// ==========================================================================
// NODEX Experimental Efficiency Index (NEEI) — version 1.1   [LEGACY]
//
// Superseded by NFEI v2.0 (src/data/nfei.js). Kept unchanged so historical
// values stay reproducible and the dashboard can show old vs corrected; see
// docs/NODEX_EFFICIENCY_INDEX_VALIDATION.md (double counting of time and
// throughput, best-of-set reference, renormalization and recovery bonus).
//
// NEEI is a NodeX-defined experimental comparison index. It is NOT an ISO /
// IEEE standard metric. It is a deterministic, normalized weighted composite
// (simple additive weighting, a standard multi-criteria decision-analysis
// method) over engineering KPIs commonly used to evaluate multi-robot /
// AMR fleets: safety (collision-free operation), task success, time
// efficiency (makespan), throughput and recovery / reliability.
//
//   NEEI = 100 × SafetyGate × Σ(w_i × c_i) / Σ(w_i)      (over APPLICABLE c_i)
//
//   SafetyGate = 1 if collisions = 0, else 0   (any collision -> NEEI = 0)
//
//   component c_i (each clamped to [0, 1])            weight w_i
//   Task success              completed / assigned       0.35
//   Time efficiency           T_ref / T_actual           0.25
//   Throughput efficiency     X_actual / X_ref           0.25
//   Recovery / reliability    recovered / reallocated    0.15
//
// v1.1: v1.0 also scored "safety = 1 when collisions = 0" with weight 0.40.
// The gate already zeroes every run with a collision, so that component was
// 1 for every non-zero score: a constant 40 free points (with renormalization
// a collision-free run finishing 20 % of its tasks scored 73 %). Safety is now
// the gate only, so the index measures how well the work itself was done.
//
// Reference values (fair comparison): the reference run set is the latest
// recorded run of every ELIGIBLE system for the same scenario/test, the same
// fleet size and therefore the same world map and workload (scenario tasks
// are generated deterministically per scenario and fleet size).
//   T_ref = shortest all-tasks completion time in that set
//   X_ref = highest throughput (completed tasks / sim hour) in that set
// Not applicable (weight removed and the rest renormalized, never scored 0):
//   - time efficiency when the run did not complete all tasks (no makespan)
//     or when the reference set has a single run (no comparative reference)
//   - throughput efficiency when the reference set has a single run
//   - recovery when the run had no reallocated task (no failure to recover)
// If collisions were not measured the index is not computed ("—").
// ==========================================================================

export const NEEI_VERSION = "1.1";

export const NEEI_WEIGHTS = Object.freeze({
  taskSuccess: 0.35,
  timeEfficiency: 0.25,
  throughputEfficiency: 0.25,
  recovery: 0.15
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Measured inputs of one recorded run (everything NEEI reads). */
export function neeiInputs(run) {
  if (!run) return null;
  const p = run.performance || {};
  const collisions = num(run.summary?.collisions);
  return {
    runId: run.runId || run.id || null,
    system: run.systemMode,
    code: run.scenarioCode,
    runKind: run.runKind || null,
    fleetSize: run.fleetSize,
    assignedTasks: num(p.tasksTotal),
    completedTasks: num(p.tasksCompleted),
    completionTimeSeconds: num(p.completionTimeSeconds),
    simTimeSeconds: num(p.simTimeSeconds),
    throughputPerHour: num(p.throughputPerHour),
    collisions,
    robotFailures: num(run.summary?.robotFailures),
    reallocatedTasks: num(p.reallocatedTasks),
    reallocatedCompleted: num(p.reallocatedCompleted)
  };
}

/**
 * Reference values from the reference run set (the eligible systems' runs
 * of one scenario/test at one fleet size).
 */
export function neeiReference(runs) {
  const inputs = runs.filter(Boolean).map(neeiInputs);
  const times = inputs.map(i => i.completionTimeSeconds).filter(v => v !== null && v > 0);
  const thr = inputs.map(i => i.throughputPerHour).filter(v => v !== null && v > 0);
  return {
    runCount: inputs.length,
    referenceTimeSeconds: times.length ? Math.min(...times) : null,
    referenceThroughputPerHour: thr.length ? Math.max(...thr) : null
  };
}

/**
 * NEEI of one run against a reference. Returns { value, components,
 * weightsUsed, inputs, reference, version } — value is null ("—") when the
 * index cannot be computed from measured data.
 */
export function computeNeei(run, reference) {
  const inputs = neeiInputs(run);
  const out = { value: null, components: {}, weightsUsed: {}, inputs, reference, version: NEEI_VERSION, reason: null };
  if (!inputs) { out.reason = "No recorded run"; return out; }
  if (inputs.collisions === null) { out.reason = "Collisions not measured"; return out; }
  if (!(inputs.assignedTasks > 0) || inputs.completedTasks === null) { out.reason = "No assigned tasks recorded"; return out; }

  const c = {};
  c.taskSuccess = clamp01(inputs.completedTasks / inputs.assignedTasks);
  const comparative = reference && reference.runCount > 1;
  if (comparative && inputs.completionTimeSeconds > 0 && reference.referenceTimeSeconds > 0) {
    c.timeEfficiency = clamp01(reference.referenceTimeSeconds / inputs.completionTimeSeconds);
  }
  if (comparative && inputs.throughputPerHour !== null && reference.referenceThroughputPerHour > 0) {
    c.throughputEfficiency = clamp01(inputs.throughputPerHour / reference.referenceThroughputPerHour);
  }
  if (inputs.reallocatedTasks > 0 && inputs.reallocatedCompleted !== null) {
    c.recovery = clamp01(inputs.reallocatedCompleted / inputs.reallocatedTasks);
  }

  let wSum = 0, score = 0;
  for (const [k, v] of Object.entries(c)) {
    const w = NEEI_WEIGHTS[k];
    out.weightsUsed[k] = w;
    wSum += w;
    score += w * v;
  }
  const gate = inputs.collisions === 0 ? 1 : 0;
  out.components = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  out.safetyGate = gate;
  out.value = Math.round(100 * gate * (score / wSum) * 10) / 10;
  return out;
}

/** Human-readable breakdown (tooltips / export). */
export function describeNeei(r) {
  if (!r || r.value === null) return r?.reason || "Not available";
  const parts = Object.entries(r.components).map(([k, v]) => `${k} ${v} × ${r.weightsUsed[k]}`);
  return `NEEI v${r.version} = ${r.value} (gate ${r.safetyGate}; ${parts.join(", ")}; weights renormalized over applicable components)`;
}
