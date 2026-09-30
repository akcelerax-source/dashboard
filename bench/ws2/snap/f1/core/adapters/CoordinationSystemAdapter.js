// ==========================================================================
// NODEX ACE - Coordination System Adapter Base Interface
// Standard abstract contract for Centralized, Decentralized, and ACE systems
// ==========================================================================

import { isCapabilitySupported, getCapabilityUnavailableReason, FEATURE_ALIAS_MAP } from "../capabilities.js";

export class CoordinationSystemAdapter {
  constructor(systemId, systemName) {
    this.systemId = systemId; // "centralized" | "decentralized" | "ace"
    this.systemName = systemName;
    this.connectionState = "DISCONNECTED"; // CONNECTED | CONNECTING | DISCONNECTED | ERROR
    this.connectionEndpoint = null;
    this.lastHeartbeat = null;
  }

  getSystemId() {
    return this.systemId;
  }

  getSystemName() {
    return this.systemName;
  }

  getConnectionState() {
    return this.connectionState;
  }

  isConnected() {
    return this.connectionState === "CONNECTED";
  }

  connect(endpoint) {
    this.connectionEndpoint = endpoint;
    this.connectionState = "CONNECTING";
    // Real WebSocket / ROS 2 bridge connection will be plugged in here
    return Promise.resolve({ status: "Connecting", endpoint });
  }

  disconnect() {
    this.connectionState = "DISCONNECTED";
    this.connectionEndpoint = null;
    return Promise.resolve({ status: "Disconnected" });
  }

  normalizeFeatureKey(key) {
    return FEATURE_ALIAS_MAP[key] || key;
  }

  // Feature Availability Query backed by Centralized Capability Registry
  isFeatureAvailable(featureKey) {
    return isCapabilitySupported(this.systemId, featureKey);
  }

  getFeatureUnavailableReason(featureKey) {
    return getCapabilityUnavailableReason(this.systemId, featureKey);
  }

  // Telemetry Retrieval Contracts
  getSystemState() {
    return {
      systemId: this.systemId,
      systemName: this.systemName,
      connectionState: this.connectionState,
      telemetrySource: this.isConnected() ? "ROS 2 / Gazebo Bridge" : "No live telemetry",
      isLive: this.isConnected()
    };
  }

  getFleetState() {
    return {
      connectedCount: this.isConnected() ? 0 : null,
      telemetryStatus: this.isConnected() ? "Streaming" : "Awaiting telemetry"
    };
  }

  getRobotState(robotId) {
    return null;
  }

  getActiveTasks() {
    return [];
  }

  getPaths() {
    return [];
  }

  getConflicts() {
    return [];
  }

  getHealth() {
    return {
      status: this.isConnected() ? "Nominal" : "Awaiting telemetry",
      score: this.isConnected() ? null : "N/A"
    };
  }

  getContracts() {
    return [];
  }

  // Command Execution Contracts (HITL / Operator Interface)
  sendHitlCommand(scope, target, command) {
    if (!this.isFeatureAvailable("hitl")) {
      return { success: false, error: this.getFeatureUnavailableReason("hitl") };
    }
    return { success: true, scope, target, command, timestamp: new Date().toISOString() };
  }

  sendFleetCommand(command) {
    if (!this.isFeatureAvailable("fleetCommand")) {
      return Promise.reject(new Error(this.getFeatureUnavailableReason("fleetCommand")));
    }
    return Promise.resolve({ success: true, target: "ALL_ROBOTS", command });
  }

  sendRobotGroupCommand(robotIds, command) {
    if (!this.isFeatureAvailable("groupCommand")) {
      return Promise.reject(new Error(this.getFeatureUnavailableReason("groupCommand")));
    }
    if (!robotIds || robotIds.length === 0) {
      return Promise.reject(new Error("Cannot dispatch command: No robots selected in group."));
    }
    return Promise.resolve({ success: true, target: robotIds, command });
  }

  sendIndividualRobotCommand(robotId, command) {
    if (!this.isFeatureAvailable("robotCommand")) {
      return Promise.reject(new Error(this.getFeatureUnavailableReason("robotCommand")));
    }
    if (!robotId) {
      return Promise.reject(new Error("Cannot dispatch command: Target robot ID is undefined."));
    }
    return Promise.resolve({ success: true, target: robotId, command });
  }
}
