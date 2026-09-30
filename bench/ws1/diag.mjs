// WS1 diagnostics: runs one configuration headlessly (same harness as the
// benchmark: bench/lib.js runOne) and observes the ACE agents after every
// simEngine.update. Observation only: never changes robot state.
//
//   node bench/ws1/diag.mjs <scenario> <fleet> <seed> [src=zz-ws1] [system=ace]
//
// Prints one JSON line with:
//  - run outcome (end reason, tasks, completion time, digest)
//  - envelope robot-seconds per state, split into moving / stopped
//  - robot-seconds moving under an envelope speed cap (targetVelocity < 1.2)
//  - escalation transitions by dominant RACE factor
//  - Edge-AI conflict prediction episodes (perPeer > 0.35 and > 0.5) and the
//    share that never led to a real interaction (false positives)
//  - mean RACE inputs per state, SAFE-DEGRADED causes
//  - peer messages / bytes by type
import { loadSim, runOne } from "../lib.js";

const [scenario = "S01", fleetS = "10", seedS = "1", src = "zz-ws1", system = "ace"] = process.argv.slice(2);
const fleet = +fleetS, seed = +seedS;
const mods = await loadSim(src);
const { simEngine, state, decentralizedFleet } = mods;

const H = 3.0;              // prediction horizon (s)
const NEAR = 32;            // safety margins touch
const WAIT_R = 48;          // attributable wait radius
const agg = {
  env: {}, envMoving: {}, envStopped: {}, cappedMovingS: 0, cappedBy: {},
  transitions: {}, escalationsByFactor: {}, inputsByState: {},
  sdFlagS: 0, sdRiskS: 0,
  ep: { p35: { n: 0, tp: 0 }, p50: { n: 0, tp: 0 } },
  sensorEp: { n: 0, tp: 0 },
  commRiskSum: 0, commRiskN: 0, commRiskMax: 0,
  robotSeconds: 0
};
const open = { p35: new Map(), p50: new Map(), sensor: new Map() }; // key -> {start, last, tp}
const prevState = new Map();

function truthIndex(robots) {
  const m = new Map();
  for (const r of robots) m.set(r.id, r);
  return m;
}
function interacting(a, b) {
  if (!a || !b) return false;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const mv = (r) => (r.velocity || 0) > 0.01;
  if (d < NEAR && (mv(a) || mv(b))) return true;
  const stoppedFacing = (s, o) => {
    if (mv(s) || s.handling || !(s.currentTaskId || s.parkingBay || s._maneuver)) return false;
    const hx = Math.cos(s.heading || 0), hy = Math.sin(s.heading || 0);
    return d < WAIT_R && ((o.x - s.x) * hx + (o.y - s.y) * hy) > 0;
  };
  return stoppedFacing(a, b) || stoppedFacing(b, a);
}
function tickEpisodes(kind, bucket, key, predicted, t, truth) {
  const map = open[kind];
  let e = map.get(key);
  if (predicted) {
    if (!e) { e = { start: t, last: t, tp: false }; map.set(key, e); bucket.n++; }
    e.last = t;
  }
}
function resolveEpisodes(kind, bucket, t, truth) {
  const map = open[kind];
  for (const [key, e] of map) {
    const [a, b] = key.split("|");
    if (!e.tp && interacting(truth.get(a), truth.get(b))) { e.tp = true; bucket.tp++; }
    if (t - e.last > H) map.delete(key);
  }
}

const origUpdate = simEngine.update.bind(simEngine);
simEngine.update = function (dt) {
  const out = origUpdate(dt);
  try { observe(dt); } catch (e) { process.stderr.write(String(e.stack) + "\n"); }
  return out;
};

function observe(dt) {
  if (state.get("systemMode") !== "ace" && system === "ace") return;
  const t = state.get("simTimeSeconds") || 0;
  const robots = state.get("robots") || [];
  const truth = truthIndex(robots);
  for (const ag of decentralizedFleet.agents.values()) {
    const ls = ag.localState;
    if (!ag.aceEnabled) continue;
    const r = truth.get(ag.robotId);
    if (!r || ["ERROR", "error", "failed"].includes(r.status)) continue;
    const st = ls.raceState || "LOCAL";
    agg.robotSeconds += dt;
    agg.env[st] = (agg.env[st] || 0) + dt;
    const moving = (r.velocity || 0) > 0.01;
    (moving ? agg.envMoving : agg.envStopped)[st] = ((moving ? agg.envMoving : agg.envStopped)[st] || 0) + dt;
    if (moving && (ls.targetVelocity || 1.2) < 1.2 - 1e-9) { agg.cappedMovingS += dt; agg.cappedBy[st] = (agg.cappedBy[st] || 0) + dt; }
    if (st === "SAFE-DEGRADED") { if (ls.isCriticalDegraded) agg.sdFlagS += dt; else agg.sdRiskS += dt; }
    const inp = ls.riskInputs || {};
    const acc = (agg.inputsByState[st] ||= { n: 0, conflict: 0, uncertainty: 0, commRisk: 0, queueGrowth: 0, cascadePressure: 0, sensorConflict: 0, aiConflict: 0, risk: 0 });
    acc.n++;
    for (const k of ["conflict", "uncertainty", "commRisk", "queueGrowth", "cascadePressure", "sensorConflict", "aiConflict"]) acc[k] += inp[k] || 0;
    acc.risk += ls.riskScore || 0;
    agg.commRiskSum += inp.commRisk || 0; agg.commRiskN++; agg.commRiskMax = Math.max(agg.commRiskMax, inp.commRisk || 0);
    const prev = prevState.get(ag.robotId);
    if (prev && prev !== st) {
      const k = `${prev}->${st}`;
      agg.transitions[k] = (agg.transitions[k] || 0) + 1;
      const lvl = { LOCAL: 0, NEIGHBORHOOD: 1, CONTAINMENT: 2, "SAFE-DEGRADED": 3 };
      if (lvl[st] > lvl[prev]) {
        const w = { conflict: 0.35, uncertainty: 0.15, commRisk: 0.2, queueGrowth: 0.15, cascadePressure: 0.15 };
        const dom = Object.keys(w).sort((x, y) => (inp[y] || 0) * w[y] - (inp[x] || 0) * w[x])[0];
        const kk = `${st}:${ls.isCriticalDegraded && st === "SAFE-DEGRADED" ? "flag" : dom}`;
        agg.escalationsByFactor[kk] = (agg.escalationsByFactor[kk] || 0) + 1;
      }
    }
    prevState.set(ag.robotId, st);
    // Edge-AI prediction episodes.
    const pp = ag.edgeAi ? ag.edgeAi.perPeer : new Map();
    for (const [pid, p] of pp) {
      const key = ag.robotId < pid ? `${ag.robotId}|${pid}` : `${pid}|${ag.robotId}`;
      tickEpisodes("p35", agg.ep.p35, `${ag.robotId}>${pid}|${key}`, p > 0.35, t, truth);
      tickEpisodes("p50", agg.ep.p50, `${ag.robotId}>${pid}|${key}`, p >= 0.5, t, truth);
    }
    // Sensor proximity "conflict" episodes (< 36 px, non-standing).
    const fr = ag.sensorFrame || { detections: [] };
    for (const d of fr.detections || []) {
      if (d.failed || (ag._isStanding && ag._isStanding(d))) continue;
      if (d.dist < 36) tickEpisodes("sensor", agg.sensorEp, `${ag.robotId}>${d.id}|x`, true, t, truth);
    }
  }
  const fix = (kind, bucket) => {
    const map = open[kind];
    for (const [key, e] of map) {
      const pair = key.split("|")[0].split(">");
      if (!e.tp && interacting(truth.get(pair[0]), truth.get(pair[1]))) { e.tp = true; bucket.tp++; }
      if (t - e.last > H) map.delete(key);
    }
  };
  fix("p35", agg.ep.p35); fix("p50", agg.ep.p50); fix("sensor", agg.sensorEp);
}

const t0 = Date.now();
const rec = await runOne(mods, { system, scenario, fleet, seed, kind: scenario.startsWith("A") ? "aceTest" : "scenario", duration: "scenario", label: "ws1diag" });
const r3 = (v) => Math.round(v * 1000) / 1000;
const inputs = {};
for (const [st, a] of Object.entries(agg.inputsByState)) {
  inputs[st] = Object.fromEntries(Object.entries(a).filter(([k]) => k !== "n").map(([k, v]) => [k, r3(v / a.n)]));
}
const tel = rec.telemetry;
console.log(JSON.stringify({
  src, system, scenario, fleet, seed,
  end: rec.end_reason, verdict: rec.verdict, sim: rec.sim_time_s,
  done: `${rec.record?.performance?.tasksCompleted}/${rec.record?.performance?.tasksTotal}`,
  completion: rec.record?.performance?.completionTimeSeconds, thr: rec.record?.performance?.throughputPerHour,
  digest: rec.det_digest, wall: (Date.now() - t0) / 1000,
  waitFrac: tel.waiting_fraction_of_busy, stops: tel.stops_per_robot, near: tel.near_collision_events, minSepMoving: tel.min_separation_px_moving,
  msgs: tel.messages.total_msgs, bytes: tel.messages.total_bytes, msgsPerTask: tel.messages_per_completed_task, bytesPerTask: tel.bytes_per_completed_task,
  byType: tel.messages.by_type,
  env: Object.fromEntries(Object.entries(agg.env).map(([k, v]) => [k, r3(v)])),
  envStopped: Object.fromEntries(Object.entries(agg.envStopped).map(([k, v]) => [k, r3(v)])),
  cappedMovingS: r3(agg.cappedMovingS), cappedBy: Object.fromEntries(Object.entries(agg.cappedBy).map(([k, v]) => [k, r3(v)])),
  sdFlagS: r3(agg.sdFlagS), sdRiskS: r3(agg.sdRiskS),
  transitions: agg.transitions, escalations: agg.escalationsByFactor,
  edgeAi: {
    p35: { episodes: agg.ep.p35.n, fpRate: agg.ep.p35.n ? r3(1 - agg.ep.p35.tp / agg.ep.p35.n) : null },
    p50: { episodes: agg.ep.p50.n, fpRate: agg.ep.p50.n ? r3(1 - agg.ep.p50.tp / agg.ep.p50.n) : null },
    sensor36: { episodes: agg.sensorEp.n, fpRate: agg.sensorEp.n ? r3(1 - agg.sensorEp.tp / agg.sensorEp.n) : null }
  },
  commRiskMean: agg.commRiskN ? r3(agg.commRiskSum / agg.commRiskN) : null, commRiskMax: agg.commRiskMax,
  inputs,
  crit: rec.record?.experimentResult?.criteria?.map(c => `${c.pass ? "OK" : c.pass === null ? "??" : "XX"} ${c.name.slice(0, 40)}: ${c.actual}`)
}));
process.exit(0);
