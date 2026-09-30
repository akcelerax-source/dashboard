// ==========================================================================
// NODEX ACE — Shared Deadlock Back-off Maneuver
// Architecture-neutral execution layer shared by the centralized
// CentralizedCoordinator/ConflictManager and the decentralized/ACE
// RobotAgent. Aisles are single 40px lanes with bidirectional traffic: when
// a robot has been yielding to the same peer for too long it cannot just
// wait in place forever (the winner is itself physically blocked from
// closing the gap to a stationary robot by the engine's separation guard),
// so it must physically vacate the lane.
//
// This module only computes maneuver geometry and phase transitions on a
// robot's own persistent state object (CentralizedCoordinator.fleetState
// entries, or RobotAgent.localState) — the existing per-tick physical step
// in sim-engine.js (target-seeking, closesSeparation, shelf/bounds guards)
// still does the actual moving, using the plannedPath/targetX/targetY this
// module sets.
//
// Policy ("back off to the last intersection", per product decision):
// retreat to the nearest waypoint behind the robot, pull ~40px into the
// cross-aisle stub off that intersection (clear of the contested lane and
// of racks), hold there until the blocking peer has moved clear (or a
// timeout), then resume the original remaining route.
// ==========================================================================

import { GlobalPlanner } from "./centralized/GlobalPlanner.js";
import { MapGeometryEngine, ROBOT_FOOTPRINT } from "./map-geometry.js";

export const RETREAT_TRIGGER_SECONDS = 1.5; // blocked-by-same-peer -> start backing off
export const HOLD_TIMEOUT_SECONDS = 10.0;   // give up waiting for the blocker to clear
export const MANEUVER_WATCHDOG_SECONDS = 20.0; // abort a stuck maneuver outright
// px into the cross-aisle stub. Must exceed the intersection zone (32) +
// release hysteresis (4) + arrival tolerance (6) so a robot parked in its
// refuge releases the intersection reservation.
const STUB_OFFSET = 44;
const ARRIVE_TOLERANCE = 6;
const CLEAR_DISTANCE = 60; // blocker must be at least this far from the refuge to resume
const HOLD_DEBOUNCE_SECONDS = 0.5; // avoid resuming the instant the blocker blips clear

// A single shared planner instance is enough: it only supplies read-only
// graph lookups (nearest waypoint), never mutated per-robot state.
let sharedPlanner = null;
function planner() {
  if (!sharedPlanner) sharedPlanner = new GlobalPlanner();
  return sharedPlanner;
}

/** Distance from `pt` to the nearest of `others` (robot-shaped objects with x/y), or Infinity. */
function nearestDistance(pt, others) {
  let min = Infinity;
  if (!others) return min;
  for (const o of others) {
    if (!o || typeof o.x !== "number") continue;
    const d = Math.hypot(pt.x - o.x, pt.y - o.y);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Finds the waypoint the robot should retreat to: the previous node on its
 * own route when known, otherwise (a robot already sitting on — or very
 * near — the contested waypoint has no usable path history to look back
 * along) a real neighboring graph node picked to be behind it relative to
 * where it's trying to go. Returns null only when no reachable waypoint or
 * neighbor exists at all.
 *
 * Deliberately never returns the robot's own current waypoint: a degenerate
 * "retreat" to the exact spot it's already stuck at is a no-op maneuver
 * that leaves it blocking the lane exactly as before.
 */
function findRetreatIntersection(p, r) {
  // Preferred: the nearest intersection behind the robot on its own aisle,
  // reachable by a straight, rack-free leg. Path history alone was unsafe:
  // an agent's pathCursor can belong to an older plannedPath, which produced
  // "retreats" to non-adjacent nodes straight across racks (the robot then
  // froze against a shelf until the maneuver watchdog fired).
  const behind = aisleNodeBehind(r);
  if (behind) return behind;

  const path = Array.isArray(r.plannedPath) ? r.plannedPath : null;
  const cursor = typeof r.pathCursor === "number" ? r.pathCursor : null;
  if (path && cursor !== null && cursor > 0 && path[cursor - 1]) {
    const prevNode = path[cursor - 1];
    if (Math.hypot(prevNode.x - r.x, prevNode.y - r.y) > 4) {
      return { x: prevNode.x, y: prevNode.y };
    }
  }
  if (typeof r.prevX === "number" && typeof r.prevY === "number"
      && Math.hypot(r.prevX - r.x, r.prevY - r.y) > 4) {
    const wp = p.findNearestReachableWaypoint(r.prevX, r.prevY);
    if (wp && Math.hypot(wp.x - r.x, wp.y - r.y) > 4) return wp;
  }

  // No usable path history — pick a real neighbor of the current waypoint,
  // choosing the one most "behind" the robot relative to its forward target.
  const here = p.neighborsOf(r.x, r.y);
  if (!here || here.neighbors.length === 0) return null;
  const fx = (typeof r.targetX === "number" ? r.targetX : r.x) - r.x;
  const fy = (typeof r.targetY === "number" ? r.targetY : r.y) - r.y;
  let best = null;
  let bestDot = Infinity;
  for (const n of here.neighbors) {
    if (Math.hypot(n.node.x - r.x, n.node.y - r.y) < 1) continue; // same point, skip
    const dot = (n.node.x - here.node.x) * fx + (n.node.y - here.node.y) * fy;
    if (dot < bestDot) { bestDot = dot; best = n.node; }
  }
  return best;
}

/** Straight leg from a to b stays in bounds and clear of racks. */
function legIsClear(a, b) {
  return MapGeometryEngine.validatePath([{ x: a.x, y: a.y }, { x: b.x, y: b.y }], ROBOT_FOOTPRINT.radius).isValid;
}

/**
 * Nearest waypoint on the robot's current aisle line that lies behind it
 * relative to its direction of travel, with a clear straight leg to it.
 */
function aisleNodeBehind(r, forward = null) {
  const nodes = MapGeometryEngine.getActiveWaypoints() || [];
  let fx = forward ? forward.x : (typeof r.targetX === "number" ? r.targetX : r.x) - r.x;
  let fy = forward ? forward.y : (typeof r.targetY === "number" ? r.targetY : r.y) - r.y;
  if (Math.hypot(fx, fy) < 1 && typeof r.heading === "number") { fx = Math.cos(r.heading); fy = Math.sin(r.heading); }
  let best = null;
  let bestDist = Infinity;
  for (const n of nodes) {
    const onLine = Math.abs(n.y - r.y) < 3 || Math.abs(n.x - r.x) < 3;
    const d = Math.hypot(n.x - r.x, n.y - r.y);
    if (!onLine || d <= 4) continue;
    if ((n.x - r.x) * fx + (n.y - r.y) * fy >= 0) continue; // not behind
    if (d < bestDist && legIsClear(r, n)) { best = { x: n.x, y: n.y }; bestDist = d; }
  }
  return best;
}

/**
 * Route still ahead of a robot or peer-cache entry: position, current target,
 * then the path points after that target.
 */
function routeAhead(o) {
  const route = [{ x: o.x, y: o.y }];
  if (typeof o.targetX === "number") route.push({ x: o.targetX, y: o.targetY });
  const path = Array.isArray(o.currentPath) && o.currentPath.length ? o.currentPath
    : (Array.isArray(o.plannedPath) ? o.plannedPath : []);
  const ti = typeof o.targetX === "number" ? path.findIndex(pt => Math.hypot(pt.x - o.targetX, pt.y - o.targetY) < 1) : -1;
  if (ti >= 0) route.push(...path.slice(ti + 1));
  return route;
}

/** True if the polyline passes within `radius` of `pt` (sampled every 8px). */
function routePassesNear(route, pt, radius) {
  for (let i = 0; i < route.length; i++) {
    if (Math.hypot(route[i].x - pt.x, route[i].y - pt.y) < radius) return true;
    const nx = route[i + 1];
    if (!nx) break;
    const len = Math.hypot(nx.x - route[i].x, nx.y - route[i].y);
    for (let d = 8; d < len; d += 8) {
      const t = d / len;
      if (Math.hypot(route[i].x + (nx.x - route[i].x) * t - pt.x, route[i].y + (nx.y - route[i].y) * t - pt.y) < radius) return true;
    }
  }
  return false;
}

const ROBOT_CLEARANCE = 26;

/**
 * Does robot `o` obstruct travel from a to b? Only if it lies ahead along the
 * leg (a robot behind the start, e.g. the peer we are backing away from, does
 * not) within the clearance corridor. Sampling from the start point made the
 * adjacent blocker count as "on" every escape leg, so no retreat was found.
 */
function legObstructedBy(a, b, o) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return Math.hypot(o.x - a.x, o.y - a.y) < ROBOT_CLEARANCE;
  const t = ((o.x - a.x) * dx + (o.y - a.y) * dy) / len; // distance along the leg
  if (t <= 0 || t > len + ROBOT_CLEARANCE) return false;
  const perp = Math.abs((o.x - a.x) * dy - (o.y - a.y) * dx) / len;
  return perp < ROBOT_CLEARANCE;
} // a leg/refuge closer than this to another robot is occupied
const ZONE_RADIUS = 32;     // matches intersection-reservation.js

/** Nearest intersection whose zone the robot is already inside, or null. */
function nodeInZone(r) {
  let best = null;
  let bestD = ZONE_RADIUS;
  for (const n of MapGeometryEngine.getActiveWaypoints() || []) {
    const d = Math.hypot(n.x - r.x, n.y - r.y);
    if (d < bestD) { best = { x: n.x, y: n.y }; bestD = d; }
  }
  return best;
}

/**
 * Plans a back-off: an intersection to reach and a cross-aisle refuge off it.
 * Candidates, in order: the intersection the robot is already in (step
 * straight into its stub, with no lane retreat needed; this resolves two queues
 * meeting head-on at a hub, where neither front robot can reverse), the
 * nearest intersection behind it on its aisle, then path history. A
 * candidate is accepted only if both legs (robot -> node -> refuge) are clear
 * of racks and other robots and the refuge is off the blocker's remaining
 * route. Returns { intersection, refuge } or null when no back-off is possible.
 */
export function planRetreat(r, blocker = null, others = []) {
  const crowd = others.filter(o => o && o !== r && o.id !== r.id && typeof o.x === "number");
  const blockerRoute = blocker ? routeAhead(blocker) : null;
  const occupied = (a, b) => crowd.some(o => legObstructedBy(a, b, o));

  const seen = new Set();
  // A parked robot (no task) has no direction of travel: "behind" means away
  // from the robot it is blocking (its heading could point straight at it).
  const forward = !r.currentTaskId && blocker ? { x: blocker.x - r.x, y: blocker.y - r.y } : null;
  const candidates = [nodeInZone(r), aisleNodeBehind(r, forward), findRetreatIntersection(planner(), r)]
    .filter(n => n && !seen.has(`${n.x},${n.y}`) && seen.add(`${n.x},${n.y}`));

  const laneDir = (() => {
    const fx = (typeof r.targetX === "number" ? r.targetX : r.x) - r.x;
    const fy = (typeof r.targetY === "number" ? r.targetY : r.y) - r.y;
    const m = Math.hypot(fx, fy);
    if (m > 1) return { x: fx / m, y: fy / m };
    return { x: Math.cos(r.heading || 0), y: Math.sin(r.heading || 0) };
  })();

  for (const node of candidates) {
    const here = { x: r.x, y: r.y };
    if (!legIsClear(here, node) || (Math.hypot(node.x - r.x, node.y - r.y) > 1 && occupied(here, node))) continue;
    let best = null;
    for (const dir of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      // Not back along the stretch the robot itself stands on.
      const toRobot = { x: r.x - node.x, y: r.y - node.y };
      if (Math.hypot(toRobot.x, toRobot.y) > 6 && dir.x * toRobot.x + dir.y * toRobot.y > 0) continue;
      const pt = { x: node.x + dir.x * STUB_OFFSET, y: node.y + dir.y * STUB_OFFSET };
      if (!legIsClear(node, pt) || occupied(node, pt)) continue;
      if (blockerRoute && routePassesNear(blockerRoute, pt, ROBOT_CLEARANCE + 4)) continue;
      const perpendicular = Math.abs(dir.x * laneDir.x + dir.y * laneDir.y) < 0.5 ? 1 : 0;
      const score = perpendicular * 1000 + Math.min(nearestDistance(pt, crowd), 999);
      if (!best || score > best.score) best = { pt, score };
    }
    if (best) return { intersection: node, refuge: best.pt };
  }
  return null;
}

/**
 * Starts a back-off maneuver on robot `r` (mutated in place: status,
 * targetX/Y, plannedPath/currentPath, heading). `blocker` is the peer it's
 * yielding to, used only to pick the clearer stub side and to know later
 * when it has passed. Returns false when no retreat point can be found (no
 * reachable waypoint nearby), so the caller can fall back to its own
 * existing escalation path. Idempotent: a robot already maneuvering is
 * left untouched.
 */
export function startBackoff(r, blocker, nearbyRobots = null) {
  if (!r) return false;
  if (r._maneuver) return true;

  const plan = planRetreat(r, blocker, nearbyRobots || (blocker ? [blocker] : []));
  if (!plan) return false;
  const { intersection, refuge } = plan;

  // Avoid the whole nearby crowd, not just the declared blocker — with
  // several robots converging on one hub, "clear of the blocker" alone can
  // still pick a refuge that's occupied by someone else.

  // Capture the route still ahead (from the current target onward) so the
  // robot can resume exactly where it left off once the lane clears.
  // Derived from the robot's current target, not pathCursor: an agent's
  // cursor can be stale relative to its plannedPath, and slicing by it
  // skipped elbow waypoints, turning the resume route into a diagonal leg.
  let resumePath = routeAhead(r).slice(1);
  // Target no longer on the path (e.g. a previous resume or replan replaced
  // it): routeAhead then drops everything after the target, and the robot
  // resumed with a one-point route, kept its task and held a hub forever.
  // Re-plan from the target to the path's end so the goal is never lost.
  const fullPath = Array.isArray(r.currentPath) && r.currentPath.length ? r.currentPath
    : (Array.isArray(r.plannedPath) ? r.plannedPath : []);
  const goal = r.currentTaskId && fullPath.length ? fullPath[fullPath.length - 1] : null;
  const last = resumePath[resumePath.length - 1];
  if (goal && (!last || Math.hypot(last.x - goal.x, last.y - goal.y) > 1)) {
    const from = last || { x: r.x, y: r.y };
    resumePath = [...resumePath, ...planner().planPath(from, goal).slice(1)];
  }

  r._maneuver = {
    phase: "retreat", // retreat -> hold -> (resumed, field deleted)
    intersection,
    refuge,
    blockerId: blocker ? blocker.id : null,
    holdElapsed: 0,
    totalElapsed: 0,
    resumePath,
    // Where the robot stood when it yielded (on its aisle): the resume route
    // retraces refuge -> intersection -> origin before continuing, so every
    // leg stays axis-aligned along aisles.
    origin: { x: r.x, y: r.y },
    // A parked robot (no task) has nowhere to resume TO — walking back to
    // the spot it just vacated would just recreate the same block. It
    // settles at the refuge instead of holding-then-resuming.
    parked: !r.currentTaskId
  };

  r.plannedPath = [
    { x: intersection.x, y: intersection.y },
    { x: refuge.x, y: refuge.y }
  ];
  r.currentPath = r.plannedPath;
  r._cursorPath = null;
  r.pathCursor = 0;
  r.prevX = r.x;
  r.prevY = r.y;
  r.targetX = intersection.x;
  r.targetY = intersection.y;
  r.heading = Math.atan2(r.targetY - r.y, r.targetX - r.x);
  r.status = "MOVING";
  r.isYielding = false;
  r.stalledDuration = 0;
  return true;
}

/**
 * Advances an in-progress maneuver by one tick. Must be called every tick
 * for any robot with `r._maneuver` set — including ticks where it no
 * longer shows up in the architecture's own conflict/proximity detection,
 * which is the expected case once it's safely parked off the contested
 * lane. The caller must skip its normal yield/conflict evaluation for this
 * robot entirely while `isManeuvering(r)` is true.
 */
export function tickBackoff(r, blocker, deltaTime, nearbyRobots = null) {
  const m = r && r._maneuver;
  if (!m) return;
  // A robot that failed mid-maneuver stays failed: resuming the maneuver
  // set it back to MOVING and "revived" it with its old task.
  if (["ERROR", "error", "failed"].includes(r.status)) {
    delete r._maneuver;
    return;
  }
  m.totalElapsed += deltaTime;

  if (m.phase === "retreat") {
    if (Math.hypot(r.x - m.refuge.x, r.y - m.refuge.y) < ARRIVE_TOLERANCE) {
      if (m.parked) {
        // Nothing to wait for — it's simply out of the lane now.
        r.status = "IDLE";
        r.velocity = 0;
        r.isYielding = false;
        r.stalledDuration = 0;
        delete r._maneuver;
        return;
      }
      m.phase = "hold";
      m.holdElapsed = 0;
      r.status = "WAITING";
      r.velocity = 0;
      r.isYielding = true;
      r.stalledDuration = 0;
    }
  } else if (m.phase === "hold") {
    m.holdElapsed += deltaTime;
    // The lane is clear only once nobody — not just the robot originally
    // named as blocker — is still crowding the intersection this robot
    // needs to re-enter. Checking the single blocker alone let a resume
    // walk straight back into a third robot that had since moved in,
    // producing a shuffle-in-shuffle-out livelock instead of progress.
    const crowd = nearbyRobots || (blocker ? [blocker] : []);
    // Also wait until the blocker's remaining route no longer passes this
    // intersection: resuming while it was still heading down the same lane
    // put the pair head-on again (the two robots took turns backing off).
    // Mutual hold (both parties parked in stubs, each waiting for the other's
    // route to clear) would otherwise time out together and collide again:
    // the lower robot ID goes first.
    const blockerHolding = blocker && ((blocker._maneuver && blocker._maneuver.phase === "hold") || blocker.maneuverPhase === "hold");
    // A blocker that is itself still retreating will come back along its old
    // route; its current (retreat) route does not show that, so resuming then
    // put the pair head-on again in a back-off livelock.
    const blockerRetreating = blocker && ((blocker._maneuver && blocker._maneuver.phase === "retreat") || blocker.maneuverPhase === "retreat");
    const blockerStillComing = blocker && !["ERROR", "error", "failed"].includes(blocker.status)
      && !(blockerHolding && String(r.id) < String(blocker.id))
      && (blockerRetreating || routePassesNear(routeAhead(blocker), m.intersection, 40));
    const others = crowd.filter(o => o && o !== r && o.id !== r.id);
    const laneClear = !blockerStillComing
      && nearestDistance(m.intersection, others) > CLEAR_DISTANCE;
    if ((laneClear && m.holdElapsed > HOLD_DEBOUNCE_SECONDS) || m.holdElapsed > HOLD_TIMEOUT_SECONDS) {
      resumeFromBackoff(r);
      return;
    }
  }

  // Cascade/failure backstop: if the maneuver (retreat or hold) hasn't
  // completed within the watchdog window — e.g. the retreat point is
  // itself physically blocked by a third robot — abandon it and resume
  // the original route rather than parking the robot forever.
  if (m.totalElapsed > MANEUVER_WATCHDOG_SECONDS) {
    resumeFromBackoff(r);
  }
}

function resumeFromBackoff(r) {
  const m = r._maneuver;
  if (!m) return;
  if (m.parked) {
    r.status = "IDLE";
    r.velocity = 0;
    r.isYielding = false;
    r.stalledDuration = 0;
    delete r._maneuver;
    return;
  }
  // Retrace the maneuver along aisles before continuing: going straight from
  // the stub (or a mid-retreat abort point) to the old target cut diagonally
  // across a corner into a rack, where the shelf guard froze the robot in
  // MOVING state and no conflict logic ever noticed it again.
  const tail = m.resumePath && m.resumePath.length > 0 ? m.resumePath : [];
  // A robot that yielded while merging out of its bay must not drive back
  // into the bay: its origin is replaced by the bay's merge point on the lane.
  const origin = MapGeometryEngine.isOffLane(m.origin.x, m.origin.y)
    ? (MapGeometryEngine.projectToNearestAisle(m.origin.x, m.origin.y) || m.origin) : m.origin;
  let remaining = MapGeometryEngine.orthogonalizePath(
    dedupeRoute([{ x: r.x, y: r.y }, m.intersection, origin, ...tail])
  ).slice(1);
  // Resume without retracing when the remaining stops are known: plan afresh
  // from the retreat intersection to the next stop (pickup if still pending,
  // else the destination). Retracing refuge -> intersection -> origin and
  // then driving the old route again is the "back off and come back" detour.
  // Only robots that plan their own route (decentralized agents carry their
  // stops); the central server re-issues centrally planned routes itself.
  const stops = [];
  if (r.currentGoal) {
    if (r.pickedUp === false && r.currentPickup) stops.push(r.currentPickup);
    stops.push(r.currentGoal);
  }
  if (stops.length) {
    let direct = [{ x: r.x, y: r.y }, ...planner().planPath(m.intersection, stops[0])];
    for (let i = 1; i < stops.length; i++) direct = [...direct, ...planner().planPath(stops[i - 1], stops[i]).slice(1)];
    direct = MapGeometryEngine.orthogonalizePath(dedupeRoute(direct)).slice(1);
    const len = (pts) => pts.reduce((s, p, i) => s + (i ? Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : Math.hypot(p.x - r.x, p.y - r.y)), 0);
    if (direct.length && len(direct) < len(remaining)) remaining = direct;
  }
  if (remaining.length === 0) remaining.push({ x: r.x, y: r.y });
  r.plannedPath = remaining;
  r.currentPath = remaining;
  r._cursorPath = null;
  r.pathCursor = 0;
  r.prevX = r.x;
  r.prevY = r.y;
  r.targetX = remaining[0].x;
  r.targetY = remaining[0].y;
  r.heading = Math.atan2(r.targetY - r.y, r.targetX - r.x);
  r.status = "MOVING";
  r.isYielding = false;
  r.stalledDuration = 0;
  delete r._maneuver;
}

/** Drops consecutive points closer than the arrival tolerance. */
function dedupeRoute(points) {
  const out = [];
  for (const pt of points) {
    if (!pt || typeof pt.x !== "number") continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= ARRIVE_TOLERANCE) out.push({ x: pt.x, y: pt.y });
  }
  return out;
}

/**
 * Can `r` actually retreat? False when its retreat leg (to the intersection
 * behind it) is occupied by another robot, typically its own follower in a
 * queue. Backing off the front robot of a queue into its follower is
 * impossible, so in that case the other party of the head-on should yield.
 */
export function retreatFeasible(r, others = [], blocker = null) {
  if (!r || ["ERROR", "error", "failed"].includes(r.status) || r.hitlHold || r.controlMode === "HUMAN") return false;
  return planRetreat(r, blocker, others) !== null;
}

/**
 * Deterministic yield choice for a sustained head-on between the designated
 * `loser` and `winner`: normally the loser backs off, but if its retreat is
 * blocked and the winner's is not, the winner backs off instead. Every
 * architecture can evaluate this from its own view (coordinator state or a
 * robot's peer cache), so both parties reach the same answer.
 */
export function chooseYielder(loser, winner, others = []) {
  if (retreatFeasible(loser, others, winner)) return loser;
  // Never back an active robot off for a parked one (it has nowhere to be,
  // and the active robot's route runs through it). The active robot waits;
  // the execution layer's parked-clearance cascade frees the parked robot's
  // escape (SimEngine.clearParkedBlockers).
  if (!loser.currentTaskId) return null;
  if (winner && !winner._maneuver && retreatFeasible(winner, others, loser)) return winner;
  return null; // neither can move: keep waiting; the watchdog/timeouts bound it
}

export function isManeuvering(r) {
  return !!(r && r._maneuver);
}

/**
 * False only when `a` and `b` are travelling in roughly the SAME direction
 * — one simply queueing behind the other in a lane. Conflict detection
 * flags any pair closing distance, including a trailing robot catching up
 * to one stopped ahead of it; backing the trailing one off would retreat it
 * straight back into whoever is behind IT, which is worse than just
 * queueing — that case resolves itself once whichever robot is actually
 * blocking the front of the queue clears (which may itself trigger its own
 * back-off further up the line).
 *
 * A genuine head-on (opposite headings) and a crossing conflict
 * (perpendicular headings, two robots converging on the same node from
 * different aisles) both need someone to physically vacate — neither robot
 * is "ahead" of the other in a shared lane the way a following pair is, so
 * both need this to return true.
 */
/**
 * Unit vector of where a robot intends to go: toward its current target when
 * it has one (a WAITING robot's heading is stale; it keeps the direction of
 * its last movement, which made a stalled robot facing its opponent's way
 * look like same-direction following), otherwise its heading.
 */
function intendedDirection(r) {
  if (typeof r.targetX === "number" && typeof r.targetY === "number") {
    const dx = r.targetX - r.x, dy = r.targetY - r.y;
    const m = Math.hypot(dx, dy);
    if (m > 1) return { x: dx / m, y: dy / m };
  }
  if (typeof r.heading === "number") return { x: Math.cos(r.heading), y: Math.sin(r.heading) };
  return null;
}

export function isHeadOnConflict(a, b) {
  const da = a && intendedDirection(a);
  const db = b && intendedDirection(b);
  if (!da || !db) return true;
  const dot = da.x * db.x + da.y * db.y;
  return dot < 0.5; // more than ~60 degrees apart: not simple same-direction following
}
