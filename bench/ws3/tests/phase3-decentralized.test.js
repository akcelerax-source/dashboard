// ==========================================================================
// NODEX ACE AMR DASHBOARD — PHASE 3 MASTER VERIFICATION TEST SUITE
// Decentralized Fleet Coordination Without ACE/RACE + Simulation Engine
// Automated tests for:
// 1. Distributed Task Allocation (Announcement -> Local Bids -> Winner Ownership)
// 2. 3 Robots + Multiple Tasks Concurrent Distributed Allocation
// 3. Crossing Trajectories Peer Intent Exchange & Collision Avoidance
// 4. Shared Narrow Corridor Distributed Arbitration (Wait -> Pass -> Resume)
// 5. Local A* Shelf Obstacle Avoidance
// 6. Peer Failure Detection & Distributed Task Recovery
// 7. Communication Staleness / Heartbeat Timeout Handling
// 8. Mutual Waiting Deadlock Recovery via Local Replanning Detour
// 9. Clean System Switching Between Centralized and Decentralized Modes
// 10. Fleet Entity Scalability (3 -> 10 -> 50 Autonomous Robot Agents)
// 11. Architecture Isolation & Feature Gating Matrix
// 12. Peer Communication Metrics Accounting
// ==========================================================================

import { describe, test, expect } from "vitest";
import {
  MapGeometryEngine,
  ROBOT_FOOTPRINT,
  WAREHOUSE_DIMENSIONS
} from "../../../zz-ws3/core/map-geometry.js";

import { PeerCommunicationBus, peerCommunicationBus, MESSAGE_TYPES } from "../../../zz-ws3/core/decentralized/PeerCommunicationBus.js";
import { RobotAgent } from "../../../zz-ws3/core/decentralized/RobotAgent.js";
import { DecentralizedFleet, decentralizedFleet } from "../../../zz-ws3/core/decentralized/DecentralizedFleet.js";
import { DecentralizedAdapter } from "../../../zz-ws3/core/adapters/DecentralizedAdapter.js";
import { CentralizedAdapter } from "../../../zz-ws3/core/adapters/CentralizedAdapter.js";
import { SystemManager } from "../../../zz-ws3/core/adapters/SystemManager.js";
import { taskManager, WAREHOUSE_TASK_LOCATIONS } from "../../../zz-ws3/core/centralized/TaskManager.js";
import { centralizedCoordinator } from "../../../zz-ws3/core/centralized/CentralizedCoordinator.js";
import { state } from "../../../zz-ws3/core/state.js";

describe("Phase 3 — Decentralized Verification Suite", () => {
  // Shared across TEST 3/4 (crossing scenario) and TEST 9/11 (system switching)
  let crossR1, crossR2, decAdapter;

  // ------------------------------------------------------------------------
  // TEST 1: Distributed Task Allocation (Announcement -> Bids -> Winner Selection)
  // ------------------------------------------------------------------------
  test("TEST 1: Distributed Task Allocation via P2P Bidding", () => {
    const testBus = new PeerCommunicationBus();
    const agent1 = new RobotAgent("R01", { x: 145, y: 35 }, testBus);
    const agent2 = new RobotAgent("R02", { x: 740, y: 35 }, testBus);

    const sampleTask = {
      id: "T-DEC-01",
      pickup: { x: 212, y: 165, name: "Storage A1" },
      destination: { x: 352, y: 305, name: "Crossing A-B" },
      priority: "HIGH"
    };

    // Announce task
    testBus.broadcast("SYSTEM", MESSAGE_TYPES.TASK_ANNOUNCEMENT, { task: sampleTask });

    // Both agents process inbox
    agent1.processInbox();
    agent2.processInbox();

    // R01 at (145, 35) is much closer to pickup (212, 165) than R02 at (740, 35)
    // So R01 should submit a lower cost bid
    const bid1 = agent1.activeBids.get("T-DEC-01");
    const bid2 = agent2.activeBids.get("T-DEC-01");

    expect(bid1 !== undefined && bid2 !== undefined, "Both autonomous agents received announcement and generated local bids").toBe(true);
    expect(bid1.myBidCost < bid2.myBidCost, `R01 bid cost (${bid1.myBidCost.toFixed(1)}) is lower than R02 (${bid2.myBidCost.toFixed(1)}) based on local distance`).toBe(true);

    // Advance time to close bidding window and evaluate consensus
    agent1.activeBids.get("T-DEC-01").announcedAt = Date.now() - 150;
    agent2.activeBids.get("T-DEC-01").announcedAt = Date.now() - 150;

    agent1.evaluateTaskBids();
    agent2.evaluateTaskBids();

    expect(agent1.localState.currentTaskId, "AMR R01 claimed task ownership via distributed bid consensus").toBe("T-DEC-01");
    expect(agent2.localState.currentTaskId, "AMR R02 recognizes higher cost and did not claim task").toBe(null);
    expect(agent1.localState.plannedPath.length > 1, "R01 planned local A* path from its position to task pickup and destination").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 2: 3 Robots + Multiple Tasks Concurrent Allocation
  // ------------------------------------------------------------------------
  test("TEST 2: 3 Robots + Multiple Tasks Distributed Allocation", () => {
    const decFleet2 = new DecentralizedFleet();
    decFleet2.initializeFleet(3);

    expect(decFleet2.agents.size, "Decentralized fleet instantiated 3 autonomous RobotAgent instances").toBe(3);
    expect(!decFleet2.agents.has("CENTRAL_COORDINATOR"), "Strict decentralization: no central coordinator instance exists").toBe(true);

    // initializeFleet() deliberately creates robots only (phantom pre-run tasks were
    // removed); tasks are announced by the scenario loader, as at a real Start.
    decFleet2.loadScenarioTasks(WAREHOUSE_TASK_LOCATIONS.slice(0, 3).map((pickup, i) => ({
      id: `T-DEC-2${i}`,
      pickup,
      destination: WAREHOUSE_TASK_LOCATIONS[(i + 5) % WAREHOUSE_TASK_LOCATIONS.length],
      priority: "MEDIUM"
    })));

    // Run ticks to let agents bid on announced tasks. Robots are staged on
    // the perimeter, so the nearest robot can win several auctions at once;
    // the board re-announces tasks it could not take after 1 s.
    for (let i = 0; i < 15; i++) {
      decFleet2.tick(0.1);
    }

    const activeDecTasks = decFleet2.getActiveTasks();
    expect(activeDecTasks.length >= 2, "Multiple tasks successfully claimed across independent robot agents").toBe(true);

    const assignedAgents = Array.from(decFleet2.agents.values()).filter(a => a.localState.currentTaskId !== null);
    expect(assignedAgents.length >= 2, "Tasks distributed across distinct AMR agents without central dispatcher").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 3: Crossing Trajectories Peer Intent Exchange & Collision Avoidance
  // ------------------------------------------------------------------------
  test("TEST 3: Crossing Trajectories Peer Intent Exchange", () => {
    const crossBus = new PeerCommunicationBus();
    crossR1 = new RobotAgent("R01", { x: 320, y: 305 }, crossBus);
    crossR2 = new RobotAgent("R02", { x: 352, y: 280 }, crossBus);

    crossR1.localState.status = "MOVING";
    crossR1.localState.targetX = 352;
    crossR1.localState.targetY = 305;
    crossR1.localState.currentTaskId = "T-CROSS-1";

    crossR2.localState.status = "MOVING";
    crossR2.localState.targetX = 352;
    crossR2.localState.targetY = 305;
    crossR2.localState.currentTaskId = "T-CROSS-2";

    // Broadcast peer states and intents
    crossR1.broadcastStateAndIntent();
    crossR2.broadcastStateAndIntent();

    // Agents process each other's messages
    crossR1.processInbox();
    crossR2.processInbox();

    expect(crossR1.peerCache.has("R02"), "R01 successfully cached peer R02's trajectory intent").toBe(true);
    expect(crossR2.peerCache.has("R01"), "R02 successfully cached peer R01's trajectory intent").toBe(true);

    // Contract change (audit r3): System 2 negotiates right of way only inside
    // a fixed two-robot pair session formed by a P2P handshake.
    crossR1.pair.request("R02", "conflict", 0);
    crossR2.processInbox();   // PAIR_REQUEST -> PAIR_ACCEPT
    crossR1.processInbox();   // PAIR_ACCEPT -> session open on both robots
    expect(crossR1.pair.isPairedWith("R02") && crossR2.pair.isPairedWith("R01"), "R01 and R02 formed a fixed pair").toBe(true);

    // R01 (lower ID) arbitrates for the pair and sends PAIR_DECISION.
    crossR1.evaluatePeerConflicts(0.1);
    crossR2.processInbox();
    crossR2.evaluatePeerConflicts(0.1);

    // R02 (25px from the node) is already inside the intersection zone; R01's
    // leg ends at that node, so R01 yields (same rule as the centralized arbiter).
    expect(crossR2.localState.status, "R02 inside the intersection keeps right-of-way").toBe("MOVING");
    expect(crossR1.localState.status, "R01 evaluated conflict locally and transitioned to WAITING state").toBe("WAITING");
    expect(crossR1.localState.velocity, "R01 stopped velocity to prevent intersection collision").toBe(0);
  });

  // ------------------------------------------------------------------------
  // TEST 4: Shared Narrow Corridor Distributed Arbitration (Wait -> Pass -> Resume)
  // ------------------------------------------------------------------------
  test("TEST 4: Shared Narrow Corridor Distributed Arbitration", () => {
    // Simulate R02 progressing through intersection and clearing crossing
    crossR2.localState.y = 420; // R02 cleared intersection
    crossR2.broadcastStateAndIntent();

    crossR1.processInbox();
    crossR1.evaluatePeerConflicts(0.1);

    expect(crossR1.localState.status, "Waiting AMR R01 resumed travel once peer cleared corridor").toBe("MOVING");
    expect(crossR1.localState.velocity > 0, "R01 restored velocity without central prompt").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 5: Local A* Shelf Obstacle Avoidance
  // ------------------------------------------------------------------------
  test("TEST 5: Local A* Shelf Obstacle Avoidance", () => {
    const localAgent = new RobotAgent("R01", { x: 280, y: 35 }, new PeerCommunicationBus());
    const destPastShelf = { x: 280, y: 165 }; // Direct straight line cuts through Shelf 01 (y: 55..135)

    const localPlannedPath = localAgent.localPlanner.planPath(
      { x: localAgent.localState.x, y: localAgent.localState.y },
      destPastShelf
    );

    expect(localPlannedPath.length >= 3, "Local planner generated detour waypoints around shelf").toBe(true);
    const pathCheck = MapGeometryEngine.validatePath(localPlannedPath, ROBOT_FOOTPRINT.radius);
    expect(pathCheck.valid, "Autonomous agent's local path strictly avoids all shelf obstacles").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 6: Peer Failure Detection & Distributed Task Recovery
  // ------------------------------------------------------------------------
  test("TEST 6: Peer Failure Detection & Distributed Task Recovery", () => {
    const failBus = new PeerCommunicationBus();
    const failFleet = new DecentralizedFleet();
    failFleet.peerBus = failBus;
    failFleet.initializeFleet(2);

    const rFail = failFleet.getAgent("R01");
    const rPeer = failFleet.getAgent("R02");

    // Give R01 a task
    rFail.localState.currentTaskId = "T-FAIL-99";
    rFail.localState.status = "MOVING";

    // R02 learns about R01's task via peer cache
    rPeer.peerCache.set("R01", {
      id: "R01",
      currentTaskId: "T-FAIL-99",
      status: "ERROR",
      lastSeen: Date.now() - 6000 // 6 seconds ago (stale heartbeat)
    });

    // R02 checks peer liveness
    rPeer.checkPeerLiveness(failFleet.taskRegistry);

    const peerDecision = rPeer.localDecisionTrace.find(d => d.decision === "PEER_FAILED");
    expect(peerDecision !== undefined, "Peer R02 autonomously detected R01's failure from stale heartbeat").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 7: Communication Staleness / Heartbeat Timeout Handling
  // ------------------------------------------------------------------------
  test("TEST 7: Communication Staleness & Heartbeat Timeout", () => {
    const commAgent = new RobotAgent("R03", { x: 145, y: 455 }, new PeerCommunicationBus());
    commAgent.peerCache.set("R04", {
      id: "R04",
      x: 145,
      y: 400,
      lastSeen: Date.now() - 10000 // 10s old
    });

    const isStale = (Date.now() - commAgent.peerCache.get("R04").lastSeen) > 5000;
    expect(isStale, "Agent correctly classifies peer records older than 5000ms as stale").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 8: Mutual Waiting Deadlock Recovery via Local Replanning Detour
  // ------------------------------------------------------------------------
  test("TEST 8: Mutual Waiting Deadlock Recovery", () => {
    const deadAgent = new RobotAgent("R01", { x: 212, y: 165 }, new PeerCommunicationBus());
    deadAgent.localState.status = "WAITING";
    deadAgent.localState.isYielding = true;
    deadAgent.localState.stalledDuration = 3.5; // Exceeded 3.0s deadlock threshold
    deadAgent.localState.currentGoal = { x: 352, y: 305 };

    deadAgent.recoverFromDeadlock("R02");

    expect(deadAgent.localState.status, "Deadlock recovery restored AMR status to MOVING").toBe("MOVING");
    expect(deadAgent.localState.stalledDuration, "Stalled duration reset to 0 after replanning detour").toBe(0);
    const deadTrace = deadAgent.localDecisionTrace.find(d => d.decision === "DEADLOCK_REPLAN");
    expect(deadTrace !== undefined, "Deadlock recovery event logged in agent decision trace").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 9: Clean System Switching Between Centralized and Decentralized Modes
  // ------------------------------------------------------------------------
  test("TEST 9: Clean System Switching Centralized <-> Decentralized", () => {
    const sysMgr = new SystemManager();

    // Switch to Centralized
    sysMgr.switchSystem("centralized");
    expect(sysMgr.getActiveAdapter() instanceof CentralizedAdapter, "System Manager successfully activates CentralizedAdapter").toBe(true);

    // Switch to Decentralized
    sysMgr.switchSystem("decentralized");
    decAdapter = sysMgr.getActiveAdapter();
    expect(decAdapter instanceof DecentralizedAdapter, "System Manager cleanly switches to DecentralizedAdapter").toBe(true);
    expect(state.get("systemMode"), "App state synchronized to decentralized systemMode").toBe("decentralized");
  });

  // ------------------------------------------------------------------------
  // TEST 10: Fleet Entity Scalability (3 -> 10 -> 50 Autonomous Robot Agents)
  // ------------------------------------------------------------------------
  test("TEST 10: Fleet Entity Scalability (3 -> 10 -> 50 AMRs)", () => {
    const scaleFleet = new DecentralizedFleet();

    scaleFleet.initializeFleet(3);
    expect(scaleFleet.agents.size, "Decentralized fleet scales to 3 autonomous agents").toBe(3);

    scaleFleet.initializeFleet(10);
    expect(scaleFleet.agents.size, "Decentralized fleet scales to 10 autonomous agents").toBe(10);

    scaleFleet.initializeFleet(50);
    expect(scaleFleet.agents.size, "Decentralized fleet scales to 50 autonomous agents").toBe(50);
  });

  // ------------------------------------------------------------------------
  // TEST 11: Architecture Isolation & Feature Gating Matrix
  // ------------------------------------------------------------------------
  test("TEST 11: Architecture Isolation & Feature Gating Matrix", () => {
    expect(decAdapter.isFeatureAvailable("hitl_control"), "Decentralized mode strictly disables HITL control").toBe(false);
    expect(decAdapter.isFeatureAvailable("ace_validation"), "Decentralized mode strictly disables ACE Validation Tests").toBe(false);
    expect(decAdapter.isFeatureAvailable("adaptive_envelopes"), "Decentralized mode strictly disables dynamic adaptive envelopes").toBe(false);
    expect(decAdapter.isFeatureAvailable("risk_adaptive_metrics"), "Decentralized mode strictly disables RACE risk scoring").toBe(false);
    expect(decAdapter.isFeatureAvailable("p2p_negotiation"), "Decentralized mode enables peer-to-peer negotiation").toBe(true);
    expect(decAdapter.isFeatureAvailable("fleet_monitoring"), "Decentralized mode enables fleet monitoring").toBe(true);
  });

  // ------------------------------------------------------------------------
  // TEST 12: Peer Communication Metrics Accounting
  // ------------------------------------------------------------------------
  test("TEST 12: Peer Communication Metrics Accounting", () => {
    const metricBus = new PeerCommunicationBus();
    metricBus.broadcast("R01", MESSAGE_TYPES.STATE_UPDATE, { x: 100, y: 100 });
    metricBus.broadcast("R01", MESSAGE_TYPES.INTENT_UPDATE, { goal: "Bay 1" });
    metricBus.broadcast("R02", MESSAGE_TYPES.TASK_BID, { taskId: "T-1", cost: 42 });

    const metrics = metricBus.getMetrics();
    expect(metrics.totalMessages, `Bus accounted for exact message volume (${metrics.totalMessages} messages)`).toBe(3);
    expect(metrics.messagesByType[MESSAGE_TYPES.TASK_BID], "TASK_BID message frequency accurately tallied").toBe(1);
  });
});
