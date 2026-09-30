// ==========================================================================
// NODEX ACE - Multi-System Manager & Safety Transition Arbiter
// Manages Centralized, Decentralized, and ACE/RACE adapters with strict gating
// ==========================================================================

import { state } from "../state.js";
import { CentralizedAdapter } from "./CentralizedAdapter.js";
import { DecentralizedAdapter } from "./DecentralizedAdapter.js";
import { AceAdapter } from "./AceAdapter.js";

export class SystemManager {
  constructor() {
    this.adapters = {
      centralized: new CentralizedAdapter(),
      decentralized: new DecentralizedAdapter(),
      ace: new AceAdapter()
    };

    const currentMode = state.get("systemMode") || "ace";
    this.activeAdapter = this.adapters[currentMode] || this.adapters.ace;

    // Listen to system mode changes
    state.subscribe("systemMode", (newMode, oldMode) => {
      this.handleSystemTransition(newMode, oldMode);
    });
  }

  getActiveAdapter() {
    return this.activeAdapter;
  }

  getSystemMode() {
    return this.activeAdapter.getSystemId();
  }

  isFeatureAvailable(featureKey) {
    return this.activeAdapter.isFeatureAvailable(featureKey);
  }

  getFeatureUnavailableReason(featureKey) {
    return this.activeAdapter.getFeatureUnavailableReason(featureKey);
  }

  switchSystem(newMode) {
    const oldMode = state.get("systemMode");
    const nextAdapter = this.adapters[newMode];
    if (nextAdapter) {
      this.activeAdapter = nextAdapter;
    }
    if (newMode !== oldMode) {
      state.set("systemMode", newMode);
      state.set("selectedSystem", newMode);
    }
  }

  /**
   * Safety Transition Logic when switching between systems
   * (e.g., from ACE to Centralized or Decentralized)
   */
  handleSystemTransition(newMode, oldMode) {
    console.log(`[SystemManager] Transitioning system: ${oldMode} -> ${newMode}`);

    const nextAdapter = this.adapters[newMode];
    if (!nextAdapter) {
      console.error(`[SystemManager] Unknown system mode: ${newMode}`);
      return;
    }

    this.activeAdapter = nextAdapter;

    // 1. If transitioning OUT of ACE mode:
    if (newMode !== "ace") {
      // Disarm and disable HITL immediately
      if (state.get("hitlEnabled")) {
        console.warn("[SystemManager] Disarming HITL as new system mode does not support ACE HITL.");
        state.set("hitlEnabled", false);
        state.set("hitlMode", "OFF");
      }

      // Close any open HITL or ACE-specific modals (if running in browser)
      if (typeof document !== "undefined") {
        const modalBackdrop = document.getElementById("hitl-backdrop");
        if (modalBackdrop) modalBackdrop.remove();

        const aceTestsBackdrop = document.getElementById("tests-modal-backdrop");
        if (aceTestsBackdrop) aceTestsBackdrop.remove();

        const singleTestBackdrop = document.getElementById("singletest-modal-backdrop");
        if (singleTestBackdrop) singleTestBackdrop.remove();
      }

      // Reset any active HITL leased robots back to autonomous and sanitize ACE telemetry
      const robots = state.get("robots") || [];
      for (const r of robots) {
        if (r.controlMode === "HUMAN") {
          r.controlMode = "AUTONOMOUS";
        }
        if (newMode === "centralized") r.coordinationScope = "Central server";
        // Systems 1 and 2 have no RACE / ACE state at all.
        r.raceState = null;
        r.riskScore = null;
        if (newMode === "centralized") r.envelopeRadius = 0;
        r.riskComponents = null;
        r.hitlHold = false;
        r.hitlSpeedLimit = null;
      }
      state.set("robots", [...robots]);
      state.set("activeSessions", []);
      state.set("contracts", []);
    }

    // 2. Notify subscribers of adapter change
    state.emit("systemAdapterChanged", this.activeAdapter);
  }
}

export const systemManager = new SystemManager();
