# NODEX ACE-AMR Fleet Operations & Coordination Dashboard
### SIH 2026 Prototype Baseline & Master Engineering Implementation

NODEX ACE is an enterprise-grade autonomous fleet coordination, observation, simulation, and scientific evaluation dashboard built for edge-AI distributed Autonomous Mobile Robots (AMRs) operating in smart warehouses.

---

## Key Highlights & UI Reference Baseline

- **Light Industrial Enterprise Theme**: Built strictly according to the approved visual reference screens with white and soft blue-gray surfaces (`#F8FAFC`), dark navy typography (`#0F172A`), precision blue accents (`#2563EB`), restrained glassmorphism (`backdrop-filter: blur(12px)`), and Inter typography with tabular figure metrics.
- **Floating Navigation Dock**: Central horizontal dock pill providing instant switching across all four screens:
  - **Operations**: What is happening right now?
  - **Coordination**: Why and with whom are robots coordinating?
  - **Control**: What scenario is running and how can it be safely controlled?
  - **Experiments**: What did the matched benchmark experiments prove?
- **Three Architecture Map Signatures**:
  1. **CENTRALIZED**: Central coordinator radio tower at top-center with continuous broadcast signal lines to all active AMRs.
  2. **DECENTRALIZED**: Fixed-radius blue peer neighborhood bubbles around active AMRs.
  3. **ACE (Risk-Adaptive Coordination Envelope)**: In normal local operation, no permanent bubble is shown; a dynamic blue adaptive coordination envelope appears only on-demand as risk increases, expands to encompass interacting peers, and contracts/dissolves once resolved.

---

## Mathematical Mechanisms & Core Algorithms (Section 5)

### 1. Task Bid Cost ($C_i$)
$$C_i = w_d D_i + w_t T_i + w_b B_i + w_l L_i + w_r R_i$$
Where terms are normalized distance, estimated completion time, battery cost constraint, current workload, and current risk.

### 2. RACE Risk Engine ($R_{base}$)
$$R_{base} = w_1 C + w_2 U + w_3 CR + w_4 Q + w_5 CP$$
- $C$: Spatiotemporal conflict probability
- $U$: Sensor & localization uncertainty
- $CR$: Communication latency / packet loss risk
- $Q$: Queue growth rate
- $CP$: Cascade pressure in adjacent aisles

### 3. Hysteresis State Machine
- **LOCAL $\rightarrow$ NEIGHBORHOOD**: if $risk \ge 0.50$ for $N \ge 3$ consecutive evaluations.
- **NEIGHBORHOOD $\rightarrow$ CONTAINMENT**: if $risk \ge 0.70$ for $N \ge 3$ evaluations.
- **CONTAINMENT $\rightarrow$ NEIGHBORHOOD**: if $risk \le 0.55$ for $N \ge 3$ evaluations and minimum dwell time $\ge 5.0\text{ s}$.
- **NEIGHBORHOOD $\rightarrow$ LOCAL**: if $risk \le 0.35$ for $N \ge 3$ evaluations and minimum dwell time $\ge 5.0\text{ s}$.
- **Critical Degradation**: Transitions robot into **SAFE-DEGRADED** crawl mode.

### 4. Deadlock Detection & Cycle Recovery
Constructs a dynamic wait-for graph ($A \rightarrow B \rightarrow C \rightarrow A$) using depth-first search (DFS). Detected cycles trigger automated backoff, priority reversal, and D* Lite dynamic replanning.

---

## The Four Dedicated Screens

### Screen 01: Operations Command Center
- **Top KPI Strip**: Active Robots (50 / 100), Idle Robots (12), Active Tasks (28 / 50), Fleet Throughput (1,248 tasks/hr), System Health (98%), Active Alerts (3).
- **Hero Warehouse Map**: Interactive 2D canvas with warehouse floor plan, storage racks (Storage A, Storage B, Receiving, Picking, Packing, Shipping, Maintenance, Charging Zone), restricted hazard area with red diagonal stripes, AMRs with heading arrows and status glow, continuous routes, and crossing caution zone.
- **Selected Robot Inspector (R07)**: 3D AMR preview, battery bar, velocity, health %, current task, RACE state (`NEIGHBORHOOD`), risk score meter (`0.71`), sub-tabs (`Task`, `Health`, `Comm`, `Coord`), **View Details** modal, and **Take Control** button.
- **Lower Operational Cards**: Live Events stream, Fleet Status donut chart & breakdown, Task Distribution progress bars, System Health node grid, and persistent Map Overview mini-map.

### Screen 02: Coordination & RACE Intelligence
- **Real-Time Coordination View**: Warehouse map with map legend and coordination layer checklist.
- **Coordination Details Card**: Active session (`S-034` with `R07` $\leftrightarrow$ `R11`), conflict resolution status, and space-time reservation contract (`C-012`).
- **Nearby Robots Table**: Real-time peer table showing ID, status, distance, and task intent.
- **Coordination Insights (AI)**: Automated decision explanations with verified status checkmarks.
- **Coordination Metrics & Sparklines**: 12 active sessions, 1.8s negotiation time, 0 deadlocks, 100% resolutions, line chart of Sessions vs. Conflicts, and RACE distribution donut chart (Local 58%, Neighborhood 28%, Containment 10%, Safe-Degraded 4%).

### Screen 03: Control & Simulation Center
- **Simulation Setup & Run Controls**: Start, Pause, Reset, Stop buttons; Speed selector (`0.25x` to `5x`); Fleet size selector (`3`, `10`, `50`, `100`); Map selector & upload lifecycle manager; Environment toggles (Dynamic humans, obstacles, variable arrival, realistic traffic).
- **Center Simulation Map**: Real-time physical kinematic simulator running at 100 Hz.
- **Fault Injection Registry**: Injects Robot Failure (`R11`), Comm Delay, Comm Loss, Dynamic Obstacles, and Central Link Failure (`C14`).
- **Active Faults Card**: Recovery timelines with **Clear All** action.
- **Simulation Timeline Scrubber**: Interactive timeline with milestone pins.
- **Quick Actions**: Add Random Obstacle, Spawn Human, Pause All Robots, and Global Emergency Safe Stop.

### Screen 04: Experiments & Scientific Evaluation
- **Map-Free Scientific Layout**: High-density evidence cockpit designed for SIH 2026 judges.
- **Experiment Setup Bar**: Scenario selector (`S01` to `S14`), Seed (`18427`), Fleet size selector, and **Run Experiment** button.
- **Efficiency Comparison Matrix**: 14 comparison situations across Centralized, Decentralized, and ACE, with color-graded heat scores and composite **NODEX Experimental Efficiency Index** (49.6 vs. 66.5 vs. 83.6).
- **Raw Performance Metrics Table**: Strictly separated from efficiency score: Completion Time, Throughput, Average Waiting Time, Deadlocks, Collisions, Coordination Messages Overhead, Recovery Time, Task Completion %, and Robot Utilization %.
- **System Comparison Charts**: Grouped bar chart comparing the three architectures and multi-line fleet scale performance trend chart (3 to 100 AMRs).
- **Data-Derived Insights Panel**: Automated evidence synthesis (Fleet Scale Insight, Best System by Scale, ACE Advantage, Coordination Savings).
- **Experiment Recordings**: Replay archive with duration, date, and download actions.
- **ACE Innovation Validation**: Table of all 12 core tests (`A01` to `A12`) with verified `PASS` status.

---

## Human-in-the-Loop (HITL) Safety Architecture

1. Operator clicks **Take Control** on any AMR (e.g. `R07`).
2. Authentication check verifies operator authorization (`OP-8821`, Level 3).
3. A cryptographic control lease is granted with an active 60-second watchdog countdown timer.
4. Robot state transitions from `AUTONOMOUS` to `HUMAN`.
5. Manual motion commands pass through the **Command Arbiter** and **Safety Supervisor** (rule-based velocity clamp at 1.5 m/s and obstacle proximity inhibition).
6. Watchdog timeout or clicking **Release Control** safely returns the robot to `AUTONOMOUS` mode.
7. **Emergency Safe Stop** is available at any time to instantly inhibit drive motors.

---

## Running the Application Locally

### 1. Frontend Web Dashboard (Vite)
```bash
# In project root:
npm install
npm run dev
```
Open **`http://localhost:3010/`** in your browser.

### 2. Backend Server & ROS 2 Telemetry Bridge (FastAPI)
```bash
# In project root:
python backend/server.py
```
API endpoints will be live at **`http://localhost:8000/`**:
- `GET /api/fleet`
- `GET /api/robots/{id}`
- `GET /api/race/{id}`
- `GET /api/sessions`
- `GET /api/contracts`
- `GET /api/runs`
- `POST /api/hitl/request`
- `POST /api/hitl/release`
- `WebSocket /ws/telemetry`

Full endpoint and configuration list: [backend/README.md](backend/README.md).

### 3. Tests
```bash
npm test
```
Runs the Vitest suites in `tests/` headlessly (no browser needed). See [tests/README.md](tests/README.md).

### 4. Docker (dashboard + backend on one port)
```bash
docker build -t nodex-ace .
docker run -p 8000:8000 nodex-ace
```
FastAPI serves the built dashboard at `/` and the API/WebSocket at `/api` and `/ws`. Set `NODEX_DATA_DIR` to a mounted volume to persist run history.

### 5. GitHub Pages (static demo)
`.github/workflows/pages.yml` builds the dashboard with `VITE_STATIC_DATA=1` on every push to `main` and ships `backend/shared_state.json` as a static file, so no backend is needed. Enable once: **Settings > Pages > Source: GitHub Actions**.

---

## Repository Layout

| Path | Contents |
|------|----------|
| `index.html`, `src/` | Dashboard source (vanilla JS + Vite). `src/core/` holds the simulator and the three coordination systems (`centralized/`, `decentralized/`, `ace/`); `src/screens/` holds the four screens. |
| `public/` | Static assets. |
| `backend/` | FastAPI server and shared run history. See [backend/README.md](backend/README.md). |
| `tests/` | Vitest regression suites. See [tests/README.md](tests/README.md). |
| `bench/` | Headless benchmark harness and analysis scripts. See [bench/README.md](bench/README.md). |
| `zz-base/` | Frozen pre-optimization copy of `src/`, used as the benchmark baseline. See [zz-base/README.md](zz-base/README.md). |
| `docs/` | Architecture, experiment and results write-ups. See [docs/README.md](docs/README.md). |
| `*_REPORT.md`, `PHASE2_*.md` | Audit and implementation reports from development phases. |
| `Dockerfile`, `.github/workflows/` | Deployment. |
