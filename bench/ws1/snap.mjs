// WS1: snapshot the ACE agents at given sim times (observation only).
//   node bench/ws1/snap.mjs <scenario> <fleet> <seed> <t1,t2,...> [src=zz-ws1] [system=ace]
import { loadSim, runOne } from "../lib.js";

const [scenario = "S01", fleetS = "10", seedS = "2", times = "300", src = "zz-ws1", system = "ace"] = process.argv.slice(2);
const want = times.split(",").map(Number);
const mods = await loadSim(src);
const { simEngine, state, decentralizedFleet } = mods;
const origUpdate = simEngine.update.bind(simEngine);
let k = 0;
simEngine.update = function (dt) {
  const out = origUpdate(dt);
  const t = state.get("simTimeSeconds") || 0;
  if (k < want.length && t >= want[k] - 1e-6) {
    k++;
    const lines = [`=== t=${t.toFixed(1)}`];
    for (const ag of decentralizedFleet.agents.values()) {
      const ls = ag.localState;
      const s = ag.ace?.session;
      lines.push(`${ag.robotId} ${ls.status} ${ls.raceState} risk=${ls.riskScore} in=${JSON.stringify(ls.riskInputs && { c: ls.riskInputs.conflict, u: ls.riskInputs.uncertainty, cr: ls.riskInputs.commRisk, q: ls.riskInputs.queueGrowth, cp: ls.riskInputs.cascadePressure, sc: ls.riskInputs.sensorConflict, ai: ls.riskInputs.aiConflict })} pos=(${ls.x.toFixed(0)},${ls.y.toFixed(0)}) tgt=(${(ls.targetX ?? 0).toFixed(0)},${(ls.targetY ?? 0).toFixed(0)}) task=${ls.currentTaskId} v=${ls.velocity} tv=${ls.targetVelocity} stall=${(ls.stalledDuration || 0).toFixed(1)} wfn=${ls.waitingForNode} yield=${ls.isYielding} man=${ls._maneuver?.phase || ""} claim=${ag.nodeClaim?.key || ""} sess=${s ? s.sid + "[" + s.contract.order.join(">") + "]" : ""}`);
      for (const d of ag.localDecisionTrace.slice(0, 4)) lines.push(`     ${d.simTime.toFixed(1)} ${d.decision}: ${d.reason.slice(0, 150)}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
  return out;
};
await runOne(mods, { system, scenario, fleet: +fleetS, seed: +seedS, kind: scenario.startsWith("A") ? "aceTest" : "scenario", duration: "scenario", label: "ws1snap" });
process.exit(0);
