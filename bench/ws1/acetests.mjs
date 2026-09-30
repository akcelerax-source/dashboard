// WS1: ACE test verdicts vs baseline (bench/results/baseline_acetests.jsonl).
//   node bench/ws1/acetests.mjs <candidate.jsonl>
import fs from "node:fs";
const read = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(j => !j.error);
const base = new Map(read("bench/results/baseline_acetests.jsonl").map(j => [`${j.scenario}|${j.fleet_size}`, j]));
let pass = 0, n = 0, regress = [];
for (const j of read(process.argv[2]).sort((a, b) => (a.fleet_size - b.fleet_size) || a.scenario.localeCompare(b.scenario))) {
  const b = base.get(`${j.scenario}|${j.fleet_size}`);
  n++; if (j.verdict === "PASS") pass++;
  const bad = (j.record?.experimentResult?.criteria || []).filter(c => c.pass !== true).map(c => `${c.name.slice(0, 50)}=${c.actual}`);
  const p = j.record?.performance || {};
  const tag = b && b.verdict === "PASS" && j.verdict !== "PASS" ? " REGRESSION" : "";
  if (tag) regress.push(`${j.scenario}/${j.fleet_size}`);
  console.log(`${j.scenario} n=${j.fleet_size} ${j.verdict} (base ${b?.verdict}) done ${p.tasksCompleted}/${p.tasksTotal} t=${j.sim_time_s} (base ${b?.sim_time_s})${tag}${bad.length ? " | " + bad.join("; ") : ""}`);
}
console.log(`PASS ${pass}/${n}; regressions: ${regress.join(", ") || "none"}`);
