// ==========================================================================
// NODEX ACE — Centralized Conflict Manager
// Authoritative fleet conflict detection, priority arbitration, and resolution
// Enforces zero robot overlaps, zero shelf crossings, and deterministic waits
// ==========================================================================

import { MapGeometryEngine, ROBOT_FOOTPRINT } from "../map-geometry.js";
import { inIntersectionZone, INTERSECTION_ZONE_RADIUS, laneLeader, legPassesNode } from "../intersection-reservation.js";

const isFailed = (r) => ["ERROR", "error", "failed"].includes(r.status);

export class ConflictManager {
  constructor() {
    this.safeSeparation = ROBOT_FOOTPRINT.totalRadius * 2; // 32px safe clearance threshold
    this.proximityLookahead = 48; // px lookahead for conflict detection
    this.activeConflicts = new Map(); // key: "R01:R02", value: conflict details
    this.conflictCounter = 0;
  }

  /**
   * Evaluates pairwise spatiotemporal conflicts across all active AMRs.
   */
  detectConflicts(robots) {
    const detected = [];
    const n = robots.length;

    for (let i = 0; i < n; i++) {
      const r1 = robots[i];
      // Failed robots are obstacles, not conflict parties (the coordinator
      // writes "ERROR"; checking only lowercase replanned failed robots back
      // to MOVING).
      if (isFailed(r1)) continue;
      // Robots holding in a back-off refuge are off the lane: not conflict parties.
      if (r1._maneuver && r1._maneuver.phase === "hold") continue;

      for (let j = i + 1; j < n; j++) {
        const r2 = robots[j];
        if (isFailed(r2)) continue;
        if (r2._maneuver && r2._maneuver.phase === "hold") continue;

        const dist = Math.hypot(r2.x - r1.x, r2.y - r1.y);

        // Check if robots are approaching each other or within lookahead distance
        if (dist < this.proximityLookahead) {
          // Trajectory convergence check: are they moving toward each other?
          const nextR1 = {
            x: r1.x + Math.cos(r1.heading || 0) * (r1.velocity || 1) * 6,
            y: r1.y + Math.sin(r1.heading || 0) * (r1.velocity || 1) * 6
          };
          const nextR2 = {
            x: r2.x + Math.cos(r2.heading || 0) * (r2.velocity || 1) * 6,
            y: r2.y + Math.sin(r2.heading || 0) * (r2.velocity || 1) * 6
          };

          const futureDist = Math.hypot(nextR2.x - nextR1.x, nextR2.y - nextR1.y);
          const isClosingIn = futureDist < dist;

          if (isClosingIn || dist < this.safeSeparation) {
            const conflictKey = [r1.id, r2.id].sort().join(":");
            detected.push({
              key: conflictKey,
              r1,
              r2,
              distance: dist,
              isImmediate: dist <= this.safeSeparation
            });
          }
        }
      }
    }

    return detected;
  }

  /**
   * Deterministically decides which robot has right-of-way.
   * Priority hierarchy:
   * 1. Higher task priority
   * 2. Closer distance to current waypoint or goal
   * 3. Deterministic robot ID tie-breaker (lower alphabetical ID wins)
   */
  resolvePriority(r1, r2, taskManager) {
    // A parked robot (no active task) is going nowhere and can never
    // legitimately have right-of-way over one that is actively trying to
    // reach a destination — otherwise a robot that finished a task and
    // happened to stop in a lane wins every future conflict forever (it's
    // always "at its target"), permanently blocking that lane.
    const r1Parked = !r1.currentTaskId;
    const r2Parked = !r2.currentTaskId;
    if (r1Parked !== r2Parked) {
      return r1Parked
        ? { winner: r2, loser: r1, reason: "Parked AMR yields to active task" }
        : { winner: r1, loser: r2, reason: "Parked AMR yields to active task" };
    }

    // A robot merging from an off-lane parking bay yields to lane traffic
    // (same rule in RobotAgent): winning let it block the lane from the side
    // while the lane robot, frozen by the separation guard, could never pass.
    const r1Bay = MapGeometryEngine.isOffLane(r1.x, r1.y);
    const r2Bay = MapGeometryEngine.isOffLane(r2.x, r2.y);
    if (r1Bay !== r2Bay) {
      return r1Bay
        ? { winner: r2, loser: r1, reason: "Merging AMR yields to lane traffic" }
        : { winner: r1, loser: r2, reason: "Merging AMR yields to lane traffic" };
    }

    // Intersection rules, identical to RobotAgent.evaluatePeerConflicts:
    // a robot queued on an intersection lock cannot move until the holder
    // clears it, so it never wins; and a robot inside an intersection zone
    // wins over one outside whose next waypoint is that intersection (it
    // holds the lock the other needs). Task priority deadlocked such pairs.
    const leader = laneLeader(r1, r2);
    if (leader) {
      return leader === r1
        ? { winner: r1, loser: r2, reason: "Lane leader proceeds" }
        : { winner: r2, loser: r1, reason: "Lane leader proceeds" };
    }
    const q1 = !!r1.waitingForNode, q2 = !!r2.waitingForNode;
    if (q1 !== q2) {
      return q1
        ? { winner: r2, loser: r1, reason: "Queued on intersection lock" }
        : { winner: r1, loser: r2, reason: "Queued on intersection lock" };
    }
    const z1 = inIntersectionZone(r1), z2 = inIntersectionZone(r2);
    if (z1 !== z2) {
      const inside = z1 ? r1 : r2, outside = z1 ? r2 : r1;
      const needsNode = (MapGeometryEngine.getActiveWaypoints() || []).some(n =>
        Math.hypot(n.x - inside.x, n.y - inside.y) < INTERSECTION_ZONE_RADIUS
        && legPassesNode(outside, n));
      if (needsNode) return { winner: inside, loser: outside, reason: "Holds intersection" };
    }

    const task1 = r1.currentTaskId ? taskManager.getTaskById(r1.currentTaskId) : null;
    const task2 = r2.currentTaskId ? taskManager.getTaskById(r2.currentTaskId) : null;

    const prio1 = task1 ? task1.priorityLevel : 2;
    const prio2 = task2 ? task2.priorityLevel : 2;

    if (prio1 !== prio2) {
      return prio1 > prio2 ? { winner: r1, loser: r2, reason: "Task Priority" } : { winner: r2, loser: r1, reason: "Task Priority" };
    }

    // Distance to target waypoint
    const d1 = Math.hypot(r1.targetX - r1.x, r1.targetY - r1.y);
    const d2 = Math.hypot(r2.targetX - r2.x, r2.targetY - r2.y);
    if (Math.abs(d1 - d2) > 8) {
      return d1 < d2 ? { winner: r1, loser: r2, reason: "Way Ahead in Crossing" } : { winner: r2, loser: r1, reason: "Way Ahead in Crossing" };
    }

    // Deterministic tie-breaker
    return r1.id < r2.id
      ? { winner: r1, loser: r2, reason: "Fleet ID Priority Arbitration" }
      : { winner: r2, loser: r1, reason: "Fleet ID Priority Arbitration" };
  }

  /**
   * Resolves detected conflicts by instructing losers to WAIT and winners to PROCEED.
   * If a robot has been waiting > 3.0s, triggers a REPLAN recommendation.
   */
  resolveConflicts(detectedConflicts, taskManager, globalPlanner) {
    const actions = [];
    const currentConflictKeys = new Set();

    for (const c of detectedConflicts) {
      currentConflictKeys.add(c.key);
      const { winner, loser, reason } = this.resolvePriority(c.r1, c.r2, taskManager);

      let conflictRecord = this.activeConflicts.get(c.key);
      if (!conflictRecord) {
        this.conflictCounter++;
        conflictRecord = {
          id: `CONF-${this.conflictCounter}`,
          key: c.key,
          winnerId: winner.id,
          loserId: loser.id,
          reason,
          detectedAt: Date.now(),
          loserWaitDuration: 0,
          replanned: false
        };
        this.activeConflicts.set(c.key, conflictRecord);

        actions.push({
          type: "CONFLICT_DETECTED",
          conflictId: conflictRecord.id,
          winnerId: winner.id,
          loserId: loser.id,
          reason,
          distance: c.distance
        });
      }

      // Check if loser has been waiting excessively (> 3.0s) -> REPLAN
      if (loser.stalledDuration > 3.0 && !conflictRecord.replanned) {
        conflictRecord.replanned = true;

        // Route to the loser's actual task destination, not just the next
        // waypoint it was blocked on — replanning to the same immediate
        // waypoint just recomputes the identical contested segment. Also
        // exclude that contested segment from the search so the detour
        // actually leaves the corridor the two robots are deadlocked on.
        const loserTask = loser.currentTaskId ? taskManager.getTaskById(loser.currentTaskId) : null;
        const destination = loserTask ? loserTask.destination : { x: loser.targetX, y: loser.targetY };
        const avoidEdges = new Set();
        const contested = globalPlanner.contestedEdgeKey({ x: loser.x, y: loser.y }, { x: loser.targetX, y: loser.targetY });
        if (contested) avoidEdges.add(contested);

        // A robot that has not reached its pickup yet must still visit it:
        // detouring straight to the destination skipped the pickup.
        const viaPickup = loserTask && !loser.pickedUp ? loserTask.pickup : null;
        let detour = globalPlanner.planPath(
          { x: loser.x, y: loser.y },
          viaPickup ? { x: viaPickup.x, y: viaPickup.y } : { x: destination.x, y: destination.y },
          { avoidEdges }
        );
        if (viaPickup) {
          const rest = globalPlanner.planPath({ x: viaPickup.x, y: viaPickup.y }, { x: destination.x, y: destination.y });
          detour = [...detour, ...rest.slice(1)];
        }

        actions.push({
          type: "PATH_REPLANNED",
          robotId: loser.id,
          detour,
          reason: "Prolonged corridor contention deadlock recovery"
        });
      } else {
        // Loser yields / waits
        actions.push({
          type: "ROBOT_WAITING",
          robotId: loser.id,
          holdingFor: winner.id,
          reason
        });

        // Winner continues
        actions.push({
          type: "ROBOT_PROCEEDING",
          robotId: winner.id
        });
      }
    }

    // Check for cleared conflicts
    for (const [key, record] of this.activeConflicts.entries()) {
      if (!currentConflictKeys.has(key)) {
        this.activeConflicts.delete(key);
        actions.push({
          type: "CONFLICT_RESOLVED",
          conflictId: record.id,
          winnerId: record.winnerId,
          loserId: record.loserId
        });
      }
    }

    return actions;
  }

  getActiveConflictList() {
    return Array.from(this.activeConflicts.values());
  }

  clear() {
    this.activeConflicts.clear();
    this.conflictCounter = 0;
  }
}

export const conflictManager = new ConflictManager();
