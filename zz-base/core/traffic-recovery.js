// ==========================================================================
// NODEX - Traffic recovery policies
// These rules used to run inside SimEngine for all three architectures with a
// global view of the fleet, i.e. a hidden shared traffic controller. They are
// now owned by the architectures:
//   - CentralTrafficRecovery: run BY the central server of System 1 (it is
//     allowed global state; it is the authority).
//   - the pure helpers below: called BY each decentralized robot for ITSELF,
//     with only its own sensor frame / peer cache (see RobotAgent).
// ==========================================================================

import { MapGeometryEngine, WAREHOUSE_TASK_LOCATIONS } from "./map-geometry.js";
import { choosePostTaskBay, homeBayKeys, arriveAtBay, POST_TASK, needsService, returnLegStalled, abandonReturnLeg } from "./task-lifecycle.js";
import { startBackoff } from "./deadlock-backoff.js";

const FAILED = ["ERROR", "error", "failed"];
export const isFailed = (r) => !!r && FAILED.includes(r.status);

const HUB_RADIUS = 32;
const LINE_TOLERANCE = 8;

/**
 * Where a point sits on the aisle graph: inside an intersection hub
 * ({ hub }) or on the straight lane segment between two consecutive
 * waypoints ({ a, b, t }, t = position along a->b), or null when off-lane.
 */
export function laneSegmentAt(pt, nodes = MapGeometryEngine.getActiveWaypoints() || []) {
  const hub = nodes.find(n => Math.hypot(n.x - pt.x, n.y - pt.y) < HUB_RADIUS);
  if (hub) return { hub };
  const pick = (line, coord) => {
    const before = line.filter(n => coord(n) < coord(pt)).sort((u, v) => coord(v) - coord(u))[0];
    const after = line.filter(n => coord(n) > coord(pt)).sort((u, v) => coord(u) - coord(v))[0];
    return before && after ? { a: before, b: after } : null;
  };
  const h = pick(nodes.filter(n => Math.abs(n.y - pt.y) < LINE_TOLERANCE), n => n.x);
  if (h) return h;
  return pick(nodes.filter(n => Math.abs(n.x - pt.x) < LINE_TOLERANCE), n => n.y);
}

/** Planner edge keys a blocker at `pt` closes: its hub's edges or its lane segment. */
export function blockedEdgeKeys(pt, planner) {
  const seg = laneSegmentAt(pt);
  const keys = new Set();
  if (!seg) return keys;
  if (seg.hub) {
    const hub = planner.neighborsOf(seg.hub.x, seg.hub.y);
    for (const n of hub?.neighbors || []) {
      const k = planner.contestedEdgeKey(hub.node, n.node);
      if (k) keys.add(k);
    }
  } else {
    const k = planner.contestedEdgeKey(seg.a, seg.b);
    if (k) keys.add(k);
  }
  return keys;
}

/** Does the polyline come within `clearance` px of `pt`? */
export function routePassesPoint(route, pt, clearance, fromIndex = 0) {
  for (let i = fromIndex; i < route.length; i++) {
    const p = route[i], nx = route[i + 1];
    if (!nx) return Math.hypot(p.x - pt.x, p.y - pt.y) < clearance;
    const len = Math.hypot(nx.x - p.x, nx.y - p.y) || 1;
    for (let d = 0; d <= len; d += 6) {
      const t = d / len;
      if (Math.hypot(p.x + (nx.x - p.x) * t - pt.x, p.y + (nx.y - p.y) * t - pt.y) < clearance) return true;
    }
  }
  return false;
}

export function routeLength(route) {
  let len = 0;
  for (let i = 1; i < (route || []).length; i++) len += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
  return len;
}

/**
 * Route from `self` to `goal` that avoids the aisle segment (or hub) occupied
 * by a blocker (failed robot, standing robot, dropped pallet). When `self` is
 * on the blocked lane itself it first turns back to the lane's node on its own
 * side, then follows the detour. Returns the new path, or null when no route
 * stays clear of the blocker. Pure: the caller decides whether to adopt it.
 */
export function planRerouteAround(self, blocker, goal, planner, clearance = 30, extraAvoid = null) {
  const avoidEdges = blockedEdgeKeys(blocker, planner);
  if (avoidEdges.size === 0) return null;
  if (extraAvoid) for (const k of extraAvoid) avoidEdges.add(k);
  const mine = laneSegmentAt(self);
  const theirs = laneSegmentAt(blocker);
  let via = null;
  if (mine && !mine.hub && theirs) {
    const nodeKey = (n) => `${Math.round(n.x)},${Math.round(n.y)}`;
    const sameLane = !theirs.hub && nodeKey(mine.a) === nodeKey(theirs.a) && nodeKey(mine.b) === nodeKey(theirs.b);
    const d = (n) => Math.hypot(n.x - blocker.x, n.y - blocker.y);
    const endsAtHub = theirs.hub && (nodeKey(mine.a) === nodeKey(theirs.hub) || nodeKey(mine.b) === nodeKey(theirs.hub));
    // Turn back to the end of my lane that is away from the blocker.
    if (sameLane || endsAtHub) via = d(mine.a) > d(mine.b) ? mine.a : mine.b;
  }
  let newPath;
  if (via) {
    const rest = planner.planPath({ x: via.x, y: via.y }, goal, { avoidEdges });
    // A robot part-way between a bay and the lane steps onto the centerline
    // first: a direct leg to the lane end would cut diagonally past the bays.
    const entry = MapGeometryEngine.projectToNearestAisle(self.x, self.y);
    const step = entry && Math.hypot(entry.x - self.x, entry.y - self.y) > 3 ? [{ x: entry.x, y: entry.y }] : [];
    newPath = [{ x: self.x, y: self.y }, ...step, { x: via.x, y: via.y }, ...rest.slice(1)];
  } else {
    newPath = planner.planPath({ x: self.x, y: self.y }, goal, { avoidEdges });
  }
  if (!Array.isArray(newPath) || newPath.length < 2) return null;
  return routePassesPoint(newPath, blocker, clearance, via ? 1 : 0) ? null : newPath;
}

/**
 * System 1 (central server) reroute around a failed robot: plans from the
 * robot's position avoiding the blocked segment / hub. Kept unchanged for the
 * centralized baseline; the decentralized robots use planRerouteAround.
 */
export function planRerouteAroundFailed(self, failed, goal, planner) {
  const nodes = MapGeometryEngine.getActiveWaypoints() || [];
  const inHub = nodes.find(n => Math.hypot(n.x - failed.x, n.y - failed.y) < 32);
  const avoidEdges = new Set();
  if (inHub) {
    const hub = planner.neighborsOf(inHub.x, inHub.y);
    for (const n of hub?.neighbors || []) {
      const k = planner.contestedEdgeKey(hub.node, n.node);
      if (k) avoidEdges.add(k);
    }
  } else {
    const horiz = nodes.filter(n => Math.abs(n.y - failed.y) < 3);
    const vert = nodes.filter(n => Math.abs(n.x - failed.x) < 3);
    const line = horiz.length ? horiz.map(n => ({ n, t: n.x - failed.x })) : vert.map(n => ({ n, t: n.y - failed.y }));
    const before = line.filter(e => e.t < 0).sort((u, v) => v.t - u.t)[0];
    const after = line.filter(e => e.t > 0).sort((u, v) => u.t - v.t)[0];
    if (before && after) {
      const k = planner.contestedEdgeKey(before.n, after.n);
      if (k) avoidEdges.add(k);
    }
  }
  if (avoidEdges.size === 0) return null;
  const newPath = planner.planPath({ x: self.x, y: self.y }, goal, { avoidEdges });
  if (!Array.isArray(newPath) || newPath.length < 2) return null;
  const passesFailed = newPath.some((pt, i) => {
    const nx = newPath[i + 1];
    if (!nx) return Math.hypot(pt.x - failed.x, pt.y - failed.y) < 30;
    const len = Math.hypot(nx.x - pt.x, nx.y - pt.y) || 1;
    for (let d = 0; d <= len; d += 6) {
      const t = d / len;
      if (Math.hypot(pt.x + (nx.x - pt.x) * t - failed.x, pt.y + (nx.y - pt.y) * t - failed.y) < 30) return true;
    }
    return false;
  });
  return passesFailed ? null : newPath;
}

/** Adopts a planned route on the robot state object the caller owns. */
export function adoptRoute(r, route, status = "MOVING") {
  r.plannedPath = route;
  r.currentPath = route;
  r._cursorPath = null;
  r.pathCursor = 0;
  r.targetX = route[1].x;
  r.targetY = route[1].y;
  r.heading = Math.atan2(r.targetY - r.y, r.targetX - r.x);
  if (status) r.status = status;
}

/** Route that ends in an off-lane parking bay (via its aisle entry point). */
export function routeToBay(self, bay, planner) {
  const entry = MapGeometryEngine.projectToNearestAisle(bay.x, bay.y);
  if (!entry) return null;
  const route = [...planner.planPath({ x: self.x, y: self.y }, entry), { x: bay.x, y: bay.y }];
  return route.length >= 2 ? route : null;
}

/**
 * Route integrity check for one robot: a task holder whose path ended short of
 * its destination gets a new route. Returns the new route or null.
 */
export function repairRouteIfLost(r, destination, planner) {
  const path = r.plannedPath;
  if (!destination || !Array.isArray(path) || path.length === 0) return null;
  const end = path[path.length - 1];
  if (Math.hypot(end.x - r.x, end.y - r.y) > 8) return null; // still travelling
  if (Math.hypot(destination.x - end.x, destination.y - end.y) <= 10) return null;
  const route = planner.planPath({ x: r.x, y: r.y }, { x: destination.x, y: destination.y });
  return route.length >= 2 ? route : null;
}

/**
 * System 1 only: traffic recovery decided by the central server from its
 * global fleet state (it owns the fleet, the intersection table and the
 * planner). Never used by the decentralized architectures.
 */
export class CentralTrafficRecovery {
  constructor({ planner, intersections, log }) {
    this.planner = planner;
    this.intersections = intersections;
    this.log = log;
    this.reset();
  }

  reset() {
    this._evictWait = new Map();
    this._stuckFor = new Map();
    this._lastPos = new Map();
    this._pendingClear = new Map();
    this._laneIdle = new Map();
    this._bays = null;
  }

  run(robots, dt, getTask) {
    this.evictParkedNodeHolders(robots, dt);
    this.clearParkedBlockers(robots, dt);
    this.repairLostRoutes(robots, getTask);
    this.returnIdleToBays(robots, dt);
    this.normalizeIdle(robots);
  }

  evictParkedNodeHolders(robots, dt) {
    const PARKED_EVICT_SECONDS = 1.0;
    const byId = new Map(robots.map(r => [r.id, r]));
    const seen = new Set();
    for (const [key, { holder, queue }] of Object.entries(this.intersections.snapshot())) {
      if (!holder || queue.length === 0) continue;
      const h = byId.get(holder);
      const parked = h && !h.currentTaskId && !h._maneuver && !isFailed(h) && !h.centralHold;
      if (!parked) continue;
      seen.add(key);
      const waited = (this._evictWait.get(key) || 0) + dt;
      if (waited < PARKED_EVICT_SECONDS) { this._evictWait.set(key, waited); continue; }
      this._evictWait.delete(key);
      if (startBackoff(h, byId.get(queue[0]), robots)) {
        this.log(holder, "NODE_EVICT", `Central server moved parked ${holder} out of intersection ${key} for queued ${queue[0]}.`);
      }
    }
    for (const key of this._evictWait.keys()) if (!seen.has(key)) this._evictWait.delete(key);
  }

  clearParkedBlockers(robots, dt) {
    const STUCK_SECONDS = 2.0;
    const isParked = r => r && !r.currentTaskId && !r._maneuver && !isFailed(r) && !r.centralHold
      && !MapGeometryEngine.isOffLane(r.x, r.y);
    const tryBackoff = (who, from) => !!(who && startBackoff(who, from, robots));
    const byId = new Map(robots.map(r => [r.id, r]));
    for (const [parkedId, requesterId] of this._pendingClear) {
      const parked = byId.get(parkedId), requester = byId.get(requesterId);
      if (!parked || !requester || !requester._maneuver || !isParked(parked)) { this._pendingClear.delete(parkedId); continue; }
      if (tryBackoff(parked, requester)) {
        this._pendingClear.delete(parkedId);
        this.log(parkedId, "PARKED_CLEARANCE", `Central server: parked ${parkedId} used the room ${requesterId} opened.`);
      }
    }
    for (const a of robots) {
      const prev = this._lastPos.get(a.id);
      const moved = prev ? Math.hypot(a.x - prev.x, a.y - prev.y) : Infinity;
      this._lastPos.set(a.id, { x: a.x, y: a.y });
      if (!a.currentTaskId || a._maneuver || moved > 0.05 || isFailed(a) || a.centralHold || a.scheduleHold) {
        this._stuckFor.delete(a.id);
        continue;
      }
      const stuck = (this._stuckFor.get(a.id) || 0) + dt;
      if (stuck < STUCK_SECONDS) { this._stuckFor.set(a.id, stuck); continue; }
      this._stuckFor.set(a.id, 0);
      const fx = a.targetX - a.x, fy = a.targetY - a.y;
      const blocker = robots
        .filter(o => o.id !== a.id && Math.hypot(o.x - a.x, o.y - a.y) < 40 && (o.x - a.x) * fx + (o.y - a.y) * fy > 0)
        .sort((u, v) => Math.hypot(u.x - a.x, u.y - a.y) - Math.hypot(v.x - a.x, v.y - a.y))[0];
      if (blocker && isFailed(blocker)) {
        const path = Array.isArray(a.plannedPath) ? a.plannedPath : [];
        const goal = path.length ? path[path.length - 1] : { x: a.targetX, y: a.targetY };
        const route = planRerouteAroundFailed(a, blocker, goal, this.planner);
        if (route) {
          adoptRoute(a, route);
          a.isYielding = false;
          a.stalledDuration = 0;
          this.log(a.id, "REROUTE_AROUND_FAILED", `Central server rerouted ${a.id} around failed ${blocker.id}.`);
        }
        continue;
      }
      if (!isParked(blocker)) {
        const behind = robots.find(c => c.id !== a.id && isParked(c)
          && Math.hypot(c.x - a.x, c.y - a.y) < 40 && (c.x - a.x) * fx + (c.y - a.y) * fy < 0);
        if (behind && tryBackoff(behind, a)) {
          this.log(behind.id, "PARKED_CLEARANCE", `Central server: parked ${behind.id} cleared retreat room behind ${a.id}.`);
        }
        continue;
      }
      if (tryBackoff(blocker, a)) {
        this.log(blocker.id, "PARKED_CLEARANCE", `Central server: parked ${blocker.id} cleared the lane for ${a.id}.`);
        continue;
      }
      const onLine = (q) => Math.abs(q.x - blocker.x) < 3 || Math.abs(q.y - blocker.y) < 3;
      const lineNodes = (MapGeometryEngine.getActiveWaypoints() || []).filter(onLine);
      const awayX = blocker.x - a.x, awayY = blocker.y - a.y;
      const obstructors = robots
        .filter(c => c.id !== blocker.id && c.id !== a.id && isParked(c)
          && Math.hypot(c.x - blocker.x, c.y - blocker.y) < 260
          && (onLine(c) || lineNodes.some(n => Math.hypot(n.x - c.x, n.y - c.y) < 50)))
        .sort((u, v) => {
          const su = ((u.x - blocker.x) * awayX + (u.y - blocker.y) * awayY) > 0 ? 0 : 1;
          const sv = ((v.x - blocker.x) * awayX + (v.y - blocker.y) * awayY) > 0 ? 0 : 1;
          return su - sv || Math.hypot(u.x - blocker.x, u.y - blocker.y) - Math.hypot(v.x - blocker.x, v.y - blocker.y);
        });
      let freed = false;
      for (const c of obstructors) {
        if (tryBackoff(c, blocker)) {
          this.log(c.id, "PARKED_CLEARANCE", `Central server: parked ${c.id} moved to free a retreat for ${blocker.id}.`);
          freed = true;
          break;
        }
      }
      if (!freed && tryBackoff(a, blocker)) {
        this.log(a.id, "PARKED_CLEARANCE", `Central server: ${a.id} backed off to give boxed-in ${blocker.id} room.`);
        this._pendingClear.set(blocker.id, a.id);
      }
    }
  }

  repairLostRoutes(robots, getTask) {
    for (const r of robots) {
      if (!r.currentTaskId || r._maneuver || isFailed(r) || r.centralHold) continue;
      const task = getTask(r.currentTaskId);
      const route = repairRouteIfLost(r, task && task.destination, this.planner);
      if (!route) continue;
      adoptRoute(r, route, r.status === "WAITING" ? null : "MOVING");
      this.log(r.id, "ROUTE_REPAIR", `Central server: ${r.id} route ended short of ${task.id} destination; replanned.`);
    }
  }

  returnIdleToBays(robots, dt) {
    const LANE_IDLE_SECONDS = 1.0;
    if (!this._bays || this._baysFor !== MapGeometryEngine.generatedLayout) {
      this._bays = MapGeometryEngine.computeParkingBays();
      this._baysFor = MapGeometryEngine.generatedLayout;
    }
    let free = null;
    const freeBays = () => {
      if (free) return free;
      const claimed = new Set(robots.filter(r => r.parkingBay).map(r => `${r.parkingBay.x},${r.parkingBay.y}`));
      free = this._bays.filter(b => !b.front && !claimed.has(`${b.x},${b.y}`)
        && !robots.some(r => Math.hypot(r.x - b.x, r.y - b.y) < 17));
      return free;
    };
    for (const r of robots) {
      const blocked = isFailed(r) || r.centralHold;
      if (r.parkingBay) {
        if (r.currentTaskId || r._maneuver || blocked) { delete r.parkingBay; continue; }
        if (Math.hypot(r.x - r.parkingBay.x, r.y - r.parkingBay.y) < 6) {
          const kind = arriveAtBay(r);
          if (kind === POST_TASK.MAINTENANCE) this.log(r.id, "MAINTENANCE_ARRIVED", `${r.id} parked in the maintenance bay; withdrawn from dispatch.`);
          else if (kind === POST_TASK.CHARGE) this.log(r.id, "CHARGING_STARTED", `${r.id} parked at the charging bay.`);
        } else if (returnLegStalled(r, dt)) {
          this.log(r.id, "RETURN_BLOCKED", `Central server: ${r.id} return leg blocked; re-targeting the nearest free bay.`);
          abandonReturnLeg(r);
          free = null;
        } else if (r.status === "IDLE") {
          r.status = "MOVING";
        }
        if (r.parkingBay || !r.retargetNearest) continue;
      }
      if (r.serviceState === POST_TASK.CHARGE) {
        r.battery = Math.min(100, (r.battery || 0) + 2 * dt);
        if (r.battery >= 90) r.serviceState = null;
      }
      const service = !r.currentTaskId && !r._maneuver && !blocked && r.status === "IDLE" && (needsService(r) || r.retargetNearest);
      if (!service && (r.currentTaskId || r._maneuver || blocked || r.status !== "IDLE"
          || MapGeometryEngine.isOffLane(r.x, r.y))) { this._laneIdle.delete(r.id); continue; }
      const idle = (this._laneIdle.get(r.id) || 0) + dt;
      this._laneIdle.set(r.id, idle);
      // Right after a task (or when it needs service) the robot leaves at once.
      if ((!service && !r.lastCompletedTaskId && idle < LANE_IDLE_SECONDS) || freeBays().length === 0) continue;
      const candidates = free.filter(b => `${b.x},${b.y}` !== r.avoidBay);
      const pick = choosePostTaskBay(r, candidates, homeBayKeys(robots.length), WAREHOUSE_TASK_LOCATIONS, { nearest: !!r.retargetNearest });
      if (!pick) continue;
      r.retargetNearest = false;
      r.avoidBay = null;
      const route = routeToBay(r, pick.bay, this.planner);
      if (!route) continue;
      free.splice(free.indexOf(pick.bay), 1);
      r.parkingBay = { x: pick.bay.x, y: pick.bay.y, kind: pick.kind };
      adoptRoute(r, route);
      this._laneIdle.delete(r.id);
      const what = pick.kind === POST_TASK.HOME ? "its staging bay" : pick.kind === POST_TASK.CHARGE ? "the charging bay"
        : pick.kind === POST_TASK.MAINTENANCE ? "the maintenance bay" : "a standby bay";
      this.log(r.id, "RETURN_TO_BAY", `Central server sent ${r.id} to ${what} (${pick.bay.x}, ${pick.bay.y}).`);
    }
  }

  normalizeIdle(robots) {
    for (const r of robots) {
      if (r.currentTaskId || r._maneuver || r.parkingBay) continue;
      if (r.status !== "MOVING") continue;
      r.status = "IDLE";
      r.velocity = 0;
      r.isYielding = false;
    }
  }
}
