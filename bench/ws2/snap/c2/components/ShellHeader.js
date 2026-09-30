import { state } from "../core/state.js";
import { SettingsPopup } from "./SettingsPopup.js";

// Map systemMode keys to human-readable labels (Phase 9: exact labels)
const SYSTEM_LABELS = {
  centralized: "Centralized",
  decentralized: "Decentralized",
  ace: "NodeX Edge AI ACE decentralized"
};

// Map systemMode keys to accent colors
const SYSTEM_COLORS = {
  centralized: "#F59E0B",
  decentralized: "#60A5FA",
  ace: "#00C8FF"
};

// Static warehouse location per requirements
const WAREHOUSE_LOCATION = "Coimbatore";

export class ShellHeader {
  constructor(container) {
    this.container = container;
    this.render();
    this.bindEvents();
  }

  render() {
    const activeTab = state.get("activeTab") || "operations";
    // Driven by the enum, not a substring test: "Disconnected (...)" contains
    // "connected", so the badge used to show green "Connected" with no backend.
    const isConnected = state.get("connectionState") === "CONNECTED";
    const systemMode = state.get("systemMode") || "ace";

    this.container.innerHTML = `
      <div class="nav-bar-container">
        <!-- 1. Left: Brand & Identity -->
        <div class="nav-left-group">
          <div class="brand-block">
            <div class="brand-cube-icon">
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                <polygon points="16,2 30,10 16,18 2,10" fill="#0077FF" opacity="0.9" />
                <polygon points="2,10 16,18 16,30 2,22" fill="#0055CC" />
                <polygon points="16,18 30,10 30,22 16,30" fill="#0099FF" />
                <polygon points="16,6 26,11.5 16,17 6,11.5" stroke="#60A5FA" stroke-width="1.2" fill="none" />
                <circle cx="16" cy="11.5" r="2.5" fill="#FFFFFF" />
              </svg>
            </div>
            <div class="brand-text">
              <div class="brand-title">
                <span>NODEX</span>
                <span class="accent-tag">ACE</span>
              </div>
              <div class="brand-sub">Adaptive Coordination for Smarter Warehouses</div>
            </div>
          </div>

          <!-- Static Warehouse Location: Coimbatore -->
          <div class="warehouse-location-static" id="warehouse-location-static">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
              <polyline points="9 22 9 12 15 12 15 22"></polyline>
            </svg>
            <span>${WAREHOUSE_LOCATION}</span>
          </div>
        </div>

        <!-- Active System Indicator Pill -->
        <div class="active-system-indicator" id="active-system-pill" title="Currently active coordination architecture">
          <div class="sys-dot" id="active-sys-dot" style="background:${SYSTEM_COLORS[systemMode] || "#00C8FF"}"></div>
          <div class="sys-text-block">
            <span class="sys-label-tiny">ACTIVE SYSTEM</span>
            <span class="sys-name-badge" id="active-sys-name">${SYSTEM_LABELS[systemMode]}</span>
          </div>
        </div>

        <!-- Center: Primary Screen Navigation Pills -->
        <nav class="nav-center-pills" aria-label="Main Views">
          <button class="nav-pill-btn ${activeTab === 'operations' ? 'active' : ''}" data-tab="operations" id="nav-btn-simulation">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            <span>Simulation</span>
          </button>

          <button class="nav-pill-btn ${activeTab === 'coordination' ? 'active' : ''}" data-tab="coordination" id="nav-btn-explain">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18h6"></path>
              <path d="M10 22h4"></path>
              <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"></path>
            </svg>
            <span>Explain Simulation</span>
          </button>

          <button class="nav-pill-btn ${activeTab === 'experiments' ? 'active' : ''}" data-tab="experiments" id="nav-btn-analytics">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="20" x2="18" y2="10"></line>
              <line x1="12" y1="20" x2="12" y2="4"></line>
              <line x1="6" y1="20" x2="6" y2="14"></line>
            </svg>
            <span>Analytics & Efficiency</span>
          </button>

          <button class="nav-pill-btn ${activeTab === 'control' ? 'active' : ''}" data-tab="control" id="nav-btn-settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
            <span>Settings</span>
          </button>
        </nav>

        <!-- Right: Live Connection, Dynamic Clock -->
        <div class="nav-right-group">
          <!-- Connection Indicator - Just "Connected" -->
          <div class="connection-pill-card ${isConnected ? 'connected' : 'disconnected'}" id="nav-connection-card">
            <div class="conn-dot-pulse"></div>
            <div class="conn-text-wrap">
              <span class="conn-status-label" id="nav-conn-label" title="${state.get("connectionStatus") || ""}">${isConnected ? 'Connected' : 'Local Sim'}</span>
            </div>
          </div>

          <!-- Live Dynamic Date & Clock -->
          <div class="dynamic-clock-card">
            <div class="clock-date-line" id="nav-clock-date">Jan 20, 2025</div>
            <div class="clock-time-line" id="nav-clock-time">10:42:28</div>
          </div>
        </div>
      </div>
    `;

    this.startDynamicClock();
  }

  startDynamicClock() {
    const update = () => {
      const now = new Date();
      const dateEl = document.getElementById("nav-clock-date");
      const timeEl = document.getElementById("nav-clock-time");

      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        });
      }

      if (timeEl) {
        const timeFormat = state.get("timeFormat") || "24-hour";
        if (timeFormat === "12-hour") {
          timeEl.textContent = now.toLocaleTimeString("en-US", { hour12: true });
        } else {
          timeEl.textContent = now.toTimeString().split(" ")[0];
        }
      }
    };

    update();
    setInterval(update, 1000);
    state.subscribe("timeFormat", () => update());
  }

  bindEvents() {
    // Navigation pill button clicks
    const pillButtons = this.container.querySelectorAll(".nav-pill-btn");
    pillButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        if (tab === "control") {
          SettingsPopup.toggle();
        } else {
          SettingsPopup.close();
          this.switchTab(tab);
        }
      });
    });

    // Subscribe to activeTab state changes
    state.subscribe("activeTab", (tab) => {
      // Any code may navigate by setting activeTab (e.g. Explain's "New
      // Simulation" button): show that screen, not only the pill highlight.
      const panel = document.getElementById(`screen-${tab}`);
      if (panel && !panel.classList.contains("active")) {
        document.querySelectorAll(".screen-panel").forEach(p => p.classList.toggle("active", p === panel));
      }
      pillButtons.forEach(btn => {
        if (btn.getAttribute("data-tab") === tab) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      });
    });

    // Subscribe to connection status changes
    state.subscribe("connectionState", (connState) => {
      const card = document.getElementById("nav-connection-card");
      const label = document.getElementById("nav-conn-label");
      if (card && label) {
        const isConnected = connState === "CONNECTED";
        card.className = `connection-pill-card ${isConnected ? 'connected' : 'disconnected'}`;
        label.textContent = isConnected ? "Connected" : "Local Sim";
        label.title = state.get("connectionStatus") || "";
      }
    });

    // Subscribe to systemMode changes — update Active System Indicator
    state.subscribe("systemMode", (mode) => {
      const nameEl = document.getElementById("active-sys-name");
      const dotEl = document.getElementById("active-sys-dot");
      if (nameEl) nameEl.textContent = SYSTEM_LABELS[mode] || mode.toUpperCase();
      if (dotEl) dotEl.style.background = SYSTEM_COLORS[mode] || "#00C8FF";
    });
  }

  switchTab(tabName) {
    state.set("activeTab", tabName);

    // Toggle screen containers
    const panels = document.querySelectorAll(".screen-panel");
    panels.forEach(p => p.classList.remove("active"));

    const target = document.getElementById(`screen-${tabName}`);
    if (target) {
      target.classList.add("active");
    }

    // If there is an external dock or tag, sync it as well
    const dockTag = document.getElementById("dock-screen-label");
    if (dockTag) dockTag.textContent = tabName.toUpperCase();
  }
}