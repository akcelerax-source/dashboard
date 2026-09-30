// ==========================================================================
// NODEX - NodeX Fleet Efficiency Index (NFEI) v2.1 unit tests.
// See docs/NODEX_EFFICIENCY_INDEX_VALIDATION.md for the derivation.
// ==========================================================================

import { describe, test, expect, beforeEach } from "vitest";
import {
  NFEI_VERSION, NFEI_WEIGHTS, NFEI_STATUS, nfeiInputs, pairingKey, safetyGate,
  computeNfeiGroup, nfeiForRun, nfeiGeomean, describeNfei
} from "../src/data/nfei.js";
import { computeNeei, neeiReference, NEEI_VERSION } from "../src/data/neei.js";
import { replaceArchivedRuns, clearRunHistory } from "../src/data/run-history.js";
import { neeiForSelection, efficiencyMatrix, overallNfei, kpiMetrics } from "../src/data/analytics-selection.js";

let seq = 0;
/** Minimal recorded run (shape of run-history.js buildRunView). */
function run(o = {}) {
  const sys = o.sys ?? "ace";
  const done = o.done ?? 10, total = o.total ?? 10;
  const end = o.end ?? "ALL_TASKS_COMPLETE";
  const complete = end === "ALL_TASKS_COMPLETE";
  const T = o.t ?? 100;
  const sim = o.sim ?? T + 5;
  const comm = sys === "centralized" ? { uplinkMessages: o.msgs ?? 1000, downlinkCommands: 0 } : { peerMessages: o.msgs ?? 1000 };
  return {
    runId: o.id ?? `R${++seq}`, systemMode: sys, scenarioCode: o.code ?? "S01", runKind: o.kind ?? "scenario",
    fleetSize: o.fleet ?? 10, seed: o.seed ?? 1, mapProfile: "WORLD-M", durationLimitSeconds: o.dl ?? 450, configVersion: "cfg",
    endReason: end,
    performance: {
      tasksTotal: total, tasksCompleted: done, simTimeSeconds: sim,
      completionTimeSeconds: complete ? T : null, completionPct: Math.round((done / total) * 1000) / 10,
      throughputPerHour: Math.round((done / (complete ? T : sim)) * 3600),
      reallocatedTasks: o.re ?? 0, reallocatedCompleted: o.rc ?? 0
    },
    summary: { collisions: o.col ?? 0, nearCollisions: o.near ?? 0, obstacleIntrusions: o.obs ?? 0, robotFailures: 0 },
    architectureMetrics: {
      physics: { collisions: o.col ?? 0, nearCollisions: o.near ?? 0, obstacleIntrusions: o.obs ?? 0, boundaryViolations: o.bnd === undefined ? 0 : o.bnd },
      allocation: { allocationLatencyAvgS: o.lat ?? 4, pending: o.pending ?? 0, taskCompletionAvgS: o.cycle ?? 50 },
      communication: comm
    }
  };
}

describe("NFEI v2.1 definition", () => {
  test("version and weights (sum 1); no makespan / success / recovery component", () => {
    expect(NFEI_VERSION).toBe("2.2");
    expect(Object.values(NFEI_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(Object.keys(NFEI_WEIGHTS).sort()).toEqual(["allocationLatency", "messagesPerTask", "throughput"]);
  });

  test("best-in-group scores 100 on a KPI; parity = 100; isReference always false", () => {
    const c = run({ sys: "centralized" }), a = run({ sys: "ace" });
    const g = computeNfeiGroup([c, a]);
    expect(g.results[c.runId].value).toBe(100);
    expect(g.results[a.runId].value).toBe(100);
    expect(g.results[c.runId].isReference).toBe(false);
    const f = run({ sys: "ace", t: 80 });
    const g2 = computeNfeiGroup([c, f]);
    expect(g2.results[f.runId].ratios.throughput).toBe(1);
    expect(g2.results[f.runId].value).toBe(100);
    expect(g2.results[c.runId].ratios.throughput).toBeCloseTo(0.8, 6);
  });

  test("weighted geometric mean of ratios (hand calculation)", () => {
    const c = run({ sys: "centralized", t: 100, lat: 4, msgs: 1000 });
    const a = run({ sys: "ace", t: 125, lat: 9, msgs: 500 }); // best: X c, L c (4 s), m a (50/task)
    const g = computeNfeiGroup([c, a]);
    // ace: X .8, L (5/10) .5, m 1
    expect(g.results[a.runId].value).toBeCloseTo(Math.round(1000 * Math.pow(0.8, 0.6) * Math.pow(0.5, 0.2)) / 10, 6);
    // centralized: X 1, L 1, m (50/100) .5
    expect(g.results[c.runId].value).toBeCloseTo(Math.round(1000 * Math.pow(0.5, 0.2)) / 10, 6);
  });

  test("time and throughput are not double counted (makespan enters once, via throughput)", () => {
    const c = run({ sys: "centralized", t: 100 }), a = run({ sys: "ace", t: 200 });
    const r = computeNfeiGroup([c, a]).results[a.runId];
    expect(Object.keys(r.ratios)).not.toContain("timeEfficiency");
    expect(r.ratios.throughput).toBeCloseTo(0.5, 6);
    expect(r.value).toBeCloseTo(Math.round(1000 * Math.pow(0.5, 0.6)) / 10, 6);
  });

  test("bounded 0..100 and best system = 100 when best on every KPI", () => {
    const c = run({ sys: "centralized", t: 100, lat: 4, msgs: 1000 }), a = run({ sys: "ace", t: 120, lat: 6, msgs: 1500 });
    const alone = computeNfeiGroup([c, a]).results[a.runId].value;
    const d = run({ sys: "decentralized", t: 60, lat: 2, msgs: 500 }); // best on every KPI
    const g = computeNfeiGroup([c, a, d]);
    expect(g.results[d.runId].value).toBe(100);
    for (const r of Object.values(g.results)) {
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(100);
      for (const v of Object.values(r.ratios)) expect(v).toBeLessThanOrEqual(1);
    }
    expect(g.results[a.runId].value).toBeLessThan(alone); // v2.1: depends on the other runs of the paired group
  });

  test("scale invariance: changing message units for every run leaves NFEI unchanged", () => {
    const c = run({ sys: "centralized", msgs: 1000 }), a = run({ sys: "ace", msgs: 3000, t: 90 });
    const c2 = run({ sys: "centralized", msgs: 10 }), a2 = run({ sys: "ace", msgs: 30, t: 90 });
    expect(computeNfeiGroup([c2, a2]).results[a2.runId].value).toBe(computeNfeiGroup([c, a]).results[a.runId].value);
  });

  test("higher is always better (non-best run): more throughput, less latency, fewer messages each raise NFEI", () => {
    const c = run({ sys: "centralized", t: 100, lat: 2, msgs: 500 }); // best on every KPI
    const base = computeNfeiGroup([c, run({ id: "b", sys: "ace", t: 120, lat: 4, msgs: 1000 })]).results.b.value;
    expect(base).toBeLessThan(100);
    expect(computeNfeiGroup([c, run({ id: "x", sys: "ace", t: 110, lat: 4, msgs: 1000 })]).results.x.value).toBeGreaterThan(base);
    expect(computeNfeiGroup([c, run({ id: "l", sys: "ace", t: 120, lat: 3, msgs: 1000 })]).results.l.value).toBeGreaterThan(base);
    expect(computeNfeiGroup([c, run({ id: "m", sys: "ace", t: 120, lat: 4, msgs: 800 })]).results.m.value).toBeGreaterThan(base);
  });
});

describe("NFEI safety validity gate", () => {
  test.each([["col", 1], ["obs", 1], ["bnd", 2]])("%s > 0 -> INVALID with no number (never compensated)", (k, v) => {
    const c = run({ sys: "centralized" }), a = run({ sys: "ace", t: 50, [k]: v });
    const r = computeNfeiGroup([c, a]).results[a.runId];
    expect(r.status).toBe(NFEI_STATUS.INVALID);
    expect(r.value).toBeNull();
  });
  test("boundary violations not measured -> not scored", () => {
    expect(safetyGate(nfeiInputs(run({ sys: "ace", bnd: null }))).status).toBe(NFEI_STATUS.NOT_MEASURED);
  });
  test("near-collisions are reported but do not change the score", () => {
    const c = run({ sys: "centralized" });
    const a = computeNfeiGroup([c, run({ id: "n0", sys: "ace", near: 0 })]).results.n0;
    const b = computeNfeiGroup([c, run({ id: "n5", sys: "ace", near: 5 })]).results.n5;
    expect(b.value).toBe(a.value);
    expect(b.nearCollisions).toBe(5);
    expect(describeNfei(b)).toMatch(/near-collisions 5/);
  });
  test("an invalid centralized run is never used as the reference", () => {
    const c = run({ sys: "centralized", col: 1 }), a = run({ sys: "ace" });
    expect(computeNfeiGroup([c, a]).results[a.runId].status).toBe(NFEI_STATUS.NO_REFERENCE);
  });
});

describe("NFEI applicability and pairing", () => {
  test("group-level applicability: censored allocation latency is dropped for every run", () => {
    const c = run({ sys: "centralized" });
    const a = run({ sys: "ace", end: "DURATION_LIMIT", done: 6, pending: 3, sim: 450 });
    const g = computeNfeiGroup([c, a]);
    expect(g.componentsUsed).toEqual(["throughput", "messagesPerTask"]);
    expect(g.results[c.runId].ratios.allocationLatency).toBeUndefined();
    expect(g.results[a.runId].ratios.allocationLatency).toBeUndefined();
  });
  test("operator-stopped runs and ACE tests are excluded (—), never 0", () => {
    const c = run({ sys: "centralized" });
    const s = run({ sys: "ace", end: "OPERATOR_STOP", sim: 40, done: 3 });
    expect(computeNfeiGroup([c, s]).results[s.runId].status).toBe(NFEI_STATUS.EXCLUDED);
    const t = run({ sys: "ace", kind: "test", code: "A01" });
    const r = nfeiForRun(t, [t]);
    expect(r.status).toBe(NFEI_STATUS.EXCLUDED);
    expect(r.value).toBeNull();
  });
  test("no centralized run with the same key (seed / duration limit) -> NO_REFERENCE", () => {
    const a = run({ sys: "ace", seed: 1 });
    const c = run({ sys: "centralized", seed: 2 });
    expect(pairingKey(c)).not.toBe(pairingKey(a));
    expect(nfeiForRun(a, [c, a]).status).toBe(NFEI_STATUS.NO_REFERENCE);
    expect(nfeiForRun(a, [run({ sys: "centralized", dl: 90 }), a]).status).toBe(NFEI_STATUS.NO_REFERENCE);
  });
  test("zero completed tasks scores 0 (valid run, no output)", () => {
    const c = run({ sys: "centralized" }), a = run({ sys: "ace", end: "DURATION_LIMIT", done: 0, pending: 10, sim: 450 });
    expect(computeNfeiGroup([c, a]).results[a.runId].value).toBe(0);
  });
  test("several replicates -> reference = best value over all producing runs", () => {
    const c1 = run({ sys: "centralized", t: 100 }), c2 = run({ sys: "centralized", t: 400 });
    const a = run({ sys: "ace", t: 200 });
    const g = computeNfeiGroup([c1, c2, a]);
    expect(g.reference.runIds).toEqual([c1.runId, c2.runId, a.runId]);
    expect(g.results[a.runId].ratios.throughput).toBeCloseTo(0.5, 6); // best X = c1 (t 100)
    expect(g.results[c1.runId].value).toBe(100);
  });
  test("geometric overall mean; any zero -> 0; empty -> null", () => {
    expect(nfeiGeomean([50, 200])).toBe(100);
    expect(nfeiGeomean([0, 120])).toBe(0);
    expect(nfeiGeomean([])).toBeNull();
  });
});

describe("Dashboard wiring: both calculation versions available", () => {
  beforeEach(() => clearRunHistory());
  test("selection exposes legacy NEEI v1.1 and corrected NFEI v2.1 for the same run", () => {
    const runs = [run({ sys: "ace", t: 120 }), run({ sys: "decentralized", t: 150 }), run({ sys: "centralized", t: 100 })];
    replaceArchivedRuns(runs);
    const sel = neeiForSelection("S01", 10);
    for (const s of ["centralized", "decentralized", "ace"]) {
      expect(sel.bySystem[s].neei.version).toBe(NEEI_VERSION);
      expect(sel.bySystem[s].nfei.version).toBe(NFEI_VERSION);
      expect(typeof sel.bySystem[s].nfei.value).toBe("number");
    }
    expect(sel.bySystem.centralized.nfei.value).toBe(100);
    const legacy = computeNeei(runs[0], neeiReference(runs));
    expect(sel.bySystem.ace.neei.value).toBe(legacy.value);
    const kpis = kpiMetrics("S01", 10);
    expect(kpis.find(k => k.key === "nfei").values.ace).toBe(sel.bySystem.ace.nfei.value);
    expect(kpis.find(k => k.key === "efficiency")).toBeUndefined(); // legacy row removed from the display (user request)
    const o = overallNfei("scenario", 10, efficiencyMatrix("scenario", 10));
    expect(o.centralized.value).toBe(100);
    expect(o.ace.rows).toBe(1);
  });
  test("ACE test selection: NFEI — for NodeX ACE, baselines stay —", () => {
    replaceArchivedRuns([run({ sys: "ace", kind: "test", code: "A05" })]);
    const sel = neeiForSelection("A05", 10);
    expect(sel.bySystem.centralized).toBeNull();
    expect(sel.bySystem.decentralized).toBeNull();
    expect(sel.bySystem.ace.nfei.value).toBeNull();
    expect(overallNfei("test", 10).ace).toBeNull();
  });
});
