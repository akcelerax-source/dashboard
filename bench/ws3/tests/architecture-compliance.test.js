// ==========================================================================
// NODEX - Three-system architecture compliance (audit r3)
// Centralized / Decentralized / NodeX Edge AI ACE decentralized are separate
// controllers: exactly one runs per simulation, each with its own decision
// logic, and HITL exists only in ACE. World size scales 3 < 10 < 50 < 100.
// ==========================================================================

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { state, SYSTEM_NAMES, SUPPORTED_ROBOT_COUNTS } from "../../../zz-ws3/core/state.js";
import { simEngine } from "../../../zz-ws3/core/sim-engine.js";
import { simLifecycle } from "../../../zz-ws3/core/sim-lifecycle.js";
import { systemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { scenarioEngine } from "../../../zz-ws3/core/scenario-engine.js";
import { hitlController } from "../../../zz-ws3/core/hitl-controller.js";
import { centralizedCoordinator } from "../../../zz-ws3/core/centralized/CentralizedCoordinator.js";
import { taskManager } from "../../../zz-ws3/core/centralized/TaskManager.js";
import { hungarian } from "../../../zz-ws3/core/centralized/HungarianAssignment.js";
import { CBSPlanner } from "../../../zz-ws3/core/centralized/CBSPlanner.js";
import { GlobalPlanner } from "../../../zz-ws3/core/centralized/GlobalPlanner.js";
import { decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";
import { RobotAgent } from "../../../zz-ws3/core/decentralized/RobotAgent.js";
import { PeerCommunicationBus } from "../../../zz-ws3/core/decentralized/PeerCommunicationBus.js";
import { MapGeometryEngine, WAREHOUSE_DIMENSIONS, WORLD_PROFILES, WAREHOUSE_TASK_LOCATIONS } from "../../../zz-ws3/core/map-geometry.js";
import { RaceEvaluator } from "../../../zz-ws3/core/race-evaluator.js";
import { evaluateExperiment } from "../../../zz-ws3/core/experiment-result.js";
import { getArchivedRuns, clearRunHistory } from "../../../zz-ws3/data/run-history.js";

scenarioEngine.setSimEngine(simEngine);
const flush = () => new Promise(r => setTimeout(r, 0));

async function startRun(mode, count, scenario, limit = null) {
  systemManager.switchSystem(mode);
  state.set("robotCount", count);
  state.set("simTestType", "scenario");
  state.set("selectedScenario", scenario);
  await simLifecycle.start();
  clearInterval(simEngine.fallbackIntervalId);
  simEngine.fallbackIntervalId = null;
  if (limit) state.set("simActiveConfig", { ...state.get("simActiveConfig"), durationSeconds: limit });
}

async function run(seconds, onTick = null) {
  for (let i = 0; i < seconds * 10 && simLifecycle.getState() === "RUNNING"; i++) {
    simEngine.update(0.1);
    if (onTick) onTick(i);
    if (i % 50 === 0) await flush();
  }
  await flush();
}

beforeEach(() => simLifecycle.reset());
afterEach(() => { simLifecycle.reset(); simEngine.pause(); state.set("hitlEnabled", false); });

describe("Runtime isolation: exactly one controller per run", () => {
  test.each(["centralized", "decentralized", "ace"])("%s: only the selected controller holds robots and state", async (mode) => {
    await startRun(mode, 10, "S01");
    await run(3);
    const ctl = state.get("activeController");
    expect(ctl.system).toBe(mode);
    expect(simEngine.activeController).toBe(mode);
    if (mode === "centralized") {
      expect(centralizedCoordinator.fleetState.size).toBe(10);
      expect(decentralizedFleet.agents.size).toBe(0);
      expect(decentralizedFleet.peerBus.subscribers.size).toBe(0);
      expect(decentralizedFleet.peerBus.getMetrics().totalMessages).toBe(0);
    } else {
      expect(decentralizedFleet.agents.size).toBe(10);
      expect(centralizedCoordinator.fleetState.size).toBe(0);
      expect(taskManager.getTotalCount()).toBe(0);
    }
    expect(state.get("architectureMetrics").system).toBe(mode);
  });

  test("switching system tears down sessions, contracts, paths and HITL of the previous one", async () => {
    await startRun("ace", 10, "S04");
    await run(10);
    simLifecycle.reset();
    systemManager.switchSystem("decentralized");
    expect(state.get("contracts")).toEqual([]);
    expect(state.get("activeSessions")).toEqual([]);
    for (const r of state.get("robots")) {
      expect(r.raceState).toBe(null);
      expect(r.hitlHold || false).toBe(false);
      expect(r.plannedPath).toEqual([]);
    }
  });

  test("canonical names and supported fleet sizes", () => {
    expect(SYSTEM_NAMES.ace).toBe("NodeX Edge AI ACE decentralized");
    expect(SYSTEM_NAMES.centralized).toBe("Centralized");
    expect(SYSTEM_NAMES.decentralized).toBe("Decentralized");
    expect(SUPPORTED_ROBOT_COUNTS).toEqual([3, 10, 50, 100]);
  });
});

describe("World scales with the fleet: 3 < 10 < 50 < 100", () => {
  test("floor area, lanes and intersections strictly grow; tasks fit the world", () => {
    let prev = null;
    for (const n of [3, 10, 50, 100]) {
      MapGeometryEngine.loadMap("WH-A", null, n);
      const L = MapGeometryEngine.generatedLayout;
      const area = WAREHOUSE_DIMENSIONS.width * WAREHOUSE_DIMENSIONS.height;
      const meta = MapGeometryEngine.getMapMetadata();
      expect(meta.worldProfileId).toBe(WORLD_PROFILES[n].id);
      // Overview camera target = the complete world.
      expect(meta.visibleWidth).toBe(WAREHOUSE_DIMENSIONS.width);
      expect(meta.visibleHeight).toBe(WAREHOUSE_DIMENSIONS.height);
      expect(meta.zoom).toBe(1);
      for (const loc of WAREHOUSE_TASK_LOCATIONS) {
        expect(MapGeometryEngine.isWithinBounds(loc.x, loc.y)).toBe(true);
        expect(L.waypoints.some(w => w.x === loc.x && w.y === loc.y)).toBe(true);
      }
      if (prev) {
        expect(area).toBeGreaterThan(prev.area);
        expect(L.waypoints.length).toBeGreaterThan(prev.wps);
      }
      prev = { area, wps: L.waypoints.length };
    }
  });

  test("planner graph and collision geometry use the loaded world", () => {
    MapGeometryEngine.loadMap("WH-A", null, 3);
    const planner = new GlobalPlanner();
    const path = planner.planPath({ x: 145, y: 35 }, { x: 578, y: 305 });
    for (const p of path) expect(MapGeometryEngine.isWithinBounds(p.x, p.y)).toBe(true);
    expect(MapGeometryEngine.isWithinBounds(740, 35)).toBe(false); // outside the small world
  });
});

describe("System 1 — pure centralized", () => {
  test("Hungarian finds the optimal one-to-one assignment", () => {
    const cost = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
    const pairs = hungarian(cost);
    const total = pairs.reduce((s, [i, j]) => s + cost[i][j], 0);
    expect(total).toBe(5); // 1 + 2 + 2
    expect(new Set(pairs.map(p => p[0])).size).toBe(3);
  });

  test("CBS resolves a head-on lane conflict (no residual conflict)", () => {
    MapGeometryEngine.loadMap("WH-A", null, 10);
    const gp = new GlobalPlanner();
    const cbs = new CBSPlanner(gp.graph);
    const res = cbs.plan([
      { id: "A", start: "WP-145-305", startTime: 0, goals: ["WP-740-305"] },
      { id: "B", start: "WP-740-305", startTime: 0, goals: ["WP-145-305"] }
    ]);
    expect(res.conflictsResolved).toBeGreaterThan(0);
    expect(res.residualConflict).toBe(false);
    expect(cbs.findConflict(res.paths)).toBe(null);
  });

  test("a centralized run allocates centrally with measured latency and plans with CBS", async () => {
    await startRun("centralized", 10, "S04", 300);
    await run(40);
    const m = state.get("architectureMetrics");
    expect(m.allocation.method).toMatch(/Hungarian/);
    expect(m.allocation.decisions).toBeGreaterThan(0);
    expect(typeof m.allocation.allocationLatencyAvgS).toBe("number");
    expect(m.planning.method).toMatch(/Conflict-Based Search/);
    expect(m.planning.runs).toBeGreaterThan(0);
    expect(m.communication.uplinkMessages).toBeGreaterThan(0);
    expect(m.edgeAi).toBeUndefined();
    expect(m.race).toBeUndefined();
    for (const r of state.get("robots")) expect(r.raceState).toBe(null);
  });

  test("server outage = safe hold, never peer-to-peer fallback", async () => {
    await startRun("centralized", 10, "S01", 300);
    await run(5);
    centralizedCoordinator.setServerOnline(false, 10);
    await run(3);
    for (const r of state.get("robots")) {
      expect(r.velocity).toBe(0);
      expect(r.centralHold).toBe(true);
    }
    expect(decentralizedFleet.agents.size).toBe(0);
    expect(decentralizedFleet.peerBus.getMetrics().totalMessages).toBe(0);
    await run(10);
    expect(centralizedCoordinator.serverOnline).toBe(true);
  });
});

describe("System 2 — decentralized, fixed two-robot coordination, no ACE", () => {
  test("pair sessions have exactly two robots, one session per robot, and coordination is continuous", async () => {
    await startRun("decentralized", 10, "S03", 300);
    let maxSize = 0, sawSession = false;
    await run(40, () => {
      const sessions = state.get("activeSessions");
      const seen = new Set();
      for (const s of sessions) {
        sawSession = true;
        maxSize = Math.max(maxSize, s.robots.length);
        expect(s.robots.length).toBe(2);
        for (const id of s.robots) { expect(seen.has(id)).toBe(false); seen.add(id); }
      }
    });
    expect(sawSession).toBe(true);
    expect(maxSize).toBe(2);
    const m = state.get("architectureMetrics");
    expect(m.coordination.refreshPairSessions).toBeGreaterThan(0); // not only on conflict
    expect(m.coordination.maxSessionSize).toBe(2);
    expect(m.allocation.method).toMatch(/Contract-Net/);
    expect(m.edgeAi).toBeUndefined();
    expect(state.get("contracts")).toEqual([]);
    for (const a of decentralizedFleet.agents.values()) {
      expect(a.edgeAi).toBe(null);
      expect(a.ace).toBe(null);
      expect(a.localState.raceState).toBe(null);
    }
  });

  test("a third robot is rejected while a pair is busy and has to wait", () => {
    const bus = new PeerCommunicationBus();
    const a = new RobotAgent("R01", { x: 200, y: 165 }, bus);
    const b = new RobotAgent("R02", { x: 230, y: 165 }, bus);
    const c = new RobotAgent("R03", { x: 260, y: 165 }, bus);
    a.pair.request("R02", "conflict", 0);
    b.processInbox(); a.processInbox();
    expect(a.pair.isPairedWith("R02")).toBe(true);
    c.pair.request("R02", "conflict", 0);
    b.processInbox(); c.processInbox();
    expect(c.pair.inSession()).toBe(false);
    expect(c.pair.stats.busyRejections).toBe(1);
  });

  test("collision awareness is sensor-only: a peer known only by radio is not a conflict", () => {
    const bus = new PeerCommunicationBus();
    const a = new RobotAgent("R01", { x: 300, y: 165 }, bus);
    a.localState.currentTaskId = "T-1"; a.localState.status = "MOVING";
    a.localState.targetX = 400; a.localState.targetY = 165;
    a.peerCache.set("R02", { id: "R02", x: 320, y: 165, targetX: 200, targetY: 165, status: "MOVING", currentTaskId: "T-2", lastSeen: a.now() });
    a.setSensorFrame({ detections: [], obstacles: [] }); // sensors see nobody
    a.evaluatePeerConflicts(0.1);
    expect(a.localState.status).toBe("MOVING");
  });
});

describe("System 3 — NodeX Edge AI ACE decentralized", () => {
  test("RACE uses the canonical weighted formula", () => {
    const ev = new RaceEvaluator();
    const inputs = { conflict: 1, uncertainty: 0.5, commRisk: 0.2, queueGrowth: 0.4, cascadePressure: 0.6 };
    const w = ev.riskWeights;
    const expected = w.w1 * 1 + w.w2 * 0.5 + w.w3 * 0.2 + w.w4 * 0.4 + w.w5 * 0.6;
    expect(ev.calculateRaceRisk(inputs)).toBeCloseTo(expected, 3);
    expect(ev.thresholds.T_neigh_exit).toBeLessThan(ev.thresholds.T_local_enter); // hysteresis band
  });

  test("Edge AI runs on every robot and feeds fused sensor + AI risk", async () => {
    await startRun("ace", 10, "S04", 300);
    await run(20);
    const m = state.get("architectureMetrics");
    expect(m.edgeAi.inferences).toBeGreaterThan(0);
    for (const a of decentralizedFleet.agents.values()) {
      expect(a.edgeAi.stats.inferences).toBeGreaterThan(0);
      expect(typeof a.localState.riskInputs.aiConflict).toBe("number");
      expect(typeof a.localState.riskInputs.sensorConflict).toBe("number");
    }
  });

  test("adaptive scope: session size follows the situation (N > 2 possible)", () => {
    const bus = new PeerCommunicationBus();
    const agents = ["R01", "R02", "R03", "R04"].map((id, i) => new RobotAgent(id, { x: 330 + i * 14, y: 305 }, bus, { aceEnabled: true }));
    const me = agents[0];
    me.localState.raceState = "CONTAINMENT";
    me.localState.envelopeRadius = 60;
    me.localState.currentTaskId = "T-1";
    me.localState.targetX = 352; me.localState.targetY = 305;
    const frame = { detections: agents.slice(1).map(a => ({ id: a.robotId, x: a.localState.x, y: a.localState.y, vx: 0, vy: 0, dist: Math.hypot(a.localState.x - me.localState.x, 0), failed: false })), obstacles: [] };
    me.setSensorFrame(frame);
    me.ace.tick(0.1, 1, frame, { conflict: 1 });
    expect(me.ace.groupSize()).toBe(4);
    expect(me.ace.session.contract.order.length).toBe(4);
    // A LOCAL robot opens no session (scope 1).
    const solo = new RobotAgent("R09", { x: 145, y: 35 }, new PeerCommunicationBus(), { aceEnabled: true });
    solo.ace.tick(0.1, 1, { detections: [], obstacles: [] }, { conflict: 0 });
    expect(solo.ace.groupSize()).toBe(1);
  });

  test("live sessions and contracts disappear when the session ends", async () => {
    await startRun("ace", 10, "S04", 300);
    let everActive = false;
    await run(90, () => { if (state.get("activeSessions").length) everActive = true; });
    expect(everActive).toBe(true);
    const live = new Set(state.get("activeSessions").map(s => s.id));
    // Every published session is held by a real agent right now.
    for (const id of live) {
      expect([...decentralizedFleet.agents.values()].some(a => a.ace.session && a.ace.session.sid === id)).toBe(true);
    }
    expect(decentralizedFleet.sessionLog.length).toBeGreaterThan(0);
    const m = state.get("architectureMetrics");
    expect(m.contracts.issued).toBeGreaterThan(0);
    expect(m.sessions.scopeChanges).toBeGreaterThan(0); // envelope expanded and contracted
    expect(Number.isFinite(m.sessions.sessionReplans)).toBe(true);
  });

  test("an ACE replan really changes the path geometry", () => {
    MapGeometryEngine.loadMap("WH-A", null, 10);
    const a = new RobotAgent("R01", { x: 212, y: 305 }, new PeerCommunicationBus(), { aceEnabled: true });
    a.localState.currentTaskId = "T-1";
    a.localState.currentGoal = { x: 578, y: 305 };
    a.localState.pickedUp = true;
    const original = a.localPlanner.planPath({ x: 212, y: 305 }, { x: 578, y: 305 });
    a.localState.plannedPath = original; a.localState.currentPath = original;
    a.localState.targetX = original[1].x; a.localState.targetY = original[1].y;
    a.ace.session = { sid: "S", initiator: "R02", members: ["R01", "R02"], region: { x: 352, y: 305, radius: 38, nodeKey: "352,305" }, contract: { order: ["R02", "R01"], slots: [] }, openedAt: 0, until: 99 };
    a.recoverFromDeadlock("R02");
    const after = a.localState.plannedPath;
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(original));
    expect(after.some(p => p.x === 352 && p.y === 305)).toBe(false); // avoids the contracted region
    expect(a.metrics.localReplans).toBe(1);
  });
});

describe("HITL exists only in NodeX Edge AI ACE decentralized", () => {
  test.each(["centralized", "decentralized"])("%s rejects every HITL command in the backend", async (mode) => {
    await startRun(mode, 3, "S01", 300);
    state.set("hitlEnabled", true);
    for (const scope of ["ENTIRE_FLEET", "ROBOT_GROUP", "INDIVIDUAL_ROBOT"]) {
      const res = hitlController.dispatchCommand({ scope, targets: ["R01", "R02"], action: "hold" });
      expect(res.success).toBe(false);
    }
    await run(1);
    for (const r of state.get("robots")) expect(r.hitlHold || false).toBe(false);
  });

  test("ACE: fleet / group / individual scopes reach the runtime robots", async () => {
    await startRun("ace", 10, "S01", 300);
    await run(3);
    state.set("hitlEnabled", true);
    const held = (id) => decentralizedFleet.getAgent(id).localState.hitlHold === true;

    expect(hitlController.dispatchCommand({ scope: "INDIVIDUAL_ROBOT", targets: "R03", action: "hold" }).success).toBe(true);
    await run(1);
    expect(held("R03")).toBe(true);
    expect(held("R04")).toBe(false);
    expect(state.get("robots").find(r => r.id === "R03").velocity).toBe(0);

    expect(hitlController.dispatchCommand({ scope: "ROBOT_GROUP", targets: ["R05", "R06"], action: "hold" }).success).toBe(true);
    await run(1);
    expect(held("R05") && held("R06")).toBe(true);
    expect(held("R07")).toBe(false);

    expect(hitlController.dispatchCommand({ scope: "ENTIRE_FLEET", action: "hold" }).success).toBe(true);
    await run(1);
    for (const a of decentralizedFleet.agents.values()) expect(a.localState.hitlHold).toBe(true);
    for (const r of state.get("robots")) expect(r.velocity).toBe(0);

    expect(hitlController.dispatchCommand({ scope: "ENTIRE_FLEET", action: "resume" }).success).toBe(true);
    await run(1);
    for (const a of decentralizedFleet.agents.values()) expect(a.localState.hitlHold).toBe(false);
    expect(state.get("architectureMetrics").hitlActions).toBe(4);
    expect(state.get("hitlAuditLog")[0].success).toBe(true);
  });
});

describe("Experiment result and run linkage", () => {
  test("all tasks completed but one collision is a FAIL", () => {
    const tasks = [{ status: "COMPLETED" }, { status: "COMPLETED" }];
    const r = evaluateExperiment({ tasks, physics: { collisions: 1, obstacleIntrusions: 0, boundaryViolations: 0 }, endReason: "ALL_TASKS_COMPLETE" });
    expect(r.verdict).toBe("FAIL");
    const ok = evaluateExperiment({ tasks, physics: { collisions: 0, obstacleIntrusions: 0, boundaryViolations: 0 }, endReason: "ALL_TASKS_COMPLETE" });
    expect(ok.verdict).toBe("PASS");
  });

  test("a finished run is archived with its identity, own metrics and verdict", async () => {
    clearRunHistory();
    await startRun("decentralized", 3, "S01", 300);
    await run(200);
    expect(simLifecycle.getState()).toBe("FINISHED");
    const rec = getArchivedRuns()[0];
    expect(rec.systemMode).toBe("decentralized");
    expect(rec.scenarioCode).toBe("S01");
    expect(rec.fleetSize).toBe(3);
    expect(rec.seed).not.toBe(null);
    expect(rec.mapProfile).toBe(WORLD_PROFILES[3].id);
    expect(rec.architectureMetrics.system).toBe("decentralized");
    expect(["PASS", "FAIL"]).toContain(rec.verdict);
    expect(state.get("simTestResult")).toBe(rec.verdict === "PASS" ? "PASSED" : "FAILED");
    // Active task count on the dashboard comes from the task registry.
    expect(state.get("kpis").activeTasks).toBe(decentralizedFleet.taskRegistry.getActiveTasks().length);
  });

  test("run time limit respects the ~1.5 minute dashboard budget", async () => {
    await startRun("centralized", 10, "S01");
    expect(state.get("simActiveConfig").durationSeconds).toBeLessThanOrEqual(90 * (state.get("simSpeed") || 1));
  });
});
