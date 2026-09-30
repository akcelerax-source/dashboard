// WS1: count recoverFromDeadlock / turn-back / backoff calls by cause (observation only).
import { loadSim, runOne } from "../lib.js";
const [sc, fl, sd, src = "zz-ws1"] = process.argv.slice(2);
const mods = await loadSim(src);
const { RobotAgent } = await import(new URL(`../../${src}/core/decentralized/RobotAgent.js`, import.meta.url).href);
const c = {};
const wrap = (name, key) => { const o = RobotAgent.prototype[name]; RobotAgent.prototype[name] = function (...a) { const k = key(a, this); c[k] = (c[k] || 0) + 1; return o.apply(this, a); }; };
wrap("recoverFromDeadlock", (a, self) => `recover:${a[0] === "CONTAINMENT_CLUSTER" ? "containment" : "peer"}:${self.localState.raceState}`);
wrap("_turnBackReplan", () => "turnBack");
wrap("_avoidBlockages", () => "avoidBlockagesCalls");
const rec = await runOne(mods, { system: "ace", scenario: sc, fleet: +fl, seed: +sd, kind: "scenario", duration: "scenario", label: "cnt" });
console.log(JSON.stringify({ done: rec.record.performance.tasksCompleted, t: rec.sim_time_s, near: rec.telemetry.near_collision_events, replans: rec.record.architectureMetrics.localReplans, c }));
process.exit(0);
