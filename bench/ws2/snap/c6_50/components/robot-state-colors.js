// ==========================================================================
// NODEX - Semantic robot-state colours (single source of truth).
// The map paints the robot BODY with the colour of its lifecycle phase
// (robot.taskPhase, derived from the controller state by the engine). The
// pickup / drop markers of a live task use the same colours as the robot
// travelling to them. LOADING / UNLOADING blink with a colour distinct from
// the travel colour.
// ==========================================================================

import { TASK_PHASE } from "../core/task-lifecycle.js";

export const ROBOT_STATE_COLORS = Object.freeze({
  [TASK_PHASE.IDLE]:        { body: "#475569", edge: "#94A3B8", label: "Idle" },
  [TASK_PHASE.ASSIGNED]:    { body: "#0284C7", edge: "#38BDF8", label: "Task assigned" },
  [TASK_PHASE.TO_PICKUP]:   { body: "#D97706", edge: "#FBBF24", label: "Moving to pickup" },
  [TASK_PHASE.LOADING]:     { body: "#0891B2", edge: "#67E8F9", label: "Loading", blink: "#ECFEFF" },
  [TASK_PHASE.TO_DROP]:     { body: "#7C3AED", edge: "#C4B5FD", label: "Moving to drop" },
  [TASK_PHASE.UNLOADING]:   { body: "#65A30D", edge: "#BEF264", label: "Unloading", blink: "#F7FEE7" },
  [TASK_PHASE.COMPLETE]:    { body: "#059669", edge: "#6EE7B7", label: "Task complete" },
  [TASK_PHASE.RETURNING]:   { body: "#0F766E", edge: "#5EEAD4", label: "Returning to staging" },
  [TASK_PHASE.STANDBY]:     { body: "#0F766E", edge: "#5EEAD4", label: "Moving to standby bay" },
  [TASK_PHASE.CHARGING]:    { body: "#15803D", edge: "#4ADE80", label: "Charging" },
  [TASK_PHASE.MAINTENANCE]: { body: "#C2410C", edge: "#FDBA74", label: "Maintenance" },
  [TASK_PHASE.FAILED]:      { body: "#B91C1C", edge: "#EF4444", label: "Failure" }
});

/** Marker colours of a live task's endpoints (same as the travel phase). */
export const PICKUP_COLOR = ROBOT_STATE_COLORS[TASK_PHASE.TO_PICKUP].edge;
export const DROP_COLOR = ROBOT_STATE_COLORS[TASK_PHASE.TO_DROP].edge;

/** Dynamic obstacles / humans: magenta, unique on the map. */
export const DYNAMIC_OBSTACLE_COLOR = { fill: "#DB2777", edge: "#F472B6" };

/** Blink period of the loading / unloading pulse (wall-clock ms). */
export const HANDLING_BLINK_MS = 400;

export function robotStateStyle(phase) {
  return ROBOT_STATE_COLORS[phase] || ROBOT_STATE_COLORS[TASK_PHASE.IDLE];
}
