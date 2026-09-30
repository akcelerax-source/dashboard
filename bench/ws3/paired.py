#!/usr/bin/env python3
"""Paired comparison of WS3 candidate ACE runs against bench/results/baseline.jsonl.

usage: python bench/ws3/paired.py cand.jsonl [--rows]
Accepts probe.mjs rows or harness rows. For every (scenario, fleet, seed) of the
candidate, looks up baseline ace / decentralized / centralized and reports per
fleet: geo-mean throughput ratio, mean tasks done, mean cycle, near-collisions,
stops/robot, wins (more tasks, then shorter completion) vs each baseline.
"""
import json, math, sys
from collections import defaultdict

BASE = "bench/results/baseline.jsonl"


def flat(r):
    if "record" in r:  # harness row
        p = (r.get("record") or {}).get("performance") or {}
        t = r["telemetry"]
        return dict(system=r["system"], scenario=r["scenario"], fleet=r["fleet_size"], seed=r["seed"],
                    done=p.get("tasksCompleted"), total=p.get("tasksTotal"), thr=p.get("throughputPerHour"),
                    cycle=t["tasks"]["cycle_s"]["mean"], near=t["near_collision_events"], stops=t["stops_per_robot"],
                    sim=r["sim_time_s"], end=r["end_reason"], contact=t.get("contact_events"))
    return dict(system=r["system"], scenario=r["scenario"], fleet=r["fleet"], seed=r["seed"], done=r["done"],
                total=r["total"], thr=r["thr"], cycle=r["cycle"], near=r["near"], stops=r["stops"], sim=r["sim"], end=r["end"],
                contact=None)


base = {}
for l in open(BASE):
    r = flat(json.loads(l))
    base[(r["system"], r["scenario"], r["fleet"], r["seed"])] = r

cand = []
for f in [a for a in sys.argv[1:] if not a.startswith("--")]:
    for l in open(f):
        if l.strip():
            r = flat(json.loads(l))
            if r["system"] == "ace":
                cand.append(r)


def outcome(a, b):
    if a["done"] != b["done"]:
        return 1 if a["done"] > b["done"] else -1
    ta = a["sim"] if a["end"] == "ALL_TASKS_COMPLETE" else None
    tb = b["sim"] if b["end"] == "ALL_TASKS_COMPLETE" else None
    if ta and tb and abs(ta - tb) > 0.01 * max(ta, tb):
        return 1 if ta < tb else -1
    return 0


agg = defaultdict(lambda: defaultdict(list))
rows = []
for c in cand:
    k = (c["scenario"], c["fleet"], c["seed"])
    for sysn in ["ace", "decentralized", "centralized"]:
        b = base.get((sysn,) + k)
        if not b:
            continue
        a = agg[(c["fleet"], sysn)]
        if c["thr"] and b["thr"]:
            a["ratio"].append(c["thr"] / b["thr"])
        a["out"].append(outcome(c, b))
        a["done_c"].append(c["done"]); a["done_b"].append(b["done"])
        a["cyc_c"].append(c["cycle"] or 0); a["cyc_b"].append(b["cycle"] or 0)
        a["near_c"].append(c["near"]); a["near_b"].append(b["near"])
        a["stops_c"].append(c["stops"]); a["stops_b"].append(b["stops"])
    if "--rows" in sys.argv:
        ba = base.get(("ace",) + k); bc = base.get(("centralized",) + k); bd = base.get(("decentralized",) + k)
        rows.append((k, c, ba, bd, bc))

mean = lambda v: sum(v) / len(v) if v else float("nan")
print("fleet | vs | n | thr ratio (geo) | done cand/base | cycle cand/base | near cand/base | stops cand/base | W/L/T")
for (fl, sysn) in sorted(agg):
    a = agg[(fl, sysn)]
    geo = math.exp(mean([math.log(x) for x in a["ratio"]])) if a["ratio"] else float("nan")
    w = sum(1 for o in a["out"] if o > 0); lo = sum(1 for o in a["out"] if o < 0); t = len(a["out"]) - w - lo
    print(f"{fl} | {sysn} | {len(a['out'])} | {geo:.3f} | {mean(a['done_c']):.1f}/{mean(a['done_b']):.1f} | "
          f"{mean(a['cyc_c']):.0f}/{mean(a['cyc_b']):.0f} | {mean(a['near_c']):.1f}/{mean(a['near_b']):.1f} | "
          f"{mean(a['stops_c']):.1f}/{mean(a['stops_b']):.1f} | {w}/{lo}/{t}")
if rows:
    print("\nscen fleet seed | cand done thr cyc near | base-ace | decentral | central")
    for k, c, ba, bd, bc in sorted(rows, key=lambda x: (x[0][1], x[0][0], x[0][2])):
        f = lambda r: f"{r['done']}/{r['total']} {r['thr']} {r['cycle'] or 0:.0f} {r['near']}" if r else "-"
        print(f"{k[0]} {k[1]} {k[2]} | {f(c)} | {f(ba)} | {f(bd)} | {f(bc)}")
