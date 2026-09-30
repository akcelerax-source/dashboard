#!/usr/bin/env python3
"""WS2 helper: compare candidate ACE runs against baseline rows (same scenario/fleet/seed).

Usage: python bench/ws2/cmp.py <candidate.jsonl> [--base bench/results/baseline.jsonl] [--detail]
Prints per-run lines and per-fleet means for candidate ace vs baseline ace / decentralized / centralized.
"""
import json
import sys
from collections import defaultdict


def load(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def m(r):
    perf = (r.get("record") or {}).get("performance") or {}
    tel = r.get("telemetry") or {}
    complete = r.get("end_reason") == "ALL_TASKS_COMPLETE"
    am = (r.get("record") or {}).get("architectureMetrics") or {}
    return {
        "done": perf.get("tasksCompleted"),
        "total": perf.get("tasksTotal"),
        "complete": 1 if complete else 0,
        "mk": perf.get("completionTimeSeconds") if complete else r.get("sim_time_s"),
        "thr": perf.get("throughputPerHour"),
        "cyc": ((tel.get("tasks") or {}).get("cycle_s") or {}).get("mean"),
        "stops": tel.get("stops_per_robot"),
        "wait": tel.get("waiting_fraction_of_busy"),
        "near": tel.get("near_collision_events"),
        "det": (tel.get("detour_ratio") or {}).get("mean"),
        "coll": ((am.get("physics") or {}).get("collisions")),
        "minsep": tel.get("min_separation_px_moving"),
    }


def key(r):
    return (r["scenario"], r["fleet_size"], r["seed"])


def fmt(v, w=6, d=1):
    if v is None:
        return "-".rjust(w)
    if isinstance(v, float):
        return f"{v:{w}.{d}f}"
    return str(v).rjust(w)


def main():
    args = sys.argv[1:]
    base_path = "bench/results/baseline.jsonl"
    detail = "--detail" in args
    if "--base" in args:
        i = args.index("--base")
        base_path = args[i + 1]
        del args[i:i + 2]
    args = [a for a in args if not a.startswith("--")]
    cand = [r for p in args for r in load(p) if r["system"] == "ace"]
    base = load(base_path)
    bidx = {(key(r), r["system"]): r for r in base}
    fields = ["done", "mk", "thr", "cyc", "stops", "wait", "near", "det"]
    agg = defaultdict(lambda: defaultdict(list))
    wins = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))
    if detail:
        print("scen fl seed | " + " ".join(f"{f:>6}" for f in fields) + " || base-ace done/mk/thr/stops/near || dec done/mk/thr || cen done/mk/thr")
    for r in sorted(cand, key=lambda r: (r["fleet_size"], r["scenario"], r["seed"])):
        k = key(r)
        c = m(r)
        rows = {s: bidx.get((k, s)) for s in ("ace", "decentralized", "centralized")}
        ms = {s: (m(v) if v else None) for s, v in rows.items()}
        fl = r["fleet_size"]
        for f in fields + ["complete", "coll"]:
            agg[fl]["cand_" + f].append(c[f])
            for s in ms:
                if ms[s]:
                    agg[fl][s + "_" + f].append(ms[s][f])
        for s in ms:
            if not ms[s]:
                continue
            b = ms[s]
            # outcome: more tasks, then shorter makespan (1% band)
            if c["done"] != b["done"]:
                w = 0 if c["done"] > b["done"] else 1
            elif b["mk"] and c["mk"] and abs(c["mk"] - b["mk"]) <= 0.01 * b["mk"]:
                w = 2
            else:
                w = 0 if (c["mk"] or 1e9) < (b["mk"] or 1e9) else 1
            wins[fl][s][w] += 1
        if detail:
            a, d, ce = ms["ace"], ms["decentralized"], ms["centralized"]
            line = f"{k[0]} {k[1]:>3} {k[2]:>5} | " + " ".join(fmt(c[f], 6, 2 if f in ('wait', 'det') else 1) for f in fields)
            if a:
                line += f" || {a['done']}/{fmt(a['mk'],5,0)}/{fmt(a['thr'],4,0)}/{fmt(a['stops'],4,1)}/{a['near']}"
            if d:
                line += f" || {d['done']}/{fmt(d['mk'],5,0)}/{fmt(d['thr'],4,0)}"
            if ce:
                line += f" || {ce['done']}/{fmt(ce['mk'],5,0)}/{fmt(ce['thr'],4,0)}"
            print(line)
    print()
    print("fleet | metric | cand | base-ace | dec | cen")
    for fl in sorted(agg):
        A = agg[fl]
        n = len(A["cand_done"])
        for f in ["complete", "done", "mk", "thr", "cyc", "stops", "wait", "near", "det", "coll"]:
            def mean(key):
                v = [x for x in A.get(key, []) if isinstance(x, (int, float))]
                return sum(v) / len(v) if v else None
            print(f"{fl:>4} (n={n}) | {f:>8} | {fmt(mean('cand_'+f),8,2)} | {fmt(mean('ace_'+f),8,2)} | {fmt(mean('decentralized_'+f),8,2)} | {fmt(mean('centralized_'+f),8,2)}")
        for s in ("ace", "decentralized", "centralized"):
            w = wins[fl][s]
            print(f"      cand vs {s}: W/L/T {w[0]}/{w[1]}/{w[2]}")
        print()


if __name__ == "__main__":
    main()
