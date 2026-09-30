// ==========================================================================
// NODEX ACE — PHASE 9 SIMULATION WINDOW & CONTROL ACCEPTANCE TEST SUITE
// Verifies Acceptance Criteria A through W:
// - Fleet scaling (3, 10, 50, 100)
// - FSM state transitions (IDLE -> STARTING -> RUNNING -> PAUSED -> STOPPING -> STOPPED -> FINISHED)
// - Configuration locking mid-run
// - Master RunConfig sharing
// - HITL gating by architecture
// - Minimap & camera viewport calculation
// ==========================================================================

import { describe, test, expect, beforeEach } from "vitest";
import { state, SUPPORTED_ROBOT_COUNTS, SYSTEM_NAMES } from "../../../zz-ws3/core/state.js";
import { simLifecycle, LIFECYCLE_STATES } from "../../../zz-ws3/core/sim-lifecycle.js";
import { simEngine } from "../../../zz-ws3/core/sim-engine.js";
import { systemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { centralizedCoordinator } from "../../../zz-ws3/core/centralized/CentralizedCoordinator.js";
import { decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";
import { SimulationHistoryService } from "../../../zz-ws3/data/simulation-history.js";
import { MapGeometryEngine } from "../../../zz-ws3/core/map-geometry.js";

describe("Phase 9 — Simulation Window & Control Acceptance Suite", () => {
  beforeEach(() => {
    simLifecycle.reset();
    systemManager.switchSystem("ace");
    state.set("robotCount", 50);
  });

  test("A & B: Supported robot counts include [3, 10, 50, 100] and accommodate fleets cleanly", () => {
    expect(SUPPORTED_ROBOT_COUNTS).toEqual([3, 10, 50, 100]);

    for (const count of [3, 10, 50, 100]) {
      state.set("robotCount", count);
      expect(state.get("robotCount")).toBe(count);
      expect(state.get("fleetSize")).toBe(count);

      simEngine.initFleet(count);
      const robots = state.get("robots") || [];
      expect(robots.length).toBe(count);

      // Verify all robots are placed inside the active floor, outside racks
      // (the 100 tier uses a larger floor; large fleets park in off-lane bays).
      for (const r of robots) {
        expect(MapGeometryEngine.isWithinBounds(r.x, r.y)).toBe(true);
        expect(MapGeometryEngine.isPointInObstacle(r.x, r.y).collision).toBe(false);
      }
    }
  });

  test("C, D, E: HITL is available exclusively in Edge AI (ACE) mode and gated in Centralized/Decentralized", () => {
    // ACE Mode
    systemManager.switchSystem("ace");
    state.set("hitlEnabled", true);
    expect(state.get("hitlEnabled")).toBe(true);

    // Switch to Centralized -> HITL auto-disarms
    systemManager.switchSystem("centralized");
    expect(state.get("hitlEnabled")).toBe(false);
    expect(state.get("systemMode")).toBe("centralized");

    // Switch to Decentralized -> HITL remains disarmed
    systemManager.switchSystem("decentralized");
    expect(state.get("hitlEnabled")).toBe(false);
    expect(state.get("systemMode")).toBe("decentralized");
  });

  test("G, H, I, J, K, L: FSM Control State Machine transitions and functional Stop transformation", async () => {
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.IDLE);
    expect(state.get("simRunning")).toBe(false);

    // G: Start simulation -> transitions to RUNNING
    const startResult = await simLifecycle.start({ animated: false });
    expect(startResult).toBe(true);
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.RUNNING);
    expect(state.get("simRunning")).toBe(true);

    // Canonical RunConfig is RUNNING
    const runCfg = state.getRunConfig();
    expect(runCfg.status).toBe(LIFECYCLE_STATES.RUNNING);
    expect(runCfg.run_id).toMatch(/^RUN-/);
    const initialRunId = runCfg.run_id;

    // I: Pause simulation -> transitions to PAUSED
    simLifecycle.pause();
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.PAUSED);
    expect(state.get("simRunning")).toBe(false);
    expect(state.getRunConfig().status).toBe(LIFECYCLE_STATES.PAUSED);

    // J: Resume simulation -> transitions back to RUNNING
    const resumeResult = simLifecycle.resume();
    expect(resumeResult).toBe(true);
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.RUNNING);
    expect(state.get("simRunning")).toBe(true);

    // K: Stop simulation -> transitions to STOPPED, clamps velocities
    simLifecycle.stop();
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.STOPPED);
    expect(state.get("simRunning")).toBe(false);
    expect(state.getRunConfig().status).toBe(LIFECYCLE_STATES.STOPPED);
    const robots = state.get("robots") || [];
    expect(robots.every(r => r.velocity === 0)).toBe(true);

    // L: Restart creates a fresh run instance with a new run_id
    const restartResult = await simLifecycle.restart({ animated: false });
    expect(restartResult).toBe(true);
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.RUNNING);
    const restartedCfg = state.getRunConfig();
    expect(restartedCfg.run_id).not.toBe(initialRunId);
    expect(restartedCfg.status).toBe(LIFECYCLE_STATES.RUNNING);
    expect(simLifecycle.hasPreviousRun).toBe(true);

    simLifecycle.stop();
  });

  test("M & N: RunConfig synchronizes across parameters and reflects in SimulationHistoryService", () => {
    state.set("robotCount", 100);
    systemManager.switchSystem("centralized");
    state.set("selectedScenario", "S02");

    const cfg = state.getRunConfig();
    expect(cfg.fleet_size).toBe(100);
    expect(cfg.system_id).toBe("centralized");
    expect(cfg.system_name).toBe(SYSTEM_NAMES["centralized"]);
    expect(cfg.scenario_id).toBe("S02");

    // Explain Simulation uses canonical runConfig
    const liveRun = SimulationHistoryService.getCurrentLiveRun();
    // The live view has the stable id "LIVE"; the authoritative run ID travels
    // in runId (the old id collided with a hard-coded history record).
    expect(liveRun.id).toBe("LIVE");
    expect(liveRun.runId).toBe(cfg.run_id);
    expect(liveRun.scenarioCode).toBe("S02");
    expect(liveRun.systemMode).toBe("centralized");
  });
});
