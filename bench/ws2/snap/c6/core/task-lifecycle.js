// ==========================================================================
// NODEX - Robot task lifecycle (architecture-neutral).
//
//   IDLE -> ASSIGNED -> TO_PICKUP -> LOADING -> TO_DROP -> UNLOADING
//        -> COMPLETE -> RETURNING | CHARGING | MAINTENANCE | STANDBY -> IDLE
//   any active phase -> FAILED
//
// All three controllers use the same handling dwell (a robot really stops at
// the pickup / drop station for a fixed simulated time) and the same phase
// derivation, so the map colours show the actual simulation state of every
// architecture identically.
// ==========================================================================

import { MapGeometryEngine } from "./map-geometry.js";

export const TASK_PHASE = Object.freeze({
  IDLE: "IDLE",
  ASSIGNED: "ASSIGNED",
  TO_PICKUP: "TO_PICKUP",
  LOADING: "LOADING",
  TO_DROP: "TO_DROP",
  UNLOADING: "UNLOADING",
  COMPLETE: "COMPLETE",
  RETURNING: "RETURNING",
  CHARGING: "CHARGING",
  MAINTENANCE: "MAINTENANCE",
  STANDBY: "STANDBY",
  FAILED: "FAILED"
});

/** Simulated seconds a robot stands at the station to load / unload. */
export const LOAD_SECONDS = 1.0;
export const UNLOAD_SECONDS = 1.0;

/** Post-task destinations (the bay a robot drives to after a task). */
export const POST_TASK = Object.freeze({ HOME: "HOME", CHARGE: "CHARGE", MAINTENANCE: "MAINTENANCE", STANDBY: "STANDBY" });
/** Battery / health thresholds that send a robot to charging / maintenance. */
export const CHARGE_BELOW_BATTERY = 25;
export const MAINTENANCE_BELOW_HEALTH = 60;

const FAILED = new Set(["ERROR", "error", "failed"]);

/** Starts a loading / unloading dwell: the robot holds position at the station. */
export function beginHandling(r, kind) {
  const total = kind === TASK_PHASE.LOADING ? LOAD_SECONDS : UNLOAD_SECONDS;
  r.handling = { kind, remaining: total, total, taskId: r.currentTaskId };
  r.velocity = 0;
  r.isYielding = false;
}

/**
 * Advances a dwell by `dt` simulated seconds. Returns the finished kind
 * (LOADING / UNLOADING) on the tick the dwell ends, otherwise null.
 */
export function tickHandling(r, dt) {
  const h = r.handling;
  if (!h) return null;
  r.velocity = 0;
  h.remaining = Math.max(0, h.remaining - dt);
  if (h.remaining > 1e-9) return null;
  r.handling = null;
  return h.kind;
}

export function cancelHandling(r) {
  r.handling = null;
}

/**
 * Where a robot goes after finishing a task: charging when the battery is
 * low, maintenance when its health is degraded, otherwise back to its own
 * perimeter staging bay (return to origin).
 */
export function postTaskDestination(r) {
  if (typeof r.health === "number" && r.health < MAINTENANCE_BELOW_HEALTH) return POST_TASK.MAINTENANCE;
  if (typeof r.battery === "number" && r.battery < CHARGE_BELOW_BATTERY) return POST_TASK.CHARGE;
  return POST_TASK.HOME;
}

/**
 * True when an idle robot must drive to charging / maintenance (and must not
 * take new work until it has been served).
 */
export function needsService(r) {
  return !r.serviceState && postTaskDestination(r) !== POST_TASK.HOME;
}

/** Service station (task location) for a post-task kind, or null. */
export function serviceStationFor(kind, locations) {
  const id = kind === POST_TASK.CHARGE ? "Charging" : kind === POST_TASK.MAINTENANCE ? "Maintenance" : null;
  return id ? (locations || []).find(l => l.id === id) || null : null;
}

/**
 * A robot drives back to its own staging bay when that bay is within this
 * (Manhattan) distance; farther away it takes the nearest free standby bay,
 * so post-task legs stay short and do not cross the whole floor.
 */
export const HOME_RETURN_RADIUS = 320;
/** A return leg that makes no progress this long is re-targeted. */
export const RETURN_STALL_SECONDS = 2.5;

/**
 * Picks the parking bay for a post-task destination from the free bays.
 * HOME: the robot's own staging bay when free and within HOME_RETURN_RADIUS;
 *   otherwise the nearest free standby bay (never another robot's home while
 *   an unclaimed bay exists).
 * CHARGE / MAINTENANCE: the free bay nearest the service station.
 * `nearest` forces the nearest free standby bay (a blocked return leg).
 * Returns { bay, kind } or null.
 */
export function choosePostTaskBay(r, freeBays, homes, locations, { nearest = false } = {}) {
  if (!freeBays.length) return null;
  let kind = postTaskDestination(r);
  const station = serviceStationFor(kind, locations);
  if (kind !== POST_TASK.HOME && !station) kind = POST_TASK.HOME;
  const d = (b, p) => Math.abs(b.x - p.x) + Math.abs(b.y - p.y);
  const notHome = freeBays.filter(b => !homes.has(`${b.x},${b.y}`));
  const pool = notHome.length ? notHome : freeBays;
  const nearestTo = (p) => [...pool].sort((a, b) => d(a, p) - d(b, p) || a.x - b.x || a.y - b.y)[0];
  if (kind === POST_TASK.HOME) {
    if (!nearest && r.home && d(r.home, r) <= HOME_RETURN_RADIUS) {
      const own = freeBays.find(b => Math.hypot(b.x - r.home.x, b.y - r.home.y) < 1);
      if (own) return { bay: own, kind: POST_TASK.HOME };
    }
    return { bay: nearestTo(r), kind: POST_TASK.STANDBY };
  }
  return { bay: nearestTo(station), kind };
}

/**
 * Tracks progress of a return leg. Returns true once the robot has not moved
 * for RETURN_STALL_SECONDS (head-on with another returning robot, a parked
 * robot in the way): the caller then re-targets the nearest free bay.
 */
export function returnLegStalled(r, dt) {
  const moved = r._retPos ? Math.hypot(r.x - r._retPos.x, r.y - r._retPos.y) : Infinity;
  r._retPos = { x: r.x, y: r.y };
  r._retStall = moved > 0.05 ? 0 : (r._retStall || 0) + dt;
  if (r._retStall < RETURN_STALL_SECONDS) return false;
  r._retStall = 0;
  return true;
}

/** Abandons a blocked return leg: the robot stops and re-targets a bay. */
export function abandonReturnLeg(r) {
  r.avoidBay = r.parkingBay ? `${r.parkingBay.x},${r.parkingBay.y}` : null;
  delete r.parkingBay;
  r.plannedPath = [];
  r.currentPath = [];
  r.status = "IDLE";
  r.velocity = 0;
  r.isYielding = false;
  r.retargetNearest = true;
}

/**
 * Staging (home) bays of the loaded world for a fleet size, as "x,y" keys.
 * The staging plan is facility configuration (like the map), so every robot
 * and the central server know it without a registry.
 */
let _homesCache = { layout: null, size: 0, keys: new Set() };
export function homeBayKeys(fleetSize) {
  const layout = MapGeometryEngine.generatedLayout;
  if (_homesCache.layout !== layout || _homesCache.size !== fleetSize) {
    let keys = new Set();
    try {
      keys = new Set(MapGeometryEngine.computeFleetSpawnPoints(fleetSize).map(p => `${p.x},${p.y}`));
    } catch { /* fleet larger than the staging plan: no reserved homes */ }
    _homesCache = { layout, size: fleetSize, keys };
  }
  return _homesCache.keys;
}

/** A robot reached the bay it was driving to: park and start any service. */
export function arriveAtBay(r) {
  const kind = r.parkingBay.kind;
  r.x = r.parkingBay.x;
  r.y = r.parkingBay.y;
  r.status = "IDLE";
  r.velocity = 0;
  r.isYielding = false;
  r.lastCompletedTaskId = null;
  if (kind === POST_TASK.CHARGE || kind === POST_TASK.MAINTENANCE) r.serviceState = kind;
  delete r.parkingBay;
  return kind;
}

/**
 * The robot's lifecycle phase from its actual controller state. Called by the
 * engine after every controller tick; the map colours read only this.
 */
export function deriveTaskPhase(r) {
  if (FAILED.has(r.status)) return TASK_PHASE.FAILED;
  if (r.handling) return r.handling.kind;
  if (r.currentTaskId) {
    if (r.pickedUp === false) return r.status === "ASSIGNED" ? TASK_PHASE.ASSIGNED : TASK_PHASE.TO_PICKUP;
    return TASK_PHASE.TO_DROP;
  }
  if (r.parkingBay) {
    const k = r.parkingBay.kind;
    return k === POST_TASK.CHARGE ? TASK_PHASE.CHARGING
      : k === POST_TASK.MAINTENANCE ? TASK_PHASE.MAINTENANCE
      : k === POST_TASK.STANDBY ? TASK_PHASE.STANDBY
      : TASK_PHASE.RETURNING;
  }
  if (r.serviceState === POST_TASK.CHARGE) return TASK_PHASE.CHARGING;
  if (r.serviceState === POST_TASK.MAINTENANCE) return TASK_PHASE.MAINTENANCE;
  // Finished a task and still on a lane: waiting for its post-task route.
  if (r.lastCompletedTaskId && !MapGeometryEngine.isOffLane(r.x, r.y)) return TASK_PHASE.COMPLETE;
  return TASK_PHASE.IDLE;
}
