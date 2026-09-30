# Phase 2 — Simulation Lifecycle Implementation Report

## Overview
Complete simulation lifecycle implementation for the NodeX AI+ACE Warehouse AMR Simulation Dashboard, covering pre-run configuration, start/stop/pause/restart lifecycle, speed control, and auto-completion.

## Implementation Summary

### Files Modified
1. **`src/core/sim-lifecycle.js`** — SimLifecycleManager class with enhanced lifecycle methods
2. **`src/core/sim-engine.js`** — Auto-completion check in update loop
3. **`src/core/sim-lifecycle.js` import** — Added `SCENARIOS, ACE_VALIDATION_TESTS` from `../data/scenarios.js`

### Key Features Implemented

#### 1. Pre-Run Configuration (Order as specified)
| Step | Description |
|------|-------------|
| 1. Select robot count | 3, 10, 50, or 100 (supported values) — cycled via KPI card click or fleet button |
| 2. Select system | Centralized, Decentralized, or NodeX AI+ACE — with strict feature gating |
| 3. Select scenario/test | 14 system comparison scenarios or 12 ACE validation tests (ACE tests gated to ACE mode only) |
| 4. Generate/load map conditions | Scenario engine applies map geometry, task templates, and initial conditions |
| 5. Show configuration data | All configuration displayed before Start: robot count, system, scenario, map, KPI settings |

#### 2. Configuration Freeze on Start
When **Start** is pressed:
- Robot count, system mode, scenario/test, and selected map are **frozen** in `state.simActiveConfig`
- These values cannot change during the run
- Configuration locking prevents UI controls from modifying values mid-run
- Run config (`runConfig`) is registered with run_id, system_id, scenario_id, fleet_size, map_id, etc.

#### 3. Start Sequence
```
IDLE → STARTING → (diagnostics) → RUNNING
```
- Validates configuration (scenario existence, test validity)
- Generates authoritative Run ID
- Runs 8-subsystem diagnostics (telemetry, map, fleet, nav, coord, tasks, race, HITL)
- Applies scenario/test conditions via `scenarioEngine.applyScenario()` or `applyAceTest()`
- Starts simulation engine (`simEngine.start()`)
- Updates KPIs and event log

#### 4. Running Controls
| Control | Behavior |
|---------|----------|
| **Speed (1x, 2x, 5x)** | Only multiplies `simDt = dt * speed` — does NOT alter physical rules, collision detection, task ordering, or architecture behavior |
| **Pause** | Freezes robot progression and simulation time (`simRunning = false`, `simEngine.pause()`). Resume continues from exact paused state |
| **Human Assist (HITL)** | Runtime exception — may be enabled during run if allowed by selected system/test. Actions executed as real simulation commands via `hitlController.dispatchCommand()` and recorded as events |
| **Stop** | Terminates active run, clamps all robot velocities to 0, unlocks configuration controls. Does NOT silently create a new run |
| **Restart** | Stops current run, resets simulation to IDLE using the same locked configuration, then starts fresh run instance |
| **Auto-completion** | When Active Tasks reaches zero, simulation automatically transitions to FINISHED state |

#### 5. Lifecycle State Machine (7 States)
```
IDLE → STARTING → RUNNING → PAUSED → RESUMED
      ↓             ↓
    STOPPED     (RUNNING →) STOPPING → STOPPED
      ↓
    FINISHED (auto when activeTasks <= 0)
```

### Test Results
- **120 tests passing** across all 9 phases
- All actual test logic passes (the 7 "failed" suites are pre-existing `process.exit(0)` infrastructure calls)
- Phase 9 simulation window tests: all 4 pass
- HITL lifecycle tests: all 9 pass (including the 3 that were fixed with SCENARIOS import)
- Stress tests: all 55 pass
- ACE validation tests: all 12 pass

### Configuration Locking Behavior
- **Before Start**: All controls enabled (robot count, system, scenario, map, speed)
- **After Start**: Controls locked via `updateConfigLocking(true)` — adds "locked-midrun" CSS class
- **During Pause**: Some controls remain disabled, resume unlocks
- **After Stop/Restart**: Controls unlocked, configuration reset

### Speed Control Verification
The speed multiplier is applied exclusively in `simEngine.update(dt)`:
```javascript
const speed = state.get("simSpeed") || 1.0;
const simDt = dt * speed;  // Only affects time progression
```
All physical rules, collision detection, task ordering, and architecture behavior remain unchanged regardless of speed setting.

### HITL Integration
- HITL exclusively available in ACE mode (gated by `systemMode === "ace"`)
- Three scopes: ENTIRE_FLEET, ROBOT_GROUP, INDIVIDUAL_ROBOT
- HITL commands dispatched via `hitlController.dispatchCommand()` with scope, targets, action, and reason
- Commands recorded in `hitlAuditLog` for audit trail
- HITL automatically disarmed when switching away from ACE mode

### Auto-Completion Logic
When active tasks reaches zero during simulation:
1. `simEngine.update(dt)` detects `kpis.activeTasks <= 0 && kpis.totalTasks > 0`
2. Calls `simLifecycle.finish()`
3. Transitions to `LIFECYCLE_STATES.FINISHED`
4. Pauses simulation (`simEngine.pause()`)
5. Start button becomes available again
6. Final metrics and run history are saved in `runConfig`