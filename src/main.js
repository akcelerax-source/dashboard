// ==========================================================================
// NODEX ACE - Main Application Bootstrap
// ==========================================================================

import { state } from "./core/state.js";
import { simEngine } from "./core/sim-engine.js";
import { ShellHeader } from "./components/ShellHeader.js";
import { FloatingNav } from "./components/FloatingNav.js";
import { ScreenOperations } from "./screens/ScreenOperations.js";
import { ScreenCoordination } from "./screens/ScreenCoordination.js";
import { ScreenControl } from "./screens/ScreenControl.js";
import { ScreenExperiments } from "./screens/ScreenExperiments.js";
import { scenarioEngine } from "./core/scenario-engine.js";
import "./components/HitlModal.js";
import { startSharedSync } from "./core/shared-sync.js";
import { sweepRunner } from "./core/sweep-runner.js";

function showErrorBanner(message) {
  let banner = document.getElementById("app-error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "app-error-banner";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#7f1d1d;color:#fecaca;padding:8px 16px;font:12px monospace;white-space:pre-wrap;max-height:40vh;overflow:auto;";
    document.body.prepend(banner);
  }
  banner.textContent += message + "\n";
}

document.addEventListener("DOMContentLoaded", () => {
  console.log("Initializing NODEX ACE Fleet Dashboard - SIH 2026...");
  startSharedSync();

  try {
    // Connect scenarioEngine with simEngine instance
    scenarioEngine.setSimEngine(simEngine);
  } catch (err) {
    console.error("scenarioEngine.setSimEngine error:", err);
  }

  // 1. Mount Global Header
  try {
    const headerContainer = document.getElementById("global-header");
    if (headerContainer) {
      new ShellHeader(headerContainer);
    }
  } catch (err) {
    console.error("ShellHeader error:", err);
    showErrorBanner("ShellHeader error: " + err.message + "\n" + err.stack);
  }

  // 2. Mount Floating Navigation Dock & Sub-Bar
  try {
    const dockContainer = document.getElementById("floating-dock-container");
    if (dockContainer) {
      new FloatingNav(dockContainer);
    }
  } catch (err) {
    console.error("FloatingNav error:", err);
    showErrorBanner("FloatingNav error: " + err.message + "\n" + err.stack);
  }

  // 3. Mount All 4 Screens
  try {
    const opsMount = document.getElementById("screen-operations");
    if (opsMount) new ScreenOperations(opsMount);
  } catch (err) {
    console.error("ScreenOperations error:", err);
    showErrorBanner("ScreenOperations error: " + err.message + "\n" + err.stack);
  }

  try {
    const coordMount = document.getElementById("screen-coordination");
    if (coordMount) new ScreenCoordination(coordMount);
  } catch (err) {
    console.error("ScreenCoordination error:", err);
    showErrorBanner("ScreenCoordination error: " + err.message);
  }

  try {
    const ctrlMount = document.getElementById("screen-control");
    if (ctrlMount) new ScreenControl(ctrlMount);
  } catch (err) {
    console.error("ScreenControl error:", err);
    showErrorBanner("ScreenControl error: " + err.message);
  }

  try {
    const expMount = document.getElementById("screen-experiments");
    if (expMount) new ScreenExperiments(expMount);
  } catch (err) {
    console.error("ScreenExperiments error:", err);
    showErrorBanner("ScreenExperiments error: " + err.message);
  }

  // 4. Render Global Footer
  try {
    const footerMount = document.getElementById("global-footer");
    if (footerMount) {
      renderFooter(footerMount);
    }
  } catch (err) {
    console.error("renderFooter error:", err);
  }

  console.log("NODEX ACE Simulation Engine online (100 Hz ready, idle).");
});

function renderFooter(container) {
  const tickRate = state.get("tickRate") || 100;
  const runId = state.get("runId") || "—";
  const seed = state.get("seed") || 18427;
  const isRunning = state.get("simRunning") !== false;

  container.innerHTML = `
    <div class="footer-left">
      <span class="footer-brand">NODEX</span>
      <span class="footer-version">v0.9.3</span>
    </div>

    <div class="footer-center">
      <span>Autonomous Mobility for a More Productive World</span>
    </div>

    <div class="footer-right">
      <div class="footer-sim-status">
        <span class="footer-sim-dot ${isRunning ? 'running' : 'paused'}"></span>
        <span id="footer-sim-status-text">${isRunning ? 'Simulation Running' : 'Simulation Paused'}</span>
      </div>
      <span>Tick Rate <strong style="color: var(--text-primary); font-family: var(--font-mono);">${tickRate} Hz</strong></span>
      <span>Run ID <strong id="footer-run-id" style="color: var(--text-primary); font-family: var(--font-mono);">${runId}</strong></span>
      <span>Seed <strong style="color: var(--text-primary); font-family: var(--font-mono);">${seed}</strong></span>
    </div>
  `;

  // Footer shows the authoritative run ID (it used to render once, with a
  // hard-coded "EXP-042" fallback, and never update).
  state.subscribe("runId", (id) => {
    const el = document.getElementById("footer-run-id");
    if (el) el.textContent = id || "—";
  });

  state.subscribe("simRunning", (running) => {
    const dot = container.querySelector(".footer-sim-dot");
    const text = document.getElementById("footer-sim-status-text");
    if (dot) dot.className = `footer-sim-dot ${running ? 'running' : 'paused'}`;
    if (text) text.textContent = running ? "Simulation Running" : "Simulation Paused";
  });
}

// Expose sweep runner for testing (call window.startSweep() in console)
if (typeof window !== "undefined") {
  window.startSweep = () => sweepRunner.runFullSweep().catch(e => console.error("Sweep failed:", e));
  window.sweepProgress = () => sweepRunner.getProgress();
}
