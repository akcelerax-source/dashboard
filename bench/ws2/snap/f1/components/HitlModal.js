// ==========================================================================
// NODEX ACE - Human-in-the-Loop (HITL) Control Lease Modal & Safety Arbiter
// Implementation of Section 8 (HITL Design) & F22-F26 Safety Gating
// ==========================================================================

import { state } from "../core/state.js";
import { simEngine } from "../core/sim-engine.js";
import { MapGeometryEngine } from "../core/map-geometry.js";
import { hitlController, HITL_SCOPES } from "../core/hitl-controller.js";

// All lease/teleop actions resolve the robot fresh from state and write through
// simEngine.updateRobot (agent localState in Decentralized/ACE). The modal used
// to keep the snapshot object captured at open(), which the engine replaces on
// the next tick, so teleop moved a discarded copy and the lease never stopped
// autonomous driving.
const liveRobot = (id) => simEngine.getRobotState(id);
// No user accounts exist: HITL actions are attributed to the operator role.
const operatorIdentity = () => ({ name: "Operator", role: "Operator" });

// The lease panel shown inline inside the Operations HITL card (null = none).
// The card re-renders often; it calls activeInlineLease.remount() each time.
export let activeInlineLease = null;

export class HitlModal {
  /**
   * `inline: true` renders the teleop lease inside the HITL card
   * (#hitl-lease-mount) instead of a full-screen modal, so the operator keeps
   * the map in view while driving the robot.
   */
  constructor(options = {}) {
    this.inline = options.inline === true;
    this.modalContainer = document.getElementById("modal-container");
    this.activeRobotId = null;
    this.leaseTimer = null;
    this.secondsRemaining = 60;
  }

  /** Status colours: the inline panel sits on the dark card background. */
  _c(light) {
    if (!this.inline) return light;
    return { "#DC2626": "#F87171", "#166534": "#86EFAC", "#64748B": "#94A3B8", "#2563EB": "#93C5FD" }[light] || light;
  }

  _mount() {
    return this.inline ? document.getElementById("hitl-lease-mount") : this.modalContainer;
  }

  /** Re-draws the inline panel after its host card re-rendered. */
  remount() {
    const target = liveRobot(this.activeRobotId);
    if (!target || !this._mount()) return;
    this.renderDOM(target);
    this.bindEvents(target);
  }

  open(robotId) {
    if (this.inline && activeInlineLease && activeInlineLease !== this) {
      const prev = liveRobot(activeInlineLease.activeRobotId);
      if (prev) activeInlineLease.releaseControl(prev, "Operator switched teleop target");
    }
    this.activeRobotId = robotId;
    this.secondsRemaining = 60;

    const robots = state.get("robots") || [];
    const target = robots.find(r => r.id === robotId) || robots[0];
    if (!target) return;
    this.activeRobotId = target.id;
    const operator = operatorIdentity();
    this.leaseToken = `LSE-${Date.now().toString(36).toUpperCase()}`;

    // Transition to HUMAN control mode: the engine suspends autonomous motion
    // for robots with controlMode HUMAN until the lease is released.
    simEngine.updateRobot(target.id, { controlMode: "HUMAN", velocity: 0 });
    state.set("hitlMode", "LEASED");
    state.set("hitlLease", { operatorId: operator.name, robotId: target.id, expiresAt: Date.now() + 60000, token: this.leaseToken });

    simEngine.addEvent(target.id, "HITL", `Control lease granted to operator ${operator.name} for ${target.id}`);

    this.renderDOM(target);
    this.startWatchdog(target);
    this.bindEvents(target);
  }

  renderDOM(target) {
    if (this.inline) {
      activeInlineLease = this;
      const mount = this._mount();
      if (!mount) return;
      mount.innerHTML = `
        <div class="hitl-lease-inline">
          <div class="hl-head">
            <span class="hl-title">Teleop lease &bull; ${target.id}</span>
            <span class="hl-timer" id="watchdog-display" title="Watchdog: lease returns to autonomy when it reaches zero">00:${this.secondsRemaining.toString().padStart(2, "0")}</span>
          </div>
          <div class="hl-safety"><span class="hl-dot"></span>Safety supervisor active &bull; speed clamp &bull; obstacle barrier</div>
          <div class="hl-body">
            <div class="hl-pad">
              <span></span><button class="hl-pad-btn" id="teleop-up" title="Move up">&uarr;</button><span></span>
              <button class="hl-pad-btn" id="teleop-left" title="Move left">&larr;</button>
              <button class="hl-pad-btn hl-stop" id="teleop-stop" title="Halt">STOP</button>
              <button class="hl-pad-btn" id="teleop-right" title="Move right">&rarr;</button>
              <span></span><button class="hl-pad-btn" id="teleop-down" title="Move down">&darr;</button><span></span>
            </div>
            <div class="hl-actions">
              <button class="hl-act" id="btn-replan-route">Replan route</button>
              <button class="hl-act hl-danger" id="btn-emergency-stop-lease">Emergency stop</button>
              <button class="hl-act hl-release" id="btn-release-lease">Release to autonomy</button>
            </div>
          </div>
          <div class="hl-status" id="hitl-modal-status">Lease ${this.leaseToken || ""} &bull; operator in control</div>
        </div>`;
      return;
    }
    this.modalContainer.innerHTML = `
      <div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15,23,42,0.55); backdrop-filter: blur(4px); z-index: 10000; display: flex; align-items: center; justify-content: center;" id="hitl-backdrop">
        <div style="background: white; border-radius: 16px; width: 480px; padding: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); display: flex; flex-direction: column; gap: 16px; border: 1px solid #E2E8F0;">
          <!-- Header -->
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #E2E8F0; padding-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="width: 28px; height: 28px; border-radius: 6px; background: #EFF6FF; color: #2563EB; display: flex; align-items: center; justify-content: center;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="2" y="6" width="20" height="12" rx="2"></rect>
                  <circle cx="8" cy="12" r="2"></circle>
                  <path d="M15 9v6"></path>
                  <path d="M12 12h6"></path>
                </svg>
              </div>
              <div>
                <h3 style="font-size: 15px; font-weight: 800; color: #0F172A;">HITL Control Lease &bull; ${target.id}</h3>
                <div style="font-size: 10.5px; color: #64748B;">Target: ${target.model} &bull; Operator: ${operatorIdentity().name} (${operatorIdentity().role})</div>
              </div>
            </div>
            <button id="close-hitl-btn" style="font-size: 20px; color: #64748B; cursor: pointer;">&times;</button>
          </div>

          <!-- Watchdog & Safety Supervisor Status -->
          <div style="display: flex; justify-content: space-between; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 10px; padding: 10px 14px;">
            <div>
              <div style="font-size: 10px; color: #64748B; font-weight: 600;">WATCHDOG TIMER</div>
              <div style="font-size: 15px; font-weight: 800; color: #DC2626; font-family: monospace;" id="watchdog-display">00:${this.secondsRemaining.toString().padStart(2, "0")}</div>
            </div>
            <div>
              <div style="font-size: 10px; color: #64748B; font-weight: 600;">SAFETY SUPERVISOR</div>
              <div style="font-size: 11.5px; font-weight: 700; color: #166534; display: flex; align-items: center; gap: 4px;">
                <span style="width: 7px; height: 7px; border-radius: 50%; background: #10B981;"></span>
                <span>Active &bull; Speed Clamp 1.5 m/s &bull; Obstacle Barrier Enforced</span>
              </div>
            </div>
          </div>

          <!-- Manual Teleop Control Pad -->
          <div style="display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 0;">
            <div style="font-size: 11px; font-weight: 700; color: #64748B;">TELEOPERATION ARBITER</div>
            <div style="display: grid; grid-template-columns: repeat(3, 50px); grid-template-rows: repeat(3, 50px); gap: 6px;">
              <div></div>
              <button class="teleop-pad-btn" id="teleop-up" style="background: #F1F5F9; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 16px; font-weight: 800; display: flex; align-items: center; justify-content: center;">&uarr;</button>
              <div></div>
              <button class="teleop-pad-btn" id="teleop-left" style="background: #F1F5F9; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 16px; font-weight: 800; display: flex; align-items: center; justify-content: center;">&larr;</button>
              <button class="teleop-pad-btn" id="teleop-stop" style="background: #FEF2F2; border: 1px solid #FECACA; color: #DC2626; border-radius: 8px; font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center;">STOP</button>
              <button class="teleop-pad-btn" id="teleop-right" style="background: #F1F5F9; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 16px; font-weight: 800; display: flex; align-items: center; justify-content: center;">&rarr;</button>
              <div></div>
              <button class="teleop-pad-btn" id="teleop-down" style="background: #F1F5F9; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 16px; font-weight: 800; display: flex; align-items: center; justify-content: center;">&darr;</button>
              <div></div>
            </div>
            <div style="font-size: 10px; color: #94A3B8;">Use arrow buttons to command safe movements along warehouse corridors</div>
          </div>

          <!-- Dynamic Status Feedback Message -->
          <div id="hitl-modal-status" style="font-size: 11px; text-align: center; color: #2563EB; min-height: 16px; font-weight: 600;"></div>

          <!-- Quick Command Action Buttons -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <button id="btn-replan-route" style="padding: 9px; background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 8px; font-size: 11.5px; font-weight: 700; color: #2563EB;">Request D* Lite Replan</button>
            <button id="btn-emergency-stop-lease" style="padding: 9px; background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; font-size: 11.5px; font-weight: 700; color: #DC2626;">Emergency Safe Stop</button>
          </div>

          <!-- Footer Actions -->
          <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #E2E8F0; padding-top: 12px;">
            <span style="font-size: 10.5px; color: #64748B;">Lease Token: #${this.leaseToken}</span>
            <button id="btn-release-lease" style="padding: 8px 16px; background: #0F172A; color: white; border-radius: 8px; font-size: 11.5px; font-weight: 700;">Release Control to Autonomous</button>
          </div>
        </div>
      </div>
    `;
  }

  startWatchdog(target) {
    if (this.leaseTimer) clearInterval(this.leaseTimer);

    this.leaseTimer = setInterval(() => {
      this.secondsRemaining--;
      const el = document.getElementById("watchdog-display");
      if (el) {
        el.textContent = `00:${this.secondsRemaining.toString().padStart(2, "0")}`;
      }

      if (this.secondsRemaining <= 0) {
        this.releaseControl(target, "Watchdog timeout (60s expired)");
      }
    }, 1000);
  }

  bindEvents(target) {
    // Re-mounts must not stack listeners on the same pad buttons.
    const root = this._mount();
    if (!root) return;
    if (root._leaseBound === this && root.firstElementChild === this._boundEl) return;
    root._leaseBound = this;
    this._boundEl = root.firstElementChild;
    const closeBtn = document.getElementById("close-hitl-btn");
    closeBtn?.addEventListener("click", () => {
      this.releaseControl(target, "Operator closed interface");
    });

    const releaseBtn = document.getElementById("btn-release-lease");
    releaseBtn?.addEventListener("click", () => {
      this.releaseControl(target, "Operator released lease manually");
    });

    // Safety Supervisor Guarded Teleoperation
    const checkSafetyAndApply = (heading, velocity = 1.0) => {
      this.secondsRemaining = 60;
      const statusEl = document.getElementById("hitl-modal-status");
      const cur = liveRobot(target.id);
      if (!cur) return false;
      const nextStep = 18;
      const testX = cur.x + Math.cos(heading) * nextStep;
      const testY = cur.y + Math.sin(heading) * nextStep;

      const inBounds = MapGeometryEngine.isWithinBounds(testX, testY);
      const shelfCheck = MapGeometryEngine.isPointInObstacle(testX, testY);

      if (!inBounds || shelfCheck.collision) {
        if (statusEl) {
          statusEl.style.color = this._c("#DC2626");
          statusEl.textContent = `Safety Supervisor: Obstacle/boundary ahead (${shelfCheck.obstacle?.name || "Map Boundary"}). Motion clamped.`;
        }
        return false;
      }

      simEngine.updateRobot(target.id, { heading, x: testX, y: testY, prevX: cur.x, prevY: cur.y });
      if (statusEl) {
        statusEl.style.color = this._c("#166534");
        statusEl.textContent = `Operator command applied: position (${Math.round(testX)}, ${Math.round(testY)})`;
      }
      return true;
    };

    // Teleop buttons
    document.getElementById("teleop-up")?.addEventListener("click", () => {
      checkSafetyAndApply(-Math.PI / 2, 1.2);
    });
    document.getElementById("teleop-down")?.addEventListener("click", () => {
      checkSafetyAndApply(Math.PI / 2, 1.0);
    });
    document.getElementById("teleop-left")?.addEventListener("click", () => {
      checkSafetyAndApply(Math.PI, 1.0);
    });
    document.getElementById("teleop-right")?.addEventListener("click", () => {
      checkSafetyAndApply(0, 1.0);
    });
    document.getElementById("teleop-stop")?.addEventListener("click", () => {
      simEngine.updateRobot(target.id, { velocity: 0 });
      const statusEl = document.getElementById("hitl-modal-status");
      if (statusEl) {
        statusEl.style.color = this._c("#64748B");
        statusEl.textContent = "Robot halted by teleop STOP.";
      }
    });

    document.getElementById("btn-replan-route")?.addEventListener("click", () => {
      const waypoints = MapGeometryEngine.getActiveWaypoints();
      const cur = liveRobot(target.id);
      if (!cur) return;
      const currentNearest = MapGeometryEngine.findNearestWaypoint(cur.x, cur.y);
      const candidates = waypoints.filter(wp => wp.x !== currentNearest.x || wp.y !== currentNearest.y);
      const targetWp = candidates.length > 0 ? candidates[Math.floor(candidates.length / 2)] : waypoints[0];

      const newPath = MapGeometryEngine.planCorridorPath(cur.x, cur.y, targetWp.x, targetWp.y);
      if (newPath.length > 1) {
        // Replaces the planned path (the map draws only the new route); the
        // robot follows it once the lease returns control to autonomy.
        simEngine.updateRobot(target.id, {
          plannedPath: newPath,
          currentPath: newPath,
          targetX: newPath[1].x,
          targetY: newPath[1].y,
          heading: Math.atan2(newPath[1].y - cur.y, newPath[1].x - cur.x),
          status: "MOVING"
        });
      }

      simEngine.addEvent(target.id, "HITL", `D* Lite corridor path replanned for ${target.id} toward ${targetWp.id}`);
      const statusEl = document.getElementById("hitl-modal-status");
      if (statusEl) {
        statusEl.style.color = this._c("#2563EB");
        statusEl.textContent = `D* Lite route calculated: ${newPath.length} legal waypoints to ${targetWp.id}`;
      }
    });

    document.getElementById("btn-emergency-stop-lease")?.addEventListener("click", () => {
      hitlController.dispatchCommand({
        scope: HITL_SCOPES.INDIVIDUAL_ROBOT,
        targets: [target.id],
        action: "safe_stop",
        reason: "Emergency safe stop from teleop lease"
      });
      this.releaseControl(target, "Emergency Stop triggered");
    });
  }

  releaseControl(target, reason) {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }

    simEngine.updateRobot(target.id, { controlMode: "AUTONOMOUS" });
    state.set("hitlLease", null);
    state.set("hitlMode", "MONITOR");
    simEngine.addEvent(target.id, "HITL", `Control lease returned to AUTONOMOUS (${reason})`);

    const mount = this._mount();
    if (mount) mount.innerHTML = "";
    if (activeInlineLease === this) activeInlineLease = null;
  }
}

export const hitlModal = new HitlModal();
window.openHitlModal = (robotId) => hitlModal.open(robotId);

// View Details Modal helper
window.openRobotDetailsModal = (robotId) => {
  const modalContainer = document.getElementById("modal-container");
  if (!modalContainer) return;

  const robots = state.get("robots") || [];
  const r = robots.find(item => item.id === robotId) || robots[0];
  if (!r) return;

  modalContainer.innerHTML = `
    <div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15,23,42,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center;" id="details-backdrop">
      <div style="background: white; border-radius: 16px; width: 520px; padding: 24px; box-shadow: 0 25px 50px rgba(0,0,0,0.2); display: flex; flex-direction: column; gap: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #E2E8F0; padding-bottom: 12px;">
          <h3 style="font-size: 16px; font-weight: 800; color: #0F172A;">Detailed Telemetry &bull; ${r.id} (${r.model})</h3>
          <button id="close-details-btn" style="font-size: 20px; color: #64748B;">&times;</button>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 11.5px;">
          <div style="background: #F8FAFC; padding: 10px; border-radius: 8px;">
            <div style="font-weight: 700; color: #0F172A; margin-bottom: 6px;">Kinematics & Pose</div>
            <div>X: ${r.x.toFixed(1)} m | Y: ${r.y.toFixed(1)} m</div>
            <div>Heading: ${(r.heading * 180 / Math.PI).toFixed(1)}&deg;</div>
            <div>Velocity: ${(r.velocity || 0).toFixed(2)} (Target: ${(r.targetVelocity || 0).toFixed(2)})</div>
          </div>
          <div style="background: #F8FAFC; padding: 10px; border-radius: 8px;">
            <div style="font-weight: 700; color: #0F172A; margin-bottom: 6px;">RACE Multi-Factor Risk</div>
            ${r.riskComponents ? `
            <div>Conflict: ${r.riskComponents.conflict}</div>
            <div>Uncertainty: ${r.riskComponents.uncertainty}</div>
            <div>Comm Risk: ${r.riskComponents.commRisk}</div>
            <div>Queue Growth: ${r.riskComponents.queueGrowth}</div>
            <div>Cascade Pressure: ${r.riskComponents.cascadePressure}</div>
            <div>RACE State: ${r.raceState} (risk ${(r.riskScore || 0).toFixed(2)})</div>` : `<div>RACE inactive in this architecture.</div>`}
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end;">
          <button id="details-close-action" style="padding: 8px 16px; background: #2563EB; color: white; border-radius: 8px; font-weight: 600;">Close</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("close-details-btn")?.addEventListener("click", () => modalContainer.innerHTML = "");
  document.getElementById("details-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "details-backdrop") modalContainer.innerHTML = "";
  });
  document.getElementById("details-close-action")?.addEventListener("click", () => modalContainer.innerHTML = "");
};
