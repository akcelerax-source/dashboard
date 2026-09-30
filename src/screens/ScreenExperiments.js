// ==========================================================================
// NODEX ACE - Screen 03: Analytics & Efficiency
//
// Every panel reads RECORDED runs (src/data/run-history.js) through
// src/data/analytics-selection.js; nothing is simulated, invented or zero-
// filled here. Two situations:
//   Scenario - the 14 scenarios, Centralized vs Decentralized vs NodeX ACE
//   Test     - the 12 ACE validation tests, NodeX ACE only
// plus one robot count (3 / 10 / 50 / 100).
//
//   Recorded Run          efficiency (NFEI v2.0, 100 = Centralized reference)
//                         per row and system + overall (geometric mean);
//                         legacy NEEI v1.1 shown beside each value
//   Key Performance       metrics of ONE scenario/test (own selector)
//   System Comparison     bars of the Key Performance selection
//   Fleet Scale           overall data across 3 -> 10 -> 50 -> 100 robots
//   Insights              computed from the overall data
//   Recorded Runs         text-only PDF report per run
//   ACE Validation        A01-A12 status (passed / failed / not tested)
// ==========================================================================

import { state } from "../core/state.js";
import { getArchivedRuns } from "../data/run-history.js";
import { SCENARIOS, ACE_TESTS } from "../data/scenarios.js";
import {
  SUPPORTED_FLEET_SIZES, SYSTEMS, rowsForKind, efficiencyMatrix, overallEfficiency, overallNfei,
  kpiMetrics, fleetScaleOverall, FLEET_METRICS, aceValidationStatus, overallInsights, selectionTitle
} from "../data/analytics-selection.js";
import { NEEI_VERSION, describeNeei } from "../data/neei.js";
import { NFEI_VERSION, describeNfei } from "../data/nfei.js";
import { runReportPdf, analyticsReportPdf, downloadPdf } from "../data/pdf-report.js";

const SYSTEM_COLORS = { centralized: "#94A3B8", decentralized: "#0077FF", ace: "#10B981" };
const SYSTEM_SHORT = { centralized: "Centralized", decentralized: "Decentralized", ace: "NodeX ACE" };
const SYSTEM_FULL = { centralized: "Centralized", decentralized: "Decentralized", ace: "NodeX Edge AI ACE decentralized" };
const CHART_KPIS = ["nfei", "completion", "throughput", "makespan"];
const RUNS_PAGE_SIZE = 6;
const fmtVal = (v, unit) => (v === null || v === undefined ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)}${unit ? (unit === "%" ? "%" : " " + unit) : ""}`);
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export class ScreenExperiments {
  constructor(container) {
    this.container = container;
    const liveCode = state.get("selectedScenario");
    this.kind = ACE_TESTS.some(t => t.code === liveCode) ? "test" : "scenario";
    this.kpiCode = { scenario: SCENARIOS.some(s => s.code === liveCode) ? liveCode : SCENARIOS[0].code, test: ACE_TESTS.some(t => t.code === liveCode) ? liveCode : ACE_TESTS[0].code };
    const liveCount = Number(state.get("robotCount"));
    this.fleetSize = SUPPORTED_FLEET_SIZES.includes(liveCount) ? liveCount : 3;
    this.fleetMetric = this.kind === "test" ? "efficiency" : "nfei";
    this.kpiPicked = { scenario: false, test: false };
    this.runsPage = 0;
    this.render();
    this.bindOnce();
  }

  systems() {
    return this.kind === "test" ? ["ace"] : [...SYSTEMS];
  }

  model() {
    const matrix = efficiencyMatrix(this.kind, this.fleetSize);
    // Until the user picks one, the Key Performance selector follows the
    // first row that has a recorded run at this robot count.
    if (!this.kpiPicked[this.kind]) {
      const withData = matrix.find(r => Object.values(r.bySystem).some(Boolean));
      if (withData) this.kpiCode[this.kind] = withData.code;
    }
    return {
      kind: this.kind,
      fleetSize: this.fleetSize,
      matrix,
      overall: overallEfficiency(this.kind, this.fleetSize, matrix),
      overallNfei: overallNfei(this.kind, this.fleetSize, matrix),
      kpiCode: this.kpiCode[this.kind],
      kpiTitle: selectionTitle(this.kpiCode[this.kind]),
      kpis: kpiMetrics(this.kpiCode[this.kind], this.fleetSize),
      insights: overallInsights(this.kind, this.fleetSize),
      validation: aceValidationStatus(this.fleetSize),
      fleet: fleetScaleOverall(this.kind, this.kind === "test" ? "efficiency" : "nfei"),
      fleetMetricKey: this.kind === "test" ? "efficiency" : "nfei"
    };
  }

  render() {
    const m = this.model();
    this._model = m;
    const systems = this.systems();
    const kindLabel = this.kind === "test" ? "ACE Validation Test" : "Scenario";
    // Corrected index (NFEI v2.0) first; legacy NEEI v1.1 stays visible in small
    // print. ACE tests have no baseline, so NFEI is "—" there by design.
    const legacy = (e) => (e && typeof e.value === "number" ? `<span class="ae-muted" style="display:block;font-size:9px" title="Legacy NEEI v${NEEI_VERSION}: ${escapeHtml(describeNeei(e.neei))}">v${NEEI_VERSION}: ${e.value.toFixed(1)}%</span>` : "");
    const effCell = (row, sys) => {
      const e = row.bySystem[sys];
      if (!e) return `<td class="ae-num ae-muted" title="No ${this.fleetSize}-robot run recorded">—</td>`;
      const n = e.nfei;
      // ACE validation tests have no baseline architecture: show the ACE test
      // score (task-completion based, 0-100) instead of the comparative NFEI.
      if (this.kind === "test") {
        const v = e.value;
        const verdict = e.run?.experimentResult?.verdict || "";
        return typeof v === "number"
          ? `<td class="ae-num" title="${escapeHtml(`${e.run.runId} · verdict ${verdict || "not judged"} (feature criteria) · task completion score ${v.toFixed(1)}`)}"><span class="ae-eff ae-eff-${verdict === "PASS" ? "hi" : verdict === "FAIL" ? "lo" : "mid"}">${verdict || "—"}</span> <span class="ae-muted">${v.toFixed(0)}</span></td>`
          : `<td class="ae-num ae-muted" title="${escapeHtml(e.run.runId)}">—</td>`;
      }
      if (!n || n.value === null) {
        const label = n?.status === "INVALID" ? "INVALID"
          : n?.status === "NO_REFERENCE" ? `<span style="font-size:9px" title="Recorded. Efficiency needs a run of another system with the same scenario, fleet, seed and config.">needs peer run</span>` : "—";
        return `<td class="ae-num ae-muted" title="${escapeHtml(`${e.run.runId} · ${describeNfei(n)}`)}">${label}</td>`;
      }
      const tone = n.value >= 95 ? "hi" : n.value >= 75 ? "mid" : "lo";
      return `<td class="ae-num"><span class="ae-eff ae-eff-${tone}" title="${escapeHtml(`${e.run.runId} · ${describeNfei(n)}`)}">${n.value.toFixed(1)}</span></td>`;
    };
    const overallCell = (sys) => {
      const o = m.overallNfei[sys];
      const old = m.overall[sys];
      const oldTxt = "";
      if (this.kind === "test") {
        const verdicts = m.matrix.map(r => r.bySystem[sys]?.run?.experimentResult?.verdict).filter(Boolean);
        const pass = verdicts.filter(v => v === "PASS").length;
        return verdicts.length
          ? `<td class="ae-num ae-overall" title="ACE tests judged by feature criteria (PASS/FAIL/INCOMPLETE); no baseline architecture, so no NFEI">${pass}/${verdicts.length} PASS</td>`
          : `<td class="ae-num ae-overall ae-muted">—</td>`;
      }
      if (!o || o.value === null) return `<td class="ae-num ae-overall ae-muted" title="${this.kind === "test" ? "ACE tests: no baseline architecture, NFEI not applicable" : `No scenario with a valid NFEI for all three architectures${o?.invalid ? `; ${o.invalid} safety-INVALID run(s)` : ""}`}">—${oldTxt}</td>`;
      return `<td class="ae-num ae-overall" title="Geometric mean of NFEI over ${o.rows} of ${o.total} scenarios with a valid NFEI for every architecture (paired)${o.invalid ? `; ${o.invalid} safety-INVALID run(s) excluded, never averaged` : ""}">${o.value.toFixed(1)}${o.invalid ? ` <span title="safety-INVALID runs">(${o.invalid}!)</span>` : ""}${oldTxt}</td>`;
    };
    const runs = getArchivedRuns().filter(r => (r.runKind || (/^A\d/.test(r.scenarioCode || "") ? "test" : "scenario")) === this.kind);
    const pages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
    this.runsPage = Math.min(this.runsPage, pages - 1);
    const pageRuns = runs.slice(this.runsPage * RUNS_PAGE_SIZE, (this.runsPage + 1) * RUNS_PAGE_SIZE);
    const badge = (st) => ({
      PASSED: `<span class="badge-pass">PASSED</span>`,
      FAILED: `<span class="badge-fail">FAILED</span>`,
      INCOMPLETE: `<span class="badge-blocked">INCOMPLETE</span>`,
      NOT_TESTED: `<span class="badge-notrun">NOT TESTED</span>`
    })[st];

    this.container.innerHTML = `
      <div class="ae-root">
        <header class="ae-header">
          <div>
            <h1 class="analytics-main-title">Analytics &amp; Efficiency</h1>
            <p class="analytics-subtitle" title="NFEI v${NFEI_VERSION} = 100 x weighted geometric mean of ratios to the best value among the paired systems with the same scenario, fleet, seed, map and duration limit: throughput (0.6), allocation latency (0.2), messages per completed task (0.2). Runs with a collision, obstacle intrusion or boundary violation are INVALID. Not an ISO/IEEE metric.">Measured comparison of recorded simulation runs. Efficiency = NodeX Fleet Efficiency Index (NFEI v${NFEI_VERSION}), a project-specific composite of recognized KPIs (0-100; x task completion ratio, so 100 only for a run that finished all tasks and was best on every KPI among the paired systems).</p>
          </div>
          <div class="ae-filters">
            <span class="ae-filter-label">Situation</span>
            <div class="ae-seg" role="tablist">
              <button class="ae-seg-btn ${this.kind === "scenario" ? "active" : ""}" data-kind="scenario">Scenario</button>
              <button class="ae-seg-btn ${this.kind === "test" ? "active" : ""}" data-kind="test">Test</button>
            </div>
            <span class="ae-filter-label">Robot count</span>
            <select class="analytics-select-compact" id="ae-fleet">
              ${SUPPORTED_FLEET_SIZES.map(n => `<option value="${n}" ${n === this.fleetSize ? "selected" : ""}>${n} robots</option>`).join("")}
            </select>
            <button class="btn-export-report" id="ae-export" title="Download this analytics view as a PDF report">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><polyline points="9 15 12 18 15 15"></polyline></svg>
              <span>Export PDF</span>
            </button>
          </div>
        </header>

        <div class="ae-grid-top">
          <section class="analytics-panel-card ae-card">
            <div class="ae-card-head">
              <span class="panel-title-text">Recorded Run · ${this.fleetSize} robots</span>
              <span class="ae-hint" title="Latest recorded ${this.fleetSize}-robot run per ${kindLabel.toLowerCase()} and system. Click a row to show its key metrics.">NFEI v${NFEI_VERSION}</span>
            </div>
            <div class="ae-scroll">
              <table class="ae-table ae-matrix">
                <colgroup><col class="ae-col-name">${systems.map(() => `<col class="ae-col-sys">`).join("")}</colgroup>
                <thead><tr><th>${kindLabel}</th>${systems.map(s => `<th class="ae-num" style="color:${SYSTEM_COLORS[s]}">${SYSTEM_SHORT[s]}</th>`).join("")}</tr></thead>
                <tbody>
                  ${m.matrix.map(row => `
                    <tr class="ae-row ${row.code === m.kpiCode ? "selected" : ""}" data-code="${row.code}">
                      <td class="ae-name"><span class="ae-code">${row.code}</span>${escapeHtml(row.name)}</td>
                      ${systems.map(s => effCell(row, s)).join("")}
                    </tr>`).join("")}
                </tbody>
                <tfoot>
                  <tr>
                    <td class="ae-overall-label" title="NFEI: geometric mean over the rows every architecture recorded with a valid NFEI (paired). Legacy NEEI: arithmetic mean, * = partial.">NodeX Fleet Efficiency Index (overall)</td>
                    ${systems.map(overallCell).join("")}
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section class="analytics-panel-card ae-card">
            <div class="ae-card-head">
              <span class="panel-title-text">Key Performance Metrics · ${this.fleetSize} robots</span>
              <select class="analytics-select-compact ae-kpi-select" id="ae-kpi-code" title="${kindLabel} whose metrics are shown">
                ${rowsForKind(this.kind).map(d => `<option value="${d.code}" ${d.code === m.kpiCode ? "selected" : ""}>${d.code} · ${escapeHtml(d.name)}</option>`).join("")}
              </select>
            </div>
            <div class="ae-scroll">
              <table class="ae-table">
                <thead><tr><th>Metric</th>${systems.map(s => `<th class="ae-num" style="color:${SYSTEM_COLORS[s]}">${SYSTEM_SHORT[s]}</th>`).join("")}</tr></thead>
                <tbody>
                  ${m.kpis.map(k => `
                    <tr>
                      <td class="ae-name">${k.label}${k.unit ? ` <span class="ae-unit">(${k.unit})</span>` : ""}</td>
                      ${systems.map(s => `<td class="ae-num ${k.best === s ? "ae-best" : ""} ${k.values[s] === null ? "ae-muted" : ""}">${fmtVal(k.values[s], k.unit === "%" ? "%" : "")}</td>`).join("")}
                    </tr>`).join("")}
                </tbody>
              </table>
              ${m.kpis.every(k => systems.every(s => k.values[s] === null)) ? `<div class="ae-empty">No ${this.fleetSize}-robot run recorded for ${escapeHtml(m.kpiTitle)}. Run it on the Simulation screen.</div>` : ""}
            </div>
          </section>

          <div class="ae-chart-col">
            <section class="analytics-panel-card ae-card">
              <div class="ae-card-head">
                <span class="panel-title-text">System Comparison · ${m.kpiCode}</span>
                <span class="ae-legend">${systems.map(s => `<span><i style="background:${SYSTEM_COLORS[s]}"></i>${SYSTEM_SHORT[s]}</span>`).join("")}</span>
              </div>
              <div class="ae-chart"><canvas id="ae-canvas-comparison"></canvas><div class="ae-tip" id="ae-tip-comparison"></div></div>
            </section>
            <section class="analytics-panel-card ae-card">
              <div class="ae-card-head">
                <span class="panel-title-text">Fleet Scale Performance</span>
                <select class="analytics-select-compact" id="ae-fleet-metric" title="Overall data of the situation at each robot count">
                  ${Object.entries(FLEET_METRICS).map(([k, d]) => `<option value="${k}" ${k === this.fleetMetric ? "selected" : ""}>${d.label}${d.unit ? ` (${d.unit})` : ""}</option>`).join("")}
                </select>
              </div>
              <div class="ae-chart"><canvas id="ae-canvas-fleet"></canvas><div class="ae-tip" id="ae-tip-fleet"></div></div>
            </section>
          </div>
        </div>

        <div class="ae-grid-bottom">
          <section class="analytics-panel-card ae-card">
            <div class="ae-card-head"><span class="panel-title-text">Insights (overall data)</span><span class="ae-hint">${this.fleetSize} robots</span></div>
            <div class="ae-scroll ae-insights">
              ${m.insights.map(i => `<div class="ae-insight ae-tone-${i.tone}"><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.text)}</p></div>`).join("")}
            </div>
          </section>

          <section class="analytics-panel-card ae-card">
            <div class="ae-card-head">
              <span class="panel-title-text">Recorded Simulation Runs</span>
              <span class="ae-hint">${runs.length} ${this.kind === "test" ? "ACE test" : "scenario"} run${runs.length === 1 ? "" : "s"} · PDF report</span>
            </div>
            <div class="ae-scroll ae-runs">
              ${pageRuns.length ? pageRuns.map(run => {
                const p = run.performance || {};
                const verdict = run.experimentResult?.verdict || run.verdict || "—";
                return `
                <div class="ae-run">
                  <div class="ae-run-text">
                    <div class="ae-run-title">${run.scenarioCode} · ${escapeHtml(run.systemModeLabel)} · ${run.fleetSize} robots</div>
                    <div class="ae-run-meta">${run.runId} · ${p.tasksCompleted ?? "—"}/${p.tasksTotal ?? "—"} tasks · ${p.completionTimeSeconds != null ? p.completionTimeSeconds + " s" : (run.endReason || run.status)} · ${verdict}</div>
                  </div>
                  <button class="btn-rec-download" data-pdf-run="${run.runId}" title="Download the run report (PDF)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    <span>PDF</span>
                  </button>
                </div>`;
              }).join("") : `<div class="ae-empty">No ${this.kind === "test" ? "ACE validation test" : "scenario"} run recorded yet. Finish or stop a run on the Simulation screen to record it here.</div>`}
            </div>
            <div class="ae-pager">
              <button class="history-page-btn" data-runs-step="-1" ${this.runsPage === 0 ? "disabled" : ""}>&lsaquo; Prev</button>
              <span class="history-page-label">Page ${this.runsPage + 1} / ${pages}</span>
              <button class="history-page-btn" data-runs-step="1" ${this.runsPage >= pages - 1 ? "disabled" : ""}>Next &rsaquo;</button>
            </div>
          </section>

          <section class="analytics-panel-card ae-card">
            <div class="ae-card-head">
              <span class="panel-title-text">ACE Feature Validation Tests</span>
              <span class="ae-hint">${m.validation.filter(v => v.status === "PASSED").length}/${m.validation.length} passed · ${this.fleetSize} robots</span>
            </div>
            <div class="ae-scroll">
              <table class="ae-table ae-validation">
                <tbody>
                  ${m.validation.map(v => `
                    <tr class="ae-test-row" data-test="${v.code}" title="${v.run ? "Show the measured acceptance criteria" : "Run this test from the Simulation screen (ACE Tests tab) to validate it"}">
                      <td class="ae-code-col">${v.code}</td>
                      <td class="ae-name">${escapeHtml(v.name)}</td>
                      <td class="ae-num">${badge(v.status)}</td>
                    </tr>`).join("")}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    `;
    requestAnimationFrame(() => this.drawCharts());
  }

  drawCharts() {
    this.drawSystemComparisonChart();
    this.drawFleetScaleChart();
  }

  /** Canvas sized to its box. Returns { ctx, w, h, isLight }. */
  _prepCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const box = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(160, box.width), h = Math.max(90, box.height);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, isLight: document.body.classList.contains("theme-light") };
  }

  _emptyChart(ctx, w, h, isLight, title, sub) {
    ctx.fillStyle = isLight ? "#475569" : "#94A3B8";
    ctx.font = "bold 11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(title, w / 2, h / 2 - 4);
    ctx.fillStyle = isLight ? "#94A3B8" : "#64748B";
    ctx.font = "9.5px JetBrains Mono, monospace";
    ctx.fillText(sub, w / 2, h / 2 + 14);
  }

  _bindTooltip(canvas, tipId, hits) {
    const tip = this.container.querySelector(`#${tipId}`);
    canvas._hits = hits;
    if (!tip || canvas._tooltipBound) return;
    canvas._tooltipBound = true;
    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const hit = (canvas._hits || []).find(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
      if (!hit) { tip.style.display = "none"; return; }
      tip.textContent = hit.text;
      tip.style.display = "block";
      tip.style.left = `${Math.max(0, Math.min(x + 10, r.width - tip.offsetWidth - 4))}px`;
      tip.style.top = `${Math.max(0, y - 24)}px`;
    });
    canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }

  /** Bars of the Key Performance selection (each metric on its own scale). */
  drawSystemComparisonChart() {
    const canvas = this.container.querySelector("#ae-canvas-comparison");
    if (!canvas) return;
    const { ctx, w, h, isLight } = this._prepCanvas(canvas);
    const systems = this.systems();
    const groups = this._model.kpis.filter(k => CHART_KPIS.includes(k.key));
    if (!groups.some(g => systems.some(s => g.values[s] !== null))) {
      this._emptyChart(ctx, w, h, isLight, "No recorded run for this selection", `${this._model.kpiTitle} · ${this.fleetSize} robots`);
      this._bindTooltip(canvas, "ae-tip-comparison", []);
      return;
    }
    const padL = 8, padR = 8, padT = 16, padB = 28;
    const chartW = w - padL - padR, chartH = h - padT - padB;
    ctx.strokeStyle = isLight ? "#E2E8F0" : "#1A2A47";
    ctx.beginPath(); ctx.moveTo(padL, padT + chartH); ctx.lineTo(w - padR, padT + chartH); ctx.stroke();
    const hits = [];
    const groupW = chartW / groups.length;
    const barW = Math.max(8, Math.min(28, (groupW - 20) / systems.length));
    groups.forEach((g, gi) => {
      const vals = systems.map(s => g.values[s]).filter(v => v !== null);
      const scaleMax = g.unit === "%" ? 100 : Math.max(1, ...vals) * 1.15;
      const startX = padL + gi * groupW + (groupW - (barW * systems.length + 3 * (systems.length - 1))) / 2;
      systems.forEach((sys, si) => {
        const v = g.values[sys];
        const x = startX + si * (barW + 3);
        ctx.font = "8px JetBrains Mono, monospace";
        ctx.textAlign = "center";
        if (v === null) {
          ctx.fillStyle = isLight ? "#94A3B8" : "#64748B";
          ctx.fillText("—", x + barW / 2, padT + chartH - 3);
          hits.push({ x0: x, x1: x + barW, y0: padT, y1: padT + chartH, text: `${SYSTEM_SHORT[sys]} · ${g.label}: — (no recorded run)` });
          return;
        }
        const bh = Math.max(1, (Math.min(v, scaleMax) / scaleMax) * chartH);
        const y = padT + chartH - bh;
        ctx.fillStyle = SYSTEM_COLORS[sys];
        ctx.fillRect(x, y, barW, bh);
        ctx.fillStyle = isLight ? "#334155" : "#CBD5E1";
        ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), x + barW / 2, y - 3);
        hits.push({ x0: x, x1: x + barW, y0: y - 10, y1: padT + chartH, text: `${SYSTEM_SHORT[sys]} · ${g.label}: ${fmtVal(v, g.unit)}${g.best === sys ? " (best)" : ""}` });
      });
      ctx.fillStyle = isLight ? "#475569" : "#8A9BB8";
      ctx.font = "9px Inter, sans-serif";
      ctx.textAlign = "center";
      const cx = padL + gi * groupW + groupW / 2;
      ctx.fillText(g.short || g.label, cx, h - 14);
      if (g.unit) ctx.fillText(`(${g.unit})`, cx, h - 3);
    });
    this._bindTooltip(canvas, "ae-tip-comparison", hits);
  }

  /** Overall data at 3 -> 10 -> 50 -> 100 robots; points only where recorded. */
  drawFleetScaleChart() {
    const canvas = this.container.querySelector("#ae-canvas-fleet");
    if (!canvas) return;
    const { ctx, w, h, isLight } = this._prepCanvas(canvas);
    const metric = FLEET_METRICS[this.fleetMetric] || FLEET_METRICS.nfei;
    const data = fleetScaleOverall(this.kind, this.fleetMetric);
    const systems = this.systems();
    const all = data.flatMap(d => systems.map(s => d[s])).filter(v => v !== null);
    if (!all.length) {
      this._emptyChart(ctx, w, h, isLight, "No recorded runs yet", `${this.kind === "test" ? "ACE tests" : "Scenarios"} at 3 / 10 / 50 / 100 robots`);
      this._bindTooltip(canvas, "ae-tip-fleet", []);
      return;
    }
    const yMax = metric.max || Math.max(1, ...all) * 1.15;
    const padL = 34, padR = 16, padT = 10, padB = 20;
    const chartW = w - padL - padR, chartH = h - padT - padB;
    const xAt = (i) => padL + (i / (data.length - 1)) * chartW;
    const yAt = (v) => padT + chartH - (Math.min(v, yMax) / yMax) * chartH;
    ctx.strokeStyle = isLight ? "#E2E8F0" : "#1A2A47";
    ctx.fillStyle = "#64748B";
    ctx.font = "8px JetBrains Mono, monospace";
    ctx.textAlign = "right";
    for (let k = 0; k <= 4; k++) {
      const val = (yMax * k) / 4, y = yAt(val);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(val >= 100 ? Math.round(val).toString() : val.toFixed(0), padL - 4, y + 3);
    }
    const selIdx = data.findIndex(d => d.fleetSize === this.fleetSize);
    if (selIdx >= 0) {
      ctx.fillStyle = isLight ? "rgba(6,182,212,0.08)" : "rgba(6,182,212,0.10)";
      ctx.fillRect(xAt(selIdx) - 9, padT, 18, chartH);
    }
    const hits = [];
    for (const sys of systems) {
      ctx.strokeStyle = SYSTEM_COLORS[sys];
      ctx.lineWidth = 1.8;
      let prev = null;
      data.forEach((d, i) => {
        const v = d[sys];
        if (v === null) { prev = null; return; }
        if (prev) { ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(xAt(i), yAt(v)); ctx.stroke(); }
        prev = { x: xAt(i), y: yAt(v) };
      });
      data.forEach((d, i) => {
        const v = d[sys];
        if (v === null) return;
        ctx.fillStyle = SYSTEM_COLORS[sys];
        ctx.beginPath(); ctx.arc(xAt(i), yAt(v), 3, 0, Math.PI * 2); ctx.fill();
        hits.push({ x0: xAt(i) - 6, x1: xAt(i) + 6, y0: yAt(v) - 6, y1: yAt(v) + 6,
          text: `${SYSTEM_SHORT[sys]} · ${d.fleetSize} robots · ${metric.label}: ${fmtVal(v, metric.unit)} (${d.coverage[sys]} ${this.kind === "test" ? "tests" : "scenarios"})` });
      });
    }
    ctx.lineWidth = 1;
    ctx.fillStyle = isLight ? "#475569" : "#8A9BB8";
    ctx.textAlign = "center";
    data.forEach((d, i) => ctx.fillText(`${d.fleetSize} robots`, xAt(i), h - 5));
    this._bindTooltip(canvas, "ae-tip-fleet", hits);
  }

  /** Delegated listeners + subscriptions, bound once (render replaces the DOM). */
  bindOnce() {
    this.container.addEventListener("click", (e) => {
      const seg = e.target.closest(".ae-seg-btn");
      if (seg) {
        this.kind = seg.dataset.kind;
        if (this.kind === "test" && this.fleetMetric === "nfei") this.fleetMetric = "efficiency";
        this.runsPage = 0;
        this.render();
        return;
      }
      const row = e.target.closest(".ae-row");
      if (row) {
        this.kpiCode[this.kind] = row.dataset.code;
        this.kpiPicked[this.kind] = true;
        this.render();
        return;
      }
      const pdfBtn = e.target.closest("[data-pdf-run]");
      if (pdfBtn) {
        const run = getArchivedRuns().find(r => r.runId === pdfBtn.dataset.pdfRun);
        if (run) downloadPdf(runReportPdf(run), `NodeX_${run.scenarioCode}_${run.systemMode}_${run.fleetSize}robots_${run.runId}.pdf`);
        return;
      }
      const step = e.target.closest("[data-runs-step]");
      if (step && !step.disabled) {
        this.runsPage += Number(step.dataset.runsStep) || 0;
        this.render();
        return;
      }
      if (e.target.closest("#ae-export")) {
        const m = this._model;
        downloadPdf(analyticsReportPdf(m), `NodeX_Analytics_${m.kind}_${m.fleetSize}robots.pdf`);
        return;
      }
      const test = e.target.closest(".ae-test-row");
      if (test) this.openTestModal(test.dataset.test);
    });
    this.container.addEventListener("change", (e) => {
      if (e.target.id === "ae-fleet") { this.fleetSize = Number(e.target.value); this.render(); }
      else if (e.target.id === "ae-kpi-code") { this.kpiCode[this.kind] = e.target.value; this.kpiPicked[this.kind] = true; this.render(); }
      else if (e.target.id === "ae-fleet-metric") { this.fleetMetric = e.target.value; this.drawFleetScaleChart(); }
    });
    window.addEventListener("resize", () => {
      if (state.get("activeTab") === "experiments") this.drawCharts();
    });
    state.subscribe("theme", () => this.drawCharts());
    state.subscribe("activeTab", (tab) => { if (tab === "experiments") this.render(); });
    // A newly archived run changes every panel.
    state.subscribe("runHistoryVersion", () => this.render());
  }

  /** Measured acceptance criteria of the latest recorded run of one ACE test. */
  openTestModal(code) {
    const v = aceValidationStatus(this.fleetSize).find(x => x.code === code);
    const def = ACE_TESTS.find(t => t.code === code);
    const modal = document.getElementById("modal-container");
    if (!v || !def || !modal) return;
    const rows = v.criteria.length
      ? v.criteria.map(c => `<tr><td>${escapeHtml(c.name)}</td><td class="ae-num">${escapeHtml(c.required)}</td><td class="ae-num">${escapeHtml(c.actual)}</td><td class="ae-num">${c.pass ? '<span class="badge-pass">PASS</span>' : '<span class="badge-fail">FAIL</span>'}</td></tr>`).join("")
      : `<tr><td colspan="4" class="ae-muted">Not tested at ${this.fleetSize} robots. Select NodeX Edge AI ACE decentralized, open the ACE Tests tab on the Simulation screen, choose ${code} and start the run.</td></tr>`;
    modal.innerHTML = `
      <div class="modal-backdrop" id="ae-test-backdrop">
        <div class="modal-dialog explain-modal-dialog" role="dialog" aria-modal="true" style="max-width: 640px;">
          <div class="modal-header">
            <div class="modal-title-wrap"><h2 class="modal-title">${code} · ${escapeHtml(def.name)}</h2></div>
            <button class="modal-close-btn" id="ae-test-close">&times;</button>
          </div>
          <div class="modal-body" style="display:flex; flex-direction:column; gap:10px; font-size:11.5px;">
            <p style="margin:0; line-height:1.45;">${escapeHtml(def.description)}</p>
            <p style="margin:0; line-height:1.45; color: var(--text-muted);">Stimulus: ${escapeHtml(def.triggerCondition)}</p>
            <table class="ae-table"><thead><tr><th>Criterion</th><th class="ae-num">Required</th><th class="ae-num">Measured</th><th class="ae-num">Result</th></tr></thead><tbody>${rows}</tbody></table>
            ${v.run ? `<p style="margin:0; color: var(--text-muted);">Run ${v.run.runId} · ${v.run.fleetSize} robots · ${v.run.endReason || v.run.status}</p>` : ""}
          </div>
        </div>
      </div>`;
    const close = () => { modal.innerHTML = ""; };
    modal.querySelector("#ae-test-close")?.addEventListener("click", close);
    modal.querySelector("#ae-test-backdrop")?.addEventListener("click", (e) => { if (e.target.id === "ae-test-backdrop") close(); });
  }
}
