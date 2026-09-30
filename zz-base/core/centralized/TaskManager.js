// ==========================================================================
// NODEX ACE — Centralized Task Manager
// Authoritative task lifecycles, priority queues, and state machines
// ==========================================================================

export const TASK_STATUS = {
  UNASSIGNED: "UNASSIGNED",
  ASSIGNED: "ASSIGNED",
  EXECUTING: "EXECUTING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED"
};

export const TASK_PRIORITY = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3
};

// Task stations of the active world (mutable, refilled per world profile by
// MapGeometryEngine). Re-exported here for existing importers.
import { WAREHOUSE_TASK_LOCATIONS, MapGeometryEngine } from "../map-geometry.js";
export { WAREHOUSE_TASK_LOCATIONS };

/**
 * A task point must exist in the loaded world. Scenario definitions carry
 * fixed coordinates from the reference map; in a smaller world a point outside
 * the floor (or inside a rack) is moved to the nearest aisle intersection.
 */
function fitToWorld(loc) {
  if (!loc || typeof loc.x !== "number") return loc;
  const inside = MapGeometryEngine.isWithinBounds(loc.x, loc.y)
    && !MapGeometryEngine.isPointInObstacle(loc.x, loc.y).collision;
  if (inside) return loc;
  const wp = MapGeometryEngine.findNearestWaypoint(loc.x, loc.y);
  return wp ? { ...loc, x: wp.x, y: wp.y, fittedToWorld: true } : loc;
}

export class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.taskCounter = 100;
    // Simulation clock (seconds). Task timing and allocation latency are
    // measured in sim time so they do not depend on frame rate.
    this.clock = () => 0;
  }

  setClock(fn) {
    if (typeof fn === "function") this.clock = fn;
  }

  /**
   * Creates a new managed warehouse task.
   */
  createTask({
    id = null,
    pickup,
    destination,
    priority = "MEDIUM",
    type = "Transport"
  }) {
    this.taskCounter++;
    const taskId = id || `T-${this.taskCounter}`;

    const pickupLoc = typeof pickup === "string"
      ? (WAREHOUSE_TASK_LOCATIONS.find(l => l.name === pickup || l.id === pickup) || WAREHOUSE_TASK_LOCATIONS[0])
      : pickup;

    const destLoc = typeof destination === "string"
      ? (WAREHOUSE_TASK_LOCATIONS.find(l => l.name === destination || l.id === destination) || WAREHOUSE_TASK_LOCATIONS[4])
      : destination;

    const task = {
      id: taskId,
      type,
      pickup: fitToWorld(pickupLoc),
      destination: fitToWorld(destLoc),
      priority: priority.toUpperCase(),
      priorityLevel: TASK_PRIORITY[priority.toUpperCase()] || TASK_PRIORITY.MEDIUM,
      status: TASK_STATUS.UNASSIGNED,
      assignedRobot: null,
      assignedRobotId: null,
      path: null,
      createdTime: Date.now(),
      assignedTime: null,
      startTime: null,
      completedTime: null,
      failedTime: null,
      failureReason: null,
      progress: 0,
      // Sim-time lifecycle (seconds) used for latency / completion metrics.
      createdSim: this.clock(),
      allocationStartSim: null,
      assignedSim: null,
      startedSim: null,
      completedSim: null,
      allocationLatencySim: null,
      allocationComputeMs: null,
      reassignCount: 0
    };

    this.tasks.set(taskId, task);
    return task;
  }

  /**
   * Assigns an unassigned task to a robot.
   */
  assignTask(taskId, robotId, path = null) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = TASK_STATUS.ASSIGNED;
    task.assignedRobot = robotId;
    task.assignedRobotId = robotId;
    task.assignedTime = Date.now();
    task.assignedSim = this.clock();
    if (task.allocationLatencySim === null || task.reassignCount > 0) {
      task.allocationLatencySim = Math.max(0, task.assignedSim - (task.releasedSim ?? task.createdSim));
    }
    task.path = path;
    return task;
  }

  /** Records allocation-decision timing for a task (compute time in ms). */
  noteAllocation(taskId, { startSim = null, computeMs = null } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (startSim !== null) task.allocationStartSim = startSim;
    if (computeMs !== null) task.allocationComputeMs = computeMs;
  }

  /**
   * Sets task state to EXECUTING when robot starts movement.
   */
  startTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = TASK_STATUS.EXECUTING;
    task.startTime = Date.now();
    task.startedSim = this.clock();
    return task;
  }

  /**
   * Marks a task as COMPLETED upon reaching destination within tolerance.
   */
  completeTask(taskId, completionTimestamp = Date.now()) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = TASK_STATUS.COMPLETED;
    task.completedTime = completionTimestamp;
    task.completedSim = this.clock();
    task.progress = 100;
    return task;
  }

  /**
   * Marks a task as FAILED if robot breaks down or path is blocked.
   */
  failTask(taskId, reason = "Robot fault") {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = TASK_STATUS.FAILED;
    task.failedTime = Date.now();
    task.failureReason = reason;
    return task;
  }

  /**
   * Reassigns a failed or uncompleted task to a new robot.
   */
  reassignTask(taskId, newRobotId, newPath = null) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = TASK_STATUS.ASSIGNED;
    task.assignedRobot = newRobotId;
    task.assignedTime = Date.now();
    task.path = newPath;
    task.failureReason = null;
    return task;
  }

  getTaskById(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * Open tasks by priority. `orphansFirst` (used by the decentralized task
   * boards) puts work released after a robot failure ahead of its priority
   * class: it was already in progress, so its peer re-bidding is never
   * starved by the backlog. The central server keeps its own ordering.
   */
  getUnassignedTasks({ orphansFirst = false } = {}) {
    return Array.from(this.tasks.values())
      .filter(t => t.status === TASK_STATUS.UNASSIGNED)
      .sort((a, b) => (orphansFirst ? ((b.reassignCount || 0) > 0) - ((a.reassignCount || 0) > 0) : 0) || b.priorityLevel - a.priorityLevel);
  }

  getActiveTaskForRobot(robotId) {
    return Array.from(this.tasks.values())
      .find(t => t.assignedRobot === robotId && (t.status === TASK_STATUS.ASSIGNED || t.status === TASK_STATUS.EXECUTING)) || null;
  }

  releaseTask(taskId, reason = "Released") {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = TASK_STATUS.UNASSIGNED;
    task.assignedRobot = null;
    task.assignedRobotId = null;
    task.failureReason = reason;
    task.reassignCount = (task.reassignCount || 0) + 1; // REASSIGNED on next award
    task.releasedSim = this.clock();
    return task;
  }

  getActiveTasks() {
    return Array.from(this.tasks.values())
      .filter(t => t.status === TASK_STATUS.ASSIGNED || t.status === TASK_STATUS.EXECUTING);
  }

  getCompletedTasks() {
    return Array.from(this.tasks.values())
      .filter(t => t.status === TASK_STATUS.COMPLETED);
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  getTotalCount() {
    return this.tasks.size;
  }

  getCompletedCount() {
    return this.getCompletedTasks().length;
  }

  /**
   * Measured task timing for the run (sim seconds): allocation latency
   * (created/released -> awarded) and completion time (created -> completed).
   */
  getTimingStats() {
    const all = this.getAllTasks();
    const lat = all.map(t => t.allocationLatencySim).filter(v => typeof v === "number");
    const comp = all.filter(t => t.completedSim !== null).map(t => t.completedSim - t.createdSim);
    const compute = all.map(t => t.allocationComputeMs).filter(v => typeof v === "number");
    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const r = (v, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
    return {
      allocationLatencyAvgS: r(avg(lat)),
      allocationLatencyMaxS: r(lat.length ? Math.max(...lat) : null),
      allocationComputeAvgMs: r(avg(compute), 3),
      taskCompletionAvgS: r(avg(comp)),
      reassignedTasks: all.filter(t => (t.reassignCount || 0) > 0).length,
      pending: all.filter(t => t.status === TASK_STATUS.UNASSIGNED).length,
      assigned: all.filter(t => t.status === TASK_STATUS.ASSIGNED).length,
      inProgress: all.filter(t => t.status === TASK_STATUS.EXECUTING).length,
      completed: all.filter(t => t.status === TASK_STATUS.COMPLETED).length,
      failed: all.filter(t => t.status === TASK_STATUS.FAILED).length
    };
  }

  clear() {
    this.tasks.clear();
    this.taskCounter = 100;
  }
}

export const taskManager = new TaskManager();
