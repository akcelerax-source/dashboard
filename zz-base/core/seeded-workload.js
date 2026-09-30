// ==========================================================================
// NODEX - Seeded workload variation (experiment seeds)
//
// The run seed (state "seed", default 18427) already drives the adaptive map
// generator (restricted zones, spawn order, zone shuffles). This module makes
// it also drive the stochastic parts of the WORKLOAD, identically for all
// three architectures:
//   - generic scenario tasks (pickup and destination both drawn from the
//     world's task stations) get a seeded pickup/destination pair and a
//     seeded release order (ids, priorities, types and count are kept);
//   - burst tasks (S02 / S13) likewise;
//   - the scenario fault trigger time gets a seeded +-10 % jitter.
// Scripted interaction tasks (crossing, deadlock, obstacle, lease tasks and
// the ACE validation tests) are never altered, so every scenario keeps its
// designed conflict.
//
// The default seed is the identity: with seed 18427 nothing is changed, so
// all existing runs, tests and recorded results are reproduced bit for bit.
// Controllers never read this module; it only shapes the scenario inputs.
// ==========================================================================

export const DEFAULT_SEED = 18427;

/** mulberry32: small, fast, well-distributed 32-bit PRNG. */
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/** True when the seed asks for variation (anything but the default seed). */
export function isVariedSeed(seed) {
  return Number.isFinite(seed) && seed !== DEFAULT_SEED;
}

/** Stream for one purpose of one run (seed x scenario x purpose). */
export function streamFor(seed, key) {
  return seededRng((seed ^ hashStr(String(key))) >>> 0);
}

/**
 * Returns the task list for a run seed. Identity for the default seed.
 * Only tasks whose pickup AND destination are station objects of
 * `locations` are re-drawn; the release order of those tasks is permuted
 * in place among their own positions.
 */
export function varyWorkload(tasks, seed, locations, key = "tasks") {
  if (!isVariedSeed(seed) || !Array.isArray(tasks) || !Array.isArray(locations) || locations.length < 2) return tasks;
  const rng = streamFor(seed, key);
  const generic = [];
  const out = tasks.map((t, i) => {
    if (!t || !locations.includes(t.pickup) || !locations.includes(t.destination)) return t;
    generic.push(i);
    const L = locations.length;
    const p = Math.floor(rng() * L);
    let d = Math.floor(rng() * (L - 1));
    if (d >= p) d += 1;
    return { ...t, pickup: locations[p], destination: locations[d] };
  });
  // Seeded release order among the generic tasks (Fisher-Yates on positions).
  const items = generic.map(i => out[i]);
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  generic.forEach((pos, k) => { out[pos] = items[k]; });
  return out;
}

/** Seeded +-10 % jitter of a fault trigger time (sim s). Identity for the default seed or t <= 0. */
export function jitterTrigger(triggerAt, seed, key = "fault") {
  if (!isVariedSeed(seed) || !(triggerAt > 0)) return triggerAt;
  const u = streamFor(seed, key)();
  return Math.round(triggerAt * (0.9 + 0.2 * u) * 10) / 10;
}
