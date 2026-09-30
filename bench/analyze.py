#!/usr/bin/env python3
"""
NODEX benchmark analyzer (stdlib only).

Aggregates bench JSONL lines (bench/bench.run.js) into per
system x fleet x scenario statistics (mean / median / std / 95 % CI) and a
paired ACE-vs-baseline comparison on identical (scenario, fleet, seed).

Usage:
  python bench/analyze.py bench/results/baseline.jsonl [more.jsonl ...]
         [--md bench/results/baseline_analysis.md] [--json bench/results/baseline_summary.json]
         [--label LABEL] [--kind scenario|aceTest]
"""
import argparse
import json
import math
import statistics as st
from collections import defaultdict

SYSTEMS = ["centralized", "decentralized", "ace"]

# Two-sided 95 % Student-t critical values, df 1..30 (df > 30 -> 1.96).
T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
       2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
       2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042]


def g(d, *path, default=None):
    for p in path:
        if d is None:
            return default
        d = d.get(p) if isinstance(d, dict) else None
    return default if d is None else d


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def extract(r):
    """Flat metric dict for one run."""
    perf = g(r, "record", "performance", default={}) or {}
    am = g(r, "record", "architectureMetrics", default={}) or {}
    tel = r.get("telemetry", {}) or {}
    system = r["system"]
    completed = perf.get("tasksCompleted")
    total = perf.get("tasksTotal")
    env = tel.get("envelope_seconds") or {}
    env_total = sum(v for v in env.values() if num(v)) or 0
    if system == "centralized":
        replans = g(am, "planning", "replans")
        sessions = g(am, "arbitration", "conflictsDetected")
    elif system == "ace":
        replans = (am.get("localReplans") or 0) + (g(am, "sessions", "sessionReplans") or 0)
        sessions = g(am, "sessions", "initiated")
    else:
        replans = am.get("localReplans")
        sessions = g(am, "coordination", "pairSessions")
    complete = r.get("end_reason") == "ALL_TASKS_COMPLETE"
    m = {
        "complete": 1.0 if complete else 0.0,
        "completion_time_s": perf.get("completionTimeSeconds") if complete else None,
        # Makespan with censoring: completion time if complete, else the run's sim time.
        "makespan_censored_s": perf.get("completionTimeSeconds") if complete else r.get("sim_time_s"),
        "throughput_per_h": perf.get("throughputPerHour"),
        "tasks_completed": completed,
        "completion_pct": perf.get("completionPct"),
        "cycle_mean_s": g(tel, "tasks", "cycle_s", "mean"),
        "cycle_p95_s": g(tel, "tasks", "cycle_s", "p95"),
        "alloc_latency_s": g(tel, "tasks", "allocation_latency_s", "mean"),
        "waiting_frac": tel.get("waiting_fraction_of_busy"),
        "stops_per_robot": tel.get("stops_per_robot"),
        "dist_per_robot_px": tel.get("distance_px_per_robot"),
        "detour_ratio": g(tel, "detour_ratio", "mean"),
        "replans": replans,
        "coord_sessions": sessions,
        "mean_active_sessions": g(tel, "sessions", "mean_active"),
        "msgs_per_task": tel.get("messages_per_completed_task"),
        "bytes_per_task": tel.get("bytes_per_completed_task"),
        "msgs_total": g(tel, "messages", "total_msgs"),
        "collisions": g(am, "physics", "collisions"),
        "near_collisions": tel.get("near_collision_events"),
        "near_pair_s": tel.get("near_pair_seconds"),
        "min_sep_moving_px": tel.get("min_separation_px_moving"),
        "cpu_ms_per_tick": g(tel, "cpu_ms_per_tick", "mean"),
        "cpu_ms_per_tick_p95": g(tel, "cpu_ms_per_tick", "p95"),
        "wall_s": r.get("wall_s"),
        "heap_max_mb": g(tel, "heap_mb", "max"),
    }
    for k in ("LOCAL", "NEIGHBORHOOD", "CONTAINMENT", "SAFE-DEGRADED"):
        m["env_" + k] = (env.get(k, 0) / env_total) if (system == "ace" and env_total > 0) else None
    return m


def stats(vals):
    v = [x for x in vals if num(x) is not None]
    n = len(v)
    if n == 0:
        return {"n": 0, "mean": None, "median": None, "std": None, "ci95": None}
    mean = sum(v) / n
    sd = st.stdev(v) if n > 1 else 0.0
    t = T95[n - 2] if 2 <= n <= 31 else 1.96
    ci = t * sd / math.sqrt(n) if n > 1 else None
    return {"n": n, "mean": mean, "median": st.median(v), "std": sd, "ci95": ci}


# metric -> +1 higher is better, -1 lower is better, 0 descriptive only
DIRECTION = {
    "complete": 1, "completion_time_s": -1, "makespan_censored_s": -1, "throughput_per_h": 1,
    "tasks_completed": 1, "completion_pct": 1, "cycle_mean_s": -1, "cycle_p95_s": -1,
    "alloc_latency_s": -1, "waiting_frac": -1, "stops_per_robot": -1, "dist_per_robot_px": 0,
    "detour_ratio": -1, "replans": 0, "coord_sessions": 0, "mean_active_sessions": 0,
    "msgs_per_task": -1, "bytes_per_task": -1, "msgs_total": -1, "collisions": -1,
    "near_collisions": -1, "near_pair_s": -1, "min_sep_moving_px": 1, "cpu_ms_per_tick": -1,
    "cpu_ms_per_tick_p95": -1, "wall_s": -1, "heap_max_mb": -1,
}

PAIRED_METRICS = ["outcome", "throughput_per_h", "makespan_censored_s", "cycle_mean_s", "waiting_frac",
                  "stops_per_robot", "msgs_per_task", "cpu_ms_per_tick"]


def outcome_cmp(a, b):
    """+1 if run a is better than run b on the primary outcome: more tasks
    completed; if equal and both complete, shorter completion time (1 % tie band)."""
    ca, cb = a["tasks_completed"] or 0, b["tasks_completed"] or 0
    if ca != cb:
        return 1 if ca > cb else -1
    ta, tb = a["makespan_censored_s"], b["makespan_censored_s"]
    if ta is None or tb is None:
        return 0
    if abs(ta - tb) <= 0.01 * max(ta, tb):
        return 0
    return 1 if ta < tb else -1


def metric_cmp(metric, a, b):
    if metric == "outcome":
        return outcome_cmp(a, b)
    va, vb = a.get(metric), b.get(metric)
    if va is None or vb is None:
        return None
    d = DIRECTION.get(metric, 0)
    if d == 0:
        return None
    tol = 0.01 * max(abs(va), abs(vb))
    if abs(va - vb) <= tol:
        return 0
    return (1 if va > vb else -1) * d


def fmt(v, d=1):
    if v is None:
        return "-"
    if isinstance(v, float):
        if abs(v) >= 1000:
            return f"{v:,.0f}"
        return f"{v:.{d}f}"
    return str(v)


def ms(s, d=1):
    if not s or s["n"] == 0:
        return "-"
    txt = fmt(s["mean"], d)
    if s["ci95"] is not None and s["n"] > 1:
        txt += f" ±{fmt(s['ci95'], d)}"
    return txt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--md", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--label", default=None)
    ap.add_argument("--kind", default="scenario")
    a = ap.parse_args()

    runs, errors = [], []
    for f in a.files:
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                if r.get("error"):
                    errors.append(r)
                    continue
                if a.label and r.get("label") != a.label:
                    continue
                if (r.get("kind") or "scenario") != a.kind:
                    continue
                runs.append(r)
    # De-duplicate (system, scenario, fleet, seed): keep the last line.
    uniq = {}
    for r in runs:
        uniq[(r["system"], r["scenario"], r["fleet_size"], r["seed"])] = r
    runs = list(uniq.values())
    for r in runs:
        r["_m"] = extract(r)

    fleets = sorted({r["fleet_size"] for r in runs})
    scenarios = sorted({r["scenario"] for r in runs})
    systems = [s for s in SYSTEMS if any(r["system"] == s for r in runs)]
    seeds = sorted({r["seed"] for r in runs})
    metrics = list(DIRECTION.keys()) + ["env_LOCAL", "env_NEIGHBORHOOD", "env_CONTAINMENT", "env_SAFE-DEGRADED"]

    cells = defaultdict(list)
    for r in runs:
        cells[(r["system"], r["fleet_size"], r["scenario"])].append(r["_m"])
        cells[(r["system"], r["fleet_size"], "ALL")].append(r["_m"])
    agg = {}
    for key, ms_ in cells.items():
        agg[key] = {m: stats([x.get(m) for x in ms_]) for m in metrics}

    # Paired comparisons.
    by = {(r["system"], r["scenario"], r["fleet_size"], r["seed"]): r["_m"] for r in runs}
    paired = {}
    for other in [s for s in systems if s != "ace"]:
        res = defaultdict(lambda: {"win": 0, "loss": 0, "tie": 0})
        rel = defaultdict(list)
        for (sys_, sc, fl, sd), m in by.items():
            if sys_ != "ace":
                continue
            o = by.get((other, sc, fl, sd))
            if o is None:
                continue
            for metric in PAIRED_METRICS:
                c = metric_cmp(metric, m, o)
                if c is None:
                    continue
                k = "win" if c > 0 else "loss" if c < 0 else "tie"
                for grp in (("fleet", fl), ("scenario", sc), ("all", "all"), ("cell", f"{sc}|{fl}")):
                    res[(metric,) + grp][k] += 1
            if m["throughput_per_h"] and o["throughput_per_h"]:
                rel[fl].append(m["throughput_per_h"] / o["throughput_per_h"])
        paired[other] = {"counts": {"|".join(map(str, k)): v for k, v in res.items()},
                         "throughput_ratio_by_fleet": {str(f): {**stats(v), "geomean": math.exp(sum(math.log(x) for x in v) / len(v))}
                                                       for f, v in rel.items()}}

    # ---------------- Markdown ----------------
    L = []
    L.append(f"# NODEX benchmark analysis\n")
    L.append(f"Runs: {len(runs)} ({a.kind}); errors: {len(errors)}; systems: {', '.join(systems)}; fleets: {fleets}; "
             f"scenarios: {len(scenarios)}; seeds: {seeds}. Values are mean ±95 % CI half-width (Student t) over seeds; "
             f"'ALL' rows pool every scenario (so their CI mixes scenario variance).\n")

    L.append("## Fleet-level summary (all scenarios pooled)\n")
    hdr = ["fleet", "system", "runs", "complete %", "tasks done %", "throughput /h", "makespan* s", "cycle s",
           "alloc lat s", "wait frac", "stops/robot", "dist/robot px", "detour", "msgs/task", "KB/task",
           "near-coll", "min sep px", "collisions", "CPU ms/tick"]
    L.append("| " + " | ".join(hdr) + " |")
    L.append("|" + "---|" * len(hdr))
    for fl in fleets:
        for s in systems:
            A = agg.get((s, fl, "ALL"))
            if not A:
                continue
            kb = A["bytes_per_task"]["mean"]
            L.append("| " + " | ".join([
                str(fl), s, str(A["complete"]["n"]), fmt(100 * A["complete"]["mean"], 0),
                ms(A["completion_pct"]), ms(A["throughput_per_h"], 0), ms(A["makespan_censored_s"], 0),
                ms(A["cycle_mean_s"]), ms(A["alloc_latency_s"], 2), ms(A["waiting_frac"], 2),
                ms(A["stops_per_robot"]), ms(A["dist_per_robot_px"], 0), ms(A["detour_ratio"], 2),
                ms(A["msgs_per_task"], 0), fmt(kb / 1024 if kb is not None else None, 1),
                ms(A["near_collisions"]), ms(A["min_sep_moving_px"]), ms(A["collisions"]),
                ms(A["cpu_ms_per_tick"], 2)]) + " |")
    L.append("\n*makespan: completion time when all tasks finished, else the run's sim time (censored at the duration limit).\n")

    if "ace" in systems:
        L.append("## ACE envelope and session activity (all scenarios pooled)\n")
        L.append("| fleet | LOCAL | NEIGHBORHOOD | CONTAINMENT | SAFE-DEGRADED | sessions initiated | mean active sessions | replans |")
        L.append("|---|---|---|---|---|---|---|---|")
        for fl in fleets:
            A = agg.get(("ace", fl, "ALL"))
            if not A:
                continue
            pct = lambda k: fmt(100 * A[k]["mean"], 1) + " %" if A[k]["mean"] is not None else "-"
            L.append(f"| {fl} | {pct('env_LOCAL')} | {pct('env_NEIGHBORHOOD')} | {pct('env_CONTAINMENT')} | {pct('env_SAFE-DEGRADED')} | "
                     f"{ms(A['coord_sessions'], 0)} | {ms(A['mean_active_sessions'], 2)} | {ms(A['replans'], 0)} |")
        L.append("")

    for other in paired:
        L.append(f"## Paired: ACE vs {other} (same scenario, fleet, seed) - wins/losses/ties for ACE\n")
        L.append("Outcome = more tasks completed, then shorter completion time (1 % tie band). Other metrics use a 1 % tie band.\n")
        cnt = paired[other]["counts"]
        L.append("| group | " + " | ".join(PAIRED_METRICS) + " |")
        L.append("|---|" + "---|" * len(PAIRED_METRICS))
        groups = [("all", "all")] + [("fleet", f) for f in fleets] + [("scenario", s) for s in scenarios]
        for grp in groups:
            row = []
            for metric in PAIRED_METRICS:
                c = cnt.get("|".join(map(str, (metric,) + grp)))
                row.append(f"{c['win']}/{c['loss']}/{c['tie']}" if c else "-")
            L.append(f"| {grp[0]} {grp[1]} | " + " | ".join(row) + " |")
        tr = paired[other]["throughput_ratio_by_fleet"]
        L.append("\nACE/" + other + " throughput ratio over paired runs (geometric mean / median): " +
                 ", ".join(f"n={f}: {fmt(v['geomean'], 2)} / {fmt(v['median'], 2)}" for f, v in sorted(tr.items(), key=lambda x: int(x[0]))) + "\n")

    L.append("## Per scenario x fleet (mean over seeds)\n")
    L.append("| scenario | fleet | system | complete % | done % | throughput /h | makespan* s | cycle s | wait frac | stops/robot | msgs/task | near-coll | CPU ms/tick |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for sc in scenarios:
        for fl in fleets:
            for s in systems:
                A = agg.get((s, fl, sc))
                if not A:
                    continue
                L.append("| " + " | ".join([sc, str(fl), s, fmt(100 * A["complete"]["mean"], 0), fmt(A["completion_pct"]["mean"], 0),
                                             ms(A["throughput_per_h"], 0), fmt(A["makespan_censored_s"]["mean"], 0),
                                             fmt(A["cycle_mean_s"]["mean"]), fmt(A["waiting_frac"]["mean"], 2),
                                             fmt(A["stops_per_robot"]["mean"]), fmt(A["msgs_per_task"]["mean"], 0),
                                             fmt(A["near_collisions"]["mean"]), fmt(A["cpu_ms_per_tick"]["mean"], 2)]) + " |")
    if errors:
        L.append("\n## Errors\n")
        for e in errors[:50]:
            L.append(f"- {e.get('system')} {e.get('scenario')} n={e.get('fleet_size')} seed={e.get('seed')}: {str(e.get('error')).splitlines()[0]}")

    # Fairness.
    fair = [r for r in runs if r.get("fairness_diffs")]
    L.append("\n## Fairness check\n")
    if not fair:
        L.append("All runs of the same (scenario, fleet, seed) had identical map, robot spawn/speed, initial and final task workload, "
                 "scheduled faults and injected-fault timeline across systems.")
    else:
        for r in fair[:100]:
            L.append(f"- {r['scenario']} n={r['fleet_size']} seed={r['seed']} {r.get('fairness_ref_system')} vs {r['system']}: "
                     + ", ".join(d["field"] for d in r["fairness_diffs"]))

    md = "\n".join(L) + "\n"
    if a.md:
        with open(a.md, "w", encoding="utf-8") as fh:
            fh.write(md)
    else:
        print(md)

    if a.json:
        out = {
            "runs": len(runs), "errors": len(errors), "systems": systems, "fleets": fleets,
            "scenarios": scenarios, "seeds": seeds, "fairness_violations": len(fair),
            "cells": {"|".join(map(str, k)): v for k, v in agg.items()},
            "paired": paired,
        }
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=1)


if __name__ == "__main__":
    main()
