# Backend

FastAPI server for the NODEX ACE dashboard (`server.py`).

- REST API for fleet, robot, RACE, session, contract and run data.
- WebSocket telemetry bridge (`/ws/telemetry`).
- Shared state across browsers (`/api/shared`, `/ws/shared`): operator preferences and run history, so every open dashboard sees the same results.
- Serves the built dashboard (`dist/`) at `/` when it exists.

## Run

```bash
pip install -r backend/requirements.txt
python backend/server.py
```

Listens on `http://localhost:8000`. The Vite dev server (`npm run dev`) proxies `/api` and `/ws` here.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/fleet` | Fleet snapshot |
| GET | `/api/robots/{id}` | One robot |
| GET | `/api/race/{id}` | RACE risk state for one robot |
| GET | `/api/sessions` | Active coordination sessions |
| GET | `/api/contracts` | Space-time reservation contracts |
| GET, POST | `/api/runs` | Experiment runs |
| POST | `/api/hitl/request`, `/api/hitl/release` | Human-in-the-loop control lease |
| GET | `/api/shared` | Shared prefs and run history |
| PUT | `/api/shared/prefs` | Update shared prefs |
| POST, DELETE | `/api/shared/runs` | Add or clear shared runs |
| WS | `/ws/telemetry`, `/ws/shared` | Live telemetry and shared-state push |
| GET | `/healthz` | Health check |

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8000` | Listen port |
| `NODEX_DATA_DIR` | `backend/` | Folder holding `shared_state.json` (for example a mounted volume) |
| `NODEX_PUBLIC` | unset | `1` = public demo; shared history and prefs are read-only for visitors |
| `NODEX_DIST_DIR` | `../dist` | Built dashboard served at `/` |

## Data

`shared_state.json` is the recorded run history. It seeds an empty `NODEX_DATA_DIR` and is published with the GitHub Pages build. Timestamped `shared_state.backup-*.json` files are local backups and are not committed.
