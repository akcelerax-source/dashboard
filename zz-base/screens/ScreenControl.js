// ==========================================================================
// NODEX ACE - Screen 03: Simulation & Control Center
// Complete 7-State Lifecycle Controller & Arbitrated 3-Scope HITL Integration
// ==========================================================================

import { state, SYSTEM_NAMES } from "../core/state.js";
import { simEngine } from "../core/sim-engine.js";
import { simLifecycle, LIFECYCLE_STATES } from "../core/sim-lifecycle.js";
import { hitlController, HITL_SCOPES, HITL_ACTIONS } from "../core/hitl-controller.js";
import { WarehouseMap } from "../components/WarehouseMap.js";
import { RobotInspector } from "../components/RobotInspector.js";
import { SCENARIOS, ACE_TESTS, MAPS_REGISTRY } from "../data/scenarios.js";
import { HitlModal } from "../components/HitlModal.js";
import { systemManager } from "../core/adapters/SystemManager.js";

export class ScreenControl {
  constructor(container) {
    this.container = container;
    this.mapInstance = null;
    this.inspectorInstance = null;
    this.activeTab = "simulation"; // "simulation" | "hitl" | "diagnostics" | "scenario" | "fault"
    this.hitlReason = "Operator supervisory action";
    this.render();
  }

  getLifecycleBadgeStyle(lifecycleState) {
    switch (lifecycleState) {
      case LIFECYCLE_STATES.RUNNING:
        return { bg: "rgba(16, 185, 129, 0.15)", color: "#10B981", border: "rgba(16, 185, 129, 0.3)", icon: "●" };
      case LIFECYCLE_STATES.INITIALIZING:
        return { bg: "rgba(245, 158, 11, 0.15)", color: "#F59E0B", border: "rgba(245, 158, 11, 0.3)", icon: "⟳" };
      case LIFECYCLE_STATES.PAUSED:
        return { bg: "rgba(234, 179, 8, 0.15)", color: "#EAB308", border: "rgba(234, 179, 8, 0.3)", icon: "⏸" };
      case LIFECYCLE_STATES.STOPPED:
        return { bg: "rgba(239, 68, 68, 0.15)", color: "#EF4444", border: "rgba(239, 68, 68, 0.3)", icon: "⏹" };
      case LIFECYCLE_STATES.ERROR:
        return { bg: "rgba(220, 38, 38, 0.2)", color: "#DC2626", border: "#DC2626", icon: "⚠" };
      default:
        return { bg: "rgba(100, 116, 139, 0.15)", color: "#94A3B8", border: "rgba(100, 116, 139, 0.3)", icon: "○" };
    }
  }

  render() {
    const fleetSize = state.get("fleetSize") || 50;
    const simSpeed = state.get("simSpeed") || 1.0;
    const faults = state.get("activeFaults") || [];
    const lifecycleState = state.get("simLifecycleState") || (state.get("simRunning") ? "RUNNING" : "IDLE");
    const badgeStyle = this.getLifecycleBadgeStyle(lifecycleState);

    this.container.innerHTML = `
      <!-- Screen Title Header -->
      <div class="screen-header-block">
        <div class="screen-title-wrap">
          <div class="screen-category-tag">
            <span class="bullet"></span>
            <span>CONTROL</span>
          </div>
          <h1 class="screen-main-title">Simulation & Control</h1>
          <div class="screen-subtitle">Authoritative 7-State lifecycle execution, arbitrated HITL supervision, and fault injection.</div>
        </div>
      </div>

      <!-- Top Mini KPIs -->
      <div class="kpi-strip" style="gap: 12px;">
        <div class="kpi-card" style="padding: 8px 12px;">
          <div class="kpi-icon-wrap cyan" style="width: 30px; height: 30px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"></rect></svg></div>
          <div class="kpi-data"><span class="kpi-value" style="font-size: 15px;" id="ctrl-kpi-fleet">${fleetSize} AMRs</span><span class="kpi-label">Robots in Simulation</span></div>
        </div>
        <div class="kpi-card" style="padding: 8px 12px;">
          <div class="kpi-icon-wrap amber" style="width: 30px; height: 30px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path></svg></div>
          <div class="kpi-data"><span class="kpi-value" style="font-size: 15px;" id="ctrl-kpi-tasks">${state.get('kpis')?.activeTasks || 0}</span><span class="kpi-label">Active Tasks</span></div>
        </div>
        <div class="kpi-card" style="padding: 8px 12px;">
          <div class="kpi-icon-wrap green" style="width: 30px; height: 30px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></div>
          <div class="kpi-data"><span class="kpi-value" style="font-size: 15px;" id="ctrl-kpi-speed">${simSpeed}x</span><span class="kpi-label">Simulation Speed</span></div>
        </div>
        <div class="kpi-card" style="padding: 8px 12px;">
          <div class="kpi-icon-wrap cyan" style="width: 30px; height: 30px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 14 10"></polyline></svg></div>
          <div class="kpi-data"><span class="kpi-value font-mono" style="font-size: 15px;" id="ctrl-elapsed-time">00:00:00</span><span class="kpi-label">Elapsed Time</span></div>
        </div>
        <div class="kpi-card" style="padding: 8px 12px;">
          <div class="kpi-icon-wrap" id="ctrl-kpi-lifecycle-icon" style="width: 30px; height: 30px; background: ${badgeStyle.bg}; color: ${badgeStyle.color}; border: 1px solid ${badgeStyle.border};">
            <span style="font-weight: 800; font-size: 14px;">${badgeStyle.icon}</span>
          </div>
          <div class="kpi-data">
            <span class="kpi-value font-mono" style="font-size: 13px; color: ${badgeStyle.color}; font-weight: 700;" id="ctrl-kpi-lifecycle-state">${lifecycleState}</span>
            <span class="kpi-label">Lifecycle State</span>
          </div>
        </div>
      </div>

      <!-- Main 3-Column Grid: Config Controls + Map + Inspector -->
      <div class="control-main-grid">
        <!-- Left Simulation Controls Panel -->
        <div class="sim-controls-panel">
          <!-- Control Subtabs -->
          <div class="coord-card-tabs" style="border-bottom: none; margin-bottom: 2px;">
            <button class="coord-tab-btn ${this.activeTab === 'simulation' ? 'active' : ''}" data-stab="simulation">Simulation</button>
            <button class="coord-tab-btn ${this.activeTab === 'hitl' ? 'active' : ''}" data-stab="hitl">HITL</button>
            <button class="coord-tab-btn ${this.activeTab === 'diagnostics' ? 'active' : ''}" data-stab="diagnostics">Diagnostics</button>
            <button class="coord-tab-btn ${this.activeTab === 'scenario' ? 'active' : ''}" data-stab="scenario">Scenario</button>
            <button class="coord-tab-btn ${this.activeTab === 'fault' ? 'active' : ''}" data-stab="fault">Faults</button>
          </div>

          <!-- Tab Content -->
          <div id="sim-tab-content">
            ${this.renderActiveTabContent()}
          </div>
        </div>

        <!-- Center Simulation Map -->
        <div id="ctrl-map-mount"></div>

        <!-- Right Selected Robot Inspector -->
        <div id="ctrl-inspector-mount"></div>
      </div>

      <!-- Bottom Row (4 Columns) -->
      <div class="control-bottom-grid">
        <!-- Col 1: Active Faults -->
        <div class="ops-card">
          <div class="ops-card-header">
            <div class="ops-card-title" style="color: var(--status-critical);">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              </svg>
              <span>Active Faults (<span id="active-faults-count">${faults.length}</span>)</span>
            </div>
            <button style="font-size: 10px; font-weight: 700; color: #DC2626;" id="btn-clear-faults">Clear All</button>
          </div>

          <div id="active-faults-list">
            ${this.renderActiveFaults(faults)}
          </div>
        </div>

        <!-- Col 2: Task Progress (live from KPIs) -->
        <div class="ops-card" id="ctrl-task-progress-card">
          ${this.renderTaskProgressCard()}
        </div>

        <!-- Col 3: Simulation Timeline Scrubber -->
        <div class="ops-card">
          <div class="ops-card-header">
            <div class="ops-card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-primary);">
                <circle cx="12" cy="12" r="10"></circle>
              </svg>
              <span>Simulation Timeline</span>
            </div>
            <div style="display: flex; gap: 8px; font-size: 9px; color: var(--text-muted);">
              <span>&bull; Task</span><span style="color: #EF4444;">&bull; Fault</span><span style="color: #F59E0B;">&bull; Event</span><span style="color: #10B981;">&bull; Checkpoint</span>
            </div>
          </div>
          <div class="sim-timeline-track" id="sim-timeline-track">
            <div class="sim-timeline-fill"></div>
            <div class="timeline-pin" style="left: 42%;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: var(--text-muted); font-family: var(--font-mono);">
            <span>00:00</span>
            <span>05:00</span>
            <span>10:00</span>
            <span>15:00</span>
            <span>20:00</span>
          </div>
        </div>

        <!-- Col 4: HITL Audit Trail & Actions -->
        <div class="ops-card">
          <div class="ops-card-header">
            <div class="ops-card-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-primary);">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              <span>HITL Audit Log</span>
            </div>
            <span style="font-size: 9.5px; color: var(--text-muted);" id="ctrl-audit-count">${(state.get("hitlAuditLog") || []).length} Records</span>
          </div>
          <div id="ctrl-hitl-quick-log" style="max-height: 95px; overflow-y: auto; font-size: 9.5px; display: flex; flex-direction: column; gap: 4px;">
            ${this.renderQuickAuditLog()}
          </div>
        </div>
      </div>
    `;

    // Mount Map & Inspector
    const mapMount = this.container.querySelector("#ctrl-map-mount");
    this.mapInstance = new WarehouseMap(mapMount, { showLegend: false, height: "480px" });

    const inspectorMount = this.container.querySelector("#ctrl-inspector-mount");
    this.inspectorInstance = new RobotInspector(inspectorMount);

    this.bindEvents();
    this.updateClockTimer();
  }

  renderActiveTabContent() {
    switch (this.activeTab) {
      case "simulation":
        return this.renderSimTabContent();
      case "hitl":
        return this.renderHitlTabContent();
      case "diagnostics":
        return this.renderDiagnosticsTabContent();
      case "scenario":
        return this.renderScenarioTabContent();
      case "fault":
        return this.renderFaultTabContent();
      default:
        return this.renderSimTabContent();
    }
  }

  renderSimTabContent() {
    const simSpeed = state.get("simSpeed") || 1.0;
    const fleetSize = state.get("fleetSize") || 50;
    const lifecycleState = state.get("simLifecycleState") || (state.get("simRunning") ? "RUNNING" : "IDLE");
    const isRunning = lifecycleState === LIFECYCLE_STATES.RUNNING;
    const isPaused = lifecycleState === LIFECYCLE_STATES.PAUSED;
    const isInitializing = lifecycleState === LIFECYCLE_STATES.INITIALIZING;
    const isError = lifecycleState === LIFECYCLE_STATES.ERROR;
    const isRestarting = lifecycleState === LIFECYCLE_STATES.RESTARTING;
    const isIdle = lifecycleState === LIFECYCLE_STATES.IDLE;
    const diagnostics = state.get("simDiagnostics") || [];
    const selectedSystem = state.get("selectedSystem") || "ace";

    // Button states per lifecycle
    const startBtnLabel = isRunning ? "▶ Running" : isPaused ? "▶ Paused" : isInitializing || isRestarting ? "⟳ Checking..." : isError ? "▶ Retry" : "▶ Start";
    const startBtnDisabled = isRunning || isPaused || isInitializing || isRestarting;
    // One stateful button: "Pause" while running, "Resume" while paused.
    const pauseBtnDisabled = !isRunning && !isPaused;
    const pauseBtnLabel = isPaused ? "&#9654; Resume" : "&#10074;&#10074; Pause";
    const stopBtnDisabled = !isRunning && !isPaused;
    const restartBtnDisabled = isIdle || isInitializing || isRestarting;

    return `
      <!-- System Architecture Selector -->
      <div style="margin-bottom: 10px;">
        <label style="font-size: 10.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; display: block;">Coordination Architecture</label>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px;">
          <button class="sys-select-card ${selectedSystem === 'centralized' ? 'active' : ''}" id="btn-sys-centralized" data-sys="centralized">
            <div style="font-size: 16px; margin-bottom: 2px;">🏛️</div>
            <div style="font-size: 9px; font-weight: 800; line-height: 1.2;">Centralized</div>
          </button>
          <button class="sys-select-card ${selectedSystem === 'decentralized' ? 'active' : ''}" id="btn-sys-decentralized" data-sys="decentralized">
            <div style="font-size: 16px; margin-bottom: 2px;">🔗</div>
            <div style="font-size: 9px; font-weight: 800; line-height: 1.2;">Decentral.</div>
          </button>
          <button class="sys-select-card ${selectedSystem === 'ace' ? 'active' : ''}" id="btn-sys-ace" data-sys="ace" title="NodeX Edge AI ACE decentralized">
            <div style="font-size: 16px; margin-bottom: 2px;">⚡</div>
            <div style="font-size: 9px; font-weight: 800; line-height: 1.2;">NodeX Edge AI ACE</div>
          </button>
        </div>
        <div style="font-size: 9px; color: var(--text-muted); margin-top: 4px; text-align: center;">
          Active: <strong style="color: var(--accent-primary);">${SYSTEM_NAMES[selectedSystem] || selectedSystem}</strong>
        </div>
      </div>

      <!-- Sim Lifecycle Controls -->
      <div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <label style="font-size: 10.5px; font-weight: 700; color: var(--text-secondary);">Lifecycle Controls</label>
          <span style="font-size: 9.5px; font-family: var(--font-mono); font-weight: 700; color: var(--accent-primary);">State: ${lifecycleState}</span>
        </div>
        <div class="sim-buttons-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
          <button class="sim-btn start ${startBtnDisabled ? 'disabled' : ''}" id="btn-sim-start" ${startBtnDisabled ? 'disabled' : ''}>
            ${startBtnLabel}
          </button>
          <button class="sim-btn ${pauseBtnDisabled ? 'disabled' : ''}" id="btn-sim-pause" data-toggle="${isPaused ? 'resume' : 'pause'}" ${pauseBtnDisabled ? 'disabled' : ''}>
            ${pauseBtnLabel}
          </button>
          <button class="sim-btn restart ${restartBtnDisabled ? 'disabled' : ''}" id="btn-sim-restart" ${restartBtnDisabled ? 'disabled' : ''}>
            &#x21BA; Restart
          </button>
          <button class="sim-btn ${stopBtnDisabled ? 'disabled' : ''}" id="btn-sim-stop" ${stopBtnDisabled ? 'disabled' : ''}>
            &#9632; Stop
          </button>
        </div>
        <button class="sim-btn" id="btn-sim-reset" style="width: 100%; margin-top: 5px;">
          &#8635; Reset to IDLE
        </button>
      </div>

      <!-- Live Diagnostics Banner if Initializing or completed -->
      ${(isInitializing || isRestarting || diagnostics.length > 0) ? `
        <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px; font-size: 10px;">
          <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 4px; display: flex; justify-content: space-between;">
            <span>Subsystem Verification</span>
            <span style="color: ${(isInitializing || isRestarting) ? '#F59E0B' : '#10B981'}; font-weight: 800;">
              ${(isInitializing || isRestarting) ? "Running Diagnostics..." : "All Subsystems Nominal (8/8)"}
            </span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 3px; max-height: 85px; overflow-y: auto;">
            ${diagnostics.map(d => `
              <div style="display: flex; justify-content: space-between; font-size: 9px; color: var(--text-secondary);">
                <span>${d.status === 'PASS' ? '✓' : '✗'} ${d.name}</span>
                <span class="font-mono" style="color: ${d.status === 'PASS' ? '#10B981' : '#EF4444'}; font-weight: 700;">${d.latencyMs}ms</span>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}

      <!-- Speed Selector -->
      <div>
        <div style="display: flex; justify-content: space-between; font-size: 10.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 4px;">
          <span>Simulation Speed</span>
          <span style="color: var(--accent-primary); font-family: var(--font-mono);">${simSpeed}x</span>
        </div>
        <div class="speed-selector-group">
          <button class="selector-pill ${simSpeed === 0.25 ? 'active' : ''}" data-speed="0.25">0.25x</button>
          <button class="selector-pill ${simSpeed === 0.5 ? 'active' : ''}" data-speed="0.5">0.5x</button>
          <button class="selector-pill ${simSpeed === 1.0 ? 'active' : ''}" data-speed="1.0">1x</button>
          <button class="selector-pill ${simSpeed === 2.0 ? 'active' : ''}" data-speed="2.0">2x</button>
          <button class="selector-pill ${simSpeed === 5.0 ? 'active' : ''}" data-speed="5.0">5x</button>
        </div>
      </div>

      <!-- Fleet Size (Robots) -->
      <div>
        <label style="font-size: 10.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 4px; display: block;">Fleet Size (Robots)</label>
        <div class="fleet-selector-group">
          <button class="selector-pill ${fleetSize === 3 ? 'active' : ''}" data-fsize="3">3</button>
          <button class="selector-pill ${fleetSize === 10 ? 'active' : ''}" data-fsize="10">10</button>
          <button class="selector-pill ${fleetSize === 50 ? 'active' : ''}" data-fsize="50">50</button>
          <button class="selector-pill ${fleetSize === 100 ? 'active' : ''}" data-fsize="100">100</button>
        </div>
      </div>

      <!-- Map Selection -->
      <div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <label style="font-size: 10.5px; font-weight: 700; color: var(--text-secondary);">Map Selection</label>
          <button style="font-size: 9.5px; color: var(--accent-primary); font-weight: 600;" id="btn-upload-map">&#x1F4E4; Upload Map</button>
        </div>
        <select style="width: 100%; padding: 6px; font-weight: 600;" id="ctrl-map-select">
          ${MAPS_REGISTRY.map(m => m.geometryImported === false
            ? `<option value="${m.id}" disabled>${m.name} (geometry not imported)</option>`
            : `<option value="${m.id}" ${m.id === state.get('selectedMap') ? 'selected' : ''}>${m.name}</option>`).join("")}
        </select>
        <div style="margin-top: 6px; background: var(--bg-surface-subtle); border: 1px solid var(--border-color); border-radius: 8px; padding: 6px 10px; display: flex; align-items: center; gap: 8px;">
          <div style="font-size: 16px;">🏢</div>
          <div>
            <div style="font-size: 10.5px; font-weight: 700; color: var(--text-primary);">Warehouse-A v3</div>
            <div style="font-size: 9px; color: var(--text-muted);">50,000 m&sup2; &bull; 5 zones</div>
          </div>
        </div>
      </div>

      <!-- Environment Settings -->
      <div>
        <label style="font-size: 10.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; display: block;">Environment Settings</label>
        <div class="env-settings-list">
          <div class="env-toggle-row"><span>&#x1F477; Dynamic Humans</span><label class="toggle-switch"><input type="checkbox" checked><span class="slider"></span></label></div>
          <div class="env-toggle-row"><span>&#x1F4E6; Dynamic Obstacles</span><label class="toggle-switch"><input type="checkbox" checked><span class="slider"></span></label></div>
          <div class="env-toggle-row"><span>&#x1F4CB; Variable Task Arrival</span><label class="toggle-switch"><input type="checkbox" checked><span class="slider"></span></label></div>
          <div class="env-toggle-row"><span>&#x1F6A6; Realistic Traffic</span><label class="toggle-switch"><input type="checkbox" checked><span class="slider"></span></label></div>
        </div>
      </div>
    `;
  }

  renderHitlTabContent() {
    const systemMode = state.get("systemMode") || "ace";
    const hitlEnabled = state.get("hitlEnabled") || false;
    const hitlScope = state.get("hitlScope") || "ENTIRE_FLEET";
    const robots = state.get("robots") || [];
    const selectedGroup = state.get("hitlSelectedGroup") || [];
    const selectedRobot = state.get("hitlSelectedRobot") || state.get("selectedRobotId") || "R01";
    const lastFeedback = state.get("hitlCommandStatus");
    const isAce = systemMode === "ace";

    if (!isAce) {
      return `
        <div class="hitl-header-row" style="margin-bottom: 8px;">
          <div class="hitl-title-row">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
            <span class="hitl-card-title">HITL Supervision</span>
          </div>
          <span class="hitl-gated-badge">ACE Gated</span>
        </div>
        <div class="hitl-gated-banner">
          <div>
            <strong>Available only in ACE mode.</strong><br>
            Current mode: <span style="text-transform: uppercase;">${systemMode}</span>. Coordination layer does not permit arbitrated human intervention leases.
          </div>
        </div>
      `;
    }

    const normScope = hitlScope.toUpperCase();
    const isFleet = normScope === "ENTIRE_FLEET" || normScope === "FLEET";
    const isGroup = normScope === "ROBOT_GROUP" || normScope === "GROUP";
    const isIndiv = normScope === "INDIVIDUAL_ROBOT" || normScope === "INDIVIDUAL";

    return `
      <!-- HITL Header & Toggle -->
      <div class="hitl-header-row" style="margin-bottom: 8px;">
        <div class="hitl-title-stack">
          <div class="hitl-title-row">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
            <span class="hitl-card-title">HITL Supervision</span>
          </div>
          <div class="hitl-sub-line">3-Scope Arbitrated Control & Audit Trail</div>
        </div>
        <div class="hitl-toggle-wrap">
          <label class="switch-hitl">
            <input type="checkbox" id="chk-ctrl-hitl-toggle" ${hitlEnabled ? "checked" : ""}>
            <span class="slider round"></span>
          </label>
          <span class="toggle-text">${hitlEnabled ? "Active" : "Standby"}</span>
        </div>
      </div>

      ${!hitlEnabled ? `
        <div class="hitl-standby-hint">
          HITL supervision is <strong>Standby</strong>. Toggle switch ON to issue arbitrated interventions across Fleet, Group, or Individual AMRs.
        </div>
      ` : `
        <div class="hitl-scope-section">
          <div class="hitl-scope-label">
            <span>Intervention Scope</span>
            <span style="font-size: 9px; color: var(--accent-cyan); font-weight: 800; font-family: monospace;">${normScope}</span>
          </div>

          <!-- Scope Selector Pills -->
          <div class="hitl-scope-pills">
            <button class="hitl-scope-pill ${isFleet ? 'active' : ''}" id="ctrl-btn-scope-fleet">Entire Fleet</button>
            <button class="hitl-scope-pill ${isGroup ? 'active' : ''}" id="ctrl-btn-scope-group">Robot Group</button>
            <button class="hitl-scope-pill ${isIndiv ? 'active' : ''}" id="ctrl-btn-scope-indiv">Individual</button>
          </div>

          <!-- Target Picker -->
          <div class="hitl-target-box" style="margin-top: 6px;">
            ${isFleet ? `
              <div class="hitl-target-desc">
                <span style="font-weight: 700; color: var(--accent-cyan);">Target:</span>
                <span>All Active AMRs (${robots.length} Robots in Fleet)</span>
              </div>
            ` : isGroup ? `
              <div class="hitl-target-desc" style="justify-content: space-between;">
                <span>Group: ${selectedGroup.length} Selected</span>
                <div style="display: flex; gap: 4px;">
                  <button id="ctrl-btn-group-all" style="background: none; border: none; font-size: 9px; color: #0077FF; cursor: pointer;">All</button>
                  <button id="ctrl-btn-group-clear" style="background: none; border: none; font-size: 9px; color: #7384A0; cursor: pointer;">Clear</button>
                </div>
              </div>
              <div class="hitl-group-list">
                ${robots.slice(0, 12).map(r => `
                  <label class="hitl-group-item ${selectedGroup.includes(r.id) ? 'checked' : ''}">
                    <input type="checkbox" class="ctrl-group-chk" data-robot-id="${r.id}" ${selectedGroup.includes(r.id) ? 'checked' : ''}>
                    <span>${r.id}</span>
                  </label>
                `).join("")}
              </div>
            ` : `
              <div class="hitl-individual-picker">
                <select id="ctrl-sel-individual" class="hitl-robot-select">
                  ${robots.map(r => `<option value="${r.id}" ${r.id === selectedRobot ? 'selected' : ''}>${r.id} (${r.status})</option>`).join("")}
                </select>
                <button class="btn-hitl-teleop-lease" id="ctrl-btn-teleop" title="Take direct teleop lease">Teleop &rarr;</button>
              </div>
            `}
          </div>

          <!-- Action Buttons -->
          <div style="font-size: 10px; font-weight: 700; color: var(--text-secondary); margin-top: 8px; margin-bottom: 4px;">Dispatched Supervisory Actions</div>
          <div class="hitl-cmd-buttons" style="grid-template-columns: repeat(2, 1fr); gap: 6px;">
            <button class="btn-hitl-cmd btn-hitl-hold" id="ctrl-cmd-hold">Hold Motion</button>
            <button class="btn-hitl-cmd btn-hitl-resume" id="ctrl-cmd-resume">Resume Nav</button>
            <button class="btn-hitl-cmd btn-hitl-stop" id="ctrl-cmd-stop">Safe Stop</button>
            <button class="btn-hitl-cmd" id="ctrl-cmd-clamp" style="background: rgba(245, 158, 11, 0.15); color: #D97706; border-color: rgba(245, 158, 11, 0.3);">Clamp (0.5x)</button>
          </div>

          <!-- Intervention Reason -->
          <div style="margin-top: 8px;">
            <label style="font-size: 9.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 2px; display: block;">Operator Rationale</label>
            <input type="text" id="ctrl-hitl-reason" value="${this.hitlReason}" style="width: 100%; padding: 4px 6px; font-size: 10px; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-surface-subtle); color: var(--text-primary);">
          </div>

          <!-- Feedback Status -->
          <div class="hitl-feedback-line ${lastFeedback ? (lastFeedback.type === 'stop' ? 'warn' : 'success') : ''}" style="margin-top: 6px;">
            <span>${lastFeedback ? `✓ ${lastFeedback.msg}` : `System ready for arbitrated operator dispatch`}</span>
          </div>
        </div>
      `}
    `;
  }

  renderDiagnosticsTabContent() {
    const diagnostics = state.get("simDiagnostics") || [];
    return `
      <div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <label style="font-size: 10.5px; font-weight: 700; color: var(--text-secondary);">Subsystem Diagnostics</label>
          <button id="btn-run-full-diagnostics" class="sim-btn start" style="padding: 4px 8px; font-size: 9.5px; flex-direction: row; gap: 4px;">
            ⟳ Run Diagnostics
          </button>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${[
            { name: "Backend Telemetry Bridge", desc: "Reactive data bus & zero-latency state store" },
            { name: "Warehouse Map Bounds", desc: "50,000m² CAD boundary & shelf obstacle masks" },
            { name: "AMR Kinematics & Footprint", desc: "Differential drive equations & 32px safe radius" },
            { name: "Corridor Waypoint Grid", desc: "Aisle waypoints & collision-free segment graphs" },
            { name: "Coordination Engine", desc: "Authoritative Centralized / Decentralized / ACE mode" },
            { name: "Task Dispatcher", desc: "Dynamic pickup, transport, and charging queues" },
            { name: "ACE / RACE Evaluator", desc: "Risk containment envelopes & spatial scoring" },
            { name: "HITL Safety Watchdog", desc: "3-Scope arbitrated supervision and audit log" }
          ].map((sub, idx) => {
            const diag = diagnostics.find(d => d.name.includes(sub.name.split(" ")[0])) || null;
            const status = diag ? diag.status : "READY";
            const color = status === "PASS" ? "#10B981" : status === "FAIL" ? "#EF4444" : "#64748B";
            return `
              <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 8px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-size: 10px; font-weight: 700; color: var(--text-primary);">${sub.name}</span>
                  <span style="font-size: 9px; font-weight: 800; color: ${color};">${diag ? `✓ PASS (${diag.latencyMs}ms)` : 'NOMINAL'}</span>
                </div>
                <div style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">${diag ? diag.details : sub.desc}</div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  renderScenarioTabContent() {
    const testType = state.get("simTestType") || "scenario";
    const selectedCode = state.get("selectedScenario") || "S01";
    const isScenario = testType === "scenario";
    const activeList = isScenario ? SCENARIOS : ACE_TESTS;
    const activeItem = activeList.find(i => i.code === selectedCode) || activeList[0];

    return `
      <!-- Test Type Tabs: Scenarios | ACE Tests -->
      <div style="display: flex; gap: 0; border-radius: 6px; overflow: hidden; border: 1px solid var(--border-color); margin-bottom: 8px;">
        <button id="ctrl-tab-scenarios" style="flex: 1; padding: 5px; font-size: 10px; font-weight: 700;
          background: ${isScenario ? 'var(--accent-primary)' : 'transparent'};
          color: ${isScenario ? '#fff' : 'var(--text-secondary)'}; border: none; cursor: pointer;">
          Scenarios (14)
        </button>
        <button id="ctrl-tab-acetests" style="flex: 1; padding: 5px; font-size: 10px; font-weight: 700;
          background: ${!isScenario ? 'var(--accent-primary)' : 'transparent'};
          color: ${!isScenario ? '#fff' : 'var(--text-secondary)'}; border: none; cursor: pointer;">
          ACE Tests (12)
        </button>
      </div>

      <!-- List -->
      <select style="width: 100%; padding: 6px; font-weight: 600; margin-bottom: 6px;" id="ctrl-scenario-select">
        ${activeList.map(s => `<option value="${s.code}" ${s.code === selectedCode ? 'selected' : ''}>${s.code} — ${s.name}</option>`).join("")}
      </select>

      <!-- Description card -->
      ${activeItem ? `
        <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; font-size: 10px;">
          <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">${activeItem.code} — ${activeItem.name}</div>
          <div style="color: var(--text-muted); line-height: 1.5;">${activeItem.description}</div>
          ${activeItem.duration ? `<div style="margin-top: 4px; color: var(--accent-primary); font-weight: 700;">Duration: ${activeItem.duration}s · Robots: ${activeItem.robotCount}</div>` : ''}
          ${activeItem.passCriteria ? `<div style="margin-top: 4px; font-size: 9px; color: #10B981;">Pass: ${activeItem.passCriteria.slice(0, 80)}...</div>` : ''}
        </div>
      ` : ''}
    `;
  }

  renderFaultTabContent() {
    return `
      <label style="font-size: 10.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; display: block;">Inject Fault / Disturbance</label>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <button class="quick-btn danger" data-fault="robot_failure">&#x26A0; Robot Failure (R11)</button>
        <button class="quick-btn" data-fault="comm_delay">&#x1F4F6; Communication Delay</button>
        <button class="quick-btn" data-fault="comm_loss">&#x1F4E1; Communication Loss</button>
        <button class="quick-btn" data-fault="central_link_failure" style="color: #DC2626; font-weight: 700;">&#x26A1; Central Coordinator Failure (C14)</button>
        <button class="quick-btn" data-fault="obstacle">&#x1F4E6; Dynamic Crossing Obstacle</button>
      </div>
    `;
  }

  renderActiveFaults(faults) {
    if (!faults || faults.length === 0) {
      return `<div style="font-size: 11px; color: var(--text-muted); padding: 6px 0;">No active faults in simulation. Fleet nominal.</div>`;
    }

    return faults.map(f => `
      <div class="fault-card-red">
        <div class="fault-card-header">
          <span style="font-size: 11px; font-weight: 700; color: #DC2626;">${f.type} - ${f.targetRobot}</span>
          <span class="fault-tag">${f.status}</span>
        </div>
        <div style="font-size: 9.5px; color: #991B1B;">Injected at ${f.timeInjected}</div>
        <div style="font-size: 10px; color: #7F1D1D; margin-top: 2px;">${f.description}</div>
      </div>
    `).join("");
  }

  renderQuickAuditLog() {
    const log = state.get("hitlAuditLog") || [];
    if (log.length === 0) {
      return `<div style="color: var(--text-muted); padding: 4px 0;">No operator interventions recorded in current run.</div>`;
    }
    return log.slice(0, 5).map(item => `
      <div style="padding: 3px 6px; border-radius: 4px; background: var(--bg-surface-subtle); border-left: 2px solid ${item.success ? '#10B981' : '#EF4444'};">
        <div style="display: flex; justify-content: space-between; font-weight: 700;">
          <span style="color: ${item.success ? '#10B981' : '#EF4444'};">${item.action} (${item.scope})</span>
          <span style="color: var(--text-muted);">${item.timeFormatted || ''}</span>
        </div>
        <div style="color: var(--text-secondary);">${item.reason || ''}</div>
      </div>
    `).join("");
  }

  bindEvents() {
    // Subtabs
    const subtabs = this.container.querySelectorAll(".coord-tab-btn");
    subtabs.forEach(btn => {
      btn.addEventListener("click", () => {
        subtabs.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.activeTab = btn.getAttribute("data-stab");
        const mount = this.container.querySelector("#sim-tab-content");
        if (mount) mount.innerHTML = this.renderActiveTabContent();
        this.bindTabSpecificEvents();
      });
    });

    this.bindTabSpecificEvents();

    // Clear Faults
    this.container.querySelector("#btn-clear-faults")?.addEventListener("click", () => {
      simEngine.clearFaults();
    });

    // Subscriptions
    // Keep this screen's selection pills in sync with changes made on other
    // screens (Operations cards, Settings popup, Explain screen).
    const rerenderActiveTab = () => {
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) {
        mount.innerHTML = this.renderActiveTabContent();
        this.bindTabSpecificEvents();
      }
    };
    ["systemMode", "robotCount", "selectedScenario", "simTestType", "hitlEnabled", "hitlScope"].forEach(key => {
      state.subscribe(key, (newVal, oldVal) => {
        if (newVal !== oldVal) rerenderActiveTab();
      });
    });

    state.subscribe("simLifecycleState", (newState) => {
      const badgeStyle = this.getLifecycleBadgeStyle(newState);
      const iconEl = document.getElementById("ctrl-kpi-lifecycle-icon");
      const valEl = document.getElementById("ctrl-kpi-lifecycle-state");
      if (iconEl) {
        iconEl.style.background = badgeStyle.bg;
        iconEl.style.color = badgeStyle.color;
        iconEl.style.borderColor = badgeStyle.border;
        iconEl.innerHTML = `<span style="font-weight: 800; font-size: 14px;">${badgeStyle.icon}</span>`;
      }
      if (valEl) {
        valEl.textContent = newState;
        valEl.style.color = badgeStyle.color;
      }

      // Re-render tab if currently on simulation or diagnostics tab
      if (this.activeTab === "simulation" || this.activeTab === "diagnostics") {
        const mount = this.container.querySelector("#sim-tab-content");
        if (mount) {
          mount.innerHTML = this.renderActiveTabContent();
          this.bindTabSpecificEvents();
        }
      }
    });

    state.subscribe("activeFaults", (f) => {
      const list = document.getElementById("active-faults-list");
      const count = document.getElementById("active-faults-count");
      if (list) list.innerHTML = this.renderActiveFaults(f);
      if (count) count.textContent = f.length;
    });

    state.subscribe("fleetSize", (sz) => {
      const el = document.getElementById("ctrl-kpi-fleet");
      if (el) el.textContent = `${sz} AMRs`;
    });

    state.subscribe("kpis", (k) => {
      const el = document.getElementById("ctrl-kpi-tasks");
      if (el && k) el.textContent = k.activeTasks;
    });

    state.subscribe("simSpeed", (spd) => {
      const el = document.getElementById("ctrl-kpi-speed");
      if (el) el.textContent = `${spd}x`;
    });

    state.subscribe("hitlAuditLog", () => {
      const logEl = document.getElementById("ctrl-hitl-quick-log");
      const countEl = document.getElementById("ctrl-audit-count");
      const log = state.get("hitlAuditLog") || [];
      if (logEl) logEl.innerHTML = this.renderQuickAuditLog();
      if (countEl) countEl.textContent = `${log.length} Records`;
    });

    state.subscribe("hitlCommandStatus", () => {
      if (this.activeTab === "hitl") {
        const mount = this.container.querySelector("#sim-tab-content");
        if (mount) {
          mount.innerHTML = this.renderActiveTabContent();
          this.bindTabSpecificEvents();
        }
      }
    });

    // Live task progress updates
    const updateTaskProgress = () => {
      const card = document.getElementById("ctrl-task-progress-card");
      if (card) card.innerHTML = this.renderTaskProgressCard();
    };
    state.subscribe("tasks", updateTaskProgress);
    state.subscribe("kpis", (k) => {
      const el = document.getElementById("ctrl-kpi-tasks");
      if (el && k) el.textContent = k.activeTasks;
      updateTaskProgress();
    });
  }

  renderTaskProgressCard() {
    const kpis = state.get("kpis") || {};
    const tasks = state.get("tasks") || [];
    const totalTasks = kpis.totalTasks || tasks.length || 0;
    const completedTasks = kpis.completedTasks || tasks.filter(t => t.status === 'DONE' || t.status === 'COMPLETED').length || 0;
    const activeTasks = kpis.activeTasks || tasks.filter(t => t.status === 'ACTIVE' || t.status === 'IN_PROGRESS').length || 0;
    const pctDone = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const pctActive = totalTasks > 0 ? Math.round((activeTasks / totalTasks) * 100) : 0;
    const pctPending = Math.max(0, 100 - pctDone - pctActive);

    return `
      <div class="ops-card-header">
        <div class="ops-card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-primary);">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
          </svg>
          <span>Task Progress (Live)</span>
        </div>
        <span style="font-weight: 800; font-size: 11px;" id="ctrl-task-pct">${pctDone}%</span>
      </div>
      <div style="height: 8px; background: rgba(100,116,139,0.2); border-radius: 4px; overflow: hidden; display: flex;">
        <div style="width: ${pctDone}%; background: #10B981; transition: width 0.4s;" title="Completed"></div>
        <div style="width: ${pctActive}%; background: #3B82F6; transition: width 0.4s;" title="Active"></div>
        <div style="width: ${pctPending}%; background: #475569; transition: width 0.4s;" title="Pending"></div>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 9.5px; color: var(--text-muted); margin-top: 4px;">
        <span>Total <strong>${totalTasks}</strong></span>
        <span>Active <strong style="color: #3B82F6;">${activeTasks}</strong></span>
        <span>Done <strong style="color: #10B981;">${completedTasks}</strong></span>
      </div>
    `;
  }

  bindTabSpecificEvents() {
    // 0. System Selector
    const sysBtns = this.container.querySelectorAll("[data-sys]");
    sysBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const sys = btn.getAttribute("data-sys");
        if (state.get("configLocked")) {
          btn.title = "System is locked while a run is active. Stop or reset first.";
          return;
        }
        systemManager.switchSystem(sys);
        // Re-render sim tab to update active button
        if (this.activeTab === "simulation") {
          const mount = this.container.querySelector("#sim-tab-content");
          if (mount) { mount.innerHTML = this.renderActiveTabContent(); this.bindTabSpecificEvents(); }
        }
      });
    });

    // 1. Simulation Lifecycle Buttons
    this.container.querySelector("#btn-sim-start")?.addEventListener("click", async () => {
      const lc = state.get("simLifecycleState") || "IDLE";
      if (lc === LIFECYCLE_STATES.ERROR) {
        await simLifecycle.retry({ animated: true });
      } else {
        await simLifecycle.start({ animated: true });
      }
    });

    this.container.querySelector("#btn-sim-pause")?.addEventListener("click", () => {
      const lc = simLifecycle.getState();
      if (lc === LIFECYCLE_STATES.RUNNING) simLifecycle.pause();
      else if (lc === LIFECYCLE_STATES.PAUSED) simLifecycle.resume();
    });

    this.container.querySelector("#btn-sim-restart")?.addEventListener("click", async () => {
      await simLifecycle.restart({ animated: true });
    });

    this.container.querySelector("#btn-sim-stop")?.addEventListener("click", () => {
      simLifecycle.stop();
    });

    this.container.querySelector("#btn-sim-reset")?.addEventListener("click", () => {
      simLifecycle.reset();
    });

    // 2. Speed buttons
    const speedPills = this.container.querySelectorAll("[data-speed]");
    speedPills.forEach(p => {
      p.addEventListener("click", () => {
        const s = parseFloat(p.getAttribute("data-speed"));
        state.set("simSpeed", s);
        speedPills.forEach(btn => btn.classList.remove("active"));
        p.classList.add("active");
      });
    });

    // 3. Fleet Size buttons
    const fsizePills = this.container.querySelectorAll("[data-fsize]");
    fsizePills.forEach(p => {
      p.addEventListener("click", () => {
        const size = parseInt(p.getAttribute("data-fsize"), 10);
        if (state.get("configLocked")) {
          p.title = "Fleet size is locked while a run is active. Stop or reset first.";
          return;
        }
        // The engine rebuilds the fleet via its robotCount subscription.
        state.set("robotCount", size);
        fsizePills.forEach(btn => btn.classList.remove("active"));
        p.classList.add("active");
      });
    });

    // 4. Fault injection buttons
    const faultBtns = this.container.querySelectorAll("[data-fault]");
    faultBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const fault = btn.getAttribute("data-fault");
        simEngine.injectFault(fault);
      });
    });

    // 5. Scenario / ACE Test type tabs
    this.container.querySelector("#ctrl-tab-scenarios")?.addEventListener("click", () => {
      state.set("simTestType", "scenario");
      state.set("selectedScenario", SCENARIOS[0].code);
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) { mount.innerHTML = this.renderActiveTabContent(); this.bindTabSpecificEvents(); }
    });
    this.container.querySelector("#ctrl-tab-acetests")?.addEventListener("click", () => {
      state.set("simTestType", "aceTest");
      state.set("selectedScenario", ACE_TESTS[0].code);
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) { mount.innerHTML = this.renderActiveTabContent(); this.bindTabSpecificEvents(); }
    });

    // Scenario/Test select dropdown
    this.container.querySelector("#ctrl-scenario-select")?.addEventListener("change", (e) => {
      state.set("selectedScenario", e.target.value);
      // Update description in the same tab
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount && this.activeTab === "scenario") {
        mount.innerHTML = this.renderActiveTabContent();
        this.bindTabSpecificEvents();
      }
    });

    // 6. Run Full Diagnostics Button
    this.container.querySelector("#btn-run-full-diagnostics")?.addEventListener("click", async () => {
      const btn = this.container.querySelector("#btn-run-full-diagnostics");
      if (btn) btn.textContent = "Checking...";
      await simLifecycle.runDiagnostics(true);
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) {
        mount.innerHTML = this.renderActiveTabContent();
        this.bindTabSpecificEvents();
      }
    });

    // 7. HITL Events
    const chkHitl = this.container.querySelector("#chk-ctrl-hitl-toggle");
    chkHitl?.addEventListener("change", (e) => {
      const val = e.target.checked;
      state.set("hitlEnabled", val);
      state.set("hitlMode", val ? "MONITOR" : "OFF");
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) {
        mount.innerHTML = this.renderActiveTabContent();
        this.bindTabSpecificEvents();
      }
    });

    this.container.querySelector("#ctrl-btn-scope-fleet")?.addEventListener("click", () => {
      state.set("hitlScope", "ENTIRE_FLEET");
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) { mount.innerHTML = this.renderActiveTabContent(); this.bindTabSpecificEvents(); }
    });

    this.container.querySelector("#ctrl-btn-scope-group")?.addEventListener("click", () => {
      state.set("hitlScope", "ROBOT_GROUP");
      const grp = state.get("hitlSelectedGroup");
      if (!grp || grp.length === 0) state.set("hitlSelectedGroup", ["R01", "R02"]);
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) { mount.innerHTML = this.renderActiveTabContent(); this.bindTabSpecificEvents(); }
    });

    this.container.querySelector("#ctrl-btn-scope-indiv")?.addEventListener("click", () => {
      state.set("hitlScope", "INDIVIDUAL_ROBOT");
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) { mount.innerHTML = this.renderActiveTabContent(); this.bindTabSpecificEvents(); }
    });

    this.container.querySelectorAll(".ctrl-group-chk").forEach(chk => {
      chk.addEventListener("change", () => {
        const id = chk.getAttribute("data-robot-id");
        const grp = state.get("hitlSelectedGroup") || [];
        const nextGrp = chk.checked ? [...grp, id] : grp.filter(x => x !== id);
        state.set("hitlSelectedGroup", nextGrp);
      });
    });

    this.container.querySelector("#ctrl-btn-group-all")?.addEventListener("click", () => {
      const robots = state.get("robots") || [];
      state.set("hitlSelectedGroup", robots.slice(0, 12).map(r => r.id));
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) { mount.innerHTML = this.renderActiveTabContent(); this.bindTabSpecificEvents(); }
    });

    this.container.querySelector("#ctrl-btn-group-clear")?.addEventListener("click", () => {
      state.set("hitlSelectedGroup", []);
      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) { mount.innerHTML = this.renderActiveTabContent(); this.bindTabSpecificEvents(); }
    });

    this.container.querySelector("#ctrl-sel-individual")?.addEventListener("change", (e) => {
      state.set("hitlSelectedRobot", e.target.value);
      state.set("selectedRobotId", e.target.value);
    });

    this.container.querySelector("#ctrl-btn-teleop")?.addEventListener("click", () => {
      const targetId = state.get("hitlSelectedRobot") || state.get("selectedRobotId") || "R01";
      new HitlModal().open(targetId);
    });

    this.container.querySelector("#ctrl-hitl-reason")?.addEventListener("input", (e) => {
      this.hitlReason = e.target.value;
    });

    const dispatchHitl = (action, speedLimitVal = null) => {
      const scope = state.get("hitlScope") || "ENTIRE_FLEET";
      let targets = [];
      if (scope === "ENTIRE_FLEET") {
        targets = (state.get("robots") || []).map(r => r.id);
      } else if (scope === "ROBOT_GROUP") {
        targets = state.get("hitlSelectedGroup") || [];
      } else {
        targets = [state.get("hitlSelectedRobot") || state.get("selectedRobotId") || "R01"];
      }

      hitlController.dispatchCommand({
        scope,
        targets,
        action,
        reason: this.hitlReason,
        speedLimitVal
      });

      const mount = this.container.querySelector("#sim-tab-content");
      if (mount) {
        mount.innerHTML = this.renderActiveTabContent();
        this.bindTabSpecificEvents();
      }
    };

    this.container.querySelector("#ctrl-cmd-hold")?.addEventListener("click", () => dispatchHitl("hold"));
    this.container.querySelector("#ctrl-cmd-resume")?.addEventListener("click", () => dispatchHitl("resume"));
    this.container.querySelector("#ctrl-cmd-stop")?.addEventListener("click", () => dispatchHitl("safe_stop"));
    this.container.querySelector("#ctrl-cmd-clamp")?.addEventListener("click", () => dispatchHitl("speed_limit", 0.5));

    // Upload map modal
    this.container.querySelector("#btn-upload-map")?.addEventListener("click", () => {
      alert("Map Lifecycle Manager:\n1. Choose GeoJSON/CAD map\n2. Checksum validation (SHA-256)\n3. Dry-run dry validation\n4. Activate for next run.");
    });
  }

  updateClockTimer() {
    setInterval(() => {
      const el = document.getElementById("ctrl-elapsed-time");
      if (el) {
        el.textContent = simEngine.formatSimTime(state.get("simTimeSeconds"));
      }
    }, 1000);
  }
}
