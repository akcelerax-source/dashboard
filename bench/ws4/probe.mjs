#!/usr/bin/env node
// WS4 quick probe (plain node): runs configurations through bench/lib.js runOne
// and prints the headline numbers plus whether the determinism digest matches
// the baseline row (bench/results/baseline.jsonl) of the same configuration.
//   SRC=zz-ws4 SYSTEMS=decentralized FLEETS=10 SCENARIOS=S01 SEEDS=1 [OUT=...] [LABEL=...] node bench/ws4/probe.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSim, runOne } from "../lib.js";

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
const SYSTEMS = list(env.SYSTEMS, ["centralized", "decentralized", "ace"]);
const FLEETS = list(env.FLEETS, ["10"]).map(Number);
const SCENARIOS = expandCodes(list(env.SCENARIOS, ["S01"]));
const SEEDS = list(env.SEEDS, ["1"]).map(Number);
const OUT = env.OUT ? path.resolve(root, env.OUT) : null;

const base = new Map();
for (const line of fs.readFileSync(path.join(root, "bench/results/baseline.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const j = JSON.parse(line);
  base.set(`${j.system}|${j.scenario}|${j.fleet_size}|${j.seed}`, j);
}
const quiet = !env.VERBOSE;
const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
if (quiet) console.log = console.info = console.debug = console.warn = () => {};
const say = (...a) => process.stdout.write(a.join(" ") + "\n");
const mods = await loadSim(SRC);
for (const scenario of SCENARIOS) for (const fleet of FLEETS) for (const seed of SEEDS) for (const system of SYSTEMS) {
  const rec = await runOne(mods, { system, scenario, fleet, seed, kind: "scenario", duration: "scenario", label: env.LABEL || "ws4probe" });
  rec.ablate = env.NODEX_ABLATE || "";
  const b = base.get(`${system}|${scenario}|${fleet}|${seed}`);
  const p = rec.record?.performance || {};
  const bp = b?.record?.performance || {};
  const t = rec.telemetry;
  const pl = rec.record?.architectureMetrics?.planning;
  say(`${system.padEnd(13)} ${scenario} n=${fleet} s=${seed} done=${p.tasksCompleted}/${p.tasksTotal} sim=${rec.sim_time_s} `
    + `(base ${bp.tasksCompleted}/${bp.tasksTotal} sim=${b?.sim_time_s}) cyc=${t.tasks.cycle_s.mean} wait=${t.waiting_fraction_of_busy} `
    + `stops=${t.stops_per_robot} near=${t.near_collision_events}${pl ? ` cbsBounded=${pl.boundedRuns}/${pl.runs}` : ""} `
    + `digest=${rec.det_digest === b?.det_digest ? "SAME" : "diff"} wall=${rec.wall_s}`);
  if (OUT) fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
}
Object.assign(console, saved);
process.exit(0);
