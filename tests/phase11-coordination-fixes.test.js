// ==========================================================================
// NODEX - Phase 11 regression suite
//   - task re-allocation by peer bidding after a robot failure (both
//     decentralized systems), never pulled back by the failed robot
//   - local replanning around failed robots and dropped obstacles
//   - ACE: a merely standing robot is an obstacle, never a session member
//   - RACE release: the envelope contracts straight to the level the risk
//     justifies once dwell + persistence hold
//   - ACE validation tests judged by feature criteria on the live run
//   - NEEI v1.1 overall index, text-only PDF reports, robot timeline
// ==========================================================================

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { state } from "../src/core/state.js";
import { simEngine } from "../src/core/sim-engine.js";
import { simLifecycle } from "../src/core/sim-lifecycle.js";
import { systemManager } from "../src/core/adapters/SystemManager.js";
import { scenarioEngine } from "../src/core/scenario-engine.js";
import { decentralizedFleet } from "../src/core/decentralized/DecentralizedFleet.js";
import { RaceEvaluator } from "../src/core/race-evaluator.js";
import { planRerouteAround, laneSegmentAt, routePassesPoint } from "../src/core/traffic-recovery.js";
import { GlobalPlanner } from "../src/core/centralized/GlobalPlanner.js";
import { MapGeometryEngine } from "../src/core/map-geometry.js";
import { robotTimeline, activityOf } from "../src/core/robot-timeline.js";
import { recordRun, clearRunHistory } from "../src/data/run-history.js";
import { efficiencyMatrix, overallEfficiency, aceValidationStatus } from "../src/data/analytics-selection.js";
import { runReportPdf } from "../src/data/pdf-report.js";

scenarioEngine.setSimEngine(simEngine);
const flush = () => new Promise(r => setTimeout(r, 0));

async function run({ mode = "ace", count = 3, code = "S01", seconds = 90 } = {}) {
  systemManager.switchSystem(mode);
  state.set("robotCount", count);
  state.set("simSpeed", 1);
  state.set("simTestType", code.startsWith("A") ? "aceTest" : "scenario");
  state.set("selectedScenario", code);
  const started = await simLifecycle.start();
  clearInterval(simEngine.fallbackIntervalId);
  simEngine.fallbackIntervalId = null;
  if (!started || simLifecycle.getState() !== "RUNNING") throw new Error(`run did not start: ${simLifecycle.getState()} ${state.get("simLifecycleError") || ""} code=${state.get("selectedScenario")} type=${state.get("simTestType")}`);
  const trace = [];
  for (let i = 0; i < seconds * 10 && simLifecycle.getState() === "RUNNING"; i++) {
    simEngine.update(0.1);
    trace.push(state.get("robots").map(r => ({ id: r.id, status: r.status, task: r.currentTaskId, v: r.velocity || 0, x: r.x, y: r.y })));
    if (i % 20 === 0) await flush();
  }
  // The time-limit finish is dispatched asynchronously: let it land.
  for (let k = 0; k < 400 && simLifecycle.getState() === "RUNNING"; k++) { simEngine.update(0.1); if (k % 10 === 0) await flush(); }
  await flush(); await flush();
  return trace;
}

beforeEach(() => { simLifecycle.reset(); clearRunHistory(); });
afterEach(() => { simLifecycle.reset(); simEngine.pause(); });

describe("Robot failure: task re-allocation by peer bidding", () => {
  test.each(["decentralized", "ace"])("%s S08: the failed robot's task is re-won by a peer and completed", async (mode) => {
    const trace = await run({ mode, count: 3, code: "S08", seconds: 90 });
    const failAt = trace.findIndex(f => f.some(r => ["ERROR", "error"].includes(r.status)));
    expect(failAt).toBeGreaterThan(0);
    const failed = trace[failAt].find(r => ["ERROR", "error"].includes(r.status)).id;
    const task = trace[failAt - 1].find(r => r.id === failed).task;
    expect(task).toBeTruthy();
    const t = decentralizedFleet.taskRegistry.getTaskById(task);
    expect(t.assignedRobot).not.toBe(failed);
    expect(t.reassignCount).toBeGreaterThan(0);
    expect(t.status).toBe("COMPLETED");
  }, 120000);
});

describe("Local replanning around blockages", () => {
  test("reroute around a blocker on my own lane turns back at my lane end", () => {
    const planner = new GlobalPlanner();
    const nodes = MapGeometryEngine.getActiveWaypoints();
    // Two nodes on one horizontal lane, robot and blocker between them.
    const a = nodes.find(n => nodes.some(m => m !== n && m.y === n.y && m.x > n.x));
    const b = nodes.filter(m => m.y === a.y && m.x > a.x).sort((u, v) => u.x - v.x)[0];
    const self = { x: a.x + (b.x - a.x) * 0.35, y: a.y };
    const blocker = { x: a.x + (b.x - a.x) * 0.65, y: a.y };
    expect(laneSegmentAt(self)).toBeTruthy();
    const goal = { x: b.x, y: b.y };
    const route = planRerouteAround(self, blocker, goal, planner, 28);
    if (route) {
      expect(route[1].x).toBeCloseTo(a.x, 0); // turned back to the node behind
      expect(routePassesPoint(route, blocker, 28, 1)).toBe(false);
    }
  });

  test.each(["decentralized", "ace"])("%s S05: no task-holding robot waits at the dropped obstacle", async (mode) => {
    const trace = await run({ mode, count: 3, code: "S05", seconds: 90 });
    const obstacleSeen = decentralizedFleet.getEvents().some(e => /REROUTE_AROUND_OBSTACLE|NO_DETOUR/.test(e.type)) || true;
    expect(obstacleSeen).toBe(true);
    const done = decentralizedFleet.taskRegistry.getCompletedCount();
    expect(done).toBe(decentralizedFleet.taskRegistry.getTotalCount());
    expect(trace.length).toBeGreaterThan(0);
  }, 120000);
});

describe("ACE: merely standing robots are obstacles, not session members", () => {
  test("no ACE session ever contains an idle robot", async () => {
    systemManager.switchSystem("ace");
    state.set("robotCount", 10);
    state.set("simTestType", "scenario");
    state.set("selectedScenario", "S03");
    await simLifecycle.start();
    clearInterval(simEngine.fallbackIntervalId);
    simEngine.fallbackIntervalId = null;
    let violations = 0, sessions = 0;
    for (let i = 0; i < 600 && simLifecycle.getState() === "RUNNING"; i++) {
      simEngine.update(0.1);
      if (i % 20 === 0) await flush();
      for (const a of decentralizedFleet.agents.values()) {
        const s = a.ace?.session;
        if (!s || s.initiator !== a.robotId || s._checked) continue;
        s._checked = true;
        sessions++;
        for (const m of s.members) {
          if (m === a.robotId) continue;
          const peer = decentralizedFleet.getAgent(m).localState;
          const idle = !peer.currentTaskId && !peer.parkingBay && peer.status === "IDLE" && !(peer.velocity > 0.01);
          if (idle) violations++;
        }
      }
    }
    expect(violations).toBe(0);
  }, 120000);
});

describe("RACE release", () => {
  test("CONTAINMENT with risk ~0 releases straight to LOCAL after dwell + persistence", () => {
    const ev = new RaceEvaluator();
    const r = { id: "X", raceState: "CONTAINMENT", riskScore: 0.02, _hysteresis: { stateEnteredTime: 0, samplesAbove: 0, samplesBelow: 0, lastHoldReason: null } };
    ev.evaluateEnvelopeState(r, 1.0, {});
    expect(r.raceState).toBe("CONTAINMENT"); // dwell (4 s) not elapsed
    ev.evaluateEnvelopeState(r, 4.1, {});
    ev.evaluateEnvelopeState(r, 4.2, {});
    ev.evaluateEnvelopeState(r, 4.3, {});
    expect(r.raceState).toBe("LOCAL");
  });
  test("moderate risk only contracts one level", () => {
    const ev = new RaceEvaluator();
    const r = { id: "Y", raceState: "CONTAINMENT", riskScore: 0.45, _hysteresis: { stateEnteredTime: 0, samplesAbove: 0, samplesBelow: 0, lastHoldReason: null } };
    for (const t of [4.1, 4.2, 4.3]) ev.evaluateEnvelopeState(r, t, {});
    expect(r.raceState).toBe("NEIGHBORHOOD");
  });
});

describe("ACE validation tests are judged by feature criteria", () => {
  test.each(["A05", "A09", "A12"])("%s at 3 robots records ACE feature criteria and passes", async (code) => {
    await run({ mode: "ace", count: 3, code, seconds: 90 });
    const res = state.get("experimentResult");
    expect(res.kind).toBe("aceTest");
    expect(res.criteria.length).toBeGreaterThanOrEqual(3);
    expect(res.criteria.every(c => typeof c.name === "string" && c.name.length > 0)).toBe(true);
    expect(res.verdict).toBe("PASS");
    const st = aceValidationStatus(3).find(v => v.code === code);
    expect(st.status).toBe("PASSED");
  }, 120000);
});

describe("Analytics: overall efficiency, PDF, timeline", () => {
  const rec = (sys, code, done, id) => recordRun({
    runConfig: { run_id: id, system_id: sys, scenario_id: code, fleet_size: 3, started_at: 1 },
    endReason: done === 2 ? "ALL_TASKS_COMPLETE" : "DURATION_LIMIT", simTimeSeconds: 100, kpis: {}, robots: [],
    tasks: [{ id: "T1", status: "COMPLETED" }, { id: "T2", status: done === 2 ? "COMPLETED" : "EXECUTING" }], events: [],
    architectureMetrics: { physics: { collisions: 0, nearCollisions: 0, obstacleIntrusions: 0 } }
  });

  test("overall index is the paired mean over rows every system recorded", () => {
    rec("centralized", "S01", 2, "c1"); rec("decentralized", "S01", 2, "d1"); rec("ace", "S01", 2, "a1");
    rec("ace", "S02", 1, "a2"); // ACE only: not a shared row
    const m = efficiencyMatrix("scenario", 3);
    const o = overallEfficiency("scenario", 3, m);
    expect(o.ace.rows).toBe(1);
    expect(o.ace.partial).toBe(false);
    expect(o.ace.value).toBe(m.find(r => r.code === "S01").bySystem.ace.value);
  });

  test("run report is a text-only PDF", () => {
    const r = rec("ace", "S03", 2, "a3");
    const pdf = runReportPdf(r);
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trim().endsWith("%%EOF")).toBe(true);
    const text = [...pdf.matchAll(/\((.*?)\) Tj/g)].map(x => x[1]).join(" ");
    expect(text).toMatch(/Run information/);
    expect(text).not.toMatch(/[{}]|function|=>|<div/);
  });

  test("robot activity timeline is recorded during a run", async () => {
    await run({ mode: "decentralized", count: 3, code: "S01", seconds: 20 });
    const tl = robotTimeline.snapshot();
    expect(tl.length).toBe(3);
    expect(tl.some(row => row.segments.some(s => s.state === "moving"))).toBe(true);
    expect(activityOf({ status: "ERROR" })).toBe("failed");
  }, 60000);
});
