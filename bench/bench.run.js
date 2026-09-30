// ==========================================================================
// NODEX benchmark runner (vitest). Not matched by the default test glob
// (*.test.js), so `npx vitest run` never runs it. Run with:
//   npx vitest run --config bench/vitest.config.js
// Parameters (env vars):
//   SRC        src | zz-base                          (default src)
//   SYSTEMS    comma list: centralized,decentralized,ace (default all three)
//   FLEETS     comma list of 3,10,50,100             (default 3,10)
//   SCENARIOS  comma list, ranges ok: S01-S14,A01-A12 (default S01)
//   SEEDS      comma list of integers                  (default 18427)
//   KIND       scenario | aceTest (auto from code prefix when omitted)
//   DURATION   scenario | dashboard | <seconds>       (default scenario)
//   OUT        JSONL output path                       (default bench/results/run.jsonl)
//   LABEL      free text label stored on each line
//   SHARD      i/N  - run only matrix entries with index % N == i
//   SKIP_DONE  1 - skip entries already present in OUT (resume)
//   MAX_FLEET_SEEDS  e.g. "100:2" - cap the seed count for a fleet size
// ==========================================================================

import { test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadSim, runOne, fairnessDiff } from "./lib.js";

const env = process.env;
const list = (v, d) => (v ? v.split(",").map(s => s.trim()).filter(Boolean) : d);

function expandCodes(items) {
  const out = [];
  for (const it of items) {
    const m = it.match(/^([A-Z])(\d+)-[A-Z]?(\d+)$/);
    if (m) {
      for (let i = +m[2]; i <= +m[3]; i++) out.push(`${m[1]}${String(i).padStart(2, "0")}`);
    } else out.push(it);
  }
  return out;
}

const SRC = env.SRC || "src";
const SYSTEMS = list(env.SYSTEMS, ["centralized", "decentralized", "ace"]);
const FLEETS = list(env.FLEETS, ["3", "10"]).map(Number);
const SCENARIOS = expandCodes(list(env.SCENARIOS, ["S01"]));
const SEEDS = list(env.SEEDS, ["18427"]).map(Number);
const DURATION = env.DURATION ? (isNaN(+env.DURATION) ? env.DURATION : +env.DURATION) : "scenario";
const OUT = path.resolve(env.OUT || "bench/results/run.jsonl");
const LABEL = env.LABEL || null;
const [SHARD_I, SHARD_N] = (env.SHARD || "0/1").split("/").map(Number);
const seedCap = {};
for (const kv of list(env.MAX_FLEET_SEEDS, [])) { const [f, n] = kv.split(":").map(Number); seedCap[f] = n; }

// Matrix order: scenario -> fleet -> seed -> system, so the three systems for
// one (scenario, fleet, seed) run back to back and can be fairness-checked.
const matrix = [];
for (const scenario of SCENARIOS) for (const fleet of FLEETS) {
  const seeds = seedCap[fleet] ? SEEDS.slice(0, seedCap[fleet]) : SEEDS;
  for (const seed of seeds) {
    const kind = env.KIND || (scenario.startsWith("A") ? "aceTest" : "scenario");
    // ACE validation tests are ACE-only.
    const systems = kind === "aceTest" ? SYSTEMS.filter(s => s === "ace") : SYSTEMS;
    for (const system of systems) matrix.push({ scenario, fleet, seed, system, kind });
  }
}
// Shard by (scenario, fleet, seed) group so a group's systems stay together.
const groupKey = (m) => `${m.scenario}|${m.fleet}|${m.seed}`;
// Greedy longest-first balancing on an estimated cost (fleet^1.6), deterministic.
const groups = [...new Set(matrix.map(groupKey))];
const cost = (g) => Math.pow(Number(g.split("|")[1]), 1.6);
const load = new Array(SHARD_N).fill(0);
const owner = new Map();
for (const g of [...groups].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
  let k = 0;
  for (let s = 1; s < SHARD_N; s++) if (load[s] < load[k]) k = s;
  load[k] += cost(g); owner.set(g, k);
}
const mine = matrix.filter(m => owner.get(groupKey(m)) === SHARD_I);

test(`bench ${SRC} ${mine.length} runs -> ${path.basename(OUT)}`, async () => {
  const quiet = !env.VERBOSE;
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  if (quiet) { console.log = console.info = console.debug = console.warn = () => {}; }
  const say = (...a) => process.stdout.write(a.join(" ") + "\n");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const done = new Set();
  if (env.SKIP_DONE && fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); done.add(`${j.system}|${j.scenario}|${j.fleet_size}|${j.seed}`); } catch {}
    }
  }
  const mods = await loadSim(SRC);
  const refs = new Map(); // group -> {system, fairness}
  let i = 0;
  const t0 = Date.now();
  for (const m of mine) {
    i++;
    if (done.has(`${m.system}|${m.scenario}|${m.fleet}|${m.seed}`)) continue;
    let rec;
    try {
      rec = await runOne(mods, { ...m, duration: DURATION, label: LABEL });
    } catch (err) {
      rec = { error: String(err && err.stack || err), src: SRC, system: m.system, scenario: m.scenario, fleet_size: m.fleet, seed: m.seed, label: LABEL, timestamp: new Date().toISOString() };
    }
    if (!rec.error) {
      const g = groupKey(m);
      if (!refs.has(g)) refs.set(g, { system: m.system, fairness: rec.fairness });
      else {
        const ref = refs.get(g);
        rec.fairness_ref_system = ref.system;
        rec.fairness_diffs = fairnessDiff(ref.fairness, rec.fairness);
        if (rec.fairness_diffs.length) say(`  FAIRNESS ${g} ${ref.system} vs ${m.system}: ${rec.fairness_diffs.map(d => d.field).join(", ")}`);
      }
    }
    fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
    const p = rec.record?.performance;
    say(`[${SRC} ${SHARD_I}/${SHARD_N}] ${i}/${mine.length} ${m.system.padEnd(13)} ${m.scenario} n=${String(m.fleet).padEnd(3)} seed=${m.seed} `
      + (rec.error ? `ERROR ${rec.error.split("\n")[0]}` : `${rec.end_reason} sim=${rec.sim_time_s}s done=${p?.tasksCompleted}/${p?.tasksTotal} wall=${rec.wall_s}s tick=${rec.telemetry.cpu_ms_per_tick.mean}ms`)
      + ` (elapsed ${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  Object.assign(console, saved);
}, 7 * 24 * 3600 * 1000);
