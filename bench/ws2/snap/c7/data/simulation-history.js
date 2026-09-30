// ==========================================================================
// NODEX ACE - Simulation History & Replay Data Repository
// Live run view + archived real runs (src/data/run-history.js). Only
// measured runs exist: the former demo fixture runs were removed.

import { state } from "../core/state.js";
import { buildRunView, getArchivedRuns } from "./run-history.js";
import { robotTimeline } from "../core/robot-timeline.js";

export const LIVE_RUN_ID = "LIVE";

export class SimulationHistoryService {
  /** Live run first, then archived real runs (measured data only). */
  static getRuns() {
    return [this.getLiveRunData(), ...getArchivedRuns()];
  }

  static getRunById(runId) {
    if (!runId || runId === LIVE_RUN_ID) return this.getLiveRunData();
    return getArchivedRuns().find(r => r.id === runId) || this.getLiveRunData();
  }

  static getRunByScenario(code) {
    return getArchivedRuns().find(r => r.scenarioCode === code) || null;
  }

  static getCurrentLiveRun() {
    return this.getLiveRunData();
  }

  static getLiveRunData() {
    const runConfig = state.getRunConfig ? state.getRunConfig() : {};
    const hasRun = Boolean(runConfig.started_at);
    const status = hasRun ? (runConfig.status || state.get("simLifecycleState")) : "IDLE";
    return buildRunView({
      id: LIVE_RUN_ID,
      runConfig: hasRun ? runConfig : { ...runConfig, run_id: null, scenario_name: "No run started yet" },
      status,
      simTimeSeconds: state.get("simTimeSeconds") || 0,
      kpis: state.get("kpis") || {},
      robots: state.get("robots") || [],
      tasks: hasRun ? (state.get("tasks") || []) : [],
      events: state.get("events") || [],
      endReason: runConfig.end_reason || null,
      isLive: true,
      architectureMetrics: hasRun ? state.get("architectureMetrics") : null,
      experimentResult: hasRun ? state.get("experimentResult") : null,
      timeline: hasRun ? robotTimeline.snapshot({ minSegmentSeconds: 0.5 }) : []
    });
  }
}
