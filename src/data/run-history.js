// ==========================================================================
// NODEX ACE - Run History Store
// Completed runs are archived here by the simulation lifecycle (stop/finish).
// Records are immutable deep copies of end-of-run values: live state can never
// overwrite history, and a record is only ever created for a run that actually
// executed. Values the engine does not measure are reported as NOT_MEASURED
// instead of being filled with plausible-looking numbers.
// ==========================================================================

import { state, SYSTEM_NAMES } from "../core/state.js";
import { SCENARIOS, ACE_TESTS } from "./scenarios.js";

export const NOT_MEASURED = "Not measured";
const STORAGE_KEY = "nodex_run_history_v2"; // v2: per-run architecture metrics + verdict
// Retention: never drop a scenario/fleet/system just because other runs were
// added. Keep the newest RUNS_PER_SLOT runs per (run kind, scenario/test,
// fleet size, system) — enough for several seeds — and a large global cap.
const RUNS_PER_SLOT = 6;
const MAX_RUNS = 3000;
function slotKey(r) {
  const kind = r.runKind || (/^A\d/.test(r.scenarioCode || "") ? "test" : "scenario");
  return `${kind}|${r.scenarioCode}|${r.fleetSize}|${r.systemMode}`;
}
/** Newest-first list pruned per slot (see RUNS_PER_SLOT). */
export function pruneRuns(runs) {
  const count = new Map();
  const out = [];
  for (const r of runs) {
    const k = slotKey(r);
    const n = count.get(k) || 0;
    if (n >= RUNS_PER_SLOT) continue;
    count.set(k, n + 1);
    out.push(r);
    if (out.length >= MAX_RUNS) break;
  }
  return out;
}

const SYSTEM_LABELS = {
  centralized: "Centralized",
  decentralized: "Decentralized",
  ace: "NodeX Edge AI ACE decentralized"
};

const STATUS_COLORS = {
  RUNNING: "#10B981",
  PAUSED: "#F59E0B",
  FINISHED: "#0077FF",
  STOPPED: "#64748B",
  ERROR: "#EF4444"
};

const CATALOG_NAMES = new Map([...SCENARIOS, ...ACE_TESTS].map(s => [s.code, `${s.code} - ${s.name}`]));

/**
 * Compact records (runs imported from the headless bench harness) carry only
 * the measured data, not the display fields buildRunView adds. Fill those in
 * from the measured values so every archived run renders the same way.
 */
function withViewFields(r) {
  if (!r || r.scenarioName) return r;
  const startedAt = r.startedAt || null;
  const perf = r.performance || {};
  const status = r.status || "FINISHED";
  const simTime = perf.simTimeSeconds || 0;
  return {
    ...r,
    isLive: false,
    runKind: r.runKind || (/^A\d/.test(r.scenarioCode || "") ? "test" : "scenario"),
    scenarioName: CATALOG_NAMES.get(r.scenarioCode) || r.scenarioCode || "Recorded run",
    systemModeLabel: SYSTEM_LABELS[r.systemMode] || SYSTEM_NAMES[r.systemMode] || r.systemMode || "—",
    date: startedAt ? new Date(startedAt).toLocaleDateString() : "—",
    time: startedAt ? new Date(startedAt).toLocaleTimeString() : "—",
    dateTimeFormatted: `${r.runId || r.id} · ${startedAt ? new Date(startedAt).toLocaleString() : "—"}`,
    status,
    indicatorColor: STATUS_COLORS[status] || "#64748B",
    timeRange: `00:00:00 — ${formatClock(simTime)}`,
    verdict: r.verdict ?? r.experimentResult?.verdict ?? null,
    tasks: r.tasks || [],
    events: r.events || [],
    timeline: r.timeline || [],
    timelineSpanSeconds: r.timelineSpanSeconds ?? simTime,
    insights: r.insights || [{
      type: "efficiency",
      color: "#0077FF",
      icon: "bar-chart-2",
      title: "Task progress (measured)",
      desc: `${perf.tasksCompleted ?? 0} of ${perf.tasksTotal ?? 0} scenario tasks completed in ${formatClock(simTime)} sim time with ${r.fleetSize ?? "—"} AMRs.`
        + (r.endReason ? ` Run ended: ${r.endReason}.` : "")
        + " Recorded by the headless benchmark harness: per-event logs were not kept."
    }]
  };
}

let archivedRuns = loadFromStorage();

// Optional remote store (core/shared-sync.js) that shares history across
// browsers. Registered at runtime so this module has no network dependency.
let remoteSink = null;
export function setRunHistorySink(sink) {
  remoteSink = sink;
}

function loadFromStorage() {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(withViewFields) : [];
  } catch (e) {
    return [];
  }
}

function persist() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(archivedRuns));
  } catch (e) {
    // Storage quota/private mode: history stays in memory for this session.
  }
}

function formatClock(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${h}:${m}:${String(s % 60).padStart(2, "0")}`;
}

function formatWallTime(ms) {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toTimeString().split(" ")[0] : "—";
}

function countEvents(events, types) {
  return events.filter(e => types.includes(e.type)).length;
}

const STATE_LABELS = { moving: "Moving", picking: "Picking (loading)", placing: "Placing (unloading)", charging: "Charging", idle: "Idle", blocked: "Blocked / waiting", failed: "Failed" };

/** Recorder segments (seconds) -> Gantt rows (percent of the run span). */
function timelineView(timeline, span) {
  if (!Array.isArray(timeline) || timeline.length === 0 || !(span > 0)) return [];
  const pct = (v) => Math.round(Math.max(0, Math.min(100, (v / span) * 100)) * 100) / 100;
  return timeline.map(row => ({
    robot: row.robot,
    segments: row.segments
      .map(seg => ({
        state: seg.state,
        start: pct(seg.start),
        end: pct(seg.state === "failed" && seg.end - seg.start < span * 0.02 ? Math.min(span, seg.start + span * 0.02) : seg.end),
        label: `${STATE_LABELS[seg.state] || seg.state} ${formatClock(seg.start)}–${formatClock(seg.end)}`
      }))
      .filter(seg => seg.end > seg.start)
  })).filter(row => row.segments.length > 0);
}

/**
 * Builds the run view consumed by the Explain Simulation screen from measured
 * values only. Shared by the live view and archived records.
 */
export function buildRunView({ id, runConfig = {}, status, simTimeSeconds = 0, tasksCompletedAtSeconds = null, kpis = {}, robots = [], tasks = [], events = [], endReason = null, isLive = false, architectureMetrics = null, experimentResult = null, timeline = [] }) {
  const systemMode = runConfig.system_id || "ace";
  const completed = tasks.filter(t => t.status === "COMPLETED").length;
  const failedRobots = robots.filter(r => ["ERROR", "error", "failed"].includes(r.status)).length;
  const startedAt = runConfig.started_at || null;

  const escalations = countEvents(events, ["ENVELOPE_ESCALATED", "CONTAINMENT_ENTERED", "SAFE_DEGRADED_ENTERED"]);
  const deEscalations = countEvents(events, ["ENVELOPE_DE_ESCALATED"]);
  const conflicts = countEvents(events, ["CONFLICT_DETECTED", "YIELD_WAIT"]);
  const replans = countEvents(events, ["PATH_REPLANNED", "DEADLOCK_REPLAN", "CONTAINMENT_DETOUR"]);

  const insights = [{
    type: "efficiency",
    color: "#0077FF",
    icon: "bar-chart-2",
    title: "Task progress (measured)",
    desc: `${completed} of ${tasks.length} scenario tasks completed in ${formatClock(simTimeSeconds)} sim time with ${robots.length} AMRs.`
      + (endReason ? ` Run ended: ${endReason}.` : "")
  }];
  if (events.length > 0) {
    insights.push({
      type: "network",
      color: "#10B981",
      icon: "network",
      title: "Coordination activity (last logged events)",
      desc: systemMode === "ace"
        ? `${escalations} envelope escalations, ${deEscalations} de-escalations, ${conflicts} conflict/yield events, ${replans} replans in the retained event log.`
        : `${conflicts} conflict/yield events and ${replans} replans in the retained event log.`
    });
  }

  const physics = architectureMetrics?.physics || null;
  // Task makespan: when the last task completed (robots may still have been
  // driving back to their bays until the run ended).
  const makespan = endReason === "ALL_TASKS_COMPLETE"
    ? (typeof tasksCompletedAtSeconds === "number" ? tasksCompletedAtSeconds : simTimeSeconds) : null;
  const workTime = makespan ?? simTimeSeconds;
  const alloc = architectureMetrics?.allocation || null;
  return {
    id,
    runId: runConfig.run_id || null,
    isLive,
    // Run identity (fair-comparison key)
    seed: runConfig.seed ?? null,
    mapProfile: runConfig.map_profile || null,
    worldSize: runConfig.world_size || null,
    configVersion: runConfig.config_version || null,
    controller: runConfig.controller || null,
    startedAt: runConfig.started_at || null,
    endedAt: runConfig.ended_at || null,
    durationLimitSeconds: runConfig.duration_limit_s ?? null,
    architectureMetrics: architectureMetrics ? JSON.parse(JSON.stringify(architectureMetrics)) : null,
    experimentResult: experimentResult ? JSON.parse(JSON.stringify(experimentResult)) : null,
    verdict: experimentResult ? experimentResult.verdict : null,
    scenarioCode: runConfig.scenario_id || runConfig.ace_test_id || "—",
    // "scenario": all three architectures are compared; "test": an
    // ACE-specific validation test (NodeX ACE only).
    runKind: runConfig.ace_test_id ? "test" : "scenario",
    scenarioName: runConfig.scenario_name || runConfig.scenario_id || runConfig.ace_test_id || "No run started",
    systemMode,
    systemModeLabel: SYSTEM_LABELS[systemMode] || SYSTEM_NAMES[systemMode] || systemMode,
    fleetSize: runConfig.fleet_size ?? robots.length,
    date: startedAt ? new Date(startedAt).toLocaleDateString() : "—",
    time: startedAt ? new Date(startedAt).toLocaleTimeString() : "—",
    dateTimeFormatted: isLive
      ? (status === "RUNNING" ? "Live Running" : `Live · ${status}`)
      : `${runConfig.run_id || id} · ${startedAt ? new Date(startedAt).toLocaleString() : "—"}`,
    status,
    endReason,
    indicatorColor: STATUS_COLORS[status] || "#64748B",
    timeRange: `00:00:00 — ${formatClock(simTimeSeconds)}`,
    // Measured end-of-run performance consumed by Analytics (Screen 3).
    // completionTimeSeconds exists only when every task finished.
    performance: {
      simTimeSeconds: Math.round(simTimeSeconds * 10) / 10,
      tasksTotal: tasks.length,
      tasksCompleted: completed,
      completionPct: tasks.length > 0 ? Math.round((completed / tasks.length) * 1000) / 10 : null,
      completionTimeSeconds: makespan !== null ? Math.round(makespan * 10) / 10 : null,
      throughputPerHour: workTime > 0 ? Math.round((completed / workTime) * 3600) : null,
      // Recovery inputs (NEEI): tasks released from a failed / expired owner
      // and later re-awarded, and how many of those were completed.
      reallocatedTasks: tasks.filter(t => (t.reassignCount || 0) > 0).length,
      reallocatedCompleted: tasks.filter(t => (t.reassignCount || 0) > 0 && t.status === "COMPLETED").length
    },
    summary: {
      totalTasks: tasks.length,
      completed,
      totalTime: `${(simTimeSeconds / 60).toFixed(1)} min`,
      robotFailures: failedRobots,
      collisions: physics ? physics.collisions : NOT_MEASURED,
      nearCollisions: physics ? physics.nearCollisions : NOT_MEASURED,
      obstacleIntrusions: physics ? physics.obstacleIntrusions : NOT_MEASURED,
      deadlocks: NOT_MEASURED,
      recoveryTime: NOT_MEASURED,
      allocationLatency: alloc && alloc.allocationLatencyAvgS !== null && alloc.allocationLatencyAvgS !== undefined ? `${alloc.allocationLatencyAvgS} s` : NOT_MEASURED,
      avgTaskCompletion: alloc && alloc.taskCompletionAvgS !== null && alloc.taskCompletionAvgS !== undefined ? `${alloc.taskCompletionAvgS} s` : NOT_MEASURED,
      avgWaitTime: NOT_MEASURED,
      throughput: typeof kpis.throughput === "string" ? kpis.throughput : NOT_MEASURED
    },
    tasks: tasks.slice(0, 50).map(t => ({
      id: t.id,
      pick: t.pickup?.name || t.pickup?.id || "—",
      drop: t.destination?.name || t.destination?.id || "—",
      robot: t.assignedRobot || "Unassigned",
      startTime: formatWallTime(t.startTime),
      endTime: t.status === "COMPLETED" ? formatWallTime(t.completedTime) : (t.status === "FAILED" ? "Failed" : "Open"),
      status: t.status === "COMPLETED" ? "Completed" : t.status === "FAILED" ? "Failed" : t.status === "EXECUTING" ? "Moving" : t.status === "ASSIGNED" ? "Assigned" : "Unassigned"
    })),
    events: events.map(e => ({
      time: e.time,
      robot: e.actor,
      event: e.type,
      details: e.desc,
      severity: ["FAULT", "ROBOT_FAILED", "CRITICAL", "ERROR"].includes(e.type)
        ? "critical"
        : (["CONFLICT_DETECTED", "ROBOT_WAITING", "YIELD_WAIT"].includes(e.type) ? "warning" : "info"),
      category: ["ROBOT_FAILED", "TASK_REALLOCATING", "PEER_FAILED", "TASK_REBID", "TASK_HANDED_OVER"].includes(e.type)
        ? "recovery"
        : (["CONFLICT_DETECTED", "ROBOT_WAITING", "YIELD_WAIT"].includes(e.type) ? "conflict" : (String(e.type).startsWith("TASK_") ? "task" : "robot"))
    })),
    // Measured per-robot activity (robot-timeline.js), as % of the run span.
    timelineSpanSeconds: Math.round(simTimeSeconds * 10) / 10,
    timeline: timelineView(timeline, simTimeSeconds),
    insights
  };
}

/** Archives a finished run. Called by the lifecycle on stop/finish. */
export function recordRun({ runConfig, endReason, simTimeSeconds, tasksCompletedAtSeconds = null, kpis, robots, tasks, events, architectureMetrics = null, experimentResult = null, timeline = [] }) {
  if (!runConfig?.run_id) return null;
  if (archivedRuns.some(r => r.runId === runConfig.run_id)) return null; // one record per run
  const view = buildRunView({
    id: runConfig.run_id,
    runConfig,
    status: runConfig.status,
    simTimeSeconds,
    tasksCompletedAtSeconds,
    kpis,
    robots,
    tasks,
    events,
    endReason,
    architectureMetrics,
    experimentResult,
    timeline
  });
  const frozen = JSON.parse(JSON.stringify(view));
  archivedRuns = pruneRuns([frozen, ...archivedRuns]);
  persist();
  state.set("runHistoryVersion", (state.get("runHistoryVersion") || 0) + 1);
  remoteSink?.add(frozen);
  return frozen;
}

export function getArchivedRuns() {
  return archivedRuns;
}

export function clearRunHistory() {
  archivedRuns = [];
  persist();
  state.set("runHistoryVersion", (state.get("runHistoryVersion") || 0) + 1);
  remoteSink?.clear();
}

/** Replaces local history with the shared copy (does not echo to the sink). */
export function replaceArchivedRuns(runs) {
  if (!Array.isArray(runs)) return;
  archivedRuns = pruneRuns(runs.map(withViewFields));
  persist();
  state.set("runHistoryVersion", (state.get("runHistoryVersion") || 0) + 1);
}

/**
 * Separately recorded runs that are comparable: same scenario, fleet size,
 * seed and map profile, one per system (most recent). Comparison only reads
 * archived records; it never runs a controller.
 */
export function comparableRuns(scenarioCode, fleetSize, seed = null, mapProfile = null) {
  const out = {};
  for (const r of archivedRuns) {
    if (r.scenarioCode !== scenarioCode || r.fleetSize !== fleetSize) continue;
    if (seed !== null && r.seed !== seed) continue;
    if (mapProfile !== null && r.mapProfile !== mapProfile) continue;
    if (!out[r.systemMode]) out[r.systemMode] = r;
  }
  return out;
}

/** Most recent archived run for a scenario and system, or null. */
export function latestRunFor(scenarioCode, systemMode) {
  return archivedRuns.find(r => r.scenarioCode === scenarioCode && r.systemMode === systemMode) || null;
}
