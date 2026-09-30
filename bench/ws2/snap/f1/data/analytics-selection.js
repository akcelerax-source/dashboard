// ==========================================================================
// NODEX - Analytics data selection (one filtered dataset for every panel).
// Recorded Run Comparison, NEEI, System Comparison bars and the Fleet Scale
// Performance Trend all read recorded runs through these functions, so the
// same filter always yields the same data.
//
// Filter semantics (implemented here, not in the UI):
//   SCENARIO selected  -> Centralized, Decentralized and NodeX ACE are eligible
//   ACE TEST selected  -> only NodeX ACE is eligible; the two baselines were
//                         never run under an ACE validation test, so they are
//                         "—" (null), never computed and never zero.
// ==========================================================================

import { getArchivedRuns } from "./run-history.js";
import { SCENARIOS, ACE_TESTS } from "./scenarios.js";
import { computeNeei, neeiReference } from "./neei.js";
import { nfeiForRun, nfeiGeomean, NFEI_VERSION, NFEI_STATUS } from "./nfei.js";

export const SUPPORTED_FLEET_SIZES = Object.freeze([3, 10, 50, 100]);
export const SYSTEMS = Object.freeze(["centralized", "decentralized", "ace"]);

export function isAceTestCode(code) {
  return ACE_TESTS.some(t => t.code === code);
}

export function selectionKind(code) {
  return isAceTestCode(code) ? "test" : "scenario";
}

export function eligibleSystems(code) {
  return selectionKind(code) === "test" ? ["ace"] : [...SYSTEMS];
}

/** Human-readable title of a scenario / test (no internal code). */
export function selectionTitle(code) {
  const def = SCENARIOS.find(s => s.code === code) || ACE_TESTS.find(t => t.code === code);
  return def ? def.name : code;
}

function runKindOf(run) {
  return run.runKind || (isAceTestCode(run.scenarioCode) ? "test" : "scenario");
}

/**
 * Latest recorded run per system for one scenario/test and fleet size.
 * Ineligible systems are null. Never mixes fleet sizes, codes or run kinds.
 */
export function selectRecordedRuns(code, fleetSize) {
  const kind = selectionKind(code);
  const eligible = new Set(eligibleSystems(code));
  const out = { centralized: null, decentralized: null, ace: null };
  for (const r of getArchivedRuns()) { // newest first
    if (r.scenarioCode !== code || Number(r.fleetSize) !== Number(fleetSize) || runKindOf(r) !== kind) continue;
    if (!eligible.has(r.systemMode) || out[r.systemMode]) continue;
    out[r.systemMode] = r;
  }
  return out;
}

/**
 * Efficiency per system for the selection ({ run, neei, nfei } or null when
 * "—"). neei = legacy NEEI v1.1 (kept for comparison); nfei = corrected NFEI
 * v2.0 (src/data/nfei.js), evaluated against the Centralized run(s) with the
 * same pairing key among ALL archived runs.
 */
export function neeiForSelection(code, fleetSize) {
  const runs = selectRecordedRuns(code, fleetSize);
  const reference = neeiReference(Object.values(runs));
  const archive = getArchivedRuns();
  const out = {};
  for (const sys of SYSTEMS) {
    out[sys] = runs[sys] ? { run: runs[sys], neei: computeNeei(runs[sys], reference), nfei: nfeiForRun(runs[sys], archive) } : null;
  }
  return { runs, reference, bySystem: out, kind: selectionKind(code) };
}

/** Metric catalogue shared by the bar chart and the fleet trend. */
export const ANALYTICS_METRICS = Object.freeze({
  neei: { label: "NEEI v1.1 (legacy)", unit: "", max: 100, read: (e) => e?.neei?.value ?? null },
  nfei: { label: `NFEI v${NFEI_VERSION}`, unit: "", max: null, read: (e) => e?.nfei?.value ?? null },
  completion: { label: "Task Completion", unit: "%", max: 100, read: (e) => e?.run?.performance?.completionPct ?? null },
  throughput: { label: "Throughput", unit: "tasks/hr", max: null, read: (e) => e?.run?.performance?.throughputPerHour ?? null },
  completionTime: { label: "Completion Time", unit: "s", max: null, read: (e) => e?.run?.performance?.completionTimeSeconds ?? null }
});

/** Values per system for the bars (null = unavailable, drawn as "—"). */
export function systemComparison(code, fleetSize, metricKeys = ["neei", "completion", "throughput", "completionTime"]) {
  const sel = neeiForSelection(code, fleetSize);
  return metricKeys.map(key => {
    const m = ANALYTICS_METRICS[key];
    const values = {};
    for (const sys of SYSTEMS) values[sys] = m.read(sel.bySystem[sys]);
    return { key, label: m.label, unit: m.unit, max: m.max, values };
  });
}

/**
 * Fleet-scale trend for one scenario/test and metric: one point per supported
 * fleet size and system, only where a run was recorded (null otherwise).
 */
export function fleetScaleTrend(code, metricKey) {
  const m = ANALYTICS_METRICS[metricKey] || ANALYTICS_METRICS.completion;
  return SUPPORTED_FLEET_SIZES.map(fleetSize => {
    const sel = neeiForSelection(code, fleetSize);
    const row = { fleetSize };
    for (const sys of SYSTEMS) row[sys] = m.read(sel.bySystem[sys]);
    return row;
  });
}

// ==========================================================================
// Analytics & Efficiency screen model
//   Situation "scenario": rows = the 14 scenarios, columns = 3 systems.
//   Situation "test":     rows = the 12 ACE validation tests, NodeX ACE only.
// Every value is read from recorded runs of the selected robot count.
// ==========================================================================

export function rowsForKind(kind) {
  return kind === "test" ? ACE_TESTS : SCENARIOS;
}

/** Recorded Run table: efficiency (NEEI, %) per row and system. */
export function efficiencyMatrix(kind, fleetSize) {
  return rowsForKind(kind).map(def => {
    const sel = neeiForSelection(def.code, fleetSize);
    const bySystem = {};
    for (const sys of SYSTEMS) {
      const e = sel.bySystem[sys];
      bySystem[sys] = e ? { value: e.neei.value, neei: e.neei, nfei: e.nfei, run: e.run } : null;
    }
    return { code: def.code, name: def.name, eligible: eligibleSystems(def.code), bySystem };
  });
}

/**
 * NodeX Experimental Efficiency Index over the whole situation (overall row).
 * Method: arithmetic mean of the per-row efficiency over the rows where EVERY
 * eligible system has a recorded, computable value (paired comparison: each
 * system is averaged over the same rows, so no system is favoured by having
 * run only easy scenarios). When no row is shared yet, each system's own rows
 * are averaged and the result is flagged partial. Coverage is reported.
 */
export function overallEfficiency(kind, fleetSize, matrix = efficiencyMatrix(kind, fleetSize)) {
  const systems = kind === "test" ? ["ace"] : [...SYSTEMS];
  const valued = (row, sys) => row.bySystem[sys] && typeof row.bySystem[sys].value === "number";
  const common = matrix.filter(row => systems.every(sys => valued(row, sys)));
  const out = {};
  for (const sys of SYSTEMS) {
    if (!systems.includes(sys)) { out[sys] = null; continue; }
    const rows = common.length ? common : matrix.filter(row => valued(row, sys));
    if (!rows.length) { out[sys] = null; continue; }
    const value = Math.round((rows.reduce((s, row) => s + row.bySystem[sys].value, 0) / rows.length) * 10) / 10;
    out[sys] = { value, rows: rows.length, total: matrix.length, partial: common.length === 0, codes: rows.map(r => r.code) };
  }
  return out;
}

/**
 * Corrected overall index (NFEI v2.0): GEOMETRIC mean of per-row NFEI (a
 * ratio scale) over the rows where every eligible system has a valid NFEI
 * (paired rows only; no partial fallback). Safety-invalid runs have no NFEI,
 * so they are counted in `invalid` and can never be averaged away. ACE tests
 * have no baseline: null for every system.
 */
export function overallNfei(kind, fleetSize, matrix = efficiencyMatrix(kind, fleetSize)) {
  const out = { centralized: null, decentralized: null, ace: null };
  if (kind === "test") return out;
  const valued = (row, sys) => typeof row.bySystem[sys]?.nfei?.value === "number";
  const common = matrix.filter(row => SYSTEMS.every(sys => valued(row, sys)));
  for (const sys of SYSTEMS) {
    const invalid = matrix.filter(row => row.bySystem[sys]?.nfei?.status === NFEI_STATUS.INVALID).length;
    const value = nfeiGeomean(common.map(row => row.bySystem[sys].nfei.value));
    out[sys] = value === null && !invalid ? null : { value, rows: common.length, total: matrix.length, invalid, codes: common.map(r => r.code) };
  }
  return out;
}

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const archOf = (run) => run?.architectureMetrics || {};

/**
 * Key Performance Metrics of one scenario/test at one robot count. Identical
 * definitions for all systems; a metric the architecture does not measure is
 * null ("—"), never zero. `better` tells which direction is preferable.
 */
export const KPI_DEFS = Object.freeze([
  { key: "nfei", label: `Efficiency NFEI v${NFEI_VERSION} (100 = Centralized ref.)`, short: "NFEI", unit: "", better: "high", read: (e) => finite(e?.nfei?.value) },
  { key: "efficiency", label: "Legacy NEEI v1.1", unit: "%", better: "high", read: (e) => finite(e?.neei?.value) },
  { key: "completion", label: "Task completion", unit: "%", better: "high", read: (e) => finite(e?.run?.performance?.completionPct) },
  { key: "tasksDone", label: "Tasks completed", unit: "", better: "high", read: (e) => finite(e?.run?.performance?.tasksCompleted) },
  { key: "makespan", label: "Completion time", unit: "s", better: "low", read: (e) => finite(e?.run?.performance?.completionTimeSeconds) },
  { key: "throughput", label: "Throughput", unit: "tasks/hr", better: "high", read: (e) => finite(e?.run?.performance?.throughputPerHour) },
  { key: "taskTime", label: "Avg task time", unit: "s", better: "low", read: (e) => finite(archOf(e?.run).allocation?.taskCompletionAvgS) },
  { key: "allocLatency", label: "Avg allocation latency", unit: "s", better: "low", read: (e) => finite(archOf(e?.run).allocation?.allocationLatencyAvgS) },
  { key: "msgsPerTask", label: "Messages per completed task", unit: "msgs", better: "low", read: (e) => {
    const v = e?.nfei?.inputs?.messagesPerTask;
    return typeof v === "number" ? Math.round(v * 10) / 10 : null;
  } },
  { key: "collisions", label: "Collisions", unit: "", better: "low", read: (e) => finite(e?.run?.summary?.collisions) },
  { key: "obstacleIntrusions", label: "Obstacle intrusions", unit: "", better: "low", read: (e) => finite(e?.run?.architectureMetrics?.physics?.obstacleIntrusions ?? e?.run?.summary?.obstacleIntrusions) },
  { key: "boundaryViolations", label: "Boundary violations", unit: "", better: "low", read: (e) => finite(e?.run?.architectureMetrics?.physics?.boundaryViolations) },
  { key: "nearCollisions", label: "Near-collisions", unit: "", better: "low", read: (e) => finite(e?.run?.summary?.nearCollisions) },
  { key: "failures", label: "Robot failures", unit: "", better: "low", read: (e) => finite(e?.run?.summary?.robotFailures) },
  { key: "recovered", label: "Re-allocated tasks recovered", unit: "%", better: "high", read: (e) => {
    const p = e?.run?.performance;
    return p && p.reallocatedTasks > 0 ? Math.round((p.reallocatedCompleted / p.reallocatedTasks) * 1000) / 10 : null;
  } },
  { key: "replans", label: "Route replans", unit: "", better: "low", read: (e) => {
    const a = archOf(e?.run);
    return finite(a.localReplans ?? a.planning?.replans);
  } },
  { key: "messages", label: "Coordination messages", unit: "msgs", better: "low", read: (e) => {
    const c = archOf(e?.run).communication;
    if (!c) return null;
    return finite(c.peerMessages ?? ((c.uplinkMessages ?? 0) + (c.downlinkCommands ?? 0)));
  } }
]);

export function kpiMetrics(code, fleetSize) {
  const sel = neeiForSelection(code, fleetSize);
  return KPI_DEFS.map(d => {
    const values = {};
    for (const sys of SYSTEMS) values[sys] = sel.bySystem[sys] ? d.read(sel.bySystem[sys]) : null;
    const present = SYSTEMS.filter(s => values[s] !== null);
    let best = null;
    if (present.length > 1) {
      const pick = d.better === "high" ? Math.max(...present.map(s => values[s])) : Math.min(...present.map(s => values[s]));
      const winners = present.filter(s => values[s] === pick);
      best = winners.length === 1 ? winners[0] : null;
    }
    return { key: d.key, label: d.label, short: d.short || d.label, unit: d.unit, better: d.better, values, best };
  });
}

/** Fleet Scale Performance metrics (overall data of the situation). */
export const FLEET_METRICS = Object.freeze({
  nfei: { label: `Overall NFEI v${NFEI_VERSION} (100 = Centralized)`, unit: "", max: null },
  efficiency: { label: "Overall legacy NEEI v1.1", unit: "%", max: 100 },
  completion: { label: "Task completion", unit: "%", max: 100 },
  throughput: { label: "Throughput", unit: "tasks/hr", max: null },
  makespan: { label: "Completion time", unit: "s", max: null }
});

/**
 * Fleet Scale Performance from overall data: one point per robot count and
 * system, averaged over the rows every eligible system recorded at that size
 * (same paired rule as the overall index). null = nothing recorded.
 */
export function fleetScaleOverall(kind, metricKey) {
  const systems = kind === "test" ? ["ace"] : [...SYSTEMS];
  const def = KPI_DEFS.find(d => d.key === metricKey) || KPI_DEFS[0];
  return SUPPORTED_FLEET_SIZES.map(fleetSize => {
    const row = { fleetSize, coverage: {} };
    if (metricKey === "nfei") {
      const o = overallNfei(kind, fleetSize);
      for (const sys of SYSTEMS) { row[sys] = o[sys] ? o[sys].value : null; row.coverage[sys] = o[sys] ? o[sys].rows : 0; }
      return row;
    }
    if (metricKey === "efficiency") {
      const o = overallEfficiency(kind, fleetSize);
      for (const sys of SYSTEMS) { row[sys] = o[sys] ? o[sys].value : null; row.coverage[sys] = o[sys] ? o[sys].rows : 0; }
      return row;
    }
    const vals = rowsForKind(kind).map(d => {
      const sel = neeiForSelection(d.code, fleetSize);
      return Object.fromEntries(SYSTEMS.map(s => [s, sel.bySystem[s] ? def.read(sel.bySystem[s]) : null]));
    });
    const common = vals.filter(v => systems.every(s => v[s] !== null));
    for (const sys of SYSTEMS) {
      if (!systems.includes(sys)) { row[sys] = null; row.coverage[sys] = 0; continue; }
      const use = (common.length ? common : vals.filter(v => v[sys] !== null)).map(v => v[sys]);
      row[sys] = use.length ? Math.round((use.reduce((a, b) => a + b, 0) / use.length) * 10) / 10 : null;
      row.coverage[sys] = use.length;
    }
    return row;
  });
}

/** ACE validation status per test at one robot count (latest recorded run). */
export function aceValidationStatus(fleetSize) {
  const runs = getArchivedRuns();
  return ACE_TESTS.map(t => {
    const run = runs.find(r => r.scenarioCode === t.code && r.systemMode === "ace" && Number(r.fleetSize) === Number(fleetSize)) || null;
    const verdict = run?.experimentResult?.verdict || run?.verdict || null;
    const status = !run ? "NOT_TESTED" : verdict === "PASS" ? "PASSED" : verdict === "FAIL" ? "FAILED" : "INCOMPLETE";
    return { code: t.code, name: t.name, status, run, criteria: run?.experimentResult?.criteria || [] };
  });
}

const SHORT_NAMES = { centralized: "Centralized", decentralized: "Decentralized", ace: "NodeX ACE" };

/**
 * Insights from the overall recorded data of the situation. Every insight is
 * computed from recorded runs; with too little data an explicit
 * "insufficient data" item is returned instead of a conclusion.
 */
export function overallInsights(kind, fleetSize) {
  const matrix = efficiencyMatrix(kind, fleetSize);
  const overall = overallNfei(kind, fleetSize, matrix);
  const systems = kind === "test" ? ["ace"] : [...SYSTEMS];
  const out = [];
  if (!matrix.some(r => systems.some(s => r.bySystem[s]))) {
    return [{ tone: "muted", title: "Insufficient data", text: `No ${kind === "test" ? "ACE validation test" : "scenario"} run recorded at ${fleetSize} robots yet. Finish or stop simulation runs to generate insights.` }];
  }
  if (kind === "scenario") {
    const ranked = systems.filter(s => typeof overall[s]?.value === "number").sort((a, b) => overall[b].value - overall[a].value);
    if (ranked.length >= 2 && overall[ranked[0]].rows > 0) {
      const [a, b] = ranked;
      const o = overall[a];
      out.push({ tone: "good", title: "Most efficient architecture", text: `${SHORT_NAMES[a]} leads with NFEI v${NFEI_VERSION} ${o.value} vs ${SHORT_NAMES[b]} ${overall[b].value} (geometric mean over ${o.rows} paired scenario${o.rows > 1 ? "s" : ""}, 100 = Centralized reference, ${fleetSize} robots).` });
    } else {
      out.push({ tone: "muted", title: "Comparison pending", text: `No scenario at ${fleetSize} robots has a valid NFEI for all three architectures with the same seed, map and duration limit. Record the missing architectures to compare.` });
    }
    let gap = null;
    for (const row of matrix) {
      const vals = systems.map(s => row.bySystem[s]?.nfei?.value).filter(v => typeof v === "number" && v > 0);
      if (vals.length < 2) continue;
      const d = Math.max(...vals) / Math.min(...vals);
      if (!gap || d > gap.d) gap = { d, row, hi: systems.find(s => row.bySystem[s]?.nfei?.value === Math.max(...vals)) };
    }
    if (gap) out.push({ tone: "info", title: "Largest efficiency gap", text: `${gap.row.name}: best / worst NFEI = ${Math.round(gap.d * 100) / 100}x between architectures; ${SHORT_NAMES[gap.hi]} highest.` });
  } else {
    const st = aceValidationStatus(fleetSize);
    const passed = st.filter(x => x.status === "PASSED").length;
    const failed = st.filter(x => x.status === "FAILED").length;
    out.push({ tone: failed ? "warn" : "good", title: "ACE feature validation", text: `${passed} passed, ${failed} failed, ${st.length - passed - failed} not tested or incomplete at ${fleetSize} robots.` });
  }
  let runs = 0, collisions = 0, intrusions = 0, boundary = 0, near = 0;
  for (const row of matrix) for (const s of systems) {
    const r = row.bySystem[s]?.run;
    if (!r) continue;
    runs++;
    const ph = r.architectureMetrics?.physics || {};
    if (typeof r.summary?.collisions === "number") collisions += r.summary.collisions;
    if (typeof ph.obstacleIntrusions === "number") intrusions += ph.obstacleIntrusions;
    if (typeof ph.boundaryViolations === "number") boundary += ph.boundaryViolations;
    if (typeof ph.nearCollisions === "number") near += ph.nearCollisions;
  }
  const violations = collisions + intrusions + boundary;
  out.push({ tone: violations ? "warn" : "good", title: "Safety", text: (violations
    ? `${collisions} collision(s), ${intrusions} obstacle intrusion(s), ${boundary} boundary violation(s) across ${runs} recorded run${runs > 1 ? "s" : ""}; those runs are INVALID (no efficiency score).`
    : `Zero collisions, obstacle intrusions and boundary violations across ${runs} recorded run${runs > 1 ? "s" : ""}.`) + ` Near-collisions (reported, not scored): ${near}.` });
  const trend = fleetScaleOverall(kind, kind === "test" ? "efficiency" : "nfei").filter(p => systems.some(s => p[s] !== null));
  if (trend.length >= 2) {
    const first = trend[0], last = trend[trend.length - 1];
    const u = kind === "test" ? "%" : "";
    const parts = systems.filter(s => first[s] !== null && last[s] !== null).map(s => `${SHORT_NAMES[s]} ${first[s]}${u} -> ${last[s]}${u}`);
    out.push({ tone: "info", title: "Fleet scaling", text: parts.length ? `Overall ${kind === "test" ? "legacy NEEI (task completion)" : `NFEI v${NFEI_VERSION}`} from ${first.fleetSize} to ${last.fleetSize} robots: ${parts.join(", ")}.` : "Scaling needs the same architecture recorded at two robot counts." });
  } else {
    out.push({ tone: "muted", title: "Fleet scaling", text: "Record this situation at a second robot count (3 / 10 / 50 / 100) to see how efficiency scales." });
  }
  return out;
}
