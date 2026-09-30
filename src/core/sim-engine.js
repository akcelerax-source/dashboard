// ==========================================================================
// NODEX — Warehouse simulation engine (architecture-neutral execution layer)
// Owns: the simulation clock, robot kinematics / physics integration (robot
// footprint vs robots, racks, walls, dynamic objects), the on-board sensor
// model, the physical-safety monitor and the scenario clock.
// It does NOT coordinate: each tick it runs exactly ONE controller, the one
// selected for the run (never all three):
//   centralized   -> CentralizedCoordinator (central server)
//   decentralized -> DecentralizedFleet agents (fixed-pair P2P)
//   ace           -> DecentralizedFleet agents (NodeX Edge AI ACE decentralized)
// Movement permissions come from that controller (central reservation table
// or the robot's own node-access decision); the engine only enforces physics.
// ==========================================================================

import { robotTimeline } from "./robot-timeline.js";
import { aceTestMonitor } from "./ace-test-monitor.js";
import { state } from "./state.js";
import { centralizedCoordinator } from "./centralized/CentralizedCoordinator.js";
import { decentralizedFleet } from "./decentralized/DecentralizedFleet.js";
import { taskManager } from "./centralized/TaskManager.js";
import { conflictManager } from "./centralized/ConflictManager.js";
import { globalPlanner } from "./centralized/GlobalPlanner.js";
import { scenarioEngine } from "./scenario-engine.js";
import { PhysicsMonitor } from "./physics-monitor.js";
import { senseFrame, resetSensorNoise } from "./sensor-sim.js";
import { deriveTaskPhase } from "./task-lifecycle.js";
import { aceFeature } from "./ace/ace-features.js";
import {
  MapGeometryEngine,
  WAREHOUSE_DIMENSIONS,
  ROBOT_FOOTPRINT,
  DRIVING_AISLES,
  SHELF_OBSTACLES,
  worldTierFor
} from "./map-geometry.js";

// WS4 fix-health-speed (see applyOperatorOverrides and scenario-engine.js).
const FIX_HEALTH_SPEED = aceFeature("fix-health-speed");

export const CONTROLLER_CLASSES = {
  centralized: "CentralizedCoordinator (central server: Hungarian + CBS + central detector)",
  decentralized: "RobotAgent x N (CNP bidding + fixed-pair P2P + sensor-only detection)",
  ace: "RobotAgent x N + EdgeAiPredictor + RACE + AceSessionManager"
};

/**
 * Moves the robot's navigation cursor to the next waypoint of its planned path.
 * The cursor is tracked per path array (reset when a replan/new assignment
 * replaces the array) and only moves forward.
 */
export function advanceAlongPath(r) {
  const path = r.plannedPath;
  if (!Array.isArray(path) || path.length === 0) return;
  if (r._cursorPath !== path) {
    r._cursorPath = path;
    const ti = path.findIndex(p => Math.hypot(p.x - r.targetX, p.y - r.targetY) < 1);
    r.pathCursor = ti >= 0 ? ti : 0;
  }
  for (let k = (r.pathCursor || 0) + 1; k < path.length; k++) {
    if (Math.hypot(path[k].x - r.x, path[k].y - r.y) >= 6) {
      r.pathCursor = k;
      r.prevX = r.x;
      r.prevY = r.y;
      r.targetX = path[k].x;
      r.targetY = path[k].y;
      r.heading = Math.atan2(r.targetY - r.y, r.targetX - r.x);
      return;
    }
  }
  r.pathCursor = path.length - 1;
}

/**
 * True when moving robot `r` to (nextX, nextY) would reduce its distance to a
 * robot that is (or would be) closer than `minDist` (footprint + margin).
 */
export function closesSeparation(r, nextX, nextY, robots, minDist) {
  for (const other of robots) {
    if (other === r || other.id === r.id) continue;
    const nextDist = Math.hypot(other.x - nextX, other.y - nextY);
    if (nextDist < minDist && nextDist < Math.hypot(other.x - r.x, other.y - r.y)) return true;
  }
  return false;
}

/**
 * Human-in-the-loop overrides on the autonomous velocity command. HITL is an
 * ACE-only capability: in any other architecture the operator flags are
 * ignored here even if something set them. A scenario-injected stall is a
 * physical fault and applies to every architecture.
 */
export function applyOperatorOverrides(r, velocity, systemMode = "ace") {
  if (r.scenarioStall) return 0;
  // fix-health-speed: a health-degraded drive train cannot exceed its degraded
  // speed, whatever the controller commands (identical for all three systems;
  // ACE's envelope logic rewrote targetVelocity every tick and so ignored it).
  if (FIX_HEALTH_SPEED && typeof r.healthSpeedCap === "number") velocity = Math.min(velocity, r.healthSpeedCap);
  if (systemMode !== "ace") return velocity;
  if (r.hitlHold || r.controlMode === "HUMAN") return 0;
  if (typeof r.hitlSpeedLimit === "number") return Math.min(velocity, r.hitlSpeedLimit);
  return velocity;
}

const RACE_SEVERITY = ["LOCAL", "NEIGHBORHOOD", "CONTAINMENT", "SAFE-DEGRADED"];
const RACE_INPUT_KEYS = ["conflict", "uncertainty", "commRisk", "queueGrowth", "cascadePressure"];
const FAILED = ["ERROR", "error", "failed"];
const PX_PER_VEL = 22;
// Sim seconds allowed after the last task for robots to reach their bays.
export const RETURN_GRACE_SECONDS = 30;
// A run with no task completed for this long (sim seconds) is gridlocked /
// livelocked and ends with END_REASONS.NO_PROGRESS (scored, not excluded).
export const NO_PROGRESS_SECONDS = 300;

export class SimEngine {
  constructor() {
    this.animationFrameId = null;
    this.lastTimestamp = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    this.simSpeed = 1.0;
    this.isRunning = true;
    this.lastUiBroadcast = 0;
    this.tasksCompleted = 0;
    this.physics = new PhysicsMonitor();
    this.activeController = null;

    this.worldWidth = WAREHOUSE_DIMENSIONS.width;
    this.worldHeight = WAREHOUSE_DIMENSIONS.height;
    this.centralNode = { x: 450, y: 35, id: "Central-Coord-01" };
    this.crossingZone = { x: 352, y: 305, radius: 42, name: "Crossing Aisle A-B" };

    // Dynamic world objects exist only when a scenario injects them (humans
    // walking a lane, dropped pallets). They physically block robots.
    this.dynamicHumans = [];
    this.dynamicObstacles = [];

    // Map regeneration: rebuild the planner graphs that read the layout.
    MapGeometryEngine.onLayoutGenerated = () => {
      if (globalPlanner && typeof globalPlanner.rebuildGraph === "function") globalPlanner.rebuildGraph();
      if (centralizedCoordinator.cbs) centralizedCoordinator.cbs.setGraph(globalPlanner.graph);
      this.worldWidth = WAREHOUSE_DIMENSIONS.width;
      this.worldHeight = WAREHOUSE_DIMENSIONS.height;
    };

    const initialCount = state.get("robotCount") || 50;
    this.initFleet(initialCount);

    state.subscribe("robotCount", (newCount) => {
      this.initFleet(newCount);
    });

    // Switching architecture tears the previous controller down completely
    // (agents, bus, central state, sessions, contracts, paths) and builds only
    // the newly selected one.
    state.subscribe("systemMode", (newMode, oldMode) => {
      if (newMode !== oldMode) this.initFleet(state.get("robotCount") || 3);
    });
  }

  /**
   * Builds the fleet under exactly one controller. The other two
   * architectures hold no robots, no tasks and no live state afterwards.
   */
  initFleet(count) {
    if (state.get("configLocked")) {
      console.warn("[SimEngine] initFleet ignored: run configuration is locked.");
      return;
    }
    const validCount = Number(count) || 50;
    const systemMode = state.get("systemMode") || "ace";
    const wantTier = MapGeometryEngine.worldTierOverride || worldTierFor(validCount);
    const layoutCfg = MapGeometryEngine.generatedLayout?.config;
    if (!MapGeometryEngine.layoutLocked && (layoutCfg?.fleetSize !== validCount || layoutCfg?.worldTier !== wantTier)) {
      MapGeometryEngine.loadMap(state.get("selectedMap") || "WH-A", null, validCount);
    }
    this.physics.reset();
    robotTimeline.reset();
    resetSensorNoise();
    this.dynamicHumans = [];
    this.dynamicObstacles = [];
    this._lastMetricsPublish = -Infinity;
    state.set("dynamicWorldObjects", []);
    state.set("activeSessions", []);
    state.set("contracts", []);

    if (systemMode === "centralized") {
      decentralizedFleet.reset();                 // no agents, no bus subscribers
      centralizedCoordinator.initializeFleet(validCount);
      state.set("robots", centralizedCoordinator.getGlobalFleetState());
    } else {
      centralizedCoordinator.initializeFleet(0);  // no central fleet or queue
      decentralizedFleet.initializeFleet(validCount, systemMode === "decentralized" ? "decentralized" : "ace");
      state.set("robots", decentralizedFleet.getGlobalFleetState());
    }
    this.activeController = systemMode;
    state.set("activeController", {
      system: systemMode,
      controller: CONTROLLER_CLASSES[systemMode] || CONTROLLER_CLASSES.ace,
      robots: validCount,
      centralFleetSize: centralizedCoordinator.fleetState.size,
      agentCount: decentralizedFleet.agents.size
    });
    state.set("architectureMetrics", null);
    state.set("physicsMetrics", this.physics.snapshot());
  }

  // ------------------------------------------------------------------------
  // Dynamic world objects (scenario-injected), architecture-neutral physics
  // ------------------------------------------------------------------------

  /**
   * Spawns the two walking operators used by dynamic-obstacle scenarios. They
   * walk service walkways beside the outer cross lanes (not along robot
   * lanes) and cross the horizontal aisles.
   */
  spawnHumans() {
    const aisles = MapGeometryEngine.getActiveAisles();
    const v = aisles.vertical;
    if (!v.length) return;
    const b = WAREHOUSE_DIMENSIONS.bounds;
    const walkways = [v[0].x - 45, v[v.length - 1].x + 45];
    this.dynamicHumans = walkways.map((x, i) => ({
      id: `H-${i + 1}`, x, y: i === 0 ? b.minY + 60 : b.maxY - 60, vy: i === 0 ? 10 : -10,
      minY: b.minY + 10, maxY: b.maxY - 10, label: i === 0 ? "Operator 1" : "Inspector 2", blockedFor: 0
    }));
  }

  /**
   * Operators give way: they wait at the edge of an aisle while a robot is
   * near the crossing, stop for any robot in front, and turn back after 2 s.
   */
  _stepHumans(dt, robots) {
    const lanes = MapGeometryEngine.getActiveAisles().horizontal;
    for (const h of this.dynamicHumans) {
      const ny = h.y + h.vy * dt;
      const bump = robots.some(r => Math.hypot(r.x - h.x, r.y - ny) < ROBOT_FOOTPRINT.radius + 10);
      const entering = lanes.find(l => h.x >= l.minX - 20 && h.x <= l.maxX + 20
        && Math.abs(ny - l.y) < 28 && Math.abs(h.y - l.y) >= 28);
      const laneBusy = entering && robots.some(r => Math.hypot(r.x - h.x, r.y - entering.y) < 70);
      if (bump || laneBusy) {
        h.blockedFor += dt;
        if (h.blockedFor > 2) { h.vy = -h.vy; h.blockedFor = 0; }
        continue;
      }
      h.blockedFor = 0;
      h.y = ny;
      if (h.y > h.maxY || h.y < h.minY) { h.vy = -h.vy; h.y = Math.max(h.minY, Math.min(h.maxY, h.y)); }
    }
  }

  worldObjects() {
    return [
      ...this.dynamicHumans.map(h => ({ id: h.id, x: h.x, y: h.y, radius: 8, kind: "human", static: false, label: h.label })),
      ...this.dynamicObstacles.map(o => ({ id: o.id, x: o.x, y: o.y, radius: Math.max(o.width || 20, o.height || 20) / 2, kind: "obstacle", static: true, label: o.type }))
    ];
  }

  _blockedByObject(r, nx, ny, objects) {
    for (const o of objects) {
      const minD = ROBOT_FOOTPRINT.radius + o.radius + 2;
      const dNext = Math.hypot(o.x - nx, o.y - ny);
      if (dNext < minD && dNext < Math.hypot(o.x - r.x, o.y - r.y)) return true;
    }
    return false;
  }

  /**
   * Physics step for one robot. `speed` is the controller's commanded speed;
   * `mayEnter(nextX, nextY)` is the controller's movement permission
   * (central reservation or robot-local node access). Returns the reason the
   * robot did not move ("robot" | "rack" | "bounds" | "object" | "permission"), or null.
   */
  _move(r, simDt, speed, robots, objects, mayEnter) {
    const dx = r.targetX - r.x, dy = r.targetY - r.y;
    if (Math.hypot(dx, dy) < 6) {
      r.x = r.targetX;
      r.y = r.targetY;
      advanceAlongPath(r);
    }
    r.heading = Math.atan2(r.targetY - r.y, r.targetX - r.x);
    r.velocity = speed;
    if (!(speed > 0)) return null;
    const step = speed * simDt * PX_PER_VEL;
    const nextX = r.x + Math.cos(r.heading) * step;
    const nextY = r.y + Math.sin(r.heading) * step;
    let reason = null;
    if (closesSeparation(r, nextX, nextY, robots, ROBOT_FOOTPRINT.totalRadius * 2 - 2)) reason = "robot";
    else if (MapGeometryEngine.isPointInObstacle(nextX, nextY, ROBOT_FOOTPRINT.radius).collision) reason = "rack";
    else if (!MapGeometryEngine.isWithinBounds(nextX, nextY, ROBOT_FOOTPRINT.radius)) reason = "bounds";
    else if (this._blockedByObject(r, nextX, nextY, objects)) reason = "object";
    else if (!mayEnter(nextX, nextY)) reason = "permission";
    if (reason) {
      r.velocity = 0;
      return reason;
    }
    r.x = nextX;
    r.y = nextY;
    r.traveledDistance = (r.traveledDistance || 0) + step;
    return null;
  }

  start() {
    this.isRunning = true;
    state.set("simRunning", true);
    this.lastTimestamp = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    this.lastRafTickMs = 0;
    const loop = (timestamp) => {
      if (!this.isRunning) return;
      const ts = timestamp || ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now());
      const dt = Math.min((ts - this.lastTimestamp) / 1000, 0.1);
      this.lastTimestamp = ts;
      this.lastRafTickMs = Date.now();
      this.update(dt);
      if (typeof requestAnimationFrame !== "undefined") {
        this.animationFrameId = requestAnimationFrame(loop);
      }
    };
    if (typeof requestAnimationFrame !== "undefined") {
      this.animationFrameId = requestAnimationFrame(loop);
    }
    // Fallback driver: requestAnimationFrame is throttled to zero in hidden/
    // headless tabs. If rAF goes silent while running, drive ticks on an
    // interval so the simulation keeps advancing. Stands down while rAF is healthy.
    if (this.fallbackIntervalId) {
      clearInterval(this.fallbackIntervalId);
      this.fallbackIntervalId = null;
    }
    this.fallbackIntervalId = setInterval(() => {
      if (!this.isRunning) return;
      if (Date.now() - this.lastRafTickMs < 300) return;
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const dt = Math.min((now - this.lastTimestamp) / 1000, 0.1);
      this.lastTimestamp = now;
      this.update(dt);
    }, 50);
  }

  pause() {
    this.isRunning = false;
    state.set("simRunning", false);
    if (this.animationFrameId && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.fallbackIntervalId) {
      clearInterval(this.fallbackIntervalId);
      this.fallbackIntervalId = null;
    }
  }

  stop() {
    this.pause();
    const robots = state.get("robots") || [];
    for (const r of robots) {
      r.velocity = 0;
      r.status = "STOPPED";
      r.isYielding = true;
    }
    state.set("robots", [...robots]);
    this.addEvent("SIM", "LIFECYCLE", "Simulation stopped by operator - all AMR motion halted.");
  }

  /**
   * Canonical reset: stops the loop, clears all transient state, reinitializes fleet.
   * Pass autoStart=true to resume the simulation loop after reset (default: false for
   * use from initialize() where callers control start).
   */
  reset(autoStart = false) {
    this.pause();
    this.tasksCompleted = 0;
    state.set("simTimeSeconds", 0);
    // Clear the previous run's task KPIs: the completion check reads the KPIs
    // published by the last tick, so a finished run's "0 open / N total" made
    // the next run auto-finish on its very first tick.
    state.set("kpis", {
      ...(state.get("kpis") || {}),
      activeTasks: 0,
      pendingTasks: 0,
      totalTasks: 0,
      throughput: "Awaiting telemetry"
    });
    state.set("activeFaults", []);
    state.set("activeSessions", []);
    state.set("contracts", []);
    state.set("events", []);

    const systemMode = state.get("systemMode") || "ace";
    const count = state.get("robotCount") || 3;

    // initFleet builds the selected controller only (and tears down the others).
    this.initFleet(count);

    if (autoStart) this.start();
  }

  /**
   * Layer B Execution Interface: Applies commands from Centralized Coordinator
   */
  applyCoordinatorCommands(fleetCommands) {
    const robots = state.get("robots") || [];
    for (const cmd of fleetCommands) {
      const r = robots.find(item => item.id === cmd.id);
      if (r) {
        // Mirror the coordinator's path exactly, including clearing it on task
        // completion, so a replanned or finished route never lingers on the map.
        if (Array.isArray(cmd.currentPath) && cmd.currentPath !== r.plannedPath) {
          r.plannedPath = cmd.currentPath;
          r.currentPath = cmd.currentPath;
        }
        r.currentTask = cmd.currentTask;
        r.currentTaskId = cmd.currentTaskId;
        r.targetX = cmd.targetX !== undefined ? cmd.targetX : r.targetX;
        r.targetY = cmd.targetY !== undefined ? cmd.targetY : r.targetY;
        r.targetVelocity = cmd.targetVelocity !== undefined ? cmd.targetVelocity : r.targetVelocity;
        r.status = cmd.status !== undefined ? cmd.status : r.status;
        r.isYielding = cmd.isYielding !== undefined ? cmd.isYielding : r.isYielding;
        if (cmd.status === "WAITING" || cmd.isYielding) {
          r.velocity = 0;
        }
      }
    }
  }

  applySingleCommand(robotId, command) {
    const robots = state.get("robots") || [];
    const r = robots.find(item => item.id === robotId);
    if (r) {
      if (command.velocity !== undefined) r.velocity = command.velocity;
      if (command.status !== undefined) r.status = command.status;
      if (command.target) {
        r.targetX = command.target.x;
        r.targetY = command.target.y;
      }
    }
  }

  getSimulatedRobotStates() {
    const robots = state.get("robots") || [];
    return robots.map(r => ({
      id: r.id,
      x: r.x,
      y: r.y,
      heading: r.heading,
      velocity: r.velocity,
      status: r.status,
      battery: r.battery,
      health: r.health
    }));
  }

  // Simulation speed (0.25x-5x) scales the WHOLE simulation clock, not robot
  // velocity: at speed > 1 each frame runs ceil(speed) complete sub-steps of
  // at most the base step, so physics, coordination, timers, faults and task
  // handling all advance together with the same fidelity as at 1x.
  update(dt, force = false) {
    if (!force && !state.get("simRunning")) return;
    const speed = state.get("simSpeed") || 1.0;
    const steps = Math.max(1, Math.ceil(speed - 1e-9));
    const stepDt = (dt * speed) / steps;
    for (let i = 0; i < steps; i++) {
      if (i > 0 && !force && !state.get("simRunning")) return;
      this._step(stepDt);
    }
  }

  _step(simDt) {
    const currentTime = (state.get("simTimeSeconds") || 0) + simDt;
    state.set("simTimeSeconds", currentTime);

    // Natural termination: a run is complete only when no task is open
    // (UNASSIGNED counts as open). Guarded by run ID so it fires once.
    const kpis = state.get("kpis") || {};
    const openTasks = (kpis.activeTasks || 0) + (kpis.pendingTasks || 0);
    const totalTasks = kpis.totalTasks || 0;
    const runId = state.get("runId");
    // All tasks done: the task makespan is recorded now, then the run keeps
    // simulating until every working robot has driven off the lanes to its
    // post-task bay (or RETURN_GRACE_SECONDS pass), so no robot is left
    // standing on a track when the run ends.
    const allDone = openTasks <= 0 && totalTasks > 0 && state.get("simLifecycleState") === "RUNNING";
    if (allDone && this._tasksDoneRunId !== runId) {
      this._tasksDoneRunId = runId;
      state.set("tasksCompletedAtSeconds", currentTime);
    }
    const doneAt = this._tasksDoneRunId === runId ? state.get("tasksCompletedAtSeconds") : null;
    if (allDone && this.finishedRunId !== runId
        && (this._fleetParked() || currentTime - doneAt >= RETURN_GRACE_SECONDS)) {
      this.finishedRunId = runId;
      import("./sim-lifecycle.js").then(m => {
        if (state.get("runId") === runId) m.simLifecycle.finish();
      }).catch(err => {
        console.error("Auto-finish failed:", err);
        this.finishedRunId = null;
      });
    }

    // Runs continue until every task is complete. The only automatic stop is
    // the NO-PROGRESS watchdog: no task completed for NO_PROGRESS_SECONDS of
    // sim time (gridlock / livelock). Such a run is recorded (end reason
    // NO_PROGRESS) and scored: its throughput counts the whole elapsed time.
    // An optional explicit durationSeconds (bench/tests only) still applies.
    const activeCfg = state.get("simActiveConfig");
    const limit = activeCfg && activeCfg.runId === runId ? activeCfg.durationSeconds : null;
    const completedNow = kpis.completedTasks || 0;
    if (this._progressRunId !== runId || completedNow !== this._progressCount) {
      this._progressRunId = runId;
      this._progressCount = completedNow;
      this._progressAt = currentTime;
    }
    if (doneAt === null && currentTime - this._progressAt >= NO_PROGRESS_SECONDS
        && state.get("simLifecycleState") === "RUNNING" && this.finishedRunId !== runId) {
      this.finishedRunId = runId;
      import("./sim-lifecycle.js").then(m => {
        if (state.get("runId") === runId) m.simLifecycle.finish(m.END_REASONS.NO_PROGRESS);
      }).catch(err => {
        console.error("No-progress finish failed:", err);
        this.finishedRunId = null;
      });
    }
    if (limit && currentTime >= limit && doneAt === null
        && state.get("simLifecycleState") === "RUNNING"
        && this.finishedRunId !== runId) {
      this.finishedRunId = runId;
      import("./sim-lifecycle.js").then(m => {
        if (state.get("runId") === runId) m.simLifecycle.finish(m.END_REASONS.DURATION_LIMIT);
      }).catch(err => {
        console.error("Duration-limit finish failed:", err);
        this.finishedRunId = null;
      });
    }

    // Scenario faults fire on sim time (applied once, not every frame).
    if (scenarioEngine && state.get("simLifecycleState") === "RUNNING") {
      scenarioEngine.processTimedEvents(currentTime);
    }

    const systemMode = this.activeController || state.get("systemMode") || "ace";
    const pre = state.get("robots") || [];
    this._stepHumans(simDt, pre);
    const objects = this.worldObjects();
    state.set("dynamicWorldObjects", objects);

    if (systemMode === "centralized") {
      this._updateCentralized(simDt, currentTime, objects);
    } else {
      this._updateDecentralized(simDt, currentTime, objects, systemMode);
    }

    // Ground-truth physical safety accounting (identical for every system).
    const robots = state.get("robots") || [];
    this.physics.observe(robots);
    if (state.get("simLifecycleState") === "RUNNING") {
      robotTimeline.sample(robots, currentTime);
      if (aceTestMonitor.active) aceTestMonitor.sample(robots, currentTime, simDt, systemMode);
    }
    state.set("physicsMetrics", this.physics.snapshot());
    if (currentTime - this._lastMetricsPublish >= 0.5) {
      this._lastMetricsPublish = currentTime;
      state.set("architectureMetrics", this.getArchitectureMetrics());
    }
  }

  /** Every non-failed robot is parked off the lanes with no task or return leg. */
  _fleetParked() {
    return (state.get("robots") || []).every(r => FAILED.includes(r.status)
      || (!r.currentTaskId && !r.parkingBay && !r.handling && !r._maneuver && MapGeometryEngine.isOffLane(r.x, r.y)));
  }

  /** Measured metrics of the ONE controller of this run. */
  getArchitectureMetrics() {
    const mode = this.activeController || state.get("systemMode") || "ace";
    return {
      system: mode,
      controller: CONTROLLER_CLASSES[mode],
      runId: state.get("runId") || null,
      physics: this.physics.snapshot(),
      ...(mode === "centralized" ? centralizedCoordinator.getCentralMetrics() : decentralizedFleet.getArchitectureMetrics())
    };
  }

  _publishKpis(robots, currentTime, registry, activeAlerts) {
    const completed = registry.getCompletedCount();
    const throughputVal = currentTime > 10
      ? (completed > 0 ? `${Math.round(completed / (currentTime / 3600))} tasks/hr` : "0 tasks/hr")
      : "Awaiting telemetry";
    const healthValues = robots.map(r => typeof r.health === "number" ? r.health : 100);
    const avgHealth = healthValues.length ? (healthValues.reduce((s, v) => s + v, 0) / healthValues.length).toFixed(1) : "100.0";
    state.set("kpis", {
      activeRobots: robots.length,
      idleRobots: robots.filter(r => r.velocity === 0 && !FAILED.includes(r.status)).length,
      activeTasks: registry.getActiveTasks().length,
      pendingTasks: registry.getUnassignedTasks().length,
      completedTasks: completed,
      totalTasks: registry.getTotalCount(),
      throughput: throughputVal,
      systemHealth: robots.length ? `${avgHealth}%` : "Awaiting telemetry",
      activeAlerts
    });
  }

  // ------------------------------------------------------------------------
  // System 1: the central server decides, robots execute
  // ------------------------------------------------------------------------
  _updateCentralized(simDt, currentTime, objects) {
    centralizedCoordinator.tick(simDt, currentTime);
    const robots = state.get("robots") || [];
    centralizedCoordinator.beginMotion(robots);
    for (const r of robots) {
      if (FAILED.includes(r.status)) { r.velocity = 0; continue; }
      // Loading / unloading at a station: the robot stands still.
      if (r.handling) { r.velocity = 0; r.waitingForNode = null; continue; }
      // Central commands: server offline (safe hold), central collision halt,
      // CBS schedule hold, conflict wait.
      if (r.centralHold || r.centralHalt || r.scheduleHold || r.status === "WAITING" || r.isYielding) {
        r.velocity = 0;
        if (r.status === "WAITING" || r.isYielding) r.stalledDuration = (r.stalledDuration || 0) + simDt;
        r.waitingForNode = null;
        continue;
      }
      const speed = applyOperatorOverrides(r, r.status === "MOVING" ? (r.targetVelocity || 1.2) : 0, "centralized");
      const why = this._move(r, simDt, speed, robots, objects, (nx, ny) => centralizedCoordinator.mayEnter(r, nx, ny));
      r.waitingForNode = why === "permission" ? centralizedCoordinator.intersections.lastBlockedKey : null;
      r.location = resolveWarehouseLocation(r.x, r.y);
      // System 1 has no ACE envelope.
      r.envelopeRadius = 0;
      r.raceState = null;
      r.riskScore = null;
      r.riskComponents = null;
      r.coordinationScope = "Central server";
    }
    centralizedCoordinator.afterMotion(robots, simDt);
    for (const r of robots) r.taskPhase = deriveTaskPhase(r);
    state.set("robots", [...robots]);

    state.updateCoordinationState({
      centralServer: {
        activeRadioChannels: robots.length,
        status: centralizedCoordinator.serverOnline ? "ONLINE" : "OFFLINE"
      },
      peerNetwork: { status: "NOT_USED" },
      raceStatus: "INACTIVE",
      raceMode: "OFF",
      raceRiskComponents: null,
      activeEnvelopes: [],
      ace: { status: "OFFLINE", adaptiveEnvelope: false, hysteresisEnabled: false }
    });
    this._publishKpis(robots, currentTime, taskManager,
      conflictManager.getActiveConflictList().length + (robots.some(r => FAILED.includes(r.status)) ? 1 : 0));
    state.set("events", centralizedCoordinator.getEvents());
    state.set("tasks", taskManager.getAllTasks());
    // Live central arbitrations (real ConflictManager records). Space-time
    // contracts are an ACE concept: System 1 publishes none.
    state.set("activeSessions", conflictManager.getActiveConflictList().map(c => ({
      id: c.id,
      status: "Active",
      robots: [c.winnerId, c.loserId],
      size: 2,
      type: "Central priority arbitration",
      scope: "CENTRAL SERVER",
      reason: c.reason,
      progressStatus: `${c.winnerId} has right-of-way; ${c.loserId} waiting`
    })));
    state.set("contracts", []);
  }

  // ------------------------------------------------------------------------
  // Systems 2 and 3: every robot decides for itself from its own sensors and
  // peer messages; the engine only simulates sensors and physics.
  // ------------------------------------------------------------------------
  _updateDecentralized(simDt, currentTime, objects, systemMode) {
    const isAce = systemMode === "ace";
    const truth = decentralizedFleet.getGlobalFleetState();
    const frames = new Map();
    for (const r of truth) frames.set(r.id, senseFrame(r, truth, objects));
    decentralizedFleet.tick(simDt, currentTime, frames);

    const fleetState = decentralizedFleet.getGlobalFleetState();
    for (const r of fleetState) {
      const agent = decentralizedFleet.getAgent(r.id);
      r.taskPhase = deriveTaskPhase(r);
      if (FAILED.includes(r.status)) {
        r.velocity = 0;
        if (agent) agent.updatePhysicalState(r);
        continue;
      }
      if (r.handling) {
        r.velocity = 0;
        r.waitingForNode = null;
        if (agent) agent.updatePhysicalState(r);
        continue;
      }
      if (r.status === "WAITING" || r.isYielding) {
        r.velocity = 0;
        r.stalledDuration = (r.stalledDuration || 0) + simDt;
        r.waitingForNode = null;
        if (agent) agent.updatePhysicalState(r);
        continue;
      }
      const commanded = r.status === "MOVING" ? (r.targetVelocity || 1.2) * (r.orcaFactor || 1) : 0;
      const speed = applyOperatorOverrides(r, commanded, systemMode);
      const why = this._move(r, simDt, speed, fleetState, objects, (nx, ny) => (agent ? agent.mayEnter(nx, ny) : true));
      r.waitingForNode = why === "permission" && agent ? agent.lastBlockedKey : null;
      r.location = resolveWarehouseLocation(r.x, r.y);
      if (agent) agent.updatePhysicalState(r);
    }
    state.set("robots", fleetState);

    const { raceMode: fleetRaceMode, raceRiskComponents } = isAce
      ? aggregateFleetRace(fleetState)
      : { raceMode: "OFF", raceRiskComponents: null };
    const runStats = decentralizedFleet.getRunStats();
    state.updateCoordinationState({
      centralServer: { status: "NOT_USED" },
      peerNetwork: {
        totalPeerMessages: runStats.peerMessagesCount || 0,
        coordinationEvents: runStats.coordinationEventsCount || 0,
        activeSessions: decentralizedFleet.getActiveSessions().length,
        activeContracts: decentralizedFleet.getContracts().length,
        status: "ONLINE"
      },
      raceStatus: isAce ? "ACTIVE" : "INACTIVE",
      raceMode: fleetRaceMode,
      raceRiskComponents,
      activeEnvelopes: isAce
        ? fleetState.filter(r => r.raceState && r.raceState !== "LOCAL").map(r => ({
            robotId: r.id, state: r.raceState, radius: r.envelopeRadius || 0, scope: r.coordinationScope, groupSize: r.coordinationGroupSize
          }))
        : [],
      ace: { status: isAce ? "ONLINE" : "OFFLINE", adaptiveEnvelope: isAce, hysteresisEnabled: isAce }
    });
    this._publishKpis(fleetState, currentTime, decentralizedFleet.taskRegistry,
      fleetState.filter(r => FAILED.includes(r.status) || r.raceState === "CONTAINMENT" || r.raceState === "SAFE-DEGRADED" || r.status === "WAITING").length);
    state.set("events", decentralizedFleet.getEvents());
    state.set("tasks", decentralizedFleet.taskRegistry.getAllTasks());
    state.set("activeSessions", decentralizedFleet.getActiveSessions());
    state.set("contracts", isAce ? decentralizedFleet.getContracts() : []);
  }

  injectFault(faultType, targetRobotId = "R02") {
    const robots = state.get("robots") || [];
    const target = robots.find(r => r.id === targetRobotId) || robots[1];
    if (!target) return;

    const systemMode = state.get("systemMode") || "ace";

    if (faultType === "robot_failure" || faultType === "ROBOT_FAILED") {
      target.status = "error";
      target.velocity = 0;
      target.health = 20;

      const faults = state.get("activeFaults") || [];
      faults.push({
        id: `F-${Date.now().toString().slice(-4)}`,
        type: "Robot Hardware Fault",
        targetRobot: target.id,
        timeInjected: this.formatSimTime(state.get("simTimeSeconds")),
        status: "Active",
        description: `AMR ${target.id} motor stall reported. Task reallocation initiated.`
      });
      state.set("activeFaults", [...faults]);

      if (systemMode === "centralized") {
        centralizedCoordinator.handleRobotFailure(target.id, "Actuator motor stall");
      } else {
        decentralizedFleet.handleRobotFailure(target.id, "Actuator motor stall");
      }
    } else if (faultType === "comm_loss") {
      const faults = state.get("activeFaults") || [];
      faults.push({
        id: `F-${Date.now().toString().slice(-4)}`,
        type: "Communication Packet Loss",
        targetRobot: target.id,
        timeInjected: this.formatSimTime(state.get("simTimeSeconds")),
        status: "Active",
        description: systemMode === "centralized"
          ? `Server link to ${target.id} lost: robot performs a safe stop until the link returns.`
          : `Wireless blackout on ${target.id}: peers stop hearing it.`
      });
      state.set("activeFaults", [...faults]);

      if (systemMode === "centralized") {
        centralizedCoordinator.setRobotLinkLost(target.id, 10);
      } else {
        decentralizedFleet.handleCommDegradation(target.id);
      }
    }
  }

  clearFaults() {
    const robots = state.get("robots") || [];
    for (const r of robots) {
      // Use uppercase IDLE consistent with coordinator status values
      if (r.status === "error" || r.status === "active" || r.status === "ERROR") {
        r.status = "IDLE";
      }
      r.health = 98;
      r.velocity = 0; // start idle after recovery; coordinator will re-assign
    }
    state.set("activeFaults", []);
    state.set("robots", [...robots]);
    const systemMode = state.get("systemMode") || "ace";
    if (systemMode === "centralized") {
      for (const r of centralizedCoordinator.fleetState.values()) {
        if (r.status === "error" || r.status === "active" || r.status === "ERROR") {
          r.status = "IDLE";
        }
        r.health = 98;
        r.velocity = 0;
      }
      this.addEvent("SYSTEM", "CLEAR", "All injected faults cleared. Centralized fleet operational.");
    } else {
      decentralizedFleet.clearFaults();
    }
  }

  addEvent(actor, type, desc) {
    // Route to authoritative coordinator for active system mode
    const systemMode = state.get("systemMode") || "ace";
    if (systemMode === "centralized") {
      centralizedCoordinator.logEvent(actor, type, desc);
      state.set("events", centralizedCoordinator.getEvents());
    } else {
      decentralizedFleet.logEvent(actor, type, desc);
      state.set("events", decentralizedFleet.getEvents());
    }
  }

  formatSimTime(seconds = 0) {
    const s = Math.floor(seconds);
    const hrs = Math.floor(s / 3600).toString().padStart(2, "0");
    const mins = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const secs = (s % 60).toString().padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
  }

  // ========================================================================
  // COMMON SIMULATION ENGINE CONTRACT (Section 6 Interface)
  // ========================================================================

  initialize(config = {}) {
    if (config.robotCount) {
      state.set("robotCount", config.robotCount);
      state.set("fleetSize", config.robotCount);
    }
    if (config.systemMode) {
      state.set("systemMode", config.systemMode);
      state.set("selectedSystem", config.systemMode);
    }
    if (config.scenarioId) {
      state.set("selectedScenario", config.scenarioId);
    }
    if (config.map) {
      state.set("selectedMap", config.map);
    }
    this.reset();
  }

  // NOTE: reset() is defined above (line ~315). This duplicate section is part of
  // the Section 6 Interface contract and delegates to the canonical reset().
  // initialize() calls reset() which handles full teardown + reinit without auto-start.
  // Callers that need simulation to resume after reset() should call reset(true).

  step(dt = 0.1) {
    // Advance one frame without toggling the global simRunning flag: the
    // lifecycle listens to it, so a benchmark trial used to flip the live FSM
    // to RUNNING and then PAUSED, fabricating a resumable "paused run".
    this.update(dt, true);
  }

  updateRobot(robotId, patch = {}) {
    const robots = state.get("robots") || [];
    const r = robots.find(item => item.id === robotId);
    if (!r) return null;
    const mode = this.activeController || state.get("systemMode") || "ace";
    // HITL fields exist only in the ACE architecture.
    if (mode !== "ace") {
      patch = { ...patch };
      delete patch.hitlHold;
      delete patch.hitlSpeedLimit;
      delete patch.controlMode;
    }
    Object.assign(r, patch);
    state.set("robots", [...robots]);
    if (mode !== "centralized") {
      const agent = decentralizedFleet.getAgent(robotId);
      if (agent) {
        Object.assign(agent.localState, patch);
        agent.updatePhysicalState(r);
      }
    }
    return r;
  }

  getRobotState(robotId) {
    const robots = state.get("robots") || [];
    return robots.find(r => r.id === robotId) || null;
  }

  getEnvironmentState() {
    return {
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      dynamicHumans: this.dynamicHumans,
      dynamicObstacles: this.dynamicObstacles,
      worldObjects: this.worldObjects(),
      shelves: SHELF_OBSTACLES,
      drivingAisles: DRIVING_AISLES,
      centralNode: this.centralNode,
      crossingZone: this.crossingZone
    };
  }

  getSimulationTime() {
    return state.get("simTimeSeconds") || 0;
  }

  getEvents() {
    return state.get("events") || [];
  }
}

export const simEngine = new SimEngine();

export function resolveWarehouseLocation(x, y) {
  if (Math.hypot(x - 352, y - 305) < 50) return "Crossing Aisle A-B";
  if (x <= 180 && y <= 100) return "Receiving Dock";
  if (x <= 180 && y >= 340) return "West Staging";
  if (x >= 650 && y <= 150) return "Picking Zone";
  if (x >= 650 && y >= 180 && y <= 340) return "Packing & Shipping";
  if (x >= 210 && x <= 330) return "Storage Bay A";
  if (x >= 360 && x <= 560) return "Storage Bay B";
  if (y >= 420 && x >= 300 && x <= 560) return "Maintenance Bay";
  return "Corridor Transit";
}

/** Fleet-level RACE summary from per-robot envelope states and risk inputs (ACE only). */
export function aggregateFleetRace(robots) {
  let severity = 0;
  const components = Object.fromEntries(RACE_INPUT_KEYS.map(k => [k, 0]));
  for (const r of robots) {
    severity = Math.max(severity, RACE_SEVERITY.indexOf(r.raceState));
    const inputs = r.riskInputs || r.riskComponents || {};
    for (const k of RACE_INPUT_KEYS) {
      if (typeof inputs[k] === "number") components[k] = Math.max(components[k], inputs[k]);
    }
  }
  return { raceMode: RACE_SEVERITY[Math.max(0, severity)], raceRiskComponents: components };
}
