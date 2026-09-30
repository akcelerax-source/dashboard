"""Import benchmark runs into the dashboard's shared run history.

Every imported record is the unmodified run record produced by the simulator
(performance, summary, architectureMetrics, experimentResult); only the
identity fields the Analytics screen filters on are copied from the harness
line. Operator-stopped runs are skipped. Usage:

    python bench/import_to_dashboard.py bench/results/final/A_src_all.jsonl [more.jsonl ...]

Needs the backend on http://127.0.0.1:8000. Back up backend/shared_state.json
first (the backend keeps at most 300 runs, newest first).
"""
import json
import sys
import time
import urllib.request
from datetime import datetime

API = "http://127.0.0.1:8000/api/shared/runs"
LABELS = {"centralized": "Centralized", "decentralized": "Decentralized", "ace": "NodeX Edge AI ACE"}


def to_run(line, order):
    rec = dict(line["record"])
    started = int(datetime.fromisoformat(line["timestamp"].replace("Z", "+00:00")).timestamp() * 1000) + order
    rec.update({
        "id": line["run_id"], "runId": line["run_id"], "isLive": False,
        "systemMode": line["system"], "systemModeLabel": LABELS.get(line["system"], line["system"]),
        "scenarioCode": line["scenario"], "fleetSize": line["fleet_size"], "seed": line["seed"],
        "runKind": "test" if line.get("kind") == "aceTest" else "scenario",
        "endReason": line["end_reason"], "verdict": line.get("verdict"),
        "configVersion": line.get("configVersion"), "startedAt": started,
        "endedAt": started + int((line.get("wall_s") or 0) * 1000),
        "durationLimitSeconds": line.get("duration_limit_s"), "status": "FINISHED",
        "source": f"bench:{line.get('label') or ''}",
    })
    return rec


def main(paths):
    runs, skipped = [], 0
    for p in paths:
        with open(p, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                d = json.loads(line)
                if d.get("end_reason") == "OPERATOR_STOP" or "record" not in d:
                    skipped += 1
                    continue
                runs.append(to_run(d, len(runs)))
    for i in range(0, len(runs), 50):
        body = json.dumps({"runs": runs[i:i + 50]}).encode()
        req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
        time.sleep(0.2)
    print(f"imported {len(runs)} runs, skipped {skipped}")


if __name__ == "__main__":
    main(sys.argv[1:])
