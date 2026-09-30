// ==========================================================================
// NODEX ACE — Centralized Task Assignment Engine
// Cost-optimal matching of unassigned tasks to available fleet AMRs, run on the
// central server only (System 1). Batch one-to-one assignment is solved with
// the Hungarian algorithm over C_i = w_d * D_i + w_l * L_i - w_b * B_i
// (+ a priority term), see assignBatch().
// ==========================================================================

import { needsService } from "../task-lifecycle.js";
import { globalPlanner } from "./GlobalPlanner.js";
import { hungarian } from "./HungarianAssignment.js";
import { canAdmitTask } from "../admission-control.js";
import { MapGeometryEngine } from "../map-geometry.js";

export class AssignmentEngine {
  constructor(weights = {}) {
    // Transparent assignment cost weights
    this.w_d = weights.distance !== undefined ? weights.distance : 1.0; // Distance weight (meters/px)
    this.w_l = weights.workload !== undefined ? weights.workload : 250.0; // Workload penalty
    this.w_b = weights.battery !== undefined ? weights.battery : 0.5; // Battery incentive
  }

  /**
   * Filters feasible candidate AMRs from global fleet state.
   */
  getFeasibleRobots(robots) {
    return robots.filter(robot => {
      // Must be online and not in an error/failed state
      if (robot.status === "error" || robot.status === "failed" || robot.status === "OFFLINE") {
        return false;
      }
      // Must have safe operational battery
      if (robot.battery !== undefined && robot.battery < 15) {
        return false;
      }
      // Health check
      if (robot.health !== undefined && robot.health < 30) {
        return false;
      }
      return true;
    });
  }

  /**
   * Calculates the assignment cost C_i for assigning task T to robot R_i.
   */
  calculateAssignmentCost(robot, task) {
    const robotPos = { x: robot.x, y: robot.y };
    const pickupPos = { x: task.pickup.x, y: task.pickup.y };

    // 1. Distance from robot current position to task pickup
    const travelDist = Math.hypot(pickupPos.x - robotPos.x, pickupPos.y - robotPos.y);

    // 2. Current robot workload
    const isIdle = robot.status === "IDLE" || !robot.currentTask || robot.velocity === 0;
    const workload = isIdle ? 0 : 1;

    // 3. Battery term (normalized 0..100)
    const battery = robot.battery || 80;

    // Assignment cost function
    const cost = (this.w_d * travelDist) + (this.w_l * workload) - (this.w_b * battery);

    return {
      cost,
      travelDist,
      isIdle,
      battery
    };
  }

  /**
   * Finds the best AMR candidate for an unassigned task.
   */
  selectBestRobot(task, availableRobots) {
    const candidates = this.getFeasibleRobots(availableRobots);
    if (candidates.length === 0) return null;

    let bestRobot = null;
    let lowestCost = Infinity;
    let bestDetails = null;

    for (const r of candidates) {
      const details = this.calculateAssignmentCost(r, task);
      if (details.cost < lowestCost) {
        lowestCost = details.cost;
        bestRobot = r;
        bestDetails = details;
      }
    }

    return {
      robot: bestRobot,
      cost: lowestCost,
      details: bestDetails
    };
  }

  /**
   * Central batch allocation (System 1): one Hungarian solve over the open
   * tasks the fleet may admit now x the idle robots. Returns decisions only
   * (task, robot, cost); routes are planned afterwards by the central CBS
   * planner for all task holders jointly.
   */
  assignBatch(unassignedTasks, robots, taskManager) {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const capacity = (() => {
      let k = 0;
      const active = taskManager.getActiveTasks().length;
      while (k < unassignedTasks.length && canAdmitTask(robots.length, active + k)) k++;
      return k;
    })();
    // Idle robots, and robots driving back to their bay after a task (they
    // abandon the return leg), except robots withdrawn for charging or
    // maintenance.
    const available = this.getFeasibleRobots(robots).filter(r => (r.status === "IDLE" || (r.parkingBay && !r._maneuver))
      && !r.currentTaskId && !r.currentTask && !r.serviceState && !r.handling && !needsService(r)
      && !(r.parkingBay && r.parkingBay.kind && r.parkingBay.kind !== "HOME" && r.parkingBay.kind !== "STANDBY")
      && MapGeometryEngine.bayExitClear(r, robots));
    if (capacity === 0 || available.length === 0) return { assignments: [], computeMs: 0, matrix: [0, 0] };
    // Columns: the highest-priority open tasks the fleet may admit (the queue
    // is already priority-ordered); rows: every available robot.
    const tasks = unassignedTasks.slice(0, Math.min(capacity, available.length));
    const cost = available.map(r => tasks.map(t => {
      const c = this.calculateAssignmentCost(r, t).cost;
      return c - 40 * (t.priorityLevel || 2); // prefer serving urgent tasks
    }));
    const pairs = hungarian(cost);
    const assignments = [];
    for (const [i, j] of pairs) {
      const robot = available[i], task = tasks[j];
      taskManager.assignTask(task.id, robot.id, null);
      assignments.push({ task, robot, cost: cost[i][j] });
    }
    const computeMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    for (const a of assignments) taskManager.noteAllocation(a.task.id, { computeMs });
    return { assignments, computeMs, matrix: [available.length, tasks.length] };
  }

  /**
   * Legacy greedy matcher (kept for the unit tests of the cost model only;
   * the central coordinator uses assignBatch).
   * Runs fleet-wide task matching: assigns unassigned tasks to available AMRs.
   * Returns array of assignment events { task, robot, path, cost }.
   */
  assignPendingTasks(unassignedTasks, robots, taskManager) {
    const assignments = [];
    const assignedRobotIds = new Set();

    let activeCount = taskManager.getActiveTasks().length;
    for (const task of unassignedTasks) {
      if (!canAdmitTask(robots.length, activeCount)) break;
      // Available robots that are idle and haven't just been assigned in this cycle
      const available = robots.filter(r => !assignedRobotIds.has(r.id) && r.status === "IDLE" && !r.currentTaskId && !r.currentTask
        && MapGeometryEngine.bayExitClear(r, robots));
      if (available.length === 0) break;

      const selection = this.selectBestRobot(task, available);
      if (selection && selection.robot) {
        const assignedRobot = selection.robot;
        assignedRobotIds.add(assignedRobot.id);

        // Plan path: Current Pos -> Pickup -> Destination
        const startToPickup = globalPlanner.planPath(
          { x: assignedRobot.x, y: assignedRobot.y },
          { x: task.pickup.x, y: task.pickup.y }
        );

        const pickupToDest = globalPlanner.planPath(
          { x: task.pickup.x, y: task.pickup.y },
          { x: task.destination.x, y: task.destination.y }
        );

        // Combine paths
        const fullPath = [...startToPickup];
        for (let i = 1; i < pickupToDest.length; i++) {
          fullPath.push(pickupToDest[i]);
        }

        taskManager.assignTask(task.id, assignedRobot.id, fullPath);
        activeCount++;

        assignments.push({
          task,
          robot: assignedRobot,
          path: fullPath,
          cost: selection.cost
        });
      }
    }

    return assignments;
  }
}

export const assignmentEngine = new AssignmentEngine();
