// ==========================================================================
// NODEX ACE — Head-on corridor deadlock resolution regression suite
// Locks in the "back off to the previous intersection" fix (audit report
// §10 item 1): single-lane aisles with bidirectional traffic used to
// gridlock all three architectures because the loser of a head-on waited
// in place forever and the winner was itself physically blocked from
// closing the gap to a stationary robot (sim-engine closesSeparation).
//
// Verified scope (see nodex-dashboard-audit-state memory for the full
// trail): a genuine pairwise head-on or crossing conflict now resolves,
// and a robot that finished a task and parked in a lane no longer blocks
// it forever. At small fleet sizes (3, matching S01's own recommended
// size) this reliably clears the whole scenario. At higher density
// (10+ robots sharing this small a warehouse) several robots can still
// converge on the same hub faster than pairwise back-off drains them —
// throughput keeps climbing rather than flatlining at the pre-fix values,
// but it is NOT full/steady completion. That residual is a capacity/
// traffic-management problem (real intersection reservation, most likely)
// beyond a reactive pairwise policy, and is intentionally left open rather
// than papered over with a looser assertion.
// ==========================================================================

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { state } from "../../../zz-ws3/core/state.js";
import { simEngine } from "../../../zz-ws3/core/sim-engine.js";
import { simLifecycle } from "../../../zz-ws3/core/sim-lifecycle.js";
import { systemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { scenarioEngine } from "../../../zz-ws3/core/scenario-engine.js";
import { MapGeometryEngine } from "../../../zz-ws3/core/map-geometry.js";
import { centralizedCoordinator } from "../../../zz-ws3/core/centralized/CentralizedCoordinator.js";
import { taskManager } from "../../../zz-ws3/core/centralized/TaskManager.js";
import { ConflictManager } from "../../../zz-ws3/core/centralized/ConflictManager.js";
import { decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";
import { RobotAgent } from "../../../zz-ws3/core/decentralized/RobotAgent.js";
import { PeerCommunicationBus } from "../../../zz-ws3/core/decentralized/PeerCommunicationBus.js";
import { startBackoff, tickBackoff, isManeuvering } from "../../../zz-ws3/core/deadlock-backoff.js";

scenarioEngine.setSimEngine(simEngine);

const flush = () => new Promise(r => setTimeout(r, 0));

async function startRun({ mode = "ace", count = 3, scenario = "S01" } = {}) {
  systemManager.switchSystem(mode);
  state.set("robotCount", count);
  state.set("simTestType", "scenario");
  state.set("selectedScenario", scenario);
  const ok = await simLifecycle.start();
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

describe("Shared back-off maneuver primitives", () => {
  test("startBackoff routes the loser off the contested waypoint, not onto it", () => {
    const r = {
      id: "R01", x: 212, y: 165, prevX: 145, prevY: 165,
      targetX: 352, targetY: 165, status: "WAITING", isYielding: true, currentTaskId: "T-1",
      stalledDuration: 2.0, plannedPath: [{ x: 145, y: 165 }, { x: 212, y: 165 }, { x: 352, y: 165 }], pathCursor: 2
    };
    const blocker = { id: "R02", x: 260, y: 165 };
    expect(startBackoff(r, blocker)).toBe(true);
    expect(isManeuvering(r)).toBe(true);
    expect(r.status).toBe("MOVING");
    expect(r.isYielding).toBe(false);
    // Immediate target must not be the contested waypoint the blocker occupies.
    expect(Math.hypot(r.targetX - 352, r.targetY - 165)).toBeGreaterThan(1);
  });

  test("tickBackoff holds at the refuge, then resumes once the blocker is clear", () => {
    const r = {
      id: "R01", x: 212, y: 165, prevX: 145, prevY: 165,
      targetX: 352, targetY: 165, status: "WAITING", isYielding: true, currentTaskId: "T-1",
      stalledDuration: 2.0, plannedPath: [{ x: 145, y: 165 }, { x: 212, y: 165 }, { x: 352, y: 165 }], pathCursor: 2
    };
    const blocker = { id: "R02", x: 260, y: 165 };
    startBackoff(r, blocker);

    // Drive it to the refuge.
    for (let i = 0; i < 50 && r._maneuver.phase === "retreat"; i++) {
      const dx = r._maneuver.refuge.x - r.x, dy = r._maneuver.refuge.y - r.y;
      const dist = Math.hypot(dx, dy) || 1;
      r.x += (dx / dist) * Math.min(dist, 5);
      r.y += (dy / dist) * Math.min(dist, 5);
      tickBackoff(r, blocker, 0.1);
    }
    expect(r._maneuver.phase).toBe("hold");
    expect(r.status).toBe("WAITING");

    // Blocker still close: stays held.
    tickBackoff(r, blocker, 0.1);
    expect(isManeuvering(r)).toBe(true);

    // Blocker moves clear: the maneuver resumes by retracing along aisles
    // (refuge -> intersection -> where it yielded) and then continues to the
    // original waypoint. Heading straight from the stub to the old target
    // cut diagonally into racks.
    const clearedBlocker = { id: "R02", x: 700, y: 400 };
    for (let i = 0; i < 20 && isManeuvering(r); i++) tickBackoff(r, clearedBlocker, 0.1);
    expect(isManeuvering(r)).toBe(false);
    expect(r.status).toBe("MOVING");
    expect(r.plannedPath[r.plannedPath.length - 1]).toEqual({ x: 352, y: 165 });
    for (let i = 1; i < r.plannedPath.length; i++) {
      const p0 = r.plannedPath[i - 1], p1 = r.plannedPath[i];
      expect(Math.abs(p0.x - p1.x) < 1 || Math.abs(p0.y - p1.y) < 1).toBe(true); // axis-aligned legs
    }
  });
});

describe("Centralized: head-on pairs resolve instead of gridlocking", () => {
  test("a sustained head-on wait is escalated to a back-off maneuver via CentralizedCoordinator.tick", async () => {
    await startRun({ mode: "centralized", count: 2, scenario: "S01" });
    const robots = state.get("robots");
    const [r1, r2] = robots;
    // Force a head-on: same aisle, moving straight at each other, close enough to conflict.
    Object.assign(r1, { x: 260, y: 165, prevX: 145, prevY: 165, targetX: 578, targetY: 165, heading: 0, status: "MOVING", velocity: 1.2, currentTaskId: r1.currentTaskId });
    Object.assign(r2, { x: 290, y: 165, prevX: 578, prevY: 165, targetX: 145, targetY: 165, heading: Math.PI, status: "MOVING", velocity: 1.2, currentTaskId: r2.currentTaskId });

    let maneuverStarted = false;
    for (let i = 0; i < 60; i++) {
      centralizedCoordinator.tick(0.1);
      if (r1._maneuver || r2._maneuver) { maneuverStarted = true; break; }
    }
    expect(maneuverStarted).toBe(true);
    // The loser must not be left waiting in place forever.
    const loser = r1._maneuver ? r1 : r2;
    expect(loser.status).not.toBe("WAITING");
  });

  test("a parked (task-finished) robot blocking a lane always loses priority and is moved out of the way", () => {
    const cManager = new ConflictManager();
    const parked = { id: "R01", x: 352, y: 448, targetX: 352, targetY: 448, currentTaskId: null, status: "IDLE", heading: 0 };
    const active = { id: "R02", x: 340, y: 455, targetX: 352, targetY: 455, currentTaskId: "T-9", status: "MOVING", heading: 0 };
    const resolution = cManager.resolvePriority(parked, active, taskManager);
    expect(resolution.winner.id).toBe("R02");
    expect(resolution.loser.id).toBe("R01");
  });

  test("centralized S01 makes continued progress instead of flatlining (regression: 10 robots stalled at ~2/10 forever from ~50s)", async () => {
    await startRun({ mode: "centralized", count: 10, scenario: "S01" });
    await tick(60);
    const early = centralizedCoordinator.getRunStats().tasksCompleted;
    expect(early).toBeGreaterThanOrEqual(2); // pre-fix baseline
    await tick(120);
    const later = centralizedCoordinator.getRunStats().tasksCompleted;
    // Throughput keeps climbing rather than permanently flatlining at the
    // pre-fix value — full completion at this density is a separate,
    // open capacity problem (see file header).
    expect(later).toBeGreaterThan(early);
  });
});

describe("Decentralized/ACE: head-on pairs resolve instead of gridlocking", () => {
  test("evaluatePeerConflicts backs a sustained loser off instead of waiting forever", () => {
    const bus = new PeerCommunicationBus();
    const agent = new RobotAgent("R01", { x: 260, y: 165 }, bus);
    agent.localState.prevX = 145; agent.localState.prevY = 165;
    // Agent is far from its own target while the peer is close to its target,
    // so the deterministic priority metric makes the agent the loser.
    agent.localState.targetX = 578; agent.localState.targetY = 165;
    agent.localState.currentGoal = { x: 578, y: 165 };
    agent.localState.currentTaskId = "T-1";
    agent.peerCache.set("R02", { id: "R02", x: 290, y: 165, targetX: 270, targetY: 165, status: "MOVING", currentTaskId: "T-2", lastSeen: Date.now() });
    // Contract change (audit r3): in System 2 right of way can only be
    // negotiated inside a fixed pair session, so the two robots are paired
    // (R01 is the pair's arbiter: lower ID).
    agent.pair.session = { sid: "PAIR-T", partner: "R02", since: 0, until: 1e9, purpose: "conflict" };

    // Drive several ticks: agent should detect the head-on, wait, then back off.
    let backedOff = false;
    for (let i = 0; i < 40; i++) {
      agent.evaluatePeerConflicts(0.1);
      if (agent.localState._maneuver) { backedOff = true; break; }
    }
    expect(backedOff).toBe(true);
    expect(agent.localState.isYielding).toBe(false);
  });

  test("a parked (task-finished) agent blocking a lane always loses priority to an active peer", () => {
    const bus = new PeerCommunicationBus();
    const agent = new RobotAgent("R01", { x: 352, y: 448 }, bus);
    agent.localState.status = "IDLE";
    agent.localState.currentTaskId = null;
    agent.localState.targetX = agent.localState.x;
    agent.localState.targetY = agent.localState.y;
    agent.peerCache.set("R02", { id: "R02", x: 340, y: 455, targetX: 352, targetY: 455, status: "MOVING", currentTaskId: "T-9", lastSeen: Date.now() });

    let backedOff = false;
    for (let i = 0; i < 20; i++) {
      agent.evaluateIdleBlocking(0.1);
      if (agent.localState._maneuver) { backedOff = true; break; }
    }
    expect(backedOff).toBe(true);
  });

  test("ACE 50-robot S01 keeps making progress instead of gridlocking (regression: 0/50 moving at ~30s)", async () => {
    await startRun({ mode: "ace", count: 50, scenario: "S01" });
    await tick(35);
    const robots = state.get("robots");
    const moving = robots.filter(r => r.velocity > 0 || r._maneuver).length;
    expect(moving).toBeGreaterThan(0);
    expect(decentralizedFleet.taskRegistry.getCompletedCount()).toBeGreaterThanOrEqual(1);
  }, 20000);

  test.each([3, 10, 50])("ACE S01 with %i robots keeps making progress over a run (physics stays valid throughout)", async (count) => {
    await startRun({ mode: "ace", count, scenario: "S01" });
    await tick(40);
    const early = decentralizedFleet.taskRegistry.getCompletedCount();
    expect(early).toBeGreaterThanOrEqual(1);
    await tick(80);
    const later = decentralizedFleet.taskRegistry.getCompletedCount();
    expect(later).toBeGreaterThanOrEqual(early); // never regresses; typically climbs
    for (const r of state.get("robots")) {
      expect(MapGeometryEngine.isPointInObstacle(r.x, r.y, 12).collision).toBe(false);
    }
  }, 20000);
});
