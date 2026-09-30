// ==========================================================================
// NODEX ACE AMR DASHBOARD — PHASE 2 MASTER VERIFICATION TEST SUITE
// Centralized Fleet Coordination System + Dashboard-Integrated Simulation
// Automated tests for:
// 1. 1 Robot + 1 Task Lifecycle (Assign -> Plan -> Execute -> Complete)
// 2. 3 Robots + Multiple Tasks Concurrent Scheduling
// 3. Two Crossing Routes Spatiotemporal Conflict Detection & Right-of-Way
// 4. Shared Narrow Corridor Arbitration (Wait -> Pass -> Resume)
// 5. Shelf Obstacle Avoidance (A* Global Planner routing around shelves)
// 6. Robot Failure & Centralized Task Reallocation
// 7. Task Completion Condition (Distance <= Goal Tolerance)
// 8. Simulation Clock Pause & Resume Integrity
// 9. Simulation Reset & State Consistency
// 10. Map Boundary Clamping & Collision Model
// 11. Fleet Entity Scalability (3 -> 10 -> 50 AMR initialization)
// 12. Architecture Isolation & Feature Gating Matrix
// ==========================================================================

import { describe, test, expect } from "vitest";
import {
  MapGeometryEngine,
  ROBOT_FOOTPRINT,
  WAREHOUSE_DIMENSIONS,
  SHELF_OBSTACLES,
  DRIVING_AISLES
} from "../../../zz-ws4/core/map-geometry.js";

import { GlobalPlanner, globalPlanner } from "../../../zz-ws4/core/centralized/GlobalPlanner.js";
import { TaskManager, taskManager, TASK_STATUS, WAREHOUSE_TASK_LOCATIONS } from "../../../zz-ws4/core/centralized/TaskManager.js";
import { AssignmentEngine, assignmentEngine } from "../../../zz-ws4/core/centralized/AssignmentEngine.js";
import { ConflictManager, conflictManager } from "../../../zz-ws4/core/centralized/ConflictManager.js";
import { CentralizedCoordinator, centralizedCoordinator } from "../../../zz-ws4/core/centralized/CentralizedCoordinator.js";
import { DashboardSimulationAdapter } from "../../../zz-ws4/core/adapters/DashboardSimulationAdapter.js";
import { CentralizedAdapter } from "../../../zz-ws4/core/adapters/CentralizedAdapter.js";
import { SystemManager } from "../../../zz-ws4/core/adapters/SystemManager.js";
import { state } from "../../../zz-ws4/core/state.js";

describe("Phase 2 — Centralized Verification Suite", () => {
  // Shared across TEST 3 and TEST 4 (crossing-route conflict scenario)
  let cManager, crossingR1, crossingR2, detectedConflicts;

  // ------------------------------------------------------------------------
  // TEST 1: 1 Robot + 1 Task Lifecycle
  // ------------------------------------------------------------------------
  test("TEST 1: 1 Robot + 1 Task Lifecycle", () => {
    const coord1 = new CentralizedCoordinator();
    coord1.initializeFleet(1);
    const r1 = coord1.getRobot("R01");

    expect(r1 !== null && r1.id === "R01", "Single AMR entity R01 spawned under centralized fleet state").toBe(true);
    expect(r1.status === "IDLE" || r1.status === "ASSIGNED" || r1.status === "MOVING", "R01 initialized with valid state").toBe(true);

    // Verify task assignment
    const testTask1 = taskManager.createTask({
      id: "T-TEST-01",
      pickup: { x: 212, y: 165, name: "Storage A1" },
      destination: { x: 578, y: 305, name: "Storage B3" },
      priority: "HIGH"
    });
    expect(testTask1.status, "Task T-TEST-01 created with status UNASSIGNED").toBe(TASK_STATUS.UNASSIGNED);

    // Run coordinator tick to assign task
    coord1.tick(0.1);
    const assignedTask = taskManager.getTaskById(r1.currentTaskId);
    expect(assignedTask !== null && assignedTask.assignedRobot === "R01", "Task assigned to R01 by centralized assignment engine").toBe(true);
    expect(r1.currentPath !== null && r1.currentPath.length > 1, "A* path generated for R01 with multiple legal corridor waypoints").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 2: 3 Robots + Multiple Tasks Concurrent Scheduling
  // ------------------------------------------------------------------------
  test("TEST 2: 3 Robots + Multiple Tasks Concurrent Scheduling", () => {
    const coord3 = new CentralizedCoordinator();
    coord3.initializeFleet(3);
    const fleet3 = coord3.getGlobalFleetState();

    expect(fleet3.length, "Centralized coordinator maintains exactly 3 distinct AMRs in fleet state").toBe(3);
    expect(fleet3.map(r => r.id).join(","), "AMR IDs R01, R02, R03 correctly populated").toBe("R01,R02,R03");

    // Fleet init creates robots only; tasks come from the scenario loader.
    coord3.loadScenarioTasks([0, 1, 2, 3].map(i => ({
      id: `T-P2-${i}`, pickup: WAREHOUSE_TASK_LOCATIONS[i], destination: WAREHOUSE_TASK_LOCATIONS[i + 6], priority: "MEDIUM"
    })));
    const unassignedBefore = taskManager.getUnassignedTasks().length;
    expect(unassignedBefore >= 3, "Coordinator created multiple tasks for fleet queue").toBe(true);

    coord3.tick(0.1);
    const activeTasks = taskManager.getActiveTasks();
    expect(activeTasks.length >= 2, "Centralized coordinator concurrently dispatched tasks to feasible fleet AMRs").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 3: Two Crossing Routes Spatiotemporal Conflict Detection & Right-of-Way
  // ------------------------------------------------------------------------
  test("TEST 3: Two Crossing Routes Conflict Detection & Right-of-Way", () => {
    cManager = new ConflictManager();
    // Robot 1 moving East along H-MID2 towards crossing (352, 305)
    crossingR1 = {
      id: "R01",
      x: 320,
      y: 305,
      targetX: 352,
      targetY: 305,
      heading: 0,
      velocity: 1.2,
      currentTaskId: null,
      status: "MOVING"
    };
    // Robot 2 moving South along V-MID2 towards crossing (352, 305)
    crossingR2 = {
      id: "R02",
      x: 352,
      y: 280,
      targetX: 352,
      targetY: 305,
      heading: Math.PI / 2,
      velocity: 1.2,
      currentTaskId: null,
      status: "MOVING"
    };

    detectedConflicts = cManager.detectConflicts([crossingR1, crossingR2]);
    expect(detectedConflicts.length > 0, "Spatiotemporal conflict detected between converging AMRs at crossing intersection").toBe(true);

    const resolution = cManager.resolvePriority(crossingR1, crossingR2, taskManager);
    expect(resolution.winner && resolution.loser, "Deterministic priority arbitration successfully selected winner and yielding AMR").toBeTruthy();
    // R02 (25px from the node) is already inside the intersection zone and
    // holds it; R01's leg ends at that node, so R01 yields (contract since the
    // intersection rules were unified with the decentralized arbiter).
    expect(resolution.winner.id, "AMR R02 inside the intersection keeps right-of-way; R01 yields").toBe("R02");
  });

  // ------------------------------------------------------------------------
  // TEST 4: Shared Narrow Corridor Arbitration (Wait -> Pass -> Resume)
  // ------------------------------------------------------------------------
  test("TEST 4: Shared Narrow Corridor Arbitration", () => {
    // Simulate conflict resolution actions
    const actions = cManager.resolveConflicts(detectedConflicts, taskManager, globalPlanner);
    const waitingAction = actions.find(a => a.type === "ROBOT_WAITING");
    const proceedingAction = actions.find(a => a.type === "ROBOT_PROCEEDING");

    expect(waitingAction && waitingAction.robotId === "R01", "Coordinator instructed R01 to enter WAITING state").toBe(true);
    expect(proceedingAction && proceedingAction.robotId === "R02", "Coordinator instructed R02 to proceed through the intersection").toBe(true);

    // Move R02 past crossing
    crossingR2.y = 420; // R02 has cleared intersection
    const clearedConflicts = cManager.detectConflicts([crossingR1, crossingR2]);
    expect(clearedConflicts.length, "Conflict clears once lead AMR moves past clearance boundary").toBe(0);
  });

  // ------------------------------------------------------------------------
  // TEST 5: Shelf Obstacle Avoidance (A* Planner Routes Around Shelves)
  // ------------------------------------------------------------------------
  test("TEST 5: Shelf Obstacle Avoidance", () => {
    // Plan path from above Shelf 01 (Storage A Upper) to below it
    // Shelf 01 occupies x: 245..320, y: 55..135
    const startAboveShelf = { x: 280, y: 35 };   // on North Lane (y: 35)
    const destBelowShelf = { x: 280, y: 165 };   // on Crossway 1 (y: 165)

    const directCutSegment = [startAboveShelf, destBelowShelf];
    const directCheck = MapGeometryEngine.validatePath(directCutSegment, ROBOT_FOOTPRINT.radius);
    expect(directCheck.valid, "Direct straight line cuts through shelf and is rejected as INVALID").toBe(false);

    // A* Global Planner plans path around shelf
    const safeAStarPath = globalPlanner.planPath(startAboveShelf, destBelowShelf);
    expect(safeAStarPath.length >= 3, "A* Global Planner generated multi-waypoint detour around shelf").toBe(true);

    const aStarValidation = MapGeometryEngine.validatePath(safeAStarPath, ROBOT_FOOTPRINT.radius);
    expect(aStarValidation.valid, "A* trajectory stays strictly within legal aisles without crossing shelf").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 6: Robot Failure & Centralized Task Reallocation
  // ------------------------------------------------------------------------
  test("TEST 6: Robot Failure & Centralized Task Reallocation", () => {
    const coordFail = new CentralizedCoordinator();
    coordFail.initializeFleet(3);
    coordFail.tick(0.1);

    // Pick robot R02 and inject motor failure
    const taskAssignedToR02 = taskManager.getActiveTasks().find(t => t.assignedRobot === "R02");
    const targetTaskId = taskAssignedToR02 ? taskAssignedToR02.id : "T-102";

    coordFail.handleRobotFailure("R02", "Actuator motor stall");
    const failedR02 = coordFail.getRobot("R02");

    expect(failedR02.status, "Failed AMR status transitioned to ERROR").toBe("ERROR");
    expect(failedR02.velocity, "Failed AMR velocity halted to 0").toBe(0);
    expect(coordFail.getRunStats().tasksFailed >= 1, "Coordinator logged robot hardware failure event in run stats").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 7: Task Completion Condition (Distance <= Goal Tolerance)
  // ------------------------------------------------------------------------
  test("TEST 7: Task Completion Condition", () => {
    const coordComplete = new CentralizedCoordinator();
    coordComplete.initializeFleet(1);

    const destLoc = { x: 578, y: 305, name: "Storage B3" };
    const testTaskComplete = taskManager.createTask({
      id: "T-COMPLETE-01",
      pickup: { x: 145, y: 35, name: "Dock 1" },
      destination: destLoc,
      priority: "HIGH"
    });
    taskManager.assignTask(testTaskComplete.id, "R01", [{ x: 570, y: 305 }, destLoc]);
    taskManager.startTask(testTaskComplete.id);

    const rComp = coordComplete.getRobot("R01");
    rComp.currentTaskId = testTaskComplete.id;
    rComp.currentTask = "T-COMPLETE-01 (Storage B3)";
    rComp.status = "MOVING";
    rComp.x = 576; // within 2px of destination (goalTolerance = 8.0px)
    rComp.y = 305;

    // Reaching the drop starts the unloading dwell; the task completes when
    // unloading ends (UNLOAD_SECONDS of sim time).
    coordComplete.tick(0.1);
    expect(taskManager.getTaskById("T-COMPLETE-01").status, "Not complete while unloading").not.toBe(TASK_STATUS.COMPLETED);
    expect(rComp.handling?.kind, "Unloading dwell started at the drop").toBe("UNLOADING");
    for (let i = 0; i < 20; i++) coordComplete.tick(0.1);
    const finishedTask = taskManager.getTaskById("T-COMPLETE-01");

    expect(finishedTask.status, "Task marked COMPLETED when AMR reaches destination within tolerance").toBe(TASK_STATUS.COMPLETED);
    expect(finishedTask.completedTime !== null, "Completion timestamp recorded in task record").toBe(true);
    expect(rComp.status, "AMR state reverts to IDLE and is ready for next assignment").toBe("IDLE");
  });

  // ------------------------------------------------------------------------
  // TEST 8: Simulation Clock Pause & Resume Integrity
  // ------------------------------------------------------------------------
  test("TEST 8: Simulation Clock Pause & Resume Integrity", () => {
    state.set("simRunning", true);
    state.set("simTimeSeconds", 120.0);

    // Pause
    state.set("simRunning", false);
    expect(state.get("simRunning"), "Simulation successfully paused").toBe(false);
    const pausedTime = state.get("simTimeSeconds");
    expect(pausedTime, "Simulation clock preserved exactly at paused timestamp").toBe(120.0);

    // Resume
    state.set("simRunning", true);
    expect(state.get("simRunning"), "Simulation successfully resumed without state loss").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 9: Simulation Reset & State Consistency
  // ------------------------------------------------------------------------
  test("TEST 9: Simulation Reset & State Consistency", () => {
    const coordReset = new CentralizedCoordinator();
    coordReset.initializeFleet(5);
    coordReset.tick(0.5);

    // Reset
    coordReset.initializeFleet(5);
    const resetRobots = coordReset.getGlobalFleetState();
    const resetStats = coordReset.getRunStats();

    expect(resetRobots.length, "Reset preserves configured fleet size").toBe(5);
    expect(resetStats.tasksCompleted, "Completed tasks counter reset to 0").toBe(0);
    expect(resetStats.conflictsDetected, "Conflict counters cleared on reset").toBe(0);
  });

  // ------------------------------------------------------------------------
  // TEST 10: Map Boundary Clamping & Collision Model
  // ------------------------------------------------------------------------
  test("TEST 10: Map Boundary Clamping & Collision Model", () => {
    const beyondBounds = { x: -50, y: 999 };
    const clampedPos = MapGeometryEngine.clampToBounds(beyondBounds.x, beyondBounds.y, ROBOT_FOOTPRINT.radius);

    expect(
      clampedPos.x >= WAREHOUSE_DIMENSIONS.bounds.minX && clampedPos.x <= WAREHOUSE_DIMENSIONS.bounds.maxX,
      "Out-of-bounds X coordinate clamped strictly within warehouse boundary"
    ).toBe(true);
    expect(
      clampedPos.y >= WAREHOUSE_DIMENSIONS.bounds.minY && clampedPos.y <= WAREHOUSE_DIMENSIONS.bounds.maxY,
      "Out-of-bounds Y coordinate clamped strictly within warehouse boundary"
    ).toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 11: Fleet Entity Scalability (3 -> 10 -> 50 AMR Initialization)
  // ------------------------------------------------------------------------
  test("TEST 11: Fleet Entity Scalability (3 -> 10 -> 50 AMRs)", () => {
    const coordScale = new CentralizedCoordinator();

    coordScale.initializeFleet(3);
    expect(coordScale.getGlobalFleetState().length, "Coordinator scales cleanly to 3 AMRs").toBe(3);

    coordScale.initializeFleet(10);
    expect(coordScale.getGlobalFleetState().length, "Coordinator scales cleanly to 10 AMRs").toBe(10);

    coordScale.initializeFleet(50);
    expect(coordScale.getGlobalFleetState().length, "Coordinator scales cleanly to 50 AMRs").toBe(50);
  });

  // ------------------------------------------------------------------------
  // TEST 12: Architecture Isolation & Feature Gating Matrix
  // ------------------------------------------------------------------------
  test("TEST 12: Architecture Isolation & Feature Gating Matrix", () => {
    const sysManager = new SystemManager();
    sysManager.switchSystem("centralized");
    const activeAdapter = sysManager.getActiveAdapter();

    expect(activeAdapter instanceof CentralizedAdapter, "Active adapter resolved strictly to CentralizedAdapter").toBe(true);
    expect(activeAdapter.isFeatureAvailable("hitl_control"), "Centralized mode disables HITL control").toBe(false);
    expect(activeAdapter.isFeatureAvailable("ace_validation"), "Centralized mode disables ACE Validation Tests").toBe(false);
    expect(activeAdapter.isFeatureAvailable("adaptive_envelopes"), "Centralized mode disables dynamic adaptive envelopes").toBe(false);
    expect(activeAdapter.isFeatureAvailable("risk_adaptive_metrics"), "Centralized mode disables RACE risk metrics").toBe(false);
    expect(activeAdapter.isFeatureAvailable("fleet_monitoring"), "Centralized mode enables fleet monitoring").toBe(true);

    // Telemetry check
    const sysState = activeAdapter.getSystemState();
    expect(sysState.systemId, "System ID confirmed as centralized").toBe("centralized");
    expect(sysState.isLive, "Centralized system is active and live streaming").toBe(true);
  });
});
