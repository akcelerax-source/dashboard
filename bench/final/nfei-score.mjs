// Scores NFEI v2.1 (src/data/nfei.js computeNfeiGroup) for every paired group in the
// given jsonl files. Output: JSON lines {run_id, system, scenario, fleet, seed, src, nfei, status}.
// usage: node bench/final/nfei-score.mjs out.json a.jsonl [b.jsonl ...]
import fs from "node:fs";
import { computeNfeiGroup, pairingKey } from "../../src/data/nfei.js";

const [outFile, ...files] = process.argv.slice(2);
const runs = [];
for (const f of files) for (const l of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
  const x = JSON.parse(l);
  runs.push({
    ...x.record,
    runId: x.run_id, systemMode: x.system, scenarioCode: x.scenario, fleetSize: x.fleet_size, seed: x.seed,
    runKind: x.kind === "aceTest" ? "test" : "scenario", endReason: x.end_reason,
    mapProfile: x.record.mapProfile, durationLimitSeconds: x.duration_limit_s,
    // group per source tree and label so before (ABLATE=all) and after runs are never mixed in one reference
    configVersion: `${x.configVersion}|${x.src}|${x.label}`,
    _meta: { src: x.src, label: x.label }
  });
}
const groups = new Map();
for (const r of runs) { const k = pairingKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
const out = [];
for (const [k, g] of groups) {
  const res = computeNfeiGroup(g, { key: k });
  for (const r of g) {
    const x = res.results[r.runId];
    out.push({ run_id: r.runId, system: r.systemMode, scenario: r.scenarioCode, fleet: r.fleetSize, seed: r.seed, src: r._meta.src,
      nfei: x?.value ?? null, status: x?.status ?? null, components: res.componentsUsed });
  }
}
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`scored ${out.length} runs in ${groups.size} groups`);
