#!/usr/bin/env node
// WS4 CBS probe (plain node, read-only observer): counts centralized CBS plans,
// truncated plans (MAX_CT_NODES hit) and the residual conflicts of the plan the
// planner returns (all pairs, countAllConflicts), for the zz-ws4 tree.
// Run with and without NODEX_ABLATE=fix-cbs-fallback to compare fallbacks.
//   SRC=zz-ws4 FLEETS=10 SCENARIOS=S13 SEEDS=18427 node bench/ws4/cbsprobe.mjs
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
const SRC = env.SRC || "zz-ws4";
const FLEETS = list(env.FLEETS, ["10"]).map(Number);
const SCENARIOS = expandCodes(list(env.SCENARIOS, ["S13"]));
const SEEDS = list(env.SEEDS, ["18427"]).map(Number);
const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
console.log = console.info = console.debug = console.warn = () => {};
const say = (...a) => process.stdout.write(a.join(" ") + "\n");

const mods = await loadSim(SRC);
const { CBSPlanner } = await import(new URL(`../../${SRC}/core/centralized/CBSPlanner.js`, import.meta.url).href);
const orig = CBSPlanner.prototype.plan;
let S;
CBSPlanner.prototype.plan = function (agents) {
  const res = orig.call(this, agents);
  S.plans++;
  S.agents += agents.length;
  if (res.truncated) {
    S.truncated++;
    const n = this.countAllConflicts(res.paths);
    S.residual += n;
    S.residualMax = Math.max(S.residualMax, n);
    if (n === 0) S.truncZero++;
  }
  return res;
};
let tot = { plans: 0, truncated: 0, residual: 0 };
for (const scenario of SCENARIOS) for (const fleet of FLEETS) for (const seed of SEEDS) {
  S = { plans: 0, agents: 0, truncated: 0, residual: 0, residualMax: 0, truncZero: 0 };
  const rec = await runOne(mods, { system: "centralized", scenario, fleet, seed, kind: "scenario", duration: "scenario", label: "cbsprobe" });
  const p = rec.record?.performance || {};
  say(`${scenario} n=${fleet} s=${seed} done=${p.tasksCompleted}/${p.tasksTotal} sim=${rec.sim_time_s} plans=${S.plans} avgAgents=${(S.agents / Math.max(1, S.plans)).toFixed(1)} `
    + `truncated=${S.truncated} residualConflicts(sum)=${S.residual} mean=${(S.residual / Math.max(1, S.truncated)).toFixed(2)} max=${S.residualMax} zero=${S.truncZero}`);
  tot.plans += S.plans; tot.truncated += S.truncated; tot.residual += S.residual;
}
say(`TOTAL plans=${tot.plans} truncated=${tot.truncated} residual=${tot.residual} ablate=${env.NODEX_ABLATE || ""}`);
Object.assign(console, saved);
process.exit(0);
