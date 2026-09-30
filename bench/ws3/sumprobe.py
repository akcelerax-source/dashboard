#!/usr/bin/env python3
"""Tabulates bench/ws3/probe.mjs JSONL output.

usage: python bench/ws3/sumprobe.py file.jsonl [more...] [--by scenario] [--label-key src|ablate]
Rows are grouped by (fleet, system-variant) where the variant is system plus
the jsonl basename, so several candidate versions can be compared.
"""
import json, sys, statistics as st
from collections import defaultdict

args = [a for a in sys.argv[1:] if not a.startswith("--")]
by_scen = "--by" in sys.argv
KEYS = ["done", "thr", "cycle", "alloc_lat", "exec_s", "empty_s", "empty_px", "graph_pick", "loaded_s",
        "slot_gap_s", "bids_per_award", "near", "stops", "wait_frac", "msgs"]
rows = []
for f in args:
    tag = f.replace("\\", "/").split("/")[-1].replace(".jsonl", "")
    for l in open(f):
        if l.strip():
            r = json.loads(l)
            r["_v"] = r["system"] if r["system"] != "ace" else "ace:" + tag
            rows.append(r)

g = defaultdict(list)
for r in rows:
    k = (r["fleet"], r["scenario"] if by_scen else "ALL", r["_v"])
    g[k].append(r)

def m(v):
    v = [x for x in v if isinstance(x, (int, float))]
    return st.mean(v) if v else None

hdr = ["fleet", "scen", "variant", "n"] + KEYS
print(" | ".join(hdr))
for k in sorted(g):
    rs = g[k]
    vals = []
    for key in KEYS:
        x = m([r.get(key) for r in rs])
        vals.append("-" if x is None else (f"{x:.0f}" if abs(x) >= 100 else f"{x:.2f}" if abs(x) < 10 else f"{x:.1f}"))
    print(" | ".join([str(k[0]), k[1], k[2], str(len(rs))] + vals))
