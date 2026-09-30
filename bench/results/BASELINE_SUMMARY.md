# NodeX baseline benchmark summary (zz-base, pre-optimization)

Data: `bench/results/baseline.jsonl` (504 runs = 3 systems x fleets {3, 10, 50, 100}
x S01-S14 x seeds {18427, 1, 2}, timeline mode `scenario`), ACE tests in
`bench/results/baseline_acetests.jsonl` (A01-A12 x {3, 10, 50}, ACE only).
Full tables: `baseline_analysis.md`, machine-readable: `baseline_summary.json`.
Configuration and reproduction: `docs/NODEX_EXPERIMENT_CONFIGURATION.md`.

- Determinism: 70+ repeated configurations (same seed twice, in-process and
  across processes, fleets 3/10/50, S01/S07/S08/S13 plus the baseline itself):
  0 digest mismatches.
- Fairness: identical map, spawn/speed, workload, fault timeline across
  systems for every (scenario, fleet, seed); sole difference S14, where the
  central-server failure only exists in the centralized system (by design).
- Errors: 0. Collisions (footprint contact, physics monitor): 0 in all 504 runs.

## Headline by fleet size (all scenarios pooled, mean over 42 runs)

| Fleet | System | All tasks done (runs) | Tasks done | Throughput / sim h | Cycle time s | Waiting frac of busy | Stops / robot | Msgs / task | KB / task | Near-coll. | CPU ms/tick |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 3 | centralized | 93 % | 98.1 % | 256 | 71 | 0.12 | 5.9 | 604 | 59 | 2.7 | 0.13 |
| 3 | decentralized | 100 % | 100 % | 250 | 71 | 0.07 | 7.3 | 410 | 132 | 1.5 | 0.23 |
| 3 | ace | 100 % | 100 % | 239 | 75 | 0.05 | 10.0 | 411 | 135 | 1.3 | 0.29 |
| 10 | centralized | 90 % | 98.7 % | 306 | 101 | 0.22 | 17.7 | 1,619 | 155 | 31 | 0.31 |
| 10 | decentralized | 90 % | 95.4 % | 277 | 117 | 0.32 | 25.4 | 1,800 | 562 | 32 | 0.83 |
| 10 | ace | 83 % | 97.3 % | 255 | 113 | 0.28 | 22.3 | 1,685 | 560 | 38 | 1.05 |
| 50 | centralized | 67 % | 83.5 % | 363 | 192 | 0.18 | 5.1 | 6,888 | 637 | 46 | 0.92 |
| 50 | decentralized | 52 % | 75.1 % | 288 | 201 | 0.19 | 6.5 | 10,766 | 2,216 | 33 | 3.58 |
| 50 | ace | 60 % | 79.0 % | 312 | 210 | 0.11 | 9.3 | 6,457 | 1,532 | 64 | 4.82 |
| 100 | centralized | 29 % | 65.3 % | 369 | 226 | 0.16 | 3.1 | 14,126 | 1,301 | 54 | 2.24 |
| 100 | decentralized | 29 % | 58.3 % | 304 | 225 | 0.15 | 3.5 | 67,243 | 9,673 | 32 | 15.2 |
| 100 | ace | 21 % | 58.5 % | 291 | 239 | 0.10 | 5.5 | 23,607 | 4,275 | 82 | 17.6 |

Centralized messages = per-tick uplink state reports + downlink route
commands; decentralized/ACE = robot-originated peer messages (bytes are JSON
sizes). CPU ms/tick was measured with 5 shards in parallel.

## Paired comparison (same scenario, fleet, seed); ACE wins / losses / ties

Outcome = more tasks completed, then shorter completion time (1 % band).

| Fleet | ACE vs centralized | ACE vs decentralized | Throughput ratio ACE/central (geo-mean) | ACE/decentral |
|---|---|---|---|---|
| 3 | 19 / 23 / 0 | 14 / 14 / 14 | 0.94 | 0.94 |
| 10 | 15 / 27 / 0 | 17 / 22 / 3 | 0.76 | 0.93 |
| 50 | 9 / 30 / 3 | 26 / 9 / 7 | 0.86 | 1.15 |
| 100 | 5 / 37 / 0 | 15 / 17 / 10 | 0.77 | 1.03 |
| all | 48 / 117 / 3 | 72 / 62 / 34 | | |

By scenario (12 paired runs each):

- **ACE loses to centralized everywhere except** S02 high task load (7/5) and
  S08 robot failure (9/3). Clean sweeps for centralized: S01 normal (0/12),
  S06 comm delay (0/12), S07 comm loss (0/12), S09 deadlock (0/12).
  Largest gaps: S01 at 10 robots (throughput 143 vs 314 /h, one seed gridlocks
  at 7/10 tasks), S06 (132-354 vs 264-463 /h), S03 at 100 (138 vs 480 /h, 92 %
  done), S07 (126-241 vs 232-328 /h), S09 (137-270 vs 209-303 /h).
- **ACE vs decentralized**: ACE wins S07 comm loss (11/1: 58 % vs 19 % done at
  50, 32 % vs 6 % at 100), S03 congestion (9/3), S02 (9/2), S04 (7/3), S12 and
  S14 (7/5); loses S13 combined stress (0/12), S06 comm delay (1/11) and S01
  (3/8). S11 is a 12-way tie (lease scenario is scripted).

## Most telling telemetry differences

- **Waiting vs throughput paradox**: ACE has the lowest waiting fraction at
  every fleet >= 50 (0.10-0.11 vs 0.15-0.19) yet lower throughput than
  centralized and longer task cycle time (210/239 s vs 192/226 s at 50/100).
  ACE robots keep moving but slower / longer (distance per robot 1,220 vs 1,100
  px decentralized at 50; detour ratio 1.22 vs 1.16) and stop more
  (9.3 vs 5.1 stops/robot at 50; 5.5 vs 3.1 at 100).
- **Small-fleet gridlocks**: 7 ACE runs at 10 robots end on the duration limit;
  in 5 of them both other systems finish the same workload (S01, S06, S08, S10, S13):
  waiting fraction 0.63-0.82 and thousands of robot-seconds in CONTAINMENT
  (e.g. S10 seed 1: 2,507 robot-s CONTAINMENT, 7/11 tasks).
- **Envelope activity peaks at 10 robots**: robot-time in LOCAL 84 % (3),
  70 % (10), 89 % (50), 94 % (100); NEIGHBORHOOD+CONTAINMENT 26 % at 10 vs
  5-9 % at 50/100. Sessions initiated per run: 6 / 87 / 158 / 172; mean active
  sessions ~1.1-1.3 at >= 10 robots; replans 269-334 per run.
- **Near-collisions**: ACE has the most safety-margin intrusions at 50/100
  (64 and 82 events vs 46/54 centralized, 32/32 decentralized) with very wide
  spread (+-52/63), i.e. a few scenarios dominate; minimum moving separation
  ~30 px for all (contact threshold 24 px), no contacts.
- **Messages**: ACE sends 1/3 of the decentralized messages per task at 100
  robots (23.6 k vs 67.2 k; 4.3 MB vs 9.7 MB per task) but 1.7x the
  centralized total (14.1 k). At 3-10 robots ACE ~ decentralized. STATE_UPDATE
  and INTENT_UPDATE broadcasts dominate peer traffic.
- **CPU**: ACE costs the most JS time per tick (0.29 / 1.05 / 4.8 / 17.6 ms at
  3/10/50/100) vs centralized 0.13 / 0.31 / 0.92 / 2.2 ms; decentralized is
  ~15-25 % cheaper than ACE. ACE never beat centralized on CPU in any paired run.

## ACE validation tests (A01-A12, ACE only, seed 18427)

PASS 33 / 36: fleet 3: 10 PASS, A04 INCOMPLETE, A10 FAIL; fleet 10: 11 PASS,
A10 FAIL; fleet 50: 12 PASS (verdicts by the ACE test monitor criteria; at 50
robots no test completes its task set within 180-300 s, the criteria still pass).
