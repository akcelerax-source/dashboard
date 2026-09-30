// ==========================================================================
// NODEX ACE AMR DASHBOARD — PRE-INTEGRATION VERIFICATION TEST SUITE
// Automated tests for:
// 1. Map Geometry & Physics Collision Engine
// 2. Three-System Adapter Architecture & Gating Matrix
// 3. HITL Three-Scope Targeting & Safety Transition
// 4. Data Honesty & Empty State Verification
// ==========================================================================

import { describe, test, expect } from "vitest";
import {
  MapGeometryEngine,
  SHELF_OBSTACLES,
  DRIVING_AISLES,
  NAVIGATION_WAYPOINTS,
  WAREHOUSE_DIMENSIONS,
  ROBOT_FOOTPRINT
} from "../../../zz-ws3/core/map-geometry.js";

import { CentralizedAdapter } from "../../../zz-ws3/core/adapters/CentralizedAdapter.js";
import { DecentralizedAdapter } from "../../../zz-ws3/core/adapters/DecentralizedAdapter.js";
import { AceAdapter } from "../../../zz-ws3/core/adapters/AceAdapter.js";
import { SystemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { state } from "../../../zz-ws3/core/state.js";
import {
  getEfficiencyMatrix,
  getFleetScaleTrend,
  getRecordingsArchive,
  BenchmarkReportService
} from "../../../zz-ws3/data/benchmark-runs.js";

describe("Pre-Integration Verification Suite", () => {
  // Shared across suites (mirrors the original script's sequential dependencies)
  let sysManager, centAdapter, decAdapter, aceAdapter;

  // ------------------------------------------------------------------------
  // TEST SUITE 1: MAP GEOMETRY & OBSTACLE PHYSICS
  // ------------------------------------------------------------------------
  test("Suite 1: Map Geometry & Obstacle Physics", () => {
    // 1.1 Inside shelf collision check
    const shelfCenterPoint = { x: 280, y: 95 }; // Inside Shelf 01 (x: 236..324, y: 55..135)
    const shelfCheck = MapGeometryEngine.isPointInObstacle(shelfCenterPoint.x, shelfCenterPoint.y, ROBOT_FOOTPRINT.radius);
    expect(shelfCheck.collision, "Point inside shelf obstacle correctly detected as collision").toBe(true);

    // 1.2 In-corridor free-space check
    const corridorPoint = { x: 280, y: 166 }; // In horizontal driving corridor H-MID1 (y: 145..187)
    const corridorCheck = MapGeometryEngine.isPointInObstacle(corridorPoint.x, corridorPoint.y, ROBOT_FOOTPRINT.radius);
    expect(corridorCheck.collision, "Point in driving aisle recognized as free traversable space").toBe(false);

    // 1.3 Boundary bounds clamping
    const outOfBoundsPoint = { x: 950, y: -20 };
    const clamped = MapGeometryEngine.clampToBounds(outOfBoundsPoint.x, outOfBoundsPoint.y, ROBOT_FOOTPRINT.radius);
    expect(
      clamped.x <= WAREHOUSE_DIMENSIONS.bounds.maxX && clamped.y >= WAREHOUSE_DIMENSIONS.bounds.minY,
      "Robot position outside bounds is strictly clamped within map perimeter"
    ).toBe(true);

    // 1.4 Path segment collision detection
    const invalidPathCrossingShelf = [
      { x: 280, y: 30 },
      { x: 280, y: 170 } // crosses through Shelf 01 (y: 55..135)
    ];
    const pathCheck = MapGeometryEngine.validatePath(invalidPathCrossingShelf, ROBOT_FOOTPRINT.radius);
    expect(pathCheck.valid, "Trajectory that cuts through shelf is rejected as INVALID").toBe(false);

    // 1.5 Legal corridor path validation
    const validCorridorPath = [
      { x: 72, y: 33 },
      { x: 212, y: 33 },
      { x: 212, y: 166 } // travels strictly along corridor centerlines
    ];
    const validPathCheck = MapGeometryEngine.validatePath(validCorridorPath, ROBOT_FOOTPRINT.radius);
    expect(validPathCheck.valid, "Trajectory that stays strictly within driving aisles is validated as SAFE").toBe(true);

    // 1.6 Robot-to-robot safe separation check
    const robotA = { id: "R01", x: 200, y: 166 };
    const robotBOverlapping = { id: "R02", x: 215, y: 166 }; // distance = 15px (< minSeparation of 32px)
    const robotCSpaced = { id: "R03", x: 260, y: 166 }; // distance = 60px

    const sepConflict = MapGeometryEngine.checkRobotSeparation(robotA, robotBOverlapping, ROBOT_FOOTPRINT.totalRadius * 2);
    const sepSafe = MapGeometryEngine.checkRobotSeparation(robotA, robotCSpaced, ROBOT_FOOTPRINT.totalRadius * 2);

    expect(sepConflict.isConflict, "Overlapping AMRs within 32px threshold trigger physical separation conflict").toBe(true);
    expect(sepSafe.isConflict, "AMRs with safe clearance (> 32px) proceed without conflict").toBe(false);
  });

  // ------------------------------------------------------------------------
  // TEST SUITE 2: THREE-SYSTEM ADAPTER ARCHITECTURE & FEATURE GATING
  // ------------------------------------------------------------------------
  test("Suite 2: Three-System Adapters & Feature Gating", () => {
    sysManager = new SystemManager();

    // 2.1 Centralized Adapter (System A)
    sysManager.switchSystem("centralized");
    centAdapter = sysManager.getActiveAdapter();
    expect(centAdapter instanceof CentralizedAdapter, "System A correctly resolves to CentralizedAdapter").toBe(true);
    expect(centAdapter.isFeatureAvailable("hitl_control"), "Centralized mode disables HITL control").toBe(false);
    expect(centAdapter.isFeatureAvailable("ace_validation"), "Centralized mode disables ACE Validation Tests").toBe(false);
    expect(centAdapter.isFeatureAvailable("adaptive_envelopes"), "Centralized mode disables adaptive envelopes").toBe(false);
    expect(centAdapter.isFeatureAvailable("fleet_monitoring"), "Centralized mode preserves fleet monitoring").toBe(true);

    // 2.2 Decentralized Adapter (System B)
    sysManager.switchSystem("decentralized");
    decAdapter = sysManager.getActiveAdapter();
    expect(decAdapter instanceof DecentralizedAdapter, "System B correctly resolves to DecentralizedAdapter").toBe(true);
    expect(decAdapter.isFeatureAvailable("hitl_control"), "Decentralized mode disables HITL control").toBe(false);
    expect(decAdapter.isFeatureAvailable("ace_validation"), "Decentralized mode disables ACE Validation Tests").toBe(false);
    expect(decAdapter.isFeatureAvailable("adaptive_envelopes"), "Decentralized mode disables ACE envelopes").toBe(false);
    expect(decAdapter.isFeatureAvailable("fleet_monitoring"), "Decentralized mode preserves fleet monitoring").toBe(true);

    // 2.3 ACE / RACE Adapter (System C)
    sysManager.switchSystem("ace");
    aceAdapter = sysManager.getActiveAdapter();
    expect(aceAdapter instanceof AceAdapter, "System C correctly resolves to AceAdapter").toBe(true);
    expect(aceAdapter.isFeatureAvailable("hitl_control"), "ACE mode enables HITL control").toBe(true);
    expect(aceAdapter.isFeatureAvailable("ace_validation"), "ACE mode enables ACE Validation Tests").toBe(true);
    expect(aceAdapter.isFeatureAvailable("adaptive_envelopes"), "ACE mode enables adaptive envelopes").toBe(true);
    expect(aceAdapter.isFeatureAvailable("risk_adaptive_metrics"), "ACE mode enables risk metrics contract").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST SUITE 3: HITL THREE-SCOPE TARGETING & SAFETY TRANSITION
  // ------------------------------------------------------------------------
  test("Suite 3: HITL Three-Scope Targeting & Safety Transition", () => {
    // 3.1 Arm HITL in ACE mode
    state.set("systemMode", "ace");
    state.set("hitlEnabled", true);
    state.set("hitlScope", "fleet");
    const robotsList = [
      { id: "R01", status: "active", velocity: 1.2 },
      { id: "R02", status: "active", velocity: 1.2 },
      { id: "R03", status: "active", velocity: 1.2 }
    ];
    state.set("robots", robotsList);

    // 3.2 Scope 1: Entire Fleet
    const fleetCmd = aceAdapter.sendHitlCommand("fleet", ["R01", "R02", "R03"], "hold");
    expect(fleetCmd.success === true && fleetCmd.targetIds.length === 3, "Scope 1 (Entire Fleet) dispatches command to all 3 AMRs").toBe(true);

    // 3.3 Scope 2: Robot Group
    state.set("hitlScope", "group");
    state.set("hitlSelectedGroup", ["R01", "R03"]);
    const groupCmd = aceAdapter.sendHitlCommand("group", ["R01", "R03"], "resume");
    expect(groupCmd.success === true && groupCmd.targetIds.length === 2, "Scope 2 (Robot Group) dispatches only to selected group (R01, R03)").toBe(true);

    // 3.4 Scope 3: Individual Robot
    state.set("hitlScope", "individual");
    state.set("hitlSelectedRobot", "R02");
    const indivCmd = aceAdapter.sendHitlCommand("individual", ["R02"], "safe_stop");
    expect(indivCmd.success === true && indivCmd.targetIds[0] === "R02", "Scope 3 (Individual Robot) targets strictly R02").toBe(true);

    // 3.5 System transition safety disarm
    sysManager.switchSystem("centralized");
    expect(state.get("hitlEnabled"), "Switching system away from ACE immediately disarms HITL state").toBe(false);
    expect(state.get("hitlMode"), "HITL mode reverts to OFF upon exiting ACE system").toBe("OFF");
  });

  // ------------------------------------------------------------------------
  // TEST SUITE 4: DATA HONESTY & EMPTY TELEMETRY VERIFICATION
  // ------------------------------------------------------------------------
  test("Suite 4: Data Honesty & Empty Telemetry States", () => {
    const matrixEmpty = getEfficiencyMatrix();
    expect(matrixEmpty.length, "When dev fixtures are disabled, efficiency matrix returns empty array (no fake data)").toBe(0);

    const trendEmpty = getFleetScaleTrend();
    expect(trendEmpty.length, "When dev fixtures are disabled, fleet scale trend returns empty array").toBe(0);

    const scenarioMetrics = BenchmarkReportService.getMetricsForScenario("S08");
    const hasFakePercentage = scenarioMetrics.metrics.some(m => typeof m.centralized === "number" && m.centralized === 49.6);
    expect(!hasFakePercentage, "Raw scenario metrics do not manufacture unvalidated benchmark percentages").toBe(true);

    const collisionMetric = scenarioMetrics.metrics.find(m => m.name === "Collisions");
    expect(
      collisionMetric && collisionMetric.centralized === "No validated run",
      "Collision metric honestly states 'No validated run' rather than fake 0%"
    ).toBe(true);

    const throughputMetric = scenarioMetrics.metrics.find(m => m.name === "Throughput");
    expect(
      throughputMetric && throughputMetric.ace === "Awaiting telemetry",
      "Throughput metric honestly states 'Awaiting telemetry' rather than fake numbers"
    ).toBe(true);
  });
});
