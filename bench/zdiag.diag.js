import { test } from "vitest";
import { loadSim, runOne } from "./lib.js";
const env = process.env;
test("diag", async () => {
  const say = (...a) => process.stdout.write(a.join(" ") + "\n");
  const saved = console.log; console.log = console.info = console.debug = console.warn = () => {};
  const mods = await loadSim("src");
  const hook = (await import("./zdiag-hook.mjs"));
  const eng = mods.simEngine;
  const om = eng._move.bind(eng);
  eng._move = (r, ...a) => { const w = om(r, ...a); r.__why = w; r.__whyT = mods.state.get("simTimeSeconds"); return w; };
  for (const system of env.SYSTEMS.split(",")) for (const sc of env.SCENARIOS.split(",")) {
    const fleet = +env.FLEET; let dumped = false; const trk = new Map();
    const orig = eng.update.bind(eng);
    eng.update = (dt) => { orig(dt);
      const t = mods.state.get("simTimeSeconds") || 0;
      hook.track(mods, trk, t); globalThis.__CM = hook.CMlist ? hook.CMlist() : [];
      if (env.TRACE && t >= +env.TRACE_FROM && t < +env.TRACE_FROM + 0.5) for (const id of env.TRACE.split(",")) { const o = (mods.state.get("robots")||[]).find(x => x.id === id); say("TR", t.toFixed(1), id, o.x.toFixed(1), o.y.toFixed(1), o.status, o.__why, o.isYielding, o.centralHalt, o.scheduleHold, o.centralHold, Math.round(o.targetX), Math.round(o.targetY), o.currentTaskId, o.pickedUp, o.handling ? "H" : "", JSON.stringify((globalThis.__CM||[]).filter(c => c.loserId === o.id || c.winnerId === o.id).map(c => [c.winnerId, c.loserId, c.reason]))); }
      if (!dumped && eng.finishedRunId === mods.state.get("runId")) { dumped = true; hook.dump(mods, system, say, t, trk); }
    };
    const rec = await runOne(mods, { system, scenario: sc, fleet, seed: +(env.SEED||3), kind: "scenario", duration: "none" });
    eng.update = orig;
    say(`## ${system} ${sc} ${fleet} end=${rec.end_reason} done=${rec.record.performance.tasksCompleted}/${rec.record.performance.tasksTotal} t=${rec.sim_time_s}`);
  }
  console.log = saved;
});
