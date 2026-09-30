# NodeX SIH 2026: Three-System Architecture Compliance Audit and Repair (r3)

Date: 2026-09-27. Scope: `Dashboard control/` (vanilla JS, Vite 6, Vitest). This report supersedes `INTEGRATION_AUDIT_REPORT.md` for architecture questions.

Evidence labels: **[T]** automated test, **[P]** headless probe run, **[B]** browser check, **[C]** code reading only.

## 1. Components inspected

- Frontend: `src/screens/*`, `src/components/*` (WarehouseMap, RobotInspector, HitlModal, ShellHeader).
- Runtime: `src/core/sim-engine.js`, `sim-lifecycle.js`, `scenario-engine.js`, `state.js`, `map-geometry.js`, `intersection-reservation.js`, `deadlock-backoff.js`, `admission-control.js`, `race-evaluator.js`, `hitl-controller.js`, `experiment-runner.js`.
- Controllers: `src/core/centralized/*`, `src/core/decentralized/*`, `src/core/adapters/*`.
- Data and history: `src/data/run-history.js`, `simulation-history.js`, `scenarios.js`.
- Backend: `backend/server.py` exists but nothing at runtime calls it (no fetch or WebSocket in `src/`).
- 500 robots: no reference in `src/`, `tests/`, `README.md` or the rebuilt `dist/`. Supported counts are `[3, 10, 50, 100]` (`state.js`). **PASS**

## 2. Architecture violations found (before repair)

| # | Violation | Where |
|---|---|---|
| V1 | A shared traffic brain ran for all three systems with a global view. It evicted parked robots, cleared blockers, rerouted around failures, sent robots to bays and repaired routes. | `SimEngine.evictParkedNodeHolders / clearParkedBlockers / returnIdleToBays / repairLostRoutes / normalizeIdle / rerouteAroundFailed` |
| V2 | A global FIFO intersection reservation table decided right of way for the decentralized systems. | `SimEngine.intersections` in both branches |
| V3 | Decentralized sessions and contracts were fabricated from pairwise distance each tick. One robot could be in many "pairs", and contracts were never consumed. | `DecentralizedFleet.updateActiveSessions` |
| V4 | System 2 carried ACE state: `raceState = "NEIGHBORHOOD"` and "4 robots (neighborhood)". | `RobotAgent` constructor, `setAceMode` |
| V5 | There was no Edge AI. RACE inputs were heuristics over the peer cache (radio), not sensors. | `RobotAgent.computeLocalRaceInputs` |
| V6 | ACE scope was hard-coded ("4 robots"). ACE sessions were always pairs. | `race-evaluator.js`, V3 |
| V7 | System 1 used greedy one-task-at-a-time assignment, not a batch or Hungarian solve. There was no CBS: routes were single-agent A*. | `AssignmentEngine.assignPendingTasks`, `GlobalPlanner` |
| V8 | S14 "server outage": robots were set to WAITING in a snapshot, and the coordinator resumed them on the next tick, so the outage had no effect. Link loss was faked as a crawl speed. | `scenario-engine.js` |
| V9 | The 3-, 10- and 50-robot runs used the same 900x520 world (same aisles). Only rack count differed. The overview camera cropped the 3- and 10-robot maps (zoom 1.8 and 1.4). | `map-geometry.js`, `WarehouseMap.resizeCanvas` |
| V10 | The map drew fake P2P links between any robots within 120 px, a 40 px blue ring on every robot, static humans and a static pallet, and a hard-coded R07 glow. | `WarehouseMap.js` |
| V11 | `simTestResult` was never computed at run end (it stayed "RUNNING"). `evaluateResult()` was never called. | `scenario-engine.js` |
| V12 | Collisions were "Not measured". Run records had no seed, map profile or architecture metrics. | `run-history.js` |
| V13 | HITL was gated only by the adapter and UI. `applyOperatorOverrides` applied `hitlHold` in every architecture. | `sim-engine.js`, `hitl-controller.js` |
| V14 | A replan to the destination skipped a pickup that had not been visited yet. Tasks could complete without their pickup. | `ConflictManager`, `RobotAgent.recoverFromDeadlock` |
| V15 | System 3 was labelled "Decentralized + ACE", "ACE Decentralized" or "NodeX AI+ACE". | several screens |
| V16 | Dead fake fleet code with hard-coded RACE values sat after `return` in `initFleet`. | `sim-engine.js` |
| V17 | Scenario rack modifiers "+2" replaced the rack count with a string. | `map-geometry.js` |

## 3. Files changed

New:
- `src/core/centralized/HungarianAssignment.js`
- `src/core/centralized/CBSPlanner.js`
- `src/core/centralized/CentralCollisionDetector.js`
- `src/core/decentralized/FixedPairCoordinator.js`
- `src/core/ace/EdgeAiPredictor.js`
- `src/core/ace/AceSessionManager.js`
- `src/core/traffic-recovery.js`
- `src/core/sensor-sim.js`
- `src/core/physics-monitor.js`
- `src/core/experiment-result.js`
- `tests/architecture-compliance.test.js`

Rewritten:
- `src/core/sim-engine.js`
- `src/core/decentralized/RobotAgent.js`
- `src/core/decentralized/DecentralizedFleet.js`
- `src/core/centralized/CentralizedCoordinator.js` (central cycle, CBS, link model, outage)

Modified:
- `map-geometry.js` (world profiles)
- `TaskManager.js` (simulation clock, latency, world fit)
- `AssignmentEngine.js`
- `ConflictManager.js`
- `PeerCommunicationBus.js`
- `race-evaluator.js`
- `scenario-engine.js`
- `sim-lifecycle.js`
- `experiment-runner.js`
- `hitl-controller.js`
- `SystemManager.js`
- `AceAdapter.js`
- `state.js`
- `run-history.js`
- `simulation-history.js`
- `WarehouseMap.js`
- `RobotInspector.js`
- `ScreenOperations.js`
- `ScreenControl.js`
- `ScreenExperiments.js`
- `ScreenCoordination.js`
- `ShellHeader.js`
- `benchmark-runs.js`
- `ace-validation.js`

Tests updated for intended contract changes (each has a comment in the test):
- `phase3` TEST 3: pair handshake.
- `phase4` TEST 2/3: envelope radii.
- `phase5`: System 2 has no RACE state and uses a fixed pair scope.
- `phase5-5`: runtime contracts; Centralized raceState is null.
- `phase7`: events looked up by type.
- `deadlock-backoff`: the pair is set up first.
- `high-density` and `integration-audit`: world sizes, compressed S08 timeline, measured collisions.
- `traffic-control`: the 90 s budget is lifted for completion tests.

## 4. What each system now does

### System 1: Centralized (`CentralizedCoordinator`)

It is the only authority. Each 0.5 s central cycle:
- **Hungarian** batch assignment of open tasks to idle robots (`assignBatch`), with the admission cap.
- **CBS** joint planning of every task holder:
  - high level: vertex conflicts and head-on lane conflicts on single-lane aisles;
  - low level: space-time A* with wait actions;
  - search is bounded to 120 constraint-tree nodes;
  - failed robots and static obstacles are blocked nodes.
- CBS waits become **schedule holds** at nodes (at most 6 s; released if a robot queues for the node).

Every tick:
- **Central collision detector** over the global state: robot-robot within a 1.5 s horizon, rack, boundary, restricted zone, and dynamic objects (halt).
- **ConflictManager** arbitration.
- A **central intersection table** owned by the server.
- **Central traffic recovery**.

Commands go over a modelled robot-server link: latency, loss, and retransmission on the next cycle.
- S06/S07 degrade that link.
- The comm-loss fault gives one robot a 10 s safe stop.
- S14 takes the server offline for 20 s: the whole fleet holds, and no peer messages exist (`decentralizedFleet.agents.size === 0`) [T].

System 1 has no bidding, peer cache, ORCA, Edge AI, RACE, ACE or HITL [T].

### System 2: Decentralized (`RobotAgent`, aceEnabled=false)

- **Allocation:** Contract-Net style. The task board announces; robots bid; the deterministic lowest bid wins; the award is recorded on the task board (the WMS ledger).
- **Admission:** a local estimate from the peer cache replaces the global read.
- **Coordination:** `FixedPairCoordinator`, continuous and fixed at two robots:
  - handshake: `PAIR_REQUEST → ACCEPT | BUSY → INTENT → DECISION → RELEASE`;
  - refresh sessions run even with no conflict [T];
  - a robot can be in at most one pair; a third robot gets `PAIR_BUSY` and waits [T];
  - right of way is decided only inside a pair (the lower ID arbitrates);
  - a conflicting robot that has no pair holds (`PAIR_WAIT`) and requests one. This is the intended bottleneck, measured as `busyRejections` and `pairWaitSeconds`.
- **Collision awareness:** on-board sensors only (`sensor-sim.js` frames). A peer known only by radio is ignored [T].
- **Local motion:** ORCA-style reciprocal speed scaling along the lane (1-D projection).
- **Intersections:** robot-local mutual exclusion from sensors plus peer claims (`mayEnter`).
- **Recovery:** robot-local. The robot sends clearance requests (P2P, with cascade), reroutes around a failed robot it sees, picks its own bay, and repairs its own route.

### System 3: NodeX Edge AI ACE decentralized (`RobotAgent`, aceEnabled=true)

- Same bidding and local motion as System 2, plus the layers below.
- **Edge AI** (`EdgeAiPredictor`) runs on every robot. It uses a constant-velocity track forecast per sensed neighbour and a logistic conflict model with fixed weights. It also estimates uncertainty (prediction residual and stale peers), link risk (message age), queue growth (trend of waiting neighbours) and cascade pressure (shared next waypoints). It is not a trained neural network.
- **Combined sensor + AI** inputs feed **RACE** `w1·C + w2·U + w3·CR + w4·Q + w5·CP` [T].
- **Hysteresis state machine:** LOCAL / NEIGHBORHOOD / CONTAINMENT / SAFE-DEGRADED, with entry above exit thresholds, 3-sample persistence and 4 s dwell (existing tests plus [T]).
- **AceSessionManager: adaptive scope.**
  - LOCAL: no session (1 robot).
  - NEIGHBORHOOD: robots with a sensed or predicted conflict.
  - CONTAINMENT: all robots in the envelope plus queued robots.
  - Group size up to 8 [T: group of 4].
- **Temporary sessions** carry a **space-time contract**: region, slot order, time slots and expiry. The contract is consumed:
  - it decides right of way between members that both use the region;
  - a member that misses its slot forfeits it;
  - robots hold at the region edge until their slot.
- In CONTAINMENT, a robot waiting more than 2 s replans a **route that avoids the contracted region**. The geometry really changes [T].
- A session closes when the region is cleared, the contract expires, or risk returns to LOCAL. The live links and contract then vanish; history stays in `sessionLog` [T].
- **HITL** is honoured only here, as below.

## 5. Map scaling and viewport

`WORLD_PROFILES` (`map-geometry.js`):

| Fleet | Profile | Floor | Lanes × aisles | Intersections | Racks | Task stations |
|---|---|---|---|---|---|---|
| 3 | WORLD-S | 700×360 | 4×3 | 12 | 4 | 12 |
| 10 | WORLD-M | 900×520 | 5×4 | 20 | 8 | 12 |
| 50 | WORLD-L | 1060×650 | 6×5 | 30 | 12 | 16 |
| 100 | WORLD-XL | 1060×1000 | 6×5 + staging lane | 36 | 14 | 16 |

- **Area order:** 252k < 468k < 689k < 1,060k [T].
- **Task stations** are defined per world and all sit on existing intersections [T].
- **Scenario coordinates** outside a smaller world are moved to the nearest intersection (`TaskManager` `fitToWorld`).
- **Planner and physics:** the planner graph, bays, spawn points and collision checks all read the active world [T].
- **Viewport:** `WarehouseMap.fitWorld` fits the complete floor, centred, and refits when the world changes (zoom is always 1).
  - Browser check at 3, 10 and 100 robots: the whole world is visible, including the 100-robot staging floor [B].
  - Robots are drawn at their physical footprint size.
- **Footprint:** robot radius 12, safety margin 4. Motion is blocked by footprint-vs-rack, bounds, robot separation and dynamic objects.
- **Physics monitor:** in every matrix run so far, `PhysicsMonitor` counted 0 overlaps and 0 rack intrusions [P].

## 6. HITL (ACE only)

- **Backend gate:** `hitlController.dispatchCommand` rejects any command unless the running controller is `ace`.
- **Engine:** `applyOperatorOverrides` ignores HITL flags outside ACE.
- **Robot state:** `simEngine.updateRobot` strips HITL fields outside ACE.
- **Mode switch:** `SystemManager` clears HITL state.
- **Non-ACE systems:** all three scopes are rejected and no robot changes [T].
- **ACE:** INDIVIDUAL, ROBOT_GROUP and ENTIRE_FLEET reach the agents' own state (`hitlHold`). Robots stop, resume works, the audit log records each command, and `hitlActions` is counted in the run metrics [T].
- **UI:** the HITL panel shows "Available only in ACE mode" outside ACE [B].

## 7. Runtime isolation

- `SimEngine.initFleet` builds one controller and tears the others down:
  - Centralized: no agents and no bus subscribers.
  - Decentralized or ACE: the central fleet and task queue are empty.
- `activeController` and the published `activeController` state name the running class. Tests assert this for each system [T].
- Benchmarks (`ExperimentRunner.runComparison`) run three separate trials one after another. They never run in parallel.

## 8. Metrics and run linkage

- `getArchitectureMetrics()` returns only the running controller's metrics. They are published every 0.5 s of simulation time.
  - **Centralized:** Hungarian decisions and compute, allocation latency, CBS runs, conflicts resolved, plan time, schedule holds, central detections by type, uplink and downlink.
  - **Decentralized:** CNP awards, bids, allocation latency, pair sessions (refresh and conflict), busy rejections, pair wait, sensor conflict events, local replans, ORCA slowdowns, peer messages.
  - **ACE:** Edge AI inferences and timing, RACE mean and max, envelope distribution, transitions, hysteresis holds, sessions (group sizes, scope changes), contracts, fused detection counts, HITL actions.
- **Common to all systems:**
  - physical collisions, near-collisions and intrusions (`PhysicsMonitor`);
  - task timing in simulation time (created → awarded latency, created → completed).
- **Run record** (`run-history.js` v2) holds:
  - run_id, system, scenario and fleet size;
  - seed, map_profile, world size and config version;
  - controller, start and end timestamps, duration limit and simulation duration;
  - timeline scale;
  - architecture metrics and the experiment result.
  - Archiving refuses metrics whose system does not match the run's system.
- **Comparison:** `comparableRuns(scenario, fleet, seed, map)` reads archived runs only.
- **Verdict** (`experiment-result.js`): PASS only if all tasks completed, 0 collisions, 0 intrusions and 0 boundary violations. "All tasks done with 1 collision" is a FAIL [T]. An operator stop is INCOMPLETE. `simTestResult` is set from this verdict.
- **Time budget:** duration = min(scenario duration, 90 s × sim speed). Scenario fault times and degradation rates are compressed by the same factor (`timeline_scale`). No artificial delays are added.
- **Active tasks:** the KPI comes from the running controller's task registry [T].

## 9. Tests and results

- `npx vitest run`: **16 files, 311/311 passing**.
  - 25 are new architecture-compliance tests, covering isolation, world scaling, Hungarian, CBS, outage, pair size and waiting, sensor-only detection, RACE formula, Edge AI, adaptive group size, session cleanup, ACE replan geometry, HITL gating and scopes, verdict and run linkage.
- `vite build`: OK.
- Browser checks [B]:
  - ACE, 10 robots, S04: sessions and contracts are live, envelopes grow and shrink, the contract region is drawn, and the full world is visible.
  - Decentralized, 100 robots: the whole XL world is visible, HITL is disabled, and the inspector shows the pair scope.
  - No console errors.

### Scenario matrix [P]

Headless probe, same seed per cell, 900 s simulated cap (not the 90 s dashboard budget). Cell = `OK <sim s>` when all tasks completed, else `done/total` at the cap.

### Centralized — 39/56 runs complete, robot overlaps 0, rack intrusions 0

| Scenario | 3 | 10 | 50 | 100 |
|---|---|---|---|---|
| S01 | OK 80.1s | OK 80.1s | OK 390.1s | OK 780.1s |
| S02 | OK 250.1s | OK 390.1s | 13/213 | 24/413 |
| S03 | OK 340.1s | OK 170.1s | OK 170.1s | OK 210.1s |
| S04 | OK 40.1s | OK 60.1s | OK 390.1s | 71/101 |
| S05 | OK 50.1s | OK 50.1s | OK 60.1s | OK 60.1s |
| S06 | OK 70.1s | OK 80.1s | OK 440.1s | 100/101 |
| S07 | OK 80.1s | OK 70.1s | OK 590.1s | 81/101 |
| S08 | 9/14 | 34/42 | 73/202 | 28/402 |
| S09 | OK 60.1s | OK 80.1s | OK 70.1s | OK 60.1s |
| S10 | OK 40.1s | OK 50.1s | OK 380.1s | OK 840.1s |
| S11 | OK 60.1s | OK 90.1s | OK 60.1s | OK 60.1s |
| S12 | OK 40.1s | 10/11 | 49/51 | 100/101 |
| S13 | 8/24 | 43/52 | 37/212 | 6/412 |
| S14 | OK 60.1s | OK 70.1s | OK 430.1s | 80/101 |

### Decentralized — 28/56 runs complete, robot overlaps 0, rack intrusions 0

| Scenario | 3 | 10 | 50 | 100 |
|---|---|---|---|---|
| S01 | OK 60.1s | OK 90.1s | OK 730.1s | 75/100 |
| S02 | OK 230.1s | 50/53 | 77/213 | 58/413 |
| S03 | OK 310.1s | 22/25 | OK 250.1s | OK 250.1s |
| S04 | OK 40.1s | 10/11 | OK 790.1s | 64/101 |
| S05 | OK 60.1s | OK 200.1s | 1/2 | OK 70.1s |
| S06 | OK 50.1s | OK 100.1s | OK 730.1s | 69/101 |
| S07 | OK 400.1s | 8/11 | 3/51 | 2/101 |
| S08 | 13/14 | 20/42 | 25/202 | 5/402 |
| S09 | OK 60.1s | OK 140.1s | OK 80.1s | OK 80.1s |
| S10 | OK 100.1s | OK 90.1s | OK 750.1s | 71/101 |
| S11 | OK 100.1s | OK 110.1s | 1/2 | OK 90.1s |
| S12 | 3/4 | 10/11 | 4/51 | 13/101 |
| S13 | 3/24 | 51/52 | 32/212 | 10/412 |
| S14 | OK 100.1s | OK 80.1s | 37/51 | 72/101 |

### NodeX Edge AI ACE decentralized — 32/56 runs complete, robot overlaps 0, rack intrusions 0

| Scenario | 3 | 10 | 50 | 100 |
|---|---|---|---|---|
| S01 | OK 60.1s | OK 120.1s | OK 590.1s | 77/100 |
| S02 | OK 270.1s | OK 430.1s | 67/213 | 68/413 |
| S03 | OK 250.1s | OK 360.1s | OK 240.1s | OK 250.1s |
| S04 | OK 40.1s | OK 90.1s | 22/51 | 71/101 |
| S05 | OK 60.1s | OK 180.1s | 1/2 | 1/2 |
| S06 | OK 140.1s | OK 340.1s | 50/51 | 45/101 |
| S07 | OK 120.1s | OK 410.1s | 11/51 | 11/101 |
| S08 | 13/14 | 19/42 | 2/202 | 2/402 |
| S09 | OK 60.1s | OK 110.1s | OK 90.1s | OK 90.1s |
| S10 | OK 50.1s | OK 100.1s | OK 540.1s | 81/101 |
| S11 | OK 60.1s | OK 140.1s | OK 80.1s | OK 80.1s |
| S12 | OK 80.1s | 9/11 | 4/51 | 3/101 |
| S13 | 3/24 | 14/52 | 13/212 | 42/412 |
| S14 | OK 50.1s | OK 80.1s | OK 670.1s | 78/101 |


## 10. Acceptance checklist

| Item | Status | Evidence |
|---|---|---|
| Centralized is pure centralized | PASS | §4, outage test [T] |
| Decentralized is truly decentralized | PASS | engine has no shared decisions; robot-local node access and recovery [C][T] |
| ACE is truly decentralized | PASS | same agent base plus on-robot Edge AI and sessions [C][T] |
| No hidden shared controller | PASS | V1/V2 removed; `CentralTrafficRecovery` is owned by System 1 only [C] |
| S1: central allocation, measurable latency | PASS | `allocationLatencyAvgS`, Hungarian [T] |
| S1: CBS genuinely used | PASS | CBS runs and conflicts resolved in metrics; head-on test [T] |
| S1: central collision detection | PASS | `CentralCollisionDetector` counts [P] |
| S1: no peer, Edge AI, ACE, HITL or decentralized fallback | PASS | [T] |
| S2: CNP bidding, no central allocator | PASS | `bidRound` on tasks; local admission estimate [T] |
| S2: continuous coordination | PASS | `refreshPairSessions` > 0 [T] |
| S2: exactly two robots per session, fixed scope | PASS | [T] |
| S2: waiting when a pair is busy | PASS | `busyRejections`, `pairWaitSeconds` [T][P] |
| S2: sensor-only collision detection | PASS | [T] |
| S2: no Edge AI, RACE, ACE or HITL | PASS | [T] |
| S3: exact name | PASS | `SYSTEM_NAMES.ace` [T] |
| S3: Edge AI on real state; RACE formula; hysteresis; 4 states | PASS | [T] |
| S3: adaptive scope, N-robot sessions | PASS | group of 4 [T]; average 2.6, maximum 4 in S03 [P] |
| S3: real sessions and contracts; links only while live | PASS | [T] |
| S3: combined sensor + AI detection | PASS | `fusedEvents` / `aiPredictedOnly` [P] |
| S3: path really changes after replan | PASS | [T] |
| HITL only in ACE, end-to-end for 3 scopes | PASS | [T][B] |
| World 3 < 10 < 50 < 100; full map visible; camera auto-fit | PASS | [T][B] |
| Robots never pass through racks or walls; footprint respected | PASS | 0 intrusions in all probe runs [P] |
| No 500-robot mode | PASS | grep of src, tests, docs and dist |
| One architecture per simulation; metrics isolated per run | PASS | [T] |
| Separate runs comparable later | PASS | `comparableRuns`, Screen 3 cells from archived runs |
| Active tasks from real state; verdict from criteria | PASS | [T] |
| Every selected scenario completes within the 90 s budget | **FAIL** | see §11 |

## 11. Remaining limitations

1. **Time budget and large fleets.** Runs are capped at 90 s of wall time. At 1× speed a 50- or 100-robot run cannot finish all its scenario tasks, because of the task count and the 6-task admission cap. The verdict is then an honest FAIL (DURATION_LIMIT). The small fleets finish S01/S04/S05/S09/S11 in about 40–120 s of simulation time; some exceed 90 s at 1× speed. The fix is a product decision: fewer tasks per scenario, a higher sim speed, or a larger budget.
2. **Traffic gridlocks at 50/100 robots** in stress scenarios (S02 burst, S08 failures, S13 combined) remain (see matrix). These are heuristic traffic limits, not architecture wiring.
3. **Edge AI** is a deterministic on-robot predictive estimator, not a trained model. No training data exists in the repository.
4. **ORCA** is implemented as 1-D reciprocal speed adaptation along the lane (robots move on a lane graph), not as 2-D velocity-obstacle half-planes.
5. **CBS is bounded** to 120 constraint-tree nodes. Truncated runs are counted (`boundedRuns`), and residual conflicts go to the central ConflictManager at run time. Continuous execution drift from the discrete plan is absorbed by schedule holds and arbitration.
6. **Robot fiducial IDs.** Robots are assumed to identify neighbours by fiducial tags in the sensor frame, and sim clocks are assumed synchronized (used by node claims).
7. **Shared utilities.** Some architecture-neutral utilities remain shared: the task board (tasks and completion ledger), back-off maneuver geometry (`deadlock-backoff.js`) and the graph A* class (each agent has its own instance).
8. **Development data.** Screen 3 fixture charts remain behind `devFixturesEnabled` (off by default). `backend/server.py` is unused.

## 12. Assumptions recorded

- S14 outage length is 20 s. A per-robot comm-loss blackout under Centralized is 10 s. A dynamic obstacle stays 25 s.
- Humans walk service walkways beside the outer cross lanes and give way at aisle crossings.
- Pair session lengths: refresh 0.4 s, conflict 1.2 s (at most 6 s). The same neighbour is refreshed at most every 1.5 s.
- ACE slot length is 2 s. The maximum session group is 8 robots.
- Envelope radii: LOCAL 18 px, NEIGHBORHOOD 40 px, CONTAINMENT 60 px, SAFE-DEGRADED 24 px. The System 2 pair scope is 22 px.
