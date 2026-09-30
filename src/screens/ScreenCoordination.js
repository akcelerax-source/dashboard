// ==========================================================================
// NODEX ACE - Screen 02: Explain Simulation (Analysis & Replay Intelligence)
// ==========================================================================

import { state } from "../core/state.js";
import { SCENARIOS } from "../data/scenarios.js";
import { SimulationHistoryService, LIVE_RUN_ID } from "../data/simulation-history.js";
import { ScenarioDetailsModal } from "../components/ScenarioDetailsModal.js";

const HISTORY_PAGE_SIZE = 8;

export class ScreenCoordination {
  constructor(container) {
    this.container = container;
    this.selectedRunId = LIVE_RUN_ID;
    this.selectedEventCategory = "all";
    this.eventSearchQuery = "";
    this.selectedRobotFilter = "all";
    this.historyPage = 0;
    this.activeRun = SimulationHistoryService.getRunById(this.selectedRunId);

    this.render();
    this.bindEvents();
    this.subscribeLiveUpdates();
  }

  render() {
    const run = this.activeRun;
    const runs = SimulationHistoryService.getRuns();

    this.container.innerHTML = `
      <div class="explain-screen-root">
        <!-- 3-Column Main Layout: Left History | Main Explanation | Right Analysis -->
        <div class="explain-three-col-layout">

          <!-- 1. LEFT SIDEBAR: Simulation History -->
          <aside class="explain-history-sidebar">
            <div class="history-sidebar-header">
              <div class="history-title-group">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span class="history-main-title">Simulation History</span>
              </div>
              <button class="btn-new-simulation" id="btn-new-sim" title="Launch a new simulation run">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>New Simulation</span>
              </button>
            </div>

            <!-- List of historical simulation runs -->
            <div class="history-runs-list" id="history-runs-list">
              ${this.renderHistoryItems(runs)}
            </div>
            <div class="history-pager" id="history-pager">${this.renderHistoryPager(runs)}</div>

            <!-- Bottom: Help & Guide Button -->
            <div class="history-sidebar-footer">
              <button class="btn-help-guide" id="btn-explain-help">
                <div class="help-btn-left">
                  <span class="help-question-circle">?</span>
                  <span class="help-label-text">Help & Guide</span>
                </div>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            </div>
          </aside>

          <!-- 2. MAIN CENTER COLUMN: Header, Filter Bar, Summary, Event History -->
          <main class="explain-center-col">
            <!-- Screen Header Block -->
            <div class="explain-header-block">
              <h1 class="explain-title">Explain Simulation</h1>
              <p class="explain-subtitle">
                Explore what happened during the simulation. See the sequence of actions, robot decisions, and system behaviour in real time.
              </p>
            </div>

            <!-- Filter & Context Bar -->
            <div class="explain-filter-bar">
              <div class="filter-item-chip">
                <span class="filter-label">System</span>
                <select class="filter-select" id="select-explain-system">
                  <option value="ace" ${run.systemMode === 'ace' ? 'selected' : ''}>NodeX Edge AI ACE decentralized</option>
                  <option value="decentralized" ${run.systemMode === 'decentralized' ? 'selected' : ''}>Decentralized</option>
                  <option value="centralized" ${run.systemMode === 'centralized' ? 'selected' : ''}>Centralized</option>
                </select>
              </div>

              <div class="filter-item-chip">
                <span class="filter-label">Scenario</span>
                <select class="filter-select" id="select-explain-scenario">
                  ${SCENARIOS.map(s => `
                    <option value="${s.code}" ${run.scenarioCode === s.code ? 'selected' : ''}>${s.code} - ${s.name}</option>
                  `).join("")}
                </select>
              </div>

              <div class="filter-time-badge">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                <span class="filter-time-label">Simulation Time</span>
                <span class="filter-time-val" id="explain-time-range">${run.timeRange}</span>
              </div>
            </div>

            <!-- Simulation Summary (5 KPI Cards) -->
            <section class="explain-summary-card">
              <div class="summary-card-header">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="16" y1="13" x2="8" y2="13"></line>
                  <line x1="16" y1="17" x2="8" y2="17"></line>
                  <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
                <span class="summary-card-title" id="summary-title-text">Simulation Summary · ${run.scenarioName}</span>
              </div>

              <div class="summary-kpis-grid">
                <!-- 1. Total Tasks -->
                <div class="summary-kpi-box">
                  <div class="kpi-icon-wrap icon-tasks">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                    </svg>
                  </div>
                  <div class="kpi-data-col">
                    <span class="kpi-metric-num" id="kpi-total-tasks">${run.summary.totalTasks}</span>
                    <span class="kpi-metric-label">Total Tasks</span>
                  </div>
                </div>

                <!-- 2. Completed -->
                <div class="summary-kpi-box">
                  <div class="kpi-icon-wrap icon-completed">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <div class="kpi-data-col">
                    <span class="kpi-metric-num text-success" id="kpi-completed-tasks">${run.summary.completed}</span>
                    <span class="kpi-metric-label">Completed</span>
                  </div>
                </div>

                <!-- 3. Total Time -->
                <div class="summary-kpi-box">
                  <div class="kpi-icon-wrap icon-time">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                  </div>
                  <div class="kpi-data-col">
                    <span class="kpi-metric-num" id="kpi-total-time">${run.summary.totalTime}</span>
                    <span class="kpi-metric-label">Total Time</span>
                  </div>
                </div>

                <!-- 4. Robot Failures -->
                <div class="summary-kpi-box">
                  <div class="kpi-icon-wrap icon-failures">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                      <line x1="12" y1="9" x2="12" y2="13"></line>
                      <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                  </div>
                  <div class="kpi-data-col">
                    <span class="kpi-metric-num ${run.summary.robotFailures > 0 ? 'text-danger' : ''}" id="kpi-robot-failures">${run.summary.robotFailures}</span>
                    <span class="kpi-metric-label">Robot Failure</span>
                  </div>
                </div>

                <!-- 5. Collisions -->
                <div class="summary-kpi-box">
                  <div class="kpi-icon-wrap icon-collisions">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="20" x2="18" y2="10"></line>
                      <line x1="12" y1="20" x2="12" y2="4"></line>
                      <line x1="6" y1="20" x2="6" y2="14"></line>
                    </svg>
                  </div>
                  <div class="kpi-data-col">
                    <span class="kpi-metric-num" id="kpi-collisions">${run.summary.collisions}</span>
                    <span class="kpi-metric-label">Collisions</span>
                  </div>
                </div>
              </div>
            </section>

            <!-- Event History Table Card -->
            <section class="explain-events-card">
              <div class="events-card-header">
                <div class="events-title-wrap">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                  </svg>
                  <span class="events-main-title">Event History</span>
                </div>

                <div class="events-controls-row">
                  <!-- Category Dropdown -->
                  <div class="events-filter-dropdown-wrap">
                    <select class="events-filter-select" id="select-event-category">
                      <option value="all">All Events</option>
                      <option value="robot">Robot Events</option>
                      <option value="task">Task Events</option>
                      <option value="coordination">Coordination Events</option>
                      <option value="conflict">Conflict Events</option>
                      <option value="recovery">Recovery Events</option>
                      <option value="system">System Events</option>
                    </select>
                  </div>

                  <!-- Real-time Search Input -->
                  <div class="events-search-wrap">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="11" cy="11" r="8"></circle>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <input type="text" id="input-search-events" placeholder="Search events..." value="${this.eventSearchQuery}">
                  </div>
                </div>
              </div>

              <!-- Events Table -->
              <div class="events-table-wrapper" id="events-table-wrapper">
                <table class="explain-events-table">
                  <thead>
                    <tr>
                      <th style="width: 85px;">Time</th>
                      <th style="width: 80px;">Robot</th>
                      <th style="width: 170px;">Event</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody id="explain-events-tbody">
                    ${this.renderEventRows(run.events)}
                  </tbody>
                </table>
              </div>
            </section>
          </main>

          <!-- 3. RIGHT ANALYSIS COLUMN: Task Flow, Robot Timeline, Key Insights -->
          <aside class="explain-right-col">
            <!-- Card 1: Task Flow (Completed Tasks) -->
            <section class="explain-analysis-card task-flow-card">
              <div class="analysis-card-header">
                <div class="analysis-title-wrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                  <span class="analysis-card-title">Task Flow (Completed Tasks)</span>
                </div>
                <button class="btn-link-action" id="btn-view-all-tasks">View All Tasks &rarr;</button>
              </div>

              <div class="task-flow-table-wrap">
                <table class="explain-tasks-table">
                  <thead>
                    <tr>
                      <th>Task ID</th>
                      <th>Pick Location</th>
                      <th>Drop Location</th>
                      <th>Assigned To</th>
                      <th>Start Time</th>
                      <th>End Time</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody id="task-flow-tbody">
                    ${this.renderTaskRows(run.tasks)}
                  </tbody>
                </table>
              </div>
            </section>

            <!-- Card 2: Robot Activity Timeline -->
            <section class="explain-analysis-card timeline-card">
              <div class="analysis-card-header">
                <div class="analysis-title-wrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                    <line x1="8" y1="21" x2="16" y2="21"></line>
                    <line x1="12" y1="17" x2="12" y2="21"></line>
                  </svg>
                  <span class="analysis-card-title">Robot Activity Timeline</span>
                </div>

                <div class="timeline-filter-dropdown-wrap">
                  <select class="timeline-robot-select" id="select-timeline-robot">
                    <option value="all">All Robots</option>
                    ${(run.timeline || []).map(r => `
                      <option value="${r.robot}" ${this.selectedRobotFilter === r.robot ? 'selected' : ''}>${r.robot}</option>
                    `).join("")}
                  </select>
                </div>
              </div>

              <!-- Gantt / Timeline visualization -->
              <div class="gantt-chart-container">
                <!-- Timeline Time Scale Header -->
                <div class="gantt-time-scale">
                  <div class="scale-spacer"></div>
                  <div class="scale-ticks-row" id="gantt-scale-ticks">${this.renderTimeTicks(run)}</div>
                </div>

                <!-- Robot Timeline Rows -->
                <div class="gantt-rows-container" id="gantt-rows-container">
                  ${this.renderTimelineRows(run.timeline)}
                </div>

                <!-- Timeline State Legend -->
                <div class="timeline-legend-row">
                  <div class="legend-chip"><span class="legend-color-dot" style="background:#0077FF;"></span>Moving</div>
                  <div class="legend-chip"><span class="legend-color-dot" style="background:#10B981;"></span>Picking</div>
                  <div class="legend-chip"><span class="legend-color-dot" style="background:#F59E0B;"></span>Placing</div>
                  <div class="legend-chip"><span class="legend-color-dot" style="background:#8B5CF6;"></span>Charging</div>
                  <div class="legend-chip"><span class="legend-color-dot" style="background:#64748B;"></span>Idle</div>
                  <div class="legend-chip"><span class="legend-color-dot" style="background:#FB923C;"></span>Blocked</div>
                  <div class="legend-chip"><span class="legend-color-cross">&times;</span>Failed</div>
                </div>
              </div>
            </section>

            <!-- Card 3: Key Insights from This Simulation -->
            <section class="explain-analysis-card insights-card">
              <div class="analysis-card-header">
                <div class="analysis-title-wrap">
                  <span style="font-size: 14px;">💡</span>
                  <span class="analysis-card-title">Key Insights from This Simulation</span>
                </div>
                <div class="insights-badges-row">
                  <span class="insight-meta-badge badge-scenario">${run.scenarioCode} - ${run.scenarioName.split(" - ")[1] || "Run"}</span>
                  <span class="insight-meta-badge badge-arch">${run.systemModeLabel}</span>
                </div>
              </div>

              <div class="insights-list-container" id="insights-list-container">
                ${this.renderInsightCards(run.insights)}
              </div>
            </section>
          </aside>

        </div>
      </div>
    `;
  }

  renderEventRows(events) {
    if (!events || events.length === 0) {
      return `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 14px;">No events recorded.</td></tr>`;
    }

    const filtered = events.filter(e => {
      // Category filter
      if (this.selectedEventCategory !== "all" && e.category !== this.selectedEventCategory) {
        return false;
      }
      // Robot filter
      if (this.selectedRobotFilter !== "all" && e.robot !== this.selectedRobotFilter) {
        return false;
      }
      // Text search
      if (this.eventSearchQuery) {
        const q = this.eventSearchQuery.toLowerCase();
        const str = `${e.time} ${e.robot} ${e.event} ${e.details}`.toLowerCase();
        if (!str.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      return `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 14px;">No events match current filter.</td></tr>`;
    }

    return filtered.map(e => {
      const isCritical = e.severity === "critical";
      const isWarning = e.severity === "warning";
      const isSuccess = e.severity === "success";
      const dotColor = isCritical ? "#EF4444" : isWarning ? "#F59E0B" : isSuccess ? "#10B981" : "#00C8FF";

      return `
        <tr class="event-table-row ${isCritical ? 'event-critical' : ''}" data-event-robot="${e.robot}">
          <td class="event-time-cell">
            <span class="event-severity-dot" style="background-color: ${dotColor}; box-shadow: 0 0 6px ${dotColor}88;"></span>
            <span class="event-time-text">${e.time}</span>
          </td>
          <td class="event-robot-cell font-mono">
            <span class="robot-id-tag ${e.robot === 'SYSTEM' ? 'tag-system' : 'tag-amr'}">${e.robot}</span>
          </td>
          <td class="event-name-cell">
            <span class="event-name-text">${e.event}</span>
          </td>
          <td class="event-details-cell">
            <span class="event-details-text">${e.details}</span>
          </td>
        </tr>
      `;
    }).join("");
  }

  renderTaskRows(tasks) {
    if (!tasks || tasks.length === 0) {
      return `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 12px;">No task flow records available.</td></tr>`;
    }

    return tasks.map(t => `
      <tr class="task-flow-row" data-task-id="${t.id}">
        <td class="task-id-cell font-mono">${t.id}</td>
        <td class="task-bay-cell font-mono">${t.pick}</td>
        <td class="task-bay-cell font-mono">${t.drop}</td>
        <td class="task-robot-cell font-mono">${t.robot}</td>
        <td class="task-time-cell font-mono">${t.startTime}</td>
        <td class="task-time-cell font-mono">${t.endTime}</td>
        <td class="task-status-cell">
          <span class="task-status-tag ${t.status.toLowerCase()}">
            ${t.status === 'Completed' ? '&#10004;' : ''} ${t.status}
          </span>
        </td>
      </tr>
    `).join("");
  }

  renderTimelineRows(timeline) {
    if (!timeline || timeline.length === 0) {
      return `<div style="text-align: center; color: var(--text-muted); padding: 12px;">No robot timeline data.</div>`;
    }

    const filtered = this.selectedRobotFilter === "all"
      ? timeline
      : timeline.filter(r => r.robot === this.selectedRobotFilter);

    return filtered.map(row => `
      <div class="gantt-robot-row" data-timeline-robot="${row.robot}">
        <div class="gantt-robot-label font-mono">${row.robot}</div>
        <div class="gantt-bar-track">
          ${row.segments.map(seg => {
            const width = seg.end - seg.start;
            const left = seg.start;
            const isFailed = seg.state === "failed";

            return `
              <div class="gantt-state-segment state-${seg.state} ${isFailed ? 'failed-marker' : ''}"
                   style="left: ${left}%; width: ${width}%;"
                   title="${row.robot}: ${seg.state} (${seg.label || ''})">
                ${isFailed ? `<span class="failed-badge-pill">&times; ${seg.label || 'Failed'}</span>` : ''}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `).join("");
  }

  renderInsightCards(insights) {
    if (!insights || insights.length === 0) {
      return `<div style="text-align: center; color: var(--text-muted); padding: 12px;">No insights generated.</div>`;
    }

    return insights.map(item => {
      let iconSvg = "";
      if (item.type === "alert") {
        iconSvg = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        `;
      } else if (item.type === "metric") {
        iconSvg = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
            <polyline points="17 6 23 6 23 12"></polyline>
          </svg>
        `;
      } else if (item.type === "network") {
        iconSvg = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
            <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
            <line x1="12" y1="20" x2="12.01" y2="20"></line>
          </svg>
        `;
      } else if (item.type === "traffic") {
        iconSvg = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <line x1="18" y1="20" x2="18" y2="10"></line>
            <line x1="12" y1="20" x2="12" y2="4"></line>
            <line x1="6" y1="20" x2="6" y2="14"></line>
          </svg>
        `;
      } else {
        iconSvg = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        `;
      }

      return `
        <div class="insight-item-box type-${item.type}">
          <div class="insight-icon-col" style="background: ${item.color}22; color: ${item.color};">
            ${iconSvg}
          </div>
          <div class="insight-text-col">
            <h5 class="insight-headline">${item.title}</h5>
            <p class="insight-description">${item.desc}</p>
          </div>
        </div>
      `;
    }).join("");
  }

  bindEvents() {
    // 1. History Run Item click
    this.container.addEventListener("click", (e) => {
      const runItem = e.target.closest(".history-run-item");
      if (runItem && !e.target.closest(".run-menu-btn")) {
        const runId = runItem.getAttribute("data-run-id");
        this.selectRun(runId);
      }
    });

    // 1b. History pager
    this.container.addEventListener("click", (e) => {
      const btn = e.target.closest(".history-page-btn");
      if (!btn || btn.disabled) return;
      this.historyPage += Number(btn.getAttribute("data-page-step")) || 0;
      this.refreshHistoryList();
    });

    // 2. New Simulation Button
    const btnNewSim = this.container.querySelector("#btn-new-sim");
    btnNewSim?.addEventListener("click", () => {
      // Trigger Live Run selection
      this.selectedRunId = LIVE_RUN_ID;
      this.activeRun = SimulationHistoryService.getLiveRunData();
      state.set("activeTab", "operations");
    });

    // 3. System Selector
    const selectSystem = this.container.querySelector("#select-explain-system");
    selectSystem?.addEventListener("change", (e) => {
      // History filter only: shows the most recent recorded run of that
      // architecture. It never changes the live system nor relabels a run.
      const mode = e.target.value;
      const scenario = this.activeRun?.scenarioCode;
      const runs = SimulationHistoryService.getRuns().filter(r => !r.isLive && r.systemMode === mode);
      const match = runs.find(r => r.scenarioCode === scenario) || runs[0];
      if (match) {
        this.selectRun(match.id);
      } else {
        e.target.value = this.activeRun?.systemMode || "ace";
        e.target.title = `No recorded run for ${mode} yet`;
      }
    });

    // 4. Scenario Selector
    const selectScenario = this.container.querySelector("#select-explain-scenario");
    selectScenario?.addEventListener("change", (e) => {
      const scenarioCode = e.target.value;
      const matchedRun = SimulationHistoryService.getRunByScenario(scenarioCode);
      if (matchedRun) {
        this.selectRun(matchedRun.id);
      }
    });

    // 5. Event Category Filter
    const selectCategory = this.container.querySelector("#select-event-category");
    selectCategory?.addEventListener("change", (e) => {
      this.selectedEventCategory = e.target.value;
      this.updateEventsTable();
    });

    // 6. Event Search Input
    const inputSearch = this.container.querySelector("#input-search-events");
    inputSearch?.addEventListener("input", (e) => {
      this.eventSearchQuery = e.target.value.trim();
      this.updateEventsTable();
    });

    // 7. Timeline Robot Filter
    const selectRobot = this.container.querySelector("#select-timeline-robot");
    selectRobot?.addEventListener("change", (e) => {
      this.selectedRobotFilter = e.target.value;
      this.updateTimelineView();
      this.updateEventsTable();
    });

    // 8. View All Tasks Button
    const btnAllTasks = this.container.querySelector("#btn-view-all-tasks");
    btnAllTasks?.addEventListener("click", () => {
      this.openAllTasksModal();
    });

    // 9. Help & Guide Button
    const btnHelp = this.container.querySelector("#btn-explain-help");
    btnHelp?.addEventListener("click", () => {
      this.openHelpModal();
    });

    // 10. Click on Event row to highlight robot
    this.container.addEventListener("click", (e) => {
      const row = e.target.closest(".event-table-row");
      if (row) {
        const robot = row.getAttribute("data-event-robot");
        if (robot && robot !== "SYSTEM") {
          this.selectedRobotFilter = robot;
          const selectRobot = this.container.querySelector("#select-timeline-robot");
          if (selectRobot) selectRobot.value = robot;
          this.updateTimelineView();
          this.updateEventsTable();
        }
      }
    });

    // 11. Run 3-dot menu actions
    this.container.addEventListener("click", (e) => {
      const menuBtn = e.target.closest(".run-menu-btn");
      if (menuBtn) {
        e.stopPropagation();
        const runId = menuBtn.getAttribute("data-run-menu");
        this.openRunActionsMenu(menuBtn, runId);
      }
    });
  }

  /** One page of the run history (the list is paged, not shown all at once). */
  pageOf(runs) {
    const pages = Math.max(1, Math.ceil(runs.length / HISTORY_PAGE_SIZE));
    this.historyPage = Math.min(Math.max(0, this.historyPage), pages - 1);
    return { pages, items: runs.slice(this.historyPage * HISTORY_PAGE_SIZE, (this.historyPage + 1) * HISTORY_PAGE_SIZE) };
  }

  renderHistoryPager(runs) {
    const { pages } = this.pageOf(runs);
    return `
      <button class="history-page-btn" data-page-step="-1" ${this.historyPage === 0 ? "disabled" : ""} title="Newer runs">&lsaquo; Prev</button>
      <span class="history-page-label">Page ${this.historyPage + 1} / ${pages} &bull; ${runs.length} runs</span>
      <button class="history-page-btn" data-page-step="1" ${this.historyPage >= pages - 1 ? "disabled" : ""} title="Older runs">Next &rsaquo;</button>`;
  }

  renderHistoryItems(runs) {
    return this.pageOf(runs).items.map(r => `
                <div class="history-run-item ${r.id === this.selectedRunId ? 'active' : ''}" data-run-id="${r.id}">
                  <div class="run-dot-status" style="background-color: ${r.indicatorColor}; box-shadow: 0 0 8px ${r.indicatorColor}88;"></div>
                  <div class="run-info-col">
                    <div class="run-scenario-name">${r.scenarioName}</div>
                    <div class="run-meta-line">
                      <span class="run-arch-tag">${r.systemModeLabel}</span>
                    </div>
                    <div class="run-date-line">${r.dateTimeFormatted}</div>
                  </div>
                  <button class="run-menu-btn" data-run-menu="${r.id}" title="Run actions">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="1"></circle>
                      <circle cx="12" cy="5" r="1"></circle>
                      <circle cx="12" cy="19" r="1"></circle>
                    </svg>
                  </button>
                </div>
    `).join("");
  }

  refreshHistoryList() {
    const runs = SimulationHistoryService.getRuns();
    const list = this.container.querySelector("#history-runs-list");
    if (list) list.innerHTML = this.renderHistoryItems(runs);
    const pager = this.container.querySelector("#history-pager");
    if (pager) pager.innerHTML = this.renderHistoryPager(runs);
  }

  selectRun(runId) {
    this.selectedRunId = runId;
    this.activeRun = SimulationHistoryService.getRunById(runId);

    // Update active highlight in left list
    const items = this.container.querySelectorAll(".history-run-item");
    items.forEach(it => {
      if (it.getAttribute("data-run-id") === runId) {
        it.classList.add("active");
      } else {
        it.classList.remove("active");
      }
    });

    // Update main panel contents
    this.refreshMainPanels();
  }

  updateRunSystemMode(mode) {
    if (this.activeRun) {
      this.activeRun.systemMode = mode;
      this.activeRun.systemModeLabel = mode === "ace" ? "NodeX Edge AI ACE decentralized" : mode === "decentralized" ? "Decentralized" : "Centralized";
      const archBadge = this.container.querySelector(".badge-arch");
      if (archBadge) archBadge.textContent = this.activeRun.systemModeLabel;
    }
  }

  refreshMainPanels() {
    const run = this.activeRun;

    // 1. Context bar
    const selectScenario = this.container.querySelector("#select-explain-scenario");
    const selectSystem = this.container.querySelector("#select-explain-system");
    const timeRange = this.container.querySelector("#explain-time-range");
    if (selectScenario) selectScenario.value = run.scenarioCode;
    if (selectSystem) selectSystem.value = run.systemMode;
    if (timeRange) timeRange.textContent = run.timeRange;

    // 2. Summary Title & KPIs
    const titleText = this.container.querySelector("#summary-title-text");
    const totalTasks = this.container.querySelector("#kpi-total-tasks");
    const completedTasks = this.container.querySelector("#kpi-completed-tasks");
    const totalTime = this.container.querySelector("#kpi-total-time");
    const robotFailures = this.container.querySelector("#kpi-robot-failures");
    const collisions = this.container.querySelector("#kpi-collisions");

    if (titleText) titleText.textContent = `Simulation Summary · ${run.scenarioName}`;
    if (totalTasks) totalTasks.textContent = run.summary.totalTasks;
    if (completedTasks) completedTasks.textContent = run.summary.completed;
    if (totalTime) totalTime.textContent = run.summary.totalTime;
    if (robotFailures) {
      robotFailures.textContent = run.summary.robotFailures;
      robotFailures.className = `kpi-metric-num ${run.summary.robotFailures > 0 ? 'text-danger' : ''}`;
    }
    if (collisions) collisions.textContent = run.summary.collisions;

    // 3. Events Table
    this.updateEventsTable();

    // 4. Task Flow
    const taskTbody = this.container.querySelector("#task-flow-tbody");
    if (taskTbody) taskTbody.innerHTML = this.renderTaskRows(run.tasks);

    // 5. Timeline
    const robotSelect = this.container.querySelector("#select-timeline-robot");
    if (robotSelect) {
      robotSelect.innerHTML = `
        <option value="all">All Robots</option>
        ${(run.timeline || []).map(r => `
          <option value="${r.robot}" ${this.selectedRobotFilter === r.robot ? 'selected' : ''}>${r.robot}</option>
        `).join("")}
      `;
    }
    this.updateTimelineView();

    // 6. Insights
    const insightsContainer = this.container.querySelector("#insights-list-container");
    if (insightsContainer) insightsContainer.innerHTML = this.renderInsightCards(run.insights);

    const scenarioBadge = this.container.querySelector(".badge-scenario");
    const archBadge = this.container.querySelector(".badge-arch");
    if (scenarioBadge) scenarioBadge.textContent = `${run.scenarioCode} - ${run.scenarioName.split(" - ")[1] || "Run"}`;
    if (archBadge) archBadge.textContent = run.systemModeLabel;
  }

  updateEventsTable() {
    const tbody = this.container.querySelector("#explain-events-tbody");
    if (tbody) {
      tbody.innerHTML = this.renderEventRows(this.activeRun.events);
    }
  }

  updateTimelineView() {
    const container = this.container.querySelector("#gantt-rows-container");
    if (container) {
      container.innerHTML = this.renderTimelineRows(this.activeRun.timeline);
    }
    const ticks = this.container.querySelector("#gantt-scale-ticks");
    if (ticks) ticks.innerHTML = this.renderTimeTicks(this.activeRun);
  }

  /** Five evenly spaced sim-time labels across the recorded run span. */
  renderTimeTicks(run) {
    const span = run?.timelineSpanSeconds || 0;
    const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    return [0, 0.25, 0.5, 0.75, 1].map(f => `<span>${fmt(span * f)}</span>`).join("");
  }

  openAllTasksModal() {
    const modalContainer = document.getElementById("modal-container");
    if (!modalContainer) return;

    const run = this.activeRun;
    modalContainer.innerHTML = `
      <div class="modal-backdrop" id="tasks-modal-backdrop">
        <div class="modal-dialog explain-modal-dialog" role="dialog" aria-modal="true" style="max-width: 780px;">
          <div class="modal-header">
            <div class="modal-title-wrap">
              <span class="scenario-code-badge">${run.scenarioCode}</span>
              <h2 class="modal-title">All Completed & Pending Tasks (${run.summary.totalTasks} Tasks)</h2>
            </div>
            <button class="modal-close-btn" id="btn-close-tasks-modal">&times;</button>
          </div>
          <div class="modal-body" style="max-height: 480px; overflow-y: auto;">
            <table class="explain-tasks-table" style="width: 100%;">
              <thead>
                <tr>
                  <th>Task ID</th>
                  <th>Pick</th>
                  <th>Drop</th>
                  <th>Assigned</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${this.renderTaskRows(run.tasks)}
              </tbody>
            </table>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: flex-end; padding: 10px 16px;">
            <button class="btn-primary" id="btn-done-tasks-modal" style="padding: 6px 14px; background: #0077FF; color: white; border-radius: 6px; border: none; cursor: pointer;">Done</button>
          </div>
        </div>
      </div>
    `;

    const close = () => { modalContainer.innerHTML = ""; };
    modalContainer.querySelector("#btn-close-tasks-modal")?.addEventListener("click", close);
    modalContainer.querySelector("#btn-done-tasks-modal")?.addEventListener("click", close);
    modalContainer.querySelector("#tasks-modal-backdrop")?.addEventListener("click", (e) => {
      if (e.target.id === "tasks-modal-backdrop") close();
    });
  }

  openHelpModal() {
    const modalContainer = document.getElementById("modal-container");
    if (!modalContainer) return;

    modalContainer.innerHTML = `
      <div class="modal-backdrop" id="help-modal-backdrop">
        <div class="modal-dialog explain-modal-dialog" role="dialog" aria-modal="true" style="max-width: 620px;">
          <div class="modal-header">
            <div class="modal-title-wrap">
              <span style="font-size: 16px; margin-right: 6px;">💡</span>
              <h2 class="modal-title">Explain Simulation - Guide & Workflow</h2>
            </div>
            <button class="modal-close-btn" id="btn-close-help-modal">&times;</button>
          </div>
          <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px; font-size: 12px; line-height: 1.5;">
            <div>
              <strong class="help-item-title">1. Simulation History:</strong>
              <p class="help-item-desc" style="margin-top: 3px;">Review past experimental benchmark runs across S01 through S14. Select any run to replay and inspect its exact event logs and coordination states.</p>
            </div>
            <div>
              <strong class="help-item-title">2. Simulation Summary:</strong>
              <p class="help-item-desc" style="margin-top: 3px;">High-level overview of task throughput, completion percentage, total elapsed simulation time, robot hardware faults, and recorded collisions.</p>
            </div>
            <div>
              <strong class="help-item-title">3. Event History:</strong>
              <p class="help-item-desc" style="margin-top: 3px;">Chronological breakdown of robot interactions, dynamic replanning triggers, contract awards, and fault injections with instant search.</p>
            </div>
            <div>
              <strong class="help-item-title">4. Task Flow & Robot Timeline:</strong>
              <p class="help-item-desc" style="margin-top: 3px;">Gantt chart mapping robot state transitions (Moving, Picking, Placing, Charging, Idle, Blocked, Failed) over the 20-minute operational window.</p>
            </div>
            <div>
              <strong class="help-item-title">5. Key Insights:</strong>
              <p class="help-item-desc" style="margin-top: 3px;">Evidence-based comparative analytics contrasting ACE Adaptive Coordination against Decentralized and Centralized architectures.</p>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: flex-end; padding: 10px 16px;">
            <button class="btn-primary" id="btn-dismiss-help-modal" style="padding: 6px 14px; background: #0077FF; color: white; border-radius: 6px; border: none; cursor: pointer;">Got it</button>
          </div>
        </div>
      </div>
    `;

    const close = () => { modalContainer.innerHTML = ""; };
    modalContainer.querySelector("#btn-close-help-modal")?.addEventListener("click", close);
    modalContainer.querySelector("#btn-dismiss-help-modal")?.addEventListener("click", close);
    modalContainer.querySelector("#help-modal-backdrop")?.addEventListener("click", (e) => {
      if (e.target.id === "help-modal-backdrop") close();
    });
  }

  openRunActionsMenu(buttonEl, runId) {
    const existing = document.getElementById("floating-run-menu");
    if (existing) existing.remove();

    const rect = buttonEl.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.id = "floating-run-menu";
    menu.className = "floating-context-menu";
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.min(window.innerWidth - 180, rect.left)}px`;

    menu.innerHTML = `
      <div class="context-menu-item" data-action="details">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
        <span>Scenario Details</span>
      </div>
      <div class="context-menu-item" data-action="recovery">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"></path></svg>
        <span>Recovery Impact</span>
      </div>
      <div class="context-menu-item" data-action="export">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        <span>Export Log JSON</span>
      </div>
    `;

    document.body.appendChild(menu);

    const onDocClick = (e) => {
      if (!menu.contains(e.target) && e.target !== buttonEl) {
        menu.remove();
        document.removeEventListener("click", onDocClick);
      }
    };
    setTimeout(() => document.addEventListener("click", onDocClick), 10);

    menu.addEventListener("click", (e) => {
      const item = e.target.closest(".context-menu-item");
      if (!item) return;
      const action = item.getAttribute("data-action");
      menu.remove();
      document.removeEventListener("click", onDocClick);

      if (action === "details" || action === "recovery") {
        ScenarioDetailsModal.open(this.activeRun.scenarioCode);
      } else if (action === "export") {
        const jsonStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.activeRun, null, 2));
        const dlAnchor = document.createElement("a");
        dlAnchor.setAttribute("href", jsonStr);
        dlAnchor.setAttribute("download", `NODEX_${this.activeRun.id}_${this.activeRun.scenarioCode}.json`);
        dlAnchor.click();
      }
    });
  }

  subscribeLiveUpdates() {
    // Robots publish every tick: rebuild the live view at most twice a second.
    let lastLive = 0;
    const refreshLive = () => {
      const nowMs = Date.now();
      if (nowMs - lastLive < 500) return;
      if (this.selectedRunId === LIVE_RUN_ID && state.get("activeTab") === "coordination") {
        lastLive = nowMs;
        const live = SimulationHistoryService.getLiveRunData();
        this.activeRun = live;
        this.refreshMainPanels();
      }
    };

    state.subscribe("events", refreshLive);
    // A run that stops/finishes is archived by the lifecycle; show it in history.
    state.subscribe("simLifecycleState", () => this.refreshHistoryList());
    state.subscribe("robots", refreshLive);
    state.subscribe("kpis", refreshLive);
    state.subscribe("simTimeSeconds", (sec) => {
      if (this.selectedRunId === LIVE_RUN_ID && state.get("activeTab") === "coordination") {
        const timeEl = this.container.querySelector("#kpi-total-time");
        if (timeEl && sec !== undefined) {
          timeEl.textContent = `${(sec / 60).toFixed(1)} min`;
        }
      }
    });
  }
}
