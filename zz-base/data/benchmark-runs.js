// ==========================================================================
// NODEX ACE - Experimental Benchmark Records & Metrics
// Scientific evaluation dataset interface - Awaiting Real Benchmark Run
// Fabricated data and synthetic dev fixtures removed: measured data only.
// ==========================================================================

import { state } from "../core/state.js";
import { experimentRunner, ExperimentRunner } from "../core/experiment-runner.js";
import { NEEI_VERSION, NEEI_WEIGHTS } from "./neei.js";
import { neeiForSelection } from "./analytics-selection.js";

// Synthetic dev fixtures were removed: these legacy accessors only ever
// return measured data, and none is kept here (see run-history.js).
export function getEfficiencyMatrix() {
  return [];
}

export function getFleetScaleTrend() {
  return [];
}

export function getRecordingsArchive() {
  return [];
}

export const EFFICIENCY_MATRIX = getEfficiencyMatrix();
export const FLEET_SCALE_TREND = getFleetScaleTrend();
export const RECORDINGS_ARCHIVE = getRecordingsArchive();

export const RAW_METRICS_SCENARIOS = {
  "S08": {
    name: "S08 - Robot Failure",
    metrics: [
      { name: "Completion Time", unit: "s", centralized: "Awaiting run", decentralized: "Awaiting run", ace: "Awaiting run", lowerBetter: true },
      { name: "Throughput", unit: "tasks/hr", centralized: "Awaiting telemetry", decentralized: "Awaiting telemetry", ace: "Awaiting telemetry", lowerBetter: false },
      { name: "Average Waiting Time", unit: "s", centralized: "Awaiting telemetry", decentralized: "Awaiting telemetry", ace: "Awaiting telemetry", lowerBetter: true },
      { name: "Deadlocks", unit: "count", centralized: "No validated run", decentralized: "No validated run", ace: "No validated run", lowerBetter: true },
      { name: "Collisions", unit: "count", centralized: "No validated run", decentralized: "No validated run", ace: "No validated run", lowerBetter: true },
      { name: "Coordination Messages", unit: "msgs", centralized: "Awaiting telemetry", decentralized: "Awaiting telemetry", ace: "Awaiting telemetry", lowerBetter: true },
      { name: "Recovery Time", unit: "s", centralized: "Awaiting telemetry", decentralized: "Awaiting telemetry", ace: "Awaiting telemetry", lowerBetter: true },
      { name: "Task Completion", unit: "%", centralized: "Awaiting run", decentralized: "Awaiting run", ace: "Awaiting run", lowerBetter: false },
      { name: "Robot Utilization", unit: "%", centralized: "Awaiting run", decentralized: "Awaiting run", ace: "Awaiting run", lowerBetter: false }
    ],
    highlightInsight: "Awaiting connected hardware/simulation telemetry to calculate measured comparative performance."
  }
};

const fmtMeasured = (run, key) => !run ? "Awaiting run" : (run.metrics[key] === null || run.metrics[key] === undefined ? "Not measured" : run.metrics[key]);
const fmtCompletion = (run) => !run ? "Awaiting run"
  : (run.metrics.completionTime === null ? `Not all tasks done in ${run.metrics.trialDurationSeconds}s` : `${run.metrics.completionTime}s`);

// Relative change in average wait time, ACE vs Centralized, from measured trials.
// Phrased by sign so a regression is never reported as a "reduction".
function describeWaitChange(centralWait, aceWait) {
  if (!(centralWait > 0)) {
    return `Measured trial: Centralized average wait ${centralWait}s, ACE ${aceWait}s (no relative change computed from a zero baseline).`;
  }
  const pct = ExperimentRunner.calculateImprovement(centralWait, aceWait, true);
  return pct >= 0
    ? `Measured trial: ACE average wait time ${pct}% lower than the Centralized baseline (${aceWait}s vs ${centralWait}s).`
    : `Measured trial: ACE average wait time ${Math.abs(pct)}% higher than the Centralized baseline (${aceWait}s vs ${centralWait}s).`;
}

export class BenchmarkReportService {
  static getLatestComparison(scenarioCode = "S08") {
    const history = experimentRunner.getHistory();
    const runs = history.filter(r => r.scenarioId === scenarioCode);
    const cRun = runs.filter(r => r.systemMode === "centralized").pop();
    const dRun = runs.filter(r => r.systemMode === "decentralized").pop();
    const aRun = runs.filter(r => r.systemMode === "ace").pop();

    if (cRun || dRun || aRun) {
      return {
        name: `${scenarioCode} - Measured Trial Evaluation`,
        metrics: [
          { name: "Completion Time", unit: "s", centralized: fmtCompletion(cRun), decentralized: fmtCompletion(dRun), ace: fmtCompletion(aRun), lowerBetter: true },
          { name: "Throughput", unit: "tasks/hr", centralized: cRun ? `${cRun.metrics.throughputTasksPerHour}` : "Awaiting telemetry", decentralized: dRun ? `${dRun.metrics.throughputTasksPerHour}` : "Awaiting telemetry", ace: aRun ? `${aRun.metrics.throughputTasksPerHour}` : "Awaiting telemetry", lowerBetter: false },
          { name: "Average Waiting Time", unit: "s", centralized: cRun ? `${cRun.metrics.averageWaitTimeSeconds}s` : "Awaiting telemetry", decentralized: dRun ? `${dRun.metrics.averageWaitTimeSeconds}s` : "Awaiting telemetry", ace: aRun ? `${aRun.metrics.averageWaitTimeSeconds}s` : "Awaiting telemetry", lowerBetter: true },
          { name: "Conflicts Detected", unit: "count", centralized: cRun ? cRun.metrics.conflictsCount : "Awaiting run", decentralized: dRun ? dRun.metrics.conflictsCount : "Awaiting run", ace: aRun ? aRun.metrics.conflictsCount : "Awaiting run", lowerBetter: true },
          { name: "Physical Overlaps", unit: "count", centralized: cRun ? cRun.metrics.collisionsCount : "Awaiting run", decentralized: dRun ? dRun.metrics.collisionsCount : "Awaiting run", ace: aRun ? aRun.metrics.collisionsCount : "Awaiting run", lowerBetter: true },
          { name: "Coordination Messages", unit: "msgs", centralized: fmtMeasured(cRun, "messagesCount"), decentralized: fmtMeasured(dRun, "messagesCount"), ace: fmtMeasured(aRun, "messagesCount"), lowerBetter: true },
          { name: "Tasks Completed", unit: "tasks", centralized: cRun ? cRun.metrics.tasksCompleted : "Awaiting run", decentralized: dRun ? dRun.metrics.tasksCompleted : "Awaiting run", ace: aRun ? aRun.metrics.tasksCompleted : "Awaiting run", lowerBetter: false },
          { name: "Task Completion Rate", unit: "%", centralized: cRun ? `${cRun.metrics.completionRatePct}%` : "Awaiting run", decentralized: dRun ? `${dRun.metrics.completionRatePct}%` : "Awaiting run", ace: aRun ? `${aRun.metrics.completionRatePct}%` : "Awaiting run", lowerBetter: false }
        ],
        highlightInsight: aRun && cRun
          ? `${describeWaitChange(cRun.metrics.averageWaitTimeSeconds, aRun.metrics.averageWaitTimeSeconds)} Tasks completed (C/D/ACE): ${cRun.metrics.tasksCompleted}/${dRun ? dRun.metrics.tasksCompleted : "-"}/${aRun.metrics.tasksCompleted} of ${aRun.metrics.totalTasks}.`
          : "Partial measured trial records: run the benchmark for all three architectures to compare."
      };
    }
    return null;
  }

  static getMetricsForScenario(code) {
    const live = this.getLatestComparison(code);
    if (live) return live;

    if (RAW_METRICS_SCENARIOS[code]) {
      return RAW_METRICS_SCENARIOS[code];
    }
    return RAW_METRICS_SCENARIOS["S08"];
  }

  static generateReportJson(scenarioCode = "S08", seed = 18427, robotCount = 50) {
    const metricsData = this.getMetricsForScenario(scenarioCode);
    const matrix = getEfficiencyMatrix();
    const trend = getFleetScaleTrend();
    const recs = getRecordingsArchive();

    return {
      title: "NODEX ACE - Scientific Benchmark Evaluation Report",
      generatedAt: new Date().toISOString(),
      platform: "NODEX ACE Industrial Fleet Operating System v0.9.3",
      evaluationScenario: {
        code: scenarioCode,
        name: metricsData.name,
        seed: seed,
        robotCount: robotCount,
        duration: "Per-trial; see completionTime in measured runs",
        map: state.get("selectedMap") || "WH-A"
      },
      // NodeX Experimental Efficiency Index (data/neei.js): computed only
      // from recorded runs of the same scenario/test and fleet size.
      efficiencyIndex: {
        name: "NodeX Experimental Efficiency Index (NEEI)",
        version: NEEI_VERSION,
        standard: "NodeX-defined experimental index (not an ISO/IEEE metric)",
        formula: "NEEI = 100 x SafetyGate x sum(w_i c_i) / sum(w_i) over applicable components",
        weights: { ...NEEI_WEIGHTS },
        bySystem: Object.fromEntries(["centralized", "decentralized", "ace"].map(sys => {
          const e = neeiForSelection(scenarioCode, robotCount).bySystem[sys];
          return [sys, e ? { value: e.neei.value, components: e.neei.components, runId: e.run.runId, reference: e.neei.reference } : null];
        }))
      },
      dataProvenance: "Measured trials only",
      keyPerformanceMetrics: metricsData.metrics,
      fleetScaleTrend: trend,
      efficiencyMatrix: matrix,
      recordings: recs,
      conclusion: metricsData.highlightInsight
    };
  }

  static generateReportCsv(scenarioCode = "S08") {
    const metricsData = this.getMetricsForScenario(scenarioCode);
    const matrix = getEfficiencyMatrix();

    let csv = "NODEX ACE - Performance Benchmark Evaluation Report\n";
    csv += `Scenario,${metricsData.name}\n`;
    csv += "Generated," + new Date().toISOString() + "\n\n";

    csv += "KEY PERFORMANCE METRICS\n";
    csv += "Metric,Unit,Centralized,Decentralized,NodeX Edge AI ACE decentralized\n";
    metricsData.metrics.forEach(m => {
      csv += `"${m.name}","${m.unit}",${m.centralized},${m.decentralized},${m.ace}\n`;
    });

    csv += "\nEFFICIENCY MATRIX\n";
    csv += "ID,Test Situation,Centralized,Decentralized,NodeX Edge AI ACE decentralized\n";
    if (matrix.length > 0) {
      matrix.forEach(row => {
        csv += `${row.id},"${row.name}",${row.centralized},${row.decentralized},${row.ace}\n`;
      });
    } else {
      csv += "No validated benchmark runs available yet (Awaiting simulation/telemetry source)\n";
    }

    return csv;
  }
}
