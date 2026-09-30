// ==========================================================================
// NodeX Fleet Efficiency Index (NFEI) — version 2.0
//
// A PROJECT-SPECIFIC composite built from recognized fleet KPIs. It is not an
// ISO / IEEE standard metric (ISO 22400 defines KPIs, not an AMR composite).
// It replaces NEEI v1.1 (src/data/neei.js, kept as the legacy index) after the
// validation in docs/NODEX_EFFICIENCY_INDEX_VALIDATION.md.
//
//   NFEI = 100 × (tasks completed / tasks assigned) × Π_k r_k^(w_k / Σw)
//   (v2.2: completion factor added so an unfinished run can never score 100)
//
//   component k                 ratio r_k (> 1 = better than reference)   w_k
//   Throughput                  X / X_ref                                  0.6
//   Allocation latency          (L_ref + 1 s) / (L + 1 s)                  0.2
//   Messages per completed task m_ref / m                                  0.2
//
//   X = tasks completed × 3600 / T_obs  (tasks/h). A task = one scenario
//       pick-and-drop order that reached COMPLETED. T_obs = task makespan when
//       all tasks completed, otherwise the sim time at the end of the run.
//   L = mean allocation latency (release -> award) of awarded tasks, s.
//   m = coordination messages / tasks completed (centralized: uplink +
//       downlink; decentralized / ACE: peer messages).
//
// Reference (v2.1, bounded 0-100): for each KPI, the BEST valid value among
// the runs with the SAME pairing key — run kind, scenario, fleet size, seed,
// map profile, duration limit and config version (at least two systems).
// Every ratio is therefore <= 1 and 100 = best on every KPI in that paired
// comparison. v2.0 used the Centralized run as reference (unbounded, > 100
// when better than Centralized); changed at the user's request for a 0-100
// scale. Rankings within a paired group are unchanged by this choice.
//
// Group-level applicability (no renormalization bias): a component is used
// for EVERY scored run of a pairing group or for none. Allocation latency is
// used only when no run of the group ended with unallocated tasks (otherwise
// the mean over awarded tasks is right-censored); messages only when every
// run measured them. Throughput is always used.
//
// Excluded on purpose (see validation doc): makespan (identical signal to
// throughput when all tasks complete, r = 1.000), task success (r = 0.92 with
// throughput in truncated runs), mean cycle time (r = 0.86 with throughput;
// censored in truncated runs), recovery (exists only when a failure happened),
// waiting fraction (not measured by the Centralized reference).
//
// Safety is a hard VALIDITY GATE, never a score: a run with any robot-robot
// collision, obstacle intrusion or boundary violation is INVALID (no number,
// so efficiency can never compensate it); if any of the three is not measured
// the run is not scored. Near-collisions are reported separately.
//
// Not scored: operator-stopped runs (observation window not set by the
// protocol) and ACE validation tests (no baseline architecture exists).
// ==========================================================================

export const NFEI_VERSION = "2.2";
export const NFEI_LABEL = "NodeX Fleet Efficiency Index";
export const NFEI_REFERENCE_SYSTEM = "centralized";
export const NFEI_ALLOC_FLOOR_S = 1;

export const NFEI_WEIGHTS = Object.freeze({
  throughput: 0.6,
  allocationLatency: 0.2,
  messagesPerTask: 0.2
});

export const NFEI_STATUS = Object.freeze({
  OK: "OK",
  INVALID: "INVALID",            // safety gate failed
  NOT_MEASURED: "NOT_MEASURED",  // safety or task data missing
  EXCLUDED: "EXCLUDED",          // operator stop / ACE test
  NO_REFERENCE: "NO_REFERENCE"   // no valid centralized run with the same key
});

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;

/** Measured inputs of one recorded run (everything NFEI reads). */
export function nfeiInputs(run) {
  if (!run) return null;
  const p = run.performance || {};
  const a = run.architectureMetrics || {};
  const ph = a.physics || {};
  const al = a.allocation || {};
  const c = a.communication || null;
  const done = num(p.tasksCompleted);
  const allDone = run.endReason === "ALL_TASKS_COMPLETE" && num(p.completionTimeSeconds) !== null;
  const tObs = allDone ? num(p.completionTimeSeconds) : num(p.simTimeSeconds);
  let messages = null;
  if (c) {
    if (num(c.peerMessages) !== null) messages = c.peerMessages;
    else if (num(c.uplinkMessages) !== null || num(c.downlinkCommands) !== null) {
      messages = (num(c.uplinkMessages) ?? 0) + (num(c.downlinkCommands) ?? 0);
    }
  }
  const fleet = num(Number(run.fleetSize));
  const sim = num(p.simTimeSeconds);
  const wait = num(a.waitingSeconds);
  return {
    runId: run.runId || run.id || null,
    system: run.systemMode,
    code: run.scenarioCode,
    // Imported / older records may lack runKind: ACE test codes are A01..A12.
    runKind: run.runKind || (/^A\d/.test(run.scenarioCode || "") ? "test" : null),
    fleetSize: fleet,
    endReason: run.endReason || null,
    tasksTotal: num(p.tasksTotal),
    tasksCompleted: done,
    observedSeconds: tObs,
    throughputPerHour: done !== null && tObs > 0 ? (done * 3600) / tObs : null,
    allocationLatencyS: num(al.allocationLatencyAvgS),
    unallocatedAtEnd: num(al.pending),
    messages,
    messagesPerTask: messages !== null && done > 0 ? messages / done : null,
    // Reported only (not in the composite)
    cycleTimeS: num(al.taskCompletionAvgS),
    makespanS: allDone ? num(p.completionTimeSeconds) : null,
    waitingFraction: wait !== null && wait >= 0 && fleet > 0 && sim > 0 ? wait / (fleet * sim) : null,
    safety: {
      collisions: num(ph.collisions ?? run.summary?.collisions),
      obstacleIntrusions: num(ph.obstacleIntrusions ?? run.summary?.obstacleIntrusions),
      boundaryViolations: num(ph.boundaryViolations),
      nearCollisions: num(ph.nearCollisions ?? run.summary?.nearCollisions)
    }
  };
}

/** Runs are comparable only with an identical pairing key. */
export function pairingKey(run) {
  if (!run) return null;
  return [run.runKind || "scenario", run.scenarioCode, Number(run.fleetSize), run.seed ?? "-", run.mapProfile ?? "-",
    run.durationLimitSeconds ?? "-", run.configVersion ?? "-"].join("|");
}

/** Hard safety validity gate (collisions + obstacle intrusions + boundary violations). */
export function safetyGate(inputs) {
  const s = inputs?.safety || {};
  const keys = ["collisions", "obstacleIntrusions", "boundaryViolations"];
  const missing = keys.filter(k => s[k] === null || s[k] === undefined);
  if (missing.length) return { status: NFEI_STATUS.NOT_MEASURED, reason: `Safety not measured: ${missing.join(", ")}`, violations: null };
  const violations = Object.fromEntries(keys.map(k => [k, s[k]]));
  const total = keys.reduce((t, k) => t + s[k], 0);
  return total > 0
    ? { status: NFEI_STATUS.INVALID, reason: `Safety gate failed: ${keys.filter(k => s[k] > 0).map(k => `${k} ${s[k]}`).join(", ")}`, violations }
    : { status: NFEI_STATUS.OK, reason: null, violations };
}

/** Whether a run can be scored at all (before looking at the reference). */
export function nfeiEligibility(run) {
  const i = nfeiInputs(run);
  if (!i) return { status: NFEI_STATUS.NOT_MEASURED, reason: "No recorded run" };
  if (i.runKind === "test") return { status: NFEI_STATUS.EXCLUDED, reason: "ACE validation test: no baseline architecture, not compared" };
  if (i.endReason === "OPERATOR_STOP") return { status: NFEI_STATUS.EXCLUDED, reason: "Operator-stopped: observation window not set by the protocol" };
  const gate = safetyGate(i);
  if (gate.status !== NFEI_STATUS.OK) return { status: gate.status, reason: gate.reason };
  if (!(i.tasksTotal > 0) || i.tasksCompleted === null || !(i.observedSeconds > 0)) {
    return { status: NFEI_STATUS.NOT_MEASURED, reason: "Task counts / observation time not recorded" };
  }
  return { status: NFEI_STATUS.OK, reason: null };
}

const geomean = (vals) => Math.exp(vals.reduce((s, v) => s + Math.log(v), 0) / vals.length);

/**
 * NFEI for every run of ONE pairing group (runs with other keys are ignored).
 * Returns { key, reference, componentsUsed, weightsUsed, results } where
 * results maps runId -> { value, status, reason, ratios, ... }.
 */
export function computeNfeiGroup(runs, { weights = NFEI_WEIGHTS, allocFloorS = NFEI_ALLOC_FLOOR_S, key = null } = {}) {
  const list = (runs || []).filter(Boolean);
  const k0 = key ?? (list.length ? pairingKey(list[0]) : null);
  const group = list.filter(r => pairingKey(r) === k0);
  const scored = [];
  const results = {};
  for (const r of group) {
    const i = nfeiInputs(r);
    const e = nfeiEligibility(r);
    const base = { version: NFEI_VERSION, runId: i.runId, system: i.system, value: null, status: e.status, reason: e.reason, ratios: {}, weightsUsed: {}, inputs: i, nearCollisions: i.safety.nearCollisions, isReference: false };
    results[i.runId] = base;
    if (e.status === NFEI_STATUS.OK) scored.push({ run: r, i, res: base });
  }
  const out = { version: NFEI_VERSION, key: k0, reference: null, componentsUsed: [], weightsUsed: {}, results };
  // Runs with zero output score 0 and do not constrain applicability.
  const producing = scored.filter(s => s.i.tasksCompleted > 0);
  const systems = new Set(scored.map(s => s.i.system));
  if (systems.size < 2 || !producing.length) {
    for (const s of scored) { s.res.status = NFEI_STATUS.NO_REFERENCE; s.res.reason = "Needs valid runs of at least two systems with the same scenario, fleet, seed, map, duration limit and config"; }
    return out;
  }
  const used = ["throughput"];
  if (producing.every(s => s.i.allocationLatencyS !== null && s.i.unallocatedAtEnd === 0)) used.push("allocationLatency");
  if (producing.every(s => s.i.messagesPerTask !== null)) used.push("messagesPerTask");
  // v2.1 reference: the BEST valid value of each KPI in the paired group, so
  // every ratio is <= 1 and NFEI is bounded to [0, 100].
  const best = (k, pick) => pick(...producing.map(s => s.i[k]));
  const reference = {
    runIds: producing.map(s => s.i.runId),
    throughputPerHour: best("throughputPerHour", Math.max),
    allocationLatencyS: used.includes("allocationLatency") ? best("allocationLatencyS", Math.min) : null,
    messagesPerTask: used.includes("messagesPerTask") ? best("messagesPerTask", Math.min) : null
  };
  const wSum = used.reduce((t, k) => t + weights[k], 0);
  const wUsed = Object.fromEntries(used.map(k => [k, weights[k] / wSum]));
  out.reference = reference;
  out.componentsUsed = used;
  out.weightsUsed = wUsed;
  for (const s of scored) {
    const res = s.res;
    res.referenceRunIds = reference.runIds;
    res.isReference = false;
    res.weightsUsed = wUsed;
    if (!(s.i.tasksCompleted > 0)) { res.value = 0; res.reason = "No task completed"; continue; }
    const r = {};
    r.throughput = s.i.throughputPerHour / reference.throughputPerHour;
    if (used.includes("allocationLatency")) r.allocationLatency = (reference.allocationLatencyS + allocFloorS) / (s.i.allocationLatencyS + allocFloorS);
    if (used.includes("messagesPerTask")) r.messagesPerTask = reference.messagesPerTask / s.i.messagesPerTask;
    const logScore = used.reduce((t, k) => t + wUsed[k] * Math.log(Math.min(1, r[k])), 0);
    res.ratios = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
    // v2.2: multiplied by the task completion ratio, so a run that left
    // tasks unfinished can never score 100 (only a complete run can).
    const completion = s.i.tasksTotal > 0 ? Math.min(1, s.i.tasksCompleted / s.i.tasksTotal) : 0;
    res.ratios.taskCompletion = Math.round(completion * 1000) / 1000;
    res.value = round1(100 * completion * Math.exp(logScore));
  }
  return out;
}

/** NFEI of one run, evaluated inside its pairing group taken from allRuns. */
export function nfeiForRun(run, allRuns, opts) {
  if (!run) return { version: NFEI_VERSION, value: null, status: NFEI_STATUS.NOT_MEASURED, reason: "No recorded run" };
  const key = pairingKey(run);
  const group = (allRuns || []).filter(r => pairingKey(r) === key);
  if (!group.includes(run)) group.push(run);
  const g = computeNfeiGroup(group, { ...opts, key });
  return { ...g.results[run.runId || run.id], componentsUsed: g.componentsUsed, reference: g.reference };
}

/** Both calculation versions of one run, labelled (legacy vs corrected). */
export function describeNfei(r) {
  if (!r) return "Not available";
  if (r.value === null) return `NFEI v${NFEI_VERSION}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`;
  const parts = Object.entries(r.ratios || {}).map(([k, v]) => `${k} ×${v} (w ${Math.round((r.weightsUsed?.[k] ?? 0) * 100) / 100})`);
  const near = r.nearCollisions > 0 ? `; near-collisions ${r.nearCollisions} (reported, not scored)` : "";
  return `NFEI v${NFEI_VERSION} = ${r.value} (100 only for a run that completed all its tasks and was best on every KPI among the paired systems; completion ratio x weighted geometric mean of ${parts.join(", ") || "no ratio"}${r.reason ? `; ${r.reason}` : ""}${near})`;
}

/** Geometric mean of positive NFEI values (ratio scale -> geometric mean). */
export function nfeiGeomean(values) {
  const v = values.filter(x => typeof x === "number" && Number.isFinite(x));
  if (!v.length) return null;
  if (v.some(x => x <= 0)) return 0;
  return round1(geomean(v));
}
