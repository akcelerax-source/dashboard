// ==========================================================================
// NODEX - System 3: NodeX Edge AI ACE decentralized (feature gating adapter)
// Full Adaptive Coordination Envelope & Risk-Adaptive Coordination Engine
// ==========================================================================

import { CoordinationSystemAdapter } from "./CoordinationSystemAdapter.js";
import { decentralizedFleet } from "../decentralized/DecentralizedFleet.js";

export class AceAdapter extends CoordinationSystemAdapter {
  constructor() {
    super("ace", "NodeX Edge AI ACE decentralized");
    this.raceStates = ["LOCAL", "NEIGHBORHOOD", "CONTAINMENT", "SAFE-DEGRADED"];
    this.fleet = decentralizedFleet;
  }

  isFeatureAvailable(featureKey) {
    return super.isFeatureAvailable(featureKey);
  }

  getFeatureUnavailableReason(featureKey) {
    return super.getFeatureUnavailableReason(featureKey);
  }

  getRobots() {
    return this.fleet.getGlobalFleetState();
  }

  getTasks() {
    return {
      active: this.fleet.getActiveTasks(),
      completed: this.fleet.getCompletedTasks()
    };
  }

  getEvents() {
    return this.fleet.getEvents();
  }

  getRunStats() {
    return this.fleet.getRunStats();
  }

  getActiveSessions() {
    return this.fleet.getActiveSessions();
  }

  getContracts() {
    return this.fleet.getContracts ? this.fleet.getContracts() : [];
  }

  getLiveAceTelemetry() {
    return this.fleet.getLiveAceTelemetry();
  }

  getAceTelemetryContract() {
    return {
      envelopeStates: this.raceStates,
      riskComponents: [
        "conflict",
        "uncertainty",
        "commRisk",
        "queueGrowth",
        "cascadePressure"
      ],
      hysteresisState: {
        expandThreshold: 0.50,
        containThreshold: 0.70,
        contractThreshold: 0.35,
        dwellTimeSeconds: 4.0
      },
      hitlScopes: ["ENTIRE_FLEET", "ROBOT_GROUP", "INDIVIDUAL_ROBOT"]
    };
  }

  sendHitlCommand(scope, target, command) {
    if (!this.isFeatureAvailable("hitl")) {
      return { success: false, error: "HITL is disabled in this mode." };
    }

    const upperScope = (scope || "").toUpperCase();
    let targetIds = [];

    if (upperScope === "FLEET" || upperScope === "ENTIRE_FLEET") {
      targetIds = Array.isArray(target) ? target : ["ALL_ACTIVE_AMRS"];
      return {
        success: true,
        status: "DISPATCHED",
        scope: "ENTIRE_FLEET",
        targetIds,
        command,
        timestamp: new Date().toISOString()
      };
    }

    if (upperScope === "GROUP" || upperScope === "ROBOT_GROUP") {
      if (!Array.isArray(target) || target.length === 0) {
        return { success: false, error: "HITL Robot Group target is empty." };
      }
      return {
        success: true,
        status: "DISPATCHED",
        scope: "ROBOT_GROUP",
        targetIds: target,
        command,
        timestamp: new Date().toISOString()
      };
    }

    if (upperScope === "INDIVIDUAL" || upperScope === "INDIVIDUAL_ROBOT") {
      const singleTarget = Array.isArray(target) ? target[0] : target;
      if (!singleTarget) {
        return { success: false, error: "HITL Individual Robot target is not specified." };
      }
      return {
        success: true,
        status: "DISPATCHED",
        scope: "INDIVIDUAL_ROBOT",
        targetIds: [singleTarget],
        command,
        timestamp: new Date().toISOString()
      };
    }

    return { success: false, error: `Invalid HITL Scope: ${scope}` };
  }
}
