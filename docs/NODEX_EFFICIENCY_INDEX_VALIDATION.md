# NodeX Efficiency Index — Validation of NEEI v1.1 and the corrected NFEI v2.0

Audit date: 2026-09-28. Scope: every efficiency / KPI value shown on the Analytics & Efficiency screen of the NodeX ACE-AMR dashboard, the legacy NodeX Experimental Efficiency Index (NEEI v1.1, `src/data/neei.js`), and the 192 recorded runs in `backend/shared_state.json` (key `runs`, recorded 2026-09-27 14:59 → 2026-09-28 19:14).

Every number in this document was computed from the recorded runs by the code that ships with the dashboard (`src/data/neei.js`, `src/data/nfei.js`), or by the Python/Node analysis scripts described in §10. No value was estimated or filled in by hand.

> **Terminology.** ISO 22400 defines manufacturing-operations KPIs (for example throughput rate). It does **not** define a composite efficiency formula for AMR fleets. Both NEEI and NFEI are **project-specific composites** built from recognized KPIs. Neither is an ISO or IEEE metric, and this document never calls either one "standard".

---

## 0. Answer: is the original NodeX Efficiency Index mathematically genuine and defensible?

**It is genuine but not defensible.**

- **What is genuine.** NEEI v1.1 is a deterministic simple-additive-weighting composite. Its weights sum to 1. It computes exactly what its header says, it reads only measured values, and it never invents data. Version 1.1 had already removed v1.0's constant 40-point "safety" bonus.
- **Why it is not defensible as an efficiency measure** (evidence in §3):
  1. **Double counting.** When all tasks complete, *time efficiency* and *throughput efficiency* are the same number (r = 1.000 over 37 paired rows). Makespan therefore carries 0.50 / 0.85 = 59 % of the score. In truncated runs, *task success* and *throughput* are also the same signal (r = 0.92).
  2. **Floating reference.** The reference is the best of the latest runs, so a run's score changes when another system's run is added or replaced. Two centralized replicates that differ by 13 % both score 100. Two ACE replicates swing by 10.6 points depending only on which one is newer.
  3. **Renormalization inflation.** A run with fewer applicable components can outscore a better run. One incomplete run scores 98.8 against 97.2 for a complete run. Single-run cells score 100 on task success alone.
  4. **Perverse recovery bonus.** The recovery component exists only when a failure caused a reallocation. That failure then adds points (+13.2 on S13/3 ACE).
  5. **Narrow safety gate.** The gate ignores obstacle intrusions, boundary violations and near-collisions. Its 0 value is then arithmetically averaged, so efficiency elsewhere compensates a collision.
  6. **Mislabelled test scores.** On ACE-only tests, NEEI equals task completion % in 69 of 77 runs but is labelled "efficiency".

NEEI v1.1 stays in the code as the legacy index, so historical values remain reproducible. The dashboard now shows NFEI v2.0 first and NEEI v1.1 beside it.

---

## 1. Data lineage — every efficiency / KPI shown on the dashboard

Line numbers refer to the files as they stand after this change. `src/core` was read only and not modified.

| Metric (dashboard label) | Source (file:line) | Formula | Units | Sampling | Aggregation | System / Scenario / Fleet handling |
|---|---|---|---|---|---|---|
| Tasks total | `src/data/run-history.js:172` (tasks passed by `src/core/sim-lifecycle.js:64,90`) | `tasks.length` at end of run, including tasks added by a task surge | tasks | end-of-run snapshot | per run | Same task registry for all 3 systems. Task list is generated per scenario and fleet size, so it differs by fleet (2 … 413 tasks). |
| Tasks completed / Task completion % | `run-history.js:99,173-174` | count of `status === "COMPLETED"`; % = done/total, rounded to 0.1 | tasks, % | end snapshot | per run; overall = mean over paired rows (`analytics-selection.js:249-277`) | identical definition for all systems |
| Completion time (makespan) | `run-history.js:131-133,175`; set by `src/core/sim-engine.js:456-460` (first tick with no open task); passed by `sim-lifecycle.js:87` | sim time when the last task completed; **null unless endReason = ALL_TASKS_COMPLETE** | s (sim) | tick resolution (dt × sim speed) | per run | excludes the return-to-bay grace (≤ 30 s, `sim-engine.js:101`) |
| Sim time | `run-history.js:171`; `sim-lifecycle.js:86` | total simulated time, including the return grace | s | end snapshot | per run | duration limit = min(scenario duration, 90 s wall × sim speed) (`sim-lifecycle.js:20-26`). The data contains limits of 90, 300 and 450 s. |
| Throughput (archived) | `run-history.js:176` | `round(done × 3600 / workTime)`, where workTime = makespan if all tasks completed, else sim time | tasks/h (integer) | end snapshot | per run; overall mean | same for all systems. **Differs from the live KPI** below. |
| Throughput (live KPI, run summary) | `src/core/sim-engine.js:539-543` → `run-history.js:195` | `done / (simTime/3600)` over the **whole** sim time | tasks/h | per tick | — | Two throughput definitions sit in the same record. For example, S11/100 ACE has summary 64 tasks/h but performance 87 tasks/h. |
| Avg task time (cycle time) | `src/core/centralized/TaskManager.js:251,259` | mean(`completedSim − createdSim`) over **completed tasks only** | s | per task | per run | right-censored in truncated runs (unfinished tasks are ignored) |
| Avg allocation latency | `TaskManager.js:119-120,256` | mean(`assignedSim − (releasedSim ?? createdSim)`) over **awarded tasks only** | s | per award | per run | censored: tasks never awarded (`pending`) are ignored (`TaskManager.js:260`) |
| Waiting | `src/core/decentralized/RobotAgent.js:447` → `DecentralizedFleet.js:323` (`architectureMetrics.waitingSeconds`) | Σ robot-seconds in state WAITING | robot-s | per tick | per run | **Decentralized and ACE only.** Not recorded for Centralized (`run-history.js:194` → "Not measured"). One negative value is recorded (−0.7 s, RUN-MULWREJB-9). |
| Coordination messages | Centralized: `src/core/centralized/CentralizedCoordinator.js:271` (+1 uplink per robot per tick), `:748` (downlink per command). Decentralized/ACE: `src/core/decentralized/PeerCommunicationBus.js:95` (+1 per send; a broadcast counts once) → `DecentralizedFleet.js:314` | Centralized: uplink + downlink. Decentralized/ACE: peerMessages (`analytics-selection.js:212-216`) | msgs | per send | per run | Both count transmissions, not deliveries. Semantics differ: periodic telemetry vs peer messages. |
| Messages per completed task (new) | `src/data/nfei.js` `nfeiInputs` → `analytics-selection.js:195-198` | messages / tasks completed | msgs/task | end snapshot | per run | as above |
| Collisions / near-collisions / obstacle intrusions / boundary violations | `src/core/physics-monitor.js:22-25,47-58` (new contacts per pair / per robot, edge-counted) → `architectureMetrics.physics`; copied to `summary` in `run-history.js:187-189` | event counts | events | per tick | per run | `boundaryViolations` is **not** copied into `summary`. NEEI never read it. |
| Robot failures | `run-history.js:100,186` | robots in ERROR/failed at end | robots | end snapshot | per run | — |
| Re-allocated tasks recovered % | `run-history.js:179-180`; `analytics-selection.js:204-207` | completed / reassigned (tasks with `reassignCount > 0`) | % | end snapshot | per run | exists only if a reallocation happened |
| **NEEI v1.1** (legacy) | `src/data/neei.js:101-133` (reference `:85-94`) | see §2 | 0-100 | per run | overall = arithmetic mean over rows every system recorded, with a partial fallback (`analytics-selection.js:143-156`) | Reference = latest run of every eligible system for the same code + fleet (`analytics-selection.js:48-58,66-75`). Seed, map, duration limit and config are not checked. |
| **NFEI v2.0** (corrected) | `src/data/nfei.js` (`computeNfeiGroup`, `nfeiForRun`); wired in `analytics-selection.js:66-75,165-183` | see §5 | index, 100 = Centralized reference | per run | overall = **geometric** mean over rows with a valid NFEI for all 3 systems (`overallNfei`) | Reference = Centralized run(s) with the identical pairing key (kind, scenario, fleet, seed, map, duration limit, config) |
| Fleet-scale chart | `analytics-selection.js:249-277` | overall value per fleet size | as metric | — | paired rows per fleet (a different row set per fleet size) | — |
| ACE validation status | `analytics-selection.js:280-292`; criteria from `src/data/ace-validation.js` and `src/core/ace-test-monitor.js` | latest run verdict PASS/FAIL | — | — | — | ACE only; not an efficiency metric |
| Benchmark report JSON | `src/data/benchmark-runs.js:64-101` (from `experimentRunner.getHistory()`, a separate pipeline) and `:121-146` (NEEI + NFEI from recorded runs) | — | — | — | — | the `RAW_METRICS_SCENARIOS` placeholders are "Awaiting run" strings, not numbers |

**Selection rule used by every panel** (`analytics-selection.js:48-58`): runs are newest first, and the panel takes the first run per system with the same scenario code, fleet size and run kind. That includes operator-stopped runs.

---

## 2. NEEI v1.1 as implemented

```
NEEI = 100 × Gate × Σ w_i c_i / Σ w_i        over applicable components
Gate = 1 if collisions = 0 else 0             (robot-robot collisions only)
c_success    = done / total                     w 0.35   always
c_time       = min(1, T_ref / T)                w 0.25   only if all tasks done and reference set > 1 run
c_throughput = min(1, X / X_ref)                w 0.25   only if reference set > 1 run
c_recovery   = reallocCompleted / realloc       w 0.15   only if a task was reallocated
T_ref = min makespan in the reference set;  X_ref = max throughput in the reference set
```

---

## 3. Validation of NEEI v1.1 (numbers from the 192 recorded runs)

### 3.1 Normalization, units, direction
- The weights sum to 1. Every component is dimensionless and clamped to [0, 1]. Higher is better for every component. **Correct.**
- Clamping at 1 plus a best-of-set reference means the best run of any set scores 1 on time and throughput, however poor it is in absolute terms. On S13 with 100 robots, every system completed ≤ 9 % of tasks, yet the best system still receives throughput efficiency 1.0.
- Throughput is rounded to an integer before the ratio (maximum error 0.68 tasks/h). This is negligible.

### 3.2 Double counting — time efficiency vs throughput (verified numerically)
When all tasks complete, X = N·3600/T. N is identical for every system of a cell (same deterministic task list), so X/X_ref = (N/T)/(N/T_ref) = T_ref/T.

- In every recorded row where both components apply, they agree to within 0.005 (the rounding of X). Examples:

  | Row | Time efficiency | Throughput efficiency |
  |---|---|---|
  | S04/10 Decentralized | 0.403 | 0.403 |
  | S06/10 ACE | 0.317 | 0.317 |
  | S01/10 ACE | 0.575 | 0.574 |

- Across the 37 paired rows where both runs completed all tasks, the correlation of log throughput ratio with log makespan ratio is **r = 1.000**.
- Effect: makespan carries weight 0.50/0.85 = **58.8 %** of a complete run's NEEI.
- In truncated runs (same duration limit), X ∝ tasks done, so *task success* and *throughput* carry the same signal: **r = 0.924** (n = 30). NEEI double counts in both regimes.

### 3.3 Reference-set dependence and latest-run bias
- **The reference moves with the other runs.** It is the best of whichever runs are currently "latest". Adding a faster run of any system lowers every other system's score without their data changing. NFEI v2 removes this: its unit test "score does not depend on non-reference runs" passes.
- **Replicates.** The two S01/3 centralized replicates (makespan 62.9 s and 55.8 s) both score **100.0**, because whichever is latest becomes the reference. The two S14/3 ACE replicates score **75.6** (latest, 62.1 s) or **86.2** (older, 47.6 s). That 10.6-point swing comes only from which replicate is newer, and it is as large as the Decentralized-vs-ACE gap in that row (86.3 vs 75.6).
- **Latest-run selection bias.** The latest-run rule picks operator-stopped runs:
  - S02/3 ACE: operator stop at 203 s, NEEI 45.0. An older operator stop at 5.9 s has NEEI **0.0**.
  - S06/3 ACE: completed 4/4 tasks but was operator-stopped, NEEI 73.3.
  - S07/3 Decentralized: operator stop, NEEI 50.4.

  The observation window of these runs was chosen by a person, not by the protocol.

### 3.4 Renormalization when components are N/A — can fewer components score higher? **Yes.**
- **Single-run cells.** Only task success applies, so the score is just completion %:
  - S10/3 ACE = 100.0
  - S11/100 ACE = 100.0
  - S14/50 ACE = 82.4
  
  These look identical to fully compared efficiencies on the screen.
- **Incomplete beats complete.** S01/50 Centralized completed 49/50 tasks (no makespan, so no time component) and scores **98.8**: (0.35·0.98 + 0.25·1)/0.60. A run that completes all tasks 5 % slower than the best scores (0.35 + 0.25·0.952·2)/0.85 = **97.2**. The incomplete run ranks higher because the time component it failed to earn is dropped rather than scored.
- **ACE validation tests.** There is no comparative reference, so NEEI = completion % in **69 of 77** test runs. The other 8 are completion % plus a recovery bonus. The screen labels this "efficiency".

### 3.5 Recovery component — presence-dependent bonus
Recovery exists only when a failure or lease expiry forced a reallocation. It is usually 1.0, so it raises the weighted mean.

| Run | NEEI with recovery | NEEI if recovery were not scored | Effect of the failure |
|---|---|---|---|
| S13/3 ACE | 47.1 | 33.9 | **+13.2 points** |
| S07/3 ACE | 71.9 | 67.0 | +4.9 points |

A robot failure can therefore *raise* measured efficiency.

### 3.6 Fleet size, scenario length and task-count bias
- Nothing is normalized per robot or per task, and task counts range from 2 tasks (S05, S11) to 413 tasks (S02/100) under the same 450 s limit.
- At 100 robots every system completes ≤ 10 % of the S02/S13 workload. There, task success mostly measures the protocol's duration limit, not the architecture.
- The overall index is an arithmetic mean of these heterogeneous rows. At 3 robots the NEEI overall uses 11 rows, including 3 rows with operator-stopped runs. At 10 and 50 robots it uses 7 rows.
- The fleet-scale chart therefore compares means over different row sets at each fleet size.

### 3.7 Safety gate adequacy
- The gate reads only robot-robot `collisions`. It ignores:
  - `obstacleIntrusions` (recorded)
  - `boundaryViolations` (recorded only in `architectureMetrics.physics`; `run-history.js` does not copy it into `summary`)
  - `nearCollisions` (reported nowhere in the index)
- The gated value 0 enters an **arithmetic mean** in the overall row. For example, rows of 100, 100 and 0 average to 66.7 %, so efficiency in other rows compensates a collision.
- In the 192 recorded runs, collisions, obstacle intrusions and boundary violations are **all zero**. Near-collisions total **16**. The gate has never been exercised by real data.

### 3.8 Filter behaviour
- **Scenario filter.** Uses the latest run with the same code, fleet and run kind. **Correct.** It does not check seed, map, duration limit or configVersion. The duration limit varies in the data (90 s in 5 runs, 300 s in 24 runs, 450 s in 163 runs).
- **ACE test filter.** Keeps NodeX ACE only, and Centralized/Decentralized are "—" (null), never computed and never 0 (`analytics-selection.js:30,48-58`). **Correct**, and covered by the existing phase-10 tests.

### 3.9 Is higher always better?
Yes for each NEEI component. But because of §3.3 and §3.4, a higher NEEI does not imply a more efficient run.

---

## 4. Historical data analysis (192 runs)

### 4.1 Composition and data gaps

| Dimension | Values |
|---|---|
| Systems | ACE 119, Centralized 38, Decentralized 35 |
| Run kind | 115 scenario runs, 77 ACE-test runs |
| End reason | ALL_TASKS_COMPLETE 96, DURATION_LIMIT 80, OPERATOR_STOP 16 |
| Seed | **18427 in all 192 runs** (no seed variety) |
| configVersion | **"NODEX-ARCH-2026.09-r3" in all 192 runs**, although the runs span 28 h of active development |
| Duration limit | 450 s (163), 300 s (24), 90 s (5) |

- **Replicates with an identical key diverge.** Examples:
  - S14/3 ACE makespan: 62.1 s vs 47.6 s
  - A12/3 ACE makespan: 100.1 s vs 171.1 s
  - S13/3 ACE tasks completed: 8 vs 11
  - A02/100 ACE tasks completed: 45 … 51

  Either the simulation is not seed-deterministic, or its behaviour changed without a configVersion bump. Either way **each cell holds n = 1 comparable run, so no variance or confidence interval can be estimated.** Every per-cell difference below is a single observation.
- **Missing cells:**
  - S09: no run
  - S08: Centralized only (3 robots)
  - S10: ACE only
  - S11/100: ACE only
  - S12 and S13: no 10- or 50-robot runs
  - S14/10: no run
  - S14/50: ACE only
- **Waiting.** Unmeasured for Centralized. One negative value is recorded (S05/50 Decentralized, −0.7 robot-s: a data-quality defect in the recorder).

### 4.2 Raw KPIs per scenario × fleet × system (runs the dashboard displays = latest per system)

Legend:
- **End:** ALL = all tasks completed; LIMIT = duration limit reached; STOP = operator stop.
- **X:** tasks × 3600 / (makespan, or sim time if the run was incomplete).
- **Wait:** Σ robot-seconds in WAITING (— = not measured).

| Scen | Fleet | System | End | Done/Total | Makespan s | Sim s | X tasks/h | Cycle s | Alloc lat s | Unalloc | Wait robot-s | Msgs/task | Near-coll | NEEI v1.1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S01 | 3 | centralized | ALL | 6/6 | 62.9 | 74.6 | 343 | 37.5 | 13.7 | 0 | — | 378 | 0 | 100.0 |
| S01 | 3 | decentralized | ALL | 6/6 | 98.1 | 113 | 220 | 57.6 | 18.3 | 0 | 14.8 | 244 | 0 | 78.9 |
| S01 | 3 | ace | ALL | 6/6 | 86.5 | 97.7 | 250 | 50.9 | 16.2 | 0 | 6.6 | 292 | 0 | 84.0 |
| S01 | 10 | centralized | ALL | 10/10 | 100.9 | 104.3 | 357 | 57.1 | 0.1 | 0 | — | 1049 | 0 | 100.0 |
| S01 | 10 | decentralized | ALL | 10/10 | 144 | 147.6 | 250 | 101.5 | 0.7 | 0 | 308.4 | 955 | 0 | 82.4 |
| S01 | 10 | ace | ALL | 10/10 | 175.5 | 180.3 | 205 | 97.9 | 0.3 | 0 | 199.9 | 818 | 0 | 75.0 |
| S01 | 50 | centralized | LIMIT | 49/50 | — | 450.5 | 392 | 203.8 | 161.2 | 0 | — | 2421 | 0 | 98.8 |
| S01 | 50 | decentralized | LIMIT | 38/50 | — | 450 | 304 | 218.1 | 188.8 | 6 | 233.9 | 2749 | 0 | 76.6 |
| S01 | 50 | ace | LIMIT | 40/50 | — | 451 | 319 | 228.4 | 199.0 | 4 | 268.5 | 2688 | 1 | 80.6 |
| S01 | 100 | centralized | LIMIT | 53/100 | — | 450.3 | 424 | 213.9 | 192.7 | 41 | — | 2277 | 0 | 72.6 |
| S01 | 100 | decentralized | LIMIT | 40/100 | — | 450.7 | 320 | 240.6 | 209.6 | 54 | 256.6 | 10126 | 0 | 54.8 |
| S01 | 100 | ace | LIMIT | 43/100 | — | 450.4 | 344 | 248.7 | 218.7 | 51 | 168.8 | 9054 | 0 | 58.9 |
| S02 | 3 | centralized | ALL | 24/24 | 286.9 | 290.4 | 301 | 165.6 | 131.5 | 0 | — | 84 | 0 | 90.9 |
| S02 | 3 | decentralized | ALL | 24/24 | 242.4 | 246.5 | 356 | 139.3 | 110.5 | 0 | 26 | 156 | 0 | 100.0 |
| S02 | 3 | ace | STOP | 10/24 | — | 203 | 177 | 79.4 | 61.2 | 11 | 58.6 | 512 | 0 | 45.0 |
| S02 | 10 | centralized | ALL | 53/53 | 401 | 408.2 | 476 | 208.8 | 142.1 | 0 | — | 213 | 0 | 93.2 |
| S02 | 10 | decentralized | ALL | 53/53 | 354.4 | 359.2 | 538 | 205.4 | 143.3 | 0 | 566.5 | 394 | 0 | 100.0 |
| S02 | 10 | ace | LIMIT | 29/53 | — | 450.7 | 232 | 142.9 | 106.1 | 14 | 1559.9 | 1511 | 0 | 49.9 |
| S02 | 50 | centralized | LIMIT | 52/213 | — | 450.1 | 416 | 230.7 | 207 | 155 | — | 1332 | 0 | 55.9 |
| S02 | 50 | decentralized | LIMIT | 45/213 | — | 450.8 | 359 | 225.3 | 198.6 | 162 | 368.6 | 10185 | 0 | 48.3 |
| S02 | 50 | ace | LIMIT | 32/213 | — | 450.9 | 255 | 190.8 | 161.0 | 175 | 518.9 | 10488 | 0 | 34.3 |
| S02 | 100 | centralized | LIMIT | 41/413 | — | 450 | 328 | 220.9 | 193.3 | 366 | — | 2511 | 0 | 47.5 |
| S02 | 100 | decentralized | LIMIT | 35/413 | — | 451 | 279 | 242.0 | 206.8 | 372 | 576.1 | 40923 | 0 | 40.4 |
| S02 | 100 | ace | LIMIT | 36/413 | — | 451 | 287 | 246.0 | 211.2 | 371 | 406.3 | 39526 | 0 | 41.5 |
| S03 | 3 | centralized | ALL | 25/25 | 313.2 | 340.2 | 287 | 168.9 | 132.5 | 0 | — | 191 | 0 | 93.4 |
| S03 | 3 | decentralized | ALL | 25/25 | 379.5 | 386.5 | 237 | 159.2 | 117.8 | 0 | 52.4 | 343 | 0 | 84.3 |
| S03 | 3 | ace | ALL | 25/25 | 278.3 | 285.4 | 323 | 140.5 | 109.4 | 0 | 30.5 | 206 | 0 | 100.0 |
| S03 | 10 | centralized | ALL | 25/25 | 207.9 | 214.4 | 433 | 117.3 | 50.0 | 0 | — | 492 | 0 | 100.0 |
| S03 | 10 | decentralized | ALL | 25/25 | 217.5 | 225.8 | 414 | 155.2 | 76.4 | 0 | 405.2 | 735 | 0 | 97.4 |
| S03 | 10 | ace | ALL | 25/25 | 218.7 | 228.1 | 412 | 132.2 | 62.0 | 0 | 199 | 418 | 0 | 97.1 |
| S03 | 50 | centralized | ALL | 25/25 | 271.9 | 283.6 | 331 | 105.0 | 54.6 | 0 | — | 1470 | 0 | 92.1 |
| S03 | 50 | decentralized | ALL | 25/25 | 235.6 | 252.5 | 382 | 122.4 | 72.3 | 0 | 101.5 | 2097 | 0 | 100.0 |
| S03 | 50 | ace | ALL | 25/25 | 248.9 | 279.2 | 362 | 113.6 | 64.7 | 0 | 55.8 | 1718 | 0 | 96.9 |
| S03 | 100 | centralized | ALL | 25/25 | 243.3 | 264.2 | 370 | 109.7 | 61.7 | 0 | — | 2784 | 0 | 96.9 |
| S03 | 100 | decentralized | ALL | 25/25 | 230.4 | 251.4 | 391 | 126.5 | 76.8 | 0 | 63.3 | 3510 | 0 | 100.0 |
| S03 | 100 | ace | ALL | 25/25 | 268.5 | 290.2 | 335 | 136.8 | 80.6 | 0 | 63.6 | 3461 | 0 | 91.6 |
| S04 | 3 | centralized | ALL | 4/4 | 49.6 | 60 | 290 | 33.9 | 5.9 | 0 | — | 202 | 0 | 93.0 |
| S04 | 3 | decentralized | ALL | 4/4 | 43.7 | 51.6 | 330 | 32.1 | 5.7 | 0 | 2.2 | 258 | 0 | 100.0 |
| S04 | 3 | ace | ALL | 4/4 | 47 | 55.6 | 306 | 33.7 | 6.4 | 0 | 1.7 | 173 | 0 | 95.8 |
| S04 | 10 | centralized | ALL | 11/11 | 83 | 90.8 | 477 | 49.5 | 2.6 | 0 | — | 192 | 0 | 100.0 |
| S04 | 10 | decentralized | ALL | 11/11 | 206.1 | 213.9 | 192 | 110.3 | 3.5 | 0 | 449.8 | 1264 | 0 | 64.9 |
| S04 | 10 | ace | ALL | 11/11 | 99 | 104 | 400 | 72.7 | 4.3 | 0 | 74.5 | 421 | 0 | 90.5 |
| S04 | 50 | centralized | LIMIT | 33/51 | — | 300.1 | 396 | 160.1 | 136 | 12 | — | 978 | 0 | 79.4 |
| S04 | 50 | decentralized | LIMIT | 27/51 | — | 300.5 | 323 | 163.1 | 133.9 | 18 | 142.3 | 2793 | 0 | 64.9 |
| S04 | 50 | ace | LIMIT | 28/51 | — | 300.8 | 335 | 169.7 | 139.9 | 17 | 114.5 | 3227 | 1 | 67.3 |
| S04 | 100 | centralized | LIMIT | 30/101 | — | 301.3 | 358 | 153.3 | 128.3 | 65 | — | 2362 | 0 | 59.0 |
| S04 | 100 | decentralized | LIMIT | 22/101 | — | 300.1 | 264 | 171.7 | 135.4 | 73 | 173.9 | 11598 | 0 | 43.4 |
| S04 | 100 | ace | LIMIT | 23/101 | — | 300.7 | 275 | 159.5 | 126.8 | 72 | 164 | 11686 | 0 | 45.3 |
| S05 | 3 | centralized | ALL | 2/2 | 64.7 | 68.1 | 111 | 48.3 | 0.1 | 0 | — | 1077 | 0 | 100.0 |
| S05 | 3 | decentralized | ALL | 2/2 | 76.6 | 80.1 | 94 | 70.5 | 0 | 0 | 12.3 | 680 | 0 | 90.9 |
| S05 | 3 | ace | ALL | 2/2 | 69.9 | 72.8 | 103 | 58.1 | 0 | 0 | 4.8 | 660 | 0 | 95.7 |
| S05 | 10 | centralized | ALL | 2/2 | 86.2 | 88.6 | 84 | 80.2 | 0.1 | 0 | — | 3910 | 0 | 100.0 |
| S05 | 10 | decentralized | ALL | 2/2 | 87.9 | 90.9 | 82 | 81.5 | 0 | 0 | 6.1 | 1702 | 0 | 98.7 |
| S05 | 10 | ace | ALL | 2/2 | 121.3 | 124.7 | 59 | 114.6 | 0 | 0 | 33.2 | 2476 | 0 | 82.7 |
| S05 | 50 | centralized | ALL | 2/2 | 63 | 74 | 114 | 59.9 | 0.1 | 0 | — | 12184 | 0 | 86.9 |
| S05 | 50 | decentralized | ALL | 2/2 | 49 | 66.5 | 147 | 46.1 | 0 | 0 | -0.7 | 4948 | 0 | 100.0 |
| S05 | 50 | ace | ALL | 2/2 | 54 | 70.8 | 133 | 48.8 | 0 | 0 | 0 | 5390 | 0 | 94.5 |
| S05 | 100 | centralized | ALL | 2/2 | 65.3 | 73.8 | 110 | 57.4 | 0.3 | 0 | — | 18408 | 0 | 100.0 |
| S05 | 100 | decentralized | ALL | 2/2 | 75.5 | 86.9 | 95 | 59.6 | 0 | 0 | 3.6 | 11516 | 0 | 92.0 |
| S05 | 100 | ace | ALL | 2/2 | 69.5 | 81.2 | 104 | 57.6 | 0 | 0 | 0.6 | 10388 | 0 | 96.6 |
| S06 | 3 | centralized | ALL | 4/4 | 46.3 | 48.9 | 311 | 32.9 | 4.4 | 0 | — | 363 | 0 | 100.0 |
| S06 | 3 | decentralized | ALL | 4/4 | 57.7 | 63.4 | 250 | 39.1 | 5.2 | 0 | 4.4 | 204 | 0 | 88.3 |
| S06 | 3 | ace | STOP | 4/4 | — | 128.6 | 112 | 58.7 | 4.0 | 0 | 12.7 | 535 | 0 | 73.3 |
| S06 | 10 | centralized | ALL | 11/11 | 84.8 | 91.6 | 467 | 50.3 | 2.5 | 0 | — | 694 | 0 | 100.0 |
| S06 | 10 | decentralized | ALL | 11/11 | 204.8 | 211.4 | 193 | 115.3 | 2.9 | 0 | 560.4 | 1090 | 0 | 65.5 |
| S06 | 10 | ace | ALL | 11/11 | 267.4 | 278.6 | 148 | 97.6 | 3.9 | 0 | 127.3 | 1685 | 0 | 59.8 |
| S06 | 50 | centralized | ALL | 51/51 | 442 | 463 | 415 | 216.4 | 170.7 | 0 | — | 2774 | 0 | 100.0 |
| S06 | 50 | decentralized | LIMIT | 35/51 | — | 450.1 | 280 | 227.9 | 198.9 | 9 | 363.5 | 2856 | 0 | 68.1 |
| S06 | 50 | ace | LIMIT | 39/51 | — | 450.7 | 312 | 220.9 | 187.7 | 6 | 185.4 | 3069 | 1 | 75.9 |
| S06 | 100 | centralized | LIMIT | 41/101 | — | 450.4 | 328 | 221.2 | 193.5 | 54 | — | 2699 | 0 | 61.7 |
| S06 | 100 | decentralized | LIMIT | 45/101 | — | 451 | 359 | 241.1 | 213.8 | 49 | 238.2 | 7628 | 1 | 67.7 |
| S06 | 100 | ace | LIMIT | 36/101 | — | 451.2 | 287 | 237.0 | 206.9 | 58 | 165.3 | 9110 | 0 | 54.1 |
| S07 | 3 | centralized | ALL | 4/4 | 66.3 | 69.2 | 217 | 41.1 | 6.3 | 0 | — | 586 | 0 | 100.0 |
| S07 | 3 | decentralized | STOP | 3/4 | — | 308.1 | 35 | 25.9 | 1.5 | 1 | 699 | 1813 | 0 | 50.4 |
| S07 | 3 | ace | ALL | 4/4 | 151.1 | 181.6 | 95 | 71.9 | 7.9 | 0 | 52 | 861 | 0 | 71.9 |
| S07 | 10 | centralized | ALL | 11/11 | 148.9 | 152.8 | 266 | 85.2 | 4.8 | 0 | — | 1376 | 0 | 100.0 |
| S07 | 10 | decentralized | LIMIT | 5/11 | — | 450.1 | 40 | 164.7 | 99.5 | 6 | 3742.8 | 5916 | 0 | 35.1 |
| S07 | 10 | ace | ALL | 11/11 | 222.3 | 252.9 | 178 | 145.9 | 25.8 | 0 | 388.2 | 1565 | 0 | 83.5 |
| S07 | 50 | centralized | LIMIT | 40/51 | — | 450.1 | 320 | 237.7 | 207.2 | 5 | — | 2097 | 0 | 87.4 |
| S07 | 50 | decentralized | LIMIT | 5/51 | — | 450.1 | 40 | 197.5 | 39.8 | 46 | 11193.4 | 99627 | 2 | 13.3 |
| S07 | 50 | ace | LIMIT | 18/51 | — | 450.3 | 144 | 254.8 | 62.6 | 33 | 2459 | 27720 | 1 | 47.1 |
| S07 | 100 | centralized | LIMIT | 37/101 | — | 450.2 | 296 | 228.2 | 196.9 | 58 | — | 3165 | 0 | 63.0 |
| S07 | 100 | decentralized | LIMIT | 10/101 | — | 450.5 | 80 | 145.5 | 52.6 | 91 | 11140.5 | 291318 | 0 | 21.0 |
| S07 | 100 | ace | LIMIT | 27/101 | — | 450.2 | 216 | 241.9 | 59.8 | 73 | 1983.6 | 105338 | 0 | 53.2 |
| S08 | 3 | centralized | ALL | 14/14 | 209.6 | 215.5 | 240 | 108.4 | 66.0 | 0 | — | 104 | 0 | 100.0 |
| S10 | 3 | ace | ALL | 4/4 | 47.7 | 54.4 | 302 | 30.6 | 4.0 | 0 | 1.3 | 286 | 0 | 100.0 |
| S11 | 3 | centralized | ALL | 2/2 | 49.7 | 52.7 | 145 | 45.8 | 0.1 | 0 | — | 722 | 0 | 98.4 |
| S11 | 3 | decentralized | ALL | 2/2 | 48.3 | 62.9 | 149 | 33.2 | 0 | 0 | 0 | 510 | 0 | 100.0 |
| S11 | 3 | ace | ALL | 2/2 | 48.3 | 62.7 | 149 | 33.2 | 0 | 0 | 0 | 512 | 0 | 100.0 |
| S11 | 100 | ace | ALL | 2/2 | 82.5 | 112.6 | 87 | 50.7 | 0 | 0 | 0 | 15086 | 0 | 100.0 |
| S12 | 3 | centralized | ALL | 4/4 | 37.3 | 43.1 | 386 | 26.7 | 4.1 | 0 | — | 288 | 0 | 100.0 |
| S12 | 3 | decentralized | ALL | 4/4 | 47.2 | 54 | 305 | 31.8 | 4.0 | 0 | 0.7 | 272 | 0 | 87.7 |
| S12 | 3 | ace | ALL | 4/4 | 62.7 | 65.6 | 230 | 37.2 | 4.0 | 0 | 0 | 328 | 0 | 76.2 |
| S12 | 100 | centralized | LIMIT | 54/101 | — | 450.9 | 431 | 227.5 | 205.2 | 41 | — | 4216 | 0 | 72.9 |
| S12 | 100 | decentralized | LIMIT | 37/101 | — | 451.2 | 295 | 242.5 | 208.9 | 58 | 262.5 | 10170 | 0 | 49.9 |
| S12 | 100 | ace | LIMIT | 28/101 | — | 451.1 | 223 | 207.2 | 170.8 | 67 | 344.7 | 12586 | 0 | 37.7 |
| S13 | 3 | centralized | LIMIT | 17/24 | — | 450 | 136 | 145.8 | 126.3 | 5 | — | 689 | 0 | 72.1 |
| S13 | 3 | decentralized | LIMIT | 23/24 | — | 450.1 | 184 | 136.8 | 114.5 | 0 | 8.1 | 467 | 0 | 97.6 |
| S13 | 3 | ace | LIMIT | 8/24 | — | 450.4 | 64 | 149.7 | 111.2 | 14 | 17.1 | 814 | 0 | 47.1 |
| S13 | 100 | centralized | LIMIT | 37/412 | — | 450.8 | 295 | 240.0 | 206.9 | 369 | — | 5465 | 0 | 46.9 |
| S13 | 100 | decentralized | LIMIT | 34/412 | — | 450.8 | 272 | 257.7 | 218.1 | 371 | 443 | 25699 | 0 | 54.5 |
| S13 | 100 | ace | LIMIT | 34/412 | — | 451 | 271 | 240.9 | 205.8 | 371 | 197.9 | 27750 | 0 | 54.5 |
| S14 | 3 | centralized | ALL | 4/4 | 36.4 | 41.7 | 396 | 26.3 | 4 | 0 | — | 286 | 0 | 100.0 |
| S14 | 3 | decentralized | ALL | 4/4 | 47.4 | 54.7 | 304 | 32.0 | 4.0 | 0 | 0.8 | 272 | 0 | 86.3 |
| S14 | 3 | ace | ALL | 4/4 | 62.1 | 65.2 | 232 | 37.1 | 4.0 | 0 | 0 | 319 | 0 | 75.6 |
| S14 | 50 | ace | LIMIT | 42/51 | — | 450.6 | 336 | 231.2 | 202.4 | 3 | 178.4 | 3035 | 0 | 82.4 |
| S14 | 100 | centralized | LIMIT | 53/101 | — | 451.1 | 423 | 231.6 | 208.4 | 42 | — | 3997 | 0 | 72.3 |
| S14 | 100 | decentralized | LIMIT | 44/101 | — | 451.2 | 351 | 245.9 | 216.6 | 51 | 196.5 | 10083 | 0 | 60.0 |
| S14 | 100 | ace | LIMIT | 42/101 | — | 451.2 | 335 | 236.3 | 207.0 | 53 | 129.4 | 9967 | 0 | 57.3 |

### 4.3 Where NodeX ACE loses (paired rows, operator stops excluded)

A win or loss uses a ±1 % tie band. Cycle time is compared only when both runs completed all tasks (uncensored). Allocation latency is compared only when neither run left tasks unallocated.

**ACE vs Centralized (33 paired rows):**

| KPI | ACE worse | ACE better | Tie | Geometric mean ACE / Centralized |
|---|---|---|---|---|
| Throughput | **28** | 5 | 0 | **0.736** (−26 %) |
| Task completion | 15 | 0 | 18 | 0.852 |
| Messages per completed task | **24** | 9 | 0 | **1.93×** |
| Mean task cycle time (18 complete pairs) | 13 | 3 | 2 | 1.24× |
| Allocation latency (18 uncensored pairs) | 10 | 7 | 1 | 1.41× (n = 13 non-zero) |

- ACE has higher throughput than Centralized only in S03/3 (×1.125), S04/3 (×1.055), S03/50 (×1.092), S05/50 (×1.167) and S11/3 (×1.029).
- Largest throughput deficits:

  | Row | ACE / Centralized throughput | Detail |
  |---|---|---|
  | S06/10 | 0.317 | makespan 267 s vs 85 s |
  | S07/3 | 0.439 | |
  | S07/50 | 0.45 | 18/51 vs 40/51 tasks |
  | S13/3 | 0.47 | 8/24 vs 17/24 tasks |
  | S02/10 | 0.487 | 29/53 at the limit vs 53/53 |
  | S12/100 | 0.518 | 28 vs 54 tasks |

- Communication: in S07/100, ACE sends about 105,000 messages per completed task vs about 3,200 for Centralized (m ratio 0.03).

**ACE vs Decentralized (32 paired rows):**

| KPI | ACE worse | ACE better | Tie | Geometric mean ACE / Decentralized |
|---|---|---|---|---|
| Throughput | 15 | 14 | 3 | 1.03 |
| Task completion | 6 | 9 | 17 | 1.03 |
| Waiting fraction | 6 | **24** | 1 | **0.62** |
| Messages per completed task | 14 | 16 | 2 | 0.915 |
| Cycle time (16 complete pairs) | 6 | 9 | 1 | 0.969 |
| Allocation latency (16 pairs) | 4 | 5 | 7 | 0.943 |

- ACE loses clearly to Decentralized on:
  - **S02/10:** 29/53 vs 53/53 tasks; throughput 232 vs 538 tasks/h; waiting 1560 vs 567 robot-s; 1511 vs 394 messages per task.
  - **S02/50:** 32 vs 45 tasks.
  - **S13/3:** 8 vs 23 tasks.
  - **S12/100:** 28 vs 37 tasks.
  - **S12/3 and S14/3:** slower makespan (62.7 s vs 47.2 s; 62.1 s vs 47.4 s).
- ACE wins clearly on the failure scenario S07 at 10, 50 and 100 robots (throughput ×4.5, ×3.6, ×2.7) and on waiting time overall.

**Summary.** On recorded data, NodeX ACE does not outperform the Centralized baseline in throughput (−26 % geometric mean, worse in 28 of 33 rows) or communication cost (1.9× messages per task). ACE is roughly on par with plain Decentralized in throughput, and better than Decentralized in waiting and in robot-failure scenarios.

---

## 5. Corrected index — NodeX Fleet Efficiency Index (NFEI) v2.0

This is a project-specific composite of recognized KPIs. It is not an ISO or IEEE metric.

### 5.1 Definition

```
NFEI = 100 × Π_k r_k^(w_k / Σ_applicable w)          (weighted geometric mean of ratios)

k                        ratio r_k (> 1 = better than reference)          w_k
Throughput               X / X_ref                                         0.6
Allocation latency       (L_ref + 1 s) / (L + 1 s)                          0.2
Messages per task        m_ref / m                                          0.2
```

- **Task.** One scenario pick-and-drop order whose status reached COMPLETED.
- **Throughput X.** Tasks completed × 3600 / T_obs, where T_obs = task makespan when all tasks completed, otherwise the sim time at the end of the run. Recomputed unrounded.
- **L.** Mean allocation latency (release → award) of awarded tasks. The 1 s floor avoids division by zero (ACE and Decentralized often record 0 s). It also stops sub-cycle differences such as 0.1 s vs 0.3 s from counting as a 3× gain. Sensitivity to the floor is tested in §6.
- **m.** Messages / tasks completed. Centralized = uplink + downlink. Decentralized/ACE = peer messages. All three count transmissions.
- **Reference (fixed, documented).**
  - The Centralized run(s) with the **identical pairing key**: run kind, scenario, fleet size, seed, map profile, duration limit, configVersion.
  - With several such runs (replicates), each reference KPI is their geometric mean.
  - A run's score never depends on any non-reference run. 100 = parity with Centralized.
- **Pairwise invariance.** With identical component sets, NFEI_A / NFEI_B equals the weighted geometric mean of A/B ratios. The ranking between Decentralized and ACE therefore does not depend on the choice of reference.
- **Scale invariance.** Ratios make the index unit-free, and multiplying a KPI by a constant for every run leaves NFEI unchanged (unit test).
- **Safety = hard validity gate, never a score.**
  - Any collision, obstacle intrusion or boundary violation → **INVALID** (no number). Such a run can never be averaged or compensated.
  - If any of the three is not measured, the run is not scored.
  - Near-collisions are reported beside the value and are not scored.
- **Not scored (—):**
  - Operator-stopped runs: the observation window is not set by the protocol.
  - ACE validation tests: there is no baseline architecture.
  - Runs with no valid Centralized run under the same key.
  - A valid run that completed 0 tasks scores 0.
- **Group-level applicability (removes renormalization bias).**
  - A component is used for every scored run of a pairing group or for none.
  - Allocation latency is used only if no run of the group ended with unallocated tasks, because otherwise the mean over awarded tasks is right-censored.
  - Messages are used only if every run measured them.
  - Throughput is always used.
  - As a result, no system in a row can gain from a component another system lacks.
- **Overall.** Geometric mean of per-row NFEI (a ratio scale) over rows where all three systems have a valid NFEI (paired). The number of INVALID runs is shown beside it.
- **Versioning.**
  - Every result carries `version: "2.0"`, its status and its reference run IDs.
  - NEEI results carry `version: "1.1"`.
  - Stored run records are never modified. Both indexes are computed on read, so the historical record is not rewritten.

### 5.2 Why these KPIs and not others (correlation evidence from the recorded data)
All correlations are computed on log-ratios vs Centralized over the dashboard's paired rows.

| Candidate KPI | Decision | Evidence |
|---|---|---|
| Makespan | excluded | r = **1.000** with throughput on 37 complete pairs: identical signal |
| Task success / completion % | excluded | r = **0.924** with throughput on 30 truncated pairs. In complete pairs it is 1 for every system (no information). |
| Mean task cycle time | excluded, but reported | r = **0.86** with throughput on complete pairs. In truncated runs it is censored: r = −0.04, meaningless. |
| Allocation latency | **included** (0.2) | r = 0.31 (complete) / 0.01 (all) with throughput: independent information about coordination |
| Messages per completed task | **included** (0.2) | r = 0.42 (complete) / 0.50 (all) with throughput: partly independent coordination cost |
| Waiting fraction | reported, not in composite | not measured for the Centralized reference; one negative recorded value |
| Recovery % | reported, not in composite | exists only when a failure occurred (presence-dependent bonus, §3.5) |

Throughput gets the largest weight because it is the one productivity KPI. It already absorbs makespan, completion and (largely) cycle time.

### 5.3 Known limitations (documented, not hidden)
- **Message semantics differ.** Centralized counts one uplink per robot per tick; ACE and Decentralized count peer sends. "Messages" is a like-for-like count of transmissions, not of bytes or airtime.
- **Membership can change applicability.** If a later run with unallocated tasks joins a pairing group, allocation latency drops out for that group. Values are therefore reported with their `componentsUsed` and reference run IDs.
- **n = 1 per cell** (§4.1). NFEI makes the comparison fair; it cannot make one observation statistically meaningful.
- **Safety gate untested on real data.** No recorded run has a collision, intrusion or boundary violation, so the INVALID path is verified only by unit tests.

---

## 6. Sensitivity analysis (historical data)

**Method.** Each weight was multiplied by 0.5, 1 and 1.5 independently (27 combinations, renormalized). The allocation-latency floor was set to 0.5, 1 and 2 s. That gives 81 variants × 4 fleet sizes = 324 overall rankings, and 2592 row-level rankings.

- **Overall ranking at 10, 50 and 100 robots:** **Centralized > NodeX ACE > Decentralized in all 81 variants** (100 % stable).
- **Overall ranking at 3 robots:** Centralized > Decentralized > ACE in 65 of 81 variants and Decentralized > Centralized > ACE in 16. **ACE is third in every variant.**
- **Row level:** the full ranking changes in 215 of 2592 row evaluations (8.3 %), and the row winner changes in 85 (3.3 %). All changes are in 11 rows whose results are close: S01/3, S04/3, S05/3, S01/10, S02/10, S03/10, S05/10, S03/50, S04/50, S03/100, S05/100.

**Extreme weightings** (overall NFEI; C = Centralized, D = Decentralized, A = ACE):

| Variant | 3 robots C / D / A | 10 robots C / D / A | 50 robots C / D / A | 100 robots C / D / A |
|---|---|---|---|---|
| v2.0 weights (0.6 / 0.2 / 0.2) | 99.2 / 96.4 / 86.2 | 100.1 / 58.6 / 64.5 | 100 / 58.4 / 68.0 | 100 / 56.8 / 60.2 |
| Throughput only | 99.3 / 89.3 / 77.3 | 100.4 / 56.8 / 61.9 | 100 / 68.2 / 78.4 | 100 / 76.3 / 80.3 |
| Without messages (0.75 / 0.25 / 0) | 99.6 / 93.4 / 81.2 | 100.3 / 59.2 / 64.8 | 100 / 66.8 / 77.6 | 100 / 76.5 / 80.6 |
| Without allocation latency (0.75 / 0 / 0.25) | 98.8 / 93.9 / 83.9 | 100.1 / 56.9 / 62.8 | 100 / 59.4 / 68.7 | 100 / 56.7 / 60.2 |
| Equal weights (1/3 each) | 99.2 / 101.5 / 93.3 | 99.8 / 59.6 / 65.5 | 100 / 50.1 / 58.8 | 100 / 42.1 / 44.9 |

**Conclusion.** The conclusion "Centralized leads, and ACE is ahead of Decentralized from 10 robots up but behind it at 3 robots" does not depend on the weights. It holds with throughput alone.

---

## 7. Old vs corrected — overall

The overall index uses the paired rows at each fleet size.

| Fleet | Legacy NEEI v1.1 overall (arithmetic mean): C / D / A (rows) | NFEI v2.0 overall (geometric mean): C / D / A (rows) |
|---|---|---|
| 3 | 95.3 / 87.7 / 78.6 (11, includes operator stops) | 99.2 / 96.4 / 86.2 (8) |
| 10 | 99.0 / **77.7 / 76.9** (7) | 100.1 / **58.6 / 64.5** (7) |
| 50 | 85.8 / 67.3 / 70.9 (7) | 100 / 58.4 / 68.0 (7) |
| 100 | 69.3 / 58.4 / 59.1 (10) | 100 / 56.8 / 60.2 (10) |

- **Why Centralized is not exactly 100 at 3 and 10 robots.** S01 has two Centralized replicates, so the reference is their geometric mean and the latest replicate scores 93.8 (3 robots) and 100.4 (10 robots).
- **Why D and A swap at 10 robots.**
  - NEEI gave Decentralized 100 on S02/10 by best-of-set clamping, and a recovery bonus on S07/10.
  - NFEI instead compares Decentralized's S04/10 run against Centralized directly: 0.40× throughput and 6.6× messages per task.
  - The swap also holds with throughput alone (61.9 vs 56.8), so it is not produced by the message weight.
- **Why NFEI gaps are wider.** NEEI compressed the gaps through clamping at the best run and through double-counted completion.

## 8. Old vs corrected — every run the dashboard displays

Key to columns and codes:
- **Components:** X = throughput ratio, L = allocation-latency ratio, m = messages-per-task ratio, all vs the Centralized reference (> 1 = better).
- **EXCLUDED:** operator-stopped run.
- **NO_REFERENCE:** no Centralized run with the same key.

| Scenario | Fleet | System | Run | End | Legacy NEEI v1.1 | NFEI v2.0 | NFEI components (ratios vs Centralized) | Reason for difference |
|---|---|---|---|---|---|---|---|---|
| S01 | 3 | centralized | RUN-MUKQNC8C-1 | ALL_TASKS_COMPLETE | 100.0 | 93.8 | X 0.942, L 1.06, m 0.821 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S01 | 3 | decentralized | RUN-MUKR9PFU-5 | ALL_TASKS_COMPLETE | 78.9 | 74.4 | X 0.604, L 0.809, m 1.275 | v1.1 counted time+throughput twice; alloc latency differs |
| S01 | 3 | ace | RUN-MUKS67YN-9 | ALL_TASKS_COMPLETE | 84.0 | 79.1 | X 0.685, L 0.907, m 1.063 | v1.1 counted time+throughput twice |
| S01 | 10 | centralized | RUN-MUKQNO2R-2 | ALL_TASKS_COMPLETE | 100.0 | 100.4 | X 1.03, L 1.004, m 0.929 | v1.1 counted time+throughput twice; reference = 100 by definition; >100 = better than reference (v1.1 capped at best-of-set) |
| S01 | 10 | decentralized | RUN-MUKREEFA-6 | ALL_TASKS_COMPLETE | 82.4 | 76.0 | X 0.722, L 0.662, m 1.02 | v1.1 counted time+throughput twice; alloc latency differs |
| S01 | 10 | ace | RUN-MUKS85E5-10 | ALL_TASKS_COMPLETE | 75.0 | 73.3 | X 0.592, L 0.859, m 1.19 | v1.1 counted time+throughput twice |
| S01 | 50 | centralized | RUN-MUKQO4IR-3 | DURATION_LIMIT | 98.8 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S01 | 50 | decentralized | RUN-MUKRHI2F-7 | DURATION_LIMIT | 76.6 | 80.1 | X 0.776, m 0.881 | v1.1 task success ~ throughput (double) |
| S01 | 50 | ace | RUN-MUKSEYRT-11 | DURATION_LIMIT | 80.6 | 83.6 | X 0.815, m 0.901 | v1.1 task success ~ throughput (double) |
| S01 | 100 | centralized | RUN-MUKQW1D4-4 | DURATION_LIMIT | 72.6 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S01 | 100 | decentralized | RUN-MUKRUVT1-8 | DURATION_LIMIT | 54.8 | 55.7 | X 0.754, m 0.225 | v1.1 task success ~ throughput (double); comm cost penalised |
| S01 | 100 | ace | RUN-MUKSQ6BZ-12 | DURATION_LIMIT | 58.9 | 60.5 | X 0.811, m 0.251 | v1.1 task success ~ throughput (double); comm cost penalised |
| S02 | 3 | centralized | RUN-MUKT6UO7-13 | ALL_TASKS_COMPLETE | 90.9 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S02 | 3 | decentralized | RUN-MUKUO6DT-17 | ALL_TASKS_COMPLETE | 100.0 | 101.1 | X 1.184, L 1.188, m 0.536 | v1.1 counted time+throughput twice; comm cost penalised; >100 = better than reference (v1.1 capped at best-of-set) |
| S02 | 3 | ace | RUN-MUKD38KQ-52 | OPERATOR_STOP | 45.0 | EXCLUDED | — | operator stop: excluded |
| S02 | 10 | centralized | RUN-MUKTIFB0-14 | ALL_TASKS_COMPLETE | 93.2 | 100.0 | X 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S02 | 10 | decentralized | RUN-MUKUXVXI-18 | ALL_TASKS_COMPLETE | 100.0 | 94.1 | X 1.131, m 0.541 | v1.1 counted time+throughput twice; comm cost penalised |
| S02 | 10 | ace | RUN-MUKVTQKS-3 | DURATION_LIMIT | 49.9 | 35.7 | X 0.487, m 0.141 | v1.1 task success ~ throughput (double); comm cost penalised |
| S02 | 50 | centralized | RUN-MUKTWYGM-15 | DURATION_LIMIT | 55.9 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S02 | 50 | decentralized | RUN-MUKVOGTV-1 | DURATION_LIMIT | 48.3 | 53.9 | X 0.864, m 0.131 | v1.1 task success ~ throughput (double); comm cost penalised |
| S02 | 50 | ace | RUN-MUKVVOK9-4 | DURATION_LIMIT | 34.3 | 41.4 | X 0.614, m 0.127 | v1.1 task success ~ throughput (double); comm cost penalised |
| S02 | 100 | centralized | RUN-MUKU9CFQ-16 | DURATION_LIMIT | 47.5 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S02 | 100 | decentralized | RUN-MUKVR5TH-2 | DURATION_LIMIT | 40.4 | 44.1 | X 0.852, m 0.061 | v1.1 task success ~ throughput (double); comm cost penalised |
| S02 | 100 | ace | RUN-MUKW6IAE-5 | DURATION_LIMIT | 41.5 | 45.5 | X 0.876, m 0.064 | v1.1 task success ~ throughput (double); comm cost penalised |
| S03 | 3 | centralized | RUN-MUKWEJX3-6 | ALL_TASKS_COMPLETE | 93.4 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S03 | 3 | decentralized | RUN-MUKX8I71-10 | ALL_TASKS_COMPLETE | 84.3 | 81.2 | X 0.825, L 1.124, m 0.558 | v1.1 counted time+throughput twice; comm cost penalised |
| S03 | 3 | ace | RUN-MUKXDEB9-14 | ALL_TASKS_COMPLETE | 100.0 | 109.8 | X 1.125, L 1.209, m 0.928 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S03 | 10 | centralized | RUN-MUKWNZ9E-7 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S03 | 10 | decentralized | RUN-MUKXA870-11 | ALL_TASKS_COMPLETE | 97.4 | 82.6 | X 0.956, L 0.659, m 0.669 | v1.1 counted time+throughput twice; comm cost penalised; alloc latency differs |
| S03 | 10 | ace | RUN-MUKXKUW7-15 | ALL_TASKS_COMPLETE | 97.1 | 96.1 | X 0.951, L 0.811, m 1.177 | v1.1 counted time+throughput twice; alloc latency differs |
| S03 | 50 | centralized | RUN-MUKWRR30-8 | ALL_TASKS_COMPLETE | 92.1 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S03 | 50 | decentralized | RUN-MUKXB7FA-12 | ALL_TASKS_COMPLETE | 100.0 | 96.0 | X 1.154, L 0.758, m 0.701 | v1.1 counted time+throughput twice; comm cost penalised; alloc latency differs |
| S03 | 50 | ace | RUN-MUKXTOSP-16 | ALL_TASKS_COMPLETE | 96.9 | 98.8 | X 1.092, L 0.846, m 0.856 | v1.1 counted time+throughput twice |
| S03 | 100 | centralized | RUN-MUKX1512-9 | ALL_TASKS_COMPLETE | 96.9 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S03 | 100 | decentralized | RUN-MUKXCAWY-13 | ALL_TASKS_COMPLETE | 100.0 | 94.5 | X 1.056, L 0.806, m 0.793 | v1.1 counted time+throughput twice; comm cost penalised; alloc latency differs |
| S03 | 100 | ace | RUN-MUKY45CB-17 | ALL_TASKS_COMPLETE | 91.6 | 85.6 | X 0.906, L 0.768, m 0.804 | v1.1 counted time+throughput twice; alloc latency differs |
| S04 | 3 | centralized | RUN-MUKYD6HJ-18 | ALL_TASKS_COMPLETE | 93.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S04 | 3 | decentralized | RUN-MUKZ31SB-22 | ALL_TASKS_COMPLETE | 100.0 | 103.5 | X 1.135, L 1.041, m 0.781 | v1.1 counted time+throughput twice; comm cost penalised; >100 = better than reference (v1.1 capped at best-of-set) |
| S04 | 3 | ace | RUN-MUKZUO48-26 | ALL_TASKS_COMPLETE | 95.8 | 105.1 | X 1.055, L 0.934, m 1.166 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S04 | 10 | centralized | RUN-MUKYEY87-19 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S04 | 10 | decentralized | RUN-MUKZ3BII-23 | ALL_TASKS_COMPLETE | 64.9 | 38.0 | X 0.403, L 0.8, m 0.152 | v1.1 counted time+throughput twice; comm cost penalised; alloc latency differs |
| S04 | 10 | ace | RUN-MUKZWUTK-27 | ALL_TASKS_COMPLETE | 90.5 | 71.1 | X 0.838, L 0.675, m 0.456 | v1.1 counted time+throughput twice; comm cost penalised; alloc latency differs |
| S04 | 50 | centralized | RUN-MUKYIHJN-20 | DURATION_LIMIT | 79.4 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S04 | 50 | decentralized | RUN-MUKZ85XO-24 | DURATION_LIMIT | 64.9 | 66.1 | X 0.817, m 0.35 | v1.1 task success ~ throughput (double); comm cost penalised |
| S04 | 50 | ace | RUN-MULWMHZL-1 | DURATION_LIMIT | 67.3 | 65.5 | X 0.847, m 0.303 | v1.1 task success ~ throughput (double); comm cost penalised |
| S04 | 100 | centralized | RUN-MUKYTUHR-21 | DURATION_LIMIT | 59.0 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S04 | 100 | decentralized | RUN-MUKZJKFK-25 | DURATION_LIMIT | 43.4 | 53.4 | X 0.736, m 0.204 | v1.1 task success ~ throughput (double); comm cost penalised |
| S04 | 100 | ace | RUN-MULWNT1I-2 | DURATION_LIMIT | 45.3 | 55.0 | X 0.768, m 0.202 | v1.1 task success ~ throughput (double); comm cost penalised |
| S05 | 3 | centralized | RUN-MULWPAFA-3 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S05 | 3 | decentralized | RUN-MULWQN9H-7 | ALL_TASKS_COMPLETE | 90.9 | 101.5 | X 0.845, L 1.13, m 1.584 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S05 | 3 | ace | RUN-MULWS3DU-11 | ALL_TASKS_COMPLETE | 95.7 | 107.9 | X 0.926, L 1.13, m 1.632 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S05 | 10 | centralized | RUN-MULWPLDV-4 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S05 | 10 | decentralized | RUN-MULWR014-8 | ALL_TASKS_COMPLETE | 98.7 | 119.8 | X 0.981, L 1.14, m 2.298 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S05 | 10 | ace | RUN-MULWSF2B-12 | ALL_TASKS_COMPLETE | 82.7 | 91.6 | X 0.711, L 1.14, m 1.58 | v1.1 counted time+throughput twice |
| S05 | 50 | centralized | RUN-MULWPZHD-5 | ALL_TASKS_COMPLETE | 86.9 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S05 | 50 | decentralized | RUN-MULWREJB-9 | ALL_TASKS_COMPLETE | 100.0 | 142.4 | X 1.286, L 1.12, m 2.462 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S05 | 50 | ace | RUN-MULWSZ3V-13 | ALL_TASKS_COMPLETE | 94.5 | 132.1 | X 1.167, L 1.12, m 2.261 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S05 | 100 | centralized | RUN-MULWQBAJ-6 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S05 | 100 | decentralized | RUN-MULWRPBK-10 | ALL_TASKS_COMPLETE | 92.0 | 105.8 | X 0.865, L 1.28, m 1.599 | v1.1 counted time+throughput twice; alloc latency differs; >100 = better than reference (v1.1 capped at best-of-set) |
| S05 | 100 | ace | RUN-MULWTAK0-14 | ALL_TASKS_COMPLETE | 96.6 | 113.5 | X 0.94, L 1.28, m 1.772 | v1.1 counted time+throughput twice; alloc latency differs; >100 = better than reference (v1.1 capped at best-of-set) |
| S06 | 3 | centralized | RUN-MULWTNOT-15 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S06 | 3 | decentralized | RUN-MULX9X08-19 | ALL_TASKS_COMPLETE | 88.3 | 95.8 | X 0.802, L 0.88, m 1.774 | v1.1 counted time+throughput twice |
| S06 | 3 | ace | RUN-MUKDBC1E-53 | OPERATOR_STOP | 73.3 | EXCLUDED | — | operator stop: excluded |
| S06 | 10 | centralized | RUN-MULWTVKZ-16 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S06 | 10 | decentralized | RUN-MULXCGTN-20 | ALL_TASKS_COMPLETE | 65.5 | 52.7 | X 0.414, L 0.903, m 0.637 | v1.1 counted time+throughput twice; comm cost penalised |
| S06 | 10 | ace | RUN-MULY1XCW-2 | ALL_TASKS_COMPLETE | 59.8 | 39.4 | X 0.317, L 0.721, m 0.412 | v1.1 counted time+throughput twice; comm cost penalised; alloc latency differs |
| S06 | 50 | centralized | RUN-MULWUA50-17 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S06 | 50 | decentralized | RUN-MULXJKJB-21 | DURATION_LIMIT | 68.1 | 73.8 | X 0.674, m 0.971 | v1.1 task success ~ throughput (double) |
| S06 | 50 | ace | RUN-MULY34PB-3 | DURATION_LIMIT | 75.9 | 78.6 | X 0.75, m 0.904 | v1.1 task success ~ throughput (double) |
| S06 | 100 | centralized | RUN-MULWWA1Y-18 | DURATION_LIMIT | 61.7 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S06 | 100 | decentralized | RUN-MULXZWJA-1 | DURATION_LIMIT | 67.7 | 82.6 | X 1.096, m 0.354 | v1.1 task success ~ throughput (double); comm cost penalised |
| S06 | 100 | ace | RUN-MULY52QM-4 | DURATION_LIMIT | 54.1 | 66.8 | X 0.876, m 0.296 | v1.1 task success ~ throughput (double); comm cost penalised |
| S07 | 3 | centralized | RUN-MULY73CC-5 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S07 | 3 | decentralized | RUN-MULYYMYO-9 | OPERATOR_STOP | 50.4 | EXCLUDED | — | operator stop: excluded |
| S07 | 3 | ace | RUN-MUM03Q4K-13 | ALL_TASKS_COMPLETE | 71.9 | 54.2 | X 0.439, L 0.817, m 0.68 | v1.1 counted time+throughput twice; v1.1 recovery bonus 1; comm cost penalised; alloc latency differs |
| S07 | 10 | centralized | RUN-MULY7EBX-6 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S07 | 10 | decentralized | RUN-MULZ78YA-10 | DURATION_LIMIT | 35.1 | 16.8 | X 0.15, m 0.233 | v1.1 recovery bonus 0.444; v1.1 task success ~ throughput (double); comm cost penalised |
| S07 | 10 | ace | RUN-MUM05P4L-14 | ALL_TASKS_COMPLETE | 83.5 | 71.7 | X 0.67, m 0.879 | v1.1 counted time+throughput twice; v1.1 recovery bonus 1 |
| S07 | 50 | centralized | RUN-MULY82BG-7 | DURATION_LIMIT | 87.4 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S07 | 50 | decentralized | RUN-MULZGFGD-11 | DURATION_LIMIT | 13.3 | 8.0 | X 0.125, m 0.021 | v1.1 recovery bonus 0.227; v1.1 task success ~ throughput (double); comm cost penalised |
| S07 | 50 | ace | RUN-MUM09AHL-15 | DURATION_LIMIT | 47.1 | 28.8 | X 0.45, m 0.076 | v1.1 recovery bonus 0.783; v1.1 task success ~ throughput (double); comm cost penalised |
| S07 | 100 | centralized | RUN-MULYKTA4-8 | DURATION_LIMIT | 63.0 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S07 | 100 | decentralized | RUN-MULZQ3EU-12 | DURATION_LIMIT | 21.0 | 12.1 | X 0.27, m 0.011 | v1.1 recovery bonus 0.37; v1.1 task success ~ throughput (double); comm cost penalised |
| S07 | 100 | ace | RUN-MUM0JNFR-16 | DURATION_LIMIT | 53.2 | 32.9 | X 0.73, m 0.03 | v1.1 recovery bonus 0.818; v1.1 task success ~ throughput (double); comm cost penalised |
| S08 | 3 | centralized | RUN-MUM0Z5BE-17 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 recovery bonus 1; reference = 100 by definition |
| S10 | 3 | ace | RUN-MUKDCO83-55 | ALL_TASKS_COMPLETE | 100.0 | NO_REFERENCE | — | no Centralized run with same key: v1.1 scored it vs nothing/partial set |
| S11 | 3 | centralized | RUN-MUM10T0P-25 | ALL_TASKS_COMPLETE | 98.4 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S11 | 3 | decentralized | RUN-MUM116GQ-26 | ALL_TASKS_COMPLETE | 100.0 | 111.5 | X 1.029, L 1.12, m 1.414 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S11 | 3 | ace | RUN-MUM11JV4-27 | ALL_TASKS_COMPLETE | 100.0 | 111.5 | X 1.029, L 1.12, m 1.41 | v1.1 counted time+throughput twice; >100 = better than reference (v1.1 capped at best-of-set) |
| S11 | 100 | ace | RUN-MUM1MIQR-37 | ALL_TASKS_COMPLETE | 100.0 | NO_REFERENCE | — | no Centralized run with same key: v1.1 scored it vs nothing/partial set |
| S12 | 3 | centralized | RUN-MUM0ZZZJ-23 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S12 | 3 | decentralized | RUN-MUM0ZOKZ-22 | ALL_TASKS_COMPLETE | 87.7 | 88.3 | X 0.79, L 1.03, m 1.057 | v1.1 counted time+throughput twice |
| S12 | 3 | ace | RUN-MUM10DUH-24 | ALL_TASKS_COMPLETE | 76.2 | 71.7 | X 0.595, L 1.026, m 0.878 | v1.1 counted time+throughput twice |
| S12 | 100 | centralized | RUN-MUM1GBVB-34 | DURATION_LIMIT | 72.9 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S12 | 100 | decentralized | RUN-MUM1IBQY-35 | DURATION_LIMIT | 49.9 | 60.4 | X 0.685, m 0.415 | v1.1 task success ~ throughput (double); comm cost penalised |
| S12 | 100 | ace | RUN-MUM1KEK2-36 | DURATION_LIMIT | 37.7 | 46.5 | X 0.518, m 0.335 | v1.1 task success ~ throughput (double); comm cost penalised |
| S13 | 3 | centralized | RUN-MUM0T9MU-18 | DURATION_LIMIT | 72.1 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S13 | 3 | decentralized | RUN-MUM0VFOL-19 | DURATION_LIMIT | 97.6 | 138.2 | X 1.353, m 1.475 | v1.1 task success ~ throughput (double); >100 = better than reference (v1.1 capped at best-of-set) |
| S13 | 3 | ace | RUN-MUM0QWVD-17 | DURATION_LIMIT | 47.1 | 54.5 | X 0.47, m 0.847 | v1.1 recovery bonus 1; v1.1 task success ~ throughput (double) |
| S13 | 100 | centralized | RUN-MUM1EA72-33 | DURATION_LIMIT | 46.9 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S13 | 100 | decentralized | RUN-MUM1BV77-32 | DURATION_LIMIT | 54.5 | 63.7 | X 0.919, m 0.213 | v1.1 recovery bonus 1; v1.1 task success ~ throughput (double); comm cost penalised |
| S13 | 100 | ace | RUN-MUM19F41-31 | DURATION_LIMIT | 54.5 | 62.5 | X 0.919, m 0.197 | v1.1 recovery bonus 1; v1.1 task success ~ throughput (double); comm cost penalised |
| S14 | 3 | centralized | RUN-MUM0Y5AT-20 | ALL_TASKS_COMPLETE | 100.0 | 100.0 | X 1, L 1, m 1 | v1.1 counted time+throughput twice; reference = 100 by definition |
| S14 | 3 | decentralized | RUN-MUM0Z7Y5-21 | ALL_TASKS_COMPLETE | 86.3 | 86.3 | X 0.768, L 1.008, m 1.051 | v1.1 counted time+throughput twice |
| S14 | 3 | ace | RUN-MUM0FT79-15 | ALL_TASKS_COMPLETE | 75.6 | 71.1 | X 0.586, L 1.006, m 0.898 | v1.1 counted time+throughput twice |
| S14 | 50 | ace | RUN-MULYT6NV-2 | DURATION_LIMIT | 82.4 | NO_REFERENCE | — | no Centralized run with same key: v1.1 scored it vs nothing/partial set |
| S14 | 100 | centralized | RUN-MUM130TA-28 | DURATION_LIMIT | 72.3 | 100.0 | X 1, m 1 | v1.1 task success ~ throughput (double); reference = 100 by definition |
| S14 | 100 | decentralized | RUN-MUM152AH-29 | DURATION_LIMIT | 60.0 | 69.0 | X 0.83, m 0.396 | v1.1 task success ~ throughput (double); comm cost penalised |
| S14 | 100 | ace | RUN-MUM177NA-30 | DURATION_LIMIT | 57.3 | 66.8 | X 0.792, m 0.401 | v1.1 task success ~ throughput (double); comm cost penalised |

## 9. All 115 historical scenario runs (including superseded replicates)

- **Legacy NEEI** for a superseded run is the value the dashboard would show if that run were its system's latest (reference = that run + the latest run of each other system).
- **NFEI** does not depend on which run is latest.
- **ACE-test runs (77)** are all **EXCLUDED** from NFEI (no baseline). Their legacy NEEI equals completion % in 69 cases and completion % plus a recovery bonus in 8.

Status counts over all 192 runs:

| Status | Runs |
|---|---|
| Scenario runs OK | 107 |
| Scenario runs EXCLUDED (operator stop) | 4 |
| Scenario runs NO_REFERENCE | 4 |
| ACE-test runs EXCLUDED | 77 |

| Run | Scen | Fleet | System | End | Duration limit s | Legacy NEEI v1.1 | NFEI v2.0 |
|---|---|---|---|---|---|---|---|
| RUN-MUM1MIQR-37 | S11 | 100 | ace | ALL_TASKS_COMPLETE | 450 | 100.0 | NO_REFERENCE |
| RUN-MUM1KEK2-36 | S12 | 100 | ace | DURATION_LIMIT | 450 | 37.7 | 46.5 |
| RUN-MUM1IBQY-35 | S12 | 100 | decentralized | DURATION_LIMIT | 450 | 49.9 | 60.4 |
| RUN-MUM1GBVB-34 | S12 | 100 | centralized | DURATION_LIMIT | 450 | 72.9 | 100.0 |
| RUN-MUM1EA72-33 | S13 | 100 | centralized | DURATION_LIMIT | 450 | 46.9 | 100.0 |
| RUN-MUM1BV77-32 | S13 | 100 | decentralized | DURATION_LIMIT | 450 | 54.5 | 63.7 |
| RUN-MUM19F41-31 | S13 | 100 | ace | DURATION_LIMIT | 450 | 54.5 | 62.5 |
| RUN-MUM177NA-30 | S14 | 100 | ace | DURATION_LIMIT | 450 | 57.3 | 66.8 |
| RUN-MUM152AH-29 | S14 | 100 | decentralized | DURATION_LIMIT | 450 | 60.0 | 69.0 |
| RUN-MUM130TA-28 | S14 | 100 | centralized | DURATION_LIMIT | 450 | 72.3 | 100.0 |
| RUN-MUM11JV4-27 | S11 | 3 | ace | ALL_TASKS_COMPLETE | 450 | 100.0 | 111.5 |
| RUN-MUM116GQ-26 | S11 | 3 | decentralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 111.5 |
| RUN-MUM10T0P-25 | S11 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 98.4 | 100.0 |
| RUN-MUM10DUH-24 | S12 | 3 | ace | ALL_TASKS_COMPLETE | 450 | 76.2 | 71.7 |
| RUN-MUM0ZZZJ-23 | S12 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MUM0ZOKZ-22 | S12 | 3 | decentralized | ALL_TASKS_COMPLETE | 450 | 87.7 | 88.3 |
| RUN-MUM0Z7Y5-21 | S14 | 3 | decentralized | ALL_TASKS_COMPLETE | 450 | 86.3 | 86.3 |
| RUN-MUM0Z5BE-17 | S08 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MUM0Y5AT-20 | S14 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MUM0VFOL-19 | S13 | 3 | decentralized | DURATION_LIMIT | 450 | 97.6 | 138.2 |
| RUN-MUM0T9MU-18 | S13 | 3 | centralized | DURATION_LIMIT | 450 | 72.1 | 100.0 |
| RUN-MUM0QWVD-17 | S13 | 3 | ace | DURATION_LIMIT | 450 | 47.1 | 54.5 |
| RUN-MUM0JNFR-16 | S07 | 100 | ace | DURATION_LIMIT | 450 | 53.2 | 32.9 |
| RUN-MUM0GCRF-16 | S13 | 3 | ace | DURATION_LIMIT | 450 | 57.3 | 74.5 |
| RUN-MUM0FT79-15 | S14 | 3 | ace | ALL_TASKS_COMPLETE | 450 | 75.6 | 71.1 |
| RUN-MUM09AHL-15 | S07 | 50 | ace | DURATION_LIMIT | 450 | 47.1 | 28.8 |
| RUN-MUM05P4L-14 | S07 | 10 | ace | ALL_TASKS_COMPLETE | 450 | 83.5 | 71.7 |
| RUN-MUM03Q4K-13 | S07 | 3 | ace | ALL_TASKS_COMPLETE | 450 | 71.9 | 54.2 |
| RUN-MULZQ3EU-12 | S07 | 100 | decentralized | DURATION_LIMIT | 450 | 21.0 | 12.1 |
| RUN-MULZGFGD-11 | S07 | 50 | decentralized | DURATION_LIMIT | 450 | 13.3 | 8.0 |
| RUN-MULZ78YA-10 | S07 | 10 | decentralized | DURATION_LIMIT | 450 | 35.1 | 16.8 |
| RUN-MULYYMYO-9 | S07 | 3 | decentralized | OPERATOR_STOP | 450 | 50.4 | EXCLUDED |
| RUN-MULYT6NV-2 | S14 | 50 | ace | DURATION_LIMIT | 450 | 82.4 | NO_REFERENCE |
| RUN-MULYP5PB-1 | S14 | 50 | ace | DURATION_LIMIT | 90 | 13.7 | NO_REFERENCE |
| RUN-MULYKTA4-8 | S07 | 100 | centralized | DURATION_LIMIT | 450 | 63.0 | 100.0 |
| RUN-MULY82BG-7 | S07 | 50 | centralized | DURATION_LIMIT | 450 | 87.4 | 100.0 |
| RUN-MULY7EBX-6 | S07 | 10 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MULY73CC-5 | S07 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MULY52QM-4 | S06 | 100 | ace | DURATION_LIMIT | 450 | 54.1 | 66.8 |
| RUN-MULY34PB-3 | S06 | 50 | ace | DURATION_LIMIT | 450 | 75.9 | 78.6 |
| RUN-MULY1XCW-2 | S06 | 10 | ace | ALL_TASKS_COMPLETE | 450 | 59.8 | 39.4 |
| RUN-MULXZWJA-1 | S06 | 100 | decentralized | DURATION_LIMIT | 450 | 67.7 | 82.6 |
| RUN-MULXJKJB-21 | S06 | 50 | decentralized | DURATION_LIMIT | 450 | 68.1 | 73.8 |
| RUN-MULXCGTN-20 | S06 | 10 | decentralized | ALL_TASKS_COMPLETE | 450 | 65.5 | 52.7 |
| RUN-MULX9X08-19 | S06 | 3 | decentralized | ALL_TASKS_COMPLETE | 450 | 88.3 | 95.8 |
| RUN-MULWWA1Y-18 | S06 | 100 | centralized | DURATION_LIMIT | 450 | 61.7 | 100.0 |
| RUN-MULWUA50-17 | S06 | 50 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MULWTVKZ-16 | S06 | 10 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MULWTNOT-15 | S06 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MULWTAK0-14 | S05 | 100 | ace | ALL_TASKS_COMPLETE | 300 | 96.6 | 113.5 |
| RUN-MULWSZ3V-13 | S05 | 50 | ace | ALL_TASKS_COMPLETE | 300 | 94.5 | 132.1 |
| RUN-MULWSF2B-12 | S05 | 10 | ace | ALL_TASKS_COMPLETE | 300 | 82.7 | 91.6 |
| RUN-MULWS3DU-11 | S05 | 3 | ace | ALL_TASKS_COMPLETE | 300 | 95.7 | 107.9 |
| RUN-MULWRPBK-10 | S05 | 100 | decentralized | ALL_TASKS_COMPLETE | 300 | 92.0 | 105.8 |
| RUN-MULWREJB-9 | S05 | 50 | decentralized | ALL_TASKS_COMPLETE | 300 | 100.0 | 142.4 |
| RUN-MULWR014-8 | S05 | 10 | decentralized | ALL_TASKS_COMPLETE | 300 | 98.7 | 119.8 |
| RUN-MULWQN9H-7 | S05 | 3 | decentralized | ALL_TASKS_COMPLETE | 300 | 90.9 | 101.5 |
| RUN-MULWQBAJ-6 | S05 | 100 | centralized | ALL_TASKS_COMPLETE | 300 | 100.0 | 100.0 |
| RUN-MULWPZHD-5 | S05 | 50 | centralized | ALL_TASKS_COMPLETE | 300 | 86.9 | 100.0 |
| RUN-MULWPLDV-4 | S05 | 10 | centralized | ALL_TASKS_COMPLETE | 300 | 100.0 | 100.0 |
| RUN-MULWPAFA-3 | S05 | 3 | centralized | ALL_TASKS_COMPLETE | 300 | 100.0 | 100.0 |
| RUN-MULWNT1I-2 | S04 | 100 | ace | DURATION_LIMIT | 300 | 45.3 | 55.0 |
| RUN-MULWMHZL-1 | S04 | 50 | ace | DURATION_LIMIT | 300 | 67.3 | 65.5 |
| RUN-MUKZWUTK-27 | S04 | 10 | ace | ALL_TASKS_COMPLETE | 300 | 90.5 | 71.1 |
| RUN-MUKZUO48-26 | S04 | 3 | ace | ALL_TASKS_COMPLETE | 300 | 95.8 | 105.1 |
| RUN-MUKZJKFK-25 | S04 | 100 | decentralized | DURATION_LIMIT | 300 | 43.4 | 53.4 |
| RUN-MUKZ85XO-24 | S04 | 50 | decentralized | DURATION_LIMIT | 300 | 64.9 | 66.1 |
| RUN-MUKZ3BII-23 | S04 | 10 | decentralized | ALL_TASKS_COMPLETE | 300 | 64.9 | 38.0 |
| RUN-MUKZ31SB-22 | S04 | 3 | decentralized | ALL_TASKS_COMPLETE | 300 | 100.0 | 103.5 |
| RUN-MUKYTUHR-21 | S04 | 100 | centralized | DURATION_LIMIT | 300 | 59.0 | 100.0 |
| RUN-MUKYIHJN-20 | S04 | 50 | centralized | DURATION_LIMIT | 300 | 79.4 | 100.0 |
| RUN-MUKYEY87-19 | S04 | 10 | centralized | ALL_TASKS_COMPLETE | 300 | 100.0 | 100.0 |
| RUN-MUKYD6HJ-18 | S04 | 3 | centralized | ALL_TASKS_COMPLETE | 300 | 93.0 | 100.0 |
| RUN-MUKY45CB-17 | S03 | 100 | ace | ALL_TASKS_COMPLETE | 450 | 91.6 | 85.6 |
| RUN-MUKXTOSP-16 | S03 | 50 | ace | ALL_TASKS_COMPLETE | 450 | 96.9 | 98.8 |
| RUN-MUKXKUW7-15 | S03 | 10 | ace | ALL_TASKS_COMPLETE | 450 | 97.1 | 96.1 |
| RUN-MUKXDEB9-14 | S03 | 3 | ace | ALL_TASKS_COMPLETE | 450 | 100.0 | 109.8 |
| RUN-MUKXCAWY-13 | S03 | 100 | decentralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 94.5 |
| RUN-MUKXB7FA-12 | S03 | 50 | decentralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 96.0 |
| RUN-MUKXA870-11 | S03 | 10 | decentralized | ALL_TASKS_COMPLETE | 450 | 97.4 | 82.6 |
| RUN-MUKX8I71-10 | S03 | 3 | decentralized | ALL_TASKS_COMPLETE | 450 | 84.3 | 81.2 |
| RUN-MUKX1512-9 | S03 | 100 | centralized | ALL_TASKS_COMPLETE | 450 | 96.9 | 100.0 |
| RUN-MUKWRR30-8 | S03 | 50 | centralized | ALL_TASKS_COMPLETE | 450 | 92.1 | 100.0 |
| RUN-MUKWNZ9E-7 | S03 | 10 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.0 |
| RUN-MUKWEJX3-6 | S03 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 93.4 | 100.0 |
| RUN-MUKW6IAE-5 | S02 | 100 | ace | DURATION_LIMIT | 450 | 41.5 | 45.5 |
| RUN-MUKVVOK9-4 | S02 | 50 | ace | DURATION_LIMIT | 450 | 34.3 | 41.4 |
| RUN-MUKVTQKS-3 | S02 | 10 | ace | DURATION_LIMIT | 450 | 49.9 | 35.7 |
| RUN-MUKVR5TH-2 | S02 | 100 | decentralized | DURATION_LIMIT | 450 | 40.4 | 44.1 |
| RUN-MUKVOGTV-1 | S02 | 50 | decentralized | DURATION_LIMIT | 450 | 48.3 | 53.9 |
| RUN-MUKUXVXI-18 | S02 | 10 | decentralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 94.1 |
| RUN-MUKUO6DT-17 | S02 | 3 | decentralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 101.1 |
| RUN-MUKU9CFQ-16 | S02 | 100 | centralized | DURATION_LIMIT | 450 | 47.5 | 100.0 |
| RUN-MUKTWYGM-15 | S02 | 50 | centralized | DURATION_LIMIT | 450 | 55.9 | 100.0 |
| RUN-MUKTIFB0-14 | S02 | 10 | centralized | ALL_TASKS_COMPLETE | 450 | 93.2 | 100.0 |
| RUN-MUKT6UO7-13 | S02 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 90.9 | 100.0 |
| RUN-MUKSQ6BZ-12 | S01 | 100 | ace | DURATION_LIMIT | 450 | 58.9 | 60.5 |
| RUN-MUKSEYRT-11 | S01 | 50 | ace | DURATION_LIMIT | 450 | 80.6 | 83.6 |
| RUN-MUKS85E5-10 | S01 | 10 | ace | ALL_TASKS_COMPLETE | 450 | 75.0 | 73.3 |
| RUN-MUKS67YN-9 | S01 | 3 | ace | ALL_TASKS_COMPLETE | 450 | 84.0 | 79.1 |
| RUN-MUKRUVT1-8 | S01 | 100 | decentralized | DURATION_LIMIT | 450 | 54.8 | 55.7 |
| RUN-MUKRHI2F-7 | S01 | 50 | decentralized | DURATION_LIMIT | 450 | 76.6 | 80.1 |
| RUN-MUKREEFA-6 | S01 | 10 | decentralized | ALL_TASKS_COMPLETE | 450 | 82.4 | 76.0 |
| RUN-MUKR9PFU-5 | S01 | 3 | decentralized | ALL_TASKS_COMPLETE | 450 | 78.9 | 74.4 |
| RUN-MUKQW1D4-4 | S01 | 100 | centralized | DURATION_LIMIT | 450 | 72.6 | 100.0 |
| RUN-MUKQO4IR-3 | S01 | 50 | centralized | DURATION_LIMIT | 450 | 98.8 | 100.0 |
| RUN-MUKQNO2R-2 | S01 | 10 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 100.4 |
| RUN-MUKQNC8C-1 | S01 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 93.8 |
| RUN-MUKQGG83-2 | S01 | 10 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 99.6 |
| RUN-MUKQG6GO-1 | S01 | 3 | centralized | ALL_TASKS_COMPLETE | 450 | 100.0 | 106.6 |
| RUN-MUKDCO83-55 | S10 | 3 | ace | ALL_TASKS_COMPLETE | 450 | 100.0 | NO_REFERENCE |
| RUN-MUKDCC3Z-54 | S14 | 3 | ace | ALL_TASKS_COMPLETE | 450 | 86.2 | 86.3 |
| RUN-MUKDBC1E-53 | S06 | 3 | ace | OPERATOR_STOP | 450 | 73.3 | EXCLUDED |
| RUN-MUKD38KQ-52 | S02 | 3 | ace | OPERATOR_STOP | 450 | 45.0 | EXCLUDED |
| RUN-MUKD357X-51 | S02 | 3 | ace | OPERATOR_STOP | 450 | 0.0 | EXCLUDED |

---

## 10. Implementation and reproducibility

**Files added or changed:**
- `src/data/nfei.js` (new): NFEI v2.0. Pure functions; no dependency on `src/core`.
- `src/data/neei.js`: header marks it LEGACY. Logic unchanged.
- `src/data/analytics-selection.js`:
  - every selection entry now carries both `neei` (v1.1) and `nfei` (v2.0);
  - new `overallNfei` (geometric, paired);
  - KPI rows added: "Efficiency NFEI v2.0", "Legacy NEEI v1.1", messages per task, obstacle intrusions, boundary violations;
  - fleet metric `nfei`;
  - insights use NFEI and the full safety gate.
- `src/screens/ScreenExperiments.js`: the matrix shows NFEI (100 = Centralized reference) with the legacy NEEI value beneath it. The subtitle and tooltip state that NFEI is a project-specific composite of recognized KPIs, not an ISO/IEEE metric. INVALID and "—" are shown where comparisons do not apply (ACE tests, no reference, operator stops).
- `src/data/pdf-report.js` and `src/data/benchmark-runs.js`: reports carry both versions, labelled.
- `tests/nfei-v2.test.js` (new): 21 tests.

**Analysis:** the scripts `analyze.py`, `part2.py`, `part3.py`, `hist.mjs`, `loses.mjs` and `variants.mjs` (kept in the audit session scratchpad) read `backend/shared_state.json`, import the shipped `neei.js` and `nfei.js`, and generated every table above.

**Recommendations for the simulation owners** (not done here, because `src/core` is out of scope):
- bump `CONFIG_VERSION` on every behaviour change;
- record Centralized waiting time and fix the negative waiting value;
- copy `boundaryViolations` into the run summary;
- use the same throughput definition for the live KPI and the archived record;
- record ≥ 5 seeds per scenario × fleet × system and report bootstrap confidence intervals of NFEI.

## 11. v2.1 change (user request: 0-100 scale)

- **Reference:** per KPI, the BEST valid value among the producing runs of the same pairing group (max throughput, min allocation latency, min messages per task), instead of the Centralized run (v2.0). `reference.runIds` lists every producing run; `isReference` is always `false`.
- **Bounded:** each ratio is capped at 1, so NFEI ∈ [0, 100]; 100 = best on every used KPI in that paired comparison.
- **Needs ≥ 2 systems** in the pairing group with valid runs, otherwise `NO_REFERENCE`.
- **Consequence:** a run's score now depends on the other runs of its paired group (adding a better system lowers the others). Rankings within a group are unchanged; values are not comparable with v2.0 numbers above (which are relative to Centralized and can exceed 100).
- Tables in §§ 4–9 were computed with v2.0 and were not regenerated.
- `tests/nfei-v2.test.js` updated to v2.1 semantics (best-in-group = 100, hand-calculated geometric mean vs best, 0..100 bound, monotonicity for a non-best run, all producing runIds as reference).
