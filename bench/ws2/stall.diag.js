// WS2 diagnostics: classify why ACE robots are not moving, per tick.
// Env: SRC, SYSTEM (default ace), SCEN, FLEET, SEED, DUMP_AT (sim s list), OUT (json), TRACE_IDS
// Run: npx vitest run --config bench/ws2/vitest.diag.config.js
import { test } from "vitest";
import fs from "node:fs";
import { loadSim, runOne } from "../lib.js";

const env = process.env;

test("stall diag", async () => {
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  console.log = console.info = console.debug = console.warn = () => {};
  const say = (...a) => process.stdout.write(a.join(" ") + "\n");
  const mods = await loadSim(env.SRC || "zz-ws2");
  const system = env.SYSTEM || "ace";
  const cfgs = [];
  for (const scen of (env.SCEN || "S01").split(",")) for (const fleet of (env.FLEET || "10").split(",")) for (const seed of (env.SEED || "2").split(",")) cfgs.push({ system, scenario: scen, fleet: +fleet, seed: +seed, kind: scen.startsWith("A") ? "aceTest" : "scenario" });
  const dumpAt = (env.DUMP_AT || "").split(",").filter(Boolean).map(Number);
  const results = [];
  for (const cfg of cfgs) {
    const eng = mods.simEngine;
    const fleet = mods.decentralizedFleet;
    const stall = {};       // category -> robot-seconds
    const yieldReasons = {};
    const lastWhy = new Map();
    const lastDecision = new Map();
    const wrapped = new WeakSet();
    const origMove = eng._move;
    eng._move = function (r, simDt, speed, robots, objects, mayEnter) {
      const why = origMove.call(this, r, simDt, speed, robots, objects, mayEnter);
      lastWhy.set(r.id, why);
      return why;
    };
    const wrapAgent = (a) => {
      if (wrapped.has(a)) return;
      wrapped.add(a);
      const ld = a.logDecision.bind(a);
      a.logDecision = (d, reason, ctx) => { lastDecision.set(a.robotId, { d, reason, t: a.simNow }); return ld(d, reason, ctx); };
      const me = a.mayEnter.bind(a);
      a.mayEnter = (nx, ny) => {
        a._diagContract = false; a._diagCorr = false;
        if (a.ace) {
          const r = a.ace.mustHoldBeforeRegion(nx, ny, a.simNow);
          a._diagContract = r;
        }
        const cb = a._corridorBlocked.bind(a);
        a._corridorBlocked = (n) => { const v = cb(n); if (v) a._diagCorr = true; return v; };
        const ok = me(nx, ny);
        a._corridorBlocked = cb;
        if (!ok) a._diagPerm = a._diagContract ? "contract" : a._diagCorr ? "corridor" : a.lastBlockedKey ? "node" : "merge";
        return ok;
      };
    };
    const origUpdate = eng.update;
    let tick = 0;
    const dumps = [];
    const prevPos = new Map();
    const prevPos2 = new Map();
    const yieldPeer = {};
    const stallSince = new Map();
    const episodes = [];
    const EP_S = +(env.EP_S || 8);
    const snapOf = (a, t) => { const ls = a.localState; return { id: a.robotId, x: Math.round(ls.x), y: Math.round(ls.y), st: ls.status, race: ls.raceState, task: ls.currentTaskId, tgt: [Math.round(ls.targetX), Math.round(ls.targetY)], man: ls._maneuver?.phase || null, why: lastWhy.get(a.robotId) || null, perm: a._diagPerm, wfn: ls.waitingForNode || null, sess: a.ace?.session ? a.ace.session.contract.order.join(">") + "@" + a.ace.session.region.nodeKey : null, dec: a.localDecisionTrace.slice(0, 3).map(x => `${x.simTime.toFixed(1)} ${x.decision}: ${x.reason}`) }; };
    eng.update = function (dt) {
      for (const a of fleet.agents.values()) wrapAgent(a);
      lastWhy.clear();
      for (const a of fleet.agents.values()) prevPos2.set(a.robotId, { x: a.localState.x, y: a.localState.y });
      const out = origUpdate.call(this, dt);
      tick++;
      const t = mods.state.get("simTimeSeconds") || 0;
      for (const a of fleet.agents.values()) {
        const ls = a.localState;
        const p = prevPos.get(a.robotId);
        const moved = p ? Math.hypot(ls.x - p.x, ls.y - p.y) > 1e-6 : true;
        prevPos.set(a.robotId, { x: ls.x, y: ls.y });
        const busy = !moved && ls.status !== "ERROR" && !ls.handling && (ls.currentTaskId || ls.parkingBay || ls._maneuver);
        if (!busy) { stallSince.delete(a.robotId); stallSince.delete(a.robotId + ":ep"); }
        else {
          if (!stallSince.has(a.robotId)) stallSince.set(a.robotId, t);
          if (t - stallSince.get(a.robotId) >= EP_S && !stallSince.get(a.robotId + ":ep") && episodes.length < 60) {
            stallSince.set(a.robotId + ":ep", 1);
            const near = [...fleet.agents.values()].filter(b => b !== a && Math.hypot(b.localState.x - ls.x, b.localState.y - ls.y) < 90).map(b => snapOf(b, t));
            episodes.push({ t: +t.toFixed(1), robot: snapOf(a, t), near });
          }
        }
        if (moved) continue;
        if (ls.status === "ERROR") continue;
        if (ls.handling) continue;
        if (!(ls.currentTaskId || ls.parkingBay || ls._maneuver)) continue;
        let cat;
        if (ls._maneuver && ls._maneuver.phase === "hold") cat = "maneuver_hold";
        else if (ls.status === "WAITING" || ls.isYielding) {
          const d = lastDecision.get(a.robotId);
          if (d && d.d === "QUEUE_HOLD" && t - d.t < 0.2) cat = "queue_hold";
          else if (d && (d.d === "YIELD_WAIT" || d.d === "PAIR_WAIT") && t - d.t < 0.2) {
            const m = d.reason.match(/\((.*)\)$/);
            let rs = m ? m[1] : d.reason;
            rs = rs.replace(/STC-ACE-R\d+-\d+/, "STC").replace(/with R\d+/, "with R");
            cat = "yield";
            yieldReasons[rs] = (yieldReasons[rs] || 0) + dt;
            const pm = d.reason.match(/peer (R\d+)/);
            const pa = pm ? fleet.agents.get(pm[1]) : null;
            if (pa) {
              const pls = pa.localState;
              const pp = prevPos2.get(pm[1]);
              const pmoved = pp ? Math.hypot(pls.x - pp.x, pls.y - pp.y) > 1e-6 : true;
              const pd = lastDecision.get(pm[1]);
              let pc;
              if (pmoved) pc = "peer_moving";
              else if (pls.handling) pc = "peer_handling";
              else if (pls._maneuver) pc = "peer_maneuver_" + pls._maneuver.phase;
              else if (pls.status === "WAITING" && pd && pd.reason && pd.reason.includes("peer " + a.robotId + " ")) pc = "peer_yields_to_me";
              else if (pls.status === "WAITING") pc = "peer_waiting_other";
              else pc = "peer_stopped_" + (lastWhy.get(pm[1]) || "none");
              yieldPeer[pc] = (yieldPeer[pc] || 0) + dt;
            }
          } else cat = "waiting_other:" + (d ? d.d : "none");
        } else {
          const why = lastWhy.get(a.robotId);
          if (why === "permission") cat = "perm_" + (a._diagPerm || "?");
          else if (why) cat = "blocked_" + why;
          else cat = "stopped_" + ls.status + (ls.velocity > 0 ? "" : "_v0");
        }
        stall[cat] = (stall[cat] || 0) + dt;
      }
      if (dumpAt.some(x => Math.abs(x - t) < dt / 2)) {
        const snap = [];
        for (const a of fleet.agents.values()) {
          const ls = a.localState;
          snap.push({ id: a.robotId, x: Math.round(ls.x), y: Math.round(ls.y), st: ls.status, race: ls.raceState, task: ls.currentTaskId, tgt: [Math.round(ls.targetX), Math.round(ls.targetY)], stalled: +(ls.stalledDuration || 0).toFixed(1), man: ls._maneuver?.phase || null, why: lastWhy.get(a.robotId) || null, perm: a._diagPerm, pick: ls.currentPickup ? [Math.round(ls.currentPickup.x), Math.round(ls.currentPickup.y)] : null, goal: ls.currentGoal ? [Math.round(ls.currentGoal.x), Math.round(ls.currentGoal.y)] : null, picked: ls.pickedUp, path: (ls.plannedPath || []).map(q => [Math.round(q.x), Math.round(q.y)]), blk: [...a._blockages.values()].map(b => `${b.key}@${Math.round(b.x)},${Math.round(b.y)}`), sess: a.ace?.session ? { sid: a.ace.session.sid, order: a.ace.session.contract.order, region: a.ace.session.region.nodeKey } : null, dec: a.localDecisionTrace.slice(0, 4).map(x => `${x.simTime.toFixed(1)} ${x.decision}: ${x.reason}`) });
        }
        dumps.push({ t: +t.toFixed(1), robots: snap });
      }
      return out;
    };
    const rec = await runOne(mods, { ...cfg, duration: "scenario", label: "diag" });
    eng.update = origUpdate;
    eng._move = origMove;
    const p = rec.record?.performance;
    const round = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +v.toFixed(1)]));
    const res = { cfg, done: p?.tasksCompleted, total: p?.tasksTotal, mk: rec.end_reason === "ALL_TASKS_COMPLETE" ? p?.completionTimeSeconds : rec.sim_time_s, thr: p?.throughputPerHour, stops: rec.telemetry.stops_per_robot, near: rec.telemetry.near_collision_events, wait: rec.telemetry.waiting_fraction_of_busy, stall: round(stall), yieldReasons: round(yieldReasons), yieldPeer: round(yieldPeer), env: rec.telemetry.envelope_seconds, dumps, episodes };
    say(JSON.stringify({ ...res, dumps: undefined, episodes: episodes.length }));
    results.push(res);
  }
  if (env.OUT) fs.writeFileSync(env.OUT, JSON.stringify(results, null, 1));
  Object.assign(console, saved);
});
