// WS1: compare candidate ACE rows against the baseline rows of the same
// (scenario, fleet, seed) for ace / decentralized / centralized.
//   node bench/ws1/compare.mjs <candidate.jsonl> [more.jsonl ...] [--base bench/results/baseline.jsonl] [--rows]
import fs from "node:fs";

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const basePath = baseIdx >= 0 ? args[baseIdx + 1] : "bench/results/baseline.jsonl";
const showRows = args.includes("--rows");
const files = args.filter((a, i) => !a.startsWith("--") && (baseIdx < 0 || i !== baseIdx + 1));

const read = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(j => !j.error);
const key = (j) => `${j.scenario}|${j.fleet_size}|${j.seed}`;
const base = new Map();
for (const j of read(basePath)) base.set(`${j.system}|${key(j)}`, j);
const cand = [];
for (const f of files) for (const j of read(f)) if (j.system === "ace") cand.push(j);

const m = (j) => {
  const p = j.record?.performance || {};
  const t = j.telemetry || {};
  const complete = j.end_reason === "ALL_TASKS_COMPLETE";
  return {
    done: p.tasksCompleted ?? 0, total: p.tasksTotal ?? 0,
    mk: complete ? p.completionTimeSeconds : j.sim_time_s,
    thr: p.throughputPerHour ?? 0,
    cyc: t.tasks?.cycle_s?.mean ?? null,
    stops: t.stops_per_robot ?? 0, near: t.near_collision_events ?? 0,
    minsep: t.min_separation_px_moving ?? null, contact: t.contact_events ?? 0,
    mpt: t.messages_per_completed_task ?? null, bpt: t.bytes_per_completed_task ?? null,
    wait: t.waiting_fraction_of_busy ?? null,
    env: t.envelope_seconds || {}, collisions: j.record?.architectureMetrics?.physics?.collisions ?? 0,
    intr: (j.record?.architectureMetrics?.physics?.obstacleIntrusions ?? 0) + (j.record?.architectureMetrics?.physics?.boundaryViolations ?? 0)
  };
};
const outcome = (a, b) => {
  if (a.done !== b.done) return a.done > b.done ? 1 : -1;
  if (a.mk == null || b.mk == null) return 0;
  if (Math.abs(a.mk - b.mk) <= 0.01 * Math.max(a.mk, b.mk)) return 0;
  return a.mk < b.mk ? 1 : -1;
};
const geo = (xs) => xs.length ? Math.exp(xs.reduce((s, v) => s + Math.log(Math.max(v, 1e-6)), 0) / xs.length) : null;
const mean = (xs) => { const v = xs.filter(x => x !== null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const f = (v, d = 1) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));

const groups = new Map();
const rows = [];
for (const j of cand) {
  const k = key(j);
  const bA = base.get(`ace|${k}`), bD = base.get(`decentralized|${k}`), bC = base.get(`centralized|${k}`);
  const c = m(j);
  const g = groups.get(j.fleet_size) || { n: 0, wlA: [0, 0, 0], wlD: [0, 0, 0], wlC: [0, 0, 0], rA: [], rD: [], rC: [], c: [], a: [], d: [], ce: [] };
  groups.set(j.fleet_size, g);
  g.n++;
  const add = (wl, b) => { if (!b) return; const o = outcome(c, m(b)); wl[o === 1 ? 0 : o === -1 ? 1 : 2]++; };
  add(g.wlA, bA); add(g.wlD, bD); add(g.wlC, bC);
  if (bA) g.rA.push(c.thr / Math.max(1, m(bA).thr));
  if (bD) g.rD.push(c.thr / Math.max(1, m(bD).thr));
  if (bC) g.rC.push(c.thr / Math.max(1, m(bC).thr));
  g.c.push(c); if (bA) g.a.push(m(bA)); if (bD) g.d.push(m(bD)); if (bC) g.ce.push(m(bC));
  rows.push({ k, c, a: bA && m(bA), d: bD && m(bD), ce: bC && m(bC) });
}
if (showRows) {
  console.log("scenario|fleet|seed  cand(done/tot mk thr near stops) | baseACE | DEC | CEN   envelope(cand)");
  rows.sort((x, y) => x.k.localeCompare(y.k));
  for (const r of rows) {
    const s = (x) => (x ? `${x.done}/${x.total} ${f(x.mk, 0)}s ${f(x.thr, 0)}/h n${x.near} s${f(x.stops, 1)}` : "-");
    const o = (x) => (x ? ["=", "+", "-"][[0, 1, -1].indexOf(outcome(r.c, x))] : " ");
    console.log(`${r.k.padEnd(14)} ${s(r.c).padEnd(30)} |${o(r.a)} ${s(r.a).padEnd(30)} |${o(r.d)} ${s(r.d).padEnd(30)} |${o(r.ce)} ${s(r.ce).padEnd(30)} ${Object.entries(r.c.env).map(([k, v]) => `${k.slice(0, 4)}:${Math.round(v)}`).join(" ")}${r.c.collisions || r.c.contact || r.c.intr ? ` COLL=${r.c.collisions} CONTACT=${r.c.contact} INTR=${r.c.intr}` : ""}`);
  }
}
console.log("fleet  n | W/L/T vs baseACE | vs DEC   | vs CEN   | thr ratio(geo) A D C | mean thr cand/A/D/C | done% cand/A/D/C | cycle cand/A/D/C | stops cand/A/D/C | near cand/A/D/C | msgs/task cand/A/D/C | KB/task cand/A/D/C");
for (const [fl, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
  const pct = (xs) => mean(xs.map(x => (x.total ? (100 * x.done) / x.total : null)));
  const col = (fn, d = 1) => [g.c, g.a, g.d, g.ce].map(xs => f(mean(xs.map(fn)), d)).join("/");
  console.log(`${String(fl).padEnd(5)} ${String(g.n).padStart(2)} | ${g.wlA.join("/").padEnd(16)} | ${g.wlD.join("/").padEnd(8)} | ${g.wlC.join("/").padEnd(8)} | ${f(geo(g.rA), 2)} ${f(geo(g.rD), 2)} ${f(geo(g.rC), 2)} | ${col(x => x.thr, 0)} | ${[g.c, g.a, g.d, g.ce].map(xs => f(pct(xs), 1)).join("/")} | ${col(x => x.cyc, 0)} | ${col(x => x.stops, 1)} | ${col(x => x.near, 1)} | ${col(x => x.mpt, 0)} | ${col(x => (x.bpt ?? 0) / 1024, 0)}`);
}
const coll = cand.filter(j => m(j).collisions || m(j).contact || m(j).intr);
console.log(`safety: runs with collisions/contacts/intrusions: ${coll.length}${coll.length ? " -> " + coll.map(key).join(", ") : ""}; min moving sep: ${f(Math.min(...cand.map(j => m(j).minsep ?? Infinity)), 1)}`);
