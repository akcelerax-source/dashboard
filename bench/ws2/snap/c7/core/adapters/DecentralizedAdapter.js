// ==========================================================================
// NODEX ACE — System B: Decentralized Coordinator Adapter (Without ACE)
// Standard peer-to-peer distributed coordination without adaptive envelope
// Bridges Autonomous Robot Agents & Peer Bus with Dashboard Layer C
// ==========================================================================

import { CoordinationSystemAdapter } from "./CoordinationSystemAdapter.js";
import { decentralizedFleet } from "../decentralized/DecentralizedFleet.js";
import { peerCommunicationBus } from "../decentralized/PeerCommunicationBus.js";

export class DecentralizedAdapter extends CoordinationSystemAdapter {
  constructor() {
    super("decentralized", "Decentralized (Standard P2P)");
    this.fleet = decentralizedFleet;
    this.peerBus = peerCommunicationBus;
    this.connectionState = "CONNECTED";
    this.connectionEndpoint = "mesh://p2p-fleet-bus";
    this.fixedNeighborhoodRadius = 40; // Static 40m radius
  }

  isFeatureAvailable(featureKey) {
    return super.isFeatureAvailable(featureKey);
  }

  getFeatureUnavailableReason(featureKey) {
    return super.getFeatureUnavailableReason(featureKey);
  }

  getP2PNetworkStatus() {
    const busMetrics = this.peerBus.getMetrics();
    return {
      status: this.isConnected() ? "Active Mesh" : "Awaiting P2P Telemetry",
      architecture: "Standard Peer-to-Peer without ACE",
      neighborhoodRadius: "40 m (Fixed static radius)",
      adaptationCapability: "None (Fixed communication window)",
      totalPeerMessages: busMetrics.totalMessages,
      coordinationEvents: busMetrics.coordinationEventsCount
    };
  }

  getSystemState() {
    return {
      systemId: this.systemId,
      systemName: this.systemName,
      connectionState: this.connectionState,
      telemetrySource: "Decentralized Mesh (Autonomous Robot Agents)",
      isLive: this.isConnected(),
      stats: this.fleet.getRunStats()
    };
  }

  getFleetState() {
    const robots = this.fleet.getGlobalFleetState();
    return {
      connectedCount: robots.length,
      telemetryStatus: "Active Mesh Streaming",
      robots
    };
  }

  getRobotState(robotId) {
    return this.fleet.getRobot(robotId);
  }

  getActiveTasks() {
    return this.fleet.getActiveTasks();
  }

  getCompletedTasks() {
    return this.fleet.getCompletedTasks();
  }

  getContracts() {
    return this.fleet.getContracts ? this.fleet.getContracts() : [];
  }

  getConflicts() {
    // Collect conflicts detected by individual agents
    const conflicts = [];
    for (const agent of this.fleet.agents.values()) {
      if (agent.localState.status === "WAITING" && agent.localState.isYielding) {
        conflicts.push({
          id: `CONF-${agent.robotId}`,
          status: "Yielding",
          loserId: agent.robotId,
          reason: "Decentralized peer corridor arbitration"
        });
      }
    }
    return conflicts;
  }

  getEvents() {
    return this.fleet.getEvents();
  }

  getRunStats() {
    return this.fleet.getRunStats();
  }
}
