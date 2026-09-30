// ==========================================================================
// NODEX ACE - Reactive Application State Manager
// ==========================================================================

// Supported Global Robot Counts: 3 -> 10 -> 50 -> 100
export const SUPPORTED_ROBOT_COUNTS = [3, 10, 50, 100];

export const SYSTEM_NAMES = {
  centralized: "Centralized",
  decentralized: "Decentralized",
  ace: "NodeX Edge AI ACE decentralized"
};

// Run-defining configuration. While a run is active (configLocked === true)
// writes to these keys are rejected at the store level, so no UI surface
// (Operations, Control, Settings, Explain) can change a run mid-flight.
export const CONFIG_LOCKED_KEYS = ["robotCount", "fleetSize", "systemMode", "selectedSystem", "selectedScenario", "selectedMap", "simTestType"];

// Canonical HITL scopes. Legacy short forms are normalized on write so every
// screen reads the same value.
const HITL_SCOPE_ALIASES = {
  fleet: "ENTIRE_FLEET", entire_fleet: "ENTIRE_FLEET",
  group: "ROBOT_GROUP", robot_group: "ROBOT_GROUP",
  individual: "INDIVIDUAL_ROBOT", robot: "INDIVIDUAL_ROBOT", individual_robot: "INDIVIDUAL_ROBOT"
};
export function normalizeHitlScope(scope) {
  return HITL_SCOPE_ALIASES[String(scope || "").toLowerCase()] || "ENTIRE_FLEET";
}

export function getNextRobotCount(current) {
  const num = parseInt(current, 10);
  const idx = SUPPORTED_ROBOT_COUNTS.indexOf(num);
  if (idx === -1 || idx === SUPPORTED_ROBOT_COUNTS.length - 1) {
    return SUPPORTED_ROBOT_COUNTS[0];
  }
  return SUPPORTED_ROBOT_COUNTS[idx + 1];
}

class AppState {
  constructor() {
    this.listeners = new Map();

    // 1. Load UI preferences from localStorage (safeguarded for Node.js test env)
    const hasStorage = typeof localStorage !== "undefined";
    const savedTheme = hasStorage ? (localStorage.getItem("nodex_theme") || "dark") : "dark";
    const savedTimeFormat = hasStorage ? (localStorage.getItem("nodex_time_format") || "24-hour") : "24-hour";
    const savedAutoRefresh = hasStorage ? (localStorage.getItem("nodex_auto_refresh") !== "false") : true;
    const savedRawCount = hasStorage
      ? parseInt(localStorage.getItem("nodex_robot_count") || localStorage.getItem("nodex_fleet_size") || "50", 10)
      : 50;
    const savedRobotCount = SUPPORTED_ROBOT_COUNTS.includes(savedRawCount) ? savedRawCount : 50;
    
    // No accounts or profiles exist: drop identity data an older build stored.
    if (hasStorage) {
      try { localStorage.removeItem("nodex_user"); } catch (e) {}
    }

    this.data = {
      // Global navigation & Settings
      activeTab: "operations", // operations | coordination | control | experiments
      theme: savedTheme,       // light | dark | auto
      timeFormat: savedTimeFormat, // 12-hour | 24-hour
      autoRefresh: savedAutoRefresh, // boolean

      // Authoritative System Mode (Centralized, Decentralized, ACE)
      selectedSystem: "ace",   // centralized | decentralized | ace
      systemMode: "ace",       // mirrored alias for backwards compatibility
      robotCount: savedRobotCount, // 3 | 10 | 50 | 100
      fleetSize: savedRobotCount,  // mirrored alias for backwards compatibility
      selectedMap: "WH-A",
      selectedScenario: "S01",
      simSpeed: 1.0,           // 0.25, 0.5, 1.0, 2.0, 5.0
      simRunning: false,
      simTestType: "scenario", // "scenario" | "aceTest"
      simTestResult: "NOT_STARTED", // NOT_STARTED | RUNNING | PASSED | FAILED
      simActiveConfig: null,
      simScenarioConditions: null,
      simTimeSeconds: 0,       // Starts from real timeline baseline
      tickRate: 100,           // Hz
      runId: null,             // Issued by the lifecycle on Start (no fake default run)
      configLocked: false,     // true while a run is active (see CONFIG_LOCKED_KEYS)
      seed: 18427,
      
      // Real Integration & Connection State (Separating UI selection from live connection)
      connectionState: "DISCONNECTED", // CONNECTED | CONNECTING | DISCONNECTED | ERROR
      // The fleet runs in the in-browser simulation engine; the optional
      // FastAPI / ROS 2 bridge (backend/server.py) is not connected.
      connectionStatus: "Local simulation: fleets run in the in-browser simulation engine. No external backend / ROS 2 bridge is connected (none is needed).",
      connectionHz: 0,

      // Architecture-Specific Coordination State
      coordination: {
        // RACE Risk-Adaptive Coordination Engine
        raceStatus: "INACTIVE", // ACTIVE | INACTIVE | DEGRADED
        raceMode: "OFF",        // OFF | LOCAL | NEIGHBORHOOD | CONTAINMENT | SAFE-DEGRADED
        activeEnvelopes: [],    // Active coordination envelopes {robotId, radius, state, scope}
        raceRiskComponents: null, // {conflict, uncertainty, commRisk, queueGrowth, cascadePressure}
        
        // Centralized Coordination
        centralServer: {
          status: "OFFLINE", // ONLINE | OFFLINE | DEGRADED
          coordinatorNode: "Central-Coord-01",
          activeRadioChannels: 0,
          singlePointOfFailureRisk: "High"
        },
        
        // Decentralized P2P
        peerNetwork: {
          status: "OFFLINE", // ONLINE | OFFLINE | DEGRADED
          neighborhoodRadius: 40, // Fixed radius for standard decentralized
          totalPeerMessages: 0,
          coordinationEvents: 0,
          activeContracts: 0
        },
        
        // ACE Adaptive Coordination
        ace: {
          status: "OFFLINE", // ONLINE | OFFLINE | DEGRADED
          adaptiveEnvelope: true,
          hysteresisEnabled: true,
          dwellTimeSeconds: 4.0,
          thresholds: {
            localEnter: 0.50,
            neighborhoodEnter: 0.70,
            containmentExit: 0.55,
            neighborhoodExit: 0.35,
            degradedEnter: 0.85,
            degradedExit: 0.68
          }
        }
      },

      // Human In The Loop (HITL) - Three Scopes Architecture
      hitlEnabled: false,
      hitlMode: "OFF",         // OFF | MONITOR | APPROVE | LEASED
      hitlScope: "ENTIRE_FLEET", // ENTIRE_FLEET | ROBOT_GROUP | INDIVIDUAL_ROBOT
      hitlSelectedGroup: [],   // Array of robot IDs selected in Group scope
      hitlSelectedRobot: "R01", // Robot ID target in Individual Robot scope
      hitlCommandStatus: null, // Feedback message for last dispatched operator command
      hitlLease: null,         // { operatorId, robotId, expiresAt, token }
      hitlAuditLog: [],        // Audit history of all HITL commands

      // Authoritative Single Run Configuration (shared across all tabs)
      runConfig: {
        run_id: null,
        system_id: "ace",
        system_name: SYSTEM_NAMES["ace"],
        scenario_id: "S01",
        scenario_name: "Corridor Crossing Conflict",
        ace_test_id: null,
        fleet_size: savedRobotCount,
        map_id: "WH-A",
        map_version: "2.1.0",
        software_version: "NODEX-0.9.3",
        controller_version: "ACE-RACE-v1.4",
        seed: 18427,
        created_at: Date.now(),
        started_at: null,
        status: "IDLE"
      },

      // Simulation Lifecycle & Diagnostics
      simLifecycleState: "IDLE", // IDLE | STARTING | RUNNING | PAUSED | STOPPING | STOPPED | FINISHED | ERROR
      simLifecycleError: null,
      simDiagnostics: [],      // Step-by-step diagnostic checks

      // Selection & Inspection
      selectedRobotId: "R01",
      selectedSessionId: "S-001",
      selectedConflictId: null,

      // Live Telemetry (Populated strictly from real source or kinematics layer)
      robots: [],
      tasks: [],
      activeSessions: [],
      contracts: [],
      activeFaults: [],
      events: [],
      
      // Coordination Metrics (Honest non-fabricated defaults)
      coordinationStats: {
        activeSessionsCount: 0,
        avgNegotiationTime: "Awaiting telemetry",
        deadlocksCount: "No validated run",
        successfulResolutionsPct: "Awaiting telemetry",
        history: []
      },

      // Global Operational KPIs (Fabricated percentages removed)
      kpis: {
        activeRobots: 0,
        idleRobots: 0,
        activeTasks: 0,
        totalTasks: 0,
        throughput: "Awaiting telemetry",
        systemHealth: "Awaiting telemetry",
        activeAlerts: 0
      },

      // Map View Settings
      mapViewMode: "2D",       // 2D | 3D
      mapConfig: null,         // Current adaptive map configuration
      mapLayers: {
        taskPaths: true,
        coordinationEnvelopes: true,
        riskZones: true,
        communicationLinks: false,
        spaceTimeContracts: false,
        intentGoals: false,
        trafficHeatmap: false,
        obstacles: true
      },

      // Environment Settings
      envSettings: {
        dynamicHumans: true,
        dynamicObstacles: true,
        variableTaskArrival: true,
        realisticTraffic: true
      }
    };
  }

  get(key) {
    if (key === "fleetSize") return this.data.robotCount;
    if (key === "selectedSystem") return this.data.systemMode;
    return this.data[key];
  }

  set(key, value) {
    if (this.data.configLocked && CONFIG_LOCKED_KEYS.includes(key)) {
      const current = this.get(key);
      if (current !== value) {
        console.warn(`[AppState] Rejected change of "${key}" while a run is active (config locked).`);
        this.emit("configChangeRejected", { key, value, current });
        return false;
      }
      return true;
    }

    if (key === "hitlScope") {
      value = normalizeHitlScope(value);
    }

    if (key === "robotCount" || key === "fleetSize") {
      const parsed = parseInt(value, 10);
      const validCount = (!isNaN(parsed) && parsed >= 1 && parsed <= 100) ? parsed : (SUPPORTED_ROBOT_COUNTS.includes(parsed) ? parsed : 50);
      const oldCount = this.data.robotCount;
      this.data.robotCount = validCount;
      this.data.fleetSize = validCount;
      if (this.data.runConfig) {
        this.data.runConfig.fleet_size = validCount;
      }
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("nodex_robot_count", String(validCount));
        localStorage.setItem("nodex_fleet_size", String(validCount));
      }
      this.emit("robotCount", validCount, oldCount);
      this.emit("fleetSize", validCount, oldCount);
      this.emit("runConfig", this.data.runConfig);
      return;
    }

    if (key === "systemMode" || key === "selectedSystem") {
      const validMode = ["centralized", "decentralized", "ace"].includes(value?.toLowerCase())
        ? value.toLowerCase()
        : "ace";
      const oldMode = this.data.systemMode;
      this.data.systemMode = validMode;
      this.data.selectedSystem = validMode;
      if (this.data.runConfig) {
        this.data.runConfig.system_id = validMode;
        this.data.runConfig.system_name = SYSTEM_NAMES[validMode] || validMode;
      }

      // System transition safety: disarm HITL if leaving ACE
      if (validMode !== "ace" && this.data.hitlEnabled) {
        this.data.hitlEnabled = false;
        this.data.hitlMode = "OFF";
        this.emit("hitlEnabled", false, true);
        this.emit("hitlMode", "OFF", "ON");
      }

      // Reset architecture-specific coordination state for the new mode
      this.resetCoordinationForMode(validMode);

      this.emit("systemMode", validMode, oldMode);
      this.emit("selectedSystem", validMode, oldMode);
      this.emit("runConfig", this.data.runConfig);
      return;
    }

    if (key === "selectedScenario" && this.data.runConfig) {
      this.data.runConfig.scenario_id = value;
      this.emit("runConfig", this.data.runConfig);
    } else if (key === "runId" && this.data.runConfig) {
      this.data.runConfig.run_id = value;
      this.emit("runConfig", this.data.runConfig);
    } else if (key === "simLifecycleState" && this.data.runConfig) {
      this.data.runConfig.status = value;
      this.emit("runConfig", this.data.runConfig);
    }

    const oldValue = this.data[key];
    this.data[key] = value;
    this.emit(key, value, oldValue);
  }

  getRunConfig() {
    return { ...this.data.runConfig };
  }

  updateRunConfig(partial) {
    if (!this.data.runConfig) return;
    this.data.runConfig = {
      ...this.data.runConfig,
      ...partial
    };
    this.emit("runConfig", this.data.runConfig);
  }

  /**
   * Resets architecture-specific coordination state when system mode changes.
   * (Previously also named updateCoordinationState, so the partial-merge method
   * below silently shadowed it and mode switches never reset RACE/network state.)
   */
  resetCoordinationForMode(mode) {
    const coord = this.data.coordination;
    const isRunning = this.data.simRunning;
    const isOnline = isRunning ? "ONLINE" : "OFFLINE";

    // Reset all to baseline
    coord.raceStatus = "INACTIVE";
    coord.raceMode = "OFF";
    coord.activeEnvelopes = [];
    coord.raceRiskComponents = null;
    coord.centralServer.status = "OFFLINE";
    coord.peerNetwork.status = "OFFLINE";
    coord.ace.status = "OFFLINE";

    switch (mode) {
      case "centralized": {
        // CENTRALIZED: Central server authority, RACE INACTIVE
        coord.raceStatus = "INACTIVE";
        coord.raceMode = "OFF";
        coord.centralServer = {
          status: isOnline,
          coordinatorNode: "Central-Coord-01",
          activeRadioChannels: isRunning ? (this.data.robots?.length || 0) : 0,
          singlePointOfFailureRisk: "High (Central server outage halts all AMRs)"
        };
        coord.peerNetwork = {
          status: "OFFLINE",
          neighborhoodRadius: 40,
          totalPeerMessages: 0,
          coordinationEvents: 0,
          activeContracts: 0
        };
        coord.ace = {
          status: "OFFLINE",
          adaptiveEnvelope: false,
          hysteresisEnabled: false,
          dwellTimeSeconds: 4.0,
          thresholds: {}
        };
        break;
      }
      case "decentralized": {
        // DECENTRALIZED: P2P mesh, fixed neighborhood, RACE INACTIVE
        coord.raceStatus = "INACTIVE";
        coord.raceMode = "OFF";
        coord.centralServer = {
          status: "OFFLINE",
          coordinatorNode: "N/A",
          activeRadioChannels: 0,
          singlePointOfFailureRisk: "None (No central server)"
        };
        coord.peerNetwork = {
          status: isOnline,
          neighborhoodRadius: 40, // Fixed static radius
          totalPeerMessages: 0,
          coordinationEvents: 0,
          activeContracts: 0
        };
        coord.ace = {
          status: "OFFLINE",
          adaptiveEnvelope: false,
          hysteresisEnabled: false,
          dwellTimeSeconds: 4.0,
          thresholds: {}
        };
        break;
      }
      case "ace": {
        // ACE: Decentralized + ACE/RACE, RACE ACTIVE
        coord.raceStatus = isRunning ? "ACTIVE" : "INACTIVE";
        coord.raceMode = isRunning ? "LOCAL" : "OFF";
        coord.centralServer = {
          status: "OFFLINE",
          coordinatorNode: "N/A",
          activeRadioChannels: 0,
          singlePointOfFailureRisk: "None (No central server)"
        };
        coord.peerNetwork = {
          status: isOnline,
          neighborhoodRadius: "Adaptive (RACE-driven)",
          totalPeerMessages: 0,
          coordinationEvents: 0,
          activeContracts: 0
        };
        coord.ace = {
          status: isOnline,
          adaptiveEnvelope: true,
          hysteresisEnabled: true,
          dwellTimeSeconds: 4.0,
          thresholds: {
            localEnter: 0.50,
            neighborhoodEnter: 0.70,
            containmentExit: 0.55,
            neighborhoodExit: 0.35,
            degradedEnter: 0.85,
            degradedExit: 0.68
          }
        };
        break;
      }
    }

    // Emit coordination state change
    this.emit("coordination", { ...coord });
  }

  /**
   * Partial update for coordination state during simulation ticks.
   * Merges provided fields with existing coordination state.
   * @param {Object} partial - Partial coordination state to merge
   */
  updateCoordinationState(partial) {
    if (!partial || typeof partial !== "object") return;

    const coord = this.data.coordination;
    if (!coord) return;

    // Deep merge partial updates
    if (partial.centralServer) {
      coord.centralServer = { ...coord.centralServer, ...partial.centralServer };
    }
    if (partial.peerNetwork) {
      coord.peerNetwork = { ...coord.peerNetwork, ...partial.peerNetwork };
    }
    if (partial.ace) {
      coord.ace = { ...coord.ace, ...partial.ace };
    }
    if (partial.activeEnvelopes !== undefined) {
      coord.activeEnvelopes = partial.activeEnvelopes;
    }
    if (partial.raceStatus !== undefined) {
      coord.raceStatus = partial.raceStatus;
    }
    if (partial.raceMode !== undefined) {
      coord.raceMode = partial.raceMode;
    }
    if (partial.raceRiskComponents !== undefined) {
      coord.raceRiskComponents = partial.raceRiskComponents;
    }

    // Emit coordination state change
    this.emit("coordination", { ...coord });
  }

  update(updates) {
    for (const [k, v] of Object.entries(updates)) {
      this.set(k, v);
    }
  }

  subscribe(key, callback) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key).add(callback);
    return () => this.listeners.get(key).delete(callback);
  }

  emit(key, newValue, oldValue) {
    if (this.listeners.has(key)) {
      for (const cb of this.listeners.get(key)) {
        try {
          cb(newValue, oldValue);
        } catch (err) {
          console.error(`State callback error on key [${key}]:`, err);
        }
      }
    }
    // Wildcard subscriber for any state changes
    if (this.listeners.has("*")) {
      for (const cb of this.listeners.get("*")) {
        cb(key, newValue, oldValue);
      }
    }
  }

  applyTheme(theme) {
    if (typeof document === "undefined" || !document.body) return;
    const isDark = theme === "dark" || (theme === "auto" && typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (isDark) {
      document.body.classList.add("theme-dark");
      document.body.classList.remove("theme-light");
    } else {
      document.body.classList.add("theme-light");
      document.body.classList.remove("theme-dark");
    }
  }
}

export const state = new AppState();

// Initialize theme on document load
state.applyTheme(state.get("theme") || "dark");
state.subscribe("theme", (t) => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("nodex_theme", t);
  }
  state.applyTheme(t);
});

// Auto theme OS preference listener
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.get("theme") === "auto") {
      state.applyTheme("auto");
    }
  });
}
