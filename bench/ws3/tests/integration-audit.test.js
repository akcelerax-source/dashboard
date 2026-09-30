// ==========================================================================
// NODEX ACE - End-to-end integration audit regression suite
// Drives the real lifecycle -> scenario engine -> sim engine -> adapters ->
// AppState path headlessly (no DOM) and locks in the wiring fixes from the
// integration audit. Ticks are driven manually for determinism.
// ==========================================================================

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { state, normalizeHitlScope } from "../../../zz-ws3/core/state.js";
import { RETURN_GRACE_SECONDS, simEngine, advanceAlongPath, aggregateFleetRace, closesSeparation, applyOperatorOverrides } from "../../../zz-ws3/core/sim-engine.js";
import { simLifecycle, LIFECYCLE_STATES, END_REASONS } from "../../../zz-ws3/core/sim-lifecycle.js";
import { systemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { scenarioEngine } from "../../../zz-ws3/core/scenario-engine.js";
import { hitlController, HITL_SCOPES } from "../../../zz-ws3/core/hitl-controller.js";
import { experimentRunner } from "../../../zz-ws3/core/experiment-runner.js";
import { MapGeometryEngine } from "../../../zz-ws3/core/map-geometry.js";
import { centralizedCoordinator } from "../../../zz-ws3/core/centralized/CentralizedCoordinator.js";
import { taskManager } from "../../../zz-ws3/core/centralized/TaskManager.js";
import { decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";
import { SimulationHistoryService, LIVE_RUN_ID } from "../../../zz-ws3/data/simulation-history.js";
import { getArchivedRuns, clearRunHistory, NOT_MEASURED } from "../../../zz-ws3/data/run-history.js";
import { BenchmarkReportService } from "../../../zz-ws3/data/benchmark-runs.js";
import { remainingRoute } from "../../../zz-ws3/components/WarehouseMap.js";

scenarioEngine.setSimEngine(simEngine);

const flush = () => new Promise(r => setTimeout(r, 0));

async function startRun({ mode = "ace", count = 3, scenario = "S01" } = {}) {
  systemManager.switchSystem(mode);
  state.set("robotCount", count);
  state.set("simTestType", "scenario");
  state.set("selectedScenario", scenario);
  const ok = await simLifecycle.start();
  // Drive ticks manually: stop the wall-clock fallback driver.
  clearInterval(simEngine.fallbackIntervalId);
  simEngine.fallbackIntervalId = null;
  return ok;
}

async function tick(seconds, dt = 0.1) {
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    simEngine.update(dt);
    if (i % 10 === 0) await flush();
  }
  await flush();
}

beforeEach(() => {
  simLifecycle.reset();
});

afterEach(() => {
  simLifecycle.reset();
  simEngine.pause();
});

describe("Run configuration integrity (fleet size, IDs, lock)", () => {
  test.each([3, 10, 50, 100])("selected fleet size %i is honoured at Start (scenario does not override)", async (count) => {
    expect(await startRun({ mode: "ace", count, scenario: "S01" })).toBe(true);
    expect(state.get("robotCount")).toBe(count);
    expect(state.get("robots").length).toBe(count);
    expect(state.getRunConfig().fleet_size).toBe(count);
    expect(state.get("simActiveConfig").robotCount).toBe(count);
    expect(state.get("simActiveConfig").recommendedRobotCount).toBe(3); // S01's own recommendation
  });

  test("centralized fleet is sized by robot count, not by task count", async () => {
    await startRun({ mode: "centralized", count: 3, scenario: "S04" });
    expect(state.get("robots").length).toBe(3);
    expect(centralizedCoordinator.fleetState.size).toBe(3);
    expect(taskManager.getTotalCount()).toBeGreaterThan(0);
    expect(centralizedCoordinator.continuousTaskGeneration).toBe(false); // identical workload across architectures
  });

  test("one run ID is shared by runId, runConfig and simActiveConfig; restart issues a new one", async () => {
    await startRun();
    const id = state.get("runId");
    expect(id).toMatch(/^RUN-/);
    expect(state.getRunConfig().run_id).toBe(id);
    expect(state.get("simActiveConfig").runId).toBe(id);
    await simLifecycle.restart();
    clearInterval(simEngine.fallbackIntervalId);
    expect(state.get("runId")).not.toBe(id);
    expect(state.get("simActiveConfig").runId).toBe(state.get("runId"));
  });

  test("run configuration is locked while running and released on stop", async () => {
    await startRun({ mode: "ace", count: 10 });
    expect(state.get("configLocked")).toBe(true);
    expect(state.set("robotCount", 100)).toBe(false);
    expect(state.set("systemMode", "centralized")).toBe(false);
    expect(state.set("selectedScenario", "S05")).toBe(false);
    simEngine.initFleet(100); // direct engine call is refused too
    expect(state.get("robots").length).toBe(10);
    expect(state.get("systemMode")).toBe("ace");

    simLifecycle.stop();
    expect(state.get("configLocked")).toBe(false);
    state.set("robotCount", 50);
    expect(state.get("robots").length).toBe(50);
  });

  test("resume is only possible from PAUSED (a STOPPED run cannot be revived)", async () => {
    await startRun();
    simLifecycle.pause();
    expect(simLifecycle.resume()).toBe(true);
    clearInterval(simEngine.fallbackIntervalId);
    simLifecycle.stop();
    expect(simLifecycle.resume()).toBe(false);
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.STOPPED);
  });
});

describe("Physics & navigation", () => {
  test.each([3, 10, 50, 100])("%i spawn points are collision-free and separated", (count) => {
    // Each fleet size has its own world profile (audit r3): spawn on it.
    MapGeometryEngine.loadMap("WH-A", null, count);
    const pts = MapGeometryEngine.computeFleetSpawnPoints(count);
    expect(pts.length).toBe(count);
    for (let i = 0; i < pts.length; i++) {
      expect(MapGeometryEngine.isPointInObstacle(pts[i].x, pts[i].y).collision).toBe(false);
      for (let j = i + 1; j < pts.length; j++) {
        expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThanOrEqual(32);
      }
    }
  });

  test("path cursor only moves forward (no ping-pong between the first waypoints)", () => {
    const path = [{ x: 145, y: 35 }, { x: 145, y: 35 }, { x: 145, y: 165 }, { x: 212, y: 165 }];
    const r = { x: 145, y: 35, targetX: 145, targetY: 35, plannedPath: path };
    advanceAlongPath(r);
    expect([r.targetX, r.targetY]).toEqual([145, 165]);
    r.x = 145; r.y = 165;
    advanceAlongPath(r);
    expect([r.targetX, r.targetY]).toEqual([212, 165]); // previously went back to (145, 35)
  });

  test("separation guard blocks gap-closing moves only", () => {
    const a = { id: "A", x: 100, y: 100 };
    const b = { id: "B", x: 120, y: 100 };
    expect(closesSeparation(a, 105, 100, [a, b], 30)).toBe(true);  // towards B
    expect(closesSeparation(a, 95, 100, [a, b], 30)).toBe(false);  // away from B
  });

  test("ACE 3-robot S01 makes task progress (regression: 0 completions before)", async () => {
    await startRun({ mode: "ace", count: 3, scenario: "S01" });
    await tick(40);
    const done = decentralizedFleet.taskRegistry.getCompletedCount();
    expect(done).toBeGreaterThanOrEqual(2);
  });

  test("no robot ever overlaps another or enters a rack during a 50-robot run", async () => {
    await startRun({ mode: "ace", count: 50, scenario: "S01" });
    for (let t = 0; t < 20; t++) {
      await tick(0.5);
      const rs = state.get("robots");
      for (let i = 0; i < rs.length; i++) {
        expect(MapGeometryEngine.isPointInObstacle(rs[i].x, rs[i].y, 12).collision).toBe(false);
        for (let j = i + 1; j < rs.length; j++) {
          expect(Math.hypot(rs[i].x - rs[j].x, rs[i].y - rs[j].y)).toBeGreaterThanOrEqual(24);
        }
      }
    }
  });

  test("map route shows only the remaining legs (a replan replaces the old route)", () => {
    const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const r = { x: 100, y: 40, targetX: 100, targetY: 100, plannedPath: path, _cursorPath: path, pathCursor: 2 };
    expect(remainingRoute(r)).toEqual([{ x: 100, y: 40 }, { x: 100, y: 100 }]);
    r.plannedPath = [{ x: 100, y: 40 }, { x: 200, y: 40 }]; // replanned
    r.targetX = 200; r.targetY = 40;
    expect(remainingRoute(r)).toEqual([{ x: 100, y: 40 }, { x: 200, y: 40 }]);
  });
});

describe("Run completion", () => {
  test("auto-finish waits for pending (UNASSIGNED) tasks and fires once per run", async () => {
    await startRun();
    // The completion check reads the KPIs published by the previous tick.
    state.set("kpis", { ...state.get("kpis"), activeTasks: 0, pendingTasks: 2, totalTasks: 5 });
    simEngine.update(0.1);
    await flush();
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.RUNNING); // open tasks remain

    // All tasks done: the run waits for robots still driving off the lanes,
    // at most RETURN_GRACE_SECONDS, then finishes exactly once.
    for (let i = 0; i < (RETURN_GRACE_SECONDS + 1) * 10 && simLifecycle.getState() === LIFECYCLE_STATES.RUNNING; i++) {
      state.set("kpis", { ...state.get("kpis"), activeTasks: 0, pendingTasks: 0, totalTasks: 5 });
      simEngine.update(0.1);
      await flush();
    }
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.FINISHED);
    expect(state.getRunConfig().end_reason).toBe(END_REASONS.ALL_TASKS_COMPLETE);
  });

  test("scenario duration limit ends the run and archives it with the reason", async () => {
    clearRunHistory();
    await startRun({ mode: "ace", count: 3, scenario: "S01" });
    const runId = state.get("runId");
    state.set("simActiveConfig", { ...state.get("simActiveConfig"), durationSeconds: 1 });
    await tick(1.5);
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.FINISHED);
    expect(state.getRunConfig().end_reason).toBe(END_REASONS.DURATION_LIMIT);
    const rec = getArchivedRuns().find(r => r.runId === runId);
    expect(rec).toBeDefined();
    expect(rec.endReason).toBe(END_REASONS.DURATION_LIMIT);
    expect(state.get("configLocked")).toBe(false);
  });
});

describe("History stays separate from live state", () => {
  test("archived run is immutable; live view uses the LIVE id; fixtures hidden by default", async () => {
    clearRunHistory();
    await startRun({ mode: "decentralized", count: 10, scenario: "S02" });
    await tick(2);
    const runId = state.get("runId");
    simLifecycle.stop();
    const rec = getArchivedRuns().find(r => r.runId === runId);
    expect(rec.systemMode).toBe("decentralized");
    expect(rec.fleetSize).toBe(10);
    const tasksBefore = rec.summary.totalTasks;

    // A newer run must not alter the archived record
    await startRun({ mode: "ace", count: 3, scenario: "S01" });
    await tick(2);
    const again = getArchivedRuns().find(r => r.runId === runId);
    expect(again.summary.totalTasks).toBe(tasksBefore);
    expect(again.systemMode).toBe("decentralized");

    const runs = SimulationHistoryService.getRuns();
    expect(runs[0].id).toBe(LIVE_RUN_ID);
    expect(runs[0].runId).toBe(state.get("runId"));
    expect(runs.some(r => r.isFixture)).toBe(false);
    // Collisions are now measured by the physics monitor (audit r3).
    expect(typeof runs[0].summary.collisions).toBe("number");
  });
});

describe("HITL (ACE only) acts on the authoritative robot state", () => {
  test("scope values are canonical across screens", () => {
    expect(normalizeHitlScope("group")).toBe("ROBOT_GROUP");
    state.set("hitlScope", "individual");
    expect(state.get("hitlScope")).toBe("INDIVIDUAL_ROBOT");
  });

  test("HOLD persists across engine ticks and RESUME releases it", async () => {
    await startRun({ mode: "ace", count: 3, scenario: "S01" });
    await tick(1);
    state.set("hitlEnabled", true);
    hitlController.dispatchCommand({ scope: HITL_SCOPES.INDIVIDUAL_ROBOT, targets: ["R01"], action: "hold" });
    const held = { ...state.get("robots").find(r => r.id === "R01") };
    await tick(3);
    const after = state.get("robots").find(r => r.id === "R01");
    expect(Math.hypot(after.x - held.x, after.y - held.y)).toBeLessThan(0.001);
    expect(decentralizedFleet.getAgent("R01").localState.hitlHold).toBe(true);

    hitlController.dispatchCommand({ scope: HITL_SCOPES.INDIVIDUAL_ROBOT, targets: ["R01"], action: "resume" });
    expect(decentralizedFleet.getAgent("R01").localState.hitlHold).toBe(false);
  });

  test("speed limit caps autonomous velocity every tick", () => {
    expect(applyOperatorOverrides({ hitlSpeedLimit: 0.4 }, 1.2)).toBe(0.4);
    expect(applyOperatorOverrides({ controlMode: "HUMAN" }, 1.2)).toBe(0);
    expect(applyOperatorOverrides({}, 1.2)).toBe(1.2);
  });

  test("HITL is rejected outside ACE", () => {
    systemManager.switchSystem("decentralized");
    const res = hitlController.dispatchCommand({ scope: HITL_SCOPES.ENTIRE_FLEET, action: "hold" });
    expect(res.success).toBe(false);
  });
});

describe("Architecture switching & RACE state", () => {
  test("switching system rebuilds the fleet under the new architecture", () => {
    systemManager.switchSystem("ace");
    state.set("robotCount", 10);
    systemManager.switchSystem("centralized");
    expect(centralizedCoordinator.fleetState.size).toBe(10);
    expect(state.get("robots").length).toBe(10);
    expect(state.get("robots")[0]).toBe(centralizedCoordinator.fleetState.get("R01"));
  });

  test("coordination state is reset for the new mode (method was shadowed before)", () => {
    systemManager.switchSystem("ace");
    systemManager.switchSystem("centralized");
    const c = state.get("coordination");
    expect(c.raceStatus).toBe("INACTIVE");
    expect(c.raceMode).toBe("OFF");
    expect(c.ace.status).toBe("OFFLINE");
  });

  test("fleet RACE mode and inputs are derived from the agents", () => {
    const agg = aggregateFleetRace([
      { raceState: "LOCAL", riskInputs: { conflict: 0.1, uncertainty: 0.2, commRisk: 0, queueGrowth: 0, cascadePressure: 0 } },
      { raceState: "CONTAINMENT", riskInputs: { conflict: 0.8, uncertainty: 0.1, commRisk: 0.3, queueGrowth: 0.5, cascadePressure: 0.4 } }
    ]);
    expect(agg.raceMode).toBe("CONTAINMENT");
    expect(agg.raceRiskComponents).toEqual({ conflict: 0.8, uncertainty: 0.2, commRisk: 0.3, queueGrowth: 0.5, cascadePressure: 0.4 });
  });

  test("live coordination.raceMode tracks the most severe robot envelope", async () => {
    await startRun({ mode: "ace", count: 10, scenario: "S01" });
    await tick(3);
    const expected = aggregateFleetRace(state.get("robots")).raceMode;
    expect(state.get("coordination").raceMode).toBe(expected);
    expect(state.get("robots")[0].riskComponents).toBeTruthy();
  });
});

describe("Benchmarks never touch the live run and never present fixtures as measured", () => {
  test("benchmark is refused while a live run is active", async () => {
    await startRun();
    expect(() => experimentRunner.runComparison({ scenarioId: "S01", durationSeconds: 1 })).toThrow(/live run/);
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.RUNNING);
  });

  test("benchmark restores the operator's live configuration", () => {
    systemManager.switchSystem("decentralized");
    state.set("robotCount", 50);
    state.set("selectedScenario", "S05");
    const lcBefore = simLifecycle.getState();
    const res = experimentRunner.runComparison({ scenarioId: "S01", durationSeconds: 1 });
    expect(simLifecycle.getState()).toBe(lcBefore); // no phantom RUNNING/PAUSED run
    expect(res.rawMetrics.centralized.messagesCount).toBeNull(); // not measured, not NaN
    expect(res.comparativeImprovements.aceVsCentralized.messages).toBeNull();
    expect(state.get("systemMode")).toBe("decentralized");
    expect(state.get("robotCount")).toBe(50);
    expect(state.get("selectedScenario")).toBe("S05");
    expect(state.get("robots").length).toBe(50);
  });

  test("report carries measured data only and missing runs as awaiting", () => {
    clearRunHistory();
    const rep = BenchmarkReportService.generateReportJson("S03", 18427, 10);
    // Synthetic dev fixtures were removed from the product.
    expect(rep.dataProvenance).toBe("Measured trials only");
    // The efficiency index is NEEI computed from recorded runs only: with no
    // recorded S03 run at 10 robots every system is null ("—"), never a
    // fixture or zero value.
    expect(rep.efficiencyIndex.version).toBe("1.1");
    expect(rep.efficiencyIndex.bySystem).toEqual({ centralized: null, decentralized: null, ace: null });
    const m = BenchmarkReportService.getMetricsForScenario("S03");
    expect(m.metrics.every(x => x.ace !== "0" && x.ace !== 0 && x.ace !== "0%")).toBe(true);
  });
});

describe("Lifecycle transition ordering", () => {
  test("stop/finish publish the final state after the run is archived, with no spurious PAUSED", async () => {
    clearRunHistory();
    await startRun();
    const seen = [];
    const archivedWhenPublished = [];
    const unsub = state.subscribe("simLifecycleState", (s) => {
      seen.push(s);
      archivedWhenPublished.push(getArchivedRuns().some(r => r.runId === state.get("runId")));
    });
    state.set("kpis", { ...state.get("kpis"), activeTasks: 0, pendingTasks: 0, totalTasks: 1 });
    simEngine.update(0.1);
    await flush();
    unsub();
    expect(seen).toEqual([LIFECYCLE_STATES.FINISHED]);
    expect(archivedWhenPublished).toEqual([true]);
  });
});
