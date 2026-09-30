// ==========================================================================
// NODEX ACE — PHASE 5 COMPLETE SYSTEM INTEGRATION & VALIDATION TEST RUNNER
// Validates common simulation contract, zero state leakage, identical initial
// conditions, experiment runner, comparison engine, and data honesty.
// ==========================================================================

import { PAIR_SCOPE_RADIUS } from "../../../zz-ws4/core/decentralized/FixedPairCoordinator.js";
import { describe, test, expect } from "vitest";
import { state } from "../../../zz-ws4/core/state.js";
import { simEngine } from "../../../zz-ws4/core/sim-engine.js";
import { systemManager } from "../../../zz-ws4/core/adapters/SystemManager.js";
import { isCapabilitySupported, getCapabilityUnavailableReason } from "../../../zz-ws4/core/capabilities.js";
import { experimentRunner, ExperimentRunner } from "../../../zz-ws4/core/experiment-runner.js";
import { raceEvaluator, RaceEvaluator } from "../../../zz-ws4/core/race-evaluator.js";
import { centralizedCoordinator } from "../../../zz-ws4/core/centralized/CentralizedCoordinator.js";
import { decentralizedFleet } from "../../../zz-ws4/core/decentralized/DecentralizedFleet.js";
import { MapGeometryEngine } from "../../../zz-ws4/core/map-geometry.js";
import { BenchmarkReportService } from "../../../zz-ws4/data/benchmark-runs.js";

describe("Phase 5 — Integration & Comparison Suite", () => {
  // ========================================================================
  // TEST SUITE 1: Common Simulation Contract (Section 6 Interface)
  // ========================================================================
  test("simEngine.initialize sets authoritative state", () => {
    simEngine.initialize({
      robotCount: 3,
      systemMode: "ace",
      scenarioId: "S08"
    });

    expect(state.get("robotCount")).toBe(3);
    expect(state.get("systemMode")).toBe("ace");
    expect(state.get("selectedScenario")).toBe("S08");
    expect(simEngine.getSimulationTime()).toBe(0);
  });

  test("simEngine.getEnvironmentState returns authoritative geometry", () => {
    const env = simEngine.getEnvironmentState();
    expect(env.worldWidth > 0 && env.worldHeight > 0).toBe(true);
    expect(Array.isArray(env.shelves) && env.shelves.length > 0).toBe(true);
    expect(env.drivingAisles && (Array.isArray(env.drivingAisles) || Array.isArray(env.drivingAisles.horizontal))).toBeTruthy();
  });

  test("simEngine.step advances simulation time deterministically", () => {
    const t0 = simEngine.getSimulationTime();
    simEngine.step(0.5);
    const t1 = simEngine.getSimulationTime();
    expect(t1 > t0, `Simulation time did not advance: ${t0} -> ${t1}`).toBe(true);
  });

  test("simEngine.getRobotState returns authoritative robot record", () => {
    const r = simEngine.getRobotState("R01");
    expect(r !== null, "R01 not found").toBe(true);
    expect(r.id).toBe("R01");
    expect(typeof r.x === "number" && typeof r.y === "number").toBe(true);
  });

  test("simEngine.updateRobot modifies authoritative robot state", () => {
    simEngine.updateRobot("R01", { targetVelocity: 0.75 });
    const r = simEngine.getRobotState("R01");
    expect(r.targetVelocity).toBe(0.75);
  });

  test("simEngine.reset resets clock and state cleanly", () => {
    simEngine.reset();
    expect(simEngine.getSimulationTime()).toBe(0);
    expect(simEngine.getEvents().length).toBe(0);
  });

  // ========================================================================
  // TEST SUITE 2: Strict Three-Way System Isolation & Zero State Leakage
  // ========================================================================
  test("Transitioning to Centralized purges ACE envelope and risk state", () => {
    // 1. Arm ACE mode with an active envelope on R01
    systemManager.switchSystem("ace");
    simEngine.initFleet(3);
    simEngine.updateRobot("R01", {
      raceState: "CONTAINMENT",
      riskScore: 0.82,
      envelopeRadius: 75,
      coordinationScope: "CONTAINMENT"
    });
    expect(simEngine.getRobotState("R01").raceState).toBe("CONTAINMENT");

    // 2. Transition from ACE to Centralized
    systemManager.switchSystem("centralized");

    const r = simEngine.getRobotState("R01");
    // Contract change (audit r3): Centralized carries no RACE state (null),
    // not a "LOCAL" ACE label.
    expect(r.raceState, `raceState was not cleared: ${r.raceState}`).toBe(null);
    expect(r.riskScore, `riskScore was not cleared: ${r.riskScore}`).toBe(null);
    expect(r.envelopeRadius, `envelopeRadius was not zeroed: ${r.envelopeRadius}`).toBe(0);
    expect(r.coordinationScope, `coordinationScope was not reset: ${r.coordinationScope}`).toBe("Central server");
    expect(r.riskComponents, "riskComponents was not cleared").toBe(null);
  });

  test("Centralized mode disarms HITL state", () => {
    expect(state.get("hitlEnabled")).toBe(false);
    expect(state.get("hitlMode")).toBe("OFF");
  });

  test("Decentralized mode has no ACE state; only the small fixed pair scope", () => {
    // 3. Transition to Decentralized
    systemManager.switchSystem("decentralized");

    simEngine.step(0.1);
    const r = simEngine.getRobotState("R01");
    // Contract change (audit r3): System 2 shows its small FIXED coordination
    // scope (PAIR_SCOPE_RADIUS) and carries no RACE/ACE state at all.
    expect(r.envelopeRadius, `Decentralized scope must be the fixed pair radius`).toBe(PAIR_SCOPE_RADIUS);
    expect(r.raceState, "Decentralized mode leaked raceState").toBe(null);
    expect(r.riskScore, "Decentralized mode leaked riskScore").toBe(null);
    expect(r.riskComponents, "Decentralized mode leaked risk inputs").toBe(null);
  });

  test("Transitioning back to ACE enables dynamic envelope capability", () => {
    // 4. Transition back to ACE
    systemManager.switchSystem("ace");

    expect(systemManager.getSystemMode()).toBe("ace");
    expect(isCapabilitySupported("ace", "adaptiveEnvelope")).toBe(true);
    expect(isCapabilitySupported("ace", "hitl")).toBe(true);
  });

  // ========================================================================
  // TEST SUITE 3: Identical Initial Conditions Across All 3 Architectures
  // ========================================================================
  let cPos, dPos, aPos;

  test("Identical Initial Conditions: capture positions across all 3 architectures", () => {
    simEngine.initialize({ robotCount: 3, systemMode: "centralized", scenarioId: "S08" });
    cPos = state.get("robots").map(r => ({ id: r.id, x: r.x, y: r.y }));

    simEngine.initialize({ robotCount: 3, systemMode: "decentralized", scenarioId: "S08" });
    dPos = state.get("robots").map(r => ({ id: r.id, x: r.x, y: r.y }));

    simEngine.initialize({ robotCount: 3, systemMode: "ace", scenarioId: "S08" });
    aPos = state.get("robots").map(r => ({ id: r.id, x: r.x, y: r.y }));

    expect(cPos.length).toBe(3);
  });

  test("Initial robot positions are identical between Centralized and Decentralized", () => {
    for (let i = 0; i < 3; i++) {
      expect(cPos[i].x).toBe(dPos[i].x);
      expect(cPos[i].y).toBe(dPos[i].y);
    }
  });

  test("Initial robot positions are identical between Decentralized and ACE", () => {
    for (let i = 0; i < 3; i++) {
      expect(dPos[i].x).toBe(aPos[i].x);
      expect(dPos[i].y).toBe(aPos[i].y);
    }
  });

  // ========================================================================
  // TEST SUITE 4: Real Experiment Execution via ExperimentRunner
  // ========================================================================
  const trialConfig = {
    scenarioId: "S08",
    robotCount: 3,
    durationSeconds: 3,
    dt: 0.1
  };

  test("Centralized trial produces real measured metrics", () => {
    const cTrial = experimentRunner.runTrial("centralized", trialConfig);
    expect(cTrial.systemMode).toBe("centralized");
    expect(cTrial.status).toBe("COMPLETED");
    // completionTime = time until all trial tasks were done, or null if the
    // 3 s window ended first (it previously just echoed the trial duration).
    expect(cTrial.metrics.completionTime === null || typeof cTrial.metrics.completionTime === "number").toBe(true);
    expect(cTrial.metrics.trialDurationSeconds).toBe(3);
    expect(typeof cTrial.metrics.averageWaitTimeSeconds === "number").toBe(true);
    expect(cTrial.metrics.shelfViolations).toBe(0);
    expect(cTrial.aceMetrics).toBe(null);
  });

  test("Decentralized trial produces real measured metrics without ACE fields", () => {
    const dTrial = experimentRunner.runTrial("decentralized", trialConfig);
    expect(dTrial.systemMode).toBe("decentralized");
    expect(dTrial.status).toBe("COMPLETED");
    expect(typeof dTrial.metrics.messagesCount === "number").toBe(true);
    expect(dTrial.aceMetrics).toBe(null);
  });

  test("ACE trial produces real measured metrics including ACE telemetry", () => {
    const aTrial = experimentRunner.runTrial("ace", trialConfig);
    expect(aTrial.systemMode).toBe("ace");
    expect(aTrial.status).toBe("COMPLETED");
    expect(aTrial.aceMetrics !== null, "ACE metrics missing from trial").toBe(true);
    expect(typeof aTrial.aceMetrics.raceEvaluationsCount === "number").toBe(true);
    expect(aTrial.aceMetrics.raceEvaluationsCount > 0).toBe(true);
    expect(typeof aTrial.aceMetrics.localDurationSec === "number").toBe(true);
  });

  // ========================================================================
  // TEST SUITE 5: Comparison Engine & Mathematical Improvement Formulation
  // ========================================================================
  test("Improvement formula correctly calculates lower-is-better metric", () => {
    // Baseline = 10s wait, New = 6s wait -> (10 - 6)/10 * 100 = 40% improvement
    const imp = ExperimentRunner.calculateImprovement(10, 6, true);
    expect(imp).toBe(40.0);
  });

  test("Improvement formula correctly calculates higher-is-better metric", () => {
    // Baseline = 100 throughput, New = 125 throughput -> (125 - 100)/100 * 100 = 25% improvement
    const imp = ExperimentRunner.calculateImprovement(100, 125, false);
    expect(imp).toBe(25.0);
  });

  test("runComparison produces valid 3-system comparison report", () => {
    const comparisonReport = experimentRunner.runComparison({
      scenarioId: "S08",
      robotCount: 3,
      durationSeconds: 3
    });

    expect(comparisonReport.scenarioId).toBe("S08");
    expect(comparisonReport.rawMetrics.centralized).toBeTruthy();
    expect(comparisonReport.rawMetrics.decentralized).toBeTruthy();
    expect(comparisonReport.rawMetrics.ace).toBeTruthy();
    expect(comparisonReport.comparativeImprovements.aceVsCentralized).toBeTruthy();
    expect(comparisonReport.comparativeImprovements.aceVsDecentralized).toBeTruthy();
    expect(comparisonReport.comparativeImprovements.decentralizedVsCentralized).toBeTruthy();
  });

  // ========================================================================
  // TEST SUITE 6: RACE Risk Deterministic Formula & Clamping
  // ========================================================================
  test("Deterministic RACE formula matches exact theoretical calculation (0.530)", () => {
    const raceEval = new RaceEvaluator();
    const sampleInputs = {
      conflict: 0.8,
      uncertainty: 0.4,
      commRisk: 0.2,
      queueGrowth: 0.6,
      cascadePressure: 0.4
    };
    // Expected: 0.35(0.8) + 0.15(0.4) + 0.20(0.2) + 0.15(0.6) + 0.15(0.4) = 0.28 + 0.06 + 0.04 + 0.09 + 0.06 = 0.530
    const computedRisk = raceEval.calculateRisk(sampleInputs);
    expect(computedRisk).toBe(0.53);
  });

  test("RACE formula clamps out-of-bounds inputs to [0, 1]", () => {
    const raceEval = new RaceEvaluator();
    const clampedRisk = raceEval.calculateRisk({ conflict: 1.5, uncertainty: -0.5, commRisk: 0, queueGrowth: 0, cascadePressure: 0 });
    expect(clampedRisk).toBe(0.35); // 0.35 * 1.0 = 0.35
  });

  // ========================================================================
  // TEST SUITE 7: Hysteresis Acceptance Test (Anti-Flapping Validation)
  // ========================================================================
  test("Hysteresis prevents rapid envelope state flapping under fluctuating risk", () => {
    const hEval = new RaceEvaluator();
    let transitionsCount = 0;
    let hysteresisHolds = 0;

    const hRobot = {
      id: "R-HYST-TEST",
      status: "MOVING",
      health: 100,
      velocity: 1.2,
      raceState: "LOCAL",
      riskScore: 0.1
    };

    // Step 1: Initial state is LOCAL at t = 0
    let res = hEval.evaluateEnvelopeState(hRobot, 0.0, { conflict: 0.1 });
    expect(hRobot.raceState).toBe("LOCAL");

    // Step 2: Risk rises to 0.58 at t = 1.0 (requires 3 samples for persistence)
    hRobot.riskScore = 0.58;
    hEval.evaluateEnvelopeState(hRobot, 1.0, { conflict: 0.8 });
    hEval.evaluateEnvelopeState(hRobot, 1.1, { conflict: 0.8 });
    res = hEval.evaluateEnvelopeState(hRobot, 1.2, { conflict: 0.8 });
    expect(hRobot.raceState).toBe("NEIGHBORHOOD");
    if (res.transitionDirection === "ESCALATE") transitionsCount++;

    // Step 3: Risk fluctuates down to 0.44 (below entry 0.50, but above exit 0.35)
    hRobot.riskScore = 0.44;
    res = hEval.evaluateEnvelopeState(hRobot, 2.0, { conflict: 0.5 });
    expect(hRobot.raceState).toBe("NEIGHBORHOOD");
    if (res.isHold) hysteresisHolds++;

    // Step 4: Risk drops down to 0.25 (below exit threshold 0.35), but dwell time (4.0s) has NOT elapsed
    hRobot.riskScore = 0.25;
    res = hEval.evaluateEnvelopeState(hRobot, 3.0, { conflict: 0.2 });
    expect(hRobot.raceState).toBe("NEIGHBORHOOD");
    if (res.isHold) hysteresisHolds++;

    // Step 5: Advance sim time to 6.0s (dwell elapsed >= 4.0s) and supply 3 persistence samples
    hEval.evaluateEnvelopeState(hRobot, 6.0, { conflict: 0.2 });
    hEval.evaluateEnvelopeState(hRobot, 6.1, { conflict: 0.2 });
    res = hEval.evaluateEnvelopeState(hRobot, 6.2, { conflict: 0.2 });
    expect(hRobot.raceState).toBe("LOCAL");
    if (res.transitionDirection === "DE_ESCALATE") transitionsCount++;

    expect(transitionsCount, "Escalated once and de-escalated once cleanly").toBe(2);
    expect(hysteresisHolds >= 2, `Hysteresis hold was not applied: ${hysteresisHolds}`).toBe(true);
  });

  // ========================================================================
  // TEST SUITE 8: Adaptive Communication & Proportional Coordination
  // ========================================================================
  test("Communication rate scales proportionally with risk (4 Hz LOCAL -> 10 Hz NEIGHBORHOOD)", () => {
    const agent01 = decentralizedFleet.getAgent("R01");
    expect(agent01, "R01 agent must exist in decentralizedFleet").toBeTruthy();
    if (!agent01) return;

    agent01.localState.raceState = "LOCAL";
    agent01.adaptBehaviorToEnvelope(0.05);
    expect(agent01.broadcastIntervalMs).toBe(250);

    agent01.localState.raceState = "NEIGHBORHOOD";
    agent01.adaptBehaviorToEnvelope(0.05);
    expect(agent01.broadcastIntervalMs).toBe(100);
  });

  // ========================================================================
  // TEST SUITE 9: Containment & Safe-Degraded Validation
  // ========================================================================
  test("Speed throttles realistically in CONTAINMENT (0.6 m/s) and SAFE-DEGRADED (0.25 m/s)", () => {
    const agent01 = decentralizedFleet.getAgent("R01");
    expect(agent01, "R01 agent must exist in decentralizedFleet").toBeTruthy();
    if (!agent01) return;

    agent01.localState.status = "MOVING";
    agent01.localState.raceState = "CONTAINMENT";
    agent01.adaptBehaviorToEnvelope(0.05);
    expect(agent01.localState.velocity).toBe(0.6);

    agent01.localState.raceState = "SAFE-DEGRADED";
    agent01.adaptBehaviorToEnvelope(0.05);
    expect(agent01.localState.velocity).toBe(0.25);
  });

  // ========================================================================
  // TEST SUITE 10: Shelf Obstacle Avoidance & Physical Separation
  // ========================================================================
  test("Path that cuts through shelf obstacle is rejected as INVALID", () => {
    // Trajectory that cuts through Shelf UA
    const invalidPath = [{ x: 280, y: 35 }, { x: 280, y: 165 }];
    const pathValidation = MapGeometryEngine.validatePath(invalidPath);
    expect(pathValidation.valid).toBe(false);
  });

  test("Corridor trajectory is validated as SAFE", () => {
    // Legal corridor trajectory
    const validPath = [{ x: 212, y: 35 }, { x: 212, y: 165 }];
    const validCheck = MapGeometryEngine.validatePath(validPath);
    expect(validCheck.valid).toBe(true);
  });

  // ========================================================================
  // TEST SUITE 11: Single Capability Registry & Strict Feature Gating
  // ========================================================================
  test("Centralized mode gates off HITL and ACE validation", () => {
    expect(isCapabilitySupported("centralized", "hitl")).toBe(false);
    expect(isCapabilitySupported("centralized", "aceValidation")).toBe(false);
    expect(isCapabilitySupported("centralized", "adaptiveEnvelope")).toBe(false);
    expect(isCapabilitySupported("centralized", "centralizedDispatch")).toBe(true);
  });

  test("Decentralized mode gates off ACE features while enabling P2P negotiation", () => {
    expect(isCapabilitySupported("decentralized", "hitl")).toBe(false);
    expect(isCapabilitySupported("decentralized", "raceRisk")).toBe(false);
    expect(isCapabilitySupported("decentralized", "peerNegotiation")).toBe(true);
  });

  test("ACE mode enables full innovative capability set", () => {
    expect(isCapabilitySupported("ace", "hitl")).toBe(true);
    expect(isCapabilitySupported("ace", "raceRisk")).toBe(true);
    expect(isCapabilitySupported("ace", "adaptiveEnvelope")).toBe(true);
    expect(isCapabilitySupported("ace", "peerNegotiation")).toBe(true);
  });

  test("getCapabilityUnavailableReason provides descriptive explanation", () => {
    const reason = getCapabilityUnavailableReason("centralized", "hitl");
    expect(reason.includes("Centralized mode")).toBe(true);
  });

  // ========================================================================
  // TEST SUITE 12: Data Lineage & Telemetry Honesty
  // ========================================================================
  test("BenchmarkReportService provides real or honest awaiting status", () => {
    const metrics = BenchmarkReportService.getMetricsForScenario("S08");
    expect(metrics !== null).toBe(true);
    expect(Array.isArray(metrics.metrics)).toBe(true);
    expect(metrics.metrics.length > 0).toBe(true);
  });
});
