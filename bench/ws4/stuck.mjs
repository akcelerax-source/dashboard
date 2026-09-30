#!/usr/bin/env node
// WS4 gridlock probe (plain node, read-only): runs ONE configuration tick by
// tick like bench/lib.js and prints, every PERIOD sim seconds, the task
// holders that have not moved for > STILL seconds (status, flags, position).
//   SRC=zz-ws4 SYSTEM=centralized FLEET=10 SCENARIO=S02 SEED=18427 node bench/ws4/stuck.mjs
import { loadSim } from "../lib.js";

const env = process.env;
const SRC = env.SRC || "zz-ws4";
const PERIOD = +(env.PERIOD || 60), STILL = +(env.STILL || 20);
const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
console.log = console.info = console.debug = console.warn = () => {};
const say = (...a) => process.stdout.write(a.join(" ") + "\n");
const mods = await loadSim(SRC);
const { state, simEngine, simLifecycle, systemManager } = mods;
simLifecycle.reset();
state.set("seed", +(env.SEED || 18427));
state.set("simSpeed", 1.0);
systemManager.switchSystem(env.SYSTEM || "centralized");
state.set("robotCount", +(env.FLEET || 10));
state.set("simTestType", "scenario");
state.set("selectedScenario", env.SCENARIO || "S02");
const unsub = state.subscribe("simActiveConfig", (v) => {
  if (!v || v.__ws4) return;
  if (v.scenarioDurationSeconds) v.durationSeconds = v.scenarioDurationSeconds;
  v.__ws4 = true;
});
await simLifecycle.start();
unsub();
clearInterval(simEngine.fallbackIntervalId);
const last = new Map();
let ticks = 0, nextPrint = PERIOD;
while (simLifecycle.getState() === "RUNNING" && ticks < 20000) {
  simEngine.update(0.1);
  ticks++;
  const t = state.get("simTimeSeconds") || 0;
  const robots = state.get("robots") || [];
  for (const r of robots) {
    const l = last.get(r.id);
    if (!l || Math.hypot(r.x - l.x, r.y - l.y) > 0.5) last.set(r.id, { x: r.x, y: r.y, t });
  }
  if (t >= nextPrint) {
    nextPrint += PERIOD;
    const tasks = (env.SYSTEM === "centralized" || !env.SYSTEM ? mods.taskManager : mods.decentralizedFleet.taskRegistry).getAllTasks();
    const done = tasks.filter(x => x.status === "COMPLETED").length;
    const stuck = robots.filter(r => (r.currentTaskId || r._maneuver || r.parkingBay) && t - last.get(r.id).t > STILL);
    say(`t=${t.toFixed(0)} done=${done}/${tasks.length} holders=${robots.filter(r => r.currentTaskId).length} stuck>${STILL}s=${stuck.length}`);
    for (const r of stuck) {
      say(`   ${r.id} ${r.status} task=${r.currentTaskId} still=${(t - last.get(r.id).t).toFixed(0)}s at (${r.x.toFixed(0)},${r.y.toFixed(0)}) tgt=(${(r.targetX ?? 0).toFixed(0)},${(r.targetY ?? 0).toFixed(0)}) `
        + `stalled=${(r.stalledDuration || 0).toFixed(1)} yield=${!!r.isYielding} halt=${!!r.centralHalt} sched=${!!r.scheduleHold} man=${r._maneuver ? r._maneuver.phase : "-"} `
        + `wfn=${r.waitingForNode || "-"} handling=${r.handling || "-"} picked=${r.pickedUp} race=${r.raceState || "-"}`);
    }
  }
  if (ticks % 20 === 0) await new Promise(r => setTimeout(r, 0));
}
Object.assign(console, saved);
process.exit(0);
