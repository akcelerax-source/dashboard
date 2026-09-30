#!/usr/bin/env node
// ==========================================================================
// Parallel matrix launcher: runs bench/bench.run.js in N shard processes and
// merges their JSONL into one file.
//
//   node bench/run-matrix.mjs --src zz-base --out bench/results/baseline.jsonl \
//        --fleets 3,10,50,100 --scenarios S01-S14 --seeds 18427,1,2 --shards 5 \
//        [--systems centralized,decentralized,ace] [--label baseline] \
//        [--duration scenario] [--max-fleet-seeds 100:2] [--resume]
//
// Each shard writes <out>.shard<i>.jsonl (resumable with --resume); the merge
// step appends every shard line to <out> in matrix order is not required -
// analyze.py keys runs by (system, scenario, fleet, seed).
// ==========================================================================
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const flag = (name) => args.includes(`--${name}`);

const out = path.resolve(root, opt("out", "bench/results/run.jsonl"));
const shards = Number(opt("shards", "4"));
const baseEnv = {
  ...process.env,
  SRC: opt("src", "src"),
  SYSTEMS: opt("systems", "centralized,decentralized,ace"),
  FLEETS: opt("fleets", "3,10,50,100"),
  SCENARIOS: opt("scenarios", "S01-S14"),
  SEEDS: opt("seeds", "18427"),
  DURATION: opt("duration", "scenario"),
  LABEL: opt("label", ""),
  MAX_FLEET_SEEDS: opt("max-fleet-seeds", ""),
  SKIP_DONE: flag("resume") ? "1" : ""
};
if (opt("kind")) baseEnv.KIND = opt("kind");

fs.mkdirSync(path.dirname(out), { recursive: true });
const t0 = Date.now();
const procs = [];
for (let i = 0; i < shards; i++) {
  const shardOut = out.replace(/\.jsonl$/, "") + `.shard${i}.jsonl`;
  if (!flag("resume") && fs.existsSync(shardOut)) fs.unlinkSync(shardOut);
  const env = { ...baseEnv, SHARD: `${i}/${shards}`, OUT: shardOut };
  const log = fs.createWriteStream(out.replace(/\.jsonl$/, "") + `.shard${i}.log`, { flags: flag("resume") ? "a" : "w" });
  const p = spawn("npx", ["vitest", "run", "--config", "bench/vitest.config.js"], { cwd: root, env, shell: true });
  p.stdout.pipe(log); p.stderr.pipe(log);
  procs.push(new Promise(res => p.on("close", code => res({ i, code, shardOut }))));
}
const results = await Promise.all(procs);
const lines = [];
for (const r of results) {
  if (fs.existsSync(r.shardOut)) lines.push(...fs.readFileSync(r.shardOut, "utf8").split("\n").filter(Boolean));
}
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`merged ${lines.length} runs from ${shards} shards into ${path.relative(root, out)} in ${Math.round((Date.now() - t0) / 1000)} s; exit codes ${results.map(r => r.code).join(",")}`);
