// ==========================================================================
// NODEX - Phase 10: robot task lifecycle, perimeter staging, post-task
// return, scenario triggers, coordination visibility, NEEI and the analytics
// selection semantics (scenario = 3 systems, ACE test = NodeX ACE only).
// Supported fleet sizes: 3, 10, 50, 100.
// ==========================================================================

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { state } from "../../../zz-ws4/core/state.js";
import { simEngine } from "../../../zz-ws4/core/sim-engine.js";
import { simLifecycle } from "../../../zz-ws4/core/sim-lifecycle.js";
import { systemManager } from "../../../zz-ws4/core/adapters/SystemManager.js";
import { scenarioEngine } from "../../../zz-ws4/core/scenario-engine.js";
import { MapGeometryEngine, WAREHOUSE_DIMENSIONS, WAREHOUSE_TASK_LOCATIONS } from "../../../zz-ws4/core/map-geometry.js";
import { decentralizedFleet } from "../../../zz-ws4/core/decentralized/DecentralizedFleet.js";
import { TASK_PHASE, choosePostTaskBay, POST_TASK, deriveTaskPhase, LOAD_SECONDS } from "../../../zz-ws4/core/task-lifecycle.js";
import { computeNeei, neeiReference, NEEI_WEIGHTS, NEEI_VERSION } from "../../../zz-ws4/data/neei.js";
import { recordRun, clearRunHistory } from "../../../zz-ws4/data/run-history.js";
import {
  selectRecordedRuns, neeiForSelection, systemComparison, fleetScaleTrend, eligibleSystems, SUPPORTED_FLEET_SIZES
} from "../../../zz-ws4/data/analytics-selection.js";

scenarioEngine.setSimEngine(simEngine);
const flush = () => new Promise(r => setTimeout(r, 0));

async function startRun(mode, count, scenario, type = "scenario") {
  systemManager.switchSystem(mode);
  state.set("robotCount", count);
  state.set("simTestType", type);
  state.set("selectedScenario", scenario);
  await simLifecycle.start();
  clearInterval(simEngine.fallbackIntervalId);
  simEngine.fallbackIntervalId = null;
}

async function runFor(seconds, onTick = null) {
  for (let i = 0; i < seconds * 10 && simLifecycle.getState() === "RUNNING"; i++) {
    simEngine.update(0.1);
    if (onTick) onTick();
    if (i % 50 === 0) await flush();
  }
  await flush();
}

beforeEach(() => simLifecycle.reset());
afterEach(() => { simLifecycle.reset(); simEngine.pause(); });

describe("Perimeter staging", () => {
  test.each([3, 10, 50, 100])("%i robots start off-lane on the outer ring, never in the centre", (count) => {
    state.set("robotCount", count);
    MapGeometryEngine.loadMap("WH-A", null, count);
    const spawns = MapGeometryEngine.computeFleetSpawnPoints(count);
    expect(spawns.length).toBe(count);
    const W = WAREHOUSE_DIMENSIONS.width, H = WAREHOUSE_DIMENSIONS.height;
    const nodes = MapGeometryEngine.getActiveWaypoints();
    for (const p of spawns) {
      expect(MapGeometryEngine.isOffLane(p.x, p.y)).toBe(true);          // not on a track
      expect(MapGeometryEngine.isPointInObstacle(p.x, p.y).collision).toBe(false);
      expect(nodes.some(n => Math.hypot(n.x - p.x, n.y - p.y) < 20)).toBe(false); // not on an intersection
      // not in the central 40% x 40% box
      const central = Math.abs(p.x - W / 2) < W * 0.2 && Math.abs(p.y - H / 2) < H * 0.2;
      expect(central).toBe(false);
    }
    // Outer bays are used first: every chosen bay is at least as close to the
    // boundary as every unused front-row bay.
    const rank = (b) => MapGeometryEngine.perimeterRank(b.x, b.y);
    const worst = Math.max(...spawns.map(rank));
    const unused = MapGeometryEngine.computeParkingBays().filter(b => !b.front && !spawns.some(s => s.x === b.x && s.y === b.y));
    const closer = unused.filter(b => rank(b) < worst - 1e-9
      && spawns.every(s => Math.hypot(s.x - b.x, s.y - b.y) >= 34));
    expect(closer.length).toBe(0);
  });
});

describe("Task lifecycle (all three architectures)", () => {
  test.each(["centralized", "decentralized", "ace"])("%s: TO_PICKUP -> LOADING -> TO_DROP -> UNLOADING -> return, no teleport", async (mode) => {
    await startRun(mode, 3, "S01");
    const seq = new Map();
    const last = new Map();
    let maxStep = 0, loadingMoved = 0;
    await runFor(200, () => {
      for (const r of state.get("robots")) {
        const ph = r.taskPhase;
        const s = seq.get(r.id) || [];
        if (s[s.length - 1] !== ph) s.push(ph);
        seq.set(r.id, s);
        const p = last.get(r.id);
        if (p) {
          const d = Math.hypot(r.x - p.x, r.y - p.y);
          maxStep = Math.max(maxStep, d);
          if (ph === TASK_PHASE.LOADING && p.ph === TASK_PHASE.LOADING) loadingMoved = Math.max(loadingMoved, d);
        }
        last.set(r.id, { x: r.x, y: r.y, ph });
      }
    });
    expect(state.getRunConfig().end_reason).toBe("ALL_TASKS_COMPLETE");
    const order = [TASK_PHASE.TO_PICKUP, TASK_PHASE.LOADING, TASK_PHASE.TO_DROP, TASK_PHASE.UNLOADING];
    let checked = 0;
    for (const s of seq.values()) {
      if (!s.includes(TASK_PHASE.UNLOADING)) continue;
      let k = 0;
      for (const ph of s) if (ph === order[k]) k++;
      expect(k).toBe(order.length);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(loadingMoved).toBe(0);           // stands still while loading
    expect(maxStep).toBeLessThanOrEqual(9); // waypoint snap (<6px) + one 2.6px step; no teleport
  }, 120000);

  test.each(["centralized", "decentralized", "ace"])("%s: after the run no robot rests on a lane", async (mode) => {
    await startRun(mode, 3, "S01");
    await runFor(200);
    // Keep ticking after the run ended so return legs finish.
    for (let i = 0; i < 400; i++) simEngine.update(0.1, true);
    for (const r of state.get("robots")) {
      expect(MapGeometryEngine.isOffLane(r.x, r.y)).toBe(true);
      expect(MapGeometryEngine.isPointInObstacle(r.x, r.y, 12).collision).toBe(false);
      expect([TASK_PHASE.IDLE, TASK_PHASE.CHARGING, TASK_PHASE.MAINTENANCE]).toContain(deriveTaskPhase(r));
    }
    // Return to origin: at least one robot is back in its own staging bay.
    expect(state.get("robots").some(r => r.home && Math.hypot(r.x - r.home.x, r.y - r.home.y) < 1)).toBe(true);
  }, 120000);

  test("loading dwell lasts LOAD_SECONDS of sim time", async () => {
    await startRun("centralized", 3, "S01");
    // First contiguous LOADING span of the first robot seen loading.
    let loadTicks = 0, id = null, ended = false;
    await runFor(60, () => {
      if (ended) return;
      const robots = state.get("robots");
      if (!id) id = robots.find(x => x.taskPhase === TASK_PHASE.LOADING)?.id || null;
      if (!id) return;
      if (robots.find(x => x.id === id).taskPhase === TASK_PHASE.LOADING) loadTicks++;
      else ended = true;
    });
    expect(loadTicks / 10).toBeGreaterThanOrEqual(LOAD_SECONDS - 0.2);
    expect(loadTicks / 10).toBeLessThanOrEqual(LOAD_SECONDS + 0.3);
  }, 60000);
});

describe("Post-task destinations", () => {
  const bays = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 150, y: 300 }];
  test("home bay when free, else standby; charging / maintenance near their station", () => {
    const loc = [{ id: "Charging", x: 390, y: 110 }, { id: "Maintenance", x: 160, y: 290 }];
    expect(choosePostTaskBay({ x: 0, y: 0, home: { x: 100, y: 100 }, battery: 80, health: 95 }, bays, new Set(), loc))
      .toEqual({ bay: bays[0], kind: POST_TASK.HOME });
    expect(choosePostTaskBay({ x: 0, y: 0, home: { x: 999, y: 999 }, battery: 80, health: 95 }, bays, new Set(["100,100"]), loc).kind)
      .toBe(POST_TASK.STANDBY);
    expect(choosePostTaskBay({ x: 0, y: 0, battery: 10, health: 95 }, bays, new Set(), loc)).toEqual({ bay: bays[1], kind: POST_TASK.CHARGE });
    expect(choosePostTaskBay({ x: 0, y: 0, battery: 80, health: 40 }, bays, new Set(), loc)).toEqual({ bay: bays[2], kind: POST_TASK.MAINTENANCE });
  });

  test("a low-battery robot drives to the charging bay and charges there", async () => {
    await startRun("ace", 3, "S01");
    const agent = decentralizedFleet.getAgent("R01");
    agent.localState.battery = 10;
    // Where it was while charging (after charging it may take new work).
    let chargedAt = null;
    const watch = () => {
      const l = agent.localState;
      if (!chargedAt && l.serviceState === "CHARGE") chargedAt = { x: l.x, y: l.y };
    };
    await runFor(200, watch);
    for (let i = 0; i < 600; i++) { simEngine.update(0.1, true); watch(); }
    const ls = agent.localState;
    const station = WAREHOUSE_TASK_LOCATIONS.find(l => l.id === "Charging");
    // It went to the bay nearest the charging station and charged.
    expect(ls.battery).toBeGreaterThan(10);
    expect(chargedAt).not.toBeNull();
    // Nearest free non-staging bay to the station (staging homes are reserved).
    expect(Math.abs(chargedAt.x - station.x) + Math.abs(chargedAt.y - station.y)).toBeLessThan(260);
  }, 120000);
});

describe("Scenario triggers act on working robots", () => {
  test.each(["centralized", "decentralized", "ace"])("%s S08: the failed robot had a task when it failed", async (mode) => {
    await startRun(mode, 10, "S08");
    let failedWithTask = null;
    const hadTask = new Map();
    await runFor(40, () => {
      for (const r of state.get("robots")) {
        if (r.taskPhase === TASK_PHASE.FAILED && failedWithTask === null) failedWithTask = hadTask.get(r.id) === true;
        else hadTask.set(r.id, !!r.currentTaskId);
      }
    });
    expect(failedWithTask).toBe(true);
  }, 60000);

  test("S05: the dynamic obstacle is placed on an active route", async () => {
    await startRun("ace", 3, "S05");
    // Routes as they were on the tick before the obstacle appeared (robots
    // replan around it right after).
    let hit = null, prevPaths = [];
    await runFor(80, () => {
      if (hit === null && simEngine.dynamicObstacles.length > 0) {
        const o = simEngine.dynamicObstacles[0];
        const nearSeg = (a, b) => {
          const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
          const t = Math.max(0, Math.min(1, ((o.x - a.x) * (b.x - a.x) + (o.y - a.y) * (b.y - a.y)) / len2));
          return Math.hypot(a.x + (b.x - a.x) * t - o.x, a.y + (b.y - a.y) * t - o.y) < 20;
        };
        hit = prevPaths.some(path => path.some((p, k) => k + 1 < path.length && nearSeg(p, path[k + 1])));
      }
      prevPaths = state.get("robots").filter(r => r.currentTaskId && Array.isArray(r.plannedPath)).map(r => r.plannedPath);
    });
    expect(hit).toBe(true);
  }, 60000);
});

describe("Coordination only when required", () => {
  test.each(["decentralized", "ace"])("%s: robots without tasks hold no session before allocation", (mode) => {
    systemManager.switchSystem(mode);
    state.set("robotCount", 10);
    simEngine.initFleet(10);
    state.set("simRunning", true);
    for (let i = 0; i < 100; i++) simEngine.update(0.1, true);
    expect(decentralizedFleet.getActiveSessions().length).toBe(0);
    expect(state.get("activeSessions").length).toBe(0);
    state.set("simRunning", false);
  });
});

describe("NEEI v1.1", () => {
  const run = (o = {}) => ({
    runId: "R", systemMode: o.sys || "ace", scenarioCode: "S01", fleetSize: 3, runKind: "scenario",
    performance: { tasksTotal: 4, tasksCompleted: o.done ?? 4, completionTimeSeconds: o.t ?? 60, throughputPerHour: o.x ?? 240, simTimeSeconds: 60,
      reallocatedTasks: o.re ?? 0, reallocatedCompleted: o.rc ?? 0 },
    summary: { collisions: o.col ?? 0, robotFailures: 0 }
  });
  test("weights sum to 1, version recorded", () => {
    expect(Object.values(NEEI_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(computeNeei(run(), neeiReference([run()])).version).toBe(NEEI_VERSION);
  });
  test("any collision gates NEEI to 0", () => {
    const r = run({ col: 1 });
    expect(computeNeei(r, neeiReference([r, run()])).value).toBe(0);
  });
  test("unmeasured collisions -> not computed (null), never 0", () => {
    const r = run(); r.summary.collisions = "Not measured";
    expect(computeNeei(r, neeiReference([r])).value).toBeNull();
  });
  test("renormalizes over applicable components and is deterministic", () => {
    const a = run({ t: 60, x: 240 }), b = run({ sys: "centralized", t: 120, x: 120, done: 2 });
    const ref = neeiReference([a, b]);
    const nb = computeNeei(b, ref);
    // gate 1; success .5, time .5, throughput .5, recovery N/A -> (0.175+0.125+0.125)/0.85
    expect(nb.value).toBeCloseTo(Math.round(1000 * (0.425 / 0.85)) / 10, 5);
    expect(nb.weightsUsed.recovery).toBeUndefined();
    expect(computeNeei(b, ref)).toEqual(nb);
    expect(computeNeei(a, ref).value).toBe(100);
  });
  test("single-run reference: time and throughput not applicable (no fabricated baseline)", () => {
    const a = run();
    const r = computeNeei(a, neeiReference([a]));
    expect(r.components.timeEfficiency).toBeUndefined();
    expect(r.components.throughputEfficiency).toBeUndefined();
    expect(r.value).toBe(100);
  });
  test("safety is a gate, not free points: a 20 % complete, collision-free run scores 20", () => {
    const a = run({ done: 1, x: 60 });
    a.performance.tasksTotal = 5;
    a.performance.completionTimeSeconds = null;
    expect(computeNeei(a, neeiReference([a])).value).toBe(20);
  });
});

describe("Analytics selection semantics", () => {
  const rec = (sys, code, fleet, ace = false, id = `${sys}-${code}-${fleet}`) => recordRun({
    runConfig: { run_id: id, system_id: sys, scenario_id: ace ? null : code, ace_test_id: ace ? code : null, fleet_size: fleet, started_at: 1 },
    endReason: "ALL_TASKS_COMPLETE", simTimeSeconds: 100, kpis: {}, robots: [],
    tasks: [{ id: "T1", status: "COMPLETED" }, { id: "T2", status: "COMPLETED" }], events: [],
    architectureMetrics: { physics: { collisions: 0, nearCollisions: 0, obstacleIntrusions: 0 } }
  });

  beforeEach(() => clearRunHistory());

  test("scenario: NEEI is calculated for all three systems", () => {
    for (const s of ["centralized", "decentralized", "ace"]) rec(s, "S04", 10);
    const sel = neeiForSelection("S04", 10);
    for (const s of ["centralized", "decentralized", "ace"]) {
      expect(sel.bySystem[s]).not.toBeNull();
      expect(typeof sel.bySystem[s].neei.value).toBe("number");
    }
    expect(eligibleSystems("S04")).toEqual(["centralized", "decentralized", "ace"]);
  });

  test("ACE test: baselines are — even if records exist, ACE is calculated", () => {
    rec("ace", "A05", 10, true);
    rec("centralized", "A05", 10, true, "stray-central");
    const sel = neeiForSelection("A05", 10);
    expect(sel.bySystem.centralized).toBeNull();
    expect(sel.bySystem.decentralized).toBeNull();
    expect(typeof sel.bySystem.ace.neei.value).toBe("number");
    const bars = systemComparison("A05", 10);
    for (const g of bars) {
      expect(g.values.centralized).toBeNull();
      expect(g.values.decentralized).toBeNull();
    }
  });

  test("robot-count filter never mixes fleet sizes; missing data is null, not 0", () => {
    rec("ace", "S01", 3);
    rec("centralized", "S01", 50);
    const at3 = selectRecordedRuns("S01", 3);
    expect(at3.ace.fleetSize).toBe(3);
    expect(at3.centralized).toBeNull();
    const trend = fleetScaleTrend("S01", "completion");
    expect(trend.map(t => t.fleetSize)).toEqual(SUPPORTED_FLEET_SIZES);
    expect(trend.find(t => t.fleetSize === 3).ace).toBe(100);
    expect(trend.find(t => t.fleetSize === 3).centralized).toBeNull();
    expect(trend.find(t => t.fleetSize === 50).centralized).toBe(100);
    expect(trend.find(t => t.fleetSize === 100).ace).toBeNull();
    expect(trend.some(t => t.fleetSize === 500 || t.fleetSize === 20)).toBe(false);
  });

  test("a newer run replaces the older one in every panel (no stale data)", () => {
    rec("ace", "S02", 10, false, "old");
    recordRun({
      runConfig: { run_id: "new", system_id: "ace", scenario_id: "S02", fleet_size: 10, started_at: 2 },
      endReason: "DURATION_LIMIT", simTimeSeconds: 90, kpis: {}, robots: [],
      tasks: [{ id: "T1", status: "COMPLETED" }, { id: "T2", status: "EXECUTING" }], events: [],
      architectureMetrics: { physics: { collisions: 0 } }
    });
    expect(selectRecordedRuns("S02", 10).ace.runId).toBe("new");
    expect(systemComparison("S02", 10).find(g => g.key === "completion").values.ace).toBe(50);
  });
});

describe("Profile / account removal", () => {
  test("no profile component, no user state", () => {
    expect(fs.existsSync("src/components/ProfilePopup.js")).toBe(false);
    expect(state.get("user")).toBeUndefined();
    expect(state.get("isLoggedIn")).toBeUndefined();
    const header = fs.readFileSync("src/components/ShellHeader.js", "utf-8");
    const settings = fs.readFileSync("src/components/SettingsPopup.js", "utf-8");
    for (const src of [header, settings]) expect(/profile|avatar|password|logout|sign out/i.test(src)).toBe(false);
  });
});
