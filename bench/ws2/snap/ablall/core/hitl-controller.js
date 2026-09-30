// ==========================================================================
// NODEX ACE — Human-in-the-Loop (HITL) Controller & Safety Arbiter
// 3-Scope Arbitrated Teleoperation, Supervisory Control & Audit Trail
// Scopes: ENTIRE_FLEET | ROBOT_GROUP | INDIVIDUAL_ROBOT
// Actions: HOLD | RESUME | SAFE_STOP | SPEED_LIMIT | REROUTE
// ==========================================================================

import { state } from "./state.js";
import { simEngine } from "./sim-engine.js";
import { systemManager } from "./adapters/SystemManager.js";
import { decentralizedFleet } from "./decentralized/DecentralizedFleet.js";

export const HITL_SCOPES = {
  ENTIRE_FLEET: "ENTIRE_FLEET",
  ROBOT_GROUP: "ROBOT_GROUP",
  INDIVIDUAL_ROBOT: "INDIVIDUAL_ROBOT"
};

export const HITL_ACTIONS = {
  HOLD: "hold",
  RESUME: "resume",
  SAFE_STOP: "safe_stop",
  SPEED_LIMIT: "speed_limit",
  REROUTE: "reroute"
};

export class HitlController {
  constructor() {
    this.robotOverrides = new Map(); // robotId -> { mode: "AUTONOMOUS" | "HITL" | "SAFE", speedLimit: null }
  }

  getAuditLog() {
    return state.get("hitlAuditLog") || [];
  }

  clearAuditLog() {
    state.set("hitlAuditLog", []);
  }

  getRobotOverride(robotId) {
    return this.robotOverrides.get(robotId) || { mode: "AUTONOMOUS", speedLimit: null };
  }

  /**
   * Dispatch an arbitrated HITL supervisory command
   * @param {Object} params
   * @param {string} params.scope - "ENTIRE_FLEET" | "ROBOT_GROUP" | "INDIVIDUAL_ROBOT" (or "fleet" | "group" | "individual")
   * @param {string|Array<string>} params.targets - Robot ID or list of Robot IDs
   * @param {string} params.action - "hold" | "resume" | "safe_stop" | "speed_limit" | "reroute"
   * @param {string} [params.reason] - Operator rationale for audit trail
   * @param {number} [params.speedLimitVal] - Speed limit value if action is speed_limit
   */
  dispatchCommand({ scope, targets, action, reason = "Manual operator intervention", speedLimitVal = 0.5 }) {
    const rawScope = (scope || "").toUpperCase();
    let normalizedScope = HITL_SCOPES.ENTIRE_FLEET;
    if (rawScope.includes("GROUP")) normalizedScope = HITL_SCOPES.ROBOT_GROUP;
    else if (rawScope.includes("INDIVIDUAL") || rawScope === "ROBOT") normalizedScope = HITL_SCOPES.INDIVIDUAL_ROBOT;

    const robots = state.get("robots") || [];
    let targetIds = [];

    if (normalizedScope === HITL_SCOPES.ENTIRE_FLEET) {
      targetIds = robots.map(r => r.id);
    } else if (normalizedScope === HITL_SCOPES.ROBOT_GROUP) {
      targetIds = Array.isArray(targets) ? targets : [targets].filter(Boolean);
    } else {
      const singleId = Array.isArray(targets) ? targets[0] : (targets || state.get("selectedRobotId") || "R01");
      targetIds = [singleId];
    }

    // Armed gate at the controller, not only in the UI: a disarmed console
    // may only release robots (resume), never issue new interventions.
    const isRelease = action === "resume" || action === "RESUME";
    const adapter = systemManager.getActiveAdapter();
    // HITL exists only in NodeX Edge AI ACE decentralized. The check is on the
    // architecture that actually runs (engine controller), not on the UI.
    const runningSystem = simEngine.activeController || state.get("systemMode");
    const adapterResult = runningSystem !== "ace"
      ? { success: false, error: "HITL is available only in NodeX Edge AI ACE decentralized" }
      : !state.get("hitlEnabled") && !isRelease
        ? { success: false, error: "HITL is disarmed; arm HITL before issuing interventions" }
        : adapter.sendHitlCommand(normalizedScope, targetIds, action);

    // If adapter rejects (e.g. Non-ACE mode gated)
    if (!adapterResult.success) {
      const errorEntry = {
        id: `HITL-${Date.now().toString().slice(-5)}`,
        timestamp: new Date().toISOString(),
        scope: normalizedScope,
        targetIds,
        action,
        reason,
        success: false,
        error: adapterResult.error || "Command rejected by safety coordination layer"
      };

      const auditLog = state.get("hitlAuditLog") || [];
      state.set("hitlAuditLog", [errorEntry, ...auditLog].slice(0, 50));
      state.set("hitlCommandStatus", {
        msg: `REJECTED: ${errorEntry.error}`,
        type: "stop"
      });

      return { success: false, error: errorEntry.error };
    }

    // Apply the command to the authoritative robot state. simEngine.updateRobot
    // writes through to the RobotAgent's localState in Decentralized/ACE mode;
    // mutating the state.robots snapshot alone was discarded on the next tick,
    // which made HOLD/SAFE-STOP/SPEED-LIMIT no-ops. The engine honours the
    // hitlHold / hitlSpeedLimit flags every tick until RESUME clears them.
    const isCentralized = false; // unreachable for non-ACE systems (rejected above)
    for (const id of targetIds) {
      const r = robots.find(x => x.id === id);
      if (!r) continue;
      if (action === "hold" || action === "HOLD_ALL") {
        simEngine.updateRobot(id, { hitlHold: true, velocity: 0, isYielding: true });
        this.robotOverrides.set(id, { mode: "HITL", speedLimit: 0 });
      } else if (action === "resume" || action === "RESUME") {
        const patch = { hitlHold: false, hitlSpeedLimit: null, isYielding: false };
        if (["STOPPED", "error", "ERROR"].includes(r.status)) patch.status = "IDLE";
        simEngine.updateRobot(id, patch);
        this.robotOverrides.set(id, { mode: "AUTONOMOUS", speedLimit: null });
      } else if (action === "safe_stop" || action === "SAFE_STOP") {
        simEngine.updateRobot(id, { hitlHold: true, velocity: 0, status: "error", isYielding: true });
        // Declare the robot failed so peers release and re-auction its task.
        if (!isCentralized) decentralizedFleet.handleRobotFailure(id, "HITL operator safe stop");
        this.robotOverrides.set(id, { mode: "SAFE", speedLimit: 0 });
      } else if (action.startsWith("SPEED_LIMIT") || action === "speed_limit") {
        const limit = typeof speedLimitVal === "number" ? speedLimitVal : 0.5;
        simEngine.updateRobot(id, { hitlSpeedLimit: limit, targetVelocity: limit, velocity: Math.min(r.velocity || 0, limit) });
        this.robotOverrides.set(id, { mode: "HITL", speedLimit: limit });
      }
    }

    state.set("robots", [...robots]);
    // Counted in the ACE run's metrics (System 3 only reaches this point).
    decentralizedFleet.hitlActions += targetIds.length ? 1 : 0;

    // Record verified audit log entry
    const auditEntry = {
      id: `HITL-${Date.now().toString().slice(-5)}`,
      timestamp: new Date().toISOString(),
      timeFormatted: new Date().toLocaleTimeString(),
      scope: normalizedScope,
      targetIds,
      action: action.toUpperCase(),
      reason,
      operator: "Operator",
      success: true
    };

    const auditLog = state.get("hitlAuditLog") || [];
    state.set("hitlAuditLog", [auditEntry, ...auditLog].slice(0, 50));

    const targetSummary = targetIds.length === robots.length ? "All Fleet AMRs" : `${targetIds.length} AMR(s) (${targetIds.slice(0, 3).join(", ")}${targetIds.length > 3 ? "..." : ""})`;
    state.set("hitlCommandStatus", {
      msg: `Dispatched [${action.toUpperCase()}] to ${targetSummary} at ${auditEntry.timeFormatted}`,
      type: action.includes("stop") ? "stop" : "success"
    });

    simEngine.addEvent("HITL", action.toUpperCase(), `Operator command dispatched to ${targetSummary} (${reason})`);

    return {
      success: true,
      auditEntry
    };
  }
}

export const hitlController = new HitlController();
