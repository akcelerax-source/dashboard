import { loadSim, runOne } from "../lib.js";
const mods = await loadSim(process.env.SRC || "zz-ws1");
const t0 = Date.now();
const rec = await runOne(mods, { system: "ace", scenario: "S01", fleet: 10, seed: 1, kind: "scenario", duration: "scenario", label: "try" });
console.log(rec.end_reason, rec.sim_time_s, rec.record.performance, (Date.now()-t0)/1000, rec.det_digest);
process.exit(0);
