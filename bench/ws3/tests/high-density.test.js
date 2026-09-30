// ==========================================================================
// NODEX ACE - High-density fleets (50 / 100 robots), scenario faults and
// run-history -> Analytics integration.
// Supported fleet sizes are 3, 10, 50 and 100 only.
// Throughput tests require FULL task completion (see traffic-control suite).
// ==========================================================================

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { state } from "../../../zz-ws3/core/state.js";
import { simEngine } from "../../../zz-ws3/core/sim-engine.js";
import { simLifecycle } from "../../../zz-ws3/core/sim-lifecycle.js";
import { systemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { scenarioEngine } from "../../../zz-ws3/core/scenario-engine.js";
import { MapGeometryEngine, WAREHOUSE_DIMENSIONS, WORLD_PROFILES } from "../../../zz-ws3/core/map-geometry.js";
import { decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";
import { taskManager } from "../../../zz-ws3/core/centralized/TaskManager.js";
import { PeerCommunicationBus } from "../../../zz-ws3/core/decentralized/PeerCommunicationBus.js";
import { MAX_CONCURRENT_TASKS_LARGE_FLEET, concurrentTaskLimit } from "../../../zz-ws3/core/admission-control.js";
import { buildRunView, recordRun, latestRunFor, clearRunHistory } from "../../../zz-ws3/data/run-history.js";

scenarioEngine.setSimEngine(simEngine);
const flush = () => new Promise(r => setTimeout(r, 0));
const registry = (mode) => (mode === "centralized" ? taskManager : decentralizedFleet.taskRegistry);

async function startRun(mode, count, scenario) {
  systemManager.switchSystem(mode);
  state.set("robotCount", count);
  state.set("simTestType", "scenario");
  state.set("selectedScenario", scenario);
  await simLifecycle.start();
  clearInterval(simEngine.fallbackIntervalId);
  simEngine.fallbackIntervalId = null;
}

async function runUntilDone(maxSeconds, onTick = null) {
  for (let i = 0; i < maxSeconds * 10 && simLifecycle.getState() === "RUNNING"; i++) {
    simEngine.update(0.1);
    if (onTick) onTick();
    if (i % 50 === 0) await flush();
  }
  await flush();
}

beforeEach(() => simLifecycle.reset());
afterEach(() => { simLifecycle.reset(); simEngine.pause(); });

describe("Layout per fleet size", () => {
  test.each([3, 10, 50, 100])("%i robots spawn inside the floor, outside racks, without overlap", (count) => {
    state.set("robotCount", count);
    MapGeometryEngine.loadMap("WH-A", null, count);
    const spawns = MapGeometryEngine.computeFleetSpawnPoints(count);
    expect(spawns.length).toBe(count);
    for (const p of spawns) {
      expect(MapGeometryEngine.isWithinBounds(p.x, p.y)).toBe(true);
      expect(MapGeometryEngine.isPointInObstacle(p.x, p.y).collision).toBe(false);
    }
    for (let i = 0; i < spawns.length; i++) {
      for (let j = i + 1; j < spawns.length; j++) {
        expect(Math.hypot(spawns[i].x - spawns[j].x, spawns[i].y - spawns[j].y)).toBeGreaterThanOrEqual(32);
      }
    }
  });

  test("50 and 100 robots park every robot off-lane; 100 uses the extended staging floor", () => {
    for (const count of [50, 100]) {
      MapGeometryEngine.loadMap("WH-A", null, count);
      const spawns = MapGeometryEngine.computeFleetSpawnPoints(count);
      expect(spawns.every(p => MapGeometryEngine.isOffLane(p.x, p.y))).toBe(true);
    }
    expect(WAREHOUSE_DIMENSIONS.height).toBe(WORLD_PROFILES[100].floor.height);
    expect(MapGeometryEngine.getActiveAisles().horizontal.some(h => h.id === "H-PARK")).toBe(true);
    MapGeometryEngine.loadMap("WH-A", null, 10);
    expect(WAREHOUSE_DIMENSIONS.height).toBe(WORLD_PROFILES[10].floor.height);
  });

  test("Start loads the run's layout (not whatever the map widget last drew)", async () => {
    MapGeometryEngine.loadMap("WH-A", null, 3);
    await startRun("centralized", 100, "S01");
    expect(WAREHOUSE_DIMENSIONS.height).toBe(WORLD_PROFILES[100].floor.height);
    expect(state.get("robots").length).toBe(100);
    for (const r of state.get("robots")) {
      expect(MapGeometryEngine.isPointInObstacle(r.x, r.y).collision).toBe(false);
    }
  });
});

describe("Admission control (identical for all architectures)", () => {
  test("fleets of 3/10 are never limited; 50/100 are capped", () => {
    expect(concurrentTaskLimit(3)).toBe(Infinity);
    expect(concurrentTaskLimit(10)).toBe(Infinity);
    expect(concurrentTaskLimit(50)).toBe(MAX_CONCURRENT_TASKS_LARGE_FLEET);
    expect(concurrentTaskLimit(100)).toBe(MAX_CONCURRENT_TASKS_LARGE_FLEET);
  });

  test.each(["centralized", "decentralized", "ace"])("%s 50-robot run never exceeds the cap", async (mode) => {
    await startRun(mode, 50, "S01");
    let peak = 0;
    await runUntilDone(60, () => { peak = Math.max(peak, registry(mode).getActiveTasks().length); });
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_TASKS_LARGE_FLEET);
  }, 60000);
});

describe("Sustained throughput at 50 and 100 robots (S01 completes)", () => {
  test.each([
    ["centralized", 50], ["decentralized", 50], ["ace", 50],
    ["centralized", 100], ["decentralized", 100], ["ace", 100]
  ])("%s with %i robots completes every S01 task", async (mode, count) => {
    await startRun(mode, count, "S01");
    const cfg = state.get("simActiveConfig");
    state.set("simActiveConfig", { ...cfg, durationSeconds: 3000 });
    await runUntilDone(3000);
    const reg = registry(mode);
    expect(reg.getCompletedCount()).toBe(reg.getTotalCount());
    expect(state.getRunConfig().end_reason).toBe("ALL_TASKS_COMPLETE");
    expect(state.getRunConfig().fleet_size).toBe(count);
    for (const r of state.get("robots")) {
      expect(MapGeometryEngine.isPointInObstacle(r.x, r.y, 12).collision).toBe(false);
    }
  }, 400000);
});

describe("Scenario faults act on the running architecture", () => {
  test.each(["centralized", "decentralized", "ace"])("%s S02 task burst adds real tasks", async (mode) => {
    await startRun(mode, 10, "S02");
    const before = registry(mode).getTotalCount();
    await runUntilDone(6);
    expect(registry(mode).getTotalCount()).toBeGreaterThan(before);
  });

  test("S07 comm loss degrades real peer links in decentralized modes", async () => {
    await startRun("ace", 10, "S07");
    await runUntilDone(25);
    expect(decentralizedFleet.peerBus.linkConditions.lossRate).toBeGreaterThan(0);
    expect(decentralizedFleet.peerBus.getMetrics().droppedMessages).toBeGreaterThan(0);
  });

  test("peer-bus loss is deterministic and spares SYSTEM task-board messages", () => {
    const run = () => {
      const bus = new PeerCommunicationBus();
      let got = 0, sys = 0;
      bus.subscribe("A", () => {});
      bus.subscribe("B", (m) => { if (m.senderId === "SYSTEM") sys++; else got++; });
      bus.setLinkConditions({ lossRate: 0.5 });
      for (let i = 0; i < 200; i++) bus.broadcast("A", "STATE_UPDATE", {});
      for (let i = 0; i < 20; i++) bus.broadcast("SYSTEM", "TASK_ANNOUNCEMENT", {});
      return { got, sys };
    };
    const a = run(), b = run();
    expect(a).toEqual(b);
    expect(a.got).toBeGreaterThan(40);
    expect(a.got).toBeLessThan(160);
    expect(a.sys).toBe(20);
  });

  test("S08 keeps the fleet busy past the robot failure (timeline compressed into the run budget)", async () => {
    await startRun("centralized", 10, "S08");
    // 135 s of a 600 s scenario -> ~20 s of the 90 s dashboard run.
    expect(state.getRunConfig().timeline_scale).toBeLessThan(1);
    await runUntilDone(30);
    expect(registry("centralized").getTotalCount()).toBeGreaterThan(10);
    expect(state.get("robots").find(r => r.id === "R02").status).toMatch(/error/i);
    expect(simLifecycle.getState()).toBe("RUNNING");
  });
});

describe("Run history feeds Analytics (Screen 3)", () => {
  test("a recorded run carries measured performance and is found by scenario + system", () => {
    clearRunHistory();
    const tasks = [{ id: "T1", status: "COMPLETED" }, { id: "T2", status: "COMPLETED" }, { id: "T3", status: "EXECUTING" }];
    const rec = recordRun({
      runConfig: { run_id: "RUN-TEST-1", system_id: "ace", scenario_id: "S04", fleet_size: 10, started_at: 1 },
      endReason: "OPERATOR_STOP", simTimeSeconds: 120, kpis: {}, robots: [], tasks, events: []
    });
    expect(rec.performance).toEqual({
      simTimeSeconds: 120, tasksTotal: 3, tasksCompleted: 2, completionPct: 66.7,
      completionTimeSeconds: null, throughputPerHour: 60,
      reallocatedTasks: 0, reallocatedCompleted: 0
    });
    expect(latestRunFor("S04", "ace").runId).toBe("RUN-TEST-1");
    expect(latestRunFor("S04", "centralized")).toBeNull();
    const done = buildRunView({ id: "X", runConfig: { run_id: "X" }, simTimeSeconds: 80, tasks: tasks.slice(0, 2), endReason: "ALL_TASKS_COMPLETE" });
    expect(done.performance.completionTimeSeconds).toBe(80);
  });

  test("a finished run is archived with its own system, scenario and fleet size", async () => {
    clearRunHistory();
    await startRun("centralized", 3, "S01");
    await runUntilDone(300);
    const run = latestRunFor("S01", "centralized");
    expect(run).not.toBeNull();
    expect(run.fleetSize).toBe(3);
    expect(run.endReason).toBe("ALL_TASKS_COMPLETE");
    expect(run.performance.completionPct).toBe(100);
    expect(run.performance.completionTimeSeconds).toBeGreaterThan(0);
  }, 60000);
});
