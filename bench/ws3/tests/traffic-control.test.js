// ==========================================================================
// NODEX ACE - Traffic control regression suite
// Intersection reservation, path orthogonalisation, back-off resume routing,
// sim-time scenario faults, run reproducibility and sustained throughput.
// Throughput thresholds require FULL task completion: the pre-fix build met
// "at least one or two tasks done" while gridlocked, so weaker bars prove
// nothing.
// ==========================================================================

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { state } from "../../../zz-ws3/core/state.js";
import { simEngine } from "../../../zz-ws3/core/sim-engine.js";
import { simLifecycle } from "../../../zz-ws3/core/sim-lifecycle.js";
import { systemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { scenarioEngine } from "../../../zz-ws3/core/scenario-engine.js";
import { MapGeometryEngine } from "../../../zz-ws3/core/map-geometry.js";
import { IntersectionReservations, INTERSECTION_ZONE_RADIUS } from "../../../zz-ws3/core/intersection-reservation.js";
import { startBackoff, tickBackoff, isManeuvering } from "../../../zz-ws3/core/deadlock-backoff.js";
import { decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";
import { taskManager } from "../../../zz-ws3/core/centralized/TaskManager.js";

scenarioEngine.setSimEngine(simEngine);
const flush = () => new Promise(r => setTimeout(r, 0));

async function startRun(mode, count, scenario) {
  systemManager.switchSystem(mode);
  state.set("robotCount", count);
  state.set("simTestType", "scenario");
  state.set("selectedScenario", scenario);
  await simLifecycle.start();
  clearInterval(simEngine.fallbackIntervalId);
  simEngine.fallbackIntervalId = null;
}

async function runUntilDone(maxSeconds) {
  for (let i = 0; i < maxSeconds * 10 && simLifecycle.getState() === "RUNNING"; i++) {
    simEngine.update(0.1);
    if (i % 20 === 0) await flush();
  }
  await flush();
}

const registry = (mode) => (mode === "centralized" ? taskManager : decentralizedFleet.taskRegistry);

beforeEach(() => simLifecycle.reset());
afterEach(() => { simLifecycle.reset(); simEngine.pause(); });

describe("Intersection reservation", () => {
  const node = MapGeometryEngine.getActiveWaypoints()[0];
  const edge = (dx) => ({ x: node.x + dx, y: node.y });

  test("only one robot may enter a node zone; the second waits at the edge", () => {
    const res = new IntersectionReservations();
    const a = { id: "A", ...edge(-40) };
    const b = { id: "B", ...edge(40) };
    res.beginTick([a, b]);
    expect(res.tryEnter(a, node.x - INTERSECTION_ZONE_RADIUS + 2, node.y)).toBe(true);
    expect(res.tryEnter(b, node.x + INTERSECTION_ZONE_RADIUS - 2, node.y)).toBe(false);
  });

  test("the reservation is released when the holder leaves and granted FIFO", () => {
    const res = new IntersectionReservations();
    const a = { id: "A", ...edge(-40) };
    const b = { id: "B", ...edge(40) };
    res.beginTick([a, b]);
    res.tryEnter(a, node.x - 20, node.y);
    Object.assign(a, { x: node.x - 20 });
    expect(res.tryEnter(b, node.x + 20, node.y)).toBe(false); // queued
    Object.assign(a, { x: node.x - 60 });                       // A left the zone
    res.beginTick([a, b]);
    expect(res.tryEnter(b, node.x + 20, node.y)).toBe(true);
  });

  test("stale queue entries (robot stopped requesting) never block others", () => {
    const res = new IntersectionReservations();
    const a = { id: "A", ...edge(-40) };
    const b = { id: "B", ...edge(40) };
    const c = { id: "C", ...edge(-80) };
    res.beginTick([a, b, c]);
    res.tryEnter(a, node.x - 20, node.y);
    Object.assign(a, { x: node.x - 20 });
    res.tryEnter(b, node.x + 20, node.y);                       // B queues...
    Object.assign(a, { x: node.x - 60 });
    res.beginTick([a, b, c]);                                   // ...then reroutes (no request)
    res.beginTick([a, b, c]);
    expect(res.tryEnter(c, node.x - 20, node.y)).toBe(true);
  });

  test("a robot already inside a zone is never trapped", () => {
    const res = new IntersectionReservations();
    const inside = { id: "I", x: node.x + 5, y: node.y };
    const other = { id: "O", x: node.x + 6, y: node.y };
    res.beginTick([inside, other]);
    expect(res.tryEnter(inside, node.x + 8, node.y)).toBe(true);
    expect(res.tryEnter(other, node.x + 9, node.y)).toBe(true);
  });
});

describe("Axis-aligned routing", () => {
  test("orthogonalizePath replaces diagonal legs with rack-free elbows", () => {
    const out = MapGeometryEngine.orthogonalizePath([{ x: 352, y: 305 }, { x: 252, y: 305 }, { x: 212, y: 165 }]);
    for (let i = 1; i < out.length; i++) {
      const p0 = out[i - 1], p1 = out[i];
      expect(Math.abs(p0.x - p1.x) < 1 || Math.abs(p0.y - p1.y) < 1).toBe(true);
    }
    expect(MapGeometryEngine.validatePath(out).isValid).toBe(true);
  });

  test("back-off resume route retraces along aisles even with a stale path cursor", () => {
    const r = {
      id: "R01", x: 212, y: 165, targetX: 352, targetY: 165, status: "WAITING", currentTaskId: "T-1",
      plannedPath: [{ x: 145, y: 165 }, { x: 212, y: 165 }, { x: 352, y: 165 }, { x: 352, y: 305 }],
      pathCursor: 3 // stale: points past the current target
    };
    const blocker = { id: "R02", x: 250, y: 165, targetX: 145, targetY: 165 };
    expect(startBackoff(r, blocker, [blocker])).toBe(true);
    r.x = r._maneuver.refuge.x; r.y = r._maneuver.refuge.y;
    const cleared = { id: "R02", x: 740, y: 455 };
    for (let i = 0; i < 40 && isManeuvering(r); i++) tickBackoff(r, cleared, 0.1, [cleared]);
    expect(isManeuvering(r)).toBe(false);
    const pts = r.plannedPath.map(p => `${p.x},${p.y}`);
    expect(pts).toContain("352,165");   // the elbow the stale cursor used to skip
    expect(pts[pts.length - 1]).toBe("352,305");
  });
});

describe("Scenario faults run on simulation time", () => {
  test("a scheduled fault fires at its sim time, once, and not on the wall clock", async () => {
    await startRun("ace", 10, "S08"); // S08: robot failure at t=135s
    const faults = () => (state.get("activeFaults") || []).length;
    await runUntilDone(1);
    expect(faults()).toBe(0);
    state.set("simTimeSeconds", 134.9);
    simEngine.update(0.2);
    await flush();
    expect(faults()).toBe(1);
    for (let i = 0; i < 20; i++) simEngine.update(0.1);
    expect(faults()).toBe(1); // no per-tick re-injection
  });

  test("per-tick condition generators no longer mutate robots or grow obstacles", async () => {
    await startRun("centralized", 10, "S05"); // S05: dynamic obstacle scenario
    const before = simEngine.dynamicObstacles.length;
    for (let i = 0; i < 50; i++) simEngine.update(0.1);
    expect(simEngine.dynamicObstacles.length - before).toBeLessThanOrEqual(1);
  });
});

describe("Reproducibility", () => {
  test("identical configuration gives identical results", async () => {
    const snapshot = async () => {
      await startRun("decentralized", 10, "S01");
      for (let i = 0; i < 600; i++) simEngine.update(0.1);
      await flush();
      const out = state.get("robots").map(r => `${r.id}:${Math.round(r.x)},${Math.round(r.y)}`).join("|")
        + `#${decentralizedFleet.taskRegistry.getCompletedCount()}`;
      simLifecycle.reset();
      return out;
    };
    expect(await snapshot()).toBe(await snapshot());
  }, 120000);
});

describe("Sustained throughput (S01 completes, no gridlock)", () => {
  test.each([
    ["centralized", 3], ["decentralized", 3], ["ace", 3],
    ["centralized", 10], ["decentralized", 10], ["ace", 10]
  ])("%s with %i robots completes every S01 task within 300 s", async (mode, count) => {
    await startRun(mode, count, "S01");
    // Traffic-completion test: lift the dashboard's 90 s wall budget.
    state.set("simActiveConfig", { ...state.get("simActiveConfig"), durationSeconds: 300 });
    await runUntilDone(300);
    const reg = registry(mode);
    expect(reg.getCompletedCount()).toBe(reg.getTotalCount());
    expect(state.getRunConfig().end_reason).toBe("ALL_TASKS_COMPLETE");
    // Physics held throughout: nobody inside a rack at the end.
    for (const r of state.get("robots")) {
      expect(MapGeometryEngine.isPointInObstacle(r.x, r.y, 12).collision).toBe(false);
    }
  }, 180000);
});
