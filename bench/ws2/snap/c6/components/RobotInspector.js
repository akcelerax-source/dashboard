// ==========================================================================
// NODEX ACE - Selected Robot (from fleet) Inspector Card
// Supports Real-Time Telemetry & ACE/RACE Adaptive State Display
// Phase 7: Full robot telemetry per requirements
// ==========================================================================

import { state } from "../core/state.js";

export class RobotInspector {
  constructor(container) {
    this.container = container;
    this.render();
    this.bindEvents();
  }

  render() {
    const robots = state.get("robots") || [];
    const selectedId = state.get("selectedRobotId") || "R01";
    const systemMode = state.get("systemMode") || "ace";
    const robotIndex = robots.findIndex(r => r.id === selectedId);
    const robot = (robotIndex >= 0 ? robots[robotIndex] : null) || robots[0] || null;
    const coordination = state.get("coordination") || {};

    // No fleet yet: say so instead of showing a fabricated robot
    // (getDefaultRobot() used to supply battery 74 %, 1.24 m/s, task T-204).
    if (!robot) {
      this.container.innerHTML = `<div class="inspector-empty" style="padding: 16px; color: var(--text-muted); font-size: 11px;">No robot telemetry: fleet not initialized.</div>`;
      return;
    }

    const isError = robot.status === "error" || robot.status === "ERROR";
    const isCharging = robot.status === "charging" || robot.status === "CHARGING";
    const isIdle = robot.status === "idle" || robot.status === "IDLE";
    const isYielding = robot.isYielding === true;
    const statusLabel = isError ? "Error" : isCharging ? "Charging" : isIdle ? "Idle" : isYielding ? "Yielding" : "Moving";
    const statusClass = isError ? "status-error" : isCharging ? "status-charging" : isIdle ? "status-idle" : isYielding ? "status-yielding" : "status-active";

    const isAce = systemMode === "ace";
    const raceState = robot.raceState || "LOCAL";
    // RACE exists only in ACE; Systems 1/2 carry riskScore = null.
    const riskScore = typeof robot.riskScore === "number" ? robot.riskScore : 0;
    const racePillClass = raceState === "CONTAINMENT" ? "status-error" : raceState === "SAFE-DEGRADED" ? "status-charging" : raceState === "NEIGHBORHOOD" ? "status-active" : "status-idle";

    // Task state indicator
    const taskState = robot.currentTaskState || (robot.currentTaskId ? "IN_PROGRESS" : "UNASSIGNED");
    const taskStateClass = taskState === "COMPLETED" ? "status-active" : taskState === "IN_PROGRESS" ? "status-yielding" : taskState === "FAILED" ? "status-error" : "status-idle";

    // Sensor status
    const sensorStatus = robot.sensorStatus || ((robot.poseUncertainty || 0) > 0 ? "DEGRADED" : "NOMINAL");
    const sensorClass = sensorStatus === "NOMINAL" ? "status-active" : sensorStatus === "DEGRADED" ? "status-yielding" : "status-error";

    // Communication status
    // From runtime state: ACE/P2P blackout flag or a lost / offline server link.
    const commStatus = robot.commStatus || (robot.isCriticalDegraded || robot.centralHold ? "DEGRADED" : "CONNECTED");
    const commClass = commStatus === "CONNECTED" ? "status-active" : commStatus === "DEGRADED" ? "status-yielding" : "status-error";

    // Coordination status
    const coordStatus = robot.coordinationStatus || (isAce ? raceState : systemMode === "decentralized"
      ? (robot.pairSession?.inSession ? `PAIR ${robot.pairSession.partner}` : "PAIR SCOPE") : "CENTRALIZED");
    const coordClass = coordStatus === "LOCAL" ? "status-active" : coordStatus === "NEIGHBORHOOD" ? "status-yielding" : coordStatus === "CONTAINMENT" ? "status-error" : coordStatus === "SAFE-DEGRADED" ? "status-charging" : "status-active";

    // Architecture-specific connection
    let archConnection = "";
    if (systemMode === "centralized") {
      archConnection = `Central Server ${coordination.centralServer?.status === "ONLINE" ? "✓" : "✗"}`;
    } else if (systemMode === "decentralized") {
      archConnection = `P2P Mesh ${coordination.peerNetwork?.status === "ONLINE" ? "✓" : "✗"} (fixed 2-robot scope)`;
    } else {
      archConnection = `ACE/RACE ${coordination.ace?.status === "ONLINE" ? "Active" : "Inactive"} (Envelope: ${robot.envelopeRadius || 0}m)`;
    }

    // Latest event
    const latestEvent = robot.latestEvent || "—";

    this.container.innerHTML = `
      <div class="selected-robot-card" id="selected-robot-card">
        <!-- Header -->
        <div class="card-top-header">
          <div class="header-title-group">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
              <rect x="3" y="11" width="18" height="10" rx="2"></rect>
              <circle cx="12" cy="5" r="2"></circle>
              <path d="M12 7v4"></path>
            </svg>
            <span class="card-main-title">Selected Robot <span class="muted-note">(from fleet)</span></span>
          </div>

          <div class="header-nav-actions">
            <button class="nav-arrow-btn" id="btn-prev-robot" title="Previous Robot">&lsaquo;</button>
            <button class="nav-arrow-btn" id="btn-next-robot" title="Next Robot">&rsaquo;</button>
            <button class="card-close-btn" id="btn-close-inspector" title="Deselect Robot">&times;</button>
          </div>
        </div>

        <!-- Body -->
        <div class="robot-details-row">
          <!-- 3D AMR Cube Preview -->
          <div class="robot-cube-preview">
            <svg width="68" height="68" viewBox="0 0 100 100" fill="none">
              <polygon points="50,15 88,36 50,57 12,36" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1.5"/>
              <polygon points="12,36 50,57 50,92 12,71" fill="#0B1322" stroke="#1E293B" stroke-width="1.5"/>
              <polygon points="50,57 88,36 88,71 50,92" fill="#152238" stroke="#1E293B" stroke-width="1.5"/>
              <ellipse cx="50" cy="36" rx="14" ry="7" fill="#060A13" stroke="#00C8FF" stroke-width="1.5"/>
              <circle cx="50" cy="36" r="3.5" fill="#00C8FF"/>
              <ellipse cx="31" cy="65" rx="8" ry="4" fill="${isError ? '#EF4444' : '#00C8FF'}" opacity="0.85"/>
              <path d="M24 74h14" stroke="#64748B" stroke-width="3" stroke-linecap="round"/>
              <path d="M62 74h14" stroke="#64748B" stroke-width="3" stroke-linecap="round"/>
            </svg>
          </div>

          <!-- Robot Identity & Status -->
          <div class="robot-identity-col">
            <div class="id-badge-row">
              <span class="robot-code-id" id="insp-robot-id">${robot.id}</span>
              <span class="robot-status-pill ${statusClass}" id="insp-status-pill">${statusLabel}</span>
              ${isAce ? `<span class="robot-status-pill ${racePillClass}" id="insp-race-pill" style="margin-left: 4px;">${raceState}</span>` : ''}
            </div>
            <div class="robot-model-line" id="insp-robot-model">${robot.model || "AMR-200"}</div>

            <!-- Battery Row -->
            <div class="metric-meter-row">
              <div class="metric-meter-label">
                <span>Battery</span>
                <span class="meter-num" id="insp-battery-num">${robot.battery}%</span>
              </div>
              <div class="meter-track">
                <div class="meter-fill battery-fill" id="insp-battery-fill" style="width: ${robot.battery}%; background: ${robot.battery < 30 ? '#EF4444' : '#10B981'};"></div>
              </div>
            </div>

            <!-- Health Row -->
            <div class="metric-meter-row">
              <div class="metric-meter-label">
                <span>Health</span>
                <span class="meter-num" id="insp-health-num">${robot.health}%</span>
              </div>
              <div class="meter-track">
                <div class="meter-fill health-fill" id="insp-health-fill" style="width: ${robot.health}%;"></div>
              </div>
            </div>

            ${isAce ? `
              <!-- ACE Risk Row -->
              <div class="metric-meter-row" style="margin-top: 4px;">
                <div class="metric-meter-label">
                  <span>RACE Risk</span>
                  <span class="meter-num font-mono" id="insp-risk-num">${riskScore.toFixed(2)}</span>
                </div>
                <div class="meter-track">
                  <div class="meter-fill" id="insp-risk-fill" style="width: ${Math.round(riskScore * 100)}%; background: ${riskScore > 0.65 ? '#EF4444' : riskScore > 0.45 ? '#F59E0B' : '#00C8FF'};"></div>
                </div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Telemetry Key-Value Grid -->
        <div class="telemetry-compact-grid">
          <div class="tel-item">
            <span class="tel-label">Speed</span>
            <span class="tel-val" id="insp-speed-val">${(robot.velocity || 0).toFixed(2)} m/s</span>
          </div>

          <div class="tel-item">
            <span class="tel-label">Current Task</span>
            <span class="tel-val highlight" id="insp-task-val">${robot.currentTask || "—"}</span>
          </div>

          <div class="tel-item">
            <span class="tel-label">Task State</span>
            <span class="tel-val highlight"><span class="robot-status-pill ${taskStateClass}" style="font-size: 10px; padding: 1px 6px;">${taskState}</span></span>
          </div>

          <div class="tel-item full-width">
            <span class="tel-label">Location</span>
            <span class="tel-val" id="insp-loc-val">${robot.location || `${robot.x?.toFixed(0) || 0}, ${robot.y?.toFixed(0) || 0}`}</span>
          </div>

          <div class="tel-item">
            <span class="tel-label">Sensor Status</span>
            <span class="tel-val"><span class="robot-status-pill ${sensorClass}" style="font-size: 10px; padding: 1px 6px;">${sensorStatus}</span></span>
          </div>

          <div class="tel-item">
            <span class="tel-label">Comm Status</span>
            <span class="tel-val"><span class="robot-status-pill ${commClass}" style="font-size: 10px; padding: 1px 6px;">${commStatus}</span></span>
          </div>

          <div class="tel-item full-width">
            <span class="tel-label">Coordination</span>
            <span class="tel-val"><span class="robot-status-pill ${coordClass}" style="font-size: 10px; padding: 1px 6px;">${coordStatus}</span></span>
          </div>

          <div class="tel-item full-width">
            <span class="tel-label">Architecture Link</span>
            <span class="tel-val font-mono" style="font-size: 9px; color: var(--accent-cyan);">${archConnection}</span>
          </div>

          <div class="tel-item full-width">
            <span class="tel-label">Latest Event</span>
            <span class="tel-val" style="font-size: 9px;">${latestEvent}</span>
          </div>

          ${isAce ? `
            <div class="tel-item full-width">
              <span class="tel-label">ACE Scope</span>
              <span class="tel-val font-mono" id="insp-scope-val" style="color: var(--accent-cyan);">${robot.coordinationScope || "1 robot (local)"}</span>
            </div>
            <div class="tel-item full-width">
              <span class="tel-label">Envelope Radius</span>
              <span class="tel-val font-mono">${robot.envelopeRadius || 0}m</span>
            </div>
            <div class="tel-item full-width">
              <span class="tel-label">Risk Components</span>
              <span class="tel-val font-mono" style="font-size: 8px;">C:${(robot.riskComponents?.conflict||0).toFixed(2)} U:${(robot.riskComponents?.uncertainty||0).toFixed(2)} CR:${(robot.riskComponents?.commRisk||0).toFixed(2)} Q:${(robot.riskComponents?.queueGrowth||0).toFixed(2)} CP:${(robot.riskComponents?.cascadePressure||0).toFixed(2)}</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    this.bindButtons(robots, robotIndex);
  }

  bindButtons(robots, currentIndex) {
    const prevBtn = this.container.querySelector("#btn-prev-robot");
    const nextBtn = this.container.querySelector("#btn-next-robot");
    const closeBtn = this.container.querySelector("#btn-close-inspector");

    prevBtn?.addEventListener("click", () => {
      if (robots.length === 0) return;
      const newIdx = (currentIndex - 1 + robots.length) % robots.length;
      state.set("selectedRobotId", robots[newIdx].id);
    });

    nextBtn?.addEventListener("click", () => {
      if (robots.length === 0) return;
      const newIdx = (currentIndex + 1) % robots.length;
      state.set("selectedRobotId", robots[newIdx].id);
    });

    closeBtn?.addEventListener("click", () => {
      state.set("selectedRobotId", "R01");
    });
  }

  bindEvents() {
    state.subscribe("selectedRobotId", () => this.render());
    state.subscribe("systemMode", () => this.render());
    state.subscribe("robots", () => this.updateTelemetry());
  }

  updateTelemetry() {
    const robots = state.get("robots") || [];
    const selectedId = state.get("selectedRobotId") || "R01";
    const robot = robots.find(r => r.id === selectedId) || robots[0];
    if (!robot) return;

    const elId = this.container.querySelector("#insp-robot-id");
    const elModel = this.container.querySelector("#insp-robot-model");
    const elStatus = this.container.querySelector("#insp-status-pill");
    const elRace = this.container.querySelector("#insp-race-pill");
    const elBatNum = this.container.querySelector("#insp-battery-num");
    const elBatFill = this.container.querySelector("#insp-battery-fill");
    const elHealthNum = this.container.querySelector("#insp-health-num");
    const elHealthFill = this.container.querySelector("#insp-health-fill");
    const elRiskNum = this.container.querySelector("#insp-risk-num");
    const elRiskFill = this.container.querySelector("#insp-risk-fill");
    const elSpeed = this.container.querySelector("#insp-speed-val");
    const elTask = this.container.querySelector("#insp-task-val");
    const elLoc = this.container.querySelector("#insp-loc-val");
    const elScope = this.container.querySelector("#insp-scope-val");
    const elTaskState = this.container.querySelector("#insp-task-state");
    const elSensor = this.container.querySelector("#insp-sensor-status");
    const elComm = this.container.querySelector("#insp-comm-status");
    const elCoord = this.container.querySelector("#insp-coord-status");
    const elArch = this.container.querySelector("#insp-arch-connection");
    const elEvent = this.container.querySelector("#insp-latest-event");
    const elEnvelope = this.container.querySelector("#insp-envelope-radius");
    const elRiskComp = this.container.querySelector("#insp-risk-components");

    if (elId) elId.textContent = robot.id;
    if (elModel) elModel.textContent = robot.model || "AMR-200";
    if (elBatNum) elBatNum.textContent = `${robot.battery}%`;
    if (elBatFill) {
      elBatFill.style.width = `${robot.battery}%`;
      elBatFill.style.background = robot.battery < 30 ? '#EF4444' : '#10B981';
    }
    if (elHealthNum) elHealthNum.textContent = `${robot.health}%`;
    if (elHealthFill) elHealthFill.style.width = `${robot.health}%`;
    if (elSpeed) elSpeed.textContent = `${(robot.velocity || 0).toFixed(2)} m/s`;
    if (elTask) elTask.textContent = robot.currentTask || "—";
    if (elLoc) elLoc.textContent = robot.location || `${robot.x?.toFixed(0) || 0}, ${robot.y?.toFixed(0) || 0}`;

    const riskScore = typeof robot.riskScore === "number" ? robot.riskScore : 0;
    if (elRiskNum) elRiskNum.textContent = riskScore.toFixed(2);
    if (elRiskFill) {
      elRiskFill.style.width = `${Math.round(riskScore * 100)}%`;
      elRiskFill.style.background = riskScore > 0.65 ? "#EF4444" : riskScore > 0.45 ? "#F59E0B" : "#00C8FF";
    }
    if (elScope) elScope.textContent = robot.coordinationScope || "1 robot (local)";
    if (elEnvelope) elEnvelope.textContent = `${robot.envelopeRadius || 0}m`;

    // Task state
    if (elTaskState) {
      const taskState = robot.currentTaskState || (robot.currentTaskId ? "IN_PROGRESS" : "UNASSIGNED");
      const taskStateClass = taskState === "COMPLETED" ? "status-active" : taskState === "IN_PROGRESS" ? "status-yielding" : taskState === "FAILED" ? "status-error" : "status-idle";
      elTaskState.innerHTML = `<span class="robot-status-pill ${taskStateClass}" style="font-size: 10px; padding: 1px 6px;">${taskState}</span>`;
    }

    // Sensor status
    if (elSensor) {
      const sensorStatus = robot.sensorStatus || ((robot.poseUncertainty || 0) > 0 ? "DEGRADED" : "NOMINAL");
      const sensorClass = sensorStatus === "NOMINAL" ? "status-active" : sensorStatus === "DEGRADED" ? "status-yielding" : "status-error";
      elSensor.innerHTML = `<span class="robot-status-pill ${sensorClass}" style="font-size: 10px; padding: 1px 6px;">${sensorStatus}</span>`;
    }

    // Comm status
    if (elComm) {
      // From runtime state: ACE/P2P blackout flag or a lost / offline server link.
    const commStatus = robot.commStatus || (robot.isCriticalDegraded || robot.centralHold ? "DEGRADED" : "CONNECTED");
      const commClass = commStatus === "CONNECTED" ? "status-active" : commStatus === "DEGRADED" ? "status-yielding" : "status-error";
      elComm.innerHTML = `<span class="robot-status-pill ${commClass}" style="font-size: 10px; padding: 1px 6px;">${commStatus}</span>`;
    }

    // Coordination status
    if (elCoord) {
      const isAce = state.get("systemMode") === "ace";
      const coordStatus = robot.coordinationStatus || (isAce ? robot.raceState || "LOCAL" : state.get("systemMode") === "decentralized"
        ? (robot.pairSession?.inSession ? `PAIR ${robot.pairSession.partner}` : "PAIR SCOPE") : "CENTRALIZED");
      const coordClass = coordStatus === "LOCAL" ? "status-active" : coordStatus === "NEIGHBORHOOD" ? "status-yielding" : coordStatus === "CONTAINMENT" ? "status-error" : coordStatus === "SAFE-DEGRADED" ? "status-charging" : "status-active";
      elCoord.innerHTML = `<span class="robot-status-pill ${coordClass}" style="font-size: 10px; padding: 1px 6px;">${coordStatus}</span>`;
    }

    // Architecture connection
    if (elArch) {
      const systemMode = state.get("systemMode") || "ace";
      const coordination = state.get("coordination") || {};
      let archConnection = "";
      if (systemMode === "centralized") {
        archConnection = `Central Server ${coordination.centralServer?.status === "ONLINE" ? "✓" : "✗"}`;
      } else if (systemMode === "decentralized") {
        archConnection = `P2P Mesh ${coordination.peerNetwork?.status === "ONLINE" ? "✓" : "✗"} (fixed 2-robot scope)`;
      } else {
        archConnection = `ACE/RACE ${coordination.ace?.status === "ONLINE" ? "Active" : "Inactive"} (Envelope: ${robot.envelopeRadius || 0}m)`;
      }
      elArch.textContent = archConnection;
    }

    // Latest event
    if (elEvent) {
      elEvent.textContent = robot.latestEvent || "—";
    }

    // Risk components
    if (elRiskComp) {
      const rc = robot.riskComponents || {};
      elRiskComp.textContent = `C:${(rc.conflict||0).toFixed(2)} U:${(rc.uncertainty||0).toFixed(2)} CR:${(rc.commRisk||0).toFixed(2)} Q:${(rc.queueGrowth||0).toFixed(2)} CP:${(rc.cascadePressure||0).toFixed(2)}`;
    }

    if (elStatus) {
      const isError = robot.status === "error" || robot.status === "ERROR";
      const isCharging = robot.status === "charging" || robot.status === "CHARGING";
      const isIdle = robot.status === "idle" || robot.status === "IDLE";
      const isYielding = robot.isYielding === true;
      const statusLabel = isError ? "Error" : isCharging ? "Charging" : isIdle ? "Idle" : isYielding ? "Yielding" : "Moving";
      const statusClass = isError ? "status-error" : isCharging ? "status-charging" : isIdle ? "status-idle" : isYielding ? "status-yielding" : "status-active";
      elStatus.textContent = statusLabel;
      elStatus.className = `robot-status-pill ${statusClass}`;
    }

    if (elRace && robot.raceState) {
      elRace.textContent = robot.raceState;
      const racePillClass = robot.raceState === "CONTAINMENT" ? "status-error" : robot.raceState === "SAFE-DEGRADED" ? "status-charging" : robot.raceState === "NEIGHBORHOOD" ? "status-active" : "status-idle";
      elRace.className = `robot-status-pill ${racePillClass}`;
    }
  }
}
