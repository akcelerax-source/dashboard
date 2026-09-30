# NODEX experiment configuration (headless benchmark)

This document fixes the configuration of the reproducible headless benchmark
of the three fleet architectures in the NodeX ACE-AMR warehouse simulator:
System 1 **centralized** (Hungarian assignment + CBS on a central server),
System 2 **decentralized** (P2P Contract-Net, fixed pair coordination) and
System 3 **ace** (NodeX Edge AI + RACE risk + adaptive coordination envelope).

The harness lives in `bench/`; results are in `bench/results/`.

## 1. Simulator and code trees

| Item | Value |
|---|---|
| Simulator | NodeX dashboard simulator, vanilla JS ES modules, driven headlessly under vitest 5 (node) |
| Baseline tree | `zz-base/` = frozen copy of `src/` taken before any optimization (`SRC=zz-base`) |
| Candidate tree | `src/` (`SRC=src`) |
| Config version | `NODEX-ARCH-2026.09-r3` (`CONFIG_VERSION`, sim-lifecycle.js), software `NODEX-0.9.3`, map version 2.1.0 |
| Harness version | `nodex-bench-1.0` (`bench/lib.js`) |
| Tick | fixed `simEngine.update(0.1)` (0.1 s sim per tick), sim speed 1.0, macrotask flush every 20 ticks and immediately once the engine schedules the run finish |
| Run end | `ALL_TASKS_COMPLETE` (every task done, then robots park or 30 s grace) or `DURATION_LIMIT` |

Only behaviour-neutral changes were made to the simulator for the harness:
`core/seeded-workload.js` (new) plus three hooks in `core/scenario-engine.js`
(section 5), applied identically to `src/` and `zz-base/` (the two `core/`
trees are byte-identical). With the default seed 18427 they are the identity:
the full regression suite (19 files, 376 tests) passes and seed-18427 run
digests are bit-identical before and after the change.

## 2. Map

Map `WH-A` (adaptive generator, `MapGeometryEngine.loadMap`). The world
profile is selected by fleet size:

| Fleet | World profile | Floor (px) | Aisle grid | Racks (base) |
|---|---|---|---|---|
| 3 | WORLD-S Small warehouse | 700 x 360 | 4 V x 3 H | 4 |
| 10 | WORLD-M Large warehouse | 900 x 520 | 5 V x 4 H | 8 |
| 50 | WORLD-L Larger warehouse | 1060 x 650 | 6 V x 5 H | 12 |
| 100 | WORLD-XL Largest (with staging floor) | 1060 x 1000 | 6 V x 5 H + parking lane | 14 |

Scenarios add racks / corridor density (e.g. S02 +1, S03 +2, S09 +2, S13 +3
rack clusters). Robot footprint radius 12 px, safety margin 4 px (total 16 px).
Task stations are the fixed per-tier station lists (`TASK_LOCATIONS_BY_TIER`).

## 3. Fleets

Fleet sizes are **3, 10, 50, 100** only. Spawn points come from
`computeFleetSpawnPoints`. Nominal commanded speed 1.2 (engine units), same
for every system.

## 4. Scenarios

All 14 comparison scenarios run on all three systems. Durations are the
scenario's own (timeline mode `scenario`, section 6).

| ID | Name | Category | Fault / trigger (sim s) | Duration (s) |
|---|---|---|---|---|
| S01 | Normal Warehouse Operation | normal | none | 600 |
| S02 | High Task Load | task allocation (2.5x burst) | task_burst @5 | 600 |
| S03 | High Traffic / Congestion | congestion | congestion @0 | 600 |
| S04 | Crossing / Bottleneck Conflict | congestion (crossing) | crossing_conflict @0 | 300 |
| S05 | Dynamic Obstacle | dynamic obstacles | dynamic_obstacle @30 | 300 |
| S06 | Communication Delay | comm delay (350 ms, 5 % loss) | comm_delay @10 | 600 |
| S07 | Communication Loss | comm delay / loss (1000 ms, 80 % loss) | comm_loss @20 | 600 |
| S08 | Robot Failure | robot failure (R02 or first busy robot) | robot_failure @135 | 600 |
| S09 | Deadlock Scenario | deadlock (cyclic 4-robot wait) | deadlock @0 | 300 |
| S10 | Sensor / Localization Uncertainty | sensor anomaly (0.35 m pose noise) | sensor_noise @15 | 600 |
| S11 | Task Lease Expiry / Reallocation | task allocation (lease expiry) + obstacle | lease_expiry @20 | 600 |
| S12 | Progressive Robot Health Degradation | robot failure (progressive) | health_degrade @30 | 600 |
| S13 | Combined Stress Scenario | combined: comm delay + robot failure + 2x tasks + obstacles | stress_test @30 | 900 |
| S14 | Central Coordinator / Link Failure | comm / infrastructure failure | central_link_failure @60 | 600 |

ACE-only validation tests A01-A12 (`simTestType "aceTest"`, ACE system only,
durations 180-300 s from `ACE_TESTS`) are run at fleets 3, 10, 50 with seed
18427 (`bench/results/baseline_acetests.jsonl`).

## 5. Seeds - what the seed controls

Seeds used: **18427** (dashboard default), **1**, **2**.

Before this work the only consumer of `state.seed` was the adaptive map
generator (`WarehouseMapGenerator.generate`, LCG seeded with `seed + fleet`):
restricted/hazard zone count, size and position, spawn-position shuffle,
pickup/drop/charging zone shuffles. There is no `Math.random` anywhere in
`src/core`; packet loss (`PeerCommunicationBus`, `CentralizedCoordinator`) and
sensor noise (`sensor-sim.js`) use fixed-seed LCGs. So the workload and faults
were identical for every seed.

`core/seeded-workload.js` now makes the seed also drive the workload, applied
identically to all three systems:

- **Generic tasks** (both pickup and destination are task stations of the
  world): seeded pickup/destination pair (never equal) and seeded release
  order; ids, priorities, types and task count are unchanged.
- **Burst tasks** (S02, S13): same treatment.
- **Fault trigger time**: seeded jitter within +-10 % of the scenario's
  trigger time (e.g. S08 135 s -> 121.5 ... 148.5 s).
- **Unchanged by design**: scripted interaction tasks (S03 bottleneck, S04
  crossing, S05 obstacle, S08 T-801/802, S09 deadlock, S11 lease tasks), the
  ACE validation tests, the fault targets, the packet-loss and sensor-noise
  sequences.
- **Identity for seed 18427**: every existing run, test and recorded result is
  reproduced exactly.

So a seed = (map variant from the generator) x (workload variant) x (fault
time variant). Controllers never read the seed.

**Determinism**: the harness records `det_digest`, a SHA-1 over every simulated
outcome (run record without wall-clock timing fields, telemetry, per-task
timeline, message counts). Repeated runs of the same (src, system, scenario,
fleet, seed) produce identical digests, both within one process and across
processes (`node bench/check-determinism.mjs <jsonl>`). Wall-clock values
(`wall_s`, CPU ms/tick, `avgInferenceMs`, `avgPlanMs`, ...) naturally vary.

## 6. Duration / timeline modes

The dashboard caps a run at `min(scenario duration, 90 s x sim speed)` and
compresses the scenario timeline (fault times, degradation rates) by
`limit / duration` (`ScenarioEngine._setTimeline`). The harness offers
(`DURATION` env var):

| Mode | Limit | Timeline | Use |
|---|---|---|---|
| `scenario` (default, used for the baseline) | scenario duration | as specified (scale 1) | benchmark |
| `dashboard` | min(duration, 90 s) | compressed | reproduce the UI exactly |
| `extended` | scenario duration | compressed to 90 s | pattern of tests/traffic-control.test.js |
| `<N>` | N s | compressed to N | custom |

The limit is applied by setting the frozen run limit before the scenario
engine reads it; no controller code is involved.

## 7. Fairness check

For every (scenario, fleet, seed) the harness fingerprints and compares
across the three systems: map (obstacles, waypoints, task stations -> hash,
world profile), robot count, spawn positions and commanded speed, initial and
final task workload (id, pickup, destination, priority, release time),
scheduled fault events, injected-fault timeline (sim time + type) and
duration limit. Differences are printed and stored in `fairness_diffs` of the
JSONL line; `analyze.py` lists them. The fault *target* is not part of the
check: the robot-failure target is "R02 if busy, else the lowest-ID busy
robot", which depends on the system's allocation by design.

Baseline result: all 504 runs identical across systems except S14 (20
comparisons, field `faults`): the "Central Coordinator Failure" is injected
only into the centralized system (the scenario tests architecture
dependency; systems 2/3 have no central server), and only if the run is still
active at the trigger time. This difference is by design.

## 8. Recorded data (one JSON line per run)

`run_id, label, src, kind, system, scenario, fleet_size, seed, configVersion,
timestamp, wall_s, cpu_s, ticks, sim_time_s, duration_limit_s, duration_mode,
timeline_scale, end_reason, verdict`, the recorded run object (`record`:
performance, summary, architectureMetrics, experimentResult verdict), and
harness telemetry collected each tick after `simEngine.update`:

- per robot: distance travelled (px), time moving / waiting / handling / idle /
  failed, stop count (moving -> waiting transitions);
  waiting = not moving while holding a task, parking leg or back-off manoeuvre;
- minimum inter-robot separation (all pairs; pairs with a moving robot);
  near-collision events (pair enters < 2 x total radius = 32 px while one is
  moving), contact events (< 2 x radius = 24 px), near-pair-seconds;
- task timing from the registry: cycle time (release -> complete), allocation
  latency, execution time, assign->start, reassignments, per-task timeline;
- detour ratio per completed task: odometer from assignment to completion /
  Manhattan lower bound (assignment position -> pickup -> destination);
- messages and bytes: peer bus sends by type, robot-originated vs task board,
  JSON bytes, broadcast deliveries (systems 2/3); uplink state reports (bytes
  modelled from the robot state vector JSON) and downlink commands (JSON
  bytes of robot, task, route) for the centralized system;
- ACE envelope time distribution (robot-seconds in LOCAL / NEIGHBORHOOD /
  CONTAINMENT / SAFE-DEGRADED), active sessions and contracts per tick;
- JS time per `update()` call (process.hrtime, observer overhead
  subtracted): mean / median / p95 / max; heap used start / max / end;
- fairness fingerprint and `det_digest`.

Message observers wrap `peerBus.send` and `centralizedCoordinator._applyCommand`
and call the original with the original arguments (counting only).

## 9. Commands to reproduce

```powershell
# single configuration set (PowerShell; bash: SRC=zz-base FLEETS=... npx vitest ...)
$env:SRC="zz-base"; $env:SYSTEMS="centralized,decentralized,ace"; $env:FLEETS="3,10"
$env:SCENARIOS="S01-S14"; $env:SEEDS="18427,1,2"; $env:OUT="bench/results/my.jsonl"; $env:LABEL="my"
npx vitest run --config bench/vitest.config.js

# full baseline matrix, 5 parallel shard processes, merged into one JSONL
node bench/run-matrix.mjs --src zz-base --out bench/results/baseline.jsonl `
  --fleets 3,10,50,100 --scenarios S01-S14 --seeds 18427,1,2 --shards 5 --label baseline
#   --resume continues an interrupted matrix; --max-fleet-seeds 100:2 caps seeds per fleet

# ACE validation tests (ACE only)
$env:SRC="zz-base"; $env:SYSTEMS="ace"; $env:FLEETS="3,10,50"; $env:SCENARIOS="A01-A12"
$env:SEEDS="18427"; $env:OUT="bench/results/baseline_acetests.jsonl"; npx vitest run --config bench/vitest.config.js

# candidate (optimized) tree: same commands with SRC=src / --src src

# analysis
python bench/analyze.py bench/results/baseline.jsonl --md bench/results/baseline_analysis.md --json bench/results/baseline_summary.json
python bench/analyze.py bench/results/baseline_acetests.jsonl --kind aceTest --md bench/results/baseline_acetests_analysis.md

# determinism
$env:SEEDS="18427,18427,1,1"; $env:OUT="bench/results/determinism.jsonl"; npx vitest run --config bench/vitest.config.js
node bench/check-determinism.mjs bench/results/determinism.jsonl
```

`npx vitest run` (the normal suite) does not run the benchmark: the runner is
`bench/bench.run.js`, which only `bench/vitest.config.js` includes. Vitest
cannot run files outside the project directory, so the harness stays in
`bench/`.

## 10. Run cost

Machine: 6-core / 12-thread Windows 11 laptop, Node via vitest 5 (forks pool).

Wall time per run, measured in the baseline matrix (`zz-base`, timeline
`scenario`, 5 shard processes in parallel, so ~1.3-1.5x slower than a lone
process):

| Fleet | centralized | decentralized | ace | worst run |
|---|---|---|---|---|
| 3 | 1.3 s | 1.0 s | 1.1 s | 6 s |
| 10 | 1.8 s | 3.3 s | 4.5 s | 17 s |
| 50 | 6.4 s | 21.8 s | 27.1 s | 66 s |
| 100 | 15.8 s | 92.4 s | 106 s | 255 s (S13, 900 s sim) |

Serial single-process reference at 100 robots (`bench/results/cost_probe.jsonl`,
seed 18427): S01 (600 s sim) centralized 20 s, decentralized 68 s, ace 78 s;
S13 (900 s sim) 27 s / 163 s / 187 s (the probe predates the timeline flag:
its S13 used the `extended` timeline; timing only, not used for results). JS time per 0.1 s tick at 100 robots:
~2.2 ms centralized, ~10-17 ms decentralized, ~12-19 ms ACE.

Full baseline matrix (3 systems x 4 fleets x 14 scenarios x 3 seeds = 504
runs): 198 CPU-process-minutes in total (100 robots: 150 min, 50: 39 min,
10: 7 min, 3: 2.4 min); **47 min wall with 5 shards**. ACE tests A01-A12 at
3/10/50: 36 runs, ~4 min. The runner's `SHARD` balancing is by estimated
cost (fleet^1.6), so 5 shards finish within a few minutes of each other.
Heap stays below ~400 MB per process.

Note: CPU ms/tick values in the matrix are measured under 5-way parallel
load; compare systems within one matrix (same load), and use a serial pass
for absolute CPU numbers.
