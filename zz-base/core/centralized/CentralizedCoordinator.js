// ==========================================================================
// NODEX — System 1: CENTRALIZED fleet controller (pure centralized)
// The central server is the only coordination authority. Per central cycle it
//   1. ingests robot telemetry into the global fleet state,
//   2. allocates open tasks with a Hungarian batch assignment,
//   3. plans every task holder's route jointly with Conflict-Based Search,
//   4. detects collisions centrally (robot, rack, boundary, restricted zone,
//      dynamic objects) and arbitrates right of way (ConflictManager),
//   5. owns the intersection reservation table and the traffic-recovery rules,
//   6. dispatches commands over the robot<->server link (latency / loss).
// Robots are execution nodes. There is no peer-to-peer coordination, no peer
// cache, no bidding, no Edge AI / RACE / ACE / HITL, and no decentralized
// fallback: if the server is offline the fleet performs a safe hold.
// ==========================================================================

import { taskManager, TASK_STATUS, WAREHOUSE_TASK_LOCATIONS } from "./TaskManager.js";
import { assignmentEngine } from "./AssignmentEngine.js";
import { globalPlanner } from "./GlobalPlanner.js";
import { conflictManager } from "./ConflictManager.js";
import { CBSPlanner, CBS_STEP_SECONDS, ROBOT_SPEED_PX_S } from "./CBSPlanner.js";
import { CentralCollisionDetector } from "./CentralCollisionDetector.js";
import { MapGeometryEngine, ROBOT_FOOTPRINT } from "../map-geometry.js";
import { IntersectionReservations, INTERSECTION_ZONE_RADIUS } from "../intersection-reservation.js";
import { CentralTrafficRecovery } from "../traffic-recovery.js";
import { state } from "../state.js";
import { TASK_PHASE, beginHandling, tickHandling, cancelHandling } from "../task-lifecycle.js";
import { startBackoff, tickBackoff, isHeadOnConflict, chooseYielder, RETREAT_TRIGGER_SECONDS } from "../deadlock-backoff.js";

export const CENTRAL_CYCLE_SECONDS = 0.5;   // central allocation / planning period
const CBS_REPLAN_SECONDS = 8.0;             // periodic joint replan while tasks run
const MAX_SCHEDULE_HOLD_SECONDS = 6.0;      // a CBS wait is never held longer than this
const PICKUP_TOLERANCE = 12;

export class CentralizedCoordinator {
  constructor(executionAdapter = null) {
    this.executionAdapter = executionAdapter;
    this.conflictManager = conflictManager;
    this.fleetState = new Map(); // robotId -> robot state
    this.events = [];
    this.runStats = this._freshStats();
    this.goalTolerance = 8.0; // px distance to consider goal reached
    this.listeners = new Set();
    // Continuous task generation keeps an idle demo fleet busy. It is switched
    // off while a scenario's fixed task set is loaded so that all three
    // architectures are measured on an identical workload.
    this.continuousTaskGeneration = true;
    // Central server resources (owned here, never shared with Systems 2/3).
    this.intersections = new IntersectionReservations();
    this.cbs = new CBSPlanner(globalPlanner.graph);
    this.detector = new CentralCollisionDetector();
    this.recovery = new CentralTrafficRecovery({
      planner: globalPlanner,
      intersections: this.intersections,
      log: (actor, type, desc) => this.logEvent(actor, type, desc)
    });
    this._resetServer();
    // Task timing is measured on the server's simulation clock.
    taskManager.setClock(() => this.simTime);
  }

  _freshStats() {
    return {
      runId: "EXP-CENTRAL-01",
      systemMode: "centralized",
      startTime: Date.now(),
      tasksCreated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      conflictsDetected: 0,
      replansCount: 0,
      collisionsCount: 0,
      totalWaitingTime: 0,
      totalTravelDistance: 0,
      // Central architecture metrics
      allocationCycles: 0,
      allocationDecisions: 0,
      allocationComputeMsTotal: 0,
      cbsRuns: 0,
      cbsConflictsResolved: 0,
      cbsNodesExpanded: 0,
      cbsTruncatedRuns: 0,
      cbsPlanMsTotal: 0,
      cbsPlanMsMax: 0,
      scheduleHolds: 0,
      uplinkMessages: 0,     // robot -> server telemetry reports
      downlinkCommands: 0,   // server -> robot commands delivered
      droppedCommands: 0,
      serverOutageSeconds: 0
    };
  }

  _resetServer() {
    this.simTime = 0;
    this._cycleAcc = CENTRAL_CYCLE_SECONDS; // first tick runs a central cycle
    this._lastCbsAt = -Infinity;
    this._replanRequested = false;
    this.serverOnline = true;
    this._outageUntil = null;
    this.link = { latencyMs: 0, lossRate: 0 };
    this._lossSeed = 11;
    this._pendingCommands = [];
    this.intersections.reset();
    this.detector.reset();
    this.recovery.reset();
    if (this.cbs.graph !== globalPlanner.graph) this.cbs.setGraph(globalPlanner.graph);
  }

  /** Robot<->server link conditions (scenario comm delay / loss). */
  setLinkConditions({ latencyMs = 0, lossRate = 0 } = {}) {
    this.link = { latencyMs: Math.max(0, latencyMs), lossRate: Math.max(0, Math.min(1, lossRate)) };
  }

  /**
   * Central server outage (S14). The fleet performs a safe hold for the
   * outage and resumes under central control when the server is back. It
   * never switches to peer-to-peer coordination.
   */
  setServerOnline(online, outageSeconds = 20) {
    this.serverOnline = !!online;
    this._outageUntil = online ? null : this.simTime + outageSeconds;
    this.logEvent("COORDINATOR", online ? "SERVER_ONLINE" : "SERVER_OFFLINE", online
      ? "Central server back online; central control resumed."
      : `Central server offline: fleet safe hold for ${outageSeconds}s (no decentralized fallback).`);
  }

  /** One robot loses its server link for `seconds` (comm-loss fault). */
  setRobotLinkLost(robotId, seconds = 10) {
    const r = this.fleetState.get(robotId);
    if (!r) return;
    r.linkLostUntil = this.simTime + seconds;
    this.logEvent(robotId, "LINK_LOST", `Server link to ${robotId} lost: safe stop for ${seconds}s (central control only).`);
  }

  _dropNext() {
    if (!this.link.lossRate) return false;
    this._lossSeed = (this._lossSeed * 1103515245 + 12345) % 2147483648;
    return this._lossSeed / 2147483648 < this.link.lossRate;
  }

  /**
   * Replaces the task queue with a scenario's fixed task set. The fleet is kept
   * as-is (sized by the run's robot count); only task ownership is reset.
   */
  loadScenarioTasks(tasks) {
    taskManager.clear();
    conflictManager.clear();
    this.continuousTaskGeneration = false;
    for (const r of this.fleetState.values()) {
      if (r.status === "ERROR") continue;
      r.status = "IDLE";
      r.currentTaskId = null;
      r.currentTask = null;
      r.currentPath = [];
      r.velocity = 0;
      r.isYielding = false;
      r.stalledDuration = 0;
    }
    for (const t of tasks) {
      taskManager.createTask({
        id: t.id,
        pickup: t.pickup,
        destination: t.destination,
        priority: t.priority,
        type: t.type
      });
    }
    this.runStats.tasksCreated = tasks.length;
    this.logEvent("SYSTEM", "TASK_LOAD", `Loaded ${tasks.length} scenario tasks into centralized queue.`);
  }

  /** Adds tasks to the live queue mid-run (scenario task bursts). */
  addTasks(tasks) {
    for (const t of tasks) {
      taskManager.createTask({ id: t.id, pickup: t.pickup, destination: t.destination, priority: t.priority, type: t.type });
    }
    this.runStats.tasksCreated += tasks.length;
    this.logEvent("SYSTEM", "TASK_LOAD", `Added ${tasks.length} burst tasks to the centralized queue.`);
  }

  setExecutionAdapter(adapter) {
    this.executionAdapter = adapter;
  }

  /**
   * Initializes the fleet entities under centralized authority.
   */
  initializeFleet(robotCount = 3) {
    this.fleetState.clear();
    taskManager.clear();
    conflictManager.clear();
    this.events = [];
    this.runStats = this._freshStats();
    this._resetServer();
    // Tasks come only from the scenario (see loadScenarioTasks); generating
    // them on completion outside a scenario created phantom work.
    this.continuousTaskGeneration = false;
    this.runStats.startTime = Date.now();

    const spawnPoints = MapGeometryEngine.computeFleetSpawnPoints(robotCount);

    for (let i = 0; i < robotCount; i++) {
      const id = `R${(i + 1).toString().padStart(2, "0")}`;
      const spawnX = spawnPoints[i].x;
      const spawnY = spawnPoints[i].y;

      const robot = {
        id,
        model: "AMR-200",
        x: spawnX,
        y: spawnY,
        prevX: spawnX,
        prevY: spawnY,
        targetX: spawnX,
        targetY: spawnY,
        heading: 0,
        velocity: 0,
        targetVelocity: 1.2,
        radius: ROBOT_FOOTPRINT.radius,
        battery: 85 - (i * 3) % 40,
        health: 98,
        status: "IDLE", // IDLE | ASSIGNED | MOVING | WAITING | BLOCKED | COMPLETED | ERROR
        currentTaskId: null,
        currentTask: null,
        currentPath: [],
        stalledDuration: 0,
        isYielding: false,
        traveledDistance: 0,
        home: { x: spawnX, y: spawnY } // perimeter staging bay (return-to-origin target)
      };

      this.fleetState.set(id, robot);
    }

    // Fleet init creates robots only (same as DecentralizedFleet). Tasks come
    // exclusively from ScenarioEngine at Start; seeding and assigning tasks
    // here logged phantom TASK_CREATED/TASK_ASSIGNED events into the run and
    // showed pre-run robots with tasks they never executed.

    // Sync to global state for telemetry coherence across adapters
    state.set("robots", Array.from(this.fleetState.values()));

    this.logEvent("SYSTEM", "INITIALIZING", `Centralized Coordinator initialized with ${robotCount} AMRs.`);
  }

  /**
   * The Centralized Coordination Tick Loop (called on every simulation cycle).
   * `simTime` (seconds) is the simulation clock; standalone callers (tests)
   * may omit it and the coordinator advances its own clock.
   */
  tick(deltaTime, simTime = null) {
    this.simTime = simTime !== null ? simTime : this.simTime + deltaTime;
    const robots = Array.from(this.fleetState.values());

    // 1. Ingest executed positions and statuses from execution adapter if present and simulation is active
    if (this.executionAdapter && state.get("simRunning")) {
      const adapterStates = this.executionAdapter.getRobotStates();
      for (const st of adapterStates) {
        const local = this.fleetState.get(st.id);
        if (local) {
          local.x = st.x;
          local.y = st.y;
          local.heading = st.heading !== undefined ? st.heading : local.heading;
          local.velocity = st.velocity !== undefined ? st.velocity : local.velocity;
          if (st.status === "error" || st.status === "failed") {
            local.status = "ERROR";
          }
        }
      }
    }
    // Every robot reports its state to the server each tick (uplink traffic).
    this.runStats.uplinkMessages += robots.length;

    // 1b. Server availability. Offline = safe hold for the whole fleet; the
    // robots never coordinate among themselves.
    if (!this.serverOnline && this._outageUntil !== null && this.simTime >= this._outageUntil) {
      this.setServerOnline(true);
    }
    // Safe hold when the server is offline, or for a robot whose own server
    // link is down (it has no valid command). Never peer coordination.
    for (const r of robots) r.centralHold = !this.serverOnline || (r.linkLostUntil !== undefined && this.simTime < r.linkLostUntil);
    if (!this.serverOnline) {
      this.runStats.serverOutageSeconds += deltaTime;
      for (const r of robots) r.velocity = 0;
      this.notifySubscribers();
      return;
    }

    // 2. Central cycle: Hungarian batch allocation + joint CBS route planning.
    this._cycleAcc += deltaTime;
    if (this._cycleAcc >= CENTRAL_CYCLE_SECONDS - 1e-9) {
      this._cycleAcc = 0;
      this.runCentralCycle(robots);
    }
    this.deliverCommands();

    // 2b. Station handling: loading at the pickup, unloading at the drop (the
    // robot stands still for the dwell). A task completes only after its
    // pickup was loaded and its load was unloaded at the destination.
    for (const r of robots) {
      if (r.status === "ERROR") { cancelHandling(r); continue; }
      if (r.handling) {
        const done = tickHandling(r, deltaTime);
        if (done === TASK_PHASE.LOADING) {
          r.pickedUp = true;
          if (r.status !== "WAITING") r.status = "MOVING";
          this.logEvent(r.id, "LOAD_COMPLETE", `${r.id} loaded ${r.currentTaskId}; driving to drop.`);
        } else if (done === TASK_PHASE.UNLOADING) {
          r._unloaded = true;
        }
        continue;
      }
      if (!r.currentTaskId || r.pickedUp || r._maneuver) continue;
      const task = taskManager.getTaskById(r.currentTaskId);
      if (task && Math.hypot(task.pickup.x - r.x, task.pickup.y - r.y) <= PICKUP_TOLERANCE) {
        beginHandling(r, TASK_PHASE.LOADING);
        this.logEvent(r.id, "PICKUP_REACHED", `${r.id} reached pickup of ${task.id}; loading.`);
      }
    }

    // 2c. Central collision detection from the global state (server perception).
    const dynamics = state.get("dynamicWorldObjects") || [];
    const { halt } = this.detector.evaluate(robots, dynamics);
    for (const r of robots) r.centralHalt = halt.has(r.id);

    // 2d. CBS schedule: hold a robot at a node until its planned departure
    // (the wait CBS inserted to separate it from another robot), unless a
    // robot is already queued for that node or the hold ran too long.
    const queued = new Set(Object.values(this.intersections.snapshot()).flatMap(e => e.queue));
    for (const r of robots) {
      r.scheduleHold = false;
      const sched = r.cbsSchedule;
      if (!sched || !r.currentTaskId || r._maneuver) continue;
      const stop = sched.find(s => Math.hypot(s.x - r.x, s.y - r.y) < 6);
      if (!stop || this.simTime >= stop.depart - 0.2) continue;
      const nodeHasQueue = queued.size > 0 && Object.entries(this.intersections.snapshot())
        .some(([key, e]) => e.queue.length && key === `${Math.round(stop.x)},${Math.round(stop.y)}`);
      stop.heldFor = (stop.heldFor || 0) + deltaTime;
      if (nodeHasQueue || stop.heldFor > MAX_SCHEDULE_HOLD_SECONDS) continue;
      if (stop.heldFor <= deltaTime + 1e-9) this.runStats.scheduleHolds++;
      r.scheduleHold = true;
    }

    // 3. Centralized Conflict Detection & Resolution
    // Maneuvering robots stay IN detection (excluding them let a third robot
    // sit blocked on one mid-maneuver forever with no escalation path, since
    // a MOVING-but-physically-blocked robot never becomes WAITING on its
    // own). The WAITING/PROCEEDING/CONFLICT_RESOLVED handlers below guard
    // against re-arbitrating a robot that's already maneuvering.
    // Robots parked in off-lane bays obstruct no lane; arbitrating them pulled
    // them out of their bays into traffic.
    const detectedConflicts = conflictManager.detectConflicts(
      robots.filter(r => r.currentTaskId || r._maneuver || !MapGeometryEngine.isOffLane(r.x, r.y)));
    if (detectedConflicts.length > 0) {
      this.runStats.conflictsDetected++;
    }

    const conflictActions = conflictManager.resolveConflicts(detectedConflicts, taskManager, globalPlanner);
    for (const act of conflictActions) {
      if (act.type === "CONFLICT_DETECTED") {
        this.logEvent("COORDINATOR", "CONFLICT_DETECTED", `Conflict detected between ${act.winnerId} and ${act.loserId} (${act.reason})`);
      } else if (act.type === "ROBOT_WAITING") {
        const loser = this.fleetState.get(act.robotId);
        if (loser && loser.status !== "ERROR" && !loser._maneuver) {
          // Waiting in place forever can't work in a single-lane aisle: the
          // winner is itself physically blocked from closing the gap to a
          // stationary robot (sim-engine's separation guard). Once the
          // wait has run long enough to be a real head-on (not just a
          // one-tick blip), back the loser off to the previous
          // intersection instead of leaving it parked in the lane.
          const blocker = this.fleetState.get(act.holdingFor);
          // A parked robot (no task) must always be moved out of the way
          // regardless of relative heading — it has nowhere it needs to be,
          // so there's no "queueing" case to protect by waiting instead.
          // The loser backs off unless its retreat leg is blocked (it is the
          // front of a queue); then the winner backs off instead.
          const yielder = loser.stalledDuration > RETREAT_TRIGGER_SECONDS
            && (!loser.currentTaskId || isHeadOnConflict(loser, blocker))
            ? chooseYielder(loser, blocker, robots)
            : null;
          const other = yielder === loser ? blocker : loser;
          if (yielder && startBackoff(yielder, other, robots)) {
            this.runStats.replansCount++;
            this.logEvent(yielder.id, "ROBOT_BACKOFF", `${yielder.id} retreating to the previous intersection to clear the corridor for ${other ? other.id : act.holdingFor}.`);
          } else {
            loser.status = "WAITING";
            loser.velocity = 0;
            loser.isYielding = true;
            loser.stalledDuration += deltaTime;
            this.runStats.totalWaitingTime += deltaTime;
          }
        }
      } else if (act.type === "ROBOT_PROCEEDING") {
        const winner = this.fleetState.get(act.robotId);
        // A maneuvering "winner" must not be yanked out of its own
        // retreat/hold by an unrelated conflict against a third robot.
        if (winner && winner.status !== "ERROR" && !winner._maneuver) {
          if (winner.status === "WAITING") {
            // No task: nothing to travel to, so it stays parked.
            winner.status = (winner.currentTaskId || winner.parkingBay) ? "MOVING" : "IDLE";
            this.logEvent(winner.id, "ROBOT_RESUMED", `${winner.id} cleared to proceed through corridor.`);
          }
          winner.velocity = winner.status === "MOVING" ? (winner.targetVelocity || 1.2) : 0;
          winner.isYielding = false;
        }
      } else if (act.type === "PATH_REPLANNED") {
        const r = this.fleetState.get(act.robotId);
        if (r && act.detour && act.detour.length > 1) {
          // The engine follows plannedPath: setting only currentPath made the
          // robot walk back along its old route after the first detour leg.
          r.plannedPath = act.detour;
          r._cursorPath = null;
          r.pathCursor = 0;
          r.currentPath = act.detour;
          r.targetX = act.detour[1].x;
          r.targetY = act.detour[1].y;
          r.stalledDuration = 0;
          r.status = "MOVING";
          r.velocity = (r.targetVelocity || 1.2) * 0.8;
          this.runStats.replansCount++;
          this.logEvent(r.id, "PATH_REPLANNED", `Detour planned for ${r.id} around congested corridor.`);
        }
      } else if (act.type === "CONFLICT_RESOLVED") {
        const loser = this.fleetState.get(act.loserId);
        // Once a robot backs off, it naturally stops showing up in conflict
        // detection (it's no longer near the contested lane) — that alone
        // would clear the old conflict record here, but the maneuver's own
        // hold phase (also status WAITING) must not be cancelled by it.
        if (loser && loser.status === "WAITING" && !loser._maneuver) {
          const going = loser.currentTaskId || loser.parkingBay; // a task or a return leg
          loser.status = going ? "MOVING" : "IDLE";
          loser.velocity = going ? (loser.targetVelocity || 1.2) : 0;
          loser.isYielding = false;
          loser.stalledDuration = 0;
          this.logEvent(loser.id, "CONFLICT_RESOLVED", `Conflict resolved. ${loser.id} resuming travel.`);
        }
      }
    }

    // 3.4 Orphaned waits: a loser whose conflict record was dropped without a
    // CONFLICT_RESOLVED action (e.g. the winner left detection range while
    // backing off) stayed WAITING forever with nobody near it.
    // Roles in a conflict record can flip between ticks, so any robot that is
    // party to an active conflict is left to the arbitration above.
    const waitingFor = new Set(conflictManager.getActiveConflictList().flatMap(c => [c.loserId, c.winnerId]));
    for (const r of robots) {
      if (r.status === "WAITING" && (r.currentTaskId || r.parkingBay) && !r._maneuver && !waitingFor.has(r.id)) {
        r.status = "MOVING";
        r.velocity = r.targetVelocity || 1.2;
        r.isYielding = false;
        r.stalledDuration = 0;
        this.logEvent(r.id, "CONFLICT_RESOLVED", `No active conflict holds ${r.id}; resuming travel.`);
      }
    }

    // 3.5 Advance any in-progress back-off maneuvers. This runs for every
    // maneuvering robot regardless of whether it appeared in conflict
    // detection above — once it's safely off the contested lane it
    // normally won't.
    for (const r of robots) {
      if (r._maneuver) {
        const blocker = r._maneuver.blockerId ? this.fleetState.get(r._maneuver.blockerId) : null;
        tickBackoff(r, blocker, deltaTime, robots);
      }
    }

    // 4. Send execution commands to Execution Adapter (e.g. DashboardSimulationAdapter or Gazebo)
    if (this.executionAdapter) {
      this.executionAdapter.dispatchFleetCommands(Array.from(this.fleetState.values()));
    }

    // 5. Check Task Progress and Completion
    for (const r of robots) {
      if (r.currentTaskId) {
        const task = taskManager.getTaskById(r.currentTaskId);
        if (task) {
          const dest = task.destination;
          const distToGoal = Math.hypot(dest.x - r.x, dest.y - r.y);

          // Task completed when reached destination within goal tolerance
          // (after its pickup was visited; pickedUp is false only for tasks
          // allocated by the central cycle, which tracks the pickup).
          if (distToGoal <= this.goalTolerance && r.pickedUp !== false && !r._unloaded && !r.handling && !r._maneuver) {
            beginHandling(r, TASK_PHASE.UNLOADING);
            this.logEvent(r.id, "DROP_REACHED", `${r.id} reached drop of ${task.id}; unloading.`);
          }
          if (r._unloaded) {
            taskManager.completeTask(task.id, Date.now());
            this.runStats.tasksCompleted++;
            this.logEvent(r.id, "TASK_COMPLETED", `AMR ${r.id} unloaded and completed ${task.id} at ${dest.name || "destination"}.`);

            delete r._unloaded;
            r.lastCompletedTaskId = task.id;
            r.status = "IDLE";
            r.currentTaskId = null;
            r.currentTask = null;
            r.currentPath = [];
            r.plannedPath = [];
            r.cbsSchedule = null;
            delete r.pickedUp;
            r.velocity = 0;

            // Spawn next continuous task if queue is getting low
            if (this.continuousTaskGeneration && taskManager.getUnassignedTasks().length < 2) {
              this.seedNextTask();
            }
          }
        }
      }
    }

    // Notify listeners
    this.notifySubscribers();
  }

  seedNextTask() {
    // Re-synchronize robot availability if tasks were cleared
    const robots = Array.from(this.fleetState.values());
    for (const r of robots) {
      if (r.currentTaskId && !taskManager.getTaskById(r.currentTaskId)) {
        r.currentTaskId = null;
        r.currentTask = null;
        r.status = "IDLE";
        r.currentPath = [];
      }
    }

    // Deterministic round-robin task generation — no Math.random()
    const n = this.runStats.tasksCreated;
    this.runStats.tasksCreated++;
    const L = WAREHOUSE_TASK_LOCATIONS.length;
    const pIdx = n % L;
    const dIdx = (n + Math.ceil(L / 2) + (n % 3)) % L === pIdx
      ? (pIdx + Math.ceil(L / 2) + 1) % L
      : (n + Math.ceil(L / 2) + (n % 3)) % L;
    const priorities = ["HIGH", "MEDIUM", "LOW", "MEDIUM", "HIGH", "LOW"];
    const priority = priorities[n % priorities.length];

    const task = taskManager.createTask({
      pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
      destination: WAREHOUSE_TASK_LOCATIONS[dIdx],
      priority
    });

    this.logEvent("SYSTEM", "TASK_CREATED", `Continuous task ${task.id} generated (${task.pickup.name} → ${task.destination.name})`);

    // Immediately run one central cycle (Hungarian allocation + CBS routes).
    this.runCentralCycle(robots);
    this.deliverCommands();

    return task;
  }

  /**
   * Handles failure of a robot (injected fault or breakdown).
   */
  handleRobotFailure(robotId, reason = "Hardware motor stall") {
    const robot = this.fleetState.get(robotId);
    if (!robot) return;

    robot.status = "ERROR";
    robot.velocity = 0;
    robot.health = 18;
    cancelHandling(robot);
    delete robot._unloaded;
    this.runStats.tasksFailed++;

    this.logEvent(robot.id, "ROBOT_FAILED", `AMR ${robotId} failure detected: ${reason}. Halting motor drive.`);

    if (robot.currentTaskId) {
      const task = taskManager.getTaskById(robot.currentTaskId);
      if (task) {
        // Return the task to the server queue: the next assignment pass gives
        // it to the best available robot. Reassigning only when a robot was
        // idle at this instant (else FAILED forever) meant the run could never
        // complete, and the replacement was set up without a followed path.
        taskManager.releaseTask(task.id, `Robot ${robotId} failed: ${reason}`);
        this.logEvent("COORDINATOR", "TASK_REALLOCATING", `Task ${task.id} returned to the dispatch queue from failed robot ${robotId}.`);
      }
      robot.currentTaskId = null;
      robot.currentTask = null;
    }
    robot.cbsSchedule = null;
    delete robot._maneuver;
    // The failed robot is now a static obstacle: replan every route around it.
    this._replanRequested = true;
  }

  // ------------------------------------------------------------------------
  // Central cycle: allocation (Hungarian) + planning (CBS) + command dispatch
  // ------------------------------------------------------------------------

  /** Asks the server to re-run CBS at the next cycle (map or fleet changed). */
  requestReplan() {
    this._replanRequested = true;
  }

  runCentralCycle(robots = Array.from(this.fleetState.values())) {
    this.runStats.allocationCycles++;
    const open = taskManager.getUnassignedTasks();
    let newAssignments = false;
    if (open.length) {
      for (const t of open) {
        if (t.allocationStartSim === null || t.allocationStartSim === undefined) taskManager.noteAllocation(t.id, { startSim: this.simTime });
      }
      const { assignments, computeMs, matrix } = assignmentEngine.assignBatch(open, robots, taskManager);
      this.runStats.allocationComputeMsTotal += computeMs;
      for (const a of assignments) {
        const r = this.fleetState.get(a.robot.id);
        if (!r) continue;
        r.status = "ASSIGNED";
        r.currentTaskId = a.task.id;
        r.currentTask = `${a.task.id} (${a.task.pickup.name || "Pickup"})`;
        r.pickedUp = false;
        r.cbsSchedule = null;
        r.lastCompletedTaskId = null;
        delete r.parkingBay;
        this.runStats.allocationDecisions++;
        newAssignments = true;
        this.logEvent(r.id, "TASK_ASSIGNED", `Central server assigned ${a.task.id} to ${r.id} (Hungarian batch ${matrix[0]}x${matrix[1]}).`);
      }
    }
    const due = this.simTime - this._lastCbsAt >= CBS_REPLAN_SECONDS;
    if ((newAssignments || this._replanRequested || due) && robots.some(r => r.currentTaskId)) {
      this.planRoutesCBS(robots);
      this._lastCbsAt = this.simTime;
      this._replanRequested = false;
    }
  }

  _nodeAt(pt) {
    const wps = MapGeometryEngine.getActiveWaypoints() || [];
    return wps.find(w => Math.hypot(w.x - pt.x, w.y - pt.y) < 2) || null;
  }

  _goalNode(pt) {
    return this._nodeAt(pt) || globalPlanner.findNearestReachableWaypoint(pt.x, pt.y);
  }

  /** CBS agent for one task holder: start node, arrival offset and goal nodes. */
  _cbsAgent(r, blockedNodes) {
    const task = taskManager.getTaskById(r.currentTaskId);
    if (!task) return null;
    const goalPts = r.pickedUp === false ? [task.pickup, task.destination] : [task.destination];
    const lead = globalPlanner.planPath({ x: r.x, y: r.y }, { x: goalPts[0].x, y: goalPts[0].y });
    const k = lead.findIndex(p => this._nodeAt(p));
    if (k < 0) return null; // goal reachable without crossing a node: plain route
    const prefix = lead.slice(0, k + 1);
    const startNode = this._nodeAt(lead[k]);
    let len = 0;
    for (let i = 1; i < prefix.length; i++) len += Math.hypot(prefix[i].x - prefix[i - 1].x, prefix[i].y - prefix[i - 1].y);
    const goals = goalPts.map(p => this._goalNode(p)).filter(Boolean).map(w => w.id);
    if (goals.length !== goalPts.length) return null;
    return {
      robot: r, task, prefix, goalPts,
      agent: { id: r.id, start: startNode.id, startTime: Math.ceil(len / (ROBOT_SPEED_PX_S * CBS_STEP_SECONDS)), goals, blockedNodes }
    };
  }

  planRoutesCBS(robots) {
    const failed = robots.filter(r => ["ERROR", "error", "failed"].includes(r.status));
    const wps = MapGeometryEngine.getActiveWaypoints() || [];
    const blocked = new Set();
    for (const f of failed) for (const w of wps) if (Math.hypot(w.x - f.x, w.y - f.y) < INTERSECTION_ZONE_RADIUS) blocked.add(w.id);
    for (const d of state.get("dynamicWorldObjects") || []) {
      if (!d.static) continue;
      for (const w of wps) if (Math.hypot(w.x - d.x, w.y - d.y) < INTERSECTION_ZONE_RADIUS) blocked.add(w.id);
    }
    const holders = robots.filter(r => r.currentTaskId && !r._maneuver && !["ERROR", "error", "failed"].includes(r.status));
    const specs = [];
    for (const r of holders) {
      const spec = this._cbsAgent(r, blocked);
      if (spec) specs.push(spec);
      else this._queueCommand(this._plainRouteCommand(r));
    }
    if (specs.length === 0) return;
    const res = this.cbs.plan(specs.map(s => s.agent));
    this.runStats.cbsRuns++;
    this.runStats.cbsConflictsResolved += res.conflictsResolved;
    this.runStats.cbsNodesExpanded += res.ctNodes;
    if (res.truncated) this.runStats.cbsTruncatedRuns++;
    this.runStats.cbsPlanMsTotal += res.ms;
    this.runStats.cbsPlanMsMax = Math.max(this.runStats.cbsPlanMsMax, res.ms);
    const byId = (id) => globalPlanner.graph.get(id)?.node;
    for (const spec of specs) {
      const path = res.paths[spec.robot.id];
      if (!path) { this._queueCommand(this._plainRouteCommand(spec.robot)); continue; }
      const route = [...spec.prefix];
      const schedule = [];
      for (let i = 0; i < path.length; i++) {
        const n = byId(path[i].id);
        const last = route[route.length - 1];
        if (Math.hypot(n.x - last.x, n.y - last.y) > 1) route.push({ x: n.x, y: n.y });
        // A wait = the same node repeated: hold there until the last repeat.
        if (i + 1 < path.length && path[i + 1].id === path[i].id && (i === 0 || path[i - 1].id !== path[i].id)) {
          let j = i + 1;
          while (j + 1 < path.length && path[j + 1].id === path[i].id) j++;
          schedule.push({ x: n.x, y: n.y, depart: this.simTime + path[j].t * CBS_STEP_SECONDS });
        }
      }
      const goal = spec.goalPts[spec.goalPts.length - 1];
      const tailFrom = route[route.length - 1];
      if (Math.hypot(goal.x - tailFrom.x, goal.y - tailFrom.y) > 2) {
        route.push(...globalPlanner.planPath(tailFrom, { x: goal.x, y: goal.y }).slice(1));
      }
      if (route.length < 2) continue;
      this._queueCommand({ robotId: spec.robot.id, taskId: spec.task.id, route, schedule, planner: "CBS" });
    }
    if (res.conflictsResolved > 0) {
      this.logEvent("COORDINATOR", "CBS_PLAN", `CBS planned ${specs.length} routes: ${res.conflictsResolved} conflicts resolved (${res.ctNodes} CT nodes, ${res.ms.toFixed(1)} ms${res.truncated ? ", bounded" : ""}).`);
    }
  }

  /** A* route (via the pickup when still pending) when CBS has no node to plan on. */
  _plainRouteCommand(r) {
    const task = taskManager.getTaskById(r.currentTaskId);
    if (!task) return null;
    let route = globalPlanner.planPath({ x: r.x, y: r.y }, r.pickedUp === false ? task.pickup : task.destination);
    if (r.pickedUp === false) route = [...route, ...globalPlanner.planPath(task.pickup, task.destination).slice(1)];
    return route.length >= 2 ? { robotId: r.id, taskId: task.id, route, schedule: [], planner: "A*" } : null;
  }

  _queueCommand(cmd) {
    if (!cmd) return;
    cmd.deliverAt = this.simTime + this.link.latencyMs / 1000;
    this._pendingCommands = this._pendingCommands.filter(c => c.robotId !== cmd.robotId); // newest supersedes
    this._pendingCommands.push(cmd);
  }

  /** Delivers due commands over the robot<->server link (latency, loss, retry). */
  deliverCommands() {
    const keep = [];
    for (const c of this._pendingCommands) {
      if (this.simTime + 1e-9 < c.deliverAt) { keep.push(c); continue; }
      if (this._dropNext()) {
        this.runStats.droppedCommands++;
        c.deliverAt = this.simTime + CENTRAL_CYCLE_SECONDS + this.link.latencyMs / 1000; // retransmit
        keep.push(c);
        continue;
      }
      this._applyCommand(c);
    }
    this._pendingCommands = keep;
  }

  _applyCommand(c) {
    const r = this.fleetState.get(c.robotId);
    if (!r || r.currentTaskId !== c.taskId || r._maneuver || ["ERROR", "error", "failed"].includes(r.status)) return;
    this.runStats.downlinkCommands++;
    const hadRoute = Array.isArray(r.plannedPath) && r.plannedPath.length > 1 && r.status !== "ASSIGNED";
    const oldTail = hadRoute ? JSON.stringify(r.plannedPath.slice(r.pathCursor || 0).map(p => [Math.round(p.x), Math.round(p.y)])) : null;
    r.plannedPath = c.route;
    r.currentPath = c.route;
    r._cursorPath = null;
    r.pathCursor = 0;
    r.targetX = c.route[1].x;
    r.targetY = c.route[1].y;
    r.heading = Math.atan2(r.targetY - r.y, r.targetX - r.x);
    r.cbsSchedule = c.schedule;
    r.plannerUsed = c.planner;
    if (r.status === "ASSIGNED" || r.status === "IDLE") {
      r.status = "MOVING";
      r.velocity = r.targetVelocity || 1.2;
      const t = taskManager.getTaskById(c.taskId);
      if (t && t.status === TASK_STATUS.ASSIGNED) taskManager.startTask(c.taskId);
    }
    // A replan counts only when the remaining route geometry really changed.
    const newTail = JSON.stringify(c.route.slice(1).map(p => [Math.round(p.x), Math.round(p.y)]));
    if (hadRoute && oldTail !== newTail && !oldTail.endsWith(newTail.slice(1))) {
      this.runStats.replansCount++;
      this.logEvent(r.id, "PATH_REPLANNED", `Central ${c.planner} replan for ${r.id}: route geometry changed (${c.route.length} waypoints).`);
    }
  }

  // ------------------------------------------------------------------------
  // Hooks used by the execution layer (SimEngine) around robot motion
  // ------------------------------------------------------------------------

  /** Central intersection reservation: may robot r move to (nx, ny)? */
  mayEnter(r, nx, ny) {
    return this.intersections.tryEnter(r, nx, ny);
  }

  beginMotion(robots) {
    this.intersections.beginTick(robots);
  }

  /** Central traffic recovery after motion (the server decides for every robot). */
  afterMotion(robots, dt) {
    this.recovery.run(robots, dt, id => taskManager.getTaskById(id));
  }

  /** Measured System 1 metrics for the active run. */
  getCentralMetrics() {
    const s = this.runStats;
    return {
      allocation: {
        method: "Hungarian batch assignment (central server)",
        cycleSeconds: CENTRAL_CYCLE_SECONDS,
        cycles: s.allocationCycles,
        decisions: s.allocationDecisions,
        avgCycleComputeMs: s.allocationCycles ? Math.round((s.allocationComputeMsTotal / s.allocationCycles) * 1000) / 1000 : null,
        ...taskManager.getTimingStats()
      },
      planning: {
        method: "Conflict-Based Search (space-time A* low level)",
        runs: s.cbsRuns,
        conflictsResolved: s.cbsConflictsResolved,
        ctNodesExpanded: s.cbsNodesExpanded,
        boundedRuns: s.cbsTruncatedRuns,
        avgPlanMs: s.cbsRuns ? Math.round((s.cbsPlanMsTotal / s.cbsRuns) * 100) / 100 : null,
        maxPlanMs: Math.round(s.cbsPlanMsMax * 100) / 100,
        scheduleHolds: s.scheduleHolds,
        replans: s.replansCount
      },
      collisionDetection: this.detector.snapshot(),
      arbitration: { conflictsDetected: s.conflictsDetected, activeConflicts: conflictManager.getActiveConflictList().length },
      communication: {
        uplinkMessages: s.uplinkMessages,
        downlinkCommands: s.downlinkCommands,
        droppedCommands: s.droppedCommands,
        linkLatencyMs: this.link.latencyMs,
        linkLossRate: this.link.lossRate
      },
      serverOnline: this.serverOnline,
      serverOutageSeconds: Math.round(s.serverOutageSeconds * 10) / 10
    };
  }


  logEvent(actor, type, desc) {
    const now = new Date();
    const timeStr = now.toTimeString().split(" ")[0];
    const event = {
      time: timeStr,
      actor,
      type,
      desc,
      timestamp: Date.now()
    };
    this.events.unshift(event);
    if (this.events.length > 80) this.events.pop();
  }

  getGlobalFleetState() {
    return Array.from(this.fleetState.values());
  }

  getRobot(robotId) {
    return this.fleetState.get(robotId) || null;
  }

  getRunStats() {
    return { ...this.runStats };
  }

  getEvents() {
    return [...this.events];
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifySubscribers() {
    for (const cb of this.listeners) {
      try { cb(this); } catch (e) { console.error("Coordinator listener error", e); }
    }
  }
  /**
   * step(dt) — public alias for tick(dt), required by SimEngine and integration tests.
   */
  step(deltaTime = 0.1) {
    this.tick(deltaTime);
  }
}

export const centralizedCoordinator = new CentralizedCoordinator();
