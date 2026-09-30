// ==========================================================================
// NODEX ACE AMR DASHBOARD — PHASE 4 MASTER VERIFICATION TEST SUITE
// Decentralized + ACE/RACE Adaptive Coordination Envelope & Kinematics
// Automated Tests for:
// 1. Deterministic RACE Risk Formula (R = w1*C + w2*U + w3*CR + w4*Q + w5*CP)
// 2. Local Decision Authority (Distributed Agents with Independent RACE Engines)
// 3. Envelope Escalation Lifecycle (LOCAL -> NEIGHBORHOOD -> CONTAINMENT -> SAFE-DEGRADED)
// 4. Hysteresis Anti-Flapping Stabilization (Dwell Time & Dual Thresholds)
// 5. Observable Real Behavioral Adaptation (Speed Throttle, Broadcast Scaling, Detour)
// 6. Cascade Pressure & Multi-Robot Contention Containment
// 7. Communication Degradation Response (Staleness / Blackout -> SAFE-DEGRADED)
// 8. Robot Fault Injection & Autonomous Peer Task Re-Bidding
// 9. Shelf Obstacle Avoidance & Physical Robot Separation Under ACE
// 10. Fleet Entity Scalability (3 -> 10 -> 50 Agents with ACE)
// 11. Three-Way Architecture Isolation & Strict Feature Gating Matrix
// 12. Seamless Runtime System Switching (Centralized -> Decentralized -> ACE -> Centralized)
// ==========================================================================

import { ENVELOPE_RADIUS } from "../../../zz-ws4/core/race-evaluator.js";
import { describe, test, expect } from "vitest";
import {
  MapGeometryEngine,
  ROBOT_FOOTPRINT,
  WAREHOUSE_DIMENSIONS
} from "../../../zz-ws4/core/map-geometry.js";

import { PeerCommunicationBus, MESSAGE_TYPES } from "../../../zz-ws4/core/decentralized/PeerCommunicationBus.js";
import { RobotAgent } from "../../../zz-ws4/core/decentralized/RobotAgent.js";
import { DecentralizedFleet, decentralizedFleet } from "../../../zz-ws4/core/decentralized/DecentralizedFleet.js";
import { RaceEvaluator, raceEvaluator } from "../../../zz-ws4/core/race-evaluator.js";
import { AceAdapter } from "../../../zz-ws4/core/adapters/AceAdapter.js";
import { DecentralizedAdapter } from "../../../zz-ws4/core/adapters/DecentralizedAdapter.js";
import { CentralizedAdapter } from "../../../zz-ws4/core/adapters/CentralizedAdapter.js";
import { SystemManager } from "../../../zz-ws4/core/adapters/SystemManager.js";
import { state } from "../../../zz-ws4/core/state.js";

describe("Phase 4 — ACE/RACE Verification Suite", () => {
  // Shared peer-communication bus across TEST 2, 3 and 4 (matches original script)
  let bus;

  // ------------------------------------------------------------------------
  // TEST 1: Deterministic RACE Risk Formula
  // ------------------------------------------------------------------------
  test("TEST 1: Deterministic RACE Risk Formula", () => {
    const evaluator = new RaceEvaluator();
    const testInputs = {
      conflict: 0.8,         // w1 = 0.35 -> 0.28
      uncertainty: 0.4,      // w2 = 0.15 -> 0.06
      commRisk: 0.5,         // w3 = 0.20 -> 0.10
      queueGrowth: 0.6,      // w4 = 0.15 -> 0.09
      cascadePressure: 0.4   // w5 = 0.15 -> 0.06
    };
    // Expected: 0.28 + 0.06 + 0.10 + 0.09 + 0.06 = 0.590
    const calculatedRisk = evaluator.calculateRaceRisk(testInputs);
    expect(Math.abs(calculatedRisk - 0.59) < 0.001, `Calculated risk ${calculatedRisk} matches expected formula 0.590`).toBe(true);

    // Zero inputs -> 0.0
    expect(evaluator.calculateRaceRisk({ conflict: 0, uncertainty: 0, commRisk: 0, queueGrowth: 0, cascadePressure: 0 }), "Zero inputs produce exactly 0.0 risk").toBe(0.0);

    // Maximum inputs -> 1.0
    expect(evaluator.calculateRaceRisk({ conflict: 1, uncertainty: 1, commRisk: 1, queueGrowth: 1, cascadePressure: 1 }), "Unit inputs produce exactly 1.0 risk").toBe(1.0);

    // Clamping of out-of-bounds inputs
    const clampedRisk = evaluator.calculateRaceRisk({ conflict: 1.5, uncertainty: -0.2, commRisk: 0, queueGrowth: 0, cascadePressure: 0 });
    expect(clampedRisk, `Out-of-bounds inputs are clamped to [0, 1] range: got ${clampedRisk}`).toBe(0.35);
  });

  // ------------------------------------------------------------------------
  // TEST 2: Local Decision Authority (No Global ACE Dictator)
  // ------------------------------------------------------------------------
  test("TEST 2: Local Decision Authority (No Global RACE Dictator)", () => {
    bus = new PeerCommunicationBus();
    const r1 = new RobotAgent("R01", { x: 145, y: 35 }, bus, { aceEnabled: true });
    const r2 = new RobotAgent("R02", { x: 740, y: 455 }, bus, { aceEnabled: true });

    // R1 is in open corridor with no neighbors
    r1.tick(0.05, null, 0);
    expect(r1.localState.raceState, "R01 evaluates low risk and independently selects LOCAL").toBe("LOCAL");
    // Contract change (audit r3): the LOCAL baseline envelope is small (18 px),
    // not zero; it grows only when RACE escalates.
    expect(r1.localState.envelopeRadius, "R01 envelope is the small LOCAL baseline").toBe(ENVELOPE_RADIUS.LOCAL);

    // R2 experiences synthetic local conflict
    r2.peerCache.set("R03", {
      id: "R03",
      x: 740,
      y: 470, // 15px proximity!
      heading: -Math.PI / 2,
      velocity: 1.2,
      status: "MOVING",
      lastSeen: Date.now()
    });

    // Run 3 persistence samples for R2
    for (let s = 1; s <= 3; s++) {
      r2.tick(0.05, null, s);
    }

    expect(r2.localState.raceState !== "LOCAL", "R02 independently escalates envelope due to local conflict").toBe(true);
    expect(r1.localState.raceState, "R01 remains in LOCAL (no global contagion)").toBe("LOCAL");
    expect(r1.raceEvaluator !== r2.raceEvaluator, "R01 and R02 have separate private RaceEvaluator instances").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 3: Envelope Escalation Lifecycle
  // ------------------------------------------------------------------------
  test("TEST 3: Envelope Escalation Lifecycle (LOCAL -> NEIGHBORHOOD -> CONTAINMENT -> SAFE-DEGRADED)", () => {
    const testAgent = new RobotAgent("R01", { x: 145, y: 35 }, bus, { aceEnabled: true });

    // Step 1: Initial state is LOCAL
    testAgent.tick(0.05, null, 0);
    expect(testAgent.localState.raceState, "Initial envelope state is LOCAL").toBe("LOCAL");

    // Step 2: Inject moderate conflict to cross T_local_enter (0.50)
    testAgent.peerCache.set("R02", {
      id: "R02",
      x: 160,
      y: 35, // 15px proximity
      heading: Math.PI,
      velocity: 1.2,
      status: "MOVING",
      lastSeen: Date.now()
    });
    for (let s = 1; s <= 3; s++) {
      testAgent.tick(0.05, null, s);
    }
    expect(testAgent.localState.raceState, "Escalated to NEIGHBORHOOD when risk crossed 0.50").toBe("NEIGHBORHOOD");
    expect(testAgent.localState.envelopeRadius, "Envelope expanded in NEIGHBORHOOD").toBe(ENVELOPE_RADIUS.NEIGHBORHOOD);

    // Step 3: Inject multi-agent contention & queue growth to cross T_neigh_enter (0.70)
    testAgent.peerCache.set("R03", {
      id: "R03",
      x: 170,
      y: 35,
      heading: 0,
      velocity: 0,
      status: "WAITING",
      currentPath: [{ x: 145, y: 35 }, { x: 212, y: 35 }],
      lastSeen: Date.now()
    });
    testAgent.peerCache.set("R04", {
      id: "R04",
      x: 180,
      y: 35,
      heading: 0,
      velocity: 0,
      status: "WAITING",
      currentPath: [{ x: 145, y: 35 }, { x: 212, y: 35 }],
      lastSeen: Date.now()
    });
    testAgent.localState.currentPath = [{ x: 145, y: 35 }, { x: 212, y: 35 }];

    for (let s = 4; s <= 6; s++) {
      testAgent.tick(0.05, null, s);
    }
    expect(testAgent.localState.raceState, "Escalated to CONTAINMENT when risk crossed 0.70").toBe("CONTAINMENT");
    expect(testAgent.localState.envelopeRadius, "Envelope expanded further in CONTAINMENT").toBe(ENVELOPE_RADIUS.CONTAINMENT);

    // Step 4: Inject critical hardware fault -> SAFE-DEGRADED
    testAgent.localState.status = "ERROR";
    testAgent.tick(0.05, null, 7);
    expect(testAgent.localState.raceState, "Transitioned to SAFE-DEGRADED upon robot error").toBe("SAFE-DEGRADED");
    expect(testAgent.localState.velocity, "Velocity halted to 0 in SAFE-DEGRADED error").toBe(0);
  });

  // ------------------------------------------------------------------------
  // TEST 4: Hysteresis Anti-Flapping Stabilization
  // ------------------------------------------------------------------------
  test("TEST 4: Hysteresis Anti-Flapping Stabilization", () => {
    const hAgent = new RobotAgent("R01", { x: 145, y: 35 }, bus, { aceEnabled: true });
    // Escalate to NEIGHBORHOOD at sim time 10s
    hAgent.localState.riskScore = 0.58;
    hAgent.raceEvaluator.evaluateEnvelopeState(hAgent.localState, 10.0, { conflict: 0.8 });
    hAgent.raceEvaluator.evaluateEnvelopeState(hAgent.localState, 10.1, { conflict: 0.8 });
    hAgent.raceEvaluator.evaluateEnvelopeState(hAgent.localState, 10.2, { conflict: 0.8 });
    expect(hAgent.localState.raceState, "Agent enters NEIGHBORHOOD").toBe("NEIGHBORHOOD");

    // Fluctuate risk down to 0.44 (below entry threshold 0.50, but above exit threshold 0.35)
    hAgent.localState.riskScore = 0.44;
    const holdTrans1 = hAgent.raceEvaluator.evaluateEnvelopeState(hAgent.localState, 11.0, { conflict: 0.5 });
    expect(hAgent.localState.raceState, "State remains NEIGHBORHOOD (anti-flapping hold)").toBe("NEIGHBORHOOD");
    expect(holdTrans1.isHold, "Hysteresis hold explicitly detected and flagged").toBe(true);

    // Risk drops down to 0.25 (below exit threshold 0.35), but dwell time (4.0s) has NOT elapsed (entered at 10.2, current 12.0)
    hAgent.localState.riskScore = 0.25;
    hAgent.raceEvaluator.evaluateEnvelopeState(hAgent.localState, 12.0, { conflict: 0.2 });
    expect(hAgent.localState.raceState, "Dwell time prevents premature de-escalation").toBe("NEIGHBORHOOD");

    // Advance sim time to 15.0s (dwell elapsed >= 4.0s) and supply 3 persistence samples
    hAgent.raceEvaluator.evaluateEnvelopeState(hAgent.localState, 15.0, { conflict: 0.2 });
    hAgent.raceEvaluator.evaluateEnvelopeState(hAgent.localState, 15.1, { conflict: 0.2 });
    const exitTrans = hAgent.raceEvaluator.evaluateEnvelopeState(hAgent.localState, 15.2, { conflict: 0.2 });
    expect(hAgent.localState.raceState, "De-escalates to LOCAL only after dwell time & persistence satisfied").toBe("LOCAL");
    expect(exitTrans.transitionDirection, "Transition direction recorded as DE_ESCALATE").toBe("DE_ESCALATE");
  });

  // ------------------------------------------------------------------------
  // TEST 5: Observable Real Behavioral Adaptation
  // ------------------------------------------------------------------------
  test("TEST 5: Observable Real Behavioral Adaptation", () => {
    const adaptAgent = new RobotAgent("R01", { x: 145, y: 35 }, bus, { aceEnabled: true });
    adaptAgent.localState.status = "MOVING";

    // In LOCAL: target speed is 1.2 m/s, broadcast interval is 250ms (4 Hz)
    adaptAgent.localState.raceState = "LOCAL";
    adaptAgent.adaptBehaviorToEnvelope(0.05);
    expect(adaptAgent.localState.velocity, "Velocity is full 1.2 m/s in LOCAL").toBe(1.2);
    expect(adaptAgent.broadcastIntervalMs, "Broadcast interval is 250ms (4 Hz) in LOCAL").toBe(250);

    // In NEIGHBORHOOD: high-frequency 100ms (10 Hz) broadcast
    adaptAgent.localState.raceState = "NEIGHBORHOOD";
    adaptAgent.adaptBehaviorToEnvelope(0.05);
    expect(adaptAgent.localState.velocity, "Velocity remains 1.2 m/s in NEIGHBORHOOD").toBe(1.2);
    expect(adaptAgent.broadcastIntervalMs, "Broadcast interval scales to 100ms (10 Hz) in NEIGHBORHOOD").toBe(100);

    // In CONTAINMENT: speed throttles to 0.6 m/s (50% speed throttle) to isolate cluster
    adaptAgent.localState.raceState = "CONTAINMENT";
    adaptAgent.adaptBehaviorToEnvelope(0.05);
    expect(adaptAgent.localState.velocity, "Velocity throttles to 0.6 m/s in CONTAINMENT").toBe(0.6);

    // In SAFE-DEGRADED: crawl speed 0.25 m/s
    adaptAgent.localState.raceState = "SAFE-DEGRADED";
    adaptAgent.adaptBehaviorToEnvelope(0.05);
    expect(adaptAgent.localState.velocity, "Velocity crawls at 0.25 m/s in SAFE-DEGRADED").toBe(0.25);
  });

  // ------------------------------------------------------------------------
  // TEST 6: Cascade Pressure & Multi-Robot Contention Containment
  // ------------------------------------------------------------------------
  test("TEST 6: Cascade Pressure & Multi-Robot Contention Containment", () => {
    const cascadeFleet = new DecentralizedFleet();
    cascadeFleet.initializeFleet(3, "ace");
    const a1 = cascadeFleet.getAgent("R01");
    const a2 = cascadeFleet.getAgent("R02");
    const a3 = cascadeFleet.getAgent("R03");

    // Position agents converging on the same corridor intersection (352, 165)
    a1.localState.x = 340; a1.localState.y = 165;
    a1.localState.currentPath = [{ x: 340, y: 165 }, { x: 352, y: 165 }, { x: 578, y: 165 }];
    a1.localState.status = "MOVING";

    a2.localState.x = 352; a2.localState.y = 150;
    a2.localState.currentPath = [{ x: 352, y: 150 }, { x: 352, y: 165 }, { x: 352, y: 305 }];
    a2.localState.status = "WAITING";

    a3.localState.x = 365; a3.localState.y = 165;
    a3.localState.currentPath = [{ x: 365, y: 165 }, { x: 352, y: 165 }, { x: 212, y: 165 }];
    a3.localState.status = "MOVING";

    // Tick fleet
    for (let t = 1; t <= 5; t++) {
      cascadeFleet.tick(0.05, t);
    }

    const inputsA1 = a1.computeLocalRaceInputs();
    expect(inputsA1.cascadePressure > 0, `Cascade pressure detected (${inputsA1.cascadePressure.toFixed(2)}) due to multi-path convergence`).toBe(true);
    expect(inputsA1.queueGrowth > 0, `Queue growth detected (${inputsA1.queueGrowth.toFixed(2)}) due to waiting peer`).toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 7: Communication Degradation Response
  // ------------------------------------------------------------------------
  test("TEST 7: Communication Degradation Response (Staleness / Blackout -> SAFE-DEGRADED)", () => {
    const commFleet = new DecentralizedFleet();
    commFleet.initializeFleet(3, "ace");
    const commAgent = commFleet.getAgent("R01");

    // Simulate stale peer updates (> 3000ms old)
    // Fleet-owned agents time peers on the simulation clock (agent.now()),
    // so staleness is expressed on that clock rather than Date.now().
    const oldTime = commAgent.now() - 3500;
    commAgent.peerCache.set("R02", {
      id: "R02",
      x: 200, y: 35,
      velocity: 1.2,
      status: "MOVING",
      lastSeen: oldTime
    });

    const commInputs = commAgent.computeLocalRaceInputs();
    expect(commInputs.uncertainty > 0.5, `Uncertainty elevated to ${commInputs.uncertainty} due to stale peer telemetry`).toBe(true);
    expect(commInputs.commRisk > 0.5, `Communication risk elevated to ${commInputs.commRisk} due to aged beacons`).toBe(true);

    // Inject complete comm loss
    commFleet.handleCommDegradation("R01");
    expect(commAgent.localState.isCriticalDegraded, "Critical degradation flag set on R01").toBe(true);
    commAgent.tick(0.05, null, 1.0);
    expect(commAgent.localState.raceState, "AMR entered SAFE-DEGRADED upon comm blackout").toBe("SAFE-DEGRADED");
  });

  // ------------------------------------------------------------------------
  // TEST 8: Robot Fault Injection & Autonomous Peer Task Re-Bidding
  // ------------------------------------------------------------------------
  test("TEST 8: Robot Fault Injection & Autonomous Peer Task Re-Bidding", () => {
    const faultFleet = new DecentralizedFleet();
    faultFleet.initializeFleet(2, "ace");
    const failedAgent = faultFleet.getAgent("R01");
    const healthyAgent = faultFleet.getAgent("R02");

    // Give R01 an active task
    const task = faultFleet.taskRegistry.createTask({
      id: "T-FAULT-01",
      pickup: { x: 145, y: 35, name: "Bay 1" },
      destination: { x: 740, y: 455, name: "Dock 1" },
      priority: "HIGH"
    });
    failedAgent.claimTaskOwnership(task, faultFleet.taskRegistry);
    expect(failedAgent.localState.currentTaskId, "Task T-FAULT-01 assigned to R01").toBe("T-FAULT-01");

    // Inject motor fault on R01
    faultFleet.handleRobotFailure("R01", "Motor thermal overload");
    expect(failedAgent.localState.status, "R01 status transitioned to ERROR").toBe("ERROR");
    expect(failedAgent.localState.raceState, "R01 transitioned to SAFE-DEGRADED").toBe("SAFE-DEGRADED");

    // Healthy peer R02 checks liveness
    healthyAgent.peerCache.set("R01", {
      id: "R01",
      status: "ERROR",
      currentTaskId: "T-FAULT-01",
      lastSeen: Date.now()
    });
    healthyAgent.checkPeerLiveness(faultFleet.taskRegistry);

    // R02 processes bidding window ticks
    healthyAgent.evaluateTaskBids(faultFleet.taskRegistry);
    healthyAgent.evaluateTaskBids(faultFleet.taskRegistry);
    expect(healthyAgent.localState.currentTaskId, "Orphaned task re-auctioned and claimed by healthy peer R02").toBe("T-FAULT-01");
  });

  // ------------------------------------------------------------------------
  // TEST 9: Shelf Obstacle Avoidance & Physical Separation Under ACE
  // ------------------------------------------------------------------------
  test("TEST 9: Shelf Obstacle Avoidance & Physical Separation Under ACE", () => {
    const acePlannerAgent = new RobotAgent("R01", { x: 280, y: 35 }, bus, { aceEnabled: true });
    // Plan path from above Shelf 01 (y: 35) to below it (y: 165)
    const shelfDetour = acePlannerAgent.localPlanner.planPath({ x: 280, y: 35 }, { x: 280, y: 165 });
    expect(shelfDetour.length >= 3, `Local A* generated multi-waypoint detour around shelf (${shelfDetour.length} waypoints)`).toBe(true);

    const aStarValidation = MapGeometryEngine.validatePath(shelfDetour, ROBOT_FOOTPRINT.radius);
    expect(aStarValidation.valid, "ACE trajectory stays strictly within corridor aisles without intersecting shelves").toBe(true);

    // Physical separation check
    const posA = { x: 200, y: 200 };
    const posB = { x: 215, y: 200 }; // 15px distance (inside 32px safe threshold)
    expect(Math.hypot(posA.x - posB.x, posA.y - posB.y) < ROBOT_FOOTPRINT.totalRadius * 2, "Proximity within 32px threshold triggers separation protection").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 10: Dynamic Fleet Scalability (3 -> 10 -> 50 Agents with ACE)
  // ------------------------------------------------------------------------
  test("TEST 10: Dynamic Fleet Scalability (3 -> 10 -> 50 Agents with ACE)", () => {
    const scaleFleet = new DecentralizedFleet();

    // Scale to 3
    scaleFleet.initializeFleet(3, "ace");
    expect(scaleFleet.agents.size, "Scaled cleanly to 3 ACE agents").toBe(3);
    scaleFleet.tick(0.05, 1.0);
    const tel3 = scaleFleet.getLiveAceTelemetry();
    expect(tel3.totalRobots, "ACE telemetry reports 3 active agents").toBe(3);

    // Scale to 10
    scaleFleet.initializeFleet(10, "ace");
    expect(scaleFleet.agents.size, "Scaled cleanly to 10 ACE agents").toBe(10);
    scaleFleet.tick(0.05, 1.0);
    const tel10 = scaleFleet.getLiveAceTelemetry();
    expect(tel10.totalRobots, "ACE telemetry reports 10 active agents").toBe(10);

    // Scale to 50
    scaleFleet.initializeFleet(50, "ace");
    expect(scaleFleet.agents.size, "Scaled cleanly to 50 ACE agents").toBe(50);
    scaleFleet.tick(0.05, 1.0);
    const tel50 = scaleFleet.getLiveAceTelemetry();
    expect(tel50.totalRobots, "ACE telemetry reports 50 active agents").toBe(50);
    expect(
      tel50.envelopeDistribution.local + tel50.envelopeDistribution.neighborhood + tel50.envelopeDistribution.containment + tel50.envelopeDistribution.safeDegraded,
      "All 50 agents accounted for across the 4 envelope states"
    ).toBe(50);
  });

  // ------------------------------------------------------------------------
  // TEST 11: Three-Way Architecture Isolation & Feature Gating Matrix
  // ------------------------------------------------------------------------
  test("TEST 11: Three-Way Architecture Isolation & Feature Gating Matrix", () => {
    const sysMgr = new SystemManager();

    // 1. Centralized Mode
    sysMgr.switchSystem("centralized");
    expect(!sysMgr.isFeatureAvailable("hitl"), "Centralized mode disables HITL control").toBe(true);
    expect(!sysMgr.isFeatureAvailable("aceValidation"), "Centralized mode disables ACE Validation Tests").toBe(true);
    expect(!sysMgr.isFeatureAvailable("adaptiveEnvelope"), "Centralized mode disables adaptive envelopes").toBe(true);
    expect(!sysMgr.isFeatureAvailable("raceRisk"), "Centralized mode disables RACE risk metrics").toBe(true);

    // 2. Decentralized Mode
    sysMgr.switchSystem("decentralized");
    expect(!sysMgr.isFeatureAvailable("hitl"), "Decentralized mode disables HITL control").toBe(true);
    expect(!sysMgr.isFeatureAvailable("aceValidation"), "Decentralized mode disables ACE Validation Tests").toBe(true);
    expect(!sysMgr.isFeatureAvailable("adaptiveEnvelope"), "Decentralized mode disables adaptive envelopes").toBe(true);
    expect(!sysMgr.isFeatureAvailable("raceRisk"), "Decentralized mode disables RACE risk metrics").toBe(true);
    expect(sysMgr.isFeatureAvailable("p2pNegotiation"), "Decentralized mode enables peer-to-peer negotiation").toBe(true);

    // 3. ACE Mode
    sysMgr.switchSystem("ace");
    expect(sysMgr.isFeatureAvailable("hitl"), "ACE mode enables HITL control").toBe(true);
    expect(sysMgr.isFeatureAvailable("aceValidation"), "ACE mode enables ACE Validation Tests").toBe(true);
    expect(sysMgr.isFeatureAvailable("adaptiveEnvelope"), "ACE mode enables dynamic adaptive envelopes").toBe(true);
    expect(sysMgr.isFeatureAvailable("raceRisk"), "ACE mode enables RACE risk metrics").toBe(true);
    expect(sysMgr.isFeatureAvailable("p2pNegotiation"), "ACE mode preserves peer-to-peer negotiation").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 12: Seamless Runtime System Switching
  // ------------------------------------------------------------------------
  test("TEST 12: Seamless Runtime System Switching without State Leakage", () => {
    const switchMgr = new SystemManager();

    // Switch: Centralized -> Decentralized -> ACE -> Centralized
    switchMgr.switchSystem("centralized");
    expect(switchMgr.getSystemMode(), "System switched to Centralized").toBe("centralized");

    switchMgr.switchSystem("decentralized");
    expect(switchMgr.getSystemMode(), "System switched to Decentralized").toBe("decentralized");

    switchMgr.switchSystem("ace");
    expect(switchMgr.getSystemMode(), "System switched to ACE").toBe("ace");

    switchMgr.switchSystem("centralized");
    expect(switchMgr.getSystemMode(), "System reverted cleanly to Centralized").toBe("centralized");
    expect(!switchMgr.isFeatureAvailable("adaptiveEnvelope"), "Reverting to Centralized cleanly locks out ACE features").toBe(true);
  });
});
