#!/usr/bin/env node
// ==========================================================================
// WS3 allocation telemetry probe (read-only observer, plain node).
//
// Runs configurations through the normal harness (bench/lib.js runOne) and,
// after every simEngine.update, reads robot / task state to measure the task
// allocation quality of any system:
//   - empty travel per task (odometer and time from assignment to pickup),
//     straight-line and graph distance robot -> pickup at assignment
//   - loaded leg time (pickup -> complete) and execution time (assign -> complete)
//   - "slot gap": task slots that could run (open task, free admission slot,
//     idle eligible robot) but are not assigned, in slot-seconds
//   - bids per award (peer systems), workload imbalance (tasks per robot)
// It never changes behaviour (reads state only).
//
//   SRC=zz-ws3 SYSTEMS=ace FLEETS=50 SCENARIOS=S01 SEEDS=1 OUT=... node bench/ws3/probe.mjs
// ==========================================================================
import fs from "node:fs";
import path from "node:path";
import { loadSim, runOne } from "../lib.js";

const env = process.env;
const list = (v, d) => (v ? v.split(",").map(s => s.trim()).filter(Boolean) : d);
function expandCodes(items) {
  const out = [];
  for (const it of items) {
    const m = it.match(/^([A-Z])(\d+)-[A-Z]?(\d+)$/);
    if (m) for (let i = +m[2]; i <= +m[3]; i++) out.push(`${m[1]}${String(i).padStart(2, "0")}`);
    else out.push(it);
  }
  return out;
}
const SRC = env.SRC || "zz-ws3";
const SYSTEMS = list(env.SYSTEMS, ["ace"]);
const FLEETS = list(env.FLEETS, ["10"]).map(Number);
const SCENARIOS = expandCodes(list(env.SCENARIOS, ["S01"]));
const SEEDS = list(env.SEEDS, ["1"]).map(Number);
const OUT = env.OUT ? path.resolve(env.OUT) : null;

const origLog = console.log;
if (!env.VERBOSE) console.log = console.info = console.debug = console.warn = () => {};
const say = (...a) => process.stdout.write(a.join(" ") + "\n");

const mods = await loadSim(SRC);
const plannerMod = await import(new URL(`../../${SRC}/core/centralized/GlobalPlanner.js`, import.meta.url).href);
const admission = await import(new URL(`../../${SRC}/core/admission-control.js`, import.meta.url).href);
const planner = new plannerMod.GlobalPlanner();
const FAILED = ["ERROR", "error", "failed"];
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

let obs = null;
const origUpdate = mods.simEngine.update.bind(mods.simEngine);
mods.simEngine.update = function (dt) {
  const out = origUpdate(dt);
  if (obs) obs.tick(dt);
  return out;
};

class AllocObserver {
  constructor(system, fleet) {
    this.system = system; this.fleet = fleet;
    this.rs = new Map();
    this.claims = [];     // { task, robot, t, euclid, graph, idleFor }
    this.byTask = new Map();
    this.slotGap = 0;
    this._n = 0;
    this.allocStats = {};
    this.noTaskDist = 0;      // px driven without a task (return / standby legs, clearance moves)
    this.nearNoTask = 0;      // near-collision pair onsets where one robot has no task
    this.nearPrev = new Set();
    this.cap = admission.concurrentTaskLimit(fleet);
  }
  registry() { return this.system === "centralized" ? mods.taskManager : mods.decentralizedFleet.taskRegistry; }
  tick(dt) {
    const st = mods.state;
    const t = st.get("simTimeSeconds") || 0;
    const robots = st.get("robots") || [];
    const reg = this.registry();
    const tasks = reg.getAllTasks();
    const tIdx = new Map(tasks.map(x => [x.id, x]));
    let idleEligible = 0;
    const near = new Set();
    for (let i = 0; i < robots.length; i++) {
      const a = robots[i];
      for (let j = i + 1; j < robots.length; j++) {
        const b = robots[j];
        if (Math.abs(a.x - b.x) >= 32 || Math.abs(a.y - b.y) >= 32) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) >= 32) continue;
        const sa = this.rs.get(a.id), sb = this.rs.get(b.id);
        const moving = (sa && (sa.px !== a.x || sa.py !== a.y)) || (sb && (sb.px !== b.x || sb.py !== b.y));
        if (!moving) continue;
        if (!a.currentTaskId || !b.currentTaskId) near.add(a.id + "|" + b.id);
      }
    }
    for (const k of near) if (!this.nearPrev.has(k)) this.nearNoTask++;
    this.nearPrev = near;
    for (const r of robots) {
      let s = this.rs.get(r.id);
      if (!s) { s = { task: null, idleSince: 0, done: 0, px: r.x, py: r.y }; this.rs.set(r.id, s); }
      if (!r.currentTaskId) this.noTaskDist += Math.hypot(r.x - s.px, r.y - s.py);
      s.px = r.x; s.py = r.y;
      const tid = r.currentTaskId || null;
      if (tid !== s.task) {
        if (s.task) {
          const c = this.byTask.get(s.task);
          const tk = tIdx.get(s.task);
          if (c && tk && tk.status === "COMPLETED" && c.robot === r.id) { c.done = t; s.done++; }
          s.idleSince = t;
        }
        if (tid) {
          const tk = tIdx.get(tid);
          const c = { task: tid, robot: r.id, t, odo: r.traveledDistance || 0, idleFor: t - s.idleSince };
          if (tk && tk.pickup) {
            c.euclid = Math.hypot(tk.pickup.x - r.x, tk.pickup.y - r.y);
            const p = planner.planPath({ x: r.x, y: r.y }, { x: tk.pickup.x, y: tk.pickup.y });
            c.graph = planner.calculatePathLength(p);
          }
          c.bids = tk?.bidRound?.bids ?? null;
          this.claims.push(c);
          this.byTask.set(tid, c);
        }
        s.task = tid;
      }
      if (tid && r.handling && r.handling.kind === "LOADING") {
        const c = this.byTask.get(tid);
        if (c && c.robot === r.id && c.pick === undefined) { c.pick = t; c.emptyPx = (r.traveledDistance || 0) - c.odo; }
      }
      if (!tid && !FAILED.includes(r.status) && !r.serviceState && !r.handling
          && (r.status === "IDLE" || r.parkingBay) && !(r.battery < 20)) idleEligible++;
    }
    if (this.system !== "centralized" && (++this._n % 20 === 0)) {
      const agg = {};
      for (const a of mods.decentralizedFleet.agents.values()) {
        for (const [k, v] of Object.entries((a.alloc && a.alloc.stats) || {})) agg[k] = (agg[k] || 0) + v;
      }
      this.allocStats = agg;
    }
    const active = reg.getActiveTasks().length;
    const open = reg.getUnassignedTasks().length;
    const free = Math.max(0, (Number.isFinite(this.cap) ? this.cap : Infinity) - active);
    this.slotGap += Math.min(open, free, idleEligible) * dt;
  }
  summary() {
    const c = this.claims;
    const done = c.filter(x => x.done !== undefined);
    const picked = c.filter(x => x.pick !== undefined);
    const perRobot = [...this.rs.values()].map(s => s.done);
    const m = mean(perRobot) || 0;
    const sd = Math.sqrt(mean(perRobot.map(v => (v - m) ** 2)) || 0);
    const bids = c.map(x => x.bids).filter(v => typeof v === "number");
    return {
      claims: c.length,
      euclid_pick: r2(mean(c.map(x => x.euclid).filter(Number.isFinite))),
      graph_pick: r2(mean(c.map(x => x.graph).filter(Number.isFinite))),
      empty_px: r2(mean(picked.map(x => x.emptyPx))),
      empty_s: r2(mean(picked.map(x => x.pick - x.t))),
      loaded_s: r2(mean(done.filter(x => x.pick !== undefined).map(x => x.done - x.pick))),
      exec_s: r2(mean(done.map(x => x.done - x.t))),
      idle_before_claim_s: r2(mean(c.map(x => x.idleFor))),
      slot_gap_s: r2(this.slotGap),
      bids_per_award: r2(mean(bids)),
      tasks_per_robot_cv: r2(m ? sd / m : null),
      tasks_per_robot_max: Math.max(0, ...perRobot),
      notask_px: Math.round(this.noTaskDist),
      alloc_stats: this.allocStats,
      near_notask: this.nearNoTask
    };
  }
}

if (OUT) fs.mkdirSync(path.dirname(OUT), { recursive: true });
for (const scenario of SCENARIOS) for (const fleet of FLEETS) for (const seed of SEEDS) for (const system of SYSTEMS) {
  obs = new AllocObserver(system, fleet);
  const t0 = Date.now();
  const rec = await runOne(mods, { system, scenario, fleet, seed, kind: "scenario", duration: env.DURATION || "scenario", label: env.LABEL || "ws3probe" });
  const a = obs.summary();
  obs = null;
  const p = rec.record?.performance || {};
  const tel = rec.telemetry;
  const row = {
    src: SRC, ablate: env.NODEX_ABLATE || "", system, scenario, fleet, seed, end: rec.end_reason, sim: rec.sim_time_s,
    done: p.tasksCompleted, total: p.tasksTotal, thr: p.throughputPerHour, cycle: tel.tasks.cycle_s.mean,
    alloc_lat: tel.tasks.allocation_latency_s.mean, near: tel.near_collision_events, stops: tel.stops_per_robot,
    wait_frac: tel.waiting_fraction_of_busy, msgs: tel.messages.total_msgs, digest: rec.det_digest, ...a, wall: Math.round((Date.now() - t0) / 100) / 10
  };
  say(JSON.stringify(row));
  if (OUT) fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
}
console.log = origLog;
process.exit(0);
