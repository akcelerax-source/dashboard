// ==========================================================================
// NODEX ACE — System A: Centralized Coordinator Adapter
// Central fleet dispatch baseline (Single Point of Coordination)
// Bridges Centralized Coordinator & Execution Substrate with Dashboard Layer C
// ==========================================================================

import { CoordinationSystemAdapter } from "./CoordinationSystemAdapter.js";
import { centralizedCoordinator } from "../centralized/CentralizedCoordinator.js";
import { dashboardSimulationAdapter } from "./DashboardSimulationAdapter.js";
import { taskManager } from "../centralized/TaskManager.js";
import { conflictManager } from "../centralized/ConflictManager.js";

export class CentralizedAdapter extends CoordinationSystemAdapter {
  constructor() {
    super("centralized", "Centralized Fleet Coordinator");
    this.coordinator = centralizedCoordinator;
    this.executionAdapter = dashboardSimulationAdapter;
    this.coordinator.setExecutionAdapter(this.executionAdapter);

    this.connectionState = "CONNECTED";
    this.connectionEndpoint = "internal://simulation-coordinator";
  }

  isFeatureAvailable(featureKey) {
    return super.isFeatureAvailable(featureKey);
  }

  getFeatureUnavailableReason(featureKey) {
    return super.getFeatureUnavailableReason(featureKey);
  }

  getCentralServerStatus() {
    return {
      status: this.isConnected() ? "Active" : "Awaiting Centralized Server connection",
      coordinatorNode: "Central-Coord-01",
      singlePointOfFailureRisk: "High (Central server outage halts all AMRs)",
      activeRadioChannels: this.isConnected() ? this.coordinator.getGlobalFleetState().length : 0
    };
  }

  getSystemState() {
    return {
      systemId: this.systemId,
      systemName: this.systemName,
      connectionState: this.connectionState,
      telemetrySource: "Centralized Coordinator (Simulation Engine)",
      isLive: this.isConnected(),
      stats: this.coordinator.getRunStats()
    };
  }

  getFleetState() {
    const robots = this.coordinator.getGlobalFleetState();
    return {
      connectedCount: robots.length,
      telemetryStatus: "Active Streaming",
      robots
    };
  }

  getRobotState(robotId) {
    return this.coordinator.getRobot(robotId);
  }

  getActiveTasks() {
    return taskManager.getActiveTasks();
  }

  getCompletedTasks() {
    return taskManager.getCompletedTasks();
  }

  getConflicts() {
    return conflictManager.getActiveConflictList();
  }

  getContracts() {
    return conflictManager.getActiveConflictList().map(c => ({
      id: `STC-CENTRAL-${c.id}`,
      resource: "Central Transit Corridor",
      timeWindow: {
        start: Date.now() / 1000,
        end: (Date.now() / 1000) + 5.0
      },
      owner: c.winnerId,
      participants: [c.winnerId, c.loserId],
      status: "ACTIVE",
      expiration: (Date.now() / 1000) + 5.0,
      conflictHandling: `Central priority arbitration: ${c.loserId} waiting for ${c.winnerId}`
    }));
  }

  getEvents() {
    return this.coordinator.getEvents();
  }

  getRunStats() {
    return this.coordinator.getRunStats();
  }
}
