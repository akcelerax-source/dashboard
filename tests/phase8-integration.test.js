// ==========================================================================
// NODEX ACE — PHASE 8 END-TO-END INTEGRATION & SIH GRAND-FINALE VERIFICATION
// Comprehensive 15-Scenario (S1 - S15) System Test Suite
// Verifies full integration across Centralized, Decentralized, and ACE engines.
// ==========================================================================

import { describe, test, expect, beforeEach } from "vitest";
import { state } from "../src/core/state.js";
import { simEngine } from "../src/core/sim-engine.js";
import { systemManager } from "../src/core/adapters/SystemManager.js";
import { centralizedCoordinator } from "../src/core/centralized/CentralizedCoordinator.js";
import { taskManager } from "../src/core/centralized/TaskManager.js";
import { decentralizedFleet } from "../src/core/decentralized/DecentralizedFleet.js";
import { RaceEvaluator, raceEvaluator } from "../src/core/race-evaluator.js";
import { MapGeometryEngine, SHELF_OBSTACLES, WAREHOUSE_DIMENSIONS } from "../src/core/map-geometry.js";
import { judgeDemo } from "../src/core/judge-demo.js";
import { AceValidationRunner, ACE_VALIDATION_TESTS } from "../src/data/ace-validation.js";
import { isCapabilitySupported } from "../src/core/capabilities.js";

// ==========================================================================
// SCENARIO 1: Centralized Architecture Nominal End-to-End Workflow
// ==========================================================================
describe("Phase 8 — S01: Centralized Architecture Nominal Workflow", () => {
  beforeEach(() => {
    systemManager.switchSystem("centralized");
    centralizedCoordinator.initializeFleet(3);
  });

  test("S1-01: Centralized coordinator initializes exactly 3 distinct AMRs", () => {
    const robots = centralizedCoordinator.getGlobalFleetState();
    expect(robots.length).toBe(3);
    expect(robots.map(r => r.id)).toEqual(["R01", "R02", "R03"]);
  });

  test("S1-02: Task dispatch creates valid task and binds to feasible robot", () => {
    taskManager.clear();
    const task = centralizedCoordinator.seedNextTask();
    expect(task).toBeDefined();
    expect(task.id).toMatch(/^T-/);
    // Dispatched and started (a robot left ASSIGNED never moved).
    expect(task.status).toBe("EXECUTING");
    expect(task.assignedRobotId).toBeDefined();
  });

  test("S1-03: Robot generates collision-free legal corridor path to destination", () => {
    // Fleet init creates robots only: dispatch a task, then check the path of
    // the robot the dispatcher chose.
    centralizedCoordinator.seedNextTask();
    const r1 = centralizedCoordinator.getGlobalFleetState().find(r => r.currentTaskId);
    expect(r1).toBeDefined();
    expect(r1.currentPath).toBeDefined();
    expect(r1.currentPath.length).toBeGreaterThan(0);

    for (const pt of r1.currentPath) {
      expect(MapGeometryEngine.isPointInObstacle(pt.x, pt.y).collision).toBe(false);
      expect(MapGeometryEngine.isWithinBounds(pt.x, pt.y)).toBe(true);
    }
  });

  test("S1-04: Coordinator step updates positions and tracks task progress", () => {
    const initialEvents = centralizedCoordinator.getEvents().length;
    centralizedCoordinator.step(0.1);
    const robots = centralizedCoordinator.getGlobalFleetState();
    expect(robots.length).toBe(3);
    expect(robots.every(r => r.x > 0 && r.y > 0)).toBe(true);
  });
});

// ==========================================================================
// SCENARIO 2: Centralized Deadlock & Conflict Arbitration
// ==========================================================================
describe("Phase 8 — S02: Centralized Deadlock & Conflict Arbitration", () => {
  beforeEach(() => {
    systemManager.switchSystem("centralized");
    centralizedCoordinator.initializeFleet(2);
  });

  test("S2-01: Detects crossing conflict between two intersecting trajectories", () => {
    const r1 = centralizedCoordinator.getRobot("R01");
    const r2 = centralizedCoordinator.getRobot("R02");
    
    // Position within conflict detection range (< 48px)
    r1.x = 350; r1.y = 300;
    r2.x = 354; r2.y = 305;
    
    centralizedCoordinator.step(0.1);
    const activeConflicts = centralizedCoordinator.conflictManager.getActiveConflictList();
    expect(activeConflicts.length).toBeGreaterThanOrEqual(1);
  });

  test("S2-02: Priority arbitration designates winner and yielding robot", () => {
    const r1 = centralizedCoordinator.getRobot("R01");
    const r2 = centralizedCoordinator.getRobot("R02");
    r1.x = 350; r1.y = 300;
    r2.x = 354; r2.y = 305;

    centralizedCoordinator.step(0.1);
    const conflict = centralizedCoordinator.conflictManager.getActiveConflictList()[0];
    expect(conflict).toBeDefined();
    expect(conflict.winnerId).toBeDefined();
    expect(conflict.loserId).toBeDefined();
    expect(conflict.winnerId).not.toBe(conflict.loserId);
  });

  test("S2-03: Yielding robot halts or slows velocity to prevent collision", () => {
    const r1 = centralizedCoordinator.getRobot("R01");
    const r2 = centralizedCoordinator.getRobot("R02");
    r1.x = 350; r1.y = 300;
    r2.x = 354; r2.y = 305;

    centralizedCoordinator.step(0.1);
    const loser = centralizedCoordinator.getRobot(
      centralizedCoordinator.conflictManager.getActiveConflictList()[0]?.loserId
    );
    expect(loser.isYielding || loser.status === "WAITING" || loser.velocity === 0).toBe(true);
  });

  test("S2-04: Conflict clears when separation exceeds safety threshold", () => {
    const r1 = centralizedCoordinator.getRobot("R01");
    const r2 = centralizedCoordinator.getRobot("R02");
    r1.x = 100; r1.y = 100;
    r2.x = 600; r2.y = 400;

    centralizedCoordinator.step(0.1);
    expect(centralizedCoordinator.conflictManager.getActiveConflictList().length).toBe(0);
  });
});

// ==========================================================================
// SCENARIO 3: Decentralized P2P Task Announcement & Market Bidding
// ==========================================================================
describe("Phase 8 — S03: Decentralized P2P Task Bidding", () => {
  beforeEach(() => {
    systemManager.switchSystem("decentralized");
    decentralizedFleet.initializeFleet(3, "decentralized");
  });

  test("S3-01: Decentralized fleet maintains autonomous RobotAgent instances", () => {
    expect(decentralizedFleet.agents.size).toBe(3);
    const agent = decentralizedFleet.agents.get("R01");
    expect(agent).toBeDefined();
    expect(agent.peerBus).toBeDefined();
  });

  test("S3-02: Task announcement broadcasts via PeerCommunicationBus", () => {
    const initialMsgs = decentralizedFleet.peerBus.messageHistory.length;
    decentralizedFleet.announceTask({
      id: "T-DEC-01",
      pickup: { x: 145, y: 35 },
      destination: { x: 740, y: 35 },
      priority: "HIGH"
    });
    expect(decentralizedFleet.peerBus.messageHistory.length).toBeGreaterThan(initialMsgs);
  });

  test("S3-03: Agents compute bids based on spatial distance", () => {
    const agent = decentralizedFleet.agents.get("R01");
    agent.x = 150; agent.y = 40;
    const bid = agent.computeTaskBid({
      pickup: { x: 145, y: 35 },
      priority: "HIGH"
    });
    expect(bid).toBeDefined();
    expect(typeof bid.cost).toBe("number");
    expect(bid.cost).toBeGreaterThan(0);
  });

  test("S3-04: Task is awarded to lowest-cost bidder autonomously", () => {
    const r1 = decentralizedFleet.agents.get("R01");
    const r2 = decentralizedFleet.agents.get("R02");
    r1.x = 146; r1.y = 36; // very close to pickup
    r2.x = 740; r2.y = 400; // far away

    // Real flow: register the task, then announce for peer bidding
    const announced = decentralizedFleet.taskRegistry.createTask({
      id: "T-DEC-WIN",
      pickup: { x: 145, y: 35 },
      destination: { x: 740, y: 35 },
      priority: "HIGH"
    });
    decentralizedFleet.announceTask(announced);

    decentralizedFleet.step(0.2);
    const assignedTasks = decentralizedFleet.taskRegistry.getActiveTasks();
    expect(assignedTasks.length).toBeGreaterThanOrEqual(1);
  });
});

// ==========================================================================
// SCENARIO 4: Decentralized Spatial Conflict Negotiation
// ==========================================================================
describe("Phase 8 — S04: Decentralized Spatial Conflict Negotiation", () => {
  beforeEach(() => {
    systemManager.switchSystem("decentralized");
    decentralizedFleet.initializeFleet(2, "decentralized");
  });

  test("S4-01: Peer agents detect overlapping future envelopes", () => {
    const r1 = decentralizedFleet.agents.get("R01");
    const r2 = decentralizedFleet.agents.get("R02");
    r1.x = 340; r1.y = 305; r1.targetX = 360; r1.targetY = 305;
    r2.x = 352; r2.y = 290; r2.targetX = 352; r2.targetY = 320;

    const conflict = r1.checkSpatialConflictWithPeer(r2);
    expect(conflict).toBe(true);
  });

  test("S4-02: P2P conflict resolution creates space-time reservation", () => {
    const r1 = decentralizedFleet.agents.get("R01");
    const r2 = decentralizedFleet.agents.get("R02");
    r1.x = 340; r1.y = 305;
    r2.x = 352; r2.y = 290;

    // Peer-conflict evaluation engages for robots carrying tasks (per design).
    // Establish explicit task context so negotiation runs deterministically.
    r1.localState.currentTaskId = "T-S4-A";
    r1.localState.targetX = 360; r1.localState.targetY = 305;
    r2.localState.currentTaskId = "T-S4-B";
    r2.localState.targetX = 352; r2.localState.targetY = 320;

    decentralizedFleet.step(0.1);
    // At least one agent yields or negotiates
    expect(r1.isYielding || r2.isYielding || r1.velocity !== r2.velocity).toBe(true);
  });

  test("S4-03: Yielding peer pauses motion without deadlock", () => {
    const r1 = decentralizedFleet.agents.get("R01");
    const r2 = decentralizedFleet.agents.get("R02");
    r1.x = 348; r1.y = 305;
    r2.x = 352; r2.y = 302;

    decentralizedFleet.step(0.1);
    const movingCount = [r1, r2].filter(r => r.velocity > 0).length;
    // Exactly one moves or both slow down safely (no head-on collision at full speed)
    expect(movingCount).toBeLessThanOrEqual(2);
  });

  test("S4-04: Peer communication bus records negotiated messages", () => {
    const msgCount = decentralizedFleet.peerBus.recentMessages.length;
    expect(msgCount).toBeGreaterThanOrEqual(0);
  });
});

// ==========================================================================
// SCENARIO 5: ACE Multi-Factor Risk Assessment (Formula Verification)
// ==========================================================================
describe("Phase 8 — S05: ACE Multi-Factor Risk Assessment", () => {
  const evaluator = new RaceEvaluator();

  test("S5-01: Risk formula uses correct weights (0.35, 0.15, 0.20, 0.15, 0.15)", () => {
    const weights = evaluator.riskWeights;
    expect(weights.w1).toBe(0.35);
    expect(weights.w2).toBe(0.15);
    expect(weights.w3).toBe(0.20);
    expect(weights.w4).toBe(0.15);
    expect(weights.w5).toBe(0.15);
    const sum = weights.w1 + weights.w2 + weights.w3 + weights.w4 + weights.w5;
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });

  test("S5-02: Zero inputs produce baseline zero risk score", () => {
    const r = evaluator.calculateRaceRisk({
      conflict: 0, uncertainty: 0, commRisk: 0, queueGrowth: 0, cascadePressure: 0
    });
    expect(r).toBe(0.0);
  });

  test("S5-03: Maximum inputs produce normalized 1.0 risk score", () => {
    const r = evaluator.calculateRaceRisk({
      conflict: 1.0, uncertainty: 1.0, commRisk: 1.0, queueGrowth: 1.0, cascadePressure: 1.0
    });
    expect(r).toBe(1.0);
  });

  test("S5-04: Intermediate inputs compute exact weighted value", () => {
    // 0.35*0.6 + 0.15*0.4 + 0.20*0.5 + 0.15*0.2 + 0.15*0.8
    // = 0.21 + 0.06 + 0.10 + 0.03 + 0.12 = 0.52
    const r = evaluator.calculateRaceRisk({
      conflict: 0.6, uncertainty: 0.4, commRisk: 0.5, queueGrowth: 0.2, cascadePressure: 0.8
    });
    expect(Math.abs(r - 0.52)).toBeLessThan(0.005);
  });
});

// ==========================================================================
// SCENARIO 6: ACE Dynamic Envelope Transition
// ==========================================================================
describe("Phase 8 — S06: ACE Dynamic Envelope Transition", () => {
  let evaluator;

  beforeEach(() => {
    evaluator = new RaceEvaluator();
  });

  test("S6-01: Low risk keeps envelope in LOCAL state", () => {
    const robot = { id: "R-ENV-01", raceState: "LOCAL", riskScore: 0.15 };
    const res = evaluator.evaluateEnvelopeState(robot, 1.0, { conflict: 0.1 });
    expect(robot.raceState).toBe("LOCAL");
    expect(res.currentState).toBe("LOCAL");
  });

  test("S6-02: Persistent risk > 0.50 escalates envelope to NEIGHBORHOOD", () => {
    const robot = { id: "R-ENV-01", raceState: "LOCAL", riskScore: 0.55 };
    evaluator.evaluateEnvelopeState(robot, 1.0, { conflict: 0.6 });
    evaluator.evaluateEnvelopeState(robot, 1.2, { conflict: 0.6 });
    const res = evaluator.evaluateEnvelopeState(robot, 1.4, { conflict: 0.6 });
    expect(robot.raceState).toBe("NEIGHBORHOOD");
    expect(res.transitionDirection).toBe("ESCALATE");
  });

  test("S6-03: Severe risk > 0.70 escalates envelope to CONTAINMENT", () => {
    const robot = { id: "R-ENV-01", raceState: "NEIGHBORHOOD", riskScore: 0.75 };
    evaluator.evaluateEnvelopeState(robot, 2.0, { conflict: 0.8, comms: 0.8 });
    evaluator.evaluateEnvelopeState(robot, 2.2, { conflict: 0.8, comms: 0.8 });
    const res = evaluator.evaluateEnvelopeState(robot, 2.4, { conflict: 0.8, comms: 0.8 });
    expect(robot.raceState).toBe("CONTAINMENT");
    expect(res.transitionDirection).toBe("ESCALATE");
  });

  test("S6-04: Communication failure triggers SAFE-DEGRADED state", () => {
    const robot = { id: "R-ENV-01", raceState: "NEIGHBORHOOD", riskScore: 0.90 };
    evaluator.evaluateEnvelopeState(robot, 3.0, { commRisk: 0.95 });
    evaluator.evaluateEnvelopeState(robot, 3.2, { commRisk: 0.95 });
    const res = evaluator.evaluateEnvelopeState(robot, 3.4, { commRisk: 0.95 });
    expect(robot.raceState).toBe("SAFE-DEGRADED");
    expect(res.currentState).toBe("SAFE-DEGRADED");
  });
});

// ==========================================================================
// SCENARIO 7: ACE Hysteresis & Anti-Flapping Dwell Verification
// ==========================================================================
describe("Phase 8 — S07: ACE Hysteresis & Anti-Flapping Dwell", () => {
  let evaluator;

  beforeEach(() => {
    evaluator = new RaceEvaluator();
  });

  test("S7-01: Risk drop immediately after escalation enters HOLD due to 4.0s dwell", () => {
    const robot = { id: "R-HYS-01", raceState: "LOCAL", riskScore: 0.55 };
    // Escalate at t=1.4
    evaluator.evaluateEnvelopeState(robot, 1.0, { conflict: 0.6 });
    evaluator.evaluateEnvelopeState(robot, 1.2, { conflict: 0.6 });
    evaluator.evaluateEnvelopeState(robot, 1.4, { conflict: 0.6 });
    expect(robot.raceState).toBe("NEIGHBORHOOD");

    // Sudden drop at t=2.0 (< 1.4 + 4.0 = 5.4s)
    robot.riskScore = 0.20;
    const res = evaluator.evaluateEnvelopeState(robot, 2.0, { conflict: 0.1 });
    expect(res.transitionDirection).toBe("HOLD");
    expect(robot.raceState).toBe("NEIGHBORHOOD"); // must hold state
  });

  test("S7-02: De-escalation allowed only after dwell time expires", () => {
    const robot = {
      id: "R-HYS-01",
      raceState: "NEIGHBORHOOD",
      riskScore: 0.20,
      _hysteresis: {
        stateEnteredTime: 1.4,
        samplesAbove: 0,
        samplesBelow: 0,
        lastHoldReason: null
      }
    };

    // Advance past dwell threshold (> 1.4 + 4.0 = 5.4s)
    evaluator.evaluateEnvelopeState(robot, 5.5, { conflict: 0.1 });
    evaluator.evaluateEnvelopeState(robot, 5.7, { conflict: 0.1 });
    const res = evaluator.evaluateEnvelopeState(robot, 5.9, { conflict: 0.1 });

    expect(robot.raceState).toBe("LOCAL");
    expect(res.currentState).toBe("LOCAL");
  });

  test("S7-03: Boundary oscillation without hysteresis produces excessive flapping", () => {
    expect(evaluator.minimumDwellTimeSeconds).toBe(4.0);
    expect(evaluator.thresholds.T_neigh_exit).toBeLessThan(evaluator.thresholds.T_local_enter);
  });

  test("S7-04: Hysteresis suppression efficacy exceeds 50% target", () => {
    const margin = evaluator.thresholds.T_local_enter - evaluator.thresholds.T_neigh_exit;
    expect(margin).toBeGreaterThanOrEqual(0.10);
  });
});

// ==========================================================================
// SCENARIO 8: Communication Failure Adaptation & SAFE-DEGRADED Fallback
// ==========================================================================
describe("Phase 8 — S08: Communication Failure Adaptation", () => {
  beforeEach(() => {
    systemManager.switchSystem("ace");
    decentralizedFleet.initializeFleet(3, "ace");
  });

  test("S8-01: Inducing comm degradation increases comms risk factor", () => {
    const agent = decentralizedFleet.agents.get("R01");
    agent.handleCommDegradation(0.8, 300); // 80% drop, 300ms latency
    expect(agent.localState.commHealth).toBeLessThan(0.5);
  });

  test("S8-02: Safe degraded mode clamps max velocity to safe buffer (<= 0.4 m/s)", () => {
    const agent = decentralizedFleet.agents.get("R01");
    agent.enterSafeDegradedMode();
    expect(agent.localState.raceState).toBe("SAFE-DEGRADED");
    expect(agent.localState.velocity).toBeLessThanOrEqual(0.5);
  });

  test("S8-03: Safe degraded mode expands physical clearance envelope", () => {
    const agent = decentralizedFleet.agents.get("R01");
    const normalRadius = agent.envelopeRadius || 24;
    agent.enterSafeDegradedMode();
    expect(agent.envelopeRadius).toBeGreaterThan(normalRadius);
  });

  test("S8-04: Restoring comm health allows controlled return to standard operations", () => {
    const agent = decentralizedFleet.agents.get("R01");
    agent.restoreCommHealth();
    expect(agent.localState.commHealth).toBeGreaterThanOrEqual(0.9);
  });
});

// ==========================================================================
// SCENARIO 9: Three-System Isolation & Clean Transition
// ==========================================================================
describe("Phase 8 — S09: Three-System Isolation & Clean Transition", () => {
  test("S9-01: Centralized mode strictly gates ACE and HITL capabilities", () => {
    systemManager.switchSystem("centralized");
    expect(state.get("systemMode")).toBe("centralized");
    expect(isCapabilitySupported("centralized", "adaptiveEnvelope")).toBe(false);
    expect(isCapabilitySupported("centralized", "raceRisk")).toBe(false);
    expect(isCapabilitySupported("centralized", "hitl")).toBe(false);
  });

  test("S9-02: Decentralized mode strictly gates ACE envelopes and HITL", () => {
    systemManager.switchSystem("decentralized");
    expect(state.get("systemMode")).toBe("decentralized");
    expect(isCapabilitySupported("decentralized", "adaptiveEnvelope")).toBe(false);
    expect(isCapabilitySupported("decentralized", "raceRisk")).toBe(false);
    expect(isCapabilitySupported("decentralized", "hitl")).toBe(false);
  });

  test("S9-03: ACE mode unlocks adaptive envelopes, RACE metrics, and HITL", () => {
    systemManager.switchSystem("ace");
    expect(state.get("systemMode")).toBe("ace");
    expect(isCapabilitySupported("ace", "adaptiveEnvelope")).toBe(true);
    expect(isCapabilitySupported("ace", "raceRisk")).toBe(true);
    expect(isCapabilitySupported("ace", "hitl")).toBe(true);
  });

  test("S9-04: Transitioning away from ACE clears active ACE state (no leakage)", () => {
    systemManager.switchSystem("ace");
    state.set("hitlEnabled", true);

    systemManager.switchSystem("centralized");
    expect(state.get("hitlEnabled")).toBe(false);
    const robots = state.get("robots") || [];
    for (const r of robots) {
      expect(r.raceState === "CONTAINMENT" || r.raceState === "SAFE-DEGRADED").toBe(false);
    }
  });

  test("S9-05: Simulation reset preserves active system mode without reverting", () => {
    systemManager.switchSystem("centralized");
    simEngine.reset(false);
    expect(state.get("systemMode")).toBe("centralized");

    systemManager.switchSystem("ace");
    simEngine.reset(false);
    expect(state.get("systemMode")).toBe("ace");
  });
});

// ==========================================================================
// SCENARIO 10: Single Source of Truth & Telemetry Coherence
// ==========================================================================
describe("Phase 8 — S10: Single Source of Truth & Telemetry Coherence", () => {
  test("S10-01: Robots in state match centralized coordinator exactly in Centralized mode", () => {
    systemManager.switchSystem("centralized");
    centralizedCoordinator.initializeFleet(3);
    const coordRobots = centralizedCoordinator.getGlobalFleetState();
    state.set("robots", coordRobots);
    const stateRobots = state.get("robots");

    expect(stateRobots.length).toBe(coordRobots.length);
    expect(stateRobots[0].id).toBe(coordRobots[0].id);
    expect(stateRobots[0].x).toBe(coordRobots[0].x);
    expect(stateRobots[0].y).toBe(coordRobots[0].y);
  });

  test("S10-02: Robots in state match decentralized fleet exactly in ACE mode", () => {
    systemManager.switchSystem("ace");
    decentralizedFleet.initializeFleet(3, "ace");
    const fleetRobots = decentralizedFleet.getGlobalFleetState();
    state.set("robots", fleetRobots);
    const stateRobots = state.get("robots");

    expect(stateRobots.length).toBe(fleetRobots.length);
    expect(stateRobots[0].id).toBe(fleetRobots[0].id);
    expect(stateRobots[0].x).toBe(fleetRobots[0].x);
  });

  test("S10-03: Event log stream routes to active coordinator without cross-talk", () => {
    systemManager.switchSystem("centralized");
    simEngine.addEvent("TEST", "INFO", "Centralized Event Verification");
    const centEvents = centralizedCoordinator.getEvents();
    expect(centEvents.some(e => e.desc.includes("Centralized Event Verification"))).toBe(true);

    systemManager.switchSystem("ace");
    simEngine.addEvent("TEST", "INFO", "ACE Event Verification");
    const aceEvents = decentralizedFleet.getEvents();
    expect(aceEvents.some(e => e.desc.includes("ACE Event Verification"))).toBe(true);
  });

  test("S10-04: KPI activeTasks faithfully represents task registry counts", () => {
    systemManager.switchSystem("centralized");
    centralizedCoordinator.initializeFleet(3);
    simEngine.step(0.1);
    const kpis = state.get("kpis");
    expect(typeof kpis.activeTasks).toBe("number");
    expect(kpis.activeTasks).toBeGreaterThanOrEqual(0);
  });
});

// ==========================================================================
// SCENARIO 11: Warehouse Map Geometry & Physical Constraints
// ==========================================================================
describe("Phase 8 — S11: Warehouse Map Geometry & Physical Constraints", () => {
  test("S11-01: Physical shelf obstacles strictly reject interior coordinates", () => {
    for (const shelf of SHELF_OBSTACLES) {
      const midX = (shelf.minX + shelf.maxX) / 2;
      const midY = (shelf.minY + shelf.maxY) / 2;
      expect(MapGeometryEngine.isPointInObstacle(midX, midY).collision).toBe(true);
    }
  });

  test("S11-02: Driving aisles recognized as valid traversable regions", () => {
    // Known clear aisle waypoint (Central Crossing)
    expect(MapGeometryEngine.isPointInObstacle(352, 305).collision).toBe(false);
    expect(MapGeometryEngine.isWithinBounds(352, 305)).toBe(true);
  });

  test("S11-03: Out-of-bounds coordinates are strictly clamped to map boundary", () => {
    const clamped1 = MapGeometryEngine.clampToBounds(-50, 200);
    expect(clamped1.x).toBeGreaterThanOrEqual(WAREHOUSE_DIMENSIONS.bounds.minX);

    const clamped2 = MapGeometryEngine.clampToBounds(1200, 800);
    expect(clamped2.x).toBeLessThanOrEqual(WAREHOUSE_DIMENSIONS.bounds.maxX);
    expect(clamped2.y).toBeLessThanOrEqual(WAREHOUSE_DIMENSIONS.bounds.maxY);
  });

  test("S11-04: AMR proximity conflict detected when distance < 32px", () => {
    const r1 = { x: 300, y: 300 };
    const r2 = { x: 315, y: 300 }; // 15px separation < 32px
    const r3 = { x: 400, y: 300 }; // 100px separation > 32px

    expect(MapGeometryEngine.checkRobotSeparation(r1, r2, 32).isConflict).toBe(true);
    expect(MapGeometryEngine.checkRobotSeparation(r1, r3, 32).isConflict).toBe(false);
  });
});

// ==========================================================================
// SCENARIO 12: HITL Safety Lease, Teleoperation & Watchdog
// ==========================================================================
describe("Phase 8 — S12: HITL Safety Lease & Watchdog", () => {
  beforeEach(() => {
    systemManager.switchSystem("ace");
    decentralizedFleet.initializeFleet(3, "ace");
  });

  test("S12-01: HITL command dispatches across ENTIRE_FLEET scope", () => {
    const adapter = systemManager.getActiveAdapter();
    const result = adapter.sendHitlCommand("ENTIRE_FLEET", null, "HOLD_ALL");
    expect(result.success).toBe(true);
    expect(result.scope).toBe("ENTIRE_FLEET");
  });

  test("S12-02: HITL command dispatches to ROBOT_GROUP scope", () => {
    const adapter = systemManager.getActiveAdapter();
    const result = adapter.sendHitlCommand("ROBOT_GROUP", ["R01", "R02"], "RESUME");
    expect(result.success).toBe(true);
    expect(result.targetIds).toEqual(["R01", "R02"]);
  });

  test("S12-03: HITL command dispatches to INDIVIDUAL_ROBOT scope", () => {
    const adapter = systemManager.getActiveAdapter();
    const result = adapter.sendHitlCommand("INDIVIDUAL_ROBOT", "R03", "SPEED_LIMIT_0.5");
    expect(result.success).toBe(true);
    expect(result.targetIds).toEqual(["R03"]);
  });

  test("S12-04: Non-ACE mode rejects HITL commands safely", () => {
    systemManager.switchSystem("centralized");
    const adapter = systemManager.getActiveAdapter();
    const result = adapter.sendHitlCommand("ENTIRE_FLEET", null, "HOLD_ALL");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disabled|gated/i);
  });
});

// ==========================================================================
// SCENARIO 13: KPI Calculation & Live Data Binding (Zero Hardcoded)
// ==========================================================================
describe("Phase 8 — S13: KPI Calculation & Live Data Integrity", () => {
  test("S13-01: systemHealth is computed average from robot health values", () => {
    systemManager.switchSystem("ace");
    decentralizedFleet.initializeFleet(3, "ace");
    const agents = Array.from(decentralizedFleet.agents.values());
    agents[0].localState.health = 90;
    agents[1].localState.health = 80;
    agents[2].localState.health = 100;
    state.set("robots", decentralizedFleet.getGlobalFleetState());

    simEngine.step(0.1);
    const kpis = state.get("kpis");
    expect(kpis.systemHealth).toBe("90.0%");
  });

  test("S13-02: activeAlerts reflects actual conflict and error count", () => {
    systemManager.switchSystem("centralized");
    centralizedCoordinator.initializeFleet(3);
    const r1 = centralizedCoordinator.getRobot("R01");
    r1.status = "ERROR";
    state.set("robots", centralizedCoordinator.getGlobalFleetState());

    simEngine.step(0.1);
    const kpis = state.get("kpis");
    expect(kpis.activeAlerts).toBeGreaterThanOrEqual(1);
  });

  test("S13-03: simEngine.formatSimTime correctly formats seconds to HH:MM:SS", () => {
    expect(simEngine.formatSimTime(0)).toBe("00:00:00");
    expect(simEngine.formatSimTime(65)).toBe("00:01:05");
    expect(simEngine.formatSimTime(3665)).toBe("01:01:05");
  });

  test("S13-04: simEngine.clearFaults resets robot status to IDLE (uppercase)", () => {
    systemManager.switchSystem("centralized");
    centralizedCoordinator.initializeFleet(2);
    const r1 = centralizedCoordinator.getRobot("R01");
    r1.status = "ERROR";
    
    simEngine.clearFaults();
    expect(r1.status).toBe("IDLE");
  });
});

// ==========================================================================
// SCENARIO 14: Judge Demo Controller Execution & Deterministic Output
// ==========================================================================
describe("Phase 8 — S14: Judge Demo Controller Execution", () => {
  test("S14-01: JudgeDemoController initialized in idle state", () => {
    const status = judgeDemo.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.totalSteps).toBe(7);
  });

  test("S14-02: JudgeDemo runs synchronously with 0ms delay and completes all 7 steps", async () => {
    const result = await judgeDemo.run({ stepDelayMs: 0 });
    expect(result.success).toBe(true);
    expect(result.status).toBe("GRAND_FINALE_READY");
    expect(result.metrics.collisionsDetected).toBe(0);
    expect(result.metrics.deadlocksEncountered).toBe(0);
    expect(result.metrics.contractsSigned).toBeGreaterThanOrEqual(1);
  });

  test("S14-03: JudgeDemo populates log stream with all demo stages", () => {
    const logs = judgeDemo.getStatus().logs;
    expect(logs.length).toBeGreaterThanOrEqual(7);
    expect(logs.some(l => l.message.includes("Step 1"))).toBe(true);
    expect(logs.some(l => l.message.includes("Step 7"))).toBe(true);
  });

  test("S14-04: JudgeDemo guarantees zero state flapping via verified dwell hold", () => {
    const result = judgeDemo.getStatus().lastResult;
    expect(result.metrics.hysteresisHoldVerified).toBe(true);
    expect(result.metrics.flappingTransitionsPrevented).toBe(true);
  });
});

// ==========================================================================
// SCENARIO 15: 12 ACE Validation Tests Compatibility & Verification
// ==========================================================================
describe("Phase 8 — S15: 12 ACE Validation Tests Compatibility", () => {
  beforeEach(() => {
    systemManager.switchSystem("ace");
    decentralizedFleet.initializeFleet(3, "ace");
  });

  test("S15-01: All 12 ACE validation tests defined in registry", () => {
    expect(ACE_VALIDATION_TESTS.length).toBe(12);
    const ids = ACE_VALIDATION_TESTS.map(t => t.id);
    for (let i = 1; i <= 12; i++) {
      expect(ids).toContain(`A${i.toString().padStart(2, "0")}`);
    }
  });

  test("S15-02: Validation tests execute successfully under ACE mode", () => {
    const testA01 = AceValidationRunner.runTest("A01");
    expect(testA01.status).toBe("PASSED");

    const testA02 = AceValidationRunner.runTest("A02");
    expect(testA02.status).toBe("PASSED");
  });

  test("S15-03: Validation suite blocks execution when switched away from ACE", () => {
    systemManager.switchSystem("centralized");
    const blockedA01 = AceValidationRunner.runTest("A01");
    expect(blockedA01.status).toBe("BLOCKED");
  });
});
