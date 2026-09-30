// ==========================================================================
// NODEX ACE-AMR headless benchmark harness - library
//
// Drives the real simulator modules (src/ or the frozen zz-base/ baseline)
// exactly like tests/traffic-control.test.js does, and records per-tick
// telemetry WITHOUT changing behaviour: the harness only reads robot/task
// state after each simEngine.update(0.1), plus two pass-through observers
// (peer bus send, central downlink command) that count messages/bytes and
// call the original function with the original arguments.
// ==========================================================================

import { createHash } from "node:crypto";

export const HARNESS_VERSION = "nodex-bench-1.0";
export const TICK_DT = 0.1;          // sim seconds per tick (same as the regression tests)
export const FLUSH_EVERY = 20;       // ticks between macrotask flushes (same as the tests)
const FAILED = ["ERROR", "error", "failed"];

const flush = () => new Promise(r => setTimeout(r, 0));
const nowNs = () => process.hrtime.bigint();

/** Loads one simulator tree ("src" or "zz-base") as singletons for this process. */
export async function loadSim(src) {
  const base = new URL(`../${src}/`, import.meta.url);
  const imp = (p) => import(new URL(p, base).href);
  const [stateM, engineM, lifeM, sysM, scenM, mapM, decM, cenM, tmM, histM, scenDataM, aceValM] = await Promise.all([
    imp("core/state.js"),
    imp("core/sim-engine.js"),
    imp("core/sim-lifecycle.js"),
    imp("core/adapters/SystemManager.js"),
    imp("core/scenario-engine.js"),
    imp("core/map-geometry.js"),
    imp("core/decentralized/DecentralizedFleet.js"),
    imp("core/centralized/CentralizedCoordinator.js"),
    imp("core/centralized/TaskManager.js"),
    imp("data/run-history.js"),
    imp("data/scenarios.js"),
    imp("data/ace-validation.js")
  ]);
  const mods = {
    src,
    state: stateM.state,
    simEngine: engineM.simEngine,
    simLifecycle: lifeM.simLifecycle,
    CONFIG_VERSION: lifeM.CONFIG_VERSION,
    RUN_WALL_BUDGET_SECONDS: lifeM.RUN_WALL_BUDGET_SECONDS,
    systemManager: sysM.systemManager,
    scenarioEngine: scenM.scenarioEngine,
    MapGeometryEngine: mapM.MapGeometryEngine,
    WAREHOUSE_DIMENSIONS: mapM.WAREHOUSE_DIMENSIONS,
    WAREHOUSE_TASK_LOCATIONS: mapM.WAREHOUSE_TASK_LOCATIONS,
    ROBOT_FOOTPRINT: mapM.ROBOT_FOOTPRINT,
    decentralizedFleet: decM.decentralizedFleet,
    centralizedCoordinator: cenM.centralizedCoordinator,
    taskManager: tmM.taskManager,
    getArchivedRuns: histM.getArchivedRuns,
    SCENARIOS: scenDataM.SCENARIOS,
    ACE_TESTS: scenDataM.ACE_TESTS,
    ACE_VALIDATION_TESTS: aceValM.ACE_VALIDATION_TESTS
  };
  mods.scenarioEngine.setSimEngine(mods.simEngine);
  installObservers(mods);
  return mods;
}

// --------------------------------------------------------------------------
// Pass-through message observers (counting only; behaviour unchanged)
// --------------------------------------------------------------------------
const comm = {
  enabled: true,
  instrNs: 0n,          // time spent inside the observers (subtracted from tick CPU)
  reset() {
    this.peerSends = 0; this.peerSendsSystem = 0; this.peerBytes = 0; this.peerBytesSystem = 0;
    this.peerDeliveries = 0; this.byType = {};
    this.downlinkCmds = 0; this.downlinkBytes = 0;
    this.instrNs = 0n;
  }
};
comm.reset();

function jsonLen(v) {
  try { return JSON.stringify(v).length; } catch { return 0; }
}

function installObservers(mods) {
  const bus = mods.decentralizedFleet.peerBus;
  if (bus && !bus.__benchObserved) {
    const orig = bus.send;
    bus.send = function (message) {
      if (comm.enabled) {
        const t0 = nowNs();
        const sys = message && message.senderId === "SYSTEM";
        const bytes = jsonLen({ type: message.type, senderId: message.senderId, receiverId: message.receiverId || "BROADCAST", payload: message.payload || {} });
        const fanout = (message.receiverId && message.receiverId !== "BROADCAST") ? 1 : Math.max(0, this.subscribers.size - (this.subscribers.has(message.senderId) ? 1 : 0));
        if (sys) { comm.peerSendsSystem++; comm.peerBytesSystem += bytes; }
        else { comm.peerSends++; comm.peerBytes += bytes; comm.peerDeliveries += fanout; }
        comm.byType[message.type] = (comm.byType[message.type] || 0) + 1;
        comm.instrNs += nowNs() - t0;
      }
      return orig.call(this, message);
    };
    bus.__benchObserved = true;
  }
  const cc = mods.centralizedCoordinator;
  if (cc && typeof cc._applyCommand === "function" && !cc.__benchObserved) {
    const orig = cc._applyCommand;
    cc._applyCommand = function (c) {
      const before = this.runStats.downlinkCommands;
      const out = orig.call(this, c);
      if (comm.enabled && this.runStats.downlinkCommands > before) {
        const t0 = nowNs();
        comm.downlinkCmds++;
        comm.downlinkBytes += jsonLen({ robotId: c.robotId, taskId: c.taskId, route: (c.route || []).map(p => [Math.round(p.x), Math.round(p.y)]) });
        comm.instrNs += nowNs() - t0;
      }
      return out;
    };
    cc.__benchObserved = true;
  }
}

// --------------------------------------------------------------------------
// Statistics helpers
// --------------------------------------------------------------------------
const r3 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
export function describe(arr) {
  const a = arr.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return { n: 0, mean: null, median: null, p95: null, max: null, min: null };
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
  return { n: a.length, mean: r3(a.reduce((s, v) => s + v, 0) / a.length), median: r3(q(0.5)), p95: r3(q(0.95)), max: r3(a[a.length - 1]), min: r3(a[0]) };
}
const sha = (v) => createHash("sha1").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 16);

// --------------------------------------------------------------------------
// Fairness fingerprint: what must be identical across the three systems
// --------------------------------------------------------------------------
function registryOf(mods, system) {
  return system === "centralized" ? mods.taskManager : mods.decentralizedFleet.taskRegistry;
}
const P = (p) => (p ? [Math.round(p.x), Math.round(p.y)] : null);

function mapFingerprint(mods) {
  const M = mods.MapGeometryEngine;
  const layout = M.generatedLayout || {};
  const obstacles = (layout.obstacles || []).map(o => [Math.round(o.x), Math.round(o.y), Math.round(o.width || 0), Math.round(o.height || 0), o.type || ""]);
  const waypoints = (M.getActiveWaypoints ? M.getActiveWaypoints() : []).map(w => P(w));
  const taskLocs = mods.WAREHOUSE_TASK_LOCATIONS.map(l => [l.id || l.name, ...P(l)]);
  return {
    mapId: M.activeMapId || null,
    profile: layout.config?.worldProfileId || null,
    world: [mods.WAREHOUSE_DIMENSIONS.width, mods.WAREHOUSE_DIMENSIONS.height],
    obstacleCount: obstacles.length,
    hash: sha({ obstacles, waypoints, taskLocs })
  };
}

function workloadList(mods, system) {
  return registryOf(mods, system).getAllTasks()
    .map(t => [t.id, ...P(t.pickup), ...P(t.destination), t.priority, r3(t.createdSim ?? 0)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function robotFingerprint(robots) {
  return robots.map(r => [r.id, Math.round(r.x), Math.round(r.y),
    r.maxVelocity ?? r.maxSpeed ?? null, r.targetVelocity ?? null]);
}

// --------------------------------------------------------------------------
// Per-tick telemetry
// --------------------------------------------------------------------------
class Telemetry {
  constructor(mods, system, fleet) {
    this.mods = mods;
    this.system = system;
    this.fleet = fleet;
    const fp = mods.ROBOT_FOOTPRINT;
    this.CONTACT = fp.radius * 2;            // 24 px: footprints touch
    this.NEAR = fp.totalRadius * 2;          // 32 px: safety margins touch
    this.robot = new Map();
    this.minSepAll = Infinity;
    this.minSepMoving = Infinity;
    this.nearPairsPrev = new Set();
    this.contactPairsPrev = new Set();
    this.nearEvents = 0; this.contactEvents = 0; this.nearPairSeconds = 0;
    this.envelopeSeconds = {};               // ACE raceState -> robot-seconds
    this.sessionSamples = 0; this.sessionSum = 0; this.sessionMax = 0; this.sessionSeconds = 0;
    this.contractSum = 0; this.contractMax = 0;
    this.detours = [];                       // actual / manhattan lower bound per completed task leg
    this.tickMs = [];
    this.heapMax = 0;
    this.faults = [];
    this._faultCount = 0;
    this.uplinkBytes = 0;
    this._uplinkPrev = 0;
    this._uplinkAvg = 0;
  }

  _rs(r) {
    let s = this.robot.get(r.id);
    if (!s) {
      s = { dist: 0, moving: 0, waiting: 0, idle: 0, handling: 0, failed: 0, stops: 0, lastCat: null, x: r.x, y: r.y,
            task: null, taskOdo: 0, taskX: r.x, taskY: r.y };
      this.robot.set(r.id, s);
    }
    return s;
  }

  observe(robots, dt, simTime, taskIndex) {
    const n = robots.length;
    const movingFlag = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = robots[i];
      const s = this._rs(r);
      const d = Math.hypot(r.x - s.x, r.y - s.y);
      s.dist += d; s.x = r.x; s.y = r.y;
      let cat;
      if (FAILED.includes(r.status)) cat = "failed";
      else if (d > 1e-6) cat = "moving";
      else if (r.handling) cat = "handling";
      else if (r.currentTaskId || r.parkingBay || r._maneuver) cat = "waiting";
      else cat = "idle";
      s[cat] += dt;
      if (cat === "waiting" && s.lastCat === "moving") s.stops++;
      s.lastCat = cat;
      movingFlag[i] = cat === "moving" ? 1 : 0;
      if (this.system === "ace" && r.raceState) this.envelopeSeconds[r.raceState] = (this.envelopeSeconds[r.raceState] || 0) + dt;

      // Task legs for detour ratio: assignment position -> pickup -> destination.
      const tid = r.currentTaskId || null;
      if (tid !== s.task) {
        if (s.task) {
          const t = taskIndex.get(s.task);
          if (t && t.status === "COMPLETED" && t.pickup && t.destination) {
            const ideal = Math.abs(t.pickup.x - s.taskX) + Math.abs(t.pickup.y - s.taskY)
              + Math.abs(t.destination.x - t.pickup.x) + Math.abs(t.destination.y - t.pickup.y);
            const actual = s.dist - s.taskOdo;
            if (ideal > 20) this.detours.push(actual / ideal);
          }
        }
        s.task = tid; s.taskOdo = s.dist; s.taskX = r.x; s.taskY = r.y;
      }
    }
    // Pairwise separation (ground truth, harness-side).
    const near = new Set(), contact = new Set();
    for (let i = 0; i < n; i++) {
      const a = robots[i];
      for (let j = i + 1; j < n; j++) {
        const b = robots[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < this.minSepAll) this.minSepAll = d;
        if (movingFlag[i] || movingFlag[j]) {
          if (d < this.minSepMoving) this.minSepMoving = d;
          if (d < this.NEAR) {
            const k = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
            if (d < this.CONTACT) contact.add(k); else near.add(k);
          }
        }
      }
    }
    for (const k of near) if (!this.nearPairsPrev.has(k) && !this.contactPairsPrev.has(k)) this.nearEvents++;
    for (const k of contact) if (!this.contactPairsPrev.has(k)) this.contactEvents++;
    this.nearPairSeconds += (near.size + contact.size) * dt;
    this.nearPairsPrev = near; this.contactPairsPrev = contact;

    const st = this.mods.state;
    const sessions = (st.get("activeSessions") || []).length;
    this.sessionSamples++; this.sessionSum += sessions; this.sessionMax = Math.max(this.sessionMax, sessions);
    this.sessionSeconds += sessions * dt;
    const contracts = (st.get("contracts") || []).length;
    this.contractSum += contracts; this.contractMax = Math.max(this.contractMax, contracts);

    const faults = st.get("activeFaults") || [];
    if (faults.length !== this._faultCount) {
      for (const f of faults.slice(this._faultCount)) this.faults.push({ t: r3(simTime), type: f.type, target: f.targetRobot });
      this._faultCount = faults.length;
    }

    // Central uplink bytes: robot state reports (modelled as the JSON of the
    // per-robot state vector each report carries).
    if (this.system === "centralized") {
      const up = this.mods.centralizedCoordinator.runStats.uplinkMessages || 0;
      if (!this._uplinkAvg || this.sessionSamples % 50 === 1) {
        let b = 0;
        for (const r of robots) b += jsonLen({ id: r.id, x: +r.x.toFixed(1), y: +r.y.toFixed(1), heading: +(r.heading || 0).toFixed(3), velocity: +(r.velocity || 0).toFixed(2), status: r.status, battery: Math.round(r.battery ?? 100), health: Math.round(r.health ?? 100) });
        this._uplinkAvg = robots.length ? b / robots.length : 0;
      }
      this.uplinkBytes += (up - this._uplinkPrev) * this._uplinkAvg;
      this._uplinkPrev = up;
    }
  }

  summary(simTime) {
    const robots = [...this.robot.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const tot = (k) => robots.reduce((s, [, v]) => s + v[k], 0);
    const busy = tot("moving") + tot("waiting") + tot("handling");
    const px = (v) => r3(v);
    return {
      robots: robots.length,
      distance_px_total: px(tot("dist")),
      distance_px_per_robot: px(robots.length ? tot("dist") / robots.length : null),
      time_s: { moving: px(tot("moving")), waiting: px(tot("waiting")), handling: px(tot("handling")), idle: px(tot("idle")), failed: px(tot("failed")) },
      waiting_fraction_of_busy: busy > 0 ? r3(tot("waiting") / busy) : null,
      waiting_fraction_of_total: simTime > 0 && robots.length ? r3(tot("waiting") / (simTime * robots.length)) : null,
      stops_total: tot("stops"),
      stops_per_robot: robots.length ? r3(tot("stops") / robots.length) : null,
      per_robot: robots.map(([id, v]) => [id, Math.round(v.dist), r3(v.moving), r3(v.waiting), r3(v.idle), r3(v.handling), v.stops]),
      per_robot_fields: ["id", "distance_px", "moving_s", "waiting_s", "idle_s", "handling_s", "stops"],
      min_separation_px_all: Number.isFinite(this.minSepAll) ? r3(this.minSepAll) : null,
      min_separation_px_moving: Number.isFinite(this.minSepMoving) ? r3(this.minSepMoving) : null,
      near_threshold_px: this.NEAR,
      contact_threshold_px: this.CONTACT,
      near_collision_events: this.nearEvents,
      contact_events: this.contactEvents,
      near_pair_seconds: r3(this.nearPairSeconds),
      detour_ratio: describe(this.detours),
      envelope_seconds: Object.fromEntries(Object.entries(this.envelopeSeconds).map(([k, v]) => [k, r3(v)])),
      sessions: { mean_active: this.sessionSamples ? r3(this.sessionSum / this.sessionSamples) : 0, max_active: this.sessionMax, session_seconds: r3(this.sessionSeconds) },
      contracts: { mean_active: this.sessionSamples ? r3(this.contractSum / this.sessionSamples) : 0, max_active: this.contractMax },
      faults: this.faults
    };
  }
}

// --------------------------------------------------------------------------
// Task timing from the registry (sim seconds)
// --------------------------------------------------------------------------
function taskTiming(tasks) {
  const cycle = [], alloc = [], exec = [], waitStart = [];
  for (const t of tasks) {
    if (typeof t.allocationLatencySim === "number") alloc.push(t.allocationLatencySim);
    if (t.completedSim !== null && t.completedSim !== undefined) {
      cycle.push(t.completedSim - (t.createdSim ?? 0));
      if (typeof t.startedSim === "number") exec.push(t.completedSim - t.startedSim);
    }
    if (typeof t.assignedSim === "number" && typeof t.startedSim === "number") waitStart.push(t.startedSim - t.assignedSim);
  }
  return {
    cycle_s: describe(cycle),          // release (created) -> complete
    allocation_latency_s: describe(alloc),
    execution_s: describe(exec),       // started -> complete
    assign_to_start_s: describe(waitStart),
    reassigned: tasks.filter(t => (t.reassignCount || 0) > 0).length,
    per_task: tasks.map(t => [t.id, r3(t.createdSim), r3(t.assignedSim), r3(t.startedSim), r3(t.completedSim), t.reassignCount || 0]),
    per_task_fields: ["id", "created_s", "assigned_s", "started_s", "completed_s", "reassigns"]
  };
}

// Timing fields that are wall-clock measurements (excluded from the determinism digest).
const WALL_KEYS = new Set(["avgInferenceMs", "maxInferenceMs", "avgCycleComputeMs", "avgPlanMs", "maxPlanMs", "allocationComputeAvgMs", "runId", "startedAt", "endedAt"]);
function stripWall(v) {
  if (Array.isArray(v)) return v.map(stripWall);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) if (!WALL_KEYS.has(k)) o[k] = stripWall(v[k]);
    return o;
  }
  return v;
}

// --------------------------------------------------------------------------
// One run
// --------------------------------------------------------------------------
/**
 * @param {object} mods        loadSim() result
 * @param {object} cfg         { system, scenario, fleet, seed, kind: "scenario"|"aceTest", duration: "scenario"|"dashboard"|number, label }
 */
export async function runOne(mods, cfg) {
  const { state, simEngine, simLifecycle, systemManager } = mods;
  const kind = cfg.kind || "scenario";
  const wall0 = nowNs();
  const cpu0 = process.cpuUsage();
  comm.reset();

  simLifecycle.reset();
  state.set("seed", cfg.seed);
  state.set("simSpeed", 1.0);
  systemManager.switchSystem(cfg.system);
  state.set("robotCount", cfg.fleet);
  state.set("simTestType", kind);
  state.set("selectedScenario", cfg.scenario);

  // Duration / timeline mode (see docs/NODEX_EXPERIMENT_CONFIGURATION.md):
  //  "scenario" (default): the scenario's own duration and UNcompressed
  //      timeline (fault at its specified sim time). Implemented by setting
  //      the frozen run limit before ScenarioEngine reads it (_setTimeline).
  //  "dashboard": exactly the UI: limit min(duration, 90 s budget), timeline
  //      compressed to that limit.
  //  "extended": UI-compressed timeline, limit lifted to the scenario duration
  //      afterwards (the pattern of tests/traffic-control.test.js).
  //  <number N>: limit N, timeline compressed to N like the UI would.
  const mode = cfg.duration ?? "scenario";
  const unsub = state.subscribe("simActiveConfig", (v) => {
    if (!v || v.__benchSet) return;
    // ACE validation tests: the lifecycle's ACE_VALIDATION_TESTS entries carry
    // no duration (UI always 90 s); their specified duration is in ACE_TESTS.
    const full = v.scenarioDurationSeconds
      || (kind === "aceTest" ? (mods.ACE_TESTS.find(t => t.code === cfg.scenario || t.id === cfg.scenario)?.duration || null) : null);
    if (full && !v.scenarioDurationSeconds) v.scenarioDurationSeconds = full;
    if (mode === "scenario" && full) v.durationSeconds = full;
    else if (typeof mode === "number") v.durationSeconds = mode;
    v.__benchSet = true;
  });
  let ok;
  try {
    ok = await simLifecycle.start();
  } finally {
    unsub();
  }
  clearInterval(simEngine.fallbackIntervalId);
  simEngine.fallbackIntervalId = null;
  if (!ok) throw new Error(`start failed: ${cfg.system} ${cfg.scenario} ${cfg.fleet}`);

  const active = state.get("simActiveConfig");
  let limit = active.durationSeconds;
  if (mode === "extended") {
    limit = active.scenarioDurationSeconds || limit;
    state.set("simActiveConfig", { ...active, durationSeconds: limit });
  }
  state.updateRunConfig({ duration_limit_s: limit });

  const runId = state.get("runId");
  const robots0 = state.get("robots") || [];
  const fairness = {
    map: mapFingerprint(mods),
    robotCount: robots0.length,
    robots: sha(robotFingerprint(robots0)),
    robotsSample: robotFingerprint(robots0).slice(0, 3),
    workloadInitial: null,
    workloadFinal: null,
    workloadInitialCount: 0,
    workloadFinalCount: 0,
    scheduled: (mods.scenarioEngine.scheduledEvents || []).map(e => ({ at: e.triggerAt, fault: e.fault })),
    faults: null,
    durationLimit: limit
  };
  const wl0 = workloadList(mods, cfg.system);
  fairness.workloadInitial = sha(wl0);
  fairness.workloadInitialCount = wl0.length;

  const tel = new Telemetry(mods, cfg.system, cfg.fleet);
  const heap0 = process.memoryUsage().heapUsed;
  let ticks = 0;
  // hard stop safety; with no duration limit (DURATION=none) the engine ends the
  // run itself (ALL_TASKS_COMPLETE / NO_PROGRESS), so only a far bound of 4 sim-h.
  const maxTicks = Math.ceil(((limit ?? 4 * 3600) + 60) / TICK_DT) + 200;
  const registry = registryOf(mods, cfg.system);

  while (simLifecycle.getState() === "RUNNING" && ticks < maxTicks) {
    const instr0 = comm.instrNs;
    const t0 = nowNs();
    simEngine.update(TICK_DT);
    const t1 = nowNs();
    tel.tickMs.push(Number((t1 - t0) - (comm.instrNs - instr0)) / 1e6);
    ticks++;
    const robots = state.get("robots") || [];
    const tasks = registry.getAllTasks();
    const idx = new Map();
    for (const t of tasks) idx.set(t.id, t);
    tel.observe(robots, TICK_DT, state.get("simTimeSeconds") || 0, idx);
    if (ticks % 200 === 0) tel.heapMax = Math.max(tel.heapMax, process.memoryUsage().heapUsed);
    // Flush on the regular cadence, and immediately once the engine has
    // scheduled a finish (so the run ends on the same tick every time).
    if (ticks % FLUSH_EVERY === 0 || simEngine.finishedRunId === runId) await flush();
  }
  await flush();
  if (simLifecycle.getState() === "RUNNING") {
    // Safety net only (should never trigger): end as operator stop.
    simLifecycle.stop();
  }

  const record = mods.getArchivedRuns().find(r => r.runId === runId) || null;
  const tasks = registry.getAllTasks();
  const wlF = workloadList(mods, cfg.system);
  fairness.workloadFinal = sha(wlF.map(t => t.slice(0, 6)));
  fairness.workloadFinalCount = wlF.length;
  fairness.faults = tel.faults.map(f => `${f.t}:${f.type}`);

  const cpu = process.cpuUsage(cpu0);
  const wallS = Number(nowNs() - wall0) / 1e9;
  const simTime = state.get("simTimeSeconds") || 0;
  const telemetry = tel.summary(simTime);
  const timing = taskTiming(tasks);
  const am = record?.architectureMetrics || null;
  const completed = record?.performance?.tasksCompleted ?? tasks.filter(t => t.status === "COMPLETED").length;

  // Messages: robot-originated peer messages (decentralized/ACE) or
  // uplink reports + downlink commands (centralized).
  const messages = cfg.system === "centralized"
    ? {
        kind: "central",
        uplink_msgs: am?.communication?.uplinkMessages ?? null,
        downlink_cmds: am?.communication?.downlinkCommands ?? comm.downlinkCmds,
        dropped: am?.communication?.droppedCommands ?? null,
        total_msgs: (am?.communication?.uplinkMessages || 0) + (am?.communication?.downlinkCommands || 0),
        uplink_bytes_est: Math.round(tel.uplinkBytes),
        downlink_bytes: comm.downlinkBytes,
        total_bytes: Math.round(tel.uplinkBytes) + comm.downlinkBytes
      }
    : {
        kind: "peer",
        robot_msgs: comm.peerSends,
        robot_bytes: comm.peerBytes,
        robot_deliveries: comm.peerDeliveries,
        system_msgs: comm.peerSendsSystem,
        system_bytes: comm.peerBytesSystem,
        coordination_msgs: am?.communication?.coordinationMessages ?? null,
        dropped: am?.communication?.droppedMessages ?? null,
        total_msgs: comm.peerSends,
        total_bytes: comm.peerBytes,
        by_type: { ...comm.byType }
      };

  const tickStats = describe(tel.tickMs);
  const out = {
    run_id: runId,
    harness: HARNESS_VERSION,
    label: cfg.label || null,
    src: mods.src,
    kind,
    system: cfg.system,
    scenario: cfg.scenario,
    fleet_size: cfg.fleet,
    seed: cfg.seed,
    configVersion: mods.CONFIG_VERSION,
    timestamp: new Date().toISOString(),
    wall_s: r3(wallS),
    cpu_s: r3((cpu.user + cpu.system) / 1e6),
    ticks,
    sim_time_s: r3(simTime),
    duration_limit_s: limit,
    duration_mode: cfg.duration ?? "scenario",
    timeline_scale: state.getRunConfig()?.timeline_scale ?? null,
    end_reason: record?.endReason || state.getRunConfig()?.end_reason || null,
    verdict: record?.verdict || null,
    record: record ? {
      performance: record.performance,
      summary: record.summary,
      architectureMetrics: record.architectureMetrics,
      experimentResult: record.experimentResult ? { verdict: record.experimentResult.verdict, kind: record.experimentResult.kind || null, criteria: record.experimentResult.criteria || null } : null,
      mapProfile: record.mapProfile,
      worldSize: record.worldSize,
      controller: record.controller
    } : null,
    telemetry: {
      ...telemetry,
      tasks: timing,
      messages,
      messages_per_completed_task: completed > 0 ? r3(messages.total_msgs / completed) : null,
      bytes_per_completed_task: completed > 0 ? r3(messages.total_bytes / completed) : null,
      cpu_ms_per_tick: tickStats,
      heap_mb: { start: r3(heap0 / 1048576), max: r3(Math.max(tel.heapMax, process.memoryUsage().heapUsed) / 1048576), end: r3(process.memoryUsage().heapUsed / 1048576) }
    },
    fairness
  };
  // Determinism digest: every simulated outcome, no wall-clock values.
  out.det_digest = sha(stripWall({
    sim: out.sim_time_s, ticks, end: out.end_reason,
    perf: record?.performance, summary: record?.summary, am,
    tel: { ...telemetry }, tasks: timing.per_task,
    msgs: { ...messages }
  }));
  simLifecycle.reset();
  simEngine.pause();
  return out;
}

/** Compares a run's fairness fingerprint to a reference; returns list of differing fields. */
export function fairnessDiff(ref, cur) {
  const diffs = [];
  const cmp = (k, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ field: k, ref: a, cur: b }); };
  cmp("map.hash", ref.map.hash, cur.map.hash);
  cmp("map.profile", ref.map.profile, cur.map.profile);
  cmp("robotCount", ref.robotCount, cur.robotCount);
  cmp("robots(spawn+speed)", ref.robots, cur.robots);
  cmp("workloadInitial", ref.workloadInitial, cur.workloadInitial);
  cmp("workloadInitialCount", ref.workloadInitialCount, cur.workloadInitialCount);
  cmp("workloadFinalCount", ref.workloadFinalCount, cur.workloadFinalCount);
  cmp("workloadFinal", ref.workloadFinal, cur.workloadFinal);
  cmp("scheduled", ref.scheduled, cur.scheduled);
  cmp("faults", ref.faults, cur.faults);
  cmp("durationLimit", ref.durationLimit, cur.durationLimit);
  return diffs;
}
