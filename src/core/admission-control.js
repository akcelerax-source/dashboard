// ==========================================================================
// NODEX ACE - Task admission control
// Identical for all three architectures.
// r6-bigmap: the 50/100 robot fleets run on their own large rectangular
// worlds (see WORLD_PROFILES in map-geometry.js) whose lane grid carries the
// whole fleet, so the former 6-task cap for fleets > 10 is removed: every
// fleet size is unlimited (every robot may hold and execute a task at once),
// exactly like the 3/10 robot fleets. A benchmark may still pin a cap for
// fleets > MAX_UNLIMITED_FLEET with the CAP env var (ablation only).
// ==========================================================================

export const MAX_UNLIMITED_FLEET = 10;
const ENV_CAP = Number(globalThis.process?.env?.CAP || 0);
/** Optional ablation cap for fleets > 10 (CAP env); unset = no cap. */
export const MAX_CONCURRENT_TASKS_LARGE_FLEET = ENV_CAP > 0 ? ENV_CAP : Infinity;

export function concurrentTaskLimit(fleetSize) {
  return fleetSize <= MAX_UNLIMITED_FLEET ? Infinity : MAX_CONCURRENT_TASKS_LARGE_FLEET;
}

/** True when one more task may start given the current active-task count. */
export function canAdmitTask(fleetSize, activeTaskCount) {
  return activeTaskCount < concurrentTaskLimit(fleetSize);
}
