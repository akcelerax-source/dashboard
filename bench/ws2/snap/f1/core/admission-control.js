// ==========================================================================
// NODEX ACE - Task admission control
// Identical for all three architectures. The aisle grid can carry only a
// limited number of robots in motion; above that, extra task holders jam the
// hubs and nothing completes. Fleets of MAX_UNLIMITED_FLEET or fewer are never
// limited (their behavior is unchanged); larger fleets keep the rest of the
// fleet parked in bays until a running task finishes.
// ==========================================================================

export const MAX_UNLIMITED_FLEET = 10;
export const MAX_CONCURRENT_TASKS_LARGE_FLEET = Number(globalThis.process?.env?.CAP || 6);

export function concurrentTaskLimit(fleetSize) {
  return fleetSize <= MAX_UNLIMITED_FLEET ? Infinity : MAX_CONCURRENT_TASKS_LARGE_FLEET;
}

/** True when one more task may start given the current active-task count. */
export function canAdmitTask(fleetSize, activeTaskCount) {
  return activeTaskCount < concurrentTaskLimit(fleetSize);
}
