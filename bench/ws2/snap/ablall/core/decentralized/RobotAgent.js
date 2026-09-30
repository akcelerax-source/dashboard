// ==========================================================================
// NODEX — Autonomous robot agent (runs ON the robot)
// Used by two separate architectures, selected per run (never both):
//
//   System 2  "Decentralized"                    (aceEnabled = false)
//     - CNP-style bidding (announce -> bid -> deterministic award)
//     - local A* on the robot's own map copy
//     - continuous FIXED two-robot peer coordination (FixedPairCoordinator)
//     - collision detection from the robot's own sensors only
//     - ORCA-style reciprocal speed adaptation along the lane
//     - no Edge AI, no RACE, no ACE, no HITL
//
//   System 3  "NodeX Edge AI ACE decentralized"  (aceEnabled = true)
//     - the same bidding / local planning / local motion layer, plus
//     - Edge AI prediction on the robot (EdgeAiPredictor)
//     - combined sensor + Edge-AI conflict/risk inputs -> RACE risk
//     - hysteresis state machine LOCAL / NEIGHBORHOOD / CONTAINMENT / SAFE-DEGRADED
//     - adaptive-scope temporary sessions + space-time contracts (AceSessionManager)
//     - HITL overrides (applied by the execution layer, ACE only)
//
// A robot knows only: its own state, its sensor frame (set by the simulator's
// sensor model each tick), and what peers told it over the P2P bus. It never
// reads the fleet registry or another robot's state object.
// ==========================================================================

import { GlobalPlanner as GraphPlanner } from "../centralized/GlobalPlanner.js";
import { MESSAGE_TYPES } from "./PeerCommunicationBus.js";
import { ROBOT_FOOTPRINT, MapGeometryEngine, WAREHOUSE_TASK_LOCATIONS } from "../map-geometry.js";
import { RaceEvaluator } from "../race-evaluator.js";
import { concurrentTaskLimit } from "../admission-control.js";
import { inIntersectionZone, laneLeader, legPassesNode, INTERSECTION_ZONE_RADIUS } from "../intersection-reservation.js";
import { startBackoff, tickBackoff, isHeadOnConflict, retreatFeasible, RETREAT_TRIGGER_SECONDS } from "../deadlock-backoff.js";
import { planRerouteAround, adoptRoute, routeToBay, repairRouteIfLost, laneSegmentAt, routePassesPoint, routeLength, blockedEdgeKeys } from "../traffic-recovery.js";
import { FixedPairCoordinator, PAIR_SCOPE_RADIUS, PAIR_RANGE } from "./FixedPairCoordinator.js";
import { EdgeAiPredictor } from "../ace/EdgeAiPredictor.js";
import { AceSessionManager } from "../ace/AceSessionManager.js";
import { SENSOR_RANGE } from "../sensor-sim.js";
import { TASK_PHASE, beginHandling, tickHandling, cancelHandling, choosePostTaskBay, POST_TASK, homeBayKeys, arriveAtBay, needsService, returnLegStalled, abandonReturnLeg } from "../task-lifecycle.js";
import { aceFeature } from "../ace/ace-features.js";

// Both agents yielding to each other longer than this: lower ID proceeds.
const MUTUAL_WAIT_SECONDS = 1.5;
const PICKUP_TOLERANCE = 12;
const CONFLICT_RADIUS = 48;
// Lane stretch around a bay's merge point that must be free before merging.
const MERGE_CLEAR_RADIUS = 46;
// ACE: a robot stationary this long without an active traversal is "merely
// standing": a physical obstacle for the local planner, not a coordination peer.
const STANDING_SECONDS = 1.0;
// ACE escalates to peer coordination with a standing robot only when local
// planning found no way around it for this long.
const STANDING_ESCALATE_SECONDS = 6.0;
// Remembered dynamic obstacles are forgotten after this long unseen.
const BLOCKAGE_MEMORY_SECONDS = 60;
// A right-of-way winner blocked this long by its loser resolves it itself.
const WINNER_TIMEOUT_SECONDS = 6.0;
// Corridor rule: never hold at a node for an oncoming robot longer than this.
const CORRIDOR_HOLD_MAX_SECONDS = 6.0;
const nodeKeyOf = (n) => `${Math.round(n.x)},${Math.round(n.y)}`;
const isFailedStatus = (s) => s === "ERROR" || s === "error" || s === "failed";

// fix-ws2-merge-gate: the engine refuses any move that closes to < 30 px of
// another robot (sim-engine _move). A robot whose centre is closer than that
// to a lane centerline blocks every robot passing it on the lane, even when
// MapGeometryEngine.isOffLane (29 px) still calls it "in its bay".
const FIX_MERGE_GATE = aceFeature("fix-ws2-merge-gate");
const DETOUR_LOCAL = aceFeature("ws2-detour-local");
const LANE_BLOCK_PX = ROBOT_FOOTPRINT.totalRadius * 2 - 2;
/** Distance from (x, y) to the nearest aisle centerline that spans it. */
function laneGap(x, y) {
  const aisles = MapGeometryEngine.getActiveAisles();
  const m = LANE_BLOCK_PX;
  let best = Infinity;
  for (const h of aisles.horizontal) if (x >= h.minX - m && x <= h.maxX + m) best = Math.min(best, Math.abs(h.y - y));
  for (const v of aisles.vertical) if (y >= v.minY - m && y <= v.maxY + m) best = Math.min(best, Math.abs(v.x - x));
  return best;
}
/** Parked clear of every lane: off-lane and not within the separation band of a lane. */
function inBayClear(x, y) {
  if (!MapGeometryEngine.isOffLane(x, y)) return false;
  return !FIX_MERGE_GATE || laneGap(x, y) >= LANE_BLOCK_PX;
}

export const ACE_LOCAL_ENVELOPE_RADIUS = 18;

export class RobotAgent {
  constructor(robotId, spawnPoint, peerBus, options = {}) {
    this.robotId = robotId;
    this.peerBus = peerBus;
    this.fleetSize = options.fleetSize ?? 0; // 0 = standalone agent, never limited
    this.localPlanner = new GraphPlanner(); // the robot's own map copy + A*
    this.raceEvaluator = new RaceEvaluator(options.raceConfig || {});
    this.aceEnabled = options.aceEnabled === true;
    // Time source for protocol timing (broadcast interval, peer liveness,
    // staleness, bid windows). Standalone agents use the wall clock; agents
    // owned by DecentralizedFleet get the simulation clock so a run's outcome
    // does not depend on CPU speed or frame rate.
    this.now = typeof options.clock === "function" ? options.clock : () => Date.now();

    this.localState = {
      id: robotId,
      model: "AMR-200",
      x: spawnPoint.x,
      y: spawnPoint.y,
      prevX: spawnPoint.x,
      prevY: spawnPoint.y,
      targetX: spawnPoint.x,
      targetY: spawnPoint.y,
      heading: 0,
      velocity: 0,
      targetVelocity: 1.2,
      radius: ROBOT_FOOTPRINT.radius,
      battery: 85 - (parseInt(robotId.replace("R", ""), 10) * 3) % 40,
      health: 98,
      status: "IDLE", // IDLE | ASSIGNED | MOVING | WAITING | ERROR
      currentTaskId: null,
      currentTask: null,
      currentGoal: null,
      currentPickup: null,
      pickedUp: null,
      home: { x: spawnPoint.x, y: spawnPoint.y }, // perimeter staging bay (return-to-origin target)
      currentPath: [],
      plannedPath: [],
      isYielding: false,
      stalledDuration: 0,
      orcaFactor: 1,
      isCriticalDegraded: false
    };
    this._configureArchitecture();

    this.peerCache = new Map(); // peerId -> { id, x, y, heading, velocity, status, task, path, intent, lastSeen }
    this.inbox = [];
    this.activeBids = new Map(); // taskId -> { task, myBidCost, bids: Map of robotId -> cost, timestamp }
    this.localDecisionTrace = [];
    this.lastBroadcast = -Infinity; // broadcast on the first tick
    this.broadcastIntervalMs = 250;
    this.goalTolerance = 8.0;
    this._lastHoldLogged = false;
    this.sensorFrame = { detections: [], obstacles: [], stamp: null };
    this.nodeClaim = null; // { key, since, inside }
    this.lastBlockedKey = null;
    this.metrics = {
      sensorConflictEvents: 0, aiPredictedConflicts: 0, fusedConflictEvents: 0,
      localReplans: 0, clearanceRequests: 0, orcaSlowdownTicks: 0,
      waitingSeconds: 0, envelopeTransitions: 0, hysteresisHolds: 0, reroutesAroundFailed: 0,
      reroutesAroundObstacle: 0, reroutesAroundStanding: 0, standingIgnored: 0,
      corridorDetours: 0, corridorHolds: 0, turnBackReplans: 0, taskRebids: 0
    };
    // Local map memory of blocked lane spots (dropped pallets, failed robots,
    // and - ACE only - merely standing robots): key -> { x, y, kind, radius, lastSeen }.
    this._blockages = new Map();
    this._standSince = new Map();
    this._rerouteTried = new Map();
    this._orphansHandled = new Set();
    this._corridorHold = null;
    this._sensorConflictActive = false;
    this._clearanceAt = -Infinity;

    // Subscribe to communication bus
    this.unsubscribeBus = this.peerBus.subscribe(this.robotId, (msg) => {
      this.inbox.push(msg);
    });
  }

  /** Builds the architecture-specific layer (System 2 pairs / System 3 ACE). */
  _configureArchitecture() {
    const ls = this.localState;
    if (this.aceEnabled) {
      this.pair = null;
      this.edgeAi = new EdgeAiPredictor(this);
      this.ace = new AceSessionManager(this);
      ls.raceState = "LOCAL";
      ls.envelopeRadius = ACE_LOCAL_ENVELOPE_RADIUS;
      ls.coordinationScope = "1 robot (local)";
      ls.coordinationGroupSize = 1;
      ls.riskScore = 0.0;
      ls.riskInputs = { conflict: 0, uncertainty: 0, commRisk: 0, queueGrowth: 0, cascadePressure: 0 };
    } else {
      this.pair = new FixedPairCoordinator(this);
      this.edgeAi = null;
      this.ace = null;
      // System 2 has no RACE / ACE state at all.
      ls.raceState = null;
      ls.envelopeRadius = PAIR_SCOPE_RADIUS;
      ls.coordinationScope = "Fixed pair (2 robots)";
      ls.coordinationGroupSize = 2;
      ls.riskScore = null;
      ls.riskInputs = null;
    }
  }

  setAceMode(enabled) {
    this.aceEnabled = enabled === true;
    this._configureArchitecture();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Proxy accessors — allow tests and external code to read/write robot
  // properties directly (e.g. agent.x = 150) while keeping localState
  // as the canonical store.
  // ─────────────────────────────────────────────────────────────────────────
  get x() { return this.localState.x; }
  set x(v) { this.localState.x = v; }

  get y() { return this.localState.y; }
  set y(v) { this.localState.y = v; }

  get targetX() { return this.localState.targetX; }
  set targetX(v) { this.localState.targetX = v; }

  get targetY() { return this.localState.targetY; }
  set targetY(v) { this.localState.targetY = v; }

  get velocity() { return this.localState.velocity; }
  set velocity(v) { this.localState.velocity = v; }

  get isYielding() { return this.localState.isYielding; }
  set isYielding(v) { this.localState.isYielding = v; }

  get status() { return this.localState.status; }
  set status(v) { this.localState.status = v; }

  get envelopeRadius() { return this.localState.envelopeRadius; }
  set envelopeRadius(v) { this.localState.envelopeRadius = v; }

  /** Current simulation time in seconds (agent clock). */
  get simNow() { return this.now() / 1000; }

  /**
   * computeTaskBid — public API to calculate this agent's bid cost for a task.
   * Returns { cost: number } — lower cost = better candidate.
   */
  computeTaskBid(task) {
    if (!task || !task.pickup) return null;
    if (this.localState.battery < 20) return { cost: Infinity, agentId: this.robotId };
    const distToPickup = Math.hypot(task.pickup.x - this.localState.x, task.pickup.y - this.localState.y);
    return { cost: distToPickup, agentId: this.robotId };
  }

  /**
   * checkSpatialConflictWithPeer — checks whether this agent's footprint
   * envelope overlaps a peer's, indicating a spatial conflict.
   */
  checkSpatialConflictWithPeer(peerAgent) {
    if (!peerAgent) return false;
    const peerState = peerAgent.localState || peerAgent;
    const dist = Math.hypot(
      (peerState.x ?? peerAgent.x) - this.localState.x,
      (peerState.y ?? peerAgent.y) - this.localState.y
    );
    const threshold = (this.localState.envelopeRadius || 24) + (peerState.envelopeRadius || peerAgent.envelopeRadius || 24) + 8;
    return dist < threshold;
  }

  destroy() {
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = null;
    }
  }

  /** Log a local autonomous decision for explainability. */
  logDecision(decision, reason, context = {}) {
    const trace = {
      time: new Date().toTimeString().split(" ")[0],
      robotId: this.robotId,
      decision,
      reason,
      context,
      timestamp: Date.now(),
      simTime: this.simNow,
      seq: (this._traceSeq = (this._traceSeq || 0) + 1)
    };
    this.localDecisionTrace.unshift(trace);
    if (this.localDecisionTrace.length > 50) this.localDecisionTrace.pop();
  }

  /** Sensor frame from the simulator's sensor model (see sensor-sim.js). */
  setSensorFrame(frame) {
    this.sensorFrame = { ...frame, stamp: this.simNow };
  }

  /**
   * Sensor frame for this tick. Without a simulator attached (standalone unit
   * tests) the frame is approximated from the peer cache.
   */
  _frame() {
    if (this.sensorFrame.stamp !== null) return this.sensorFrame;
    const ls = this.localState;
    const detections = [];
    for (const p of this.peerCache.values()) {
      if (p.id === this.robotId || typeof p.x !== "number") continue;
      const dist = Math.hypot(p.x - ls.x, p.y - ls.y);
      if (dist > SENSOR_RANGE) continue;
      const v = p.velocity || 0, h = p.heading || 0;
      detections.push({ id: p.id, x: p.x, y: p.y, vx: Math.cos(h) * v, vy: Math.sin(h) * v, dist, moving: v > 0.01, failed: isFailedStatus(p.status) });
    }
    detections.sort((a, b) => a.dist - b.dist);
    return { detections, obstacles: [], stamp: null };
  }

  /** Ingest physical state feedback from execution engine. */
  updatePhysicalState(simState) {
    if (!simState) return;
    this.localState.x = simState.x;
    this.localState.y = simState.y;
    this.localState.heading = simState.heading !== undefined ? simState.heading : this.localState.heading;
    // Sync back engine-advanced navigation cursor so waypoint progression persists.
    if (simState.targetX !== undefined) this.localState.targetX = simState.targetX;
    if (simState.targetY !== undefined) this.localState.targetY = simState.targetY;
    if (simState.pathCursor !== undefined && simState._cursorPath === this.localState.plannedPath) {
      this.localState.pathCursor = simState.pathCursor;
      this.localState._cursorPath = simState._cursorPath;
    }
    this.localState.waitingForNode = simState.waitingForNode || null;
    if (simState.velocity !== undefined) this.localState.velocity = simState.velocity;
    if (simState.stalledDuration !== undefined) this.localState.stalledDuration = simState.stalledDuration;
    if (simState.traveledDistance !== undefined) this.localState.traveledDistance = simState.traveledDistance;
    if (simState.location !== undefined) this.localState.location = simState.location;
    if (simState.status === "error" || simState.status === "failed") {
      this.localState.status = "ERROR";
      this.localState.velocity = 0;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // System 3: combined sensor + Edge AI risk inputs for RACE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The five RACE inputs from the robot's own sensor observations fused with
   * its Edge-AI prediction. Sensors give the hard, present-tense conflict;
   * the Edge AI gives predicted conflict, uncertainty, link risk, queue growth
   * and cascade pressure. (ACE only.)
   */
  computeRaceInputs(frame = this._frame(), ai = null) {
    const ls = this.localState;
    if (!ai) {
      this.edgeAi.observe(frame, this.simNow);
      ai = this.edgeAi.infer(frame, this.simNow);
    }
    let sensorConflict = 0;
    for (const d of frame.detections) {
      if (d.failed || this._isStanding(d)) continue; // standing robot = obstacle, not a conflict
      if (d.dist < 36) sensorConflict = 1;
      else if (d.dist < 64) sensorConflict = Math.max(sensorConflict, (64 - d.dist) / 28);
    }
    if (ls.isYielding || ls.status === "WAITING") sensorConflict = Math.max(sensorConflict, 0.6);
    const sensorHit = sensorConflict >= 0.5, aiHit = ai.conflict >= 0.5;
    if (sensorHit && aiHit) this.metrics.fusedConflictEvents++;
    else if (aiHit) this.metrics.aiPredictedConflicts++;
    const conflict = Math.max(sensorConflict, ai.conflict);
    const round = (v) => parseFloat(Math.min(1, Math.max(0, v)).toFixed(3));
    return {
      conflict: round(conflict),
      uncertainty: round(Math.max(ai.uncertainty, conflict > 0.5 ? conflict * 0.55 : 0)),
      commRisk: round(ai.commRisk),
      queueGrowth: round(ai.queueGrowth),
      cascadePressure: round(Math.max(ai.cascadePressure, conflict > 0.5 ? conflict * 0.45 : 0)),
      sensorConflict: round(sensorConflict),
      aiConflict: round(ai.conflict),
      aiConfidence: round(ai.confidence)
    };
  }

  /** Backward-compatible name (ACE only). */
  computeLocalRaceInputs() {
    return this.computeRaceInputs();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Local decision loop
  // ─────────────────────────────────────────────────────────────────────────

  tick(deltaTime, taskRegistry = null, simTimeSeconds = 0) {
    const now = this.simNow;
    this.processInbox(taskRegistry);
    const ls = this.localState;

    if (ls.status === "ERROR") {
      ls.velocity = 0;
      cancelHandling(ls);
      if (this.nodeClaim) { this.nodeClaim = null; this._claimChanged = true; }
      // Once peers have re-awarded my task on the task board, drop my stale
      // claim so the dashboard never shows a failed robot holding live work.
      const held = ls.currentTaskId && taskRegistry ? taskRegistry.getTaskById(ls.currentTaskId) : null;
      if (held && held.assignedRobot !== this.robotId) {
        this.logDecision("TASK_HANDED_OVER", `Task ${held.id} re-awarded to ${held.assignedRobot || "peer bidding"}; releasing it on the failed robot.`);
        Object.assign(ls, { currentTaskId: null, currentTask: null, currentGoal: null, currentPickup: null, pickedUp: null, currentPath: [], plannedPath: [] });
      }
      if (this.aceEnabled) {
        ls.raceState = "SAFE-DEGRADED";
        ls.envelopeRadius = 24;
        ls.coordinationScope = "1 robot (safe-degraded stop)";
        ls.coordinationGroupSize = 1;
        if (this.ace.session) this.ace.close(now, "ROBOT_FAILED");
      } else if (this.pair.session) {
        this.pair.release(now, "robot failed");
      }
      this._maybeBroadcast();
      return;
    }

    const frame = this._frame();
    this._updateStanding(frame);
    this._updateBlockages(frame);
    // Sensor-based collision awareness (both decentralized systems). ACE does
    // not count a merely standing robot as a conflict: it is an obstacle.
    const sensedConflict = frame.detections.some(d => !d.failed && d.dist < CONFLICT_RADIUS && !(this.aceEnabled && this._isStanding(d)));
    if (sensedConflict && !this._sensorConflictActive) this.metrics.sensorConflictEvents++;
    this._sensorConflictActive = sensedConflict;
    ls.orcaFactor = this.computeOrcaFactor(frame);

    if (this.aceEnabled) {
      // Edge AI -> RACE -> hysteresis -> envelope -> session / contract.
      this.edgeAi.observe(frame, now);
      const ai = this.edgeAi.infer(frame, now);
      const riskInputs = this.computeRaceInputs(frame, ai);
      ls.riskInputs = riskInputs;
      ls.riskScore = this.raceEvaluator.calculateRaceRisk(riskInputs);
      const trans = this.raceEvaluator.evaluateEnvelopeState(ls, simTimeSeconds, riskInputs);
      if (trans.transitioned) {
        this._lastHoldLogged = false;
        this.metrics.envelopeTransitions++;
        this.logDecision("ENVELOPE_TRANSITION", trans.reason, { from: trans.previousState, to: trans.currentState, risk: trans.risk, inputs: riskInputs });
      } else if (trans.isHold && !this._lastHoldLogged) {
        this._lastHoldLogged = true;
        this.metrics.hysteresisHolds++;
        this.logDecision("HYSTERESIS_HOLD", trans.holdReason, { risk: trans.risk });
      }
      this.adaptBehaviorToEnvelope(deltaTime);
      this.ace.tick(deltaTime, now, frame, ai);
      const size = this.ace.groupSize();
      ls.coordinationGroupSize = size;
      ls.coordinationScope = ls.raceState === "SAFE-DEGRADED" ? "1 robot (safe-degraded crawl)"
        : size > 1 ? `${size} robots (${ls.raceState.toLowerCase()} session)` : "1 robot (local)";
      ls.aceSession = this.ace.snapshot();
    } else {
      // Continuous fixed-pair coordination with robots in sensor range.
      const sensedIds = new Set(frame.detections.filter(d => d.dist <= PAIR_RANGE && !d.failed).map(d => d.id));
      this.pair.tick(deltaTime, now, sensedIds);
      ls.pairSession = this.pair.snapshot();
    }

    this.evaluateTaskBids(taskRegistry);
    this.checkPeerLiveness(taskRegistry);
    this._trackPickup();
    this._expireNodeClaim();
    this._tickService(deltaTime);

    if (ls.handling) {
      // Loading / unloading at the station: the robot stands still and does
      // not negotiate traffic until the dwell ends.
      this._tickHandling(deltaTime, taskRegistry);
    } else if (ls.currentTaskId) {
      this.reconcileTaskOwnership(taskRegistry);
      if (ls.currentTaskId) {
        this._avoidBlockages();
        this.evaluatePeerConflicts(deltaTime);
        this.evaluateStuck(deltaTime);
        this.repairOwnRoute();
        this.checkTaskCompletion(taskRegistry);
      }
    } else if (ls.status === "IDLE" || ls._maneuver || ls.parkingBay) {
      if (ls.parkingBay) this._avoidBlockages();
      this.evaluateIdleBlocking(deltaTime);
      this.returnToBay(deltaTime);
      this.normalizeIdle();
    }
    if (this.ace && this.ace.wfr) this.ace.wfr.update(now);
    if (ls.status === "WAITING") this.metrics.waitingSeconds += deltaTime;

    this._maybeBroadcast();
  }

  _maybeBroadcast() {
    const t = this.now();
    const interval = this.aceEnabled ? this.broadcastIntervalMs : 250;
    if (t - this.lastBroadcast > interval || this._claimChanged) {
      this.lastBroadcast = t;
      this._claimChanged = false;
      this.broadcastStateAndIntent();
    }
  }

  /**
   * ORCA-style reciprocal speed adaptation projected on the lane: for a sensed
   * robot ahead that closes the gap, each robot takes half of the avoidance
   * (reduces its speed in proportion to the time to collision).
   */
  computeOrcaFactor(frame) {
    const ls = this.localState;
    if (ls.status !== "MOVING") return 1;
    const hx = ls.targetX - ls.x, hy = ls.targetY - ls.y, hm = Math.hypot(hx, hy);
    if (hm < 1) return 1;
    const ux = hx / hm, uy = hy / hm;
    const myV = (ls.targetVelocity || 1.2) * 22;
    let factor = 1;
    for (const d of frame.detections) {
      const along = (d.x - ls.x) * ux + (d.y - ls.y) * uy;
      const lateral = Math.abs((d.x - ls.x) * uy - (d.y - ls.y) * ux);
      if (along <= 0 || lateral > 20) continue;
      const theirAlong = (d.vx * ux + d.vy * uy) * 22;
      const closing = myV - theirAlong;
      if (closing <= 0) continue;
      const tau = (along - 32) / closing;
      if (tau < 1.5) factor = Math.min(factor, Math.max(0.3, 1 - 0.5 * (1 - Math.max(0, tau) / 1.5)));
    }
    if (factor < 1) this.metrics.orcaSlowdownTicks++;
    return factor;
  }

  /** Adapts speed and broadcast rate to the ACE envelope state (ACE only). */
  adaptBehaviorToEnvelope(deltaTime) {
    const st = this.localState.raceState;
    const ls = this.localState;
    if (st === "LOCAL") {
      this.broadcastIntervalMs = 250; // 4 Hz
      ls.targetVelocity = ls.hitlSpeedLimit ?? 1.2;
    } else if (st === "NEIGHBORHOOD") {
      this.broadcastIntervalMs = 100; // 10 Hz high-frequency peer exchange
      ls.targetVelocity = ls.hitlSpeedLimit ?? 1.2;
    } else if (st === "CONTAINMENT") {
      this.broadcastIntervalMs = 100;
      ls.targetVelocity = Math.min(0.6, ls.hitlSpeedLimit ?? 0.6); // throttle to contain the bottleneck
      // Containment replan: waiting inside a containment cluster too long ->
      // local detour around the contested region (real path change).
      if (ls.status === "WAITING" && ls.stalledDuration > 2.0 && !ls._maneuver) {
        this.logDecision("CONTAINMENT_DETOUR", "Triggering proactive containment detour around bottleneck.");
        this.recoverFromDeadlock("CONTAINMENT_CLUSTER");
      }
    } else if (st === "SAFE-DEGRADED") {
      this.broadcastIntervalMs = 500; // 2 Hz emergency beacons
      ls.targetVelocity = 0.25;       // explicit safe crawl
    }
    if (ls.status === "MOVING") ls.velocity = Math.min(ls.velocity || ls.targetVelocity, ls.targetVelocity);
  }

  enterSafeDegradedMode() {
    this.localState.raceState = "SAFE-DEGRADED";
    this.localState.envelopeRadius = 24;
    this.localState.coordinationScope = "1 robot (safe-degraded crawl)";
    this.localState.targetVelocity = 0.25;
    this.localState.velocity = Math.min(this.localState.velocity, 0.25);
  }

  handleCommDegradation(packetDropRate = 0.8, latencyMs = 300) {
    this.localState.commHealth = Math.max(0.1, 1.0 - packetDropRate);
    this.localState.commLatency = latencyMs;
    this.commHealth = this.localState.commHealth;
  }

  restoreCommHealth() {
    this.localState.commHealth = 1.0;
    this.localState.commLatency = 10;
    this.commHealth = 1.0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────────────────────────

  processInbox(taskRegistry) {
    // Swap the inbox out and walk it by index: shift() in a loop is O(n^2).
    const inbox = this.inbox;
    this.inbox = [];
    const now = this.simNow;
    for (let mi = 0; mi < inbox.length; mi++) {
      const msg = inbox[mi];
      const sender = msg.senderId;
      const p = msg.payload || {};

      switch (msg.type) {
        case MESSAGE_TYPES.STATE_UPDATE:
        case MESSAGE_TYPES.HEARTBEAT: {
          const prev = this.peerCache.get(sender);
          this.peerCache.set(sender, {
            id: sender,
            x: p.x,
            y: p.y,
            targetX: p.targetX,
            targetY: p.targetY,
            heading: p.heading,
            velocity: p.velocity,
            status: p.status,
            currentTaskId: p.currentTaskId,
            battery: p.battery,
            raceState: p.raceState,
            riskScore: p.riskScore,
            maneuverPhase: p.maneuverPhase || null,
            waitingForNode: p.waitingForNode || null,
            nodeClaim: p.nodeClaim || null,
            parkingBay: p.parkingBay || null,
            parking: !!p.parking,
            handling: !!p.handling,
            hitlHold: !!p.hitlHold,
            currentPath: prev?.currentPath || [],
            intentGoal: prev?.intentGoal,
            // Link latency makes the information older on arrival.
            lastSeen: this.now() - (msg.latencyMs || 0)
          });
          break;
        }

        case MESSAGE_TYPES.INTENT_UPDATE: {
          const peer = this.peerCache.get(sender) || { id: sender };
          peer.intentGoal = p.goal;
          peer.currentPath = p.path || [];
          peer.targetX = p.targetX;
          peer.targetY = p.targetY;
          peer.lastSeen = this.now() - (msg.latencyMs || 0);
          this.peerCache.set(sender, peer);
          break;
        }

        case MESSAGE_TYPES.TASK_ANNOUNCEMENT:
          this.handleTaskAnnouncement(p.task);
          break;

        case MESSAGE_TYPES.TASK_BID: {
          const bidRecord = this.activeBids.get(p.taskId);
          if (bidRecord) bidRecord.bids.set(sender, p.cost);
          break;
        }

        case MESSAGE_TYPES.COORDINATION_RESPONSE:
          if (p.action === "YIELDING" && this.localState.status === "WAITING" && p.forRobot === this.robotId) {
            this.localState.status = "MOVING";
            this.localState.velocity = this.localState.targetVelocity || 1.2;
            this.localState.isYielding = false;
            this.logDecision("RESUME", `Peer ${sender} yielded; resuming corridor travel.`);
          }
          break;

        case MESSAGE_TYPES.COORDINATION_REQUEST:
          if (p.targetRobot === this.robotId && p.priority === "HIGH") {
            this.localState.status = "WAITING";
            this.localState.velocity = 0;
            this.localState.isYielding = true;
            this.peerBus.unicast(this.robotId, sender, MESSAGE_TYPES.COORDINATION_RESPONSE, { action: "YIELDING", forRobot: sender });
            this.logDecision("WAIT", `Peer ${sender} requested priority; yielding right of way.`);
          }
          break;

        case MESSAGE_TYPES.CLEARANCE_REQUEST:
          this.handleClearanceRequest(sender, p);
          break;

        case MESSAGE_TYPES.CLEARANCE_BLOCKED:
          this.handleClearanceBlocked(sender, p);
          break;

        default:
          if (this.pair && msg.type.startsWith("PAIR_")) this.pair.onMessage(msg, now);
          else if (this.ace && msg.type.startsWith("ACE_")) this.ace.onMessage(msg, now);
          break;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Distributed task allocation (Contract-Net style, both systems)
  // ─────────────────────────────────────────────────────────────────────────

  /** Evaluates an announced task and submits a local bid if eligible. */
  handleTaskAnnouncement(task) {
    if (!task || this.localState.status === "ERROR") return;
    const returning = this.localState.parkingBay && !this.localState._maneuver
      && (this.localState.parkingBay.kind === "HOME" || this.localState.parkingBay.kind === "STANDBY");
    if ((this.localState.status !== "IDLE" && !returning) || this.localState.currentTaskId) return;
    if (this.localState.hitlHold || this.localState.serviceState || this.localState.handling || needsService(this.localState)) return;
    if (this.localState.battery < 20) return;
    if (this.activeBids.has(task.id)) return; // bid round already open for it
    // Deep parking bay with its front bay occupied: cannot leave, so no bid.
    if (!MapGeometryEngine.bayExitClear(this.localState, this.peerCache.values())) return;

    // Local bid cost: C_i = w_d * D_i + w_l * L_i - w_b * B_i (+ w_r * R_i in ACE)
    const distToPickup = Math.hypot(task.pickup.x - this.localState.x, task.pickup.y - this.localState.y);
    const workload = 0;
    let bidCost = (1.0 * distToPickup) + (250.0 * workload) - (0.5 * this.localState.battery);
    if (this.aceEnabled && this.localState.riskScore > 0) {
      // Elevated risk raises the bid cost, steering work away from congested clusters.
      bidCost += this.raceEvaluator.bidWeights.w_r * this.localState.riskScore * 120.0;
    }

    const record = { task, myBidCost: bidCost, bids: new Map([[this.robotId, bidCost]]), announcedAt: this.now() };
    this.activeBids.set(task.id, record);
    this.peerBus.broadcast(this.robotId, MESSAGE_TYPES.TASK_BID, { taskId: task.id, cost: bidCost });
    this.logDecision("SUBMIT_BID", `Submitted local bid ${bidCost.toFixed(1)} for task ${task.id}`, { cost: bidCost });
  }

  /** Evaluates collected peer bids and deterministically awards ownership. */
  evaluateTaskBids(taskRegistry) {
    const now = this.now();
    for (const [taskId, record] of this.activeBids.entries()) {
      record.ticksElapsed = (record.ticksElapsed || 0) + 1;
      if (record.ticksElapsed >= 1 || (now - record.announcedAt >= 50)) {
        let lowestCost = Infinity;
        let winningRobotId = null;
        for (const [bidderId, cost] of record.bids.entries()) {
          if (cost < lowestCost) {
            lowestCost = cost;
            winningRobotId = bidderId;
          } else if (Math.abs(cost - lowestCost) < 0.01 && bidderId < winningRobotId) {
            winningRobotId = bidderId;
          }
        }
        if (winningRobotId === this.robotId && (!this.localState.currentTaskId || this.localState.currentTaskId === taskId)) {
          if (this.claimTaskOwnership(record.task, taskRegistry)) {
            const t = taskRegistry && taskRegistry.getTaskById(taskId);
            if (t) t.bidRound = { bids: record.bids.size, winningCost: lowestCost };
          }
        }
        this.activeBids.delete(taskId);
      }
    }
  }

  /**
   * Local admission estimate: tasks in flight as known from my own state and
   * my peers' broadcasts (no global registry read).
   */
  _localActiveTaskEstimate() {
    const fresh = this.now() - 1500;
    let n = this.localState.currentTaskId ? 1 : 0;
    for (const p of this.peerCache.values()) if (p.currentTaskId && (p.lastSeen ?? 0) >= fresh) n++;
    return n;
  }

  /** Accepts task ownership, plans a local path, and starts movement. */
  claimTaskOwnership(task, taskRegistry) {
    // Contract award is recorded on the task board (the WMS task source): only
    // an UNASSIGNED task can be awarded, which prevents duplicate execution.
    if (taskRegistry) {
      const current = taskRegistry.getTaskById(task.id);
      if (current && current.status !== "UNASSIGNED") return false;
    }
    if (this._localActiveTaskEstimate() >= concurrentTaskLimit(this.fleetSize)) return false;
    const ls = this.localState;
    ls.currentTaskId = task.id;
    ls.currentTask = `${task.id} (${task.pickup.name || "Bay"})`;
    ls.currentGoal = task.destination;
    ls.currentPickup = task.pickup;
    ls.pickedUp = false;
    ls.status = "ASSIGNED";
    ls.replanAttempts = 0;
    ls.lastCompletedTaskId = null;
    delete ls.parkingBay;

    const fullPath = this._planViaPickup({ x: ls.x, y: ls.y });
    ls.plannedPath = fullPath;
    ls.currentPath = fullPath;
    ls._cursorPath = null;
    ls.pathCursor = 0;
    if (fullPath.length > 1) {
      ls.targetX = fullPath[1].x;
      ls.targetY = fullPath[1].y;
      ls.heading = Math.atan2(ls.targetY - ls.y, ls.targetX - ls.x);
      ls.status = "MOVING";
      ls.velocity = ls.targetVelocity || 1.2;
    }
    if (taskRegistry) {
      taskRegistry.assignTask(task.id, this.robotId, fullPath);
      taskRegistry.startTask(task.id);
    }
    this.logDecision("CLAIM_TASK", `Won bidding for task ${task.id}. Local A* planned (${fullPath.length} wps).`);
    this.broadcastStateAndIntent();
    return true;
  }

  /** Local route: current position -> pickup (if pending) -> destination. */
  _planViaPickup(from, options = {}) {
    const ls = this.localState;
    const goal = ls.currentGoal;
    if (!goal) return [];
    if (ls.pickedUp === false && ls.currentPickup) {
      const a = this.localPlanner.planPath(from, { x: ls.currentPickup.x, y: ls.currentPickup.y }, options);
      const b = this.localPlanner.planPath({ x: ls.currentPickup.x, y: ls.currentPickup.y }, { x: goal.x, y: goal.y });
      return [...a, ...b.slice(1)];
    }
    return this.localPlanner.planPath(from, { x: goal.x, y: goal.y }, options);
  }

  _trackPickup() {
    const ls = this.localState;
    if (ls.pickedUp !== false || !ls.currentPickup || ls.handling || ls._maneuver) return;
    const tol = this._stopTolerance(ls.currentPickup, PICKUP_TOLERANCE);
    if (Math.hypot(ls.currentPickup.x - ls.x, ls.currentPickup.y - ls.y) <= tol) {
      beginHandling(ls, TASK_PHASE.LOADING);
      this.logDecision("PICKUP_REACHED", `Reached pickup of ${ls.currentTaskId}; loading.`);
    }
  }

  /** Advances a loading / unloading dwell; finishes the stage when it ends. */
  _tickHandling(deltaTime, taskRegistry) {
    const ls = this.localState;
    const done = tickHandling(ls, deltaTime);
    if (done === TASK_PHASE.LOADING) {
      ls.pickedUp = true;
      ls.status = "MOVING";
      ls.velocity = ls.targetVelocity || 1.2;
      this.logDecision("LOAD_COMPLETE", `Loaded ${ls.currentTaskId}; driving to drop.`);
    } else if (done === TASK_PHASE.UNLOADING) {
      this._completeTask(taskRegistry);
    }
  }

  /** Charging / maintenance bay service while parked there. */
  _tickService(deltaTime) {
    const ls = this.localState;
    if (ls.serviceState === POST_TASK.CHARGE) {
      ls.battery = Math.min(100, (ls.battery || 0) + 2 * deltaTime);
      if (ls.battery >= 90) {
        ls.serviceState = null;
        this.logDecision("CHARGE_COMPLETE", `Battery charged to ${Math.round(ls.battery)}%; available for tasks.`);
      }
    }
  }

  /**
   * Releases locally held task state when the task board shows the task was
   * completed/failed by another owner (stale duplicate claim).
   */
  reconcileTaskOwnership(taskRegistry) {
    if (!this.localState.currentTaskId || !taskRegistry) return;
    const t = taskRegistry.getTaskById(this.localState.currentTaskId);
    if (!t) return;
    const done = t.status === "COMPLETED" || t.status === "FAILED";
    if (done && t.assignedRobot && t.assignedRobot !== this.robotId) {
      this.logDecision("RELEASE_STALE_TASK", `Task ${t.id} ${t.status} by ${t.assignedRobot}; releasing stale local claim.`);
      this._clearTask();
      this.broadcastStateAndIntent();
    }
  }

  _clearTask() {
    const ls = this.localState;
    ls.handling = null;
    ls.status = "IDLE";
    ls.currentTaskId = null;
    ls.currentTask = null;
    ls.currentGoal = null;
    ls.currentPickup = null;
    ls.pickedUp = null;
    ls.currentPath = [];
    ls.plannedPath = [];
    ls.velocity = 0;
    ls.isYielding = false;
    ls.stalledDuration = 0;
    ls.replanAttempts = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Local traffic: node access, conflicts, recovery
  // ─────────────────────────────────────────────────────────────────────────

  _expireNodeClaim() {
    const c = this.nodeClaim;
    if (!c) return;
    const n = (MapGeometryEngine.getActiveWaypoints() || []).find(w => nodeKeyOf(w) === c.key);
    const d = n ? Math.hypot(n.x - this.localState.x, n.y - this.localState.y) : Infinity;
    if (d > 90 || (c.inside && d > INTERSECTION_ZONE_RADIUS + 4)) {
      this.nodeClaim = null;
      this._claimChanged = true;
    }
  }

  /**
   * Robot-local intersection access (decentralized mutual exclusion): the
   * robot may enter an intersection zone only when its own sensors see the
   * zone empty and no fresher-informed peer holds an earlier claim on it.
   * Claims travel in the robot's state broadcasts. ACE robots also honour
   * their space-time contract slot at the contracted region.
   */
  mayEnter(nextX, nextY) {
    const ls = this.localState;
    const now = this.simNow;
    this._permBy = null; // ws2-waitfor: whom a refused step waits for
    const wfr = this.ace && this.ace.wfr;
    if (this.ace && !(wfr && wfr.overrides(undefined, now)) && this.ace.mustHoldBeforeRegion(nextX, nextY, now)) {
      this.lastBlockedKey = this.ace.session.region.nodeKey;
      if (wfr) this._permBy = { id: this.ace.holdFor, kind: "contract" };
      return false;
    }
    // Bay merge gate: a robot parked beside a lane steps onto it only when
    // its own sensors show the merge point clear (lane traffic has priority),
    // so it never ends up half-merged and wedged against passing robots.
    // (fix-ws2-merge-gate: the gate fires where the robot would start to
    // block the lane, not 1 px inside it, so it never waits half-merged.)
    if (inBayClear(ls.x, ls.y) && !inBayClear(nextX, nextY)) {
      const merge = MapGeometryEngine.projectToNearestAisle(ls.x, ls.y);
      // Robots parked in bays do not block the merge; another robot merging
      // at the same point goes first when it has the lower ID.
      const blocksMerge = (d) => {
        if (d.failed || Math.hypot(d.x - merge.x, d.y - merge.y) >= MERGE_CLEAR_RADIUS) return false;
        if (!MapGeometryEngine.isOffLane(d.x, d.y)) return true;
        const p = this.peerCache.get(d.id);
        return !!p && !!p.currentTaskId && d.id < this.robotId;
      };
      if (merge && this.sensorFrame.detections.some(blocksMerge)) {
        this.lastBlockedKey = null;
        if (wfr) this._permBy = { id: this.sensorFrame.detections.find(blocksMerge).id, kind: "merge" };
        return false;
      }
    }
    for (const node of MapGeometryEngine.getActiveWaypoints() || []) {
      const key = nodeKeyOf(node);
      const nowIn = Math.hypot(ls.x - node.x, ls.y - node.y) < INTERSECTION_ZONE_RADIUS;
      const nextIn = Math.hypot(nextX - node.x, nextY - node.y) < INTERSECTION_ZONE_RADIUS;
      if (nowIn) {
        if (!this.nodeClaim || this.nodeClaim.key !== key || !this.nodeClaim.inside) {
          this.nodeClaim = { key, since: this.nodeClaim?.key === key ? this.nodeClaim.since : now, inside: true };
          this._claimChanged = true;
        }
        continue;
      }
      if (!nextIn) continue;
      if (this._corridorBlocked(node)) {
        this.lastBlockedKey = key;
        if (wfr) this._permBy = { id: this._corridorHold?.oncomingId || null, kind: "corridor" };
        return false;
      }
      if (!this.nodeClaim || this.nodeClaim.key !== key) {
        this.nodeClaim = { key, since: now, inside: false };
        this._claimChanged = true;
      }
      const mine = this.nodeClaim;
      const occupied = this.sensorFrame.detections.some(d => Math.hypot(d.x - node.x, d.y - node.y) < INTERSECTION_ZONE_RADIUS);
      const freshAfter = this.now() - 1000;
      let earlier = false;
      for (const p of this.peerCache.values()) {
        const c = p.nodeClaim;
        // A failed robot holds no right of way: only its body (sensed above) blocks.
        if (!c || c.key !== key || (p.lastSeen ?? 0) < freshAfter || isFailedStatus(p.status)) continue;
        if (Math.hypot(p.x - node.x, p.y - node.y) > 90) continue;
        const stale = !c.inside && now - c.since > 4 && !(p.velocity > 0);
        if (c.inside || (!stale && (c.since < mine.since || (c.since === mine.since && p.id < this.robotId)))) { earlier = p.id; break; }
      }
      if (occupied || earlier) {
        this.lastBlockedKey = key;
        if (wfr) {
          const occ = this.sensorFrame.detections.find(d => Math.hypot(d.x - node.x, d.y - node.y) < INTERSECTION_ZONE_RADIUS);
          this._permBy = { id: occ ? occ.id : earlier, kind: "node" };
        }
        return false;
      }
    }
    return true;
  }

  /** Peer view for conflict rules: sensed position + communicated intent. */
  _sensedPeers(radius) {
    const out = [];
    for (const d of this._frame().detections) {
      if (d.dist >= radius) continue;
      const info = this.peerCache.get(d.id) || {};
      const intent = this.pair && this.pair.partnerIntent && this.pair.partnerIntent.id === d.id ? this.pair.partnerIntent : null;
      out.push({
        ...info,
        ...(intent ? { status: intent.status, targetX: intent.targetX, targetY: intent.targetY, currentTaskId: intent.currentTaskId, waitingForNode: intent.waitingForNode } : {}),
        id: d.id,
        x: d.x,
        y: d.y,
        velocity: Math.hypot(d.vx, d.vy),
        standing: this._isStanding(d),
        status: d.failed ? "ERROR" : (intent?.status || info.status || "UNKNOWN")
      });
    }
    return out;
  }

  /** Deterministic local right-of-way rule between me and one peer. */
  _rightOfWay(peer) {
    const ls = this.localState;
    const myDistToTarget = Math.hypot(ls.targetX - ls.x, ls.targetY - ls.y);
    const peerParked = !peer.currentTaskId && (peer.status === "IDLE" || peer.status === "CHARGING" || peer.status === "STOPPED" || peer.parking);
    const peerDistToTarget = peerParked ? Infinity
      : peer.targetX !== undefined ? Math.hypot(peer.targetX - peer.x, peer.targetY - peer.y) : 50;
    // A robot inside the lane's separation band already blocks lane traffic:
    // it is a lane robot, not a merging one (fix-ws2-merge-gate).
    const myInBay = inBayClear(ls.x, ls.y);
    const peerInBay = inBayClear(peer.x, peer.y);
    const myInZone = inIntersectionZone(ls);
    const peerInZone = inIntersectionZone(peer);
    const outsider = myInZone ? peer : ls;
    const insider = myInZone ? ls : peer;
    const outsiderNeedsNode = myInZone !== peerInZone && (MapGeometryEngine.getActiveWaypoints() || []).some(n =>
      Math.hypot(n.x - insider.x, n.y - insider.y) < 32 && legPassesNode(outsider, n));
    const outsiderQueued = !!outsider.waitingForNode || outsiderNeedsNode;
    const leader = peerParked ? null : laneLeader(ls, peer);
    if (leader) return { iWin: leader === ls, reason: "Lane leader proceeds", peerParked };
    if (!peerParked && myInBay !== peerInBay) return { iWin: peerInBay, reason: "Merging AMR yields to lane traffic", peerParked };
    if (!peerParked && !!peer.waitingForNode !== !!ls.waitingForNode) return { iWin: !!peer.waitingForNode, reason: "Peer queued on intersection", peerParked };
    if (!peerParked && myInZone !== peerInZone && outsiderQueued) return { iWin: myInZone, reason: "Holds intersection", peerParked };
    if (Math.abs(myDistToTarget - peerDistToTarget) > 8) return { iWin: myDistToTarget < peerDistToTarget, reason: "Intersection progression distance", peerParked };
    return { iWin: this.robotId < peer.id, reason: "Decentralized ID tie-breaker", peerParked };
  }

  /**
   * Conflict evaluation from the robot's own sensors (who is physically near)
   * plus communicated intent. The architecture decides who negotiates:
   *   System 2: only the current pair partner (fixed scope); an unpaired
   *             conflicting robot must wait for a pair slot.
   *   System 3: the space-time contract of the active session; in LOCAL the
   *             robot resolves alone with the local rule.
   */
  evaluatePeerConflicts(deltaTime) {
    const ls = this.localState;
    this._yieldTo = null; // ws2-waitfor: whom I yield to this tick
    if (ls._maneuver) {
      const blockerId = ls._maneuver.blockerId;
      tickBackoff(ls, blockerId ? this.peerCache.get(blockerId) : null, deltaTime, this._neighborStates());
      return;
    }
    let shouldYield = false, conflictPeerId = null, conflictReason = null, pairWait = false;
    const wfr = this.ace && this.ace.wfr;

    for (const peer of this._sensedPeers(CONFLICT_RADIUS)) {
      if (isFailedStatus(peer.status)) continue;
      if (peer.maneuverPhase === "hold") continue;
      // ACE: a merely standing robot is an obstacle for the local planner
      // (see _avoidBlockages), not a right-of-way negotiation partner.
      if (this.aceEnabled && peer.standing) continue;
      let { iWin, reason, peerParked } = this._rightOfWay(peer);

      if (this.pair) {
        if (this.pair.isPairedWith(peer.id) && this.pair.isArbiterFor(peer.id)) {
          const agreed = this.pair.agree(peer.id, iWin, reason);
          iWin = agreed.iWin; reason = `Pair agreement: ${agreed.reason}`;
        } else if (this.pair.agreementWith(peer.id)) {
          const agreed = this.pair.agreementWith(peer.id);
          iWin = agreed.iWin; reason = `Pair agreement: ${agreed.reason}`;
        } else if (!peerParked) {
          // Fixed scope: cannot negotiate with a robot outside my pair (or the
          // arbiter's decision has not arrived yet).
          if (!this.pair.isPairedWith(peer.id)) this.pair.needPartner(peer.id);
          iWin = false; reason = `Awaiting pair slot with ${peer.id}`; pairWait = true;
        }
      } else if (this.ace) {
        const dec = this.ace.decide(peer.id, reason);
        if (dec) { iWin = dec.iWin; reason = dec.reason; }
        // ws2-waitfor: a resolved circular wait lets me pass this peer.
        if (!iWin && wfr && wfr.overrides(peer.id, this.simNow)) { iWin = true; reason = "Wait-for cycle resolution"; }
      }

      // Mutual wait: both concluded they must yield. After MUTUAL_WAIT_SECONDS
      // the lower robot ID proceeds, which both compute identically.
      if (!iWin && peer.status === "WAITING" && !peerParked
          && (ls.stalledDuration || 0) > MUTUAL_WAIT_SECONDS && this.robotId < peer.id) {
        iWin = true;
        reason = "Mutual wait tie-break (lower ID proceeds)";
        pairWait = false;
      }
      if (!iWin) {
        shouldYield = true;
        conflictPeerId = peer.id;
        conflictReason = reason;
        break;
      }
    }

    if (shouldYield && !pairWait) this._yieldTo = conflictPeerId;
    if (shouldYield) {
      ls.status = "WAITING";
      ls.velocity = 0;
      ls.isYielding = true;
      ls.stalledDuration += deltaTime;
      if (pairWait && this.pair) this.pair.noteWait(deltaTime);
      this.logDecision(pairWait ? "PAIR_WAIT" : "YIELD_WAIT", `Yielding right-of-way to peer ${conflictPeerId} (${conflictReason})`);
      if (pairWait) return; // cannot act on a conflict that was not negotiated

      const blockingPeer = this._sensedPeers(CONFLICT_RADIUS).find(p => p.id === conflictPeerId) || this.peerCache.get(conflictPeerId);
      const peers = this._neighborStates();
      if (ls.stalledDuration > RETREAT_TRIGGER_SECONDS && isHeadOnConflict(ls, blockingPeer)
          && this._turnBackReplan(blockingPeer)) return;
      if (ls.stalledDuration > RETREAT_TRIGGER_SECONDS
          && isHeadOnConflict(ls, blockingPeer)
          && retreatFeasible(ls, peers, blockingPeer)
          && startBackoff(ls, blockingPeer, peers)) {
        this.logDecision("BACKOFF_RETREAT", `Retreating to previous intersection to clear corridor for ${conflictPeerId}.`);
        return;
      }
      if (ls.stalledDuration > 3.0) this.recoverFromDeadlock(conflictPeerId);
    } else {
      if (ls.status === "WAITING") {
        ls.status = "MOVING";
        ls.velocity = ls.targetVelocity || 1.2;
        ls.isYielding = false;
        ls.stalledDuration = 0;
        this.logDecision("RESUME", "Corridor conflict cleared; resuming travel.");
      }
      this.evaluateWinnerBlocked(deltaTime);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Local map: blocked lane spots, standing robots, corridor direction
  // ─────────────────────────────────────────────────────────────────────────

  /** Tracks how long each sensed robot has been stationary. */
  _updateStanding(frame) {
    const now = this.simNow;
    const seen = new Set();
    for (const d of frame.detections) {
      seen.add(d.id);
      if (d.moving) this._standSince.delete(d.id);
      else if (!this._standSince.has(d.id)) this._standSince.set(d.id, now);
    }
    for (const id of this._standSince.keys()) if (!seen.has(id)) this._standSince.delete(id);
  }

  /**
   * A "merely standing" robot (ACE rule 3): failed, or stationary for
   * STANDING_SECONDS without an active traversal (no task, loading/unloading
   * dwell, HITL hold). A task holder stopped in a queue is NOT standing: that
   * is a genuine traffic interaction and stays a coordination candidate.
   */
  _isStanding(d) {
    if (!d) return false;
    if (d.failed) return true;
    if (d.moving) return false;
    const p = this.peerCache.get(d.id);
    if (p && (p.lastSeen ?? -Infinity) >= this.now() - 1500) {
      // The peer's own fresh broadcast says what it is doing.
      if (p.handling || p.hitlHold) return true;
      if (p.currentTaskId) return false; // task holder stopped in traffic
      // No task and not queueing / driving to a bay: parked, idle.
      if (!p.parking && p.status !== "WAITING" && p.status !== "MOVING") return true;
      return false;
    }
    // No fresh peer information: judge from the sensors alone.
    const since = this._standSince.get(d.id);
    return since !== undefined && this.simNow - since >= STANDING_SECONDS;
  }

  /**
   * Local map memory of blocked lane spots, from the robot's own sensors:
   * dropped pallets and failed robots (both systems) and, in ACE only, merely
   * standing robots. Obstacles and failed robots stay remembered until the
   * robot sees the spot clear again; standing robots only while seen standing.
   */
  _updateBlockages(frame) {
    const ls = this.localState;
    const now = this.simNow;
    const seen = new Set();
    const put = (key, x, y, kind, radius) => {
      seen.add(key);
      const prev = this._blockages.get(key);
      this._blockages.set(key, { key, x, y, kind, radius, firstSeen: prev ? prev.firstSeen : now, lastSeen: now });
    };
    for (const o of frame.obstacles || []) {
      if (o.dynamic && typeof o.x === "number" && (o.static || o.kind === "obstacle")) put(`obs:${o.id}`, o.x, o.y, "obstacle", o.radius || 12);
    }
    for (const d of frame.detections) {
      if (MapGeometryEngine.isOffLane(d.x, d.y)) continue;
      if (d.failed) put(`rob:${d.id}`, d.x, d.y, "failed", ROBOT_FOOTPRINT.radius);
      else if (this.aceEnabled && this._isStanding(d)) put(`rob:${d.id}`, d.x, d.y, "standing", ROBOT_FOOTPRINT.radius);
    }
    for (const [key, b] of this._blockages) {
      if (seen.has(key)) continue;
      const inView = Math.hypot(b.x - ls.x, b.y - ls.y) < SENSOR_RANGE - 12;
      if (b.kind === "standing" || inView || now - b.lastSeen > BLOCKAGE_MEMORY_SECONDS) {
        this._blockages.delete(key);
        this._rerouteTried.delete(key);
      }
    }
  }

  /** Next stop of my route (pickup / drop / bay entry) and what follows it. */
  _routeTargets() {
    const ls = this.localState;
    if (ls.currentGoal) {
      if (ls.pickedUp === false && ls.currentPickup) return { first: ls.currentPickup, then: ls.currentGoal, bay: null };
      return { first: ls.currentGoal, then: null, bay: null };
    }
    if (ls.parkingBay) {
      const entry = MapGeometryEngine.projectToNearestAisle(ls.parkingBay.x, ls.parkingBay.y);
      return entry ? { first: entry, then: null, bay: ls.parkingBay } : null;
    }
    return null;
  }

  /** My remaining route: current position, current target, rest of the path. */
  _remainingRoute() {
    const ls = this.localState;
    const path = ls.plannedPath || [];
    const cursor = Math.max(0, path.findIndex(p => Math.hypot(p.x - ls.targetX, p.y - ls.targetY) < 1));
    return [{ x: ls.x, y: ls.y }, ...path.slice(cursor)];
  }

  _blockedEdges() {
    const avoid = new Set();
    for (const b of this._blockages.values()) for (const k of blockedEdgeKeys(b, this.localPlanner)) avoid.add(k);
    return avoid;
  }

  /** Completes a first-stop route with the legs after it (drop / bay). */
  _completeRoute(route, targets, avoid) {
    let full = route;
    if (targets.then) full = [...full, ...this.localPlanner.planPath(targets.first, targets.then, { avoidEdges: avoid }).slice(1)];
    if (targets.bay) full = [...full, { x: targets.bay.x, y: targets.bay.y }];
    return full;
  }

  /**
   * Local planner reaction to a blocked lane on my route: plan around it.
   * Both decentralized systems do this for dropped pallets and failed robots;
   * ACE also for merely standing robots, without opening a session.
   */
  _avoidBlockages() {
    const ls = this.localState;
    if (this._blockages.size === 0 || ls._maneuver || ls.handling || ls.hitlHold) return false;
    const targets = this._routeTargets();
    if (!targets || (ls.plannedPath || []).length < 2) return false;
    const ahead = this._remainingRoute();
    const now = this.simNow;
    for (const [key, b] of this._blockages) {
      const clearance = ROBOT_FOOTPRINT.radius + b.radius + 4;
      if (!routePassesPoint(ahead, b, clearance)) continue;
      // A walled-off stop cannot be planned around (see _stopTolerance).
      if ([targets.first, targets.then, targets.bay].some(t => t && Math.hypot(t.x - b.x, t.y - b.y) < 64)) continue;
      const tried = this._rerouteTried.get(key);
      if (tried !== undefined && now - tried < 3) continue;
      this._rerouteTried.set(key, now);
      const avoid = this._blockedEdges();
      const route = planRerouteAround(ls, b, targets.first, this.localPlanner, clearance, avoid);
      if (!route) {
        this.logDecision("NO_DETOUR", `No route around the ${b.kind} ${key.slice(4)} at (${Math.round(b.x)}, ${Math.round(b.y)}); waiting for it to clear.`);
        continue;
      }
      adoptRoute(ls, this._completeRoute(route, targets, avoid));
      ls.isYielding = false;
      ls.stalledDuration = 0;
      this.metrics.localReplans++;
      if (b.kind === "failed") {
        this.metrics.reroutesAroundFailed++;
        this.logDecision("REROUTE_AROUND_FAILED", `Sensors show failed ${key.slice(4)} on my lane; local replan around it.`);
      } else if (b.kind === "standing") {
        this.metrics.reroutesAroundStanding++;
        this.logDecision("REROUTE_AROUND_STANDING", `Standing robot ${key.slice(4)} treated as an obstacle; local replan around it (no coordination session).`);
      } else {
        this.metrics.reroutesAroundObstacle++;
        this.logDecision("REROUTE_AROUND_OBSTACLE", `Obstacle at (${Math.round(b.x)}, ${Math.round(b.y)}) on my route; local replan around it.`);
      }
      this.broadcastStateAndIntent();
      return true;
    }
    return false;
  }

  /**
   * Stop tolerance. A stop (pickup / drop) occupied or walled off by a failed
   * robot or obstacle can never be reached exactly: the hand-over then
   * happens from the nearest safe spot in front of the blocker.
   */
  _stopTolerance(stop, normal) {
    let tol = normal;
    for (const b of this._blockages.values()) {
      if (b.kind === "standing") continue;
      const d = Math.hypot(b.x - stop.x, b.y - stop.y);
      if (d < 64) tol = Math.max(tol, d + b.radius + ROBOT_FOOTPRINT.radius + 8);
    }
    return tol;
  }

  /**
   * Oncoming robot on the lane from `node` to `next`: on that lane and
   * driving toward `node`. `swap` = it wants the lane I am on right now.
   */
  _oncomingOn(node, next) {
    const ls = this.localState;
    const len = Math.hypot(next.x - node.x, next.y - node.y);
    if (len < 1) return null;
    const ux = (next.x - node.x) / len, uy = (next.y - node.y) / len;
    const fresh = this.now() - 1000;
    const cand = new Map();
    for (const d of this._sensedPeers(SENSOR_RANGE + 1)) cand.set(d.id, d);
    for (const p of this.peerCache.values()) if (!cand.has(p.id) && typeof p.x === "number" && (p.lastSeen ?? 0) >= fresh) cand.set(p.id, p);
    const mx = ls.x - node.x, my = ls.y - node.y, mm = Math.hypot(mx, my) || 1;
    for (const p of cand.values()) {
      if (p.id === this.robotId || isFailedStatus(p.status) || p.standing) continue;
      if (!p.currentTaskId && !p.parking) continue;
      const along = (p.x - node.x) * ux + (p.y - node.y) * uy;
      const lateral = Math.abs((p.x - node.x) * uy - (p.y - node.y) * ux);
      if (lateral > 8 || along <= INTERSECTION_ZONE_RADIUS * 0.5 || along >= len + 20) continue;
      const tx = (p.targetX ?? p.x) - p.x, ty = (p.targetY ?? p.y) - p.y, tm = Math.hypot(tx, ty);
      if (tm < 1 || (tx * ux + ty * uy) / tm > -0.9) continue;
      const rest = this.peerCache.get(p.id)?.currentPath || [];
      const ti = rest.findIndex(q => Math.hypot(q.x - (p.targetX ?? 0), q.y - (p.targetY ?? 0)) < 1);
      let swap = false;
      for (let i = Math.max(0, ti); i + 1 < rest.length; i++) {
        if (Math.hypot(rest[i].x - node.x, rest[i].y - node.y) > 3) continue;
        const qx = rest[i + 1].x - node.x, qy = rest[i + 1].y - node.y, qm = Math.hypot(qx, qy) || 1;
        swap = (qx * mx + qy * my) / (qm * mm) > 0.9;
        break;
      }
      return { id: p.id, swap };
    }
    return null;
  }

  /**
   * Directional corridor rule (both decentralized systems). Before I enter
   * intersection `node`, I look at the lane I leave it by. A robot already on
   * that lane driving toward `node` would meet me head-on inside a one-lane
   * aisle, which only a reversal can undo. So I take a detour when a
   * reasonable one exists, otherwise I hold outside the intersection until
   * the oncoming robot is through. Returns true when I must not enter now.
   */
  _corridorBlocked(node) {
    const ls = this.localState;
    const path = ls.plannedPath || [];
    const k = path.findIndex(p => Math.hypot(p.x - node.x, p.y - node.y) < 2);
    const next = k >= 0 ? path[k + 1] : null;
    if (!next || Math.hypot(next.x - node.x, next.y - node.y) < INTERSECTION_ZONE_RADIUS) { this._corridorHold = null; return false; }
    const oncoming = this._oncomingOn(node, next);
    if (!oncoming) { this._corridorHold = null; return false; }
    const now = this.simNow;
    const key = nodeKeyOf(node);
    if (!this._corridorHold || this._corridorHold.key !== key) this._corridorHold = { key, since: now, detourTried: false, logged: false };
    const hold = this._corridorHold;
    hold.oncomingId = oncoming.id;
    if (!hold.detourTried) {
      hold.detourTried = true;
      if (this._corridorDetour(node, next, oncoming.id)) return true;
    }
    // A swap (it wants my lane) cannot be solved by waiting, nor can an
    // overly long wait: the normal right-of-way rules take over.
    if (oncoming.swap || now - hold.since > CORRIDOR_HOLD_MAX_SECONDS) return false;
    if (!hold.logged) {
      hold.logged = true;
      this.metrics.corridorHolds++;
      this.logDecision("CORRIDOR_HOLD", `Oncoming ${oncoming.id} on lane (${Math.round(node.x)}, ${Math.round(node.y)}) -> (${Math.round(next.x)}, ${Math.round(next.y)}); holding before the intersection instead of meeting it head-on.`);
    }
    return true;
  }

  /** Detour that avoids the lane node -> next, taken only if it is short enough. */
  _corridorDetour(node, next, oncomingId) {
    const ls = this.localState;
    const targets = this._routeTargets();
    if (!targets) return false;
    const avoid = this._blockedEdges();
    const lane = this.localPlanner.contestedEdgeKey(node, next);
    if (!lane) return false;
    avoid.add(lane);
    const route = this.localPlanner.planPath({ x: ls.x, y: ls.y }, targets.first, { avoidEdges: avoid });
    if (!Array.isArray(route) || route.length < 2) return false;
    // Must continue forward through `node` (no reversal) and stay off the lane.
    const first = route.find(p => Math.hypot(p.x - ls.x, p.y - ls.y) > 3);
    if (!first || Math.hypot(first.x - node.x, first.y - node.y) > 2) return false;
    const mid = { x: (node.x + next.x) / 2, y: (node.y + next.y) / 2 };
    if (routePassesPoint(route, mid, 10)) return false;
    const full = this._completeRoute(route, targets, avoid);
    const extra = routeLength(full) - routeLength(this._remainingRoute());
    if (extra > Math.hypot(next.x - node.x, next.y - node.y) + 100) return false;
    adoptRoute(ls, full, ls.status === "IDLE" ? null : "MOVING");
    this.metrics.corridorDetours++;
    this.metrics.localReplans++;
    this.logDecision("CORRIDOR_DETOUR", `Oncoming ${oncomingId} on my next lane; detour (+${Math.round(Math.max(0, extra))} px) instead of a head-on meeting.`);
    this.broadcastStateAndIntent();
    return true;
  }

  /**
   * Head-on in a one-lane aisle, and I am the one who yields: turn back to the
   * node behind me and continue on a different route to my goal, instead of
   * retreating into a side stub, holding, and driving the same lane again.
   * Used only when the new route costs no more than the retreat maneuver.
   */
  _turnBackReplan(peer) {
    if (!peer || typeof peer.x !== "number") return false;
    const ls = this.localState;
    const targets = this._routeTargets();
    if (!targets) return false;
    const avoid = this._blockedEdges();
    const route = planRerouteAround(ls, peer, targets.first, this.localPlanner, ROBOT_FOOTPRINT.radius * 2 + 4, avoid);
    if (!route) return false;
    const full = this._completeRoute(route, targets, avoid);
    const back = Math.hypot(route[1].x - ls.x, route[1].y - ls.y);
    const extra = routeLength(full) - routeLength(this._remainingRoute());
    if (extra > 2 * back + 160) return false;
    adoptRoute(ls, full);
    ls.isYielding = false;
    ls.stalledDuration = 0;
    this.metrics.turnBackReplans++;
    this.metrics.localReplans++;
    this.logDecision("TURN_BACK_REPLAN", `Head-on with ${peer.id}: turning back and taking another route (+${Math.round(Math.max(0, extra))} px) instead of retreat-and-return.`);
    this.broadcastStateAndIntent();
    return true;
  }

  /** Peer states known to this robot (sensed positions preferred). */
  _neighborStates() {
    const sensed = new Map(this._sensedPeers(SENSOR_RANGE + 1).map(p => [p.id, p]));
    const out = [...sensed.values()];
    for (const p of this.peerCache.values()) if (!sensed.has(p.id)) out.push(p);
    return out;
  }

  /**
   * I won the conflict but cannot move: the loser in front of me is waiting
   * and cannot retreat. The same chooseYielder rule says I back off.
   */
  evaluateWinnerBlocked(deltaTime) {
    const ls = this.localState;
    const moved = this._lastTickPos ? Math.hypot(ls.x - this._lastTickPos.x, ls.y - this._lastTickPos.y) : Infinity;
    this._lastTickPos = { x: ls.x, y: ls.y };
    if (ls.status !== "MOVING" || moved > 0.05) { this._winnerBlockedFor = 0; return; }
    this._winnerBlockedFor = (this._winnerBlockedFor || 0) + deltaTime;
    if (this._winnerBlockedFor <= RETREAT_TRIGGER_SECONDS) return;
    const peers = this._neighborStates();
    const fx = ls.targetX - ls.x, fy = ls.targetY - ls.y;
    const loser = this._sensedPeers(40).find(pe => pe.status !== "ERROR"
      && (pe.x - ls.x) * fx + (pe.y - ls.y) * fy > 0
      && (pe.status === "WAITING" || pe.velocity === 0));
    if (!loser || !loser.currentTaskId) return;
    // Normally the loser backs off. Views of the two robots can differ, so
    // after WINNER_TIMEOUT_SECONDS the blocked winner resolves it itself.
    if (retreatFeasible(loser, [...peers, ls], ls) && this._winnerBlockedFor <= WINNER_TIMEOUT_SECONDS) return;
    if (this._turnBackReplan(loser)) { this._winnerBlockedFor = 0; return; }
    if (!retreatFeasible(ls, peers, loser)) return;
    if (startBackoff(ls, loser, peers)) {
      this._winnerBlockedFor = 0;
      this.logDecision("BACKOFF_RETREAT", `Peer ${loser.id} cannot retreat (queue behind it); backing off to clear the corridor instead.`);
    }
  }

  /**
   * Active robot that made no progress: act on what its sensors show ahead.
   *   - a failed robot -> local reroute around it
   *   - a parked robot -> ask it (P2P) to move aside
   *   - an active robot with a parked robot behind me -> ask that one to make
   *     retreat room
   */
  evaluateStuck(deltaTime) {
    const ls = this.localState;
    const moved = this._stuckPos ? Math.hypot(ls.x - this._stuckPos.x, ls.y - this._stuckPos.y) : Infinity;
    this._stuckPos = { x: ls.x, y: ls.y };
    if (ls._maneuver || moved > 0.05 || ls.hitlHold) { this._stuckFor = 0; this._stuckTotal = 0; return; }
    this._stuckFor = (this._stuckFor || 0) + deltaTime;
    this._stuckTotal = (this._stuckTotal || 0) + deltaTime;
    if (this._stuckFor < 2.0) return;
    this._stuckFor = 0;
    const fx = ls.targetX - ls.x, fy = ls.targetY - ls.y;
    const near = this._sensedPeers(40);
    const ahead = near.filter(o => (o.x - ls.x) * fx + (o.y - ls.y) * fy > 0)
      .sort((u, v) => Math.hypot(u.x - ls.x, u.y - ls.y) - Math.hypot(v.x - ls.x, v.y - ls.y))[0];
    if (ahead && isFailedStatus(ahead.status)) {
      // Failed robot ahead: it is on my local map; retry the local replan now.
      this._rerouteTried.delete(`rob:${ahead.id}`);
      this._avoidBlockages();
      return;
    }
    // ACE: a standing robot ahead is an obstacle. Peer coordination with it
    // (a clearance request) is used only once local planning has found no
    // way around it for STANDING_ESCALATE_SECONDS.
    if (this.aceEnabled && ahead && ahead.standing) {
      this._rerouteTried.delete(`rob:${ahead.id}`);
      if (this._avoidBlockages() || this._stuckTotal < STANDING_ESCALATE_SECONDS) return;
    }
    const parked = (p) => p && !p.currentTaskId && !p.maneuverPhase && !isFailedStatus(p.status)
      && !MapGeometryEngine.isOffLane(p.x, p.y);
    let target = null;
    if (ahead && parked(ahead)) target = ahead;
    else if (ahead) target = near.find(c => parked(c) && (c.x - ls.x) * fx + (c.y - ls.y) * fy < 0) || null;
    if (target && this.simNow - this._clearanceAt > 2.0) {
      this._clearanceAt = this.simNow;
      this.metrics.clearanceRequests++;
      this.peerBus.unicast(this.robotId, target.id, MESSAGE_TYPES.CLEARANCE_REQUEST, { x: ls.x, y: ls.y, targetX: ls.targetX, targetY: ls.targetY, hops: 0 });
      this.logDecision("CLEARANCE_REQUEST", `Asked parked ${target.id} to move aside.`);
    }
  }

  /**
   * A peer asked me to move aside. A parked robot complies. If it is boxed in,
   * it forwards the request to the parked robots on its own lane (away from
   * the requester first, up to two hops) and tells the requester it is
   * blocked, so the requester can open room itself.
   */
  handleClearanceRequest(sender, p) {
    const ls = this.localState;
    if (ls.currentTaskId || ls._maneuver || ls.status === "ERROR" || ls.hitlHold) return;
    const requester = { id: sender, x: p.x, y: p.y, targetX: p.targetX, targetY: p.targetY, currentTaskId: "REQUESTER" };
    const peers = this._neighborStates();
    if (startBackoff(ls, requester, peers)) {
      this.logDecision("PARKED_CLEARANCE", `Moved aside for ${sender}.`);
      return;
    }
    if ((p.hops || 0) >= 2) return;
    const onLine = (q) => Math.abs(q.x - ls.x) < 3 || Math.abs(q.y - ls.y) < 3;
    const awayX = ls.x - p.x, awayY = ls.y - p.y;
    const parked = Array.from(this.peerCache.values())
      .filter(c => c.id !== sender && !c.currentTaskId && !c.maneuverPhase && !isFailedStatus(c.status)
        && typeof c.x === "number" && onLine(c) && Math.hypot(c.x - ls.x, c.y - ls.y) < 260)
      .sort((u, v) => {
        const su = ((u.x - ls.x) * awayX + (u.y - ls.y) * awayY) > 0 ? 0 : 1;
        const sv = ((v.x - ls.x) * awayX + (v.y - ls.y) * awayY) > 0 ? 0 : 1;
        return su - sv || Math.hypot(u.x - ls.x, u.y - ls.y) - Math.hypot(v.x - ls.x, v.y - ls.y);
      });
    for (const c of parked.slice(0, 2)) {
      this.peerBus.unicast(this.robotId, c.id, MESSAGE_TYPES.CLEARANCE_REQUEST, { x: ls.x, y: ls.y, targetX: ls.x, targetY: ls.y, hops: (p.hops || 0) + 1 });
    }
    if ((p.hops || 0) === 0) this.peerBus.unicast(this.robotId, sender, MESSAGE_TYPES.CLEARANCE_BLOCKED, { x: ls.x, y: ls.y });
  }

  /** The parked robot I asked is boxed in: back off myself to open room. */
  handleClearanceBlocked(sender, p) {
    const ls = this.localState;
    if (!ls.currentTaskId || ls._maneuver || ls.hitlHold) return;
    const blocker = { id: sender, x: p.x, y: p.y, targetX: p.x, targetY: p.y };
    if (startBackoff(ls, blocker, this._neighborStates())) {
      this.logDecision("PARKED_CLEARANCE", `${sender} is boxed in; backing off to give it room.`);
    }
  }

  _finalGoalPoint() {
    const ls = this.localState;
    return ls.currentGoal ? { x: ls.currentGoal.x, y: ls.currentGoal.y } : { x: ls.targetX, y: ls.targetY };
  }

  /** Prepends the pickup visit to a route to the destination when still pending. */
  _withPendingPickup(routeToGoal) {
    const ls = this.localState;
    if (ls.pickedUp !== false || !ls.currentPickup) return routeToGoal;
    return this._planViaPickup({ x: ls.x, y: ls.y });
  }

  /** Own route integrity: a path that ends short of the destination is replanned. */
  repairOwnRoute() {
    const ls = this.localState;
    if (ls._maneuver || ls.hitlHold || !ls.currentGoal) return;
    const route = repairRouteIfLost(ls, ls.currentGoal, this.localPlanner);
    if (!route) return;
    adoptRoute(ls, this._withPendingPickup(route), ls.status === "WAITING" ? null : "MOVING");
    this.logDecision("ROUTE_REPAIR", "Own route ended short of the destination; replanned locally.");
  }

  /**
   * Parked robot (no task): moves aside for a robot it physically blocks, and
   * vacates an intersection that peers report queueing for.
   */
  evaluateIdleBlocking(deltaTime) {
    const ls = this.localState;
    if (ls._maneuver) {
      const blockerId = ls._maneuver.blockerId;
      tickBackoff(ls, blockerId ? this.peerCache.get(blockerId) : null, deltaTime, this._neighborStates());
      return;
    }
    if (ls.parkingBay || ls.hitlHold) return;
    if (MapGeometryEngine.isOffLane(ls.x, ls.y)) {
      ls.stalledDuration = 0;
      return;
    }
    let blockingPeer = null;
    for (const peer of this._sensedPeers(40)) {
      if (isFailedStatus(peer.status) || !peer.currentTaskId) continue;
      blockingPeer = peer;
      break;
    }
    // Peers queueing for (or heading into) the intersection I am parked in.
    if (!blockingPeer && this.nodeClaim?.inside) {
      const fresh = this.now() - 1000;
      const [nx, ny] = this.nodeClaim.key.split(",").map(Number);
      for (const p of this.peerCache.values()) {
        if (p.waitingForNode === this.nodeClaim.key && (p.lastSeen ?? 0) >= fresh) { blockingPeer = p; break; }
      }
      if (!blockingPeer) {
        blockingPeer = this._sensedPeers(70).find(p => p.currentTaskId && !isFailedStatus(p.status)
          && typeof p.targetX === "number" && Math.hypot(p.targetX - nx, p.targetY - ny) < INTERSECTION_ZONE_RADIUS) || null;
      }
    }
    if (blockingPeer) {
      ls.stalledDuration = (ls.stalledDuration || 0) + deltaTime;
      if (ls.stalledDuration > 0.3 && startBackoff(ls, blockingPeer, this._neighborStates())) {
        this.logDecision("PARKED_CLEARANCE", `Parked on a lane; moving aside for ${blockingPeer.id}.`);
      }
    } else {
      ls.stalledDuration = 0;
    }
  }

  /**
   * Large fleets: an idle robot on a lane drives to a free off-lane parking
   * bay it picks itself (claims come from peers' broadcasts).
   */
  returnToBay(deltaTime) {
    const ls = this.localState;
    if (ls.parkingBay) {
      if (ls.currentTaskId || ls._maneuver || ls.hitlHold) { delete ls.parkingBay; return; }
      if (Math.hypot(ls.x - ls.parkingBay.x, ls.y - ls.parkingBay.y) < 6) {
        const kind = arriveAtBay(ls);
        this._claimChanged = true;
        if (kind === POST_TASK.MAINTENANCE) this.logDecision("MAINTENANCE_ARRIVED", "Parked in the maintenance bay; withdrawn from task allocation.");
        else if (kind === POST_TASK.CHARGE) this.logDecision("CHARGING_STARTED", "Parked at the charging bay; charging.");
      } else if (returnLegStalled(ls, deltaTime)) {
        // Head-on with another robot on the way back: turn back and take
        // another way to the same bay before giving the bay up.
        const fx = ls.targetX - ls.x, fy = ls.targetY - ls.y;
        const ahead = this._sensedPeers(44).filter(pe => !isFailedStatus(pe.status) && (pe.x - ls.x) * fx + (pe.y - ls.y) * fy > 0)
          .sort((u, v) => Math.hypot(u.x - ls.x, u.y - ls.y) - Math.hypot(v.x - ls.x, v.y - ls.y))[0];
        if (ahead && isHeadOnConflict(ls, ahead) && this._turnBackReplan(ahead)) return;
        this.logDecision("RETURN_BLOCKED", `Return leg to (${ls.parkingBay.x}, ${ls.parkingBay.y}) blocked; re-targeting the nearest free bay.`);
        abandonReturnLeg(ls);
        this._claimChanged = true;
      } else if (ls.status === "IDLE") {
        ls.status = "MOVING";
      }
      if (ls.parkingBay || !ls.retargetNearest) return;
    }
    // An idle robot that needs charging / maintenance drives there even from
    // its staging bay.
    const service = ls.status === "IDLE" && !ls._maneuver && !ls.hitlHold && (needsService(ls) || ls.retargetNearest);
    if (!service && (ls.status !== "IDLE" || ls._maneuver || ls.hitlHold || MapGeometryEngine.isOffLane(ls.x, ls.y))) { this._laneIdle = 0; return; }
    this._laneIdle = (this._laneIdle || 0) + deltaTime;
    // Right after a task the robot leaves the lane at once; any other idle
    // robot on a lane waits a moment first (it may be bid a task).
    if (!service && !ls.lastCompletedTaskId && !ls.retargetNearest && this._laneIdle < 1.0) return;
    const layout = MapGeometryEngine.generatedLayout;
    if (this._baysFor !== layout) { this._bays = MapGeometryEngine.computeParkingBays(); this._baysFor = layout; }
    const claimed = new Set();
    const occupied = [];
    for (const p of this.peerCache.values()) {
      if (p.parkingBay) claimed.add(`${p.parkingBay.x},${p.parkingBay.y}`);
      if (typeof p.x === "number") occupied.push(p);
    }
    for (const d of this.sensorFrame.detections) occupied.push(d);
    const free = this._bays.filter(b => !b.front && !claimed.has(`${b.x},${b.y}`) && `${b.x},${b.y}` !== ls.avoidBay
      && !occupied.some(o => Math.hypot(o.x - b.x, o.y - b.y) < 17));
    const pick = choosePostTaskBay(ls, free, homeBayKeys(this.fleetSize), WAREHOUSE_TASK_LOCATIONS, { nearest: !!ls.retargetNearest });
    if (!pick) return;
    ls.retargetNearest = false;
    ls.avoidBay = null;
    const route = routeToBay(ls, pick.bay, this.localPlanner);
    if (!route) return;
    ls.parkingBay = { x: pick.bay.x, y: pick.bay.y, kind: pick.kind };
    adoptRoute(ls, route);
    this._laneIdle = 0;
    this._claimChanged = true;
    const what = pick.kind === POST_TASK.HOME ? "its staging bay" : pick.kind === POST_TASK.CHARGE ? "the charging bay"
      : pick.kind === POST_TASK.MAINTENANCE ? "the maintenance bay" : "a standby bay";
    this.logDecision("RETURN_TO_BAY", `Leaving the lane; driving to ${what} (${pick.bay.x}, ${pick.bay.y}).`);
  }

  normalizeIdle() {
    const ls = this.localState;
    if (ls.currentTaskId || ls._maneuver || ls.parkingBay || ls.status !== "MOVING") return;
    ls.status = "IDLE";
    ls.velocity = 0;
    ls.isYielding = false;
  }

  /** Deadlock recovery: local replan that avoids the contested segment. */
  recoverFromDeadlock(blockingPeerId) {
    const ls = this.localState;
    // A queue hold is not forever: after 10 s the detour search starts over
    // (the traffic around the robot has changed by then).
    if (ls.replanAttempts > 3 && this.simNow - (this._queueHoldAt ?? -Infinity) > 10) ls.replanAttempts = 0;
    ls.replanAttempts = (ls.replanAttempts || 0) + 1;
    if (ls.replanAttempts > 3) {
      if (ls.replanAttempts === 4) this._queueHoldAt = this.simNow;
      this.logDecision("QUEUE_HOLD", `Holding position in queue behind ${blockingPeerId} after ${ls.replanAttempts - 1} detours.`);
      ls.status = "WAITING";
      ls.velocity = 0;
      ls.isYielding = true;
      ls.stalledDuration = 0;
      return;
    }
    if (!ls.currentGoal) return;
    const avoidEdges = new Set();
    const contested = this.localPlanner.contestedEdgeKey({ x: ls.x, y: ls.y }, { x: ls.targetX, y: ls.targetY });
    if (contested) avoidEdges.add(contested);
    // In an ACE session the contracted region is avoided as a whole.
    // ws2-detour-local: only the contested edge is avoided, not the whole hub.
    const region = DETOUR_LOCAL ? null : this.ace?.session?.region;
    if (region) {
      const hub = this.localPlanner.neighborsOf(region.x, region.y);
      for (const n of hub?.neighbors || []) {
        const k = this.localPlanner.contestedEdgeKey(hub.node, n.node);
        if (k) avoidEdges.add(k);
      }
    }
    const detour = this._planViaPickup({ x: ls.x, y: ls.y }, { avoidEdges });
    if (detour.length <= 1) return;
    const before = JSON.stringify((ls.plannedPath || []).slice(ls.pathCursor || 0).map(p => [Math.round(p.x), Math.round(p.y)]));
    const after = JSON.stringify(detour.slice(1).map(p => [Math.round(p.x), Math.round(p.y)]));
    adoptRoute(ls, detour);
    ls.velocity = (ls.targetVelocity || 1.2) * 0.7;
    ls.stalledDuration = 0;
    ls.isYielding = false;
    if (before !== after) {
      this.metrics.localReplans++;
      if (this.ace?.session) this.ace.stats.sessionReplans++;
      this.logDecision(this.ace?.session ? "ACE_REPLAN" : "DEADLOCK_REPLAN",
        `Local replan around ${blockingPeerId}: new route (${detour.length} wps)${region ? ` avoiding contract region (${region.x}, ${region.y})` : ""}.`);
    }
  }

  /** Checks whether the AMR reached its goal within tolerance (after the pickup). */
  checkTaskCompletion(taskRegistry) {
    const ls = this.localState;
    if (!ls.currentGoal || ls.pickedUp === false || ls.handling || ls._maneuver) return;
    const distToGoal = Math.hypot(ls.currentGoal.x - ls.x, ls.currentGoal.y - ls.y);
    const tol = this._stopTolerance(ls.currentGoal, this.goalTolerance);
    if (distToGoal <= tol) {
      beginHandling(ls, TASK_PHASE.UNLOADING);
      this.logDecision("DROP_REACHED", `Reached drop of ${ls.currentTaskId}; unloading.`);
    }
  }

  _completeTask(taskRegistry) {
    const ls = this.localState;
    const taskId = ls.currentTaskId;
    if (taskRegistry) taskRegistry.completeTask(taskId, Date.now());
    this.logDecision("TASK_COMPLETED", `Unloaded at destination; task ${taskId} complete.`);
    this._clearTask();
    ls.lastCompletedTaskId = taskId;
    this.broadcastStateAndIntent();
  }

  /** Peer liveness: detects failed peers and re-announces their tasks. */
  checkPeerLiveness(taskRegistry) {
    const now = this.now();
    for (const [peerId, peer] of this.peerCache.entries()) {
      const isDead = peer.status === "ERROR" || (now - (peer.lastSeen || 0) > 5000);
      if (!isDead || !peer.currentTaskId) continue;
      const abandonedTaskId = peer.currentTaskId;
      peer.currentTaskId = null;
      if (!this._orphansHandled.has(`${peerId}:${abandonedTaskId}`)) {
        this._orphansHandled.add(`${peerId}:${abandonedTaskId}`);
        this.logDecision("PEER_FAILED", `Detected failure on peer ${peerId} (holding ${abandonedTaskId}).`);
      }
      if (!taskRegistry) continue;
      const task = taskRegistry.getTaskById(abandonedTaskId);
      if (!task || task.status === "COMPLETED" || task.status === "FAILED") continue;
      // Only work the board still shows on the failed peer is orphaned. The
      // failed robot keeps re-broadcasting its old task id; that must never
      // pull back a task a peer has already re-won.
      if (task.assignedRobot && task.assignedRobot !== peerId) continue;
      if (task.status === "UNASSIGNED" && task.orphanOf === peerId) continue; // another peer already re-announced it
      if (task.status !== "UNASSIGNED") {
        // Release (not fail) the lease so the orphan can be re-awarded.
        taskRegistry.releaseTask(abandonedTaskId, `Peer ${peerId} failure detected by distributed peers`);
      }
      task.orphanOf = peerId;
      task.lastAnnouncedSimTime = this.simNow;
      this.metrics.taskRebids++;
      this.logDecision("TASK_REBID", `Re-announcing ${abandonedTaskId} of failed ${peerId} for local re-bidding.`);
      // Local re-bid round: every eligible peer bids; lowest cost wins.
      this.peerBus.broadcast(this.robotId, MESSAGE_TYPES.TASK_ANNOUNCEMENT, { task });
      this.handleTaskAnnouncement(task);
    }
  }

  /** Broadcasts local state and current intent to the peer bus. */
  broadcastStateAndIntent() {
    const ls = this.localState;
    this.peerBus.broadcast(this.robotId, MESSAGE_TYPES.STATE_UPDATE, {
      x: ls.x,
      y: ls.y,
      targetX: ls.targetX,
      targetY: ls.targetY,
      heading: ls.heading,
      velocity: ls.velocity,
      status: ls.status,
      currentTaskId: ls.currentTaskId,
      battery: ls.battery,
      raceState: ls.raceState,
      riskScore: ls.riskScore,
      maneuverPhase: ls._maneuver ? ls._maneuver.phase : null,
      waitingForNode: ls.waitingForNode || null,
      nodeClaim: this.nodeClaim ? { ...this.nodeClaim } : null,
      parkingBay: ls.parkingBay ? { ...ls.parkingBay } : null,
      parking: !!ls.parkingBay,
      handling: !!ls.handling,
      hitlHold: !!ls.hitlHold
    });
    if (ls.currentPath && ls.currentPath.length > 0) {
      this.peerBus.broadcast(this.robotId, MESSAGE_TYPES.INTENT_UPDATE, {
        goal: ls.currentGoal,
        path: ls.currentPath,
        targetX: ls.targetX,
        targetY: ls.targetY
      });
    }
  }
}
