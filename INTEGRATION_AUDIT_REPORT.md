# NodeX ACE Dashboard: End-to-End Integration Audit & Repair

Date: 2026-09-26 · Scope: `Dashboard control/` (vanilla JS + Vite 6 + Vitest) · System: ACE-AMR (ACE / RACE), 3 architectures.

**Labels:** **[C] Confirmed** means verified by a test, headless probe, or browser check. **[I] Implemented** means a fix was made and verified. **[Inf] Inferred** means read from code but not exercised. **[U] Unknown**.

**Bottom line:** Before this audit the dashboard rendered correctly but was **not integrated**. Runs could never complete: robots ping-ponged or froze, and 50/100-robot fleets were unreachable. RACE state on the panels was hard-coded, HITL was a no-op, and fabricated history was shown as real runs. Those wiring defects are fixed and covered by tests. **One blocker remains and it is algorithmic, not wiring: head-on corridor deadlocks** (see Remaining issues #1). Until it is resolved, no efficiency or "ACE is better" claim is supportable.

The earlier `STATE_AUDIT_REPORT.md` / `AUDIT_SUMMARY.md` claims of "0 logic failures", "HITL works", and "no fake values" were **false** [C]:
- phase3 had 2 real failures, phase4 had 1, and phase5-5 had 1.
- HITL had no lasting effect in ACE mode.
- EXP-042 history, the "Connected" badge, and the RobotInspector defaults were all fabricated.

---

## 1. Architecture map (as it actually runs)

```
UI (4 screens + ShellHeader/FloatingNav/SettingsPopup/ProfilePopup/HitlModal/WarehouseMap/RobotInspector)
  │ state.set(...)                        │ simLifecycle.start/pause/resume/stop/reset/restart
  ▼                                       ▼
AppState (core/state.js) ◄──────── SimLifecycleManager (core/sim-lifecycle.js)
  │  get/set/subscribe/emit                │ validate → issue RunID → freeze config (configLocked)
  │  CONFIG_LOCKED_KEYS guard              │ simEngine.reset → diagnostics → scenarioEngine.apply*
  │                                        │ → simEngine.start ; finish/stop → archiveRun
  ▼                                        ▼
SystemManager (adapters/) ─ switchSystem ─► systemMode ─► SimEngine subscription → initFleet
  │ CentralizedAdapter / DecentralizedAdapter / AceAdapter (feature gating, HITL gate)
  ▼
SimEngine (core/sim-engine.js)  one tick = update(dt)
  ├─ centralized:   CentralizedCoordinator.tick → TaskManager/AssignmentEngine/ConflictManager/GlobalPlanner
  │                 → DashboardSimulationAdapter.dispatchFleetCommands → engine.applyCoordinatorCommands
  └─ decentralized/ace: DecentralizedFleet.tick → RobotAgent.tick (bids, RACE eval, conflicts) via PeerCommunicationBus
  │ kinematics (path cursor, separation guard, shelf guard, HITL overrides) → agent.updatePhysicalState
  ▼
AppState keys published per tick: robots, kpis, coordination, events, tasks, activeSessions, contracts, simTimeSeconds
  ▼
Screens / WarehouseMap / RobotInspector (subscribe) ;  run end → data/run-history.js (archived, immutable)
ExperimentRunner (benchmarks) drives the same engine synchronously, isolated from the live run.
backend/server.py (FastAPI :8000): NOT used at runtime. No fetch/WebSocket in src/ [C].
```

## 2. Component connection matrix

| From → To | Mechanism | Status |
|---|---|---|
| Operations/Control system selector → SystemManager → AppState.systemMode | `switchSystem` | [C] works; now rejected mid-run [I] |
| AppState.systemMode → fleet rebuild | SimEngine subscription (new) | **was missing** [I] |
| AppState.systemMode → coordination reset | `resetCoordinationForMode` | **was dead code (method shadowed)** [I] |
| Fleet size (Ops cycle, Control pills, Settings select) → robotCount → initFleet | subscription | [C]; lock-guarded [I] |
| Scenario select → selectedScenario → Start | lifecycle | [C]; scenario no longer overrides fleet [I] |
| Start/Pause/Resume/Stop/Reset/Restart → SimLifecycleManager | direct calls | [C]; resume-from-STOPPED removed, stop/reset guarded [I] |
| Lifecycle → ScenarioEngine → task registries | `_loadTasks` | **re-sized fleet by task count** → fixed [I] |
| Engine ↔ RobotAgent state | snapshot + `updatePhysicalState` | path cursor & HITL flags now synced [I] |
| HITL (Ops card, Control tab, HitlModal) → hitlController → engine | `simEngine.updateRobot` write-through | **was snapshot-only (no-op)** [I] |
| RobotAgent RACE → coordination.raceMode/raceRiskComponents | `aggregateFleetRace` | **was hard-coded LOCAL/zeros** [I] |
| RobotAgent riskInputs → UI `riskComponents` | alias in `getGlobalFleetState` | **field mismatch: UI always 0.00** [I] |
| Lifecycle end → history | `recordRun` (new store) | **history was fabricated** [I] |
| ExperimentRunner → live state | snapshot/restore + refusal | **clobbered live run** [I] |
| AppState.runId → footer / Ops status card | subscriptions | **rendered once, "EXP-042" fallback** [I] |
| Settings map upload → MapGeometryEngine | none (file not parsed) | stub; now reported honestly [I], importer missing [U→open] |
| ProfilePopup → AppState.user (+localStorage) | `state.set("user")` | [Inf] works; now also used as HITL operator identity [I] |
| Theme (Settings) → AppState.theme → body class | subscription | [Inf] works (unchanged) |

## 3. Screen integration matrix (one run, all screens)

Verified in the browser on a live run (decentralized, 10 AMRs, S01; then ACE, 10 AMRs, S01) [C]:

| Value | Operations | Control | Explain (Coordination) | Analytics (Experiments) | Header/Footer |
|---|---|---|---|---|---|
| System | cards + System Status card (**was stale "Ace"**, fixed) | pills (**stale until lifecycle change**, fixed) | live view + history filter (**changed live system and relabelled runs**, fixed) | reads systemMode | header "Decentralized" ✓ |
| Fleet size | KPI + Status card (**showed boot value 3**, fixed) | pills + KPI | live summary | benchmark uses its own trial size (restored after) | — |
| Scenario | dropdown | tab | live view | own benchmark scenario (now shows the one just run) | — |
| Run ID | Status card (**never updated**, fixed) | — | live `runId`; archived id | per-trial experimentId | footer (**never updated**, fixed) |
| Lifecycle | buttons/lock | badge | status | benchmark refused while active [C] | footer sim status |

History vs live [C]: archived records are deep copies made at stop/finish; a newer run cannot alter them (test). The live view uses id `LIVE` and carries the real ID in `runId`. The run-ID guard ensures auto-finish and duration-finish act on the current run only.

## 4. Metric lineage matrix

| Metric (where shown) | Source | Classification |
|---|---|---|
| Active/Idle robots, Active tasks, Total tasks (KPI cards) | engine tick → registry counts | real runtime [C] |
| `pendingTasks` (new) | registry UNASSIGNED count | real runtime [I] |
| Throughput "tasks/hr" | completed ÷ sim time (after 10 s) | real runtime [Inf] |
| System health % | mean of robot `health` fields | deterministic sim (health is a sim field) [Inf] |
| Alerts | count of ERROR/CONTAINMENT/SAFE-DEGRADED/WAITING robots | real runtime [Inf] |
| RACE mode / 5 inputs (coordination panel) | max over agents' `raceState` / `riskInputs` | real runtime [I][C] |
| Robot inspector risk components | agent `riskInputs` | real runtime [I][C] (was always 0.00) |
| Envelopes on map | per-robot `raceState`/`envelopeRadius` | real runtime [C] (screenshot) |
| Explain summary: tasks, completed, time, failures | run snapshot | real runtime [I] |
| Explain: collisions, deadlocks, recovery, avg wait | not measured by live engine | now "Not measured" [I] (were hard-coded 0/0/"18s"/"12.4s") |
| Benchmark table (Analytics) | ExperimentRunner trials | deterministic sim [C]; fixed NaN messages, wrong conflict/replan fields, mislabelled "Completion Time" [I] |
| Benchmark headline | measured wait-time change + tasks completed | deterministic sim [I] (previously single cherry-picked metric) |
| Efficiency matrix / fleet-scale trend / recordings / insight % | `dev-fixtures/` | labelled fixture, off by default [C] |
| "Efficiency index" | **no formula exists in code or docs** | **open decision** (see §8) |

## 5. Broken connections found and fixed

| # | File | Root cause | Fix |
|---|---|---|---|
| 1 | `core/sim-engine.js` | Waypoint advance searched from the *start* of the path, so robots ping-ponged between waypoints 0 and 2 forever (0 tasks completed in 120 s) [C] | Forward-only per-path cursor `advanceAlongPath`, synced to agents |
| 2 | `core/scenario-engine.js` | Every scenario wrote `robotCount` (S01→3, **S03→20, unsupported**), so 50/100 were unreachable in any run [C] | Selected fleet is authoritative; scenario count kept as `recommendedRobotCount` |
| 3 | `core/scenario-engine.js` `_loadTasks` | Centralized `initializeFleet(tasks.length)` sized the fleet by task count (6 robots for fleet 3), assigned then deleted tasks, and the run "finished" in under 30 s with every task unassigned [C] | New `CentralizedCoordinator.loadScenarioTasks` that loads tasks without rebuilding the fleet |
| 4 | same + `DecentralizedFleet` | 30% of HIGH-load tasks preloaded as `ASSIGNED` with no robot: phantom tasks that never finish [C] | All tasks load UNASSIGNED |
| 5 | `DecentralizedFleet` | Tasks whose auction closed while agents were busy were never offered again (16 stuck UNASSIGNED) [C] | `reannounceOpenTasks` (task-board re-broadcast; allocation stays P2P) |
| 6 | `RobotAgent.checkPeerLiveness` | Orphaned task marked FAILED, but only UNASSIGNED can be claimed, so a failed robot's task was lost (phase4 failure; S08 path) [C] | `releaseTask` instead of `failTask` |
| 7 | `CentralizedCoordinator`, `DecentralizedFleet` | Lane spawn step of 14 px (below the 32 px separation), so at 50 robots 41 were permanently frozen and at 100, 94 were [C] | `MapGeometryEngine.computeFleetSpawnPoints` (validated, ≥34 px, on aisles) |
| 8 | `core/sim-engine.js` | Separation guard froze *both* robots of any close pair, even when moving apart [C] | Block only gap-closing moves (`closesSeparation`) |
| 9 | `core/sim-engine.js` | Auto-finish when `activeTasks==0` ignored UNASSIGNED work; its guard was never reset, so only the first run per page load could finish [C] | Finish only when no open tasks; guarded by run ID; only in RUNNING |
| 10 | `core/sim-engine.js` + lifecycle | Scenario `duration` (300/600 s) displayed but never enforced; deadlocked runs never ended [C] | Duration limit → FINISHED with `end_reason=DURATION_LIMIT` |
| 11 | `core/state.js` | Two methods named `updateCoordinationState`; the partial-merge one shadowed the mode reset, so switching system never reset RACE/network state [C] | Renamed to `resetCoordinationForMode` |
| 12 | `core/sim-engine.js` (ACE branch) | Every tick wrote `raceMode:"LOCAL"` and all-zero risk inputs, so the panel never followed RACE [C] | `aggregateFleetRace` over agents + `activeEnvelopes` |
| 13 | `DecentralizedFleet.getGlobalFleetState` | Agents publish `riskInputs`, UI reads `riskComponents`, so the inspector showed 0.00 and HitlModal details could throw [C] | `riskComponents` alias (ACE only) |
| 14 | `hitl-controller.js`, `ScreenOperations.js`, `HitlModal.js` | HITL mutated snapshot copies that the next tick discarded (no-op in ACE). Operations had a duplicate path bypassing the audit log and gating. The modal held a stale robot reference; the lease didn't stop autonomy [C] | Write-through via `simEngine.updateRobot`; engine honours `hitlHold`/`hitlSpeedLimit`/`controlMode HUMAN`; safe-stop triggers re-auction; one dispatch path |
| 15 | `state.js`, Operations vs Control | HITL scope `fleet/group/individual` vs `ENTIRE_FLEET/...`, so screens disagreed [C] | `normalizeHitlScope` on write; canonical values everywhere |
| 16 | `state.js` + all config UIs | No core config lock: Settings robot count / Reset-to-default / Explain system selector could change or rebuild the fleet mid-run [Inf→C] | `configLocked` + `CONFIG_LOCKED_KEYS` rejected in `AppState.set`; `initFleet` refuses while locked |
| 17 | `sim-lifecycle.js` | Run ID generated twice from `Date.now().slice(-4)` (mismatch, repeats); `simActiveConfig` overwritten by the scenario engine (runId lost); resume allowed from STOPPED; stop/reset unguarded | Single `generateRunId`; merge instead of replace; resume only from PAUSED; guarded stop; fresh fleet reset per Start |
| 18 | `adapters/SystemManager.js` / engine | Comment claimed SystemManager rebuilt the fleet on mode change; it didn't, so the engine drove the old architecture's robots [C] | Engine subscribes to `systemMode` → `initFleet` |
| 19 | `experiment-runner.js` | Benchmark switched the live system/fleet/scenario and reset events; could destroy an active run; `step()` toggled `simRunning`, fabricating a live PAUSED run [C] | Refuse while live; snapshot/restore; `update(dt, force)` without touching `simRunning` |
| 20 | `experiment-runner.js` | Centralized ran on its own seeded + continuously generated tasks (unfair workload); `messages = tasksAssigned*2` gave NaN; conflicts/replans read nonexistent fields; `completionTime` = trial length [C] | Identical task set via both loaders; `null` = not measured; correct fields; real completion time or null |
| 21 | `sim-engine.applyCoordinatorCommands` | Path copied only when non-empty, so a finished route stayed on the map [Inf] | Mirror the coordinator path exactly |
| 22 | `WarehouseMap.js` | Drew the whole `plannedPath`, including driven legs; a replan looked layered on the old route [Inf] | `remainingRoute` (robot → target → rest of path) [C test] |
| 23 | `WarehouseMap.js` | Decentralized region fill alpha 0.05, effectively invisible [C] | Filled blue region (0.16) [C screenshot] |
| 24 | `WarehouseMap.regenerateMap` / `loadMap` | WH-B/WH-C overwritten by the generator on fleet/scenario change; `loadMap` ignored the layout lock | Static maps via `loadMap`; lock honoured |
| 25 | `ScreenOperations.js` System Status card | Rendered once, so it showed boot system/count during other runs [C] | Reactive `renderSystemStatusCard` |
| 26 | `ScreenControl.js` | Pills re-rendered only on lifecycle change, so they went stale after edits on other screens [C] | Subscriptions for system/fleet/scenario/HITL |
| 27 | `ScreenCoordination.js` | Explain "System" dropdown changed the *live* system and relabelled the displayed run's architecture [C] | Read-only history filter |
| 28 | `screens.css` `.ops-center-viewport` | Map column stretched to the tallest sidebar (2251 px), so the warehouse was drawn off-screen [C] | Viewport-bounded sticky column |
| 29 | `ShellHeader.js` | `"Disconnected (...)".includes("connected")` is true, so a green "Connected" badge showed with no backend [C] | Enum-driven; shows "Local Sim" |
| 30 | `sim-lifecycle.js` (my own change, caught in browser) | Final state published before the run was archived, so the history list missed the run | Archive first, then publish; no spurious PAUSED (test) |

## 6. Dummy / fake data audit

| Item | Where | Classification | Action |
|---|---|---|---|
| "44% improvement at 100", "98.3% completion", "+19.7%", "-66% messages", 83.6/66.5/49.6 indices | `ScreenExperiments.js` insights | Intentional labelled fixture (only when `devFixturesEnabled`, disclaimer bar) | Kept gated; non-fixture copy made accurate (removed "ROS 2 bridge", "20 AMRs") |
| System-comparison bar values (86/124/168…) | `ScreenExperiments.drawSystemComparisonChart` | Labelled fixture (gated) | Unchanged |
| Efficiency matrix, fleet-scale, recordings | `dev-fixtures/benchmark-fixtures.js` | Labelled fixture, default off [C] | Unchanged; export no longer calls them "Measured" [I] |
| Report `efficiencyIndex: "Measured"` for fixture data; `duration 00:20:00`, `50,000 m²` | `benchmark-runs.js` | **Fake claim** | Relabelled "DEV FIXTURE (not measured)"; real map id |
| Missing runs shown as `0`, `0%`, "0 overlaps" | `benchmark-runs.js` | **Placeholder shown as measured** | "Awaiting run" |
| EXP-042 "PASS", 168 tasks/hr, 18 s recovery, etc. | `simulation-history.js` `SIMULATION_RUNS` | **Fake history shown as real** | Demo fixture only when dev fixtures on, labelled `[DEMO FIXTURE]`; real run store added |
| Live summary collisions 0, deadlocks 0, recovery "18s", avg wait "12.4s", end time "00:02:15", fake timeline | `simulation-history.getLiveRunData` | **Fabricated** | Measured values or "Not measured"; no fabricated timeline |
| Default run ID "EXP-042" (state, footer, sentinel) | `state.js`, `main.js`, screens | **Fake identity** | `null` / "—" until a run starts |
| Robot fallback (battery 74, 1.24 m/s, T-204) | `RobotInspector.getDefaultRobot` | **Placeholder shown as telemetry** | Removed; empty state |
| "Operator OP-8821 (Lead Engineer)", lease token #LSE-8821-4491, "AI Confidence 94.2%", "Acceleration 0.45" | `HitlModal.js` | **Fabricated** | Profile identity, generated token, real target velocity/RACE inputs |
| "Connected" badge | `ShellHeader.js` | **Fake status** (substring bug) | "Local Sim" |
| Map upload "registered successfully" and activated | `SettingsPopup.js` | **Fake capability** (file never parsed) | Registers only, says import not implemented |
| `judge-demo.js` (scripted teleports, injected risk, hard-coded `collisionsDetected: 0`) | core | Scripted demo, **not wired to any UI** (dead import) [C] | Left; see remaining issues |
| `sim-lifecycle2.js` | core | Dead duplicate, not imported [C] | Left |
| Seed 18427, tick 100 Hz | state | Deterministic sim parameters | OK |
| Static labels ("Virtual LiDAR + IMU", "Speed Clamp 1.5 m/s") | UI | Descriptive config text | OK (inferred) |

## 7. Test results & evidence

- **Baseline before changes** [C]: 120 Vitest tests passed, but the inline suites had **4 real failures** (phase3 ×2, phase4 ×1, phase5-5 ×1) that the prior reports hid behind "process.exit infrastructure".
- **After** [C]: `npx vitest run` gives **152/152** Vitest tests passing. Inline suites: phase2 43/43, phase3 37/37, phase4 67/67, phase5-5 32/32, phase5-integration 30/30, phase6 55/55, pre-integration 32/32. The 7 "failed files" are **only** the known harness pattern (`process.exit` / no `describe`), with 0 failed assertions.
- `npm test` (now includes `sim-lifecycle-hitl` and the new suite): **105/105**. `vite build`: OK.
- New suite `tests/integration-audit.test.js` (32 tests): fleet sizes 3/10/50/100 honoured; centralized fleet not sized by tasks; one run ID; config lock; resume only from PAUSED; spawn validity ×4; forward-only cursor; separation guard; ACE task progress; 50-robot no overlap / no rack entry for 10 s; remaining-route rendering; auto-finish semantics; duration limit + archive; history immutability; HITL hold persistence, scope canonicalization, ACE-only gating; fleet rebuild on switch; coordination reset; RACE aggregation (unit + live); benchmark refusal, restore, no phantom lifecycle, NaN removal; report provenance labels; lifecycle transition ordering.
- **Stale tests corrected (intended contract changes, documented inline):** phase3 (fleet init no longer announces tasks), phase5-5 (WH-A is generated, not `RACK-UA`), phase5-integration (`completionTime`), phase9 (live view id `LIVE`).
- **Browser (dev server :3010)** [C]:
  - Run config consistent across Operations, Control, header, footer, and store.
  - Mid-run changes rejected on Operations, Control, and Settings.
  - HITL HOLD via the Operations card: R01 moved 0.00 px in 3 s, and the audit shows `INDIVIDUAL_ROBOT` / operator "Engineer".
  - Benchmark refused mid-run; after an idle benchmark the lifecycle stays IDLE and the config is restored.
  - Stop archives the run, and the archive persists across reload.
  - Explain filter leaves the live system untouched.
  - Map shows filled decentralized regions and ACE envelopes (CONTAINMENT/NEIGHBORHOOD) tracking agent states.
  - No app console errors (the only error is Vite's HMR socket).

## 8. Efficiency formula: open decision

No efficiency-index formula is defined in code or in the existing docs [C]. The only comparative formula is `ExperimentRunner.calculateImprovement` (relative % change, sign-aware; now `null` when either side is unmeasured). The 0–100 "efficiency index" values exist only in dev fixtures. **A formula (metrics, weights, normalisation, fleet-size handling) must be decided by the team;** none was invented. Exports now state `definition: UNDEFINED`.

## 9. Files changed

`src/core/`: `state.js`, `sim-engine.js`, `sim-lifecycle.js`, `scenario-engine.js`, `map-geometry.js`, `hitl-controller.js`, `experiment-runner.js`, `centralized/CentralizedCoordinator.js`, `decentralized/DecentralizedFleet.js`, `decentralized/RobotAgent.js`.
`src/data/`: `run-history.js` (new), `simulation-history.js`, `benchmark-runs.js`.
`src/components/`: `HitlModal.js`, `RobotInspector.js`, `SettingsPopup.js`, `WarehouseMap.js`, `ShellHeader.js`.
`src/screens/`: `ScreenOperations.js`, `ScreenControl.js`, `ScreenCoordination.js`, `ScreenExperiments.js`. `src/main.js`, `src/styles/screens.css`.
`tests/`: `integration-audit.test.js` (new), `phase3-decentralized`, `phase5-5-audit`, `phase5-integration`, `phase9-simulation-window`. `package.json` (`test` script). `dist/` rebuilt by `vite build`.
Pre-audit snapshot of `src/` and `tests/` was taken before editing (session scratchpad), since the folder is not a git repo.

## 10. Remaining issues (not fixed)

1. **Traffic deadlocks: largely resolved at 3–10 robots, still open at high density.** See §11. With the fixes, 72 of 84 scenario runs (14 scenarios × 3 architectures × 3/10 robots, 300 s cap) complete every task. The remaining stalls are mostly Centralized at 10 robots (S02, S03, S04) and the combined-stress S13. At 50/100 robots all architectures still gridlock: the aisles hold about 100 robot slots at 34 px spacing, so there is no free space to back off into. This is a map/scenario capacity limit, not a protocol bug.
2. Efficiency formula undefined (§8).
3. Map upload has no geometry importer (YAML/PGM); uploads are registered but not usable.
4. The default benchmark trial is 10 s, which is too short for most tasks to finish. The table now says so, but trial duration should be set per scenario.
5. The live engine does not measure collisions, deadlocks, recovery time, or average wait (shown as "Not measured"); the benchmark path does measure some of these.
6. Teleop moves under a lease can leave a robot off its route; after release it resumes toward its target and the shelf guard may stop it [Inf].
7. HITL commands are gated by architecture (ACE) but not by the "armed" toggle at the controller level; the UI hides the buttons when disarmed [Inf].
8. Test harness: 7 legacy files still use `process.exit`/inline asserts, so Vitest reports them as failed files. Convert them to `describe/test`.
9. Dead code: `core/sim-lifecycle2.js`; `core/judge-demo.js` (scripted, hard-coded "0 collisions"; delete or label if ever wired to UI).
10. `backend/server.py` (FastAPI :8000) is not the runtime source of truth; the adapters report in-process `CONNECTED`, and nothing connects to it [C].
11. The space-time-contract layer renders many overlapping labels at 10+ robots (visual clutter, not correctness).

## 11. Follow-up: traffic control, scenario faults and reproducibility (2026-09-26)

A peer session implemented back-off-to-last-intersection (`src/core/deadlock-backoff.js`). Independent verification showed throughput still flatlined after about 1 minute [C]. This session then found and fixed the causes below, measured with a headless probe that drives the real Start path.

| # | File | Root cause | Fix |
|---|---|---|---|
| 31 | `deadlock-backoff.js` | Resume went straight from the refuge stub to the old target: a diagonal across a rack corner, so the robot froze MOVING against a shelf where no conflict rule ever saw it [C] | Resume retraces refuge → intersection → yield point → route; all legs axis-aligned |
| 32 | `deadlock-backoff.js` | Retreat point taken from `pathCursor`, which can belong to an older path, so it "retreated" to a non-adjacent node across racks [C] | Geometric retreat: the intersection the robot is in, else the nearest one behind it on its aisle |
| 33 | `deadlock-backoff.js` | Refuge stub at 40 px stayed inside the intersection lock's 36 px release distance, so a robot parked in its refuge kept the hub locked [C] | Stub at 44 px |
| 34 | `deadlock-backoff.js` | Loser at the front of a queue was told to reverse into its own follower (impossible); two queues meeting at a hub had no escape [C] | `retreatFeasible`/`chooseYielder`: whoever can actually retreat yields; a robot already in a hub steps into that hub's stub |
| 35 | `deadlock-backoff.js` | Leg-occupancy check sampled from the robot's own position, so the blocker behind it "occupied" every escape leg [C] | Only robots ahead along a leg obstruct it |
| 36 | `deadlock-backoff.js` | Resume ended when the blocker was momentarily far away, while it was still heading down the same lane, so the pair took turns backing off [C] | Hold until the blocker's remaining route no longer passes the intersection; mutual holds tie-broken by robot ID |
| 37 | `deadlock-backoff.js` | Head-on test compared `heading`; a waiting robot keeps its last-movement heading, so a real head-on looked like following [C] | Compare intended directions (toward target) |
| 38 | `RobotAgent.js`, `ConflictManager.js` | Robots holding in a refuge (off the lane, about 44 px from the hub) were still conflict parties, so passing robots yielded to them [C] | Refuge holders are ignored in conflict detection (maneuver phase is broadcast) |
| 39 | `intersection-reservation.js` (new), `sim-engine.js` | Several robots entered a hub from different aisles at once and jammed it [C] | FIFO mutex per intersection in the execution layer, identical for all architectures; a decentralized holder has right of way over robots queued for it (`waitingForNode`) |
| 40 | `sim-engine.js` | Robots that finished tasks parked in lanes/hubs/stubs and boxed each other in; a parked robot cannot ask a peer to move [C] | Parked-robot clearance cascade (parked blocker → parked obstructors on its aisle → stuck robot backs off, with retries); parked lock holders are evicted when others queue |
| 41 | `sim-engine.js` | A failed robot is a permanent obstacle and nothing routed around it (S08) [C] | Reroute avoiding the failed robot's aisle segment, applied only if the new route stays clear of it |
| 42 | `GlobalPlanner.js`, `map-geometry.js` | Planner fallbacks produced diagonal legs across open floor, stranding robots off the aisle grid [C] | `orthogonalizePath` on every planned path |
| 43 | `scenario-engine.js`, `sim-engine.js` | Per-tick "condition generators" re-applied one-shot effects every frame: forced R01–R04 targets into racks, froze Centralized robots (comm loss / bottleneck), added an obstacle and a fault **every tick**, and flooded the event log. They only had lasting effect in Centralized (Decentralized/ACE state is rebuilt from agents each tick), so S02–S13 were skewed against Centralized [C] | Per-tick generators are no longer run; faults come from the one-shot timed events |
| 44 | `scenario-engine.js` | Timed faults used wall-clock `setTimeout`/`setInterval`: wrong sim time at 2×/5×, kept counting while paused, never fired in benchmarks; health degradation wrote snapshots only [C] | Sim-time scheduler advanced by the engine; health degradation writes through `updateRobot` |
| 45 | `RobotAgent.js`, `DecentralizedFleet.js` | Broadcast interval, peer liveness, staleness and bid windows used `Date.now()`, so identical runs differed with CPU speed [C] | Fleet agents use the sim clock (injectable `clock`); two identical headless runs now match exactly |
| 46 | `sim-engine.js` | KPIs survived `reset()`; after a completed run the next run read "0 open / N total" and auto-finished on its first tick [C] | `reset()` clears task KPIs (verified in the browser: a second Start now runs normally) |

**Measured results** (headless, deterministic, 300 s cap; tasks completed):

| Fleet / scenario | Before this follow-up | After |
|---|---|---|
| 3 robots, S01 (all architectures) | 6/6 Centralized & ACE, 5/6 Decentralized | 6/6 all |
| 10 robots, S01 | Centralized 3/10, Decentralized 6/10, ACE 4/10 (flat after about 3 min) | 10/10 all |
| Full matrix: 14 scenarios × 3 architectures × 3/10 robots | not measured | 72/84 complete (Centralized 22/28, Decentralized 25/28, ACE 25/28) |
| 50 / 100 robots, S01 | gridlock | still gridlock (capacity) |

These completion counts come from the shared traffic heuristics interacting with each architecture's conflict rules. They are **not** evidence that one architecture outperforms another.

**Still open:**
- Stalls at 10 robots in Centralized S02/S03/S04 and in the combined-stress S13 (several architectures). S02/S03 runs for Decentralized/ACE are still progressing when the 300 s cap ends.
- 50/100-robot capacity: needs a larger map, dedicated parking for idle robots, or one-way aisles.
- Remaining scenario-engine defects: `_injectTaskBurst` announces a 2.5× task surge but creates no tasks; `_startProgressiveRiskEscalation` (A01) scripts RACE states and risk values directly instead of producing them; `_applyCommConditions` and `_injectCascadePressure` write snapshots, so they only affect Centralized.
- S08 creates only 2 tasks, so at 10 robots they finish before the failure fires at 135 s and the recovery path is never exercised.
- The browser loop advances by frame time, so interactive runs are not bit-reproducible (headless runs and benchmarks are).

**Tests:** new `tests/traffic-control.test.js` (15 tests): intersection mutex (exclusivity, FIFO, stale queue, never trapping), path orthogonalisation, resume routing with a stale cursor, sim-time faults firing once at the right time, no per-tick generator effects, reproducibility, and **full** S01 completion for all architectures at 3 and 10 robots. Weaker thresholds were already met by the gridlocked build. Two existing tests were updated for intended changes (agent clock in phase4 TEST 7; retrace resume in `deadlock-backoff.test.js`), with comments. `npx vitest run` / `npm test`: **14 files, 261/261 passing**; `vite build` OK. Browser: ACE 10-robot S01 completes at 5× speed; a second Start after a completed run runs normally; no console errors.

## 12. Second integration pass (2026-09-26, evening)

Scope: re-verify the acceptance chain (Screen 1 → run → Screen 2 → Screen 3, Settings, Profile) and close the open blockers from §10/§11. Supported fleet sizes are **3, 10, 50, 100** only. The removed 500-robot option has no reference in `src/`, `tests/`, the docs, or the rebuilt `dist/` [C].

### 12.1 Defects found and fixed

| # | File(s) | Problem | Root cause | Fix | Screens |
|---|---|---|---|---|---|
| 47 | `screens/ScreenExperiments.js`, `data/run-history.js` | **Completed runs never reached Screen 3.** The matrix showed "Awaiting telemetry" for a scenario that had just completed | Screen 3 read only benchmark trials and dev fixtures | Each archived run now carries measured `performance` (tasks done/total, completion %, completion time only when every task finished, throughput). The matrix shows the latest recorded run per scenario × system ("Not recorded" otherwise). The Recordings panel lists recorded runs with a JSON download. Screen 3 re-renders on `runHistoryVersion` | 3 |
| 48 | `ScreenExperiments.js` | Every re-render re-bound container listeners and state subscriptions (duplicate handlers). A system switch did not re-render the ACE-only panel | `bindEvents()` mixed per-render and one-time bindings | New `bindOnce()` for delegated listeners and subscriptions; re-render on `systemMode` | 3 |
| 49 | `ScreenExperiments.js` | Efficiency-index footer said "Awaiting run", which implied a run would fill it | No formula exists | Footer says "Formula not defined"; panel renamed "Recorded Run Comparison" outside fixture mode | 3 |
| 50 | `core/admission-control.js` (new), `AssignmentEngine.js`, `RobotAgent.js`, `DecentralizedFleet.js` | 50/100 robots gridlocked in every architecture | All robots took tasks at once; the aisle grid holds about 100 robot slots | Identical admission cap for all architectures: fleets above 10 run at most 6 concurrent tasks. Open tasks are not re-announced while the cap is full (this removed a bid storm) | 1 |
| 51 | `map-geometry.js`, `sim-engine.js`, `GlobalPlanner.js`, `ConflictManager.js`, `RobotAgent.js` | Idle robots parked on lanes and boxed traffic in | No off-lane parking existed | Off-lane parking bays, up to 4 rows deep; a deep bay is used only while its front bays are empty (`bayExitClear`). Fleets above 14 spawn in bays; idle lane robots return to a bay (`returnIdleToBays`). Bay robots leave perpendicular to the aisle, merging robots yield to lane traffic, and robots in bays are not conflict parties | 1 |
| 52 | `map-geometry.js`, `WarehouseMap.js`, `ScreenOperations.js` | 100 robots cannot fit on the 900×520 floor (only about 69 off-lane cells) | Fixed floor | The 100 tier uses a 900×860 floor with a south staging lane `H-PARK`. `WAREHOUSE_DIMENSIONS` follows the active layout. The renderer floor, the minimap, and the Screen 1 overview (previously a hard-coded aisle copy that missed V-MID1) read it | 1 |
| 53 | `sim-lifecycle.js`, `sim-engine.js`, `GlobalPlanner.js` | Runtime geometry was generated only by the map widget; before Start, 24 of 100 robots were drawn inside racks | Fleet was placed on the previous layout | Start and `initFleet` load the run's layout first; every `GlobalPlanner` instance rebuilds its graph when the layout changes | 1 |
| 54 | `deadlock-backoff.js`, `sim-engine.js` | A robot could hold a task with a one-point route and keep a hub locked forever | Back-off captured the route only from the current target | Back-off replans to the path end when the target is off-path; shared `repairLostRoutes` watchdog replans any route that ends short of the task destination | 1 |
| 55 | `CentralizedCoordinator.js` | Detours were half-applied, and robots with no task were set MOVING | `PATH_REPLANNED` set `currentPath` but not `plannedPath` (the engine follows `plannedPath`). CONFLICT_RESOLVED/PROCEEDING set MOVING without a task | Both fixed. Waits orphaned by a dropped conflict record now resume | 1 |
| 56 | `ConflictManager.js`, `RobotAgent.js`, `intersection-reservation.js` | Several deadlocks: leader waited for its follower; robot inside a hub yielded to one entering it; a robot queued on a lock won right-of-way | Missing or asymmetric right-of-way rules | Shared rules in both arbiters: lane leader proceeds (`laneLeader`); hub occupant wins over a robot whose leg passes the hub (`legPassesNode`); a robot queued on a lock never wins. Decentralized mutual-wait tie-break: lower ID proceeds after 1.5 s | 1 |
| 57 | `sim-engine.js`, `deadlock-backoff.js` | Stale `waitingForNode`; symmetric back-off livelock (seen in the browser: R02/R04 on S04) | Field not cleared while yielding; hold ended while the blocker was still retreating | Field cleared for yielding robots; a retreating blocker counts as "still coming" | 1 |
| 58 | `sim-engine.js` | Orphan MOVING robot with no task, maneuver or bay held a hub (100-robot Decentralized stalled at 30/100 depending on start state) | Idle rules only run for IDLE robots | Shared `normalizeIdle` invariant | 1 |
| 59 | `ConflictManager.js`, `deadlock-backoff.js`, `CentralizedCoordinator.js` | S08: the failed robot was revived to MOVING, and its task stayed FAILED unless a robot happened to be idle | Arbiter skipped only lowercase `error`; failure handler reassigned or failed the task | Failed robots are never conflict parties or maneuvered; the task returns to the dispatch queue | 1, 2 |
| 60 | `CentralizedCoordinator.js` | Fleet init created and assigned 6 phantom tasks (visible in Screen 2 event history before `TASK_LOAD`); continuous generation left robots in ASSIGNED | Leftover seeding | Init creates robots only (same as the decentralized fleet); tasks come only from the scenario | 1, 2 |
| 61 | `scenario-engine.js`, `CentralizedCoordinator.js`, `DecentralizedFleet.js` | `_injectTaskBurst` created no tasks | Event and fault card only | Real tasks added to the running architecture (`addTasks`) | 1, 2, 3 |
| 62 | `scenario-engine.js`, `PeerCommunicationBus.js`, `RobotAgent.js`, `sim-engine.js` | Comm conditions and A01/A04 wrote snapshot fields (Centralized only); A01 scripted risk values | See §11 | Peer bus gets deterministic loss and latency (latency ages `lastSeen`, a real RACE input). A01 escalates latency, not risk values. A04 stalls robots through `scenarioStall` in every architecture | 1 |
| 63 | `scenario-engine.js` | S08 had 2 tasks, so the failure never exercised reallocation at 10+ robots. The `deadlocks_resolved` validation rule returned `true` | Scenario sizing; fake rule | 4 tasks per robot; fake rule removed (validation rules are not wired to the UI) | 1 |
| 64 | `DecentralizedFleet.js` | ACE sessions paired every NEIGHBORHOOD/CONTAINMENT robot with every robot at any distance (fleet-wide fake links, O(n²)) | No range check | Sessions only within 64 px or the envelope radius | 1 (map layers) |
| 65 | `RobotAgent.js`, `race-evaluator.js`, `DecentralizedFleet.js` | ACE at 100 robots cost 82 ms per tick (not real-time) | `inbox.shift()` O(n²), bid storm, full-horizon lookahead for far pairs | Index walk, no re-announce while capped, exact reachability early-exit: now about 10 ms per tick (Decentralized about 4, Centralized about 1) | 1 |
| 66 | `ScreenOperations.js`, `sim-lifecycle.js` | Fleet table showed every robot "Moving"; counts stale after finish | Case mismatch (`idle` vs `IDLE`); no publish after the final tick | Normalized status; robots re-published on finish | 1 |
| 67 | `ScreenOperations.js` | Centralized showed "Communication OFFLINE ✔" | Read the peer network in Centralized mode | Shows the server or peer link of the active architecture; warning icon when not online | 1 |
| 68 | `hitl-controller.js` | HITL "armed" gate existed only in the UI | — | Controller rejects interventions while disarmed; RESUME is still allowed | 1 |
| 69 | `ScreenControl.js` | An uploaded map (geometry not imported) was selectable, so the run was labelled with it while running WH-A | — | Such maps are listed as disabled "(geometry not imported)" | 1, Settings |
| 70 | `ProfilePopup.js` | "Change Password" reported "✓ Password updated successfully" | No auth backend exists | Reports that it is not available and that nothing was changed | Profile |
| 71 | `sim-lifecycle2.js` (deleted; backup in the session scratchpad), `judge-demo.js`, `ScreenOperations.js` | Dead duplicate lifecycle; unused scripted demo imported by Screen 1 | — | Deleted; judge demo labelled "scripted, never a result source" and its import removed | — |

### 12.2 Verified flows [C]

- **Browser (dev server :3010):**
  - Run A: Centralized, 3 robots, S01. Pause held the clock and positions for 2.5 s; Resume kept the same run ID and clock. It finished `ALL_TASKS_COMPLETE` at 82.7 s, and the fleet table showed Idle.
  - Run B: ACE, 10 robots, S04. `runConfig` = ace/S04/10. Live ACE state showed LOCAL 5 / NEIGHBORHOOD 4 / CONTAINMENT 1, all 10 robots with RACE components, and 0 sessions beyond envelope range. It finished `ALL_TASKS_COMPLETE` at 104.4 s.
  - Screen 2: Run A shows S01 / Centralized / 3 AMRs / 6 of 6 / 1:22 with its own events (including pause/resume). Run B shows S04 / ACE / 10 AMRs / 11 of 11 / 1:44. Neither inherits from the other.
  - Screen 3: S01×Centralized = "100% · 82.7s · 3R"; S04×ACE = "100% · 104.4s · 10R". Other cells show "Not recorded"; the footer shows "Formula not defined"; Recorded Simulation Runs lists both.
  - Settings: robot count 50 plus Light theme → state, Screen 1 KPI, and runtime fleet (50) all updated, and the theme was applied.
  - Profile: open; Edit Profile propagated to state, the header, and the popup; close works.
  - HITL: rejected while disarmed. Armed via the UI toggle, "Hold Motion" froze all 3 robots for 2.5 s, with an audit entry (ENTIRE_FLEET, success). "Resume Nav" released them.
  - Stop archived the run as OPERATOR_STOP and unlocked the config.
  - ACE-only Screen 3 panel is gated in Centralized mode. No app console errors.
- **Tests:** `npx vitest run` **15 files, 286/286 passing**; `vite build` OK. New `tests/high-density.test.js` (24 tests) covers:
  - layout per fleet size (3/10/50/100);
  - bays and the 100-robot floor;
  - Start loads the run layout;
  - admission cap in all architectures;
  - **full S01 completion at 50 and 100 robots in all three architectures**;
  - S02 burst creates real tasks in each architecture;
  - S07 degrades real peer links;
  - deterministic bus loss;
  - S08 fault keeps the robot failed;
  - run-history performance and Screen 3 lookup;
  - a finished run is archived with its own system, scenario, and fleet size.

  Updated tests (intended contract changes, with comments): phase2 TEST 2/3/4 and phase3 TEST 3/4 (a robot already inside the intersection keeps right-of-way; tasks come from the scenario loader), phase8 S1-02/S1-03 (a dispatched task is started), phase9 fleet bounds (active floor), HITL tests arm the console first, plus a new disarmed-rejection test.

### 12.3 Full scenario matrix (headless, deterministic, 6000 s sim cap, final code) [C]

14 scenarios × 3 architectures × 3/10/50/100 robots = 168 runs, each started after `simLifecycle.reset()` (as in the app). OK = every task completed (`ALL_TASKS_COMPLETE`); otherwise tasks completed / total at the cap. **No robot ended inside a rack in any run.**

| Scenario | C3 | C10 | C50 | C100 | D3 | D10 | D50 | D100 | A3 | A10 | A50 | A100 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S01 | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| S02 | OK | OK | 208/213 | 410/413 | OK | OK | OK | OK | OK | 51/53 | OK | OK |
| S03 | OK | 16/25 | OK | OK | OK | OK | 24/25 | 24/25 | 23/25 | OK | OK | 7/25 |
| S04 | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | 99/101 |
| S05 | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| S06 | OK | OK | 23/51 | OK | OK | OK | OK | OK | OK | OK | 25/51 | OK |
| S07 | OK | OK | OK | OK | OK | OK | 14/51 | 7/101 | OK | OK | 14/51 | 6/101 |
| S08 | OK | 23/42 | OK | 259/402 | OK | OK | 142/202 | 135/402 | OK | OK | 126/202 | 27/402 |
| S09 | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| S10 | OK | OK | OK | 36/101 | OK | OK | OK | OK | OK | OK | OK | 31/101 |
| S11 | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| S12 | OK | OK | OK | 36/101 | OK | OK | 19/51 | 40/101 | OK | OK | 47/51 | 49/101 |
| S13 | 22/24 | 51/52 | OK | 79/412 | OK | 49/52 | 3/212 | 14/412 | OK | 50/52 | 113/212 | 84/412 |
| S14 | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK | 31/101 |

Totals: **130/168**. At 3/10 robots: **76/84** (was 72/84 in §11, and the scenarios now inject real faults). At 50/100 robots: **54/84** (was 0 before this pass: all 50/100 runs gridlocked). S01, S05, S09 and S11 complete in all 12 cells.

These are shared-heuristic traffic results. They are not evidence that one architecture beats another.

### 12.4 Decision: **INTEGRATION NOT COMPLETE**

The data and control chain is proven end to end for every architecture and all four fleet sizes: UI → AppState → run config → runtime → live state → run history → Screen 2 → Screen 3, plus Settings and Profile. Every run, including one that stalls, is recorded honestly: `DURATION_LIMIT` or `OPERATOR_STOP` with measured completion. The acceptance requirement "the selected scenario runs to completion at the selected fleet size" still fails in 38 of 168 cells, mostly fault and stress scenarios at 50/100 robots. So the verdict remains NOT COMPLETE.

### 12.5 Remaining issues

**Integration blockers**
1. Traffic gridlocks in fault and stress scenarios (table above). Patterns:
   - S07: comm loss at 50/100 in Decentralized and ACE, with 80% peer loss;
   - S08: a failed robot left inside a lane next to a hub;
   - S12: health-degraded robots;
   - S13: combined stress;
   - S03: single-hub saturation (all four approach arms full, no retreat room).

   Each needs traffic-level work (bounded hub queues, rerouting around a failed robot's whole aisle, multi-robot cascade back-off). This is not wiring.

**Functional bugs / limitations**
2. The admission cap (6 concurrent tasks for fleets above 10) keeps 50/100 robots moving, but it limits throughput to about 6 working robots. Large fleets mostly show parked robots, and high-load scenarios take long (S02 at 100 robots: 413 tasks).
3. Results depend on start state: a prior `reset()` changed one 100-robot outcome from 100/100 to 30/100 before fix #58. Other chaotic cases may remain. Browser runs step by frame time and are not bit-reproducible.
4. The live engine still does not measure collisions, deadlocks, recovery time or average wait. These show as "Not measured".
5. The Screen 3 KPI table and charts are fed by benchmark trials ("Run Benchmark"), not by live runs. They are labelled "Awaiting run" until a trial runs.
6. There is still no efficiency-index formula; this is a team decision.
7. Map upload still has no geometry importer; uploaded maps are disabled in the selector.

**UI / polish**
8. At 100 robots the markers are small (5 px) on the 900×860 floor.
9. The space-time-contract layer is still cluttered at 10+ robots.

**Non-critical**
10. `backend/server.py` is unused at runtime.
11. Validation rules in `scenario-engine.js` are unused.

### 12.6 Skills and tools

- **Used:**
  - Claude Browser pane: the full UI journey on the dev server.
  - Headless node probes (a node script that imports `src/core` with a localStorage stub): the matrices and traces.
  - `node --cpu-prof`: performance profiling (fix #65).
  - Vitest and `vite build`.
- **Installed:** none. `find-skills` was not needed: browser automation, profiling and tests were already available.
- **Unavailable:** graft (the dependency-graph MCP server) timed out on connect, so dependency tracing used grep and reading code.
