// ==========================================================================
// NODEX ACE — Simulation Lifecycle & HITL Verification Suite
// Verifies 7-state lifecycle state machine and 3-scope arbitrated HITL control
// ==========================================================================

import { describe, test, expect, beforeEach } from "vitest";
import { state } from "../../../zz-ws3/core/state.js";
import { simEngine } from "../../../zz-ws3/core/sim-engine.js";
import { simLifecycle, LIFECYCLE_STATES } from "../../../zz-ws3/core/sim-lifecycle.js";
import { hitlController, HITL_SCOPES, HITL_ACTIONS } from "../../../zz-ws3/core/hitl-controller.js";
import { systemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";

describe("Simulation Lifecycle State Machine & Subsystems", () => {
  beforeEach(() => {
    systemManager.switchSystem("ace");
    simLifecycle.reset();
  });

  test("Initializes to IDLE after reset", () => {
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.IDLE);
    expect(state.get("simLifecycleState")).toBe(LIFECYCLE_STATES.IDLE);
    expect(state.get("simRunning")).toBe(false);
  });

  test("Runs 8-subsystem diagnostics successfully", async () => {
    const res = await simLifecycle.runDiagnostics(false);
    expect(res.success).toBe(true);
    expect(res.diagnostics.length).toBe(8);
    expect(res.diagnostics.every(d => d.status === "PASS")).toBe(true);
  });

  test("Starts simulation through INITIALIZING -> RUNNING", async () => {
    const started = await simLifecycle.start({ animated: false });
    expect(started).toBe(true);
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.RUNNING);
    expect(state.get("simRunning")).toBe(true);
  });

  test("Pauses and resumes simulation loop", async () => {
    await simLifecycle.start({ animated: false });
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.RUNNING);

    simLifecycle.pause();
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.PAUSED);
    expect(state.get("simRunning")).toBe(false);

    simLifecycle.resume();
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.RUNNING);
    expect(state.get("simRunning")).toBe(true);
  });

  test("Stops simulation and halts all robot velocities", async () => {
    await simLifecycle.start({ animated: false });
    simLifecycle.stop();
    expect(simLifecycle.getState()).toBe(LIFECYCLE_STATES.STOPPED);
    expect(state.get("simRunning")).toBe(false);

    const robots = state.get("robots") || [];
    expect(robots.every(r => r.velocity === 0 && r.status === "STOPPED")).toBe(true);
  });
});

describe("Human-in-the-Loop (HITL) Controller & Audit Trail", () => {
  beforeEach(() => {
    systemManager.switchSystem("ace");
    decentralizedFleet.initializeFleet(3, "ace");
    hitlController.clearAuditLog();
    state.set("hitlEnabled", true); // commands require an armed console
  });

  test("Disarmed HITL rejects interventions but still allows RESUME", () => {
    state.set("hitlEnabled", false);
    const hold = hitlController.dispatchCommand({ scope: "ENTIRE_FLEET", action: "hold" });
    expect(hold.success).toBe(false);
    expect(hold.error).toMatch(/disarmed/);
    const resume = hitlController.dispatchCommand({ scope: "ENTIRE_FLEET", action: "resume" });
    expect(resume.success).toBe(true);
  });

  test("Dispatches ENTIRE_FLEET hold motion command", () => {
    const res = hitlController.dispatchCommand({
      scope: HITL_SCOPES.ENTIRE_FLEET,
      action: "hold",
      reason: "Obstacle blocking central crossing"
    });

    expect(res.success).toBe(true);
    const robots = state.get("robots") || [];
    expect(robots.every(r => r.velocity === 0 && r.isYielding === true)).toBe(true);

    const log = hitlController.getAuditLog();
    expect(log.length).toBe(1);
    expect(log[0].action).toBe("HOLD");
    expect(log[0].scope).toBe("ENTIRE_FLEET");
  });

  test("Dispatches ROBOT_GROUP safe stop command", () => {
    const res = hitlController.dispatchCommand({
      scope: HITL_SCOPES.ROBOT_GROUP,
      targets: ["R01", "R02"],
      action: "safe_stop",
      reason: "Group emergency isolation"
    });

    expect(res.success).toBe(true);
    const robots = state.get("robots") || [];
    const r1 = robots.find(r => r.id === "R01");
    const r2 = robots.find(r => r.id === "R02");
    const r3 = robots.find(r => r.id === "R03");

    expect(r1.velocity).toBe(0);
    expect(r1.status).toBe("error");
    expect(r2.velocity).toBe(0);
    expect(r2.status).toBe("error");
    // R03 was not in group
    expect(r3.status).not.toBe("error");
  });

  test("Dispatches INDIVIDUAL_ROBOT speed limit command", () => {
    const res = hitlController.dispatchCommand({
      scope: HITL_SCOPES.INDIVIDUAL_ROBOT,
      targets: "R03",
      action: "speed_limit",
      speedLimitVal: 0.4,
      reason: "Maintenance zone caution"
    });

    expect(res.success).toBe(true);
    const robots = state.get("robots") || [];
    const r3 = robots.find(r => r.id === "R03");
    expect(r3.targetVelocity).toBe(0.4);
  });

  test("Rejects command safely when switched away from ACE", () => {
    systemManager.switchSystem("centralized");
    const res = hitlController.dispatchCommand({
      scope: HITL_SCOPES.ENTIRE_FLEET,
      action: "hold"
    });

    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();

    const log = hitlController.getAuditLog();
    expect(log.length).toBe(1);
    expect(log[0].success).toBe(false);
  });
});
