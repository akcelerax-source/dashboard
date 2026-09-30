"""Load benchmark run records into the dashboard's shared run history.

Usage: python bench/final/import_to_dashboard.py <runs.jsonl> [--label TAG]

Each JSONL line is one real harness run (bench/lib.js). Its recorded run
object (`record`) is posted unchanged to the backend (/api/shared/runs), so
the Analytics screen computes efficiency from the same data as the report.
Only runs with an ablation label other than none are skipped. Backs up
backend/shared_state.json first.
"""
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
src = Path(sys.argv[1])
tag = sys.argv[sys.argv.index("--label") + 1] if "--label" in sys.argv else "BENCH"

state = ROOT / "backend" / "shared_state.json"
if state.exists():
    shutil.copy(state, state.with_name(f"shared_state.backup-{int(time.time())}.json"))

runs = []
for line in src.read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    row = json.loads(line)
    rec = row.get("record")
    if not rec or row.get("ablate"):
        continue
    rec = dict(rec)
    rec["runId"] = rec["id"] = f"{tag}-{row['system'][:3].upper()}-{row['scenario']}-{row['fleet_size']}-s{row['seed']}-{row['run_id']}"
    rec["source"] = f"bench:{src.name}"
    # Harness records carry no wall-clock start; the backend keeps the newest
    # 300 by startedAt, so stamp the harness timestamp (ms).
    if not rec.get("startedAt"):
        from datetime import datetime
        rec["startedAt"] = int(datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
    for k in ("systemMode", "scenarioCode", "fleetSize", "seed", "endReason"):
        rec.setdefault(k, {"systemMode": row["system"], "scenarioCode": row["scenario"], "fleetSize": row["fleet_size"],
                           "seed": row["seed"], "endReason": row["end_reason"]}[k])
    runs.append(rec)

body = json.dumps({"runs": runs}).encode("utf-8")
req = urllib.request.Request("http://127.0.0.1:8000/api/shared/runs", data=body,
                             headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req) as resp:
    total = len(json.loads(resp.read())["runs"])
print(f"posted {len(runs)} runs from {src}; dashboard history now {total}")
