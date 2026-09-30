// ==========================================================================
// NODEX ACE - Primary Landing Screen: Industrial AMR Fleet Control Center
// Matches reference UI layout strictly with live data binding
// ==========================================================================

import { state, normalizeHitlScope, getNextRobotCount } from "../core/state.js";
import { hitlController } from "../core/hitl-controller.js";
import { simEngine } from "../core/sim-engine.js";
import { SCENARIOS, ACE_TESTS } from "../data/scenarios.js";
import { WarehouseMap } from "../components/WarehouseMap.js";
import { RobotInspector } from "../components/RobotInspector.js";
import { ScenarioDetailsModal } from "../components/ScenarioDetailsModal.js";
import { systemManager } from "../core/adapters/SystemManager.js";
import { HitlModal, activeInlineLease } from "../components/HitlModal.js";
import { simLifecycle } from "../core/sim-lifecycle.js";
import { scenarioEngine } from "../core/scenario-engine.js";
import { MapGeometryEngine, WAREHOUSE_DIMENSIONS } from "../core/map-geometry.js";

export class ScreenOperations {
  constructor(container) {
    this.container = container;
    this.mapInstance = null;
    this.inspectorInstance = null;
    this.searchQuery = "";
    // The selected tab mirrors the run type the lifecycle will start.
    this.activeSimTab = state.get("simTestType") === "aceTest" ? "tests" : "scenarios"; // "scenarios" | "tests"
    this.render();
    this.bindEvents();
    this.startLiveLoops();
  }

  render() {
    const robots = state.get("robots") || [];
    const activeTasks = state.get("kpis")?.activeTasks ?? 0;
    const totalTasks = state.get("kpis")?.totalTasks ?? 0;
    const simSpeed = state.get("simSpeed") || 1.0;
    const activeAlerts = state.get("kpis")?.activeAlerts ?? 0;
    const systemMode = state.get("systemMode") || "ace";
    const selectedScenarioCode = state.get("selectedScenario") || "S08";
    const scenario = SCENARIOS.find(s => s.code === selectedScenarioCode) || ACE_TESTS.find(t => t.code === selectedScenarioCode) || SCENARIOS[7];
    const onTests = this.activeSimTab === "tests";
    const selectList = onTests ? ACE_TESTS : SCENARIOS;
    const hitlEnabled = state.get("hitlEnabled") || false;
    const simTime = state.get("simTimeSeconds") || 0;
    const runId = state.get("runId") || "—";
    const seed = state.get("seed") || 18427;
    const coordination = state.get("coordination") || {};
    const systemHealth = state.get("kpis")?.systemHealth || "Awaiting telemetry";

    // Compute fleet status counts
    let moving = 0, idle = 0, charging = 0, error = 0, maint = 0;
    for (const r of robots) {
      if (r.status === "error" || r.status === "ERROR") error++;
      else if (r.status === "charging" || r.status === "CHARGING") charging++;
      else if (r.status === "idle" || r.status === "IDLE" || r.velocity === 0) idle++;
      else moving++;
    }

    // Compute task progress from actual task registry.
    // Registry statuses: UNASSIGNED / ASSIGNED / EXECUTING / COMPLETED / FAILED
    // (+ lowercase legacy variants). ASSIGNED/EXECUTING/IN_PROGRESS count as
    // active work in their type bucket; FAILED/UNASSIGNED fall into other.
    let pick = 0, place = 0, transport = 0, charge = 0, notAssigned = 0;
    const tasks = state.get("tasks") || [];
    const isDone = (s) => s === "COMPLETED" || s === "completed";
    const isActive = (s) => s === "ASSIGNED" || s === "assigned" || s === "EXECUTING" || s === "executing" || s === "IN_PROGRESS" || s === "in_progress";
    const bucketByType = (t) => {
      if (t.type?.includes("Pick")) pick++;
      else if (t.type?.includes("Place")) place++;
      else transport++;
    };
    for (const t of tasks) {
      if (isDone(t.status) || isActive(t.status)) {
        bucketByType(t);
      } else if (t.status === "CHARGING" || t.status === "charging") {
        charge++;
      } else {
        notAssigned++;
      }
    }
    const taskTotal = pick + place + transport + charge + notAssigned || 1;

    // Compute Expected Time to End from real simulation progress
    const completedTasks = tasks.filter(t => t.status === "COMPLETED" || t.status === "completed").length;
    const remainingTasks = Math.max(0, taskTotal - completedTasks);
    const tasksPerSecond = completedTasks / Math.max(1, simTime);
    const expectedTimeEnd = tasksPerSecond > 0 && remainingTasks > 0
      ? Math.round(remainingTasks / tasksPerSecond)
      : (remainingTasks > 0 ? 0 : simTime);

    this.container.innerHTML = `
      <div class="ops-dashboard-wrapper">
        <!-- ================================================================
             1. TOP KPI STRIP & SIMULATION CONTROLS
             ================================================================ -->
        <div class="kpi-controls-strip">
          <!-- 5 KPI Cards -->
          <div class="kpi-cards-group">
            <!-- KPI 1: Robot Count (Interactive Cycling 3 -> 10 -> 50 -> 100) -->
            <div class="kpi-mini-card clickable" id="kpi-card-robots" title="Click to cycle fleet count (3 → 10 → 50 → 100)">
              <div class="kpi-box-icon cyan">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="10" rx="2"></rect>
                  <circle cx="12" cy="5" r="2"></circle>
                  <path d="M12 7v4"></path>
                </svg>
              </div>
              <div class="kpi-text-stack">
                <span class="kpi-big-num" id="kpi-val-robots">${robots.length}</span>
                <span class="kpi-sub-label">Robots</span>
              </div>
            </div>

            <!-- KPI 2: Active Tasks -->
            <div class="kpi-mini-card">
              <div class="kpi-box-icon amber">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                  <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                </svg>
              </div>
              <div class="kpi-text-stack">
                <span class="kpi-big-num" id="kpi-val-tasks">${activeTasks}</span>
                <span class="kpi-sub-label">Active Tasks</span>
              </div>
            </div>

            <!-- KPI 3: Sim Speed -->
            <div class="kpi-mini-card clickable" id="kpi-card-speed" title="Click to cycle speed multiplier">
              <div class="kpi-box-icon green">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </div>
              <div class="kpi-text-stack">
                <span class="kpi-big-num" id="kpi-val-speed">${simSpeed.toFixed(1)}x</span>
                <span class="kpi-sub-label">Sim Speed</span>
              </div>
            </div>

            <!-- KPI 4: Elapsed Time -->
            <div class="kpi-mini-card">
              <div class="kpi-box-icon blue">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 14 10"></polyline>
                </svg>
              </div>
              <div class="kpi-text-stack">
                <span class="kpi-big-num font-mono" id="kpi-val-time">${simEngine.formatSimTime(simTime)}</span>
                <span class="kpi-sub-label">Elapsed Time</span>
              </div>
            </div>

            <!-- KPI 5: Expected Time to End -->
            <div class="kpi-mini-card">
              <div class="kpi-box-icon purple">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </div>
              <div class="kpi-text-stack">
                <span class="kpi-big-num font-mono" id="kpi-val-time-end">${expectedTimeEnd > 0 ? simEngine.formatSimTime(expectedTimeEnd) : "--:--:--"}</span>
                <span class="kpi-sub-label">Expected End</span>
              </div>
            </div>

            <!-- KPI 6: Active Alerts -->
            <div class="kpi-mini-card">
              <div class="kpi-box-icon red">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
              </div>
              <div class="kpi-text-stack">
                <span class="kpi-big-num" id="kpi-val-alerts">${activeAlerts}</span>
                <span class="kpi-sub-label">Active Alerts</span>
              </div>
            </div>
          </div>

          <!-- Top-Right Simulation Control Buttons -->
          <div class="sim-actions-group">
            <button class="sim-ctrl-btn btn-start" id="btn-sim-start">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              <span>Start</span>
            </button>

            <button class="sim-ctrl-btn btn-pause" id="btn-sim-pause">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16"></rect>
                <rect x="14" y="4" width="4" height="16"></rect>
              </svg>
              <span>Pause</span>
            </button>

            <button class="sim-ctrl-btn btn-restart" id="btn-sim-restart" title="Restart simulation with current configuration">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
              </svg>
              <span>Restart</span>
            </button>

            <button class="sim-ctrl-btn btn-reset" id="btn-sim-reset" title="Reset simulation to initial state">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
              </svg>
              <span>Reset</span>
            </button>
          </div>
        </div>

        <!-- ================================================================
             2. THREE-COLUMN MAIN GRID (LEFT SIDEBAR | VIEWPORT | RIGHT SIDEBAR)
             ================================================================ -->
        <div class="ops-three-col-grid">
          <!-- LEFT SIDEBAR -->
          <aside class="ops-left-sidebar">
            <!-- SECTION 1: System Selection -->
            <div class="sidebar-panel-card">
              <div class="sidebar-section-title">
                <span class="step-num-pill">1</span>
                <span>System Selection</span>
              </div>

              <div class="sys-select-cards-grid" id="ops-sys-cards-grid">
                <div class="sys-select-card ${systemMode === 'centralized' ? 'selected' : ''}" data-mode="centralized">
                  <div class="sys-card-header">
                    <span class="sys-card-radio"></span>
                    <span class="sys-card-title">Centralized</span>
                  </div>
                  <div class="sys-card-desc">Central server: Hungarian allocation, CBS planning</div>
                </div>
                <div class="sys-select-card ${systemMode === 'decentralized' ? 'selected' : ''}" data-mode="decentralized">
                  <div class="sys-card-header">
                    <span class="sys-card-radio"></span>
                    <span class="sys-card-title">Decentralized</span>
                  </div>
                  <div class="sys-card-desc">P2P contract-net bidding, fixed two-robot coordination</div>
                </div>
                <div class="sys-select-card ${systemMode === 'ace' ? 'selected' : ''}" data-mode="ace">
                  <div class="sys-card-header">
                    <span class="sys-card-radio"></span>
                    <span class="sys-card-title">NodeX Edge AI ACE decentralized</span>
                  </div>
                  <div class="sys-card-desc">Edge AI + RACE adaptive envelope, sessions, contracts, HITL</div>
                </div>
              </div>
            </div>

            <!-- SECTION 2: Simulation & Test Selection -->
            <div class="sidebar-panel-card collapsible" id="panel-sim-selection">
              <div class="sidebar-section-title-bar" id="toggle-sim-selection">
                <div class="title-left">
                  <span class="step-num-pill">2</span>
                  <span>Simulation & Test Selection</span>
                </div>
                <svg class="chevron-toggle" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </div>

              <div class="sim-selection-content" id="sim-selection-body">
                <!-- Tabs: Scenarios (14) vs ACE Tests (12) -->
                <div class="tab-pill-row">
                  <button class="sim-tab-pill ${onTests ? "" : "active"}" id="tab-pill-scenarios">Scenarios (${SCENARIOS.length})</button>
                  <button class="sim-tab-pill ${onTests ? "active" : ""}" id="tab-pill-tests">ACE Tests (${ACE_TESTS.length})</button>
                </div>

                <!-- Scenario Dropdown -->
                <div class="scenario-dropdown-wrap">
                  <select id="sel-scenario-list" class="scenario-native-select">
                    ${selectList.map(s => `
                      <option value="${s.code}" ${s.code === selectedScenarioCode ? 'selected' : ''}>
                        ${s.code} - ${s.name}
                      </option>
                    `).join("")}
                  </select>
                </div>

                <!-- Dynamic Description Box -->
                <div class="scenario-desc-box" id="scenario-desc-text">
                  ${scenario.description}
                </div>

                <!-- View Scenario Details Button -->
                <button class="btn-link-action" id="btn-view-scenario-details">
                  <span>View Scenario Details</span>
                  <span class="arrow-glyph">&rarr;</span>
                </button>
              </div>
            </div>

            <!-- SECTION 3: Robot Fleet List -->
            <div class="sidebar-panel-card fleet-panel-card" id="panel-robot-fleet">
              <div class="sidebar-section-title-bar" id="toggle-robot-fleet">
                <div class="title-left" id="btn-cycle-fleet-count" title="Click to cycle fleet count (3 → 10 → 50 → 100)" style="cursor: pointer;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                    <rect x="3" y="11" width="18" height="10" rx="2"></rect>
                    <circle cx="12" cy="5" r="2"></circle>
                    <path d="M12 7v4"></path>
                  </svg>
                  <span>Robot Fleet (<span id="fleet-count-title">${robots.length || 50}</span>)</span>
                </div>
                <svg class="chevron-toggle" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </div>

              <div class="fleet-content-body">
                <!-- Search Box -->
                <div class="fleet-search-wrap">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                  <input type="text" id="fleet-search-input" placeholder="Search robot..." value="${this.searchQuery}">
                </div>

                <!-- Robot Table -->
                <div class="fleet-table-container">
                  <table class="fleet-table" id="fleet-table">
                    <thead>
                      <tr>
                        <th style="width: 50px;">ID</th>
                        <th>Status</th>
                        <th>Task</th>
                        <th style="width: 60px;">Battery</th>
                      </tr>
                    </thead>
                    <tbody id="fleet-table-body">
                      <!-- Populated dynamically -->
                    </tbody>
                  </table>
                </div>

                <!-- View All Robots Button -->
                <button class="btn-link-action bottom-fleet-link" id="btn-view-all-robots">
                  <span>View All Robots</span>
                  <span class="arrow-glyph">&rarr;</span>
                </button>
              </div>
            </div>
          </aside>

          <!-- CENTER SIMULATION VIEWPORT -->
          <main class="ops-center-viewport">
            <div id="warehouse-map-mount" class="warehouse-mount-wrap"></div>
          </main>

          <!-- BOTTOM-LEFT: Active Events (under the left column) -->
          <!-- CARD 1: Active Events -->
          <div class="bottom-info-card events-card-wrap ops-events-cell">
            <div class="card-top-header">
              <div class="header-title-group">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                </svg>
                <span class="card-main-title">Active Events</span>
                <span class="notif-counter-pill red" id="events-count-pill">3</span>
              </div>
              <div class="filter-dropdown-pill">
                <span>All Events</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>

            <!-- Tabular Event Stream -->
            <div class="events-table-wrapper">
              <table class="events-stream-table">
                <thead>
                  <tr>
                    <th style="width: 65px;">Time</th>
                    <th style="width: 65px;">Source</th>
                    <th>Event</th>
                    <th style="width: 75px;">Severity</th>
                  </tr>
                </thead>
                <tbody id="events-stream-body">
                  <!-- Populated dynamically -->
                </tbody>
              </table>
            </div>
          </div>


          <!-- BOTTOM-CENTER: Task Progress + Fleet Status (under the map) -->
          <div class="ops-center-bottom">
          <!-- CARD 2: Task Progress -->
          <div class="bottom-info-card task-progress-card">
            <div class="card-top-header">
              <div class="header-title-group">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
                  <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
                </svg>
                <span class="card-main-title">Task Progress</span>
              </div>
              <span class="progress-pct-stat" id="task-progress-stat">0% (0 / 0)</span>
            </div>

            <!-- Multi-colored Segmented Bar -->
            <div class="segmented-bar-container">
              <div class="segment seg-pick" style="width: 0%;" title="Pick: 0"></div>
              <div class="segment seg-place" style="width: 0%;" title="Place: 0"></div>
              <div class="segment seg-transport" style="width: 0%;" title="Transport: 0"></div>
              <div class="segment seg-charge" style="width: 0%;" title="Charge: 0"></div>
              <div class="segment seg-other" style="width: 0%;" title="Other: 0"></div>
            </div>

            <!-- Legend with Counts -->
            <div class="task-categories-legend">
              <div class="task-cat-item"><span class="cat-dot seg-pick"></span>Pick <strong id="cnt-pick">0</strong></div>
              <div class="task-cat-item"><span class="cat-dot seg-place"></span>Place <strong id="cnt-place">0</strong></div>
              <div class="task-cat-item"><span class="cat-dot seg-transport"></span>Transport <strong id="cnt-transport">0</strong></div>
              <div class="task-cat-item"><span class="cat-dot seg-charge"></span>Charge <strong id="cnt-charge">0</strong></div>
              <div class="task-cat-item"><span class="cat-dot seg-other"></span>Other <strong id="cnt-other">0</strong></div>
            </div>
          </div>

          <!-- CARD 3: Fleet Status Donut Chart -->
          <div class="bottom-info-card fleet-status-card">
            <div class="card-top-header">
              <div class="header-title-group">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                  <rect x="3" y="11" width="18" height="10" rx="2"></rect>
                  <circle cx="12" cy="5" r="2"></circle>
                  <path d="M12 7v4"></path>
                </svg>
                <span class="card-main-title">Fleet Status (<span id="fleet-total-label">${robots.length || 50}</span>)</span>
              </div>
            </div>

            <div class="fleet-donut-wrap">
              <div class="donut-chart-box">
                <canvas class="donut-canvas" id="fleet-donut-canvas"></canvas>
                <div class="donut-overlay-label">
                  <span class="donut-total" id="donut-total-val">${robots.length || 50}</span>
                  <span class="donut-caption">Robots</span>
                </div>
              </div>

              <!-- Breakdown Rows -->
              <div class="fleet-status-legend-col">
                <div class="legend-stat-row">
                  <span class="color-bullet cyan"></span>
                  <span class="stat-name">Moving</span>
                  <span class="stat-num" id="stat-cnt-moving">0</span>
                </div>
                <div class="legend-stat-row">
                  <span class="color-bullet blue"></span>
                  <span class="stat-name">Idle</span>
                  <span class="stat-num" id="stat-cnt-idle">0</span>
                </div>
                <div class="legend-stat-row">
                  <span class="color-bullet yellow"></span>
                  <span class="stat-name">Charging</span>
                  <span class="stat-num" id="stat-cnt-charging">0</span>
                </div>
                <div class="legend-stat-row">
                  <span class="color-bullet red"></span>
                  <span class="stat-name">Error</span>
                  <span class="stat-num" id="stat-cnt-error">0</span>
                </div>
                <div class="legend-stat-row">
                  <span class="color-bullet gray"></span>
                  <span class="stat-name">Maintenance</span>
                  <span class="stat-num" id="stat-cnt-maint">0</span>
                </div>
              </div>
            </div>
          </div>

          </div>

          <!-- RIGHT INSPECTION SIDEBAR -->
          <aside class="ops-right-sidebar">
            <!-- CARD 1: Human Assist (HITL) (Dynamically mounted with 3 scopes & system gating) -->
            <div id="hitl-panel-mount" class="rs-card-mount"></div>

            <!-- CARD 2: Selected Robot (from fleet) -->
            <div id="robot-inspector-mount" class="inspector-mount-wrap rs-card-mount rs-flex"></div>

            <!-- CARD 3: Live Coordination (Dynamically mounted based on system mode) -->
            <div id="live-coord-mount" class="rs-card-mount"></div>

            <!-- CARD 4: System Status (Honest Telemetry Indicators) -->
            <div id="ops-system-status-mount" class="rs-card-mount">${this.renderSystemStatusCard()}</div>
          </aside>
        </div>

      </div>
    `;

    // Mount Warehouse Map
    const mapMount = this.container.querySelector("#warehouse-map-mount");
    if (mapMount) {
      this.mapInstance = new WarehouseMap(mapMount, { showLegend: false, height: "100%" });
    }

    // Mount Selected Robot Inspector
    const inspectorMount = this.container.querySelector("#robot-inspector-mount");
    if (inspectorMount) {
      this.inspectorInstance = new RobotInspector(inspectorMount);
    }

    this.renderFleetTable();
    this.renderEventsTable();
    this.renderDonutChart();
    this.renderHitlCard();
    this.renderLiveCoordinationCard();
    this.updateSimTabGating();
    this.updateSimTabGating();
    this.updateSimButtonStates(simLifecycle.getState());
    this.updateKPIs();
  }

  // System Status card, re-rendered from state (it was rendered once at mount,
  // so it kept showing the boot-time system/robot count during other runs).
  renderSystemStatusCard() {
    const systemMode = state.get("systemMode") || "ace";
    const robots = state.get("robots") || [];
    const coordination = state.get("coordination") || {};
    const systemHealth = state.get("kpis")?.systemHealth || "Awaiting telemetry";
    const runId = state.get("runId") || "—";
    const seed = state.get("seed") || 18427;
    return `
            <div class="sidebar-panel-card status-panel-card">
              <div class="card-top-header">
                <div class="header-title-group">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                  <span class="card-main-title">System Status</span>
                </div>
                <span class="system-mode-badge" style="text-transform: uppercase; font-size: 10px; background: ${systemMode === 'ace' ? 'rgba(16, 185, 129, 0.2)' : systemMode === 'centralized' ? 'rgba(2, 132, 199, 0.2)' : 'rgba(59, 130, 246, 0.2)'}; color: ${systemMode === 'ace' ? '#10B981' : systemMode === 'centralized' ? '#0284C7' : '#3B82F6'}; padding: 2px 8px; border-radius: 4px;">${systemMode}</span>
              </div>

              <div class="system-status-grid">
                <div class="status-row">
                  <span class="status-tick" style="color: #10B981;">&#10004;</span>
                  <span class="status-label">Active System</span>
                  <span class="status-val font-mono" style="color: #10B981; text-transform: capitalize;">${systemMode}</span>
                </div>
                <div class="status-row">
                  <span class="status-tick" style="color: #00C8FF;">&#10004;</span>
                  <span class="status-label">Robot Count</span>
                  <span class="status-val font-mono" style="color: #00C8FF;">${robots.length}</span>
                </div>
                <div class="status-row">
                  <span class="status-tick" style="color: #00C8FF;">&#10004;</span>
                  <span class="status-label">Sensors</span>
                  <span class="status-val font-mono" style="color: #00C8FF;">Virtual LiDAR + IMU</span>
                </div>
                ${(() => {
                  // Centralized robots talk to the server; the others to peers.
                  const link = systemMode === "centralized" ? coordination.centralServer?.status : coordination.peerNetwork?.status;
                  const ok = link === "ONLINE";
                  return `<div class="status-row">
                  <span class="status-tick" style="color: ${ok ? '#10B981' : '#F59E0B'};">${ok ? '&#10004;' : '&#9888;'}</span>
                  <span class="status-label">Communication</span>
                  <span class="status-val font-mono" style="color: ${ok ? '#10B981' : '#F59E0B'};">${link || 'Awaiting telemetry'}${systemMode === "centralized" ? " (server)" : " (peers)"}</span>
                </div>`;
                })()}
                <div class="status-row">
                  <span class="status-tick" style="color: ${this.getAlgorithmStatus(systemMode) ? '#10B981' : '#F59E0B'};">&#10004;</span>
                  <span class="status-label">Active Algorithms</span>
                  <span class="status-val font-mono" style="color: ${this.getAlgorithmStatus(systemMode) ? '#10B981' : '#F59E0B'}; font-size: 9px;">${this.getAlgorithmList(systemMode)}</span>
                </div>
                <div class="status-row">
                  <span class="status-tick" style="color: ${systemHealth === 'Awaiting telemetry' ? '#F59E0B' : '#10B981'};">&#10004;</span>
                  <span class="status-label">Runtime Health</span>
                  <span class="status-val font-mono" style="color: ${systemHealth === 'Awaiting telemetry' ? '#F59E0B' : '#10B981'};">${systemHealth}</span>
                </div>
                <div class="status-row">
                  <span class="status-tick" style="color: ${coordination.centralServer?.status === 'ONLINE' || coordination.peerNetwork?.status === 'ONLINE' || coordination.ace?.status === 'ONLINE' ? '#10B981' : '#F59E0B'};">&#10004;</span>
                  <span class="status-label">Architecture Status</span>
                  <span class="status-val font-mono" style="color: ${coordination.centralServer?.status === 'ONLINE' || coordination.peerNetwork?.status === 'ONLINE' || coordination.ace?.status === 'ONLINE' ? '#10B981' : '#F59E0B'};">${this.getArchitectureStatus(systemMode, coordination)}</span>
                </div>
                <div class="status-row">
                  <span class="status-tick" style="color: #00C8FF;">&#10004;</span>
                  <span class="status-label">Run ID / Seed</span>
                  <span class="status-val font-mono" style="color: #00C8FF;">${runId} / ${seed}</span>
                </div>
              </div>
            </div>
`;
  }

  refreshSystemStatusCard() {
    const mount = this.container.querySelector("#ops-system-status-mount");
    if (mount) mount.innerHTML = this.renderSystemStatusCard();
  }

  isSimulationActive() {
    const fsmState = simLifecycle.getState();
    return fsmState === "RUNNING" || fsmState === "PAUSED" || fsmState === "STARTING" || fsmState === "STOPPING";
  }

  showLockToast(message) {
    let toast = document.getElementById("nodex-lock-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "nodex-lock-toast";
      toast.className = "nodex-lock-toast";
      document.body.appendChild(toast);
    }
    toast.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #F59E0B; flex-shrink: 0;">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      <span>${message}</span>
    `;
    toast.classList.add("visible");
    clearTimeout(this._lockToastTimer);
    this._lockToastTimer = setTimeout(() => {
      toast.classList.remove("visible");
    }, 3200);
  }

  updateConfigLocking(isLocked) {
    const sysGrid = this.container.querySelector("#ops-sys-cards-grid");
    const kpiRobots = this.container.querySelector("#kpi-card-robots");
    const btnFleetCount = this.container.querySelector("#btn-cycle-fleet-count");
    const selScenario = this.container.querySelector("#sel-scenario-list");
    const tabScenarios = this.container.querySelector("#tab-pill-scenarios");
    const tabTests = this.container.querySelector("#tab-pill-tests");

    if (isLocked) {
      sysGrid?.classList.add("locked-midrun");
      kpiRobots?.classList.add("locked-midrun");
      btnFleetCount?.classList.add("locked-midrun");
      if (selScenario) selScenario.disabled = true;
      if (tabScenarios) tabScenarios.style.pointerEvents = "none";
      if (tabTests) tabTests.style.pointerEvents = "none";
    } else {
      sysGrid?.classList.remove("locked-midrun");
      kpiRobots?.classList.remove("locked-midrun");
      btnFleetCount?.classList.remove("locked-midrun");
      if (selScenario) selScenario.disabled = false;
      if (tabScenarios) tabScenarios.style.pointerEvents = "";
      if (tabTests) tabTests.style.pointerEvents = "";
    }
  }

  updateSimButtonStates(fsmState) {
    const btnStart = this.container.querySelector("#btn-sim-start");
    const btnPause = this.container.querySelector("#btn-sim-pause");
    const btnRestart = this.container.querySelector("#btn-sim-restart");

    const isRunning = fsmState === "RUNNING";
    const isPaused = fsmState === "PAUSED";
    const isStarting = fsmState === "STARTING";
    const isStopping = fsmState === "STOPPING";
    const isIdle = fsmState === "IDLE";

    if (btnStart) {
      if (isRunning || isPaused) {
        btnStart.className = "sim-ctrl-btn btn-stop";
        btnStart.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="5" y="5" width="14" height="14" rx="2"></rect>
          </svg>
          <span>Stop</span>
        `;
        btnStart.disabled = false;
        btnStart.title = "Stop active simulation";
      } else if (isStarting) {
        btnStart.className = "sim-ctrl-btn btn-start";
        btnStart.innerHTML = `
          <span style="font-size: 11px;">Starting...</span>
        `;
        btnStart.disabled = true;
      } else if (isStopping) {
        btnStart.className = "sim-ctrl-btn btn-stop";
        btnStart.innerHTML = `
          <span style="font-size: 11px;">Stopping...</span>
        `;
        btnStart.disabled = true;
      } else {
        btnStart.className = "sim-ctrl-btn btn-start";
        btnStart.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          <span>Start</span>
        `;
        btnStart.disabled = false;
        btnStart.title = "Start simulation";
      }
    }

    if (btnPause) {
      // One stateful button: "Pause" while running, "Resume" while paused.
      btnPause.disabled = !isRunning && !isPaused;
      btnPause.classList.toggle("disabled", btnPause.disabled);
      btnPause.classList.toggle("btn-resume", isPaused);
      btnPause.classList.toggle("active", isPaused);
      btnPause.classList.toggle("btn-pause", !isPaused);
      btnPause.dataset.toggle = isPaused ? "resume" : "pause";
      btnPause.title = isPaused ? "Resume simulation" : "Pause simulation";
      btnPause.innerHTML = isPaused
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Resume</span>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg><span>Pause</span>`;
    }

    if (btnRestart) {
      if (isIdle) {
        btnRestart.disabled = !simLifecycle.hasPreviousRun;
      } else if (isStarting || isStopping) {
        btnRestart.disabled = true;
      } else {
        btnRestart.disabled = false;
      }
      if (btnRestart.disabled) btnRestart.classList.add("disabled");
      else btnRestart.classList.remove("disabled");
    }

    this.updateConfigLocking(isRunning || isPaused || isStarting || isStopping);
  }

  bindEvents() {
    // 1. Simulation Controls
    const btnStart = this.container.querySelector("#btn-sim-start");
    const btnPause = this.container.querySelector("#btn-sim-pause");

    btnStart?.addEventListener("click", () => {
      const fsmState = simLifecycle.getState();
      if (fsmState === "RUNNING" || fsmState === "PAUSED") {
        simLifecycle.stop();
      } else if (fsmState === "IDLE" || fsmState === "STOPPED" || fsmState === "FINISHED" || fsmState === "ERROR") {
        simLifecycle.start({ animated: false });
      }
    });

    btnPause?.addEventListener("click", () => {
      const lc = simLifecycle.getState();
      if (lc === "RUNNING") simLifecycle.pause();
      else if (lc === "PAUSED") simLifecycle.resume();
    });

    const btnReset = this.container.querySelector("#btn-sim-reset");
    btnReset?.addEventListener("click", () => {
      simLifecycle.reset();
      this.updateKPIs();
      const elTime = document.getElementById("kpi-val-time");
      if (elTime) elTime.textContent = "00:00:00";
    });

    const btnRestart = this.container.querySelector("#btn-sim-restart");
    btnRestart?.addEventListener("click", () => {
      simLifecycle.restart({ animated: false });
      this.updateKPIs();
      const elTime = document.getElementById("kpi-val-time");
      if (elTime) elTime.textContent = "00:00:00";
    });

    // Robot Count Interactive Cycle Handler (3 -> 10 -> 50 -> 100)
    const cycleRobotCount = () => {
      if (this.isSimulationActive()) {
        this.showLockToast("Robot count cannot be changed while simulation is active. Stop or reset the simulation first.");
        return;
      }
      const cur = state.get("robotCount") || 50;
      const next = getNextRobotCount(cur);
      state.set("robotCount", next); // engine rebuilds the fleet via its subscription
      simEngine.addEvent("SYSTEM", "CONFIG", `Fleet reconfigured to ${next} AMRs.`);
    };

    const cardRobots = this.container.querySelector("#kpi-card-robots");
    cardRobots?.addEventListener("click", cycleRobotCount);

    const btnCycleCount = this.container.querySelector("#btn-cycle-fleet-count");
    btnCycleCount?.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleRobotCount();
    });

    // Speed click on KPI card
    const cardSpeed = this.container.querySelector("#kpi-card-speed");
    cardSpeed?.addEventListener("click", () => {
      const speeds = [1.0, 2.0, 5.0];
      const cur = state.get("simSpeed") || 1.0;
      const next = speeds[(speeds.indexOf(cur) + 1) % speeds.length];
      state.set("simSpeed", next);
      const valEl = document.getElementById("kpi-val-speed");
      if (valEl) valEl.textContent = `${next.toFixed(1)}x`;
    });

    // 2. System Selection Mode Radio Cards
    const sysCards = this.container.querySelectorAll(".sys-select-card");
    sysCards.forEach(card => {
      card.addEventListener("click", () => {
        if (this.isSimulationActive()) {
          this.showLockToast("System architecture cannot be changed while simulation is active. Stop or reset the simulation first.");
          return;
        }
        const mode = card.dataset.mode;
        if (!mode) return;
        const current = state.get("systemMode");
        if (mode === current) return; // Already selected — no-op
        sysCards.forEach(c => c.classList.toggle("selected", c.dataset.mode === mode));
        systemManager.switchSystem(mode);
        this.renderHitlCard();
        this.renderLiveCoordinationCard();
        this.updateSimTabGating();
      });
    });

    // 3. Scenario Dropdown
    const selScenario = this.container.querySelector("#sel-scenario-list");
    selScenario?.addEventListener("change", (e) => {
      if (this.isSimulationActive()) {
        this.showLockToast("Scenario selection is locked while simulation is active. Stop or reset the simulation first.");
        e.target.value = state.get("selectedScenario") || "S01";
        return;
      }
      const code = e.target.value;
      state.set("simTestType", ACE_TESTS.some(t => t.code === code) ? "aceTest" : "scenario");
      state.set("selectedScenario", code);
      const sc = SCENARIOS.find(s => s.code === code) || ACE_TESTS.find(t => t.code === code);
      const descEl = document.getElementById("scenario-desc-text");
      if (sc && descEl) descEl.textContent = sc.description;
    });

    // Scenario Details Modal Trigger
    const btnDetails = this.container.querySelector("#btn-view-scenario-details");
    btnDetails?.addEventListener("click", () => {
      const curCode = state.get("selectedScenario") || "S08";
      ScenarioDetailsModal.open(curCode);
    });

    // Scenarios vs Tests Tabs
    const tabScenarios = this.container.querySelector("#tab-pill-scenarios");
    const tabTests = this.container.querySelector("#tab-pill-tests");

    tabScenarios?.addEventListener("click", () => {
      if (this.isSimulationActive()) {
        this.showLockToast("Simulation test category is locked while simulation is active.");
        return;
      }
      this.activeSimTab = "scenarios";
      tabScenarios.classList.add("active");
      tabTests?.classList.remove("active");
      this.populateScenarioSelect("scenarios");
    });

    tabTests?.addEventListener("click", () => {
      if (this.isSimulationActive()) {
        this.showLockToast("Simulation test category is locked while simulation is active.");
        return;
      }
      const sys = state.get("systemMode") || "ace";
      if (sys !== "ace") return; // Gated
      this.activeSimTab = "tests";
      tabTests.classList.add("active");
      tabScenarios?.classList.remove("active");
      this.populateScenarioSelect("tests");
    });

    // 4. Robot Fleet Search
    const searchInput = this.container.querySelector("#fleet-search-input");
    searchInput?.addEventListener("input", (e) => {
      this.searchQuery = e.target.value.trim().toUpperCase();
      this.renderFleetTable();
    });

    // View All Robots Trigger
    const btnAllRobots = this.container.querySelector("#btn-view-all-robots");
    btnAllRobots?.addEventListener("click", () => {
      this.searchQuery = "";
      if (searchInput) searchInput.value = "";
      this.renderFleetTable();
    });

    // Right column: every card collapses/expands from its header, so the
    // column always fits the screen height (state survives card re-renders
    // because it lives on the mount element, not on the re-rendered card).
    this.container.querySelector(".ops-right-sidebar")?.addEventListener("click", (e) => {
      if (e.target.closest("button, input, select, label, a, .hitl-toggle-wrap")) return;
      const mount = e.target.closest(".rs-card-mount");
      const header = mount && mount.firstElementChild && mount.firstElementChild.firstElementChild;
      if (!header || !header.contains(e.target)) return;
      mount.classList.toggle("rs-collapsed");
    });

    // Subscribe to state changes
    state.subscribe("systemMode", (newMode) => {
      const cards = this.container.querySelectorAll(".sys-select-card");
      cards.forEach(c => c.classList.toggle("selected", c.dataset.mode === newMode));
      this.renderHitlCard();
      this.renderLiveCoordinationCard();
      this.updateSimTabGating();
    });

    state.subscribe("hitlEnabled", () => {
      this.renderHitlCard();
    });

    state.subscribe("hitlScope", () => {
      this.renderHitlCard();
    });

    state.subscribe("hitlSelectedGroup", () => {
      this.renderHitlCard();
    });

    state.subscribe("hitlSelectedRobot", () => {
      this.renderHitlCard();
    });

    state.subscribe("hitlCommandStatus", () => {
      this.renderHitlCard();
    });

    state.subscribe("hitlLease", () => {
      this.renderHitlCard();
    });

    state.subscribe("robots", () => {
      this.updateKPIs();
      this.renderFleetTable();
      this.renderDonutChart();
    });

    state.subscribe("robotCount", (count) => {
      this._forceRebuildTable = true;
      this.updateKPIs();
      this.renderFleetTable();
      this.renderDonutChart();
    });

    state.subscribe("selectedRobotId", () => {
      this.renderFleetTable();
    });

    state.subscribe("events", () => {
      this.renderEventsTable();
    });

    state.subscribe("selectedScenario", (code) => {
      if (selScenario && selScenario.value !== code) {
        selScenario.value = code;
      }
      const sc = SCENARIOS.find(s => s.code === code) || ACE_TESTS.find(t => t.code === code);
      const descEl = document.getElementById("scenario-desc-text");
      if (sc && descEl) descEl.textContent = sc.description;
    });

    state.subscribe("activeSessions", () => {
      this.renderLiveCoordinationCard();
    });

    state.subscribe("simLifecycleState", (newState) => {
      this.updateSimButtonStates(newState);
    });

    ["systemMode", "robotCount", "runId", "coordination"].forEach(key => {
      state.subscribe(key, () => this.refreshSystemStatusCard());
    });
  }

  updateSimTabGating() {
    const systemMode = state.get("systemMode") || "ace";
    const tabTests = this.container.querySelector("#tab-pill-tests");
    if (!tabTests) return;

    if (systemMode !== "ace") {
      tabTests.disabled = true;
      tabTests.style.opacity = "0.4";
      tabTests.style.cursor = "not-allowed";
      tabTests.title = "Available only in ACE mode";
      if (this.activeSimTab === "tests") {
        this.activeSimTab = "scenarios";
        const tabScenarios = this.container.querySelector("#tab-pill-scenarios");
        tabScenarios?.classList.add("active");
        tabTests.classList.remove("active");
        this.populateScenarioSelect("scenarios");
      }
    } else {
      tabTests.disabled = false;
      tabTests.style.opacity = "1";
      tabTests.style.cursor = "pointer";
      tabTests.title = "View ACE Validation Tests";
    }
  }

  renderHitlCard() {
    const mount = this.container.querySelector("#hitl-panel-mount");
    if (!mount) return;

    const systemMode = state.get("systemMode") || "ace";
    const hitlEnabled = state.get("hitlEnabled") || false;
    const hitlScope = normalizeHitlScope(state.get("hitlScope"));
    const hitlSelectedGroup = state.get("hitlSelectedGroup") || [];
    const robots = state.get("robots") || [];
    const selectedRobotId = state.get("selectedRobotId") || (robots[0]?.id || "R01");
    const targetRobotId = state.get("hitlSelectedRobot") || selectedRobotId;
    const lastFeedback = state.get("hitlCommandStatus") || null;

    const isAce = systemMode === "ace";

    let bodyHtml = "";

    if (!isAce) {
      bodyHtml = `
        <div class="hitl-header-row">
          <div class="hitl-title-stack">
            <div class="hitl-title-row">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              <span class="hitl-card-title">Human Assist (HITL)</span>
            </div>
            <div class="hitl-sub-line">Supervision &bull; Leases &bull; Arbitrated Override</div>
          </div>
          <span class="hitl-gated-badge">ACE Only</span>
        </div>
        <div class="hitl-gated-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; margin-top: 1px;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <div>
            <strong>Available only in ACE mode.</strong><br>
            Current mode: <span style="text-transform: uppercase;">${systemMode}</span>. Coordination layer does not support risk-adaptive human leases.
          </div>
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="hitl-header-row">
          <div class="hitl-title-stack">
            <div class="hitl-title-row">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              <span class="hitl-card-title">Human Assist (HITL)</span>
            </div>
            <div class="hitl-sub-line">Monitor &bull; Approve &bull; Take Control</div>
          </div>

          <div class="hitl-toggle-wrap">
            <label class="switch-hitl">
              <input type="checkbox" id="chk-hitl-toggle" ${hitlEnabled ? "checked" : ""}>
              <span class="slider round"></span>
            </label>
            <span class="toggle-text" id="hitl-toggle-label">${hitlEnabled ? "On" : "Off"}</span>
          </div>
        </div>
      `;

      if (!hitlEnabled) {
        bodyHtml += `
          <div class="hitl-standby-hint">
            HITL supervision is <strong>Standby</strong>. Toggle switch ON to activate the 3 coordination scopes (Entire Fleet, Robot Group, Individual Robot).
          </div>
        `;
      } else {
        bodyHtml += `
          <div class="hitl-scope-section">
            <div class="hitl-scope-label">
              <span>HITL Coordination Scope</span>
              <span style="font-size: 9px; color: var(--accent-cyan); font-weight: 800; font-family: monospace;">${hitlScope.toUpperCase()}</span>
            </div>

            <!-- 3 Scope Buttons -->
            <div class="hitl-scope-pills">
              <button class="hitl-scope-pill ${hitlScope === 'ENTIRE_FLEET' ? 'active' : ''}" id="btn-scope-fleet" title="Target entire AMR fleet">
                Entire Fleet
              </button>
              <button class="hitl-scope-pill ${hitlScope === 'ROBOT_GROUP' ? 'active' : ''}" id="btn-scope-group" title="Target custom group of AMRs">
                Robot Group
              </button>
              <button class="hitl-scope-pill ${hitlScope === 'INDIVIDUAL_ROBOT' ? 'active' : ''}" id="btn-scope-individual" title="Target specific AMR">
                Individual Robot
              </button>
            </div>

            <!-- Dynamic Target Area -->
            <div class="hitl-target-box">
        `;

        if (hitlScope === "ENTIRE_FLEET") {
          bodyHtml += `
            <div class="hitl-target-desc">
              <span style="font-weight: 700; color: var(--accent-cyan);">Target:</span>
              <span>All Active AMRs (${robots.length} Robots in Fleet)</span>
            </div>
            <div style="font-size: 9.5px; color: var(--text-secondary);">
              Supervisory commands dispatch concurrently across all autonomous mobile robots.
            </div>
          `;
        } else if (hitlScope === "ROBOT_GROUP") {
          const selectedSet = new Set(hitlSelectedGroup);
          bodyHtml += `
            <div class="hitl-target-desc" style="justify-content: space-between;">
              <div>
                <span style="font-weight: 700; color: var(--accent-cyan);">Target:</span>
                <span>Group (${selectedSet.size} Selected)</span>
              </div>
              <div style="display: flex; gap: 4px;">
                <button id="btn-group-select-all" style="background: none; border: none; font-size: 9px; color: #0077FF; cursor: pointer; text-decoration: underline;">All</button>
                <span style="color: var(--border-color);">|</span>
                <button id="btn-group-clear" style="background: none; border: none; font-size: 9px; color: #7384A0; cursor: pointer; text-decoration: underline;">Clear</button>
              </div>
            </div>

            <div class="hitl-group-list">
              ${robots.slice(0, 16).map(r => `
                <label class="hitl-group-item ${selectedSet.has(r.id) ? 'checked' : ''}">
                  <input type="checkbox" class="hitl-group-chk" data-robot-id="${r.id}" ${selectedSet.has(r.id) ? 'checked' : ''}>
                  <span>${r.id}</span>
                </label>
              `).join("")}
            </div>
          `;
        } else {
          // Individual Robot
          bodyHtml += `
            <div class="hitl-target-desc">
              <span style="font-weight: 700; color: var(--accent-cyan);">Target:</span>
              <span>Single AMR</span>
            </div>
            <div class="hitl-individual-picker">
              <select id="sel-hitl-individual-robot" class="hitl-robot-select">
                ${robots.map(r => `
                  <option value="${r.id}" ${r.id === targetRobotId ? 'selected' : ''}>${r.id} (${r.status})</option>
                `).join("")}
              </select>
              <button class="btn-hitl-teleop-lease" id="btn-open-hitl-teleop" title="Take direct manual teleoperation lease (controls open here, the map stays visible)">
                ${activeInlineLease ? "Switch Lease" : "Teleop Lease"} &rarr;
              </button>
            </div>
            <div id="hitl-lease-mount"></div>
          `;
        }

        bodyHtml += `
            </div>

            <!-- Command Dispatch Actions -->
            <div class="hitl-cmd-buttons">
              <button class="btn-hitl-cmd btn-hitl-hold" id="btn-cmd-hold" title="Issue speed clamp / temporary hold">
                Hold Motion
              </button>
              <button class="btn-hitl-cmd btn-hitl-resume" id="btn-cmd-resume" title="Resume normal autonomous coordination">
                Resume Nav
              </button>
              <button class="btn-hitl-cmd btn-hitl-stop" id="btn-cmd-safe-stop" title="Trigger safety emergency stop">
                Safe Stop
              </button>
            </div>

            <!-- Dynamic Feedback Line -->
            <div class="hitl-feedback-line ${lastFeedback ? (lastFeedback.type === 'stop' ? 'warn' : 'success') : ''}" id="hitl-feedback-status">
              <span>${lastFeedback ? `✓ ${lastFeedback.msg}` : `Target: ${this.getResolvedHitlTargetText(hitlScope)}`}</span>
            </div>
          </div>
        `;
      }
    }

    mount.innerHTML = `
      <div class="sidebar-panel-card hitl-panel-card ${!isAce ? 'disabled-system-gated' : ''}">
        ${bodyHtml}
      </div>
    `;

    this.bindHitlCardEvents(isAce, hitlEnabled, hitlScope);
    // Keep an active teleop lease panel inside the card across re-renders; a
    // lease on a scope/system that no longer shows the panel is released.
    if (activeInlineLease) {
      if (isAce && hitlEnabled && hitlScope === "INDIVIDUAL_ROBOT") activeInlineLease.remount();
      else {
        const r = simEngine.getRobotState(activeInlineLease.activeRobotId);
        if (r) activeInlineLease.releaseControl(r, "HITL panel scope changed");
      }
    }
  }

  getResolvedHitlTargetText(scope) {
    const robots = state.get("robots") || [];
    scope = normalizeHitlScope(scope);
    if (scope === "ENTIRE_FLEET") return `Entire Fleet (${robots.length} AMRs)`;
    if (scope === "ROBOT_GROUP") {
      const grp = state.get("hitlSelectedGroup") || [];
      return grp.length > 0 ? `${grp.length} Selected AMRs (${grp.slice(0, 3).join(", ")}${grp.length > 3 ? "..." : ""})` : "No AMRs selected in group";
    }
    const targetId = state.get("hitlSelectedRobot") || state.get("selectedRobotId") || "R01";
    return `Individual AMR ${targetId}`;
  }

  bindHitlCardEvents(isAce, hitlEnabled, hitlScope) {
    if (!isAce) return;

    // HITL Toggle
    const chkHitl = this.container.querySelector("#chk-hitl-toggle");
    chkHitl?.addEventListener("change", (e) => {
      const checked = e.target.checked;
      state.set("hitlEnabled", checked);
      state.set("hitlMode", checked ? "MONITOR" : "OFF");
    });

    if (!hitlEnabled) return;

    // Scope Pill Switchers
    this.container.querySelector("#btn-scope-fleet")?.addEventListener("click", () => {
      state.set("hitlScope", "ENTIRE_FLEET");
    });

    this.container.querySelector("#btn-scope-group")?.addEventListener("click", () => {
      // Ensure group is initialized
      const curGroup = state.get("hitlSelectedGroup");
      if (!curGroup || curGroup.length === 0) {
        state.set("hitlSelectedGroup", ["R01", "R02"]);
      }
      state.set("hitlScope", "ROBOT_GROUP");
    });

    this.container.querySelector("#btn-scope-individual")?.addEventListener("click", () => {
      state.set("hitlScope", "INDIVIDUAL_ROBOT");
    });

    // Group Checkbox Handlers
    const groupCheckboxes = this.container.querySelectorAll(".hitl-group-chk");
    groupCheckboxes.forEach(chk => {
      chk.addEventListener("change", () => {
        const id = chk.getAttribute("data-robot-id");
        const currentGroup = state.get("hitlSelectedGroup") || [];
        const nextGroup = chk.checked ? [...currentGroup, id] : currentGroup.filter(x => x !== id);
        state.set("hitlSelectedGroup", nextGroup);
      });
    });

    // Group Quick Selectors
    this.container.querySelector("#btn-group-select-all")?.addEventListener("click", () => {
      const robots = state.get("robots") || [];
      state.set("hitlSelectedGroup", robots.slice(0, 16).map(r => r.id));
    });

    this.container.querySelector("#btn-group-clear")?.addEventListener("click", () => {
      state.set("hitlSelectedGroup", []);
    });

    // Individual Robot Select
    const selIndividual = this.container.querySelector("#sel-hitl-individual-robot");
    selIndividual?.addEventListener("change", (e) => {
      state.set("hitlSelectedRobot", e.target.value);
      state.set("selectedRobotId", e.target.value);
    });

    // Teleop Lease Trigger
    this.container.querySelector("#btn-open-hitl-teleop")?.addEventListener("click", () => {
      const targetId = state.get("hitlSelectedRobot") || state.get("selectedRobotId") || "R01";
      new HitlModal({ inline: true }).open(targetId);
      this.renderHitlCard();
    });

    // Command Dispatch Buttons: Hold, Resume, Safe Stop
    const dispatchCommand = (action) => {
      const robots = state.get("robots") || [];
      let targetIds = [];

      if (hitlScope === "ENTIRE_FLEET") {
        targetIds = robots.map(r => r.id);
      } else if (hitlScope === "ROBOT_GROUP") {
        targetIds = state.get("hitlSelectedGroup") || [];
      } else {
        const singleId = state.get("hitlSelectedRobot") || state.get("selectedRobotId") || "R01";
        targetIds = [singleId];
      }

      if (targetIds.length === 0) {
        state.set("hitlCommandStatus", { msg: "Cannot dispatch: No AMRs selected", type: "warn" });
        return;
      }

      // Single authoritative path (same as the Control screen): adapter gating,
      // write-through to the robot agents, audit log and event log.
      hitlController.dispatchCommand({
        scope: hitlScope,
        targets: targetIds,
        action,
        reason: "Operations screen operator command"
      });
    };

    this.container.querySelector("#btn-cmd-hold")?.addEventListener("click", () => dispatchCommand("hold"));
    this.container.querySelector("#btn-cmd-resume")?.addEventListener("click", () => dispatchCommand("resume"));
    this.container.querySelector("#btn-cmd-safe-stop")?.addEventListener("click", () => dispatchCommand("safe_stop"));
  }

  renderLiveCoordinationCard() {
    const mount = this.container.querySelector("#live-coord-mount");
    if (!mount) return;

    const systemMode = state.get("systemMode") || "ace";

    let html = "";
    if (systemMode === "ace") {
      const activeSessions = state.get("activeSessions") || [];
      const contracts = state.get("contracts") || [];
      const robots = state.get("robots") || [];
      const sessionCount = activeSessions.length;

      // Build detailed session items for ACE mode
      const sessionItems = activeSessions.length > 0
        ? activeSessions.slice(0, 4).map(s => {
            // Real runtime session: all members + its own space-time contract.
            const members = s.robots.map(id => robots.find(r => r.id === id)).filter(Boolean);
            const contract = contracts.find(c => c.sessionId === s.id);
            const maxRisk = Math.max(0, ...members.map(r => (typeof r.riskScore === "number" ? r.riskScore : 0)));
            const inputs = {};
            for (const r of members) for (const [k, v] of Object.entries(r.riskComponents || {})) {
              if (["conflict", "uncertainty", "commRisk", "queueGrowth", "cascadePressure"].includes(k)) inputs[k] = Math.max(inputs[k] || 0, v);
            }
            const riskFactors = Object.entries(inputs).filter(([, v]) => v > 0.2).map(([k, v]) => `${k}: ${v.toFixed(2)}`);
            const envelopes = members.map(r => `${r.id}:${r.raceState || "—"}(${r.envelopeRadius || 0})`).join(" ");
            const holding = members.filter(r => r.isYielding || r.status === "WAITING").map(r => r.id);
            const contractState = contract
              ? `${contract.order.join(" → ")} · ends ${contract.expiration}s`
              : "—";
            return `
              <div class="coord-item ace-detail">
                <div class="coord-top-row">
                  <span class="coord-check">&#10004;</span>
                  <span class="coord-robots">${s.robots.join(" &harr; ")}</span>
                  <span class="coord-scope-tag ${(s.scope || "neighborhood").toLowerCase()}">${s.scope} · ${s.robots.length} robots</span>
                </div>
                <div class="coord-detail-grid">
                  <div class="coord-detail-row">
                    <span class="coord-detail-label">Reason</span>
                    <span class="coord-detail-value">${s.reason || "—"}</span>
                  </div>
                  <div class="coord-detail-row">
                    <span class="coord-detail-label">Max RACE Risk</span>
                    <span class="coord-detail-value font-mono">${maxRisk.toFixed(2)}</span>
                  </div>
                  <div class="coord-detail-row">
                    <span class="coord-detail-label">Risk Factors</span>
                    <span class="coord-detail-value font-mono" style="font-size: 8px;">${riskFactors.join(", ") || "—"}</span>
                  </div>
                  <div class="coord-detail-row">
                    <span class="coord-detail-label">ACE Envelopes</span>
                    <span class="coord-detail-value font-mono" style="font-size: 8px;">${envelopes}</span>
                  </div>
                  <div class="coord-detail-row">
                    <span class="coord-detail-label">Space-Time Contract</span>
                    <span class="coord-detail-value font-mono" style="font-size: 8px;">${contractState}</span>
                  </div>
                  <div class="coord-detail-row">
                    <span class="coord-detail-label">Holding</span>
                    <span class="coord-detail-value font-mono" style="font-size: 8px;">${holding.join(", ") || "none"}</span>
                  </div>
                </div>
              </div>
            `;
          }).join("")
        : `
            <div style="font-size: 10.5px; color: var(--text-muted); padding: 8px 4px; line-height: 1.4;">
              Autonomous Local Autonomy (LOCAL). No active bottleneck clusters detected. Envelopes dynamically scale upon trajectory convergence.
            </div>
          `;

      html = `
        <div class="sidebar-panel-card coord-panel-card">
          <div class="card-top-header">
            <div class="header-title-group">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
                <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
                <line x1="12" y1="20" x2="12.01" y2="20"></line>
              </svg>
              <span class="card-main-title">Live Coordination (ACE)</span>
            </div>
            <span class="badge-active-count" id="badge-coord-count">${sessionCount} Active</span>
          </div>

          <div class="coord-sessions-list" id="coord-sessions-list">
            ${sessionItems}
          </div>
        </div>
      `;
    } else if (systemMode === "decentralized") {
      // Keep collapsed/inactive for Decentralized
      html = `
        <div class="sidebar-panel-card coord-panel-card collapsed">
          <div class="card-top-header">
            <div class="header-title-group">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
              <span class="card-main-title">Decentralized Protocol</span>
            </div>
            <span class="badge-active-count" style="background: rgba(0, 119, 255, 0.2); color: #60A5FA;">Distributed</span>
          </div>
          <div class="coord-collapsed-content">
            <div style="font-size: 10.5px; color: var(--text-secondary); line-height: 1.5; padding: 8px 4px;">
              ${(() => {
                const m = state.get("architectureMetrics");
                const live = (state.get("activeSessions") || []).length;
                if (!m || m.system !== "decentralized") return "Fixed two-robot P2P coordination. RACE / Edge AI / HITL not present.";
                const c = m.coordination || {}, a = m.allocation || {};
                return `Live pairs: <b>${live}</b> (fixed 2 robots) · pair sessions ${c.pairSessions} (refresh ${c.refreshPairSessions}, conflict ${c.conflictPairSessions})<br>`
                  + `Busy rejections ${c.busyRejections} · pair wait ${c.pairWaitSeconds}s · sensor conflicts ${m.sensorConflictEvents}<br>`
                  + `CNP awards ${a.awardedTasks} · allocation latency ${a.allocationLatencyAvgS ?? "—"}s · peer msgs ${m.communication.peerMessages}`;
              })()}
            </div>
          </div>
        </div>
      `;
    } else {
      // Centralized - keep collapsed/inactive
      html = `
        <div class="sidebar-panel-card coord-panel-card collapsed">
          <div class="card-top-header">
            <div class="header-title-group">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                <line x1="6" y1="6" x2="6.01" y2="6"></line>
                <line x1="6" y1="18" x2="6.01" y2="18"></line>
              </svg>
              <span class="card-main-title">Centralized Coordinator</span>
            </div>
            <span class="badge-active-count" style="background: rgba(148, 163, 184, 0.2); color: #94A3B8;">Server Solver</span>
          </div>
          <div class="coord-collapsed-content">
            <div style="font-size: 10.5px; color: var(--text-secondary); line-height: 1.5; padding: 8px 4px;">
              ${(() => {
                const m = state.get("architectureMetrics");
                if (!m || m.system !== "centralized") return "Central server: Hungarian allocation, CBS planning, central collision detection.";
                const a = m.allocation || {}, p = m.planning || {}, d = m.collisionDetection || {};
                return `Server <b>${m.serverOnline ? "ONLINE" : "OFFLINE (safe hold)"}</b> · Hungarian decisions ${a.decisions} · allocation latency ${a.allocationLatencyAvgS ?? "—"}s<br>`
                  + `CBS runs ${p.runs} · conflicts resolved ${p.conflictsResolved} · avg ${p.avgPlanMs ?? "—"} ms · replans ${p.replans}<br>`
                  + `Central detections ${d.total} · uplink ${m.communication.uplinkMessages} · commands ${m.communication.downlinkCommands}`;
              })()}
            </div>
          </div>
        </div>
      `;
    }

    mount.innerHTML = html;
  }

  /**
   * Fills the selector for the chosen tab AND makes that choice the run the
   * lifecycle will start (run type + code). Previously the ACE Tests tab only
   * changed the option list: the run type stayed "scenario" and the old
   * scenario code stayed selected, so an ACE test could never be started.
   */
  populateScenarioSelect(mode) {
    const sel = this.container.querySelector("#sel-scenario-list");
    const desc = this.container.querySelector("#scenario-desc-text");
    if (!sel) return;
    const list = mode === "scenarios" ? SCENARIOS : ACE_TESTS;
    const current = state.get("selectedScenario");
    const remembered = mode === "scenarios" ? this._lastScenarioCode : this._lastTestCode;
    const code = list.some(x => x.code === current) ? current
      : list.some(x => x.code === remembered) ? remembered : list[0].code;
    if (mode === "scenarios") this._lastTestCode = ACE_TESTS.some(x => x.code === current) ? current : this._lastTestCode;
    else this._lastScenarioCode = SCENARIOS.some(x => x.code === current) ? current : this._lastScenarioCode;
    sel.innerHTML = list.map(s => `
        <option value="${s.code}">
          ${s.code} - ${s.name}
        </option>
      `).join("");
    sel.value = code;
    state.set("simTestType", mode === "scenarios" ? "scenario" : "aceTest");
    state.set("selectedScenario", code);
    const def = list.find(x => x.code === code);
    if (desc && def) desc.textContent = def.description;
  }

  renderFleetTable() {
    const tbody = this.container.querySelector("#fleet-table-body");
    if (!tbody) return;

    const robots = state.get("robots") || [];
    const selectedId = state.get("selectedRobotId") || "R01";

    const filtered = robots.filter(r => {
      if (!this.searchQuery) return true;
      return r.id.toUpperCase().includes(this.searchQuery) ||
             (r.currentTask && r.currentTask.toUpperCase().includes(this.searchQuery));
    });

    const existingRows = tbody.querySelectorAll(".fleet-row");
    if (existingRows.length === filtered.length && !this._forceRebuildTable) {
      for (let idx = 0; idx < filtered.length; idx++) {
        const r = filtered[idx];
        const row = existingRows[idx];
        const isSelected = r.id === selectedId;
        if (isSelected && !row.classList.contains("selected")) row.classList.add("selected");
        if (!isSelected && row.classList.contains("selected")) row.classList.remove("selected");

        // Runtime statuses are uppercase (IDLE/ERROR/...); comparing only the
        // lowercase forms showed every robot as "Moving".
        const st = String(r.status || "").toUpperCase();
        const isError = st === "ERROR" || st === "FAILED";
        const isCharging = st === "CHARGING";
        const isIdle = st === "IDLE";

        const statusDotClass = isError ? "dot-error" : isCharging ? "dot-charging" : isIdle ? "dot-idle" : "dot-moving";
        const statusText = isError ? "Error" : isCharging ? "Charging" : isIdle ? "Idle" : (r.isYielding ? "Yielding" : "Moving");

        const dot = row.querySelector(".status-indicator-dot");
        if (dot && dot.className !== `status-indicator-dot ${statusDotClass}`) {
          dot.className = `status-indicator-dot ${statusDotClass}`;
        }
        const textSpan = row.querySelector(".robot-status-cell span:last-child");
        if (textSpan && textSpan.textContent !== statusText) {
          textSpan.textContent = statusText;
        }
        const taskCell = row.querySelector(".robot-task-cell");
        const taskShort = r.currentTask ? r.currentTask.split(" ")[0] : "—";
        if (taskCell && taskCell.textContent !== taskShort) {
          taskCell.textContent = taskShort;
        }
        const batText = row.querySelector(".bat-pct-text");
        if (batText && batText.textContent !== `${r.battery}%`) {
          batText.textContent = `${r.battery}%`;
        }
        const batFill = row.querySelector(".bat-mini-fill");
        if (batFill) {
          batFill.style.width = `${r.battery}%`;
        }
      }
      return;
    }

    this._forceRebuildTable = false;
    tbody.innerHTML = filtered.map(r => {
      const isSelected = r.id === selectedId;
      const st = String(r.status || "").toUpperCase();
      const isError = st === "ERROR" || st === "FAILED";
      const isCharging = st === "CHARGING";
      const isIdle = st === "IDLE";

      const statusDotClass = isError ? "dot-error" : isCharging ? "dot-charging" : isIdle ? "dot-idle" : "dot-moving";
      const statusText = isError ? "Error" : isCharging ? "Charging" : isIdle ? "Idle" : (r.isYielding ? "Yielding" : "Moving");

      return `
        <tr class="fleet-row ${isSelected ? 'selected' : ''}" data-robot-id="${r.id}">
          <td class="robot-id-cell font-mono">${r.id}</td>
          <td class="robot-status-cell">
            <span class="status-indicator-dot ${statusDotClass}"></span>
            <span>${statusText}</span>
          </td>
          <td class="robot-task-cell font-mono">${r.currentTask ? r.currentTask.split(" ")[0] : "—"}</td>
          <td class="robot-bat-cell">
            <div class="bat-mini-wrap">
              <span class="bat-pct-text">${r.battery}%</span>
              <div class="bat-mini-track">
                <div class="bat-mini-fill" style="width: ${r.battery}%; background: ${r.battery < 30 ? '#EF4444' : '#10B981'};"></div>
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    // Bind row click
    const rows = tbody.querySelectorAll(".fleet-row");
    rows.forEach(row => {
      row.addEventListener("click", () => {
        const id = row.getAttribute("data-robot-id");
        state.set("selectedRobotId", id);
      });
    });
  }

  renderEventsTable() {
    const tbody = this.container.querySelector("#events-stream-body");
    if (!tbody) return;

    const events = state.get("events") || [];
    const stream = events.slice(0, 10);

    if (stream.length === 0) {
      tbody.innerHTML = `
        <tr class="event-stream-row">
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 14px; font-size: 11px;">
            Awaiting real-time simulation events...
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = stream.map(e => {
      let severityClass = "info";
      let severityText = "Info";

      const upperType = (e.type || "").toUpperCase();
      const upperDesc = (e.desc || "").toUpperCase();

      if (upperType.includes("FAULT") || upperType.includes("CRITICAL") || upperDesc.includes("FAILURE")) {
        severityClass = "critical";
        severityText = "Critical";
      } else if (upperType.includes("WARN") || upperDesc.includes("ENVELOPE") || upperDesc.includes("RISK")) {
        severityClass = "warning";
        severityText = "Warning";
      } else if (upperType.includes("SUCCESS") || upperDesc.includes("COMPLETED")) {
        severityClass = "success";
        severityText = "Success";
      }

      return `
        <tr class="event-stream-row">
          <td class="ev-time font-mono">${e.time || "00:00:00"}</td>
          <td class="ev-actor"><span class="actor-tag actor-${severityClass}">${e.actor || "SYSTEM"}</span></td>
          <td class="ev-desc" title="${e.desc}">${e.desc}</td>
          <td class="ev-severity"><span class="severity-pill pill-${severityClass}">${severityText}</span></td>
        </tr>
      `;
    }).join("");
  }

  renderDonutChart() {
    const canvas = this.container.querySelector("#fleet-donut-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    // Drawn at the canvas' laid-out size (the card scales with the screen).
    const S = Math.round(canvas.getBoundingClientRect().width) || 74;
    canvas.width = S * dpr;
    canvas.height = S * dpr;
    ctx.scale(dpr, dpr);

    const robots = state.get("robots") || [];
    let moving = 0, idle = 0, charging = 0, error = 0, maint = 0;

    for (const r of robots) {
      if (r.status === "error" || r.status === "ERROR") error++;
      else if (r.taskPhase === "MAINTENANCE") maint++;
      else if (r.status === "charging" || r.status === "CHARGING") charging++;
      else if (r.status === "idle" || r.status === "IDLE" || r.velocity === 0) idle++;
      else moving++;
    }

    // Update numbers in legend
    const setTxt = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    setTxt("stat-cnt-moving", moving);
    setTxt("stat-cnt-idle", idle);
    setTxt("stat-cnt-charging", charging);
    setTxt("stat-cnt-error", error);
    setTxt("stat-cnt-maint", maint);
    setTxt("donut-total-val", robots.length);

    const data = [
      { count: moving, color: "#00C8FF" },
      { count: idle, color: "#0077FF" },
      { count: charging, color: "#F59E0B" },
      { count: error, color: "#EF4444" },
      { count: maint, color: "#64748B" }
    ];

    const total = data.reduce((acc, d) => acc + d.count, 0) || 50;
    const cx = S / 2, cy = S / 2, r = S * 27 / 74, strokeW = Math.max(6, S * 6 / 74);

    ctx.clearRect(0, 0, S, S);
    let startAngle = -Math.PI / 2;

    for (const d of data) {
      if (d.count === 0) continue;
      const sliceAngle = (d.count / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
      ctx.strokeStyle = d.color;
      ctx.lineWidth = strokeW;
      ctx.stroke();
      startAngle += sliceAngle;
    }
  }

  updateKPIs() {
    const robots = state.get("robots") || [];
    const count = state.get("robotCount") || robots.length || 50;
    const elRobots = document.getElementById("kpi-val-robots");
    const elFleetTitle = document.getElementById("fleet-count-title");
    const elFleetTotal = document.getElementById("fleet-total-label");
    const elDonutTotal = document.getElementById("donut-total-val");
    if (elRobots) elRobots.textContent = count;
    if (elFleetTitle) elFleetTitle.textContent = count;
    if (elFleetTotal) elFleetTotal.textContent = count;
    if (elDonutTotal) elDonutTotal.textContent = count;

    const kpis = state.get("kpis") || {};
    const activeTasks = kpis.activeTasks ?? 0;
    const totalTasks = kpis.totalTasks || (activeTasks > 0 ? activeTasks : count);
    const elProgressStat = document.getElementById("task-progress-stat");
    if (elProgressStat) {
      const pct = totalTasks > 0 ? Math.round((activeTasks / totalTasks) * 100) : 0;
      elProgressStat.textContent = `${pct}% (${activeTasks} / ${totalTasks})`;
    }
    const elTasks = document.getElementById("kpi-val-tasks");
    if (elTasks) {
      elTasks.textContent = activeTasks;
    }
    const elAlerts = document.getElementById("kpi-val-alerts");
    if (elAlerts) {
      elAlerts.textContent = kpis.activeAlerts ?? 0;
    }

    this.updateTaskProgressBar(robots, activeTasks);
  }

  updateTaskProgressBar(robots, activeTasks) {
    const tasks = state.get("tasks") || [];
    let pick = 0, place = 0, transport = 0, charge = 0, notAssigned = 0;

    const isDone = (s) => s === "COMPLETED" || s === "completed";
    const isActive = (s) => s === "ASSIGNED" || s === "assigned" || s === "EXECUTING" || s === "executing" || s === "IN_PROGRESS" || s === "in_progress";
    for (const t of tasks) {
      if (isDone(t.status) || isActive(t.status)) {
        if (t.type?.includes("Pick")) pick++;
        else if (t.type?.includes("Place")) place++;
        else transport++;
      } else if (t.status === "CHARGING" || t.status === "charging") {
        charge++;
      } else {
        notAssigned++;
      }
    }

    const total = pick + place + transport + charge + notAssigned || 1;
    const pPick = Math.round((pick / total) * 100);
    const pPlace = Math.round((place / total) * 100);
    const pTrans = Math.round((transport / total) * 100);
    const pCharge = Math.round((charge / total) * 100);
    const pOther = Math.max(0, 100 - (pPick + pPlace + pTrans + pCharge));

    const segPick = this.container.querySelector(".seg-pick");
    const segPlace = this.container.querySelector(".seg-place");
    const segTrans = this.container.querySelector(".seg-transport");
    const segCharge = this.container.querySelector(".seg-charge");
    const segOther = this.container.querySelector(".seg-other");

    if (segPick) { segPick.style.width = `${pPick}%`; segPick.title = `Pick: ${pick}`; }
    if (segPlace) { segPlace.style.width = `${pPlace}%`; segPlace.title = `Place: ${place}`; }
    if (segTrans) { segTrans.style.width = `${pTrans}%`; segTrans.title = `Transport: ${transport}`; }
    if (segCharge) { segCharge.style.width = `${pCharge}%`; segCharge.title = `Charge: ${charge}`; }
    if (segOther) { segOther.style.width = `${pOther}%`; segOther.title = `Other (unassigned/failed): ${notAssigned}`; }

    const elPick = document.getElementById("cnt-pick");
    const elPlace = document.getElementById("cnt-place");
    const elTrans = document.getElementById("cnt-transport");
    const elCharge = document.getElementById("cnt-charge");
    const elOther = document.getElementById("cnt-other");
    const elProgressStat = document.getElementById("task-progress-stat");

    if (elPick) elPick.textContent = pick;
    if (elPlace) elPlace.textContent = place;
    if (elTrans) elTrans.textContent = transport;
    if (elCharge) elCharge.textContent = charge;
    if (elOther) elOther.textContent = notAssigned;
    if (elProgressStat) {
      const completed = tasks.filter(t => t.status === "COMPLETED" || t.status === "completed").length;
      elProgressStat.textContent = `${Math.round((completed / total) * 100)}% (${completed} / ${total})`;
    }
  }

  startLiveLoops() {
    setInterval(() => {
      const elTime = document.getElementById("kpi-val-time");
      if (elTime) {
        elTime.textContent = simEngine.formatSimTime(state.get("simTimeSeconds"));
      }

      // Update Expected Time to End
      const tasks = state.get("tasks") || [];
      const simTime = state.get("simTimeSeconds") || 0;
      const completedTasks = tasks.filter(t => t.status === "COMPLETED" || t.status === "completed").length;
      const totalTasks = tasks.length || 1;
      const remainingTasks = Math.max(0, totalTasks - completedTasks);
      const tasksPerSecond = completedTasks / Math.max(1, simTime);
      const expectedTimeEnd = tasksPerSecond > 0 && remainingTasks > 0
        ? Math.round(remainingTasks / tasksPerSecond)
        : (remainingTasks > 0 ? 0 : simTime);
      const elTimeEnd = document.getElementById("kpi-val-time-end");
      if (elTimeEnd) {
        elTimeEnd.textContent = expectedTimeEnd > 0 ? simEngine.formatSimTime(expectedTimeEnd) : "--:--:--";
      }

      this.updateKPIs();
      // Live-refresh operational panels from the same authoritative state.
      // Fleet table uses efficient in-place row updates; inspector re-renders
      // selected-robot telemetry; events table appends new event stream rows.
      try {
        this.renderFleetTable();
        if (this.inspectorInstance) this.inspectorInstance.render();
        this.renderEventsTable();
      } catch (e) { /* transient render errors must not kill the live loop */ }
    }, 1000);
  }

  getAlgorithmStatus(systemMode) {
    const simRunning = state.get("simRunning");
    if (!simRunning) return false;
    // Algorithm is running if simulation is running
    return true;
  }

  getAlgorithmList(systemMode) {
    if (systemMode === "centralized") {
      return "Global Planner, Assignment Engine, Conflict Manager";
    } else if (systemMode === "decentralized") {
      return "P2P Bidding, Velocity Obstacles, Contract-Net";
    } else {
      return "RACE Evaluator, Adaptive Envelope, Hysteresis, Space-Time Contract";
    }
  }

  getArchitectureStatus(systemMode, coordination) {
    if (systemMode === "centralized") {
      return coordination.centralServer?.status === "ONLINE" ? "Central Server: Online" : "Central Server: Offline";
    } else if (systemMode === "decentralized") {
      return coordination.peerNetwork?.status === "ONLINE" ? "P2P Mesh: Connected" : "P2P Mesh: Disconnected";
    } else {
      return coordination.ace?.status === "ONLINE" ? "ACE/RACE: Active" : "ACE/RACE: Inactive";
    }
  }
}
