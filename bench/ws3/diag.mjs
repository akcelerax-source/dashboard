#!/usr/bin/env node
// WS3 diagnostic: runs one configuration and prints robot snapshots when no
// task has completed for STALL seconds (gridlock inspection). Read-only.
//   SRC=zz-ws3 SYSTEM=ace FLEET=10 SCENARIO=S02 SEED=1 STALL=40 node bench/ws3/diag.mjs
import { loadSim, runOne } from "../lib.js";

const env = process.env;
const SRC = env.SRC || "zz-ws3";
const origLog = console.log;
if (!env.VERBOSE) console.log = console.info = console.debug = console.warn = () => {};
const say = (...a) => process.stdout.write(a.join(" ") + "\n");
const mods = await loadSim(SRC);
const STALL = Number(env.STALL || 40);
let lastDone = 0, lastT = 0, printed = 0;
const origUpdate = mods.simEngine.update.bind(mods.simEngine);
mods.simEngine.update = function (dt) {
  const out = origUpdate(dt);
  const t = mods.state.get("simTimeSeconds") || 0;
  const reg = env.SYSTEM === "centralized" ? mods.taskManager : mods.decentralizedFleet.taskRegistry;
  const done = reg.getCompletedCount();
  if (done !== lastDone) { lastDone = done; lastT = t; }
  if (t - lastT > STALL && printed < Number(env.MAXPRINT || 2)) {
    printed++;
    lastT = t;
    say(`--- stall at t=${t.toFixed(1)} done=${done} active=${reg.getActiveTasks().length}`);
    for (const r of mods.state.get("robots") || []) {
      if (!r.currentTaskId && !r.parkingBay && !r._maneuver && r.status === "IDLE") continue;
      const a = mods.decentralizedFleet.getAgent(r.id);
      const tr = a ? a.localDecisionTrace.slice(0, 3).map(d => `${d.decision}:${d.reason.slice(0, 70)}`).join(" || ") : "";
      say(`${r.id} (${Math.round(r.x)},${Math.round(r.y)}) ${r.status} task=${r.currentTaskId} picked=${r.pickedUp} race=${r.raceState} stall=${(r.stalledDuration || 0).toFixed(1)} wfn=${r.waitingForNode} tgt=(${Math.round(r.targetX)},${Math.round(r.targetY)}) bay=${r.parkingBay ? r.parkingBay.kind : ""} man=${r._maneuver ? r._maneuver.phase : ""}`);
      say(`    ${tr}`);
    }
  }
  return out;
};
const rec = await runOne(mods, { system: env.SYSTEM || "ace", scenario: env.SCENARIO || "S01", fleet: Number(env.FLEET || 10), seed: Number(env.SEED || 1), kind: "scenario", duration: "scenario" });
const p = rec.record?.performance || {};
say(`end ${rec.end_reason} sim=${rec.sim_time_s} done=${p.tasksCompleted}/${p.tasksTotal} thr=${p.throughputPerHour} near=${rec.telemetry.near_collision_events}`);
console.log = origLog;
process.exit(0);
