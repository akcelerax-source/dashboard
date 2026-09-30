#!/usr/bin/env node
// WS3: classifies near-collision onsets (< 32 px, one robot moving) by what
// the two robots were doing. Read-only.
//   SRC=zz-ws3 FLEET=50 SCENARIO=S01 SEED=1 node bench/ws3/nearlog.mjs
import { loadSim, runOne } from "../lib.js";

const env = process.env;
const origLog = console.log;
if (!env.VERBOSE) console.log = console.info = console.debug = console.warn = () => {};
const say = (...a) => process.stdout.write(a.join(" ") + "\n");
const mods = await loadSim(env.SRC || "zz-ws3");
const M = mods.MapGeometryEngine;
const prevPos = new Map();
let prevNear = new Set();
const kinds = new Map();
const role = (r) => {
  if (r.currentTaskId) return r.handling ? "handling" : (r.pickedUp ? "loaded" : "toPickup");
  if (r._maneuver) return "maneuver";
  if (r.parkingBay) return "return:" + r.parkingBay.kind;
  return M.isOffLane(r.x, r.y) ? "parked" : "idleOnLane";
};
const origUpdate = mods.simEngine.update.bind(mods.simEngine);
mods.simEngine.update = function (dt) {
  const out = origUpdate(dt);
  const robots = mods.state.get("robots") || [];
  const near = new Set();
  for (let i = 0; i < robots.length; i++) for (let j = i + 1; j < robots.length; j++) {
    const a = robots[i], b = robots[j];
    if (Math.hypot(a.x - b.x, a.y - b.y) >= 32) continue;
    const pa = prevPos.get(a.id), pb = prevPos.get(b.id);
    const ma = pa && (pa.x !== a.x || pa.y !== a.y), mb = pb && (pb.x !== b.x || pb.y !== b.y);
    if (!ma && !mb) continue;
    const k = a.id + "|" + b.id;
    near.add(k);
    if (!prevNear.has(k)) {
      const kk = [role(a) + (ma ? "*" : ""), role(b) + (mb ? "*" : "")].sort().join(" + ");
      kinds.set(kk, (kinds.get(kk) || 0) + 1);
      if (env.DETAIL) say(`t=${(mods.state.get("simTimeSeconds") || 0).toFixed(1)} ${a.id}(${Math.round(a.x)},${Math.round(a.y)}) ${role(a)} ${b.id}(${Math.round(b.x)},${Math.round(b.y)}) ${role(b)} d=${Math.hypot(a.x - b.x, a.y - b.y).toFixed(1)}`);
    }
  }
  prevNear = near;
  for (const r of robots) prevPos.set(r.id, { x: r.x, y: r.y });
  return out;
};
const rec = await runOne(mods, { system: env.SYSTEM || "ace", scenario: env.SCENARIO || "S01", fleet: Number(env.FLEET || 50), seed: Number(env.SEED || 1), kind: "scenario", duration: "scenario" });
const p = rec.record?.performance || {};
say(`${env.SYSTEM || "ace"} ${env.SCENARIO} n=${env.FLEET} seed=${env.SEED} ablate=${env.NODEX_ABLATE || ""} done=${p.tasksCompleted}/${p.tasksTotal} thr=${p.throughputPerHour} near=${rec.telemetry.near_collision_events}`);
for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) say(`  ${v}  ${k}`);
console.log = origLog;
process.exit(0);
