#!/usr/bin/env node
// Determinism check: every repeated (src, system, scenario, fleet, seed,
// duration mode) in the given JSONL files must have the same det_digest
// (a hash of all simulated outcomes, excluding wall-clock timings).
//   node bench/check-determinism.mjs bench/results/determinism.jsonl [more.jsonl]
import fs from "node:fs";

const groups = new Map();
for (const f of process.argv.slice(2)) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.error) continue;
    const k = [r.src, r.system, r.scenario, r.fleet_size, r.seed, r.duration_mode].join("|");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.det_digest);
  }
}
let repeated = 0, bad = 0;
for (const [k, d] of groups) {
  if (d.length < 2) continue;
  repeated++;
  const same = d.every(x => x === d[0]);
  if (!same) bad++;
  console.log(`${same ? "SAME" : "DIFF"}  ${k}  x${d.length}  ${[...new Set(d)].join(",")}`);
}
console.log(`\n${repeated} repeated configurations, ${bad} non-deterministic`);
process.exit(bad ? 1 : 0);
