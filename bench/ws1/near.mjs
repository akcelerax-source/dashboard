// WS1: list near-collision events (pair enters < 32 px while one moves), observation only.
//   node bench/ws1/near.mjs <scenario> <fleet> <seed> [src] [system]
import { loadSim, runOne } from "../lib.js";
const [scenario = "S13", fleetS = "10", seedS = "1", src = "zz-ws1", system = "ace"] = process.argv.slice(2);
const mods = await loadSim(src);
const { simEngine, state, decentralizedFleet } = mods;
const orig = simEngine.update.bind(simEngine);
let prev = new Set();
const ev = [];
simEngine.update = function (dt) {
  const out = orig(dt);
  const t = state.get("simTimeSeconds") || 0;
  const rs = state.get("robots") || [];
  const near = new Set();
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    const mv = (r) => (r.velocity || 0) > 0 && !["ERROR","error","failed"].includes(r.status);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < 32 && (mv(a) || mv(b))) {
      const k = a.id + "|" + b.id; near.add(k);
      if (!prev.has(k)) {
        const ag = (r) => decentralizedFleet.agents.get(r.id)?.localState || r;
        const desc = (r) => { const l = ag(r); const dx=(l.targetX??l.x)-l.x, dy=(l.targetY??l.y)-l.y; return `${r.id}:${l.status}/${l.raceState}/v${(r.velocity||0).toFixed(2)}/tv${l.targetVelocity}/h(${Math.round(dx)},${Math.round(dy)})/${l.currentTaskId||"-"}${l._maneuver?"/man":""}`; };
        ev.push(`${t.toFixed(1)} d=${d.toFixed(1)} (${Math.round(a.x)},${Math.round(a.y)}) ${desc(a)} | ${desc(b)}`);
      }
    }
  }
  prev = near;
  return out;
};
await runOne(mods, { system, scenario, fleet: +fleetS, seed: +seedS, kind: scenario.startsWith("A") ? "aceTest" : "scenario", duration: "scenario", label: "ws1near" });
console.log(ev.length + " events");
const byPair = {}; for (const e of ev) { const m = e.match(/ (R\d+):.* \| (R\d+):/); const k = m ? m[1] + "|" + m[2] : "?"; byPair[k] = (byPair[k] || 0) + 1; }
const top = Object.entries(byPair).sort((a, b) => b[1] - a[1]); console.log("pairs", top.length, "top", JSON.stringify(top.slice(0, 10)));
const lim = +(process.env.LIMIT || 60);
for (const e of ev.slice(0, lim)) console.log(e);
process.exit(0);
