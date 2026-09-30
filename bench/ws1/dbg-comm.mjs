import { loadSim, runOne } from "../lib.js";
const [sc, fl, sd, rid, tt] = process.argv.slice(2);
const mods = await loadSim("zz-ws1");
const { simEngine, state, decentralizedFleet } = mods;
const orig = simEngine.update.bind(simEngine); let done = false;
simEngine.update = function (dt) { const o = orig(dt); const t = state.get("simTimeSeconds"); if (t > +tt + 0.05) { process.exit(0); }
  if (!done && t >= +tt) { done = true; const ag = decentralizedFleet.agents.get(rid); const now = ag.now();
    const rows = [...ag.peerCache.values()].map(p => [p.id, Math.round(now - p.lastSeen), p.hbMs, p.ws1Link && +(p.ws1Link.lost/(p.ws1Link.lost+p.ws1Link.recv)).toFixed(2)]).filter(r => r[1] > (r[2] ?? 250) + 250);
    console.log("loss", ag._ws1InboundLoss(), "hb", ag._ws1HeartbeatMs(), "stale peers", JSON.stringify(rows.slice(0, 12)), "det", ag.sensorFrame.detections.map(d => d.id + (ag.peerCache.has(d.id) ? "" : "!")).join(",")); }
  return o; };
await runOne(mods, { system: "ace", scenario: sc, fleet: +fl, seed: +sd, kind: "scenario", duration: process.env.DUR ? +process.env.DUR : "scenario", label: "dbg" });
process.exit(0);
