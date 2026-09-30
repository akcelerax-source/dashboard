"""Restore dashboard run history from every backend backup + current state.

Collects all runs from backend/shared_state*.json, de-duplicates by runId and
posts them to the running backend (/api/shared/runs), which applies the
per-slot retention (newest runs per kind/scenario/fleet/system are kept).
Usage: python bench/final/restore_history.py
"""
import glob
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
seen, runs = set(), []
for f in sorted(glob.glob(str(ROOT / "backend" / "shared_state*.json"))):
    try:
        data = json.loads(Path(f).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    for r in data.get("runs", []):
        rid = r.get("runId")
        if rid and rid not in seen:
            seen.add(rid)
            runs.append(r)

for i in range(0, len(runs), 200):
    body = json.dumps({"runs": runs[i:i + 200]}).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:8000/api/shared/runs", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        total = len(json.loads(resp.read())["runs"])
print(f"collected {len(runs)} unique runs from backups; dashboard history now {total}")
