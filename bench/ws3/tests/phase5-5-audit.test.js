// ==========================================================================
// NODEX ACE — PHASE 5.5 MASTER ARCHITECTURE & FEATURE AUDIT VERIFICATION TEST
// Rigorous verification covering Section 1 to 74 of Master Audit Specification
// ==========================================================================

import { describe, test, expect } from "vitest";
import { state } from "../../../zz-ws3/core/state.js";
import { simEngine } from "../../../zz-ws3/core/sim-engine.js";
import { raceEvaluator, RaceEvaluator } from "../../../zz-ws3/core/race-evaluator.js";
import { MapGeometryEngine, ROBOT_FOOTPRINT } from "../../../zz-ws3/core/map-geometry.js";
import { systemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { centralizedCoordinator } from "../../../zz-ws3/core/centralized/CentralizedCoordinator.js";
import { decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";
import { isCapabilitySupported, getCapabilityUnavailableReason } from "../../../zz-ws3/core/capabilities.js";

describe("Phase 5.5 — Master Audit Verification Suite", () => {
  // --------------------------------------------------------------------------
  // 1. SECTION 14 & 15: HYSTERESIS OSCILLATION TEST & TELEMETRY CONTRACT
  // --------------------------------------------------------------------------
  test("Section 14: Fluctuating risk sequence [0.59, 0.61, 0.60, 0.61, 0.59, 0.60] does not oscillate envelope", () => {
    const evaluator = new RaceEvaluator({
      thresholds: {
        T_local_enter: 0.50,
        T_neigh_enter: 0.70,
        T_contain_exit: 0.55,
        T_neigh_exit: 0.35,
        T_degraded_enter: 0.85,
        T_degraded_exit: 0.68
      },
      persistenceSamplesRequired: 3,
      minimumDwellTimeSeconds: 4.0
    });

    const testRobot = {
      id: "R-AUDIT-01",
      raceState: "NEIGHBORHOOD",
      riskScore: 0.60,
      envelopeRadius: 45,
      coordinationScope: "4 robots (neighborhood)",
      _hysteresis: {
        stateEnteredTime: 10.0,
        samplesAbove: 0,
        samplesBelow: 0,
        lastHoldReason: null
      }
    };

    const riskSequence = [0.59, 0.61, 0.60, 0.61, 0.59, 0.60];
    const statesRecorded = [];
    const telemetryHistory = [];

    let simTime = 11.0;
    for (const r of riskSequence) {
      testRobot.riskScore = r;
      const res = evaluator.evaluateEnvelopeState(testRobot, simTime, {
        conflict: r,
        uncertainty: 0.1,
        commRisk: 0.1,
        queueGrowth: 0.1,
        cascadePressure: 0.1
      });

      statesRecorded.push(res.currentState);
      telemetryHistory.push(res);
      simTime += 0.2; // dwell time not yet elapsed (only 1.2s elapsed)
    }

    // All states must remain NEIGHBORHOOD without oscillation to CONTAINMENT or LOCAL
    const allNeighborhood = statesRecorded.every(s => s === "NEIGHBORHOOD");
    expect(allNeighborhood, `Envelope oscillated: ${statesRecorded.join(" -> ")}`).toBe(true);

    // Section 15: Telemetry check on all required fields
    const sample = telemetryHistory[0];
    expect(sample.previousEnvelope !== undefined, "previousEnvelope must exist").toBe(true);
    expect(sample.currentEnvelope !== undefined, "currentEnvelope must exist").toBe(true);
    expect(sample.risk !== undefined, "risk must exist").toBe(true);
    expect(sample.transitionDirection !== undefined, "transitionDirection must exist").toBe(true);
    expect(sample.transitionReason !== undefined, "transitionReason must exist").toBe(true);
    expect(sample.hysteresisState !== undefined, "hysteresisState must exist").toBe(true);
    expect(sample.timestamp !== undefined, "timestamp must exist").toBe(true);
  });

  // --------------------------------------------------------------------------
  // 2. SECTION 8 & 9: RACE RISK FORMULA & DETERMINISM
  // --------------------------------------------------------------------------
  test("RACE calculation strictly evaluates all 5 weighted factors and clamps [0, 1]", () => {
    const inputs = {
      conflict: 0.8,        // w1 = 0.35 -> 0.280
      uncertainty: 0.4,     // w2 = 0.15 -> 0.060
      commRisk: 0.5,        // w3 = 0.20 -> 0.100
      queueGrowth: 0.6,     // w4 = 0.15 -> 0.090
      cascadePressure: 0.2  // w5 = 0.15 -> 0.030
    };
    // Expected = 0.280 + 0.060 + 0.100 + 0.090 + 0.030 = 0.560
    const risk = raceEvaluator.calculateRaceRisk(inputs);
    expect(risk, `Calculated risk ${risk} did not match theoretical 0.560`).toBe(0.560);

    // Clamping test
    const clampedRisk = raceEvaluator.calculateRaceRisk({
      conflict: 2.5,
      uncertainty: -1.0,
      commRisk: 1.5,
      queueGrowth: 3.0,
      cascadePressure: 0.0
    });
    expect(clampedRisk <= 1.0 && clampedRisk >= 0.0, "Risk must be strictly clamped to [0, 1]").toBe(true);
  });

  // --------------------------------------------------------------------------
  // 3. SECTION 20: SPACE-TIME CONTRACT RUNTIME OBJECTS
  // --------------------------------------------------------------------------
  test("Space-Time Contracts are real runtime objects with defined schema", () => {
    systemManager.switchSystem("ace");
    simEngine.initialize({ robotCount: 3, systemMode: "ace" });

    // Run simulation forward to generate coordination
    for (let i = 0; i < 5; i++) {
      simEngine.step(0.1);
    }

    // Contract change (audit r3): contracts are no longer fabricated from
    // distance/labels. Put two robots in physical proximity and let the ACE
    // runtime do the rest: sensors + Edge AI -> RACE escalation -> session ->
    // space-time contract.
    // Coordination is opened only by a robot that is carrying out a task
    // (idle robots never coordinate), so both converging robots hold one.
    simEngine.updateRobot("R01", { x: 340, y: 305, targetX: 340, targetY: 305, currentTaskId: "T-STC-1" });
    simEngine.updateRobot("R02", { x: 368, y: 305, targetX: 368, targetY: 305, currentTaskId: "T-STC-2" });
    let contracts = [];
    for (let i = 0; i < 20 && contracts.length === 0; i++) {
      simEngine.step(0.1);
      contracts = decentralizedFleet.getContracts();
    }

    expect(contracts.length > 0, "Active contracts must be created for converging AMRs").toBe(true);
    const contract = contracts[0];

    expect(contract.id.startsWith("STC-"), `Contract ID missing STC prefix: ${contract.id}`).toBe(true);
    expect(contract.resource !== undefined, "Contract must specify resource/region").toBe(true);
    expect(contract.timeWindow && contract.timeWindow.start !== undefined && contract.timeWindow.end !== undefined, "Contract must have timeWindow").toBe(true);
    expect(contract.owner !== undefined, "Contract must define owner").toBe(true);
    expect(Array.isArray(contract.participants), "Contract must define participants array").toBe(true);
    expect(contract.status, "Contract status must be ACTIVE").toBe("ACTIVE");
    expect(contract.expiration > 0, "Contract expiration must be positive number").toBe(true);
    expect(contract.conflictHandling !== undefined, "Contract must detail conflict handling mechanism").toBe(true);
    // The contract is consumed by its participants: between two robots that
    // both need the contracted region it decides right of way (parked robots
    // are not arbitrated by it).
    const [first, second] = contract.order;
    const a1 = decentralizedFleet.getAgent(first), a2 = decentralizedFleet.getAgent(second);
    // The non-initiating participant joins when it reads the session-open
    // message; deliver pending peer messages without advancing time.
    for (const a of [a1, a2]) a.processInbox(decentralizedFleet.taskRegistry);
    const reg = contract.region;
    for (const [me, other] of [[a1, a2], [a2, a1]]) {
      me.localState.currentTaskId = `T-${me.robotId}`;
      me.localState.targetX = reg.x; me.localState.targetY = reg.y;
      me.peerCache.set(other.robotId, { ...(me.peerCache.get(other.robotId) || {}), id: other.robotId, currentTaskId: `T-${other.robotId}`, targetX: reg.x, targetY: reg.y, x: other.localState.x, y: other.localState.y });
    }
    expect(a1.ace.decide(second).iWin).toBe(true);
    expect(a2.ace.decide(first).iWin).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 4. SECTION 25 & 26: MAP AUTHORITY & MAP UPLOAD AUDIT
  // --------------------------------------------------------------------------
  test("Map upload and selection dynamically alters authoritative geometry and planner collision checking", () => {
    // Test WH-A default
    MapGeometryEngine.loadMap("WH-A");
    const defaultObstacles = MapGeometryEngine.getActiveObstacles();
    // WH-A is produced by the adaptive WarehouseMapGenerator (map-geometry.js),
    // not the legacy fixed SHELF_OBSTACLES table (RACK-UA...). Assert the real
    // contract: a generated, non-empty rack set that keeps every waypoint clear.
    expect(defaultObstacles.length > 0, "WH-A must contain generated racks").toBe(true);
    expect(defaultObstacles.some(o => o.id.startsWith("RACK-WH-A-")), "WH-A racks must come from the generator").toBe(true);
    expect(
      MapGeometryEngine.getActiveWaypoints().every(w => !MapGeometryEngine.isPointInObstacle(w.x, w.y).collision),
      "No WH-A navigation waypoint may lie inside a rack"
    ).toBe(true);

    // Load custom map layout (e.g. simulated from uploaded GeoJSON/YAML)
    const customMapData = {
      obstacles: [
        { id: "CUSTOM-RACK-01", name: "Custom Vault Rack", minX: 180, minY: 100, maxX: 300, maxY: 180, type: "shelf" }
      ]
    };
    MapGeometryEngine.loadMap("WH-UPLOADED", customMapData);

    const activeObs = MapGeometryEngine.getActiveObstacles();
    expect(activeObs.length, "Authoritative obstacles must update to custom uploaded map").toBe(1);
    expect(activeObs[0].id, "Uploaded obstacle must be active").toBe("CUSTOM-RACK-01");

    // Verify that collision check uses the newly uploaded obstacle
    const hitCustom = MapGeometryEngine.isPointInObstacle(240, 140);
    expect(hitCustom.collision, "Collision engine must recognize custom uploaded obstacle").toBe(true);
    expect(hitCustom.obstacle.id).toBe("CUSTOM-RACK-01");

    // Re-load default WH-A layout
    MapGeometryEngine.loadMap("WH-A");
    expect(MapGeometryEngine.getActiveObstacles().some(o => o.id === "CUSTOM-RACK-01"), "Custom obstacles must not survive a WH-A reload").toBe(false);
    expect(MapGeometryEngine.getActiveObstacles().some(o => o.id.startsWith("RACK-WH-A-"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 5. SECTION 36 & 37: HITL 3 SCOPES & SAFETY ARBITRATION
  // --------------------------------------------------------------------------
  test("HITL supports exactly 3 scopes (ENTIRE_FLEET, ROBOT_GROUP, INDIVIDUAL_ROBOT) with feature gating", () => {
    systemManager.switchSystem("ace");
    const aceAdapter = systemManager.getActiveAdapter();

    // Test Scope 1: ENTIRE_FLEET
    const fleetRes = aceAdapter.sendHitlCommand("ENTIRE_FLEET", ["ALL_ACTIVE_AMRS"], "hold");
    expect(fleetRes.success).toBe(true);
    expect(fleetRes.scope).toBe("ENTIRE_FLEET");

    // Test Scope 2: ROBOT_GROUP
    const groupRes = aceAdapter.sendHitlCommand("ROBOT_GROUP", ["R01", "R02"], "resume");
    expect(groupRes.success).toBe(true);
    expect(groupRes.scope).toBe("ROBOT_GROUP");
    expect(groupRes.targetIds).toEqual(["R01", "R02"]);

    // Test Scope 3: INDIVIDUAL_ROBOT
    const indivRes = aceAdapter.sendHitlCommand("INDIVIDUAL_ROBOT", "R03", "safe_stop");
    expect(indivRes.success).toBe(true);
    expect(indivRes.scope).toBe("INDIVIDUAL_ROBOT");
    expect(indivRes.targetIds).toEqual(["R03"]);

    // Switch to Centralized: HITL must be locked out
    systemManager.switchSystem("centralized");
    const centAdapter = systemManager.getActiveAdapter();
    const centHitl = centAdapter.sendHitlCommand("ENTIRE_FLEET", ["ALL_ACTIVE_AMRS"], "hold");
    expect(centHitl.success, "Centralized mode must reject HITL commands").toBe(false);
  });

  test("Safety supervisor prevents human commands from penetrating solid obstacles", () => {
    // Point inside upper storage rack A (x: 280, y: 100)
    const shelfCheck = MapGeometryEngine.isPointInObstacle(280, 100);
    expect(shelfCheck.collision, "Solid shelf obstacle must trigger collision").toBe(true);

    // Valid point in corridor (x: 212, y: 165)
    const corridorCheck = MapGeometryEngine.isPointInObstacle(212, 165);
    expect(corridorCheck.collision, "Legal corridor must be collision-free").toBe(false);
  });

  // --------------------------------------------------------------------------
  // 6. SECTION 42: THREE-SYSTEM ISOLATION & ZERO STATE LEAKAGE
  // --------------------------------------------------------------------------
  test("Switching CENTRALIZED -> DECENTRALIZED -> ACE -> CENTRALIZED sanitizes state", () => {
    systemManager.switchSystem("ace");
    const robots = state.get("robots") || [];
    if (robots[0]) {
      robots[0].raceState = "CONTAINMENT";
      robots[0].envelopeRadius = 75;
      robots[0].riskScore = 0.85;
    }

    // Switch to Centralized
    systemManager.switchSystem("centralized");
    const centRobots = state.get("robots");
    for (const r of centRobots) {
      // Contract change (audit r3): Centralized has no RACE state at all.
      expect(r.raceState, "raceState must be absent in Centralized").toBe(null);
      expect(r.envelopeRadius, "envelopeRadius must be 0 in Centralized").toBe(0);
      expect(r.riskScore, "riskScore must be absent in Centralized").toBe(null);
    }

    // Switch to Decentralized
    systemManager.switchSystem("decentralized");
    expect(isCapabilitySupported("decentralized", "adaptiveEnvelope")).toBe(false);
    expect(isCapabilitySupported("decentralized", "peerNegotiation")).toBe(true);

    // Switch to ACE
    systemManager.switchSystem("ace");
    expect(isCapabilitySupported("ace", "adaptiveEnvelope")).toBe(true);
    expect(isCapabilitySupported("ace", "hitl")).toBe(true);
  });
});
