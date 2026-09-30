// ==========================================================================
// NODEX - Text-only PDF reports (no dependency).
// A small PDF 1.4 writer (Helvetica / Helvetica-Bold, A4, automatic page
// breaks and word wrap) plus the two report builders used by Analytics:
//   runReportPdf(run)          one recorded simulation run / ACE test
//   analyticsReportPdf(model)  the Analytics & Efficiency selection
// Reports contain readable results only: no code, JSON or debug payloads.
// ==========================================================================

import { SYSTEMS, KPI_DEFS, neeiForSelection } from "./analytics-selection.js";
import { describeNeei, computeNeei, neeiReference } from "./neei.js";
import { nfeiForRun, describeNfei, NFEI_VERSION } from "./nfei.js";
import { getArchivedRuns } from "./run-history.js";

const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;
const SYSTEM_LABELS = { centralized: "Centralized", decentralized: "Decentralized", ace: "NodeX Edge AI ACE decentralized" };

/** Restricts text to the PDF standard (WinAnsi) character set. */
function clean(text) {
  return String(text ?? "")
    .replace(/[—–]/g, "-").replace(/[·•]/g, "-")
    .replace(/→/g, "->").replace(/←/g, "<-").replace(/≤/g, "<=").replace(/≥/g, ">=")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/×/g, "x").replace(/…/g, "...")
    .replace(/[^\x20-\x7E]/g, "");
}

const esc = (s) => clean(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

class PdfWriter {
  constructor() {
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE_H - MARGIN;
  }

  ensure(h) {
    if (this.y - h < MARGIN) this.newPage();
  }

  /** Word-wrapped text; Helvetica average glyph width ~0.52 em. */
  text(str, { size = 10, bold = false, indent = 0, gap = 3, color = null } = {}) {
    const maxChars = Math.max(10, Math.floor((PAGE_W - 2 * MARGIN - indent) / (size * 0.52)));
    const words = clean(str).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > maxChars && line) { lines.push(line); line = w; }
      else line = (line + " " + w).trim();
    }
    if (line || !lines.length) lines.push(line);
    for (const l of lines) {
      this.ensure(size + gap);
      this.y -= size + gap;
      const rgb = color ? `${color.join(" ")} rg ` : "0.1 0.12 0.16 rg ";
      this.ops.push(`BT ${rgb}/${bold ? "F2" : "F1"} ${size} Tf ${MARGIN + indent} ${this.y.toFixed(1)} Td (${esc(l)}) Tj ET`);
    }
  }

  heading(str) {
    this.ensure(30);
    this.y -= 8;
    this.text(str, { size: 13, bold: true, color: [0.0, 0.27, 0.55] });
    this.ops.push(`0.75 0.8 0.86 RG 0.6 w ${MARGIN} ${(this.y - 3).toFixed(1)} m ${PAGE_W - MARGIN} ${(this.y - 3).toFixed(1)} l S`);
    this.y -= 6;
  }

  /** Simple table: columns share the width by `widths` (fractions). */
  table(headers, rows, widths) {
    const total = PAGE_W - 2 * MARGIN;
    const xs = [];
    let acc = MARGIN;
    for (const w of widths) { xs.push(acc); acc += w * total; }
    const cell = (vals, bold) => {
      this.ensure(14);
      this.y -= 13;
      vals.forEach((v, i) => {
        const maxChars = Math.max(3, Math.floor((widths[i] * total - 4) / (9 * 0.52)));
        let s = clean(v);
        if (s.length > maxChars) s = s.slice(0, maxChars - 2) + "..";
        this.ops.push(`BT 0.1 0.12 0.16 rg /${bold ? "F2" : "F1"} 9 Tf ${xs[i].toFixed(1)} ${this.y.toFixed(1)} Td (${esc(s)}) Tj ET`);
      });
    };
    cell(headers, true);
    this.ops.push(`0.8 0.84 0.9 RG 0.5 w ${MARGIN} ${(this.y - 3).toFixed(1)} m ${PAGE_W - MARGIN} ${(this.y - 3).toFixed(1)} l S`);
    this.y -= 2;
    for (const r of rows) cell(r, false);
    this.y -= 4;
  }

  space(h = 6) { this.y -= h; }

  /** Serialises to a PDF byte string (ASCII only). */
  build(title) {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds = [];
    this.pages.forEach((ops, i) => {
      const footer = `BT 0.45 0.5 0.58 rg /F1 8 Tf ${MARGIN} 28 Td (${esc(`${title} - page ${i + 1} of ${this.pages.length}`)}) Tj ET`;
      const stream = [...ops, footer].join("\n");
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    const info = add(`<< /Title (${esc(title)}) /Producer (NodeX ACE dashboard) >>`);
    let out = "%PDF-1.4\n";
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return out;
  }
}

const fmt = (v, unit = "") => (v === null || v === undefined || v === "" ? "-" : `${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : v}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`);
const clock = (s) => {
  if (typeof s !== "number") return "-";
  const t = Math.floor(s);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** Readable report of one recorded run (scenario run or ACE validation test). */
export function runReportPdf(run) {
  const w = new PdfWriter();
  const isTest = run.runKind === "test";
  const p = run.performance || {};
  const s = run.summary || {};
  w.text(isTest ? "NodeX ACE Validation Test Report" : "NodeX Simulation Run Report", { size: 18, bold: true, color: [0.02, 0.2, 0.42] });
  w.text(`${run.scenarioName} - ${run.systemModeLabel} - ${run.fleetSize} robots`, { size: 11 });
  w.space(4);

  w.heading("Run information");
  w.table(["Field", "Value"], [
    ["Run ID", run.runId || run.id],
    [isTest ? "ACE validation test" : "Scenario", `${run.scenarioCode} - ${run.scenarioName}`],
    ["System", run.systemModeLabel],
    ["Robot count", run.fleetSize],
    ["Started", run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"],
    ["Simulated time", `${fmt(p.simTimeSeconds, "s")} (${clock(p.simTimeSeconds)})`],
    ["End reason", run.endReason || run.status || "-"],
    ["Verdict", run.verdict || run.experimentResult?.verdict || "-"],
    ["Seed / map profile", `${run.seed ?? "-"} / ${run.mapProfile || "-"}`]
  ], [0.3, 0.7]);

  w.heading("Performance");
  w.table(["Metric", "Value"], [
    ["Tasks completed", `${fmt(p.tasksCompleted)} of ${fmt(p.tasksTotal)} (${fmt(p.completionPct, "%")})`],
    ["All-tasks completion time", fmt(p.completionTimeSeconds, "s")],
    ["Throughput", fmt(p.throughputPerHour, "tasks/hr")],
    ["Average task time", s.avgTaskCompletion ?? "-"],
    ["Average allocation latency", s.allocationLatency ?? "-"],
    ["Robot-robot collisions", fmt(s.collisions)],
    ["Near-collisions", fmt(s.nearCollisions)],
    ["Rack / zone intrusions", fmt(s.obstacleIntrusions)],
    ["Robot failures", fmt(s.robotFailures)],
    ["Re-allocated tasks (completed)", `${fmt(p.reallocatedTasks)} (${fmt(p.reallocatedCompleted)})`]
  ], [0.45, 0.55]);

  // Reference set: this run plus the latest run of every other eligible
  // architecture for the same scenario / test and robot count.
  const sel = neeiForSelection(run.scenarioCode, run.fleetSize);
  const refRuns = [run, ...Object.values(sel.runs).filter(r => r && r.systemMode !== run.systemMode)];
  const reference = neeiReference(refRuns);
  const neei = computeNeei(run, reference);
  const nfei = nfeiForRun(run, getArchivedRuns());
  w.heading(`Efficiency (NodeX Fleet Efficiency Index v${NFEI_VERSION}, project-specific composite)`);
  w.text(`NFEI v${NFEI_VERSION}: ${nfei.value === null ? `- (${nfei.status})` : `${nfei.value} (0-100, 100 = best among paired systems)`}`, { bold: true });
  w.text(describeNfei(nfei), { size: 9 });
  w.text(isTest
    ? "ACE validation tests are evaluated for NodeX ACE only; no Centralized or Decentralized result applies."
    : `Reference set: this run and the latest recorded run of each other architecture for this scenario at ${run.fleetSize} robots (${reference.runCount} run${reference.runCount === 1 ? "" : "s"}).`, { size: 9 });

  const crit = run.experimentResult?.criteria || [];
  if (crit.length) {
    w.heading(isTest ? "ACE feature acceptance criteria" : "Acceptance criteria");
    w.table(["Criterion", "Required", "Measured", "Result"], crit.map(c => [c.name, c.required, c.actual, c.pass ? "PASS" : "FAIL"]), [0.48, 0.17, 0.25, 0.1]);
    const obs = run.experimentResult?.aceObservations;
    if (obs) {
      const share = obs.timeShare ? Object.entries(obs.timeShare).map(([k, v]) => `${k} ${v}%`).join(", ") : "-";
      w.text(`Envelope transitions: ${obs.transitions}; coordination sessions: ${obs.sessions}; max scope: ${obs.maxScope} robots; time share: ${share}.`, { size: 9 });
    }
  }

  const events = (run.events || []).slice(0, 30);
  if (events.length) {
    w.heading("Relevant events (most recent first)");
    w.table(["Time", "Robot", "Event", "Details"], events.map(e => [e.time, e.robot, e.event, e.details]), [0.12, 0.1, 0.23, 0.55]);
  }
  if ((run.insights || []).length) {
    w.heading("Insights");
    for (const i of run.insights) { w.text(i.title, { bold: true }); w.text(i.desc, { indent: 8, size: 9.5 }); }
  }
  return w.build(`NodeX run ${run.runId || run.id}`);
}

/** Analytics & Efficiency report for the current selection. */
export function analyticsReportPdf({ kind, fleetSize, matrix, overall, overallNfei = null, kpiCode, kpiTitle, kpis, insights, validation, fleet, fleetMetricKey = "efficiency" }) {
  const w = new PdfWriter();
  const systems = kind === "test" ? ["ace"] : SYSTEMS;
  w.text("NodeX Analytics & Efficiency Report", { size: 18, bold: true, color: [0.02, 0.2, 0.42] });
  w.text(`${kind === "test" ? "ACE validation tests (NodeX ACE only)" : "Scenarios (three-architecture comparison)"} - ${fleetSize} robots - generated ${new Date().toLocaleString()}`, { size: 10 });

  if (kind !== "test") {
    w.heading(`NodeX Fleet Efficiency Index v${NFEI_VERSION} (${fleetSize} robots; 0-100, 100 = best among paired systems)`);
    w.table(["Scenario", ...systems.map(sys => SYSTEM_LABELS[sys])], matrix.map(r => [`${r.code} ${r.name}`, ...systems.map(sys => {
      const n = r.bySystem[sys]?.nfei;
      return !n ? "-" : n.value === null ? n.status : String(n.value);
    })]), [0.43, 0.19, 0.19, 0.19]);
    if (overallNfei) w.text(`NFEI overall (geometric mean over paired rows): ${systems.map(sys => `${SYSTEM_LABELS[sys]} ${overallNfei[sys] && overallNfei[sys].value !== null ? `${overallNfei[sys].value} (${overallNfei[sys].rows}/${overallNfei[sys].total} rows${overallNfei[sys].invalid ? `, ${overallNfei[sys].invalid} INVALID` : ""})` : "-"}`).join("; ")}.`, { bold: true, size: 9.5 });
    w.text("Method: NFEI = 100 x weighted geometric mean of ratios to the best value among the paired systems with the same scenario, fleet, seed, map and duration limit: throughput 0.6, allocation latency 0.2, messages per completed task 0.2. Collisions, obstacle intrusions or boundary violations make a run INVALID. Project-specific composite of recognized KPIs; not an ISO/IEEE metric.", { size: 8.5 });
  }
  w.heading(`Recorded run task-completion score (${fleetSize} robots)`);
  const headers = [kind === "test" ? "ACE test" : "Scenario", ...systems.map(sys => SYSTEM_LABELS[sys])];
  const widths = kind === "test" ? [0.7, 0.3] : [0.43, 0.19, 0.19, 0.19];
  w.table(headers, matrix.map(r => [`${r.code} ${r.name}`, ...systems.map(sys => r.bySystem[sys] && r.bySystem[sys].value !== null ? `${r.bySystem[sys].value}%` : "-")]), widths);
  w.text(`NodeX Experimental Efficiency Index (overall): ${systems.map(sys => `${SYSTEM_LABELS[sys]} ${overall[sys] ? `${overall[sys].value}% (${overall[sys].rows}/${overall[sys].total} rows${overall[sys].partial ? ", partial" : ""})` : "-"}`).join("; ")}.`, { bold: true, size: 9.5 });
  w.text("Method: mean of per-row efficiency over the rows every architecture recorded (paired rows); efficiency per run = NEEI v1.1 (collision gate x weighted composite of task success, time, throughput and recovery).", { size: 8.5 });

  w.heading(`Key performance metrics - ${kpiTitle} (${kpiCode})`);
  w.table(["Metric", ...systems.map(sys => SYSTEM_LABELS[sys])], kpis.map(k => [k.label + (k.unit ? ` (${k.unit})` : ""), ...systems.map(sys => fmt(k.values[sys]))]), kind === "test" ? [0.6, 0.4] : [0.4, 0.2, 0.2, 0.2]);

  if (fleet && fleet.length) {
    w.heading(`Fleet scale performance (${fleetMetricKey === "nfei" ? `overall NFEI v${NFEI_VERSION}` : "ACE test score"})`);
    w.table(["Robots", ...systems.map(sys => SYSTEM_LABELS[sys])], fleet.map(p => [p.fleetSize, ...systems.map(sys => fmt(p[sys], fleetMetricKey === "nfei" ? "" : "%"))]), kind === "test" ? [0.6, 0.4] : [0.4, 0.2, 0.2, 0.2]);
  }
  if (validation && validation.length) {
    w.heading(`ACE feature validation (${fleetSize} robots)`);
    w.table(["Test", "Status"], validation.map(v => [`${v.code} ${v.name}`, v.status.replace("_", " ")]), [0.75, 0.25]);
  }
  w.heading("Insights (overall data)");
  for (const i of insights) { w.text(i.title, { bold: true }); w.text(i.text, { indent: 8, size: 9.5 }); }
  return w.build("NodeX Analytics & Efficiency report");
}

/** Browser download of a PDF string. */
export function downloadPdf(pdf, filename) {
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
