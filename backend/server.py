# ==========================================================================
# NODEX ACE - FastAPI Backend & ROS 2 / DDS Bridge Server
# Section 7: Data, API and Integration Design
# ==========================================================================

import asyncio
import json
import os
import time
from pathlib import Path
from typing import List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Deployment settings (all optional; defaults match local development).
#   PORT            listen port (hosting platforms set this)
#   NODEX_DATA_DIR  folder holding shared_state.json (e.g. a mounted volume)
#   NODEX_PUBLIC    "1" = public demo: the shared run history and preferences
#                   are read-only for visitors, so nobody can wipe or overwrite
#                   the recorded results. Visitors' own runs stay in their browser.
#   NODEX_DIST_DIR  built dashboard (vite build output) served at "/"
BASE_DIR = Path(__file__).resolve().parent
PUBLIC_MODE = os.environ.get("NODEX_PUBLIC") == "1"
DIST_DIR = Path(os.environ.get("NODEX_DIST_DIR", BASE_DIR.parent / "dist"))

app = FastAPI(
    title="NODEX ACE Fleet Coordination API",
    version="0.9.3",
    description="Backend API and WebSocket telemetry bridge for NODEX ACE Autonomous Mobile Robot (AMR) fleets."
)

# Enable CORS for frontend Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# The shared run history is several MB of JSON; compress it on the wire.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# In-Memory Fleet State Database
FLEET_STATE = {
    "system_mode": "ace",
    "fleet_size": 50,
    "scenario_id": "S08",
    "map_id": "WH-A",
    "run_id": "EXP-042",
    "robots": [
        {
            "id": "R07",
            "model": "AMR-200",
            "status": "active",
            "x": 305.0,
            "y": 205.0,
            "heading": 0.0,
            "velocity": 1.24,
            "battery": 74,
            "health": 98,
            "location": "Aisle A-12",
            "current_task": "T-204 (Pick)",
            "race_state": "NEIGHBORHOOD",
            "risk_score": 0.71,
            "coordination_scope": "4 robots",
            "control_mode": "AUTONOMOUS",
            "risk_components": {
                "conflict": 0.78,
                "uncertainty": 0.12,
                "comm_risk": 0.15,
                "queue_growth": 0.22,
                "cascade_pressure": 0.35,
                "ai_risk": 0.68,
                "ai_confidence": 0.94
            }
        },
        {
            "id": "R11",
            "model": "AMR-200",
            "status": "error",
            "x": 365.0,
            "y": 245.0,
            "heading": 3.1415,
            "velocity": 0.0,
            "battery": 52,
            "health": 42,
            "location": "Crossing Aisle A-12",
            "current_task": "T-204 (Yielded)",
            "race_state": "CONTAINMENT",
            "risk_score": 0.88,
            "coordination_scope": "Cluster containment",
            "control_mode": "AUTONOMOUS",
            "risk_components": {
                "conflict": 0.92,
                "uncertainty": 0.35,
                "comm_risk": 0.20,
                "queue_growth": 0.45,
                "cascade_pressure": 0.60,
                "ai_risk": 0.85,
                "ai_confidence": 0.91
            }
        },
        {
            "id": "R03",
            "model": "AMR-200",
            "status": "active",
            "x": 230.0,
            "y": 260.0,
            "heading": 3.1415,
            "velocity": 0.95,
            "battery": 82,
            "health": 99,
            "location": "Aisle A-10",
            "current_task": "T-102 (Pick)",
            "race_state": "LOCAL",
            "risk_score": 0.24,
            "coordination_scope": "Local",
            "control_mode": "AUTONOMOUS"
        }
    ],
    "sessions": [
        {
            "id": "S-034",
            "status": "Active",
            "robots": ["R07", "R11"],
            "type": "Crossing Coordination",
            "scope": "NEIGHBORHOOD",
            "risk_score": 0.71,
            "reason": "Head-on conflict at Aisle A-12",
            "negotiation": "ORCA (Adaptive via RACE)"
        }
    ],
    "contracts": [
        {
            "id": "C-012",
            "zone": "Crossing Aisle A-12",
            "holder": "R07",
            "yielded": "R11",
            "time_window": "10:42:25 - 10:42:35",
            "status": "Active",
            "ttl_remaining": 6.8
        }
    ],
    "hitl_leases": {}
}

# Pydantic Schemas
class HitlRequest(BaseModel):
    operator_id: str
    target_robot_id: str
    command_sequence: int = 1
    ttl_seconds: int = 60

class HitlRelease(BaseModel):
    operator_id: str
    target_robot_id: str
    lease_id: str

class RunCreate(BaseModel):
    scenario_id: str
    fleet_size: int
    system_mode: str
    seed: int = 18427


# --- REST API Endpoints (Section 7.3) ---

@app.get("/api/fleet")
def get_fleet():
    """Retrieve full fleet telemetry and system status."""
    return {
        "status": "success",
        "system_mode": FLEET_STATE["system_mode"],
        "fleet_size": len(FLEET_STATE["robots"]),
        "robots": FLEET_STATE["robots"]
    }

@app.get("/api/robots/{robot_id}")
def get_robot(robot_id: str):
    """Retrieve single robot telemetry."""
    for r in FLEET_STATE["robots"]:
        if r["id"].upper() == robot_id.upper():
            return {"status": "success", "robot": r}
    raise HTTPException(status_code=404, detail="Robot not found")

@app.get("/api/race/{robot_id}")
def get_race_telemetry(robot_id: str):
    """Retrieve detailed RACE coordination state and multi-factor risk components."""
    for r in FLEET_STATE["robots"]:
        if r["id"].upper() == robot_id.upper():
            return {
                "status": "success",
                "robot_id": r["id"],
                "race_state": r.get("race_state", "LOCAL"),
                "filtered_risk": r.get("risk_score", 0.18),
                "thresholds": {
                    "T_local_enter": 0.50,
                    "T_neigh_enter": 0.70,
                    "T_contain_exit": 0.55,
                    "T_neigh_exit": 0.35
                },
                "persistence_samples": 3,
                "minimum_dwell_seconds": 5.0,
                "risk_components": r.get("risk_components", {})
            }
    raise HTTPException(status_code=404, detail="Robot not found")

@app.get("/api/sessions")
def get_sessions():
    """Retrieve active peer coordination sessions."""
    return {"status": "success", "sessions": FLEET_STATE["sessions"]}

@app.get("/api/contracts")
def get_contracts():
    """Retrieve active space-time reservation contracts."""
    return {"status": "success", "contracts": FLEET_STATE["contracts"]}

@app.get("/api/runs")
def get_runs():
    """Retrieve stored benchmark and evaluation runs."""
    return {
        "status": "success",
        "active_run": FLEET_STATE["run_id"],
        "runs": [
            {"run_id": "EXP-042", "scenario": "S08", "system_mode": "ace", "robots": 50, "result": "PASS"},
            {"run_id": "EXP-041", "scenario": "S04", "system_mode": "decentralized", "robots": 50, "result": "PASS"},
            {"run_id": "EXP-040", "scenario": "S01", "system_mode": "centralized", "robots": 50, "result": "PASS"}
        ]
    }

@app.post("/api/runs")
def create_run(req: RunCreate):
    """Create a new matched experiment run."""
    new_run_id = f"EXP-{int(time.time()) % 1000:03d}"
    return {
        "status": "success",
        "run_id": new_run_id,
        "config": req.dict(),
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S")
    }

@app.post("/api/hitl/request")
def request_hitl_lease(req: HitlRequest):
    """Request a safety-gated HITL control lease."""
    target_id = req.target_robot_id.upper()
    existing_lease = FLEET_STATE["hitl_leases"].get(target_id)

    if existing_lease and existing_lease["expires_at"] > time.time():
        if existing_lease["operator_id"] != req.operator_id:
            raise HTTPException(status_code=409, detail="Robot is already leased to another operator.")

    lease_id = f"LSE-{int(time.time()) % 10000:04d}"
    expires_at = time.time() + req.ttl_seconds

    FLEET_STATE["hitl_leases"][target_id] = {
        "lease_id": lease_id,
        "operator_id": req.operator_id,
        "expires_at": expires_at,
        "status": "ACTIVE"
    }

    # Update robot control mode
    for r in FLEET_STATE["robots"]:
        if r["id"] == target_id:
            r["control_mode"] = "HUMAN"

    return {
        "status": "granted",
        "lease_id": lease_id,
        "target_robot_id": target_id,
        "expires_at": expires_at,
        "ttl_seconds": req.ttl_seconds,
        "safety_supervisor": "ACTIVE_SPEED_CLAMP_1_5MS"
    }

@app.post("/api/hitl/release")
def release_hitl_lease(req: HitlRelease):
    """Release HITL control lease back to autonomous mode."""
    target_id = req.target_robot_id.upper()
    if target_id in FLEET_STATE["hitl_leases"]:
        del FLEET_STATE["hitl_leases"][target_id]

    for r in FLEET_STATE["robots"]:
        if r["id"] == target_id:
            r["control_mode"] = "AUTONOMOUS"

    return {"status": "released", "target_robot_id": target_id, "control_mode": "AUTONOMOUS"}


# --- WebSocket Live Telemetry Streaming (Section 7.4) ---

@app.websocket("/ws/telemetry")
async def telemetry_websocket(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # Emit live robot telemetry at 20 Hz
            payload = {
                "timestamp": time.time(),
                "system_mode": FLEET_STATE["system_mode"],
                "robots": FLEET_STATE["robots"],
                "active_sessions": FLEET_STATE["sessions"],
                "contracts": FLEET_STATE["contracts"]
            }
            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(0.05)
    except WebSocketDisconnect:
        pass


# --- Shared Dashboard State (cross-browser sync) ---
# UI preferences and archived run history live here instead of only in each
# browser's localStorage, so every open dashboard (any browser, any device on
# the LAN) sees the same settings and runs. Changes are pushed to all open
# dashboards over /ws/shared. Persisted to shared_state.json next to this file.

SHARED_FILE = Path(os.environ.get("NODEX_DATA_DIR", BASE_DIR)) / "shared_state.json"
SEED_FILE = BASE_DIR / "shared_state.json"  # bundled results, copied to an empty volume
SHARED_PREF_KEYS = {"theme", "timeFormat", "autoRefresh", "robotCount"}
MAX_SHARED_RUNS = 3000
RUNS_PER_SLOT = 6  # newest runs kept per (kind, scenario, fleet, system); mirrors run-history.js


def _prune_runs(runs):
    """Newest-first list pruned per slot so old fleets/scenarios are never evicted by new runs."""
    count, out = {}, []
    for r in runs:
        code = r.get("scenarioCode") or ""
        kind = r.get("runKind") or ("test" if code[:1] == "A" and code[1:2].isdigit() else "scenario")
        k = (kind, code, str(r.get("fleetSize")), r.get("systemMode"))
        if count.get(k, 0) >= RUNS_PER_SLOT:
            continue
        count[k] = count.get(k, 0) + 1
        out.append(r)
        if len(out) >= MAX_SHARED_RUNS:
            break
    return out


def _load_shared():
    source = SHARED_FILE if SHARED_FILE.exists() else SEED_FILE
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
        prefs = data.get("prefs") if isinstance(data.get("prefs"), dict) else {}
        runs = data.get("runs") if isinstance(data.get("runs"), list) else []
        return {"prefs": prefs, "runs": runs}
    except (OSError, ValueError):
        return {"prefs": {}, "runs": []}


def _save_shared():
    SHARED_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SHARED_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(SHARED), encoding="utf-8")
    os.replace(tmp, SHARED_FILE)


SHARED = _load_shared()
SHARED_CLIENTS = set()


async def _broadcast_shared(message):
    text = json.dumps(message)
    for ws in list(SHARED_CLIENTS):
        try:
            await ws.send_text(text)
        except Exception:
            SHARED_CLIENTS.discard(ws)


class RunsUpload(BaseModel):
    runs: List[dict]


@app.get("/api/shared")
def get_shared():
    """Current shared preferences and archived run history."""
    return {"status": "success", **SHARED}


@app.put("/api/shared/prefs")
async def put_shared_prefs(prefs: dict):
    """Merge preference changes and push them to every open dashboard."""
    changes = {k: v for k, v in prefs.items() if k in SHARED_PREF_KEYS}
    if PUBLIC_MODE:
        # Each visitor keeps their own settings; nothing is shared or saved.
        return {"status": "success", "prefs": {**SHARED["prefs"], **changes}}
    if changes:
        SHARED["prefs"].update(changes)
        _save_shared()
        await _broadcast_shared({"type": "prefs", "prefs": SHARED["prefs"]})
    return {"status": "success", "prefs": SHARED["prefs"]}


@app.post("/api/shared/runs")
async def post_shared_runs(req: RunsUpload):
    """Add archived runs (one record per runId), newest first."""
    known = {r.get("runId") for r in SHARED["runs"]}
    added = [r for r in req.runs if r.get("runId") and r.get("runId") not in known]
    if PUBLIC_MODE:
        # Echo the visitor's runs back merged with the recorded history so they
        # stay in that visitor's browser, without changing the shared results.
        merged = sorted(added + SHARED["runs"], key=lambda r: r.get("startedAt") or 0, reverse=True)
        return {"status": "success", "runs": _prune_runs(merged)}
    if added:
        merged = added + SHARED["runs"]
        merged.sort(key=lambda r: r.get("startedAt") or 0, reverse=True)
        SHARED["runs"] = _prune_runs(merged)
        _save_shared()
        await _broadcast_shared({"type": "runs", "runs": SHARED["runs"]})
    return {"status": "success", "runs": SHARED["runs"]}


@app.delete("/api/shared/runs")
async def clear_shared_runs():
    """Clear archived run history on every dashboard."""
    if PUBLIC_MODE:
        raise HTTPException(status_code=403, detail="Run history is read-only on the public demo.")
    SHARED["runs"] = []
    _save_shared()
    await _broadcast_shared({"type": "runs", "runs": []})
    return {"status": "success", "runs": []}


@app.websocket("/ws/shared")
async def shared_websocket(websocket: WebSocket):
    await websocket.accept()
    SHARED_CLIENTS.add(websocket)
    try:
        while True:
            await websocket.receive_text()  # clients only listen; keeps the socket open
    except WebSocketDisconnect:
        pass
    finally:
        SHARED_CLIENTS.discard(websocket)


# Keep-alive: Render's free plan sleeps a service after 15 min without inbound
# requests. When running on Render (RENDER_EXTERNAL_URL is set by Render),
# request our own public URL every 10 min; the request enters through Render's
# edge, so it counts as traffic. Disable with NODEX_KEEPALIVE=0.
KEEPALIVE_URL = os.environ.get("RENDER_EXTERNAL_URL")
KEEPALIVE_SECONDS = 600


def _ping(url):
    import urllib.request
    with urllib.request.urlopen(url, timeout=30) as res:
        return res.status


async def _keepalive_loop():
    url = KEEPALIVE_URL.rstrip("/") + "/healthz"
    while True:
        await asyncio.sleep(KEEPALIVE_SECONDS)
        try:
            await asyncio.to_thread(_ping, url)
        except Exception as exc:
            print(f"[keepalive] ping failed: {exc}")


@app.on_event("startup")
async def _start_keepalive():
    if KEEPALIVE_URL and os.environ.get("NODEX_KEEPALIVE") != "0":
        asyncio.create_task(_keepalive_loop())


@app.get("/healthz")
def healthz():
    """Liveness probe for the hosting platform and uptime monitors."""
    return {"status": "ok", "runs": len(SHARED["runs"]), "public": PUBLIC_MODE}


# Built dashboard at "/". Mounted last so /api, /ws and /healthz win.
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="dashboard")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
