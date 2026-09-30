#!/usr/bin/env python3
"""WS4 helper: compare candidate runs against the baseline rows of the SAME system
(same scenario / fleet / seed), per system x fleet.

Usage: python bench/ws4/cmp.py <cand.jsonl> [more.jsonl] [--base bench/results/baseline.jsonl]
                               [--scen] [--runs] [--systems centralized,decentralized,ace]
Prints n, runs with all tasks done, tasks done %, throughput (mean and paired geo-mean
ratio cand/base), censored makespan, cycle time, stops/robot, near-collisions,
waiting fraction, collisions, and paired outcome W/L/T (more tasks, then 1 % faster).
"""
import json
import math
import sys
from collections import defaultdict


def load(paths):
    out = {}
    for p in paths:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                j = json.loads(line)
                if j.get("error"):
                    print("ERROR row", j.get("system"), j.get("scenario"), j.get("fleet_size"), j.get("seed"), j["error"][:120])
                    continue
                out[(j["system"], j["scenario"], j["fleet_size"], j["seed"])] = j
    return out


def m(r):
    perf = (r.get("record") or {}).get("performance") or {}
    tel = r.get("telemetry") or {}
    am = (r.get("record") or {}).get("architectureMetrics") or {}
    complete = r.get("end_reason") == "ALL_TASKS_COMPLETE"
    return {
        "done": perf.get("tasksCompleted") or 0,
        "total": perf.get("tasksTotal") or 0,
        "complete": 1 if complete else 0,
        "mk": perf.get("completionTimeSeconds") if complete else r.get("sim_time_s"),
        "thr": perf.get("throughputPerHour"),
        "cyc": ((tel.get("tasks") or {}).get("cycle_s") or {}).get("mean"),
        "stops": tel.get("stops_per_robot"),
        "wait": tel.get("waiting_fraction_of_busy"),
        "near": tel.get("near_collision_events"),
        "coll": (am.get("physics") or {}).get("collisions"),
        "contact": tel.get("contact_events"),
        "bounded": (am.get("planning") or {}).get("boundedRuns"),
        "empty": None,
    }


def outcome(a, b):
    if a["done"] != b["done"]:
        return 1 if a["done"] > b["done"] else -1
    ta, tb = a["mk"], b["mk"]
    if ta is None or tb is None or abs(ta - tb) <= 0.01 * max(ta, tb):
        return 0
    return 1 if ta < tb else -1


def mean(v):
    v = [x for x in v if x is not None]
    return sum(v) / len(v) if v else None


def f(v, d=1):
    if v is None:
        return "-"
    return f"{v:.{d}f}"


def main():
    args = sys.argv[1:]
    base_path = "bench/results/baseline.jsonl"
    systems = ["centralized", "decentralized", "ace"]
    if "--base" in args:
        i = args.index("--base"); base_path = args[i + 1]; del args[i:i + 2]
    if "--systems" in args:
        i = args.index("--systems"); systems = args[i + 1].split(","); del args[i:i + 2]
    scen = "--scen" in args
    runs = "--runs" in args
    files = [a for a in args if not a.startswith("--")]
    cand = load(files)
    base = load([base_path])
    groups = defaultdict(list)
    for k, r in cand.items():
        if k in base:
            groups[(k[0], k[2])].append((k, m(r), m(base[k])))
    hdr = f"{'system':13} {'fleet':>5} {'n':>3} {'allDone c/b':>11} {'done% c/b':>13} {'thr c/b':>13} {'geo':>5} {'mkspan c/b':>13} {'cycle c/b':>13} {'stops c/b':>11} {'near c/b':>11} {'wait c/b':>11} {'coll':>4} {'W/L/T':>8}"
    print(hdr)
    for sysname in systems:
        for fleet in sorted({k[1] for k in groups if k[0] == sysname}):
            rows = groups[(sysname, fleet)]
            n = len(rows)
            ac = sum(c["complete"] for _, c, _ in rows); ab = sum(b["complete"] for _, _, b in rows)
            dc = sum(c["done"] for _, c, _ in rows); db = sum(b["done"] for _, _, b in rows); tt = sum(c["total"] for _, c, _ in rows)
            logs = [math.log(c["thr"] / b["thr"]) for _, c, b in rows if c["thr"] and b["thr"]]
            geo = math.exp(sum(logs) / len(logs)) if logs else None
            w = sum(1 for _, c, b in rows if outcome(c, b) > 0); l = sum(1 for _, c, b in rows if outcome(c, b) < 0)
            coll = sum((c["coll"] or 0) for _, c, _ in rows)
            M = lambda key, who: mean([(c if who == 0 else b)[key] for _, c, b in rows])
            print(f"{sysname:13} {fleet:>5} {n:>3} {f'{ac}/{ab}':>11} {f(100*dc/tt if tt else None)+'/'+f(100*db/tt if tt else None):>13} "
                  f"{f(M('thr',0),0)+'/'+f(M('thr',1),0):>13} {f(geo,2):>5} {f(M('mk',0),0)+'/'+f(M('mk',1),0):>13} "
                  f"{f(M('cyc',0),0)+'/'+f(M('cyc',1),0):>13} {f(M('stops',0))+'/'+f(M('stops',1)):>11} "
                  f"{f(M('near',0),0)+'/'+f(M('near',1),0):>11} {f(M('wait',0),2)+'/'+f(M('wait',1),2):>11} {coll:>4} {f'{w}/{l}/{n-w-l}':>8}")
    if scen:
        print()
        print("Per scenario (outcome W/L/T vs same-system baseline, pooled over fleets/seeds; thr geo ratio)")
        sc = defaultdict(list)
        for (sysname, fleet), rows in groups.items():
            for k, c, b in rows:
                sc[(sysname, k[1])].append((c, b))
        for sysname in systems:
            line = []
            for s in sorted({k[1] for k in sc if k[0] == sysname}):
                rows = sc[(sysname, s)]
                w = sum(1 for c, b in rows if outcome(c, b) > 0); l = sum(1 for c, b in rows if outcome(c, b) < 0)
                logs = [math.log(c["thr"] / b["thr"]) for c, b in rows if c["thr"] and b["thr"]]
                geo = math.exp(sum(logs) / len(logs)) if logs else None
                line.append(f"{s}:{w}/{l}/{len(rows)-w-l}({f(geo,2)})")
            if line:
                print(f"{sysname:13} " + " ".join(line))
    if runs:
        print()
        for (sysname, fleet), rows in sorted(groups.items()):
            for k, c, b in sorted(rows):
                print(f"{sysname:13} {k[1]} n={fleet:<3} s={k[3]:<5} done {c['done']}/{c['total']} vs {b['done']}  mk {f(c['mk'],0)} vs {f(b['mk'],0)}  thr {f(c['thr'],0)} vs {f(b['thr'],0)}  near {c['near']} vs {b['near']}  out {outcome(c,b):+d}")


if __name__ == "__main__":
    main()
