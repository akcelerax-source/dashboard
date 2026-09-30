// ==========================================================================
// NODEX ACE - Settings Floating Popup Component
// High-fidelity implementation matching Reference Screenshot 1
// ==========================================================================

import { state } from "../core/state.js";
import { simEngine } from "../core/sim-engine.js";
import { MAPS_REGISTRY } from "../data/scenarios.js";

export class SettingsPopup {
  static open() {

    let overlay = document.getElementById("settings-popup-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "settings-popup-overlay";
      overlay.className = "floating-popup-overlay";
      document.body.appendChild(overlay);
    }

    const currentTheme = state.get("theme") || "dark";
    const currentTimeFormat = state.get("timeFormat") || "24-hour";
    const currentAutoRefresh = state.get("autoRefresh") !== false;
    const currentRobotCount = state.get("robotCount") || 50;

    overlay.innerHTML = `
      <div class="floating-popup-card settings-popup-card" id="settings-popup-card" role="dialog" aria-modal="true">
        <!-- Header -->
        <div class="popup-header-row">
          <div class="popup-title-group">
            <div class="popup-icon-badge">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </div>
            <div class="popup-header-text">
              <span class="popup-main-title">Settings</span>
              <span class="popup-sub-title">Customize your experience</span>
            </div>
          </div>
          <button class="popup-close-btn" id="btn-close-settings-popup" title="Close Settings">&times;</button>
        </div>

        <!-- Content Body -->
        <div class="popup-content-body">
          <!-- 2. Theme Row -->
          <div class="settings-row">
            <div class="row-left-label">
              <span class="row-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="5"></circle>
                  <line x1="12" y1="1" x2="12" y2="3"></line>
                  <line x1="12" y1="21" x2="12" y2="23"></line>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                  <line x1="1" y1="12" x2="3" y2="12"></line>
                  <line x1="21" y1="12" x2="23" y2="12"></line>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                </svg>
              </span>
              <span>Theme</span>
            </div>
            <div class="pill-toggle-group" id="theme-toggle-group">
              <button class="pill-toggle-opt ${currentTheme === 'light' ? 'active' : ''}" data-val="light">Light</button>
              <button class="pill-toggle-opt ${currentTheme === 'dark' ? 'active' : ''}" data-val="dark">Dark</button>
              <button class="pill-toggle-opt ${currentTheme === 'auto' ? 'active' : ''}" data-val="auto">Auto</button>
            </div>
          </div>

          <!-- 3. Time Format Row -->
          <div class="settings-row">
            <div class="row-left-label">
              <span class="row-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </span>
              <span>Time Format</span>
            </div>
            <div class="pill-toggle-group" id="time-toggle-group">
              <button class="pill-toggle-opt ${currentTimeFormat === '12-hour' ? 'active' : ''}" data-val="12-hour">12-hour</button>
              <button class="pill-toggle-opt ${currentTimeFormat === '24-hour' ? 'active' : ''}" data-val="24-hour">24-hour</button>
            </div>
          </div>

          <!-- 4. Map Upload Row -->
          <div class="settings-row" style="align-items: flex-start;">
            <div class="row-left-label" style="margin-top: 6px;">
              <span class="row-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
                  <line x1="8" y1="2" x2="8" y2="18"></line>
                  <line x1="16" y1="6" x2="16" y2="22"></line>
                </svg>
              </span>
              <span>Map Upload</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end;">
              <input type="file" id="settings-map-file-input" accept=".yaml,.yml,.png,.pgm" style="display: none;">
              <div class="map-upload-compact-btn" id="btn-trigger-map-upload">
                <div class="upload-title-row">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <span>Upload Map</span>
                </div>
                <span class="upload-sub-formats">Supports .yaml, .png, .pgm</span>
              </div>
              <div class="upload-feedback-msg" id="map-upload-feedback" style="display: none;"></div>
            </div>
          </div>

          <!-- 5. Robot Count Row -->
          <div class="settings-row">
            <div class="row-left-label">
              <span class="row-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="10" rx="2"></rect>
                  <circle cx="12" cy="5" r="2"></circle>
                  <path d="M12 7v4"></path>
                  <line x1="8" y1="16" x2="8" y2="16"></line>
                  <line x1="16" y1="16" x2="16" y2="16"></line>
                </svg>
              </span>
              <span>Robot Count</span>
            </div>
            <select class="settings-robot-select" id="sel-settings-robot-count">
              <option value="3" ${currentRobotCount === 3 ? 'selected' : ''}>3 Robots</option>
              <option value="10" ${currentRobotCount === 10 ? 'selected' : ''}>10 Robots</option>
              <option value="50" ${currentRobotCount === 50 ? 'selected' : ''}>50 Robots</option>
              <option value="100" ${currentRobotCount === 100 ? 'selected' : ''}>100 Robots</option>
            </select>
          </div>

          <!-- 6. Auto Refresh Data Row -->
          <div class="settings-row">
            <div class="row-left-label">
              <span class="row-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <polyline points="1 20 1 14 7 14"></polyline>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
              </span>
              <span>Auto Refresh Data</span>
            </div>
            <label class="switch-setting">
              <input type="checkbox" id="chk-settings-auto-refresh" ${currentAutoRefresh ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- Footer -->
        <div class="settings-footer-row">
          <button class="btn-reset-default" id="btn-settings-reset">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
              <polyline points="3 3 3 8 8 8"></polyline>
            </svg>
            <span>Reset to Default</span>
          </button>
          
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="save-confirmation-toast" id="settings-save-toast" style="display: none;">
              <span>&#10003; Settings saved</span>
            </div>
            <button class="btn-save-settings" id="btn-settings-save">Save Changes</button>
          </div>
        </div>
      </div>
    `;

    // Add active class to top nav Settings button
    const navSettingsBtn = document.getElementById("nav-btn-settings");
    if (navSettingsBtn) navSettingsBtn.classList.add("settings-active-popup");

    SettingsPopup.bindEvents(overlay);
  }

  static close() {
    const overlay = document.getElementById("settings-popup-overlay");
    if (overlay) {
      overlay.remove();
    }
    const navSettingsBtn = document.getElementById("nav-btn-settings");
    if (navSettingsBtn) navSettingsBtn.classList.remove("settings-active-popup");
  }

  static isOpen() {
    return !!document.getElementById("settings-popup-overlay");
  }

  static toggle() {
    if (SettingsPopup.isOpen()) {
      SettingsPopup.close();
    } else {
      SettingsPopup.open();
    }
  }

  static bindEvents(overlay) {
    const card = overlay.querySelector("#settings-popup-card");

    // Close button
    const closeBtn = overlay.querySelector("#btn-close-settings-popup");
    closeBtn?.addEventListener("click", () => SettingsPopup.close());

    // Click outside to close
    overlay.addEventListener("click", (e) => {
      if (!e.target.closest("#settings-popup-card") && !e.target.closest("#nav-btn-settings")) {
        SettingsPopup.close();
      }
    });

    // Escape key closes popup
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        SettingsPopup.close();
        document.removeEventListener("keydown", onKeyDown);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Theme Toggle
    const themeButtons = overlay.querySelectorAll("#theme-toggle-group .pill-toggle-opt");
    themeButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const theme = btn.getAttribute("data-val");
        themeButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.set("theme", theme);
        localStorage.setItem("nodex_theme", theme);
      });
    });

    // Time Format Toggle
    const timeButtons = overlay.querySelectorAll("#time-toggle-group .pill-toggle-opt");
    timeButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const format = btn.getAttribute("data-val");
        timeButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.set("timeFormat", format);
        localStorage.setItem("nodex_time_format", format);
      });
    });

    // Map Upload Handler
    const mapFileInput = overlay.querySelector("#settings-map-file-input");
    const mapUploadTrigger = overlay.querySelector("#btn-trigger-map-upload");
    const mapFeedback = overlay.querySelector("#map-upload-feedback");

    mapUploadTrigger?.addEventListener("click", () => {
      mapFileInput?.click();
    });

    mapFileInput?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
      const validExtensions = [".yaml", ".yml", ".png", ".pgm"];

      if (!validExtensions.includes(ext)) {
        if (mapFeedback) {
          mapFeedback.style.display = "block";
          mapFeedback.className = "upload-feedback-msg error";
          mapFeedback.textContent = `Invalid file format (${ext}). Supported: .yaml, .png, .pgm`;
        }
        mapFileInput.value = "";
        return;
      }

      // Valid file format: register map into MAPS_REGISTRY
      const cleanName = file.name.replace(/\.[^/.]+$/, "");
      const newMapId = `WH-UP-${Date.now().toString().slice(-4)}`;
      const newMap = {
        id: newMapId,
        name: cleanName,
        version: "v1.0 (Custom)",
        facility: "Uploaded Layout",
        area: "Custom Area",
        zonesCount: 4,
        checksum: `upload:${file.name}`,
        description: `User-uploaded warehouse floor layout: ${file.name}`,
        isUploaded: true
      };

      // The file's geometry is NOT parsed (no YAML/PGM occupancy-grid importer
      // exists). Activating it would label the generated WH-A layout with the
      // uploaded file's name, so the upload is only registered, not activated.
      newMap.geometryImported = false;
      MAPS_REGISTRY.push(newMap);

      if (mapFeedback) {
        mapFeedback.style.display = "block";
        mapFeedback.className = "upload-feedback-msg error";
        mapFeedback.textContent = `"${file.name}" registered, but map geometry import is not implemented yet. The simulation keeps using ${state.get("selectedMap") || "WH-A"}.`;
      }
    });

    // Robot Count Change
    const selRobotCount = overlay.querySelector("#sel-settings-robot-count");
    selRobotCount?.addEventListener("change", (e) => {
      const count = parseInt(e.target.value, 10);
      if (state.get("configLocked")) {
        // Store rejects the write mid-run; keep the control truthful.
        e.target.value = String(state.get("robotCount"));
        e.target.title = "Robot count is locked while a run is active.";
        return;
      }
      state.set("robotCount", count);
    });

    // Real-time synchronization if robot count is cycled on the first screen while settings is open
    const unsubRobotCount = state.subscribe("robotCount", (count) => {
      if (selRobotCount && selRobotCount.value !== String(count)) {
        selRobotCount.value = String(count);
      }
    });

    // Auto Refresh Toggle
    const chkAutoRefresh = overlay.querySelector("#chk-settings-auto-refresh");
    chkAutoRefresh?.addEventListener("change", (e) => {
      const isAuto = e.target.checked;
      state.set("autoRefresh", isAuto);
      localStorage.setItem("nodex_auto_refresh", String(isAuto));
    });

    // Reset to Default
    const btnReset = overlay.querySelector("#btn-settings-reset");
    btnReset?.addEventListener("click", () => {
      state.set("theme", "dark");
      state.set("timeFormat", "24-hour");
      state.set("autoRefresh", true);
      if (!state.get("configLocked")) state.set("robotCount", 50);

      localStorage.setItem("nodex_theme", "dark");
      localStorage.setItem("nodex_time_format", "24-hour");
      localStorage.setItem("nodex_auto_refresh", "true");
      localStorage.setItem("nodex_robot_count", "50");
      localStorage.setItem("nodex_fleet_size", "50");

      // Update UI elements in popup
      themeButtons.forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-val") === "dark");
      });
      timeButtons.forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-val") === "24-hour");
      });
      if (chkAutoRefresh) chkAutoRefresh.checked = true;
      if (selRobotCount) selRobotCount.value = "50";

      const toast = overlay.querySelector("#settings-save-toast");
      if (toast) {
        toast.style.display = "flex";
        toast.innerHTML = "<span>&#10003; Defaults restored</span>";
        setTimeout(() => { if (toast) toast.style.display = "none"; }, 2500);
      }
    });

    // Save Changes Button
    const btnSave = overlay.querySelector("#btn-settings-save");
    btnSave?.addEventListener("click", () => {
      const activeThemeBtn = overlay.querySelector("#theme-toggle-group .pill-toggle-opt.active");
      const activeTimeBtn = overlay.querySelector("#time-toggle-group .pill-toggle-opt.active");
      const themeVal = activeThemeBtn?.getAttribute("data-val") || "dark";
      const timeVal = activeTimeBtn?.getAttribute("data-val") || "24-hour";
      const autoRefreshVal = chkAutoRefresh ? chkAutoRefresh.checked : true;
      const countVal = parseInt(selRobotCount?.value || "50", 10);

      localStorage.setItem("nodex_theme", themeVal);
      localStorage.setItem("nodex_time_format", timeVal);
      localStorage.setItem("nodex_auto_refresh", String(autoRefreshVal));
      localStorage.setItem("nodex_fleet_size", String(countVal));

      const toast = overlay.querySelector("#settings-save-toast");
      if (toast) {
        toast.style.display = "flex";
        toast.innerHTML = "<span>&#10003; Settings saved</span>";
        setTimeout(() => {
          if (toast) toast.style.display = "none";
          SettingsPopup.close();
        }, 1200);
      }
    });
  }
}
