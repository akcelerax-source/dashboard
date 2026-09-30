// ==========================================================================
// NODEX - Experiment result (separate from task state)
// Task state: PENDING(UNASSIGNED) / ASSIGNED / IN_PROGRESS(EXECUTING) /
// COMPLETED / FAILED (+ reassignCount for REASSIGNED).
// Experiment verdict: derived ONLY from the run's acceptance criteria and
// measured values, never from a UI flag. Default criteria (all must hold):
//   1. all scenario tasks completed (termination rule all_tasks_complete)
//   2. zero physical robot-robot collisions
//   3. zero rack / restricted-zone intrusions and boundary violations
// ==========================================================================

export const DEFAULT_ACCEPTANCE = {
  allTasksCompleted: true,
  maxCollisions: 0,
  maxObstacleIntrusions: 0,
  maxBoundaryViolations: 0
};

/**
 * @param {Object} p
 * @param {Array} p.tasks - final task records of the run
 * @param {Object} p.physics - PhysicsMonitor snapshot
 * @param {string} p.endReason - ALL_TASKS_COMPLETE | DURATION_LIMIT | OPERATOR_STOP | ERROR
 * @param {Object} [p.acceptance] - overrides of DEFAULT_ACCEPTANCE
 */
export function evaluateExperiment({ tasks = [], physics = {}, endReason = null, acceptance = {} }) {
  const a = { ...DEFAULT_ACCEPTANCE, ...acceptance };
  const completed = tasks.filter(t => t.status === "COMPLETED").length;
  const criteria = [];
  if (a.allTasksCompleted) {
    criteria.push({ name: "All tasks completed", required: `${tasks.length}/${tasks.length}`, actual: `${completed}/${tasks.length}`, pass: tasks.length > 0 && completed === tasks.length });
  }
  criteria.push({ name: "Robot-robot collisions", required: `<= ${a.maxCollisions}`, actual: physics.collisions ?? 0, pass: (physics.collisions ?? 0) <= a.maxCollisions });
  criteria.push({ name: "Rack / restricted-zone intrusions", required: `<= ${a.maxObstacleIntrusions}`, actual: physics.obstacleIntrusions ?? 0, pass: (physics.obstacleIntrusions ?? 0) <= a.maxObstacleIntrusions });
  criteria.push({ name: "Boundary violations", required: `<= ${a.maxBoundaryViolations}`, actual: physics.boundaryViolations ?? 0, pass: (physics.boundaryViolations ?? 0) <= a.maxBoundaryViolations });
  const aborted = endReason === "OPERATOR_STOP" || endReason === "ERROR";
  const verdict = aborted ? "INCOMPLETE" : (criteria.every(c => c.pass) ? "PASS" : "FAIL");
  return { verdict, endReason, criteria, tasksCompleted: completed, tasksTotal: tasks.length };
}
