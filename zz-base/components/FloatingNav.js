// ==========================================================================
// NODEX ACE - Floating Navigation Dock & Quick HITL / Search Bar
// ==========================================================================

import { state } from "../core/state.js";

export class FloatingNav {
  constructor(container) {
    this.container = container;
    this.render();
    this.bindEvents();
  }

  render() {
    const activeTab = state.get("activeTab") || "operations";
    const hitlEnabled = state.get("hitlEnabled") || false;

    this.container.innerHTML = `
      <!-- Left Category Tag (changes dynamically) -->
      <div class="dock-left-meta">
        <div class="screen-indicator-tag" id="dock-screen-tag">
          <span class="tag-dot"></span>
          <span id="dock-screen-label">${activeTab.toUpperCase()}</span>
        </div>
      </div>

      <!-- Centered Floating 4-Tab Navigation Dock -->
      <nav class="floating-nav-dock" aria-label="Main Navigation">
        <!-- Operations Tab -->
        <button class="nav-tab-btn ${activeTab === 'operations' ? 'active' : ''}" data-tab="operations" id="tab-operations">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
            <polyline points="9 22 9 12 15 12 15 22"></polyline>
          </svg>
          <span>Operations</span>
        </button>

        <!-- Coordination Tab -->
        <button class="nav-tab-btn ${activeTab === 'coordination' ? 'active' : ''}" data-tab="coordination" id="tab-coordination">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <circle cx="12" cy="12" r="6"></circle>
            <circle cx="12" cy="12" r="2"></circle>
          </svg>
          <span>Coordination</span>
        </button>

        <!-- Control Tab -->
        <button class="nav-tab-btn ${activeTab === 'control' ? 'active' : ''}" data-tab="control" id="tab-control">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <rect x="2" y="6" width="20" height="12" rx="2"></rect>
            <circle cx="8" cy="12" r="2"></circle>
            <path d="M15 9v6"></path>
            <path d="M12 12h6"></path>
          </svg>
          <span>Control</span>
        </button>

        <!-- Experiments Tab -->
        <button class="nav-tab-btn ${activeTab === 'experiments' ? 'active' : ''}" data-tab="experiments" id="tab-experiments">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M10 2v7.31"></path>
            <path d="M14 2v7.31"></path>
            <path d="M8.5 2h7"></path>
            <path d="M14 9.3a6.5 6.5 0 1 1-4 0"></path>
          </svg>
          <span>Experiments</span>
        </button>
      </nav>

      <!-- Right Controls: HITL Toggle & Global Search -->
      <div class="dock-right-controls">
        <!-- HITL Badge / Toggle Card -->
        <div class="hitl-status-card">
          <div class="hitl-icon-wrap">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
          </div>
          <div class="hitl-text-group">
            <span class="hitl-title">Human-in-the-Loop</span>
            <span class="hitl-subtitle" id="hitl-sub-label">Monitor &bull; Approve &bull; Take Control</span>
          </div>
          <label class="toggle-switch" title="Toggle Human-in-the-Loop Monitoring / Control">
            <input type="checkbox" id="hitl-global-switch" ${hitlEnabled ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>

        <!-- Global Search Input -->
        <div class="global-search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-muted);">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input type="text" id="global-search-input" placeholder="Search robots, tasks, zones...">
          <span class="search-shortcut-kbd">⌘ K</span>
        </div>
      </div>
    `;
  }

  bindEvents() {
    // Tab Switching
    const buttons = this.container.querySelectorAll(".nav-tab-btn");
    buttons.forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        this.switchTab(tab);
      });
    });

    // HITL Toggle
    const hitlSwitch = this.container.querySelector("#hitl-global-switch");
    hitlSwitch?.addEventListener("change", (e) => {
      const checked = e.target.checked;
      state.set("hitlEnabled", checked);
      state.set("hitlMode", checked ? "MONITOR" : "OFF");
      const label = document.getElementById("hitl-sub-label");
      if (label) {
        label.textContent = checked ? "Active &bull; Monitoring Telemetry" : "Monitor &bull; Approve &bull; Take Control";
      }
    });

    // Keyboard shortcut ⌘K / Ctrl+K
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const searchInput = document.getElementById("global-search-input");
        searchInput?.focus();
      }
    });

    // Global Search interaction
    const searchInput = this.container.querySelector("#global-search-input");
    searchInput?.addEventListener("input", (e) => {
      const q = e.target.value.trim().toUpperCase();
      if (!q) return;
      const robots = state.get("robots") || [];
      const match = robots.find(r => r.id.includes(q) || r.currentTask.includes(q));
      if (match) {
        state.set("selectedRobotId", match.id);
      }
    });

    // Subscribe to activeTab state changes
    state.subscribe("activeTab", (tab) => {
      buttons.forEach(btn => {
        if (btn.getAttribute("data-tab") === tab) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      });
      const lbl = document.getElementById("dock-screen-label");
      if (lbl) lbl.textContent = tab.toUpperCase();
    });
  }

  switchTab(tab) {
    state.set("activeTab", tab);

    // Hide all screens and show target screen
    const screens = ["operations", "coordination", "control", "experiments"];
    screens.forEach(s => {
      const el = document.getElementById(`screen-${s}`);
      if (el) {
        if (s === tab) {
          el.classList.add("active");
        } else {
          el.classList.remove("active");
        }
      }
    });
  }
}
