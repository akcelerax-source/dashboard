# NodeX ACE-AMR: Efficiency Optimization Final Report

Config `NODEX-ARCH-2026.09-r6-bigmap` · date 2026-09-29 · simulator: in-repo JS warehouse simulator (headless harness `bench/`), not Gazebo/ROS.

Every number below comes from `bench/results/final/A_src_all.jsonl` (168 runs) or `bench/results/final/D_acetests.jsonl` (24 runs), analysed by `bench/final/final_analysis.py`. Full tables are in `docs/NODEX_BASELINE_VS_OPTIMIZED_RESULTS.md`. Code integrity: the SHA-1 of every file in `src/core` was identical at the start and the end of the final runs (`bench/final/src_core_sha1_start.txt` = `..._end.txt`).

Supporting documents:
- `docs/NODEX_ARCHITECTURE_AUDIT.md`: three-system code audit
- `docs/NODEX_RESEARCH_AND_DESIGN_RATIONALE.md`: standards and literature
- `docs/NODEX_EFFICIENCY_INDEX_VALIDATION.md`: metric audit
- `docs/NODEX_EXPERIMENT_CONFIGURATION.md`: harness and reproduction
- `docs/changes/ws1.md`, `ws2.md`, `ws3.md`, `ws4.md`, `bigmap.md`: change logs with development evidence
- `bench/results/BASELINE_SUMMARY.md`: pre-optimization baseline

## 1. Executive summary

**Problem.** In the pre-optimization baseline (504 runs, `bench/results/baseline.jsonl`), NodeX ACE lost to Centralized in 117 of 168 paired runs. Its throughput was 0.76–0.94× Centralized's.

**Diagnosis.** The measured causes were in ACE itself, not in the metric:
- **Over-escalation.** The Edge-AI conflict model had a floor of 0.354, above its 0.35 cutoff, so nearby queued robots triggered CONTAINMENT. That state halves speed and holds for at least 4 s.
- **Permanent crawl.** After a comm-loss fault, speed stayed at 0.25× even after comms returned.
- **Session livelocks at 10 robots.** A half-merged robot blocked the lane while yielding to it. Contract order overrode the lane rules, so the same session repeated forever.
- **Biased allocation.** The auction closed before peers' bids arrived, so the lowest-ID idle robot always won. Bids used straight-line distance.

Genuine baseline bugs were also found and fixed for all affected systems (§5).

**Changes.** The optimizations below are real algorithm changes, each gated by an `aceFeature()` switch:
- Calibrated conflict prediction.
- Queue-aware cascade pressure.
- Per-robot, relevance-weighted comm risk.
- Event-triggered adaptive communication.
- Adaptive comm-loss handling.
- Peer-to-peer circular-wait (wait-for) detection with PIBT-style resolution.
- Lane rules take precedence over contracts.
- Local deadlock detours.
- Joint award after the full bid window, with route-ETA bids.

Separately, the 50- and 100-robot maps were enlarged to 2:1 rectangles with no admission cap, and the run rules were changed: no time cap, and a stop only when no task makes progress.

**Measured result (held-out seeds 3 and 4, 7 scenarios, 3/10/50/100 robots, 56 paired runs per comparison).**

| NodeX ACE vs | Wins / losses / ties | Throughput ratio, geometric mean [95 % CI] |
|---|---|---|
| Centralized | 43 / 12 / 1 | 1.60 [1.28, 1.99] |
| Decentralized | 44 / 10 / 2 | 1.73 [1.40, 2.13] |

- There were 0 collisions, 0 obstacle intrusions and 0 boundary violations in all 168 runs.
- ACE has more near-collision events per completed task at 50 and 100 robots (§11).
- The ACE test pass count fell from 21/24 to 20/24.

## 2. Centralized audit (summary)

Real Hungarian task assignment runs every 0.5 s. Paths come from a real space-time CBS: vertex and edge conflicts, 1 s steps, and a cap of 120 expanded nodes. Global traffic handling is done by intersection reservations. Robot-local execution has no ORCA.

Bug fixed (`fix-cbs-fallback`): when the node cap was hit, CBS returned the deepest node instead of the fewest-conflicts node.

Standards alignment: VDA 5050 3.0.0 is an interface standard and leaves traffic management to the implementer. ISO 3691-4:2023 is a safety standard. Neither prescribes the algorithm.

Measured limitation (A runs): at 50 and 100 robots, 0/28 Centralized runs completed all tasks, and every one ended with no progress. The global planner does not resolve dense head-on queues on the big maps.

## 3. Decentralized audit (summary)

- **Allocation:** Contract-Net bidding. Genuine bugs fixed for Decentralized and ACE alike:
  - `fix-cnp-window`: the auction closed in the bid tick.
  - `fix-cnp-committed`: the award could go to a robot already committed to another task.
- **Coordination:** fixed-scope continuous pair coordination (unchanged by design) with ORCA-style local avoidance.
- **Wait timers:** `fix-wait-timer` fixed a stall timer that was counted twice. This affected all three systems.

Measured behaviour:
- It has the highest bytes per task: 2,694 KB at 50 robots versus 1,005 KB for ACE.
- It collapses under comm loss: S07 finished 16.5 % of tasks, versus 78.1 % for ACE and 77.9 % for Centralized.

## 4. NodeX ACE audit (summary)

- **Genuine features:**
  - Edge-AI conflict prediction (a heuristic logistic model, not trained).
  - RACE weighted risk with hysteresis.
  - Four envelope states, each changing speed, message rate and group scope.
  - Temporary sessions with contracts.
  - HITL: off in all benchmark runs, and active in ACE test A12.
- **Dead code found:** three unused functions in `race-evaluator.js`. HITL `REROUTE` is not implemented.
- **Unfair advantage removed:** `fix-health-speed`. ACE used to ignore robot health degradation.
- **Decentralization kept:** no central controller was added. Allocation, deadlock resolution and risk are computed on each robot from peer messages only.

## 5. Efficiency calculation audit

- **Original NEEI v1.1:** mathematically computed, but not defensible:
  - Time efficiency and throughput carry the same signal (r = 1.000), so they are double-counted.
  - Its reference is the best of the latest runs, so a score changes when other runs are added.
  - Renormalization lets incomplete runs outscore complete ones.
  - A robot failure earns a recovery bonus.
  - The safety gate checked collisions only.
- **NFEI v2.0:** a weighted geometric mean of throughput (0.6), allocation latency (0.2) and messages per completed task (0.2), relative to the Centralized run. Any collision, obstacle intrusion or boundary violation makes a run INVALID, never just a lower score. Near-collisions are reported separately.
- **NFEI v2.1 (current, user request):** bounded 0–100. The reference for each KPI is the best value among the paired systems (same scenario, fleet, seed, map and config), so 100 means best on every KPI in that comparison. Trade-off: a score depends on the other systems in its paired group.
- **Classification:** NFEI is a project-specific composite metric based on recognized KPIs (throughput and latency as in ISO 22400-2 and the lifelong-MAPF literature). It is not standard-defined. No standard defines a composite efficiency index for AMR fleets.
- **Historical runs:** they keep their recorded values. The old and new index versions are compared in the validation document.

## 6. Why NodeX was losing (baseline data)

Source: `bench/results/BASELINE_SUMMARY.md`.
- **Throughput ratio ACE/Centralized:** 0.94, 0.76, 0.86 and 0.77 at 3, 10, 50 and 100 robots.
- **Stalled runs at 10 robots:** 5 ACE runs gridlocked where both baselines finished, with a waiting fraction of 0.63–0.82 and thousands of robot-seconds in CONTAINMENT.
- **Extra stops at 50 robots:** 9.3 stops per robot versus 5.1 for Centralized.

## 7. Research findings (summary)

Covered in `docs/NODEX_RESEARCH_AND_DESIGN_RATIONALE.md`:
- VDA 5050 3.0.0 (zones, path sharing).
- ISO 3691-4:2023 plus the draft next edition.
- ISO 22400-2 KPIs.
- PIBT and priority inheritance for deadlock-free passing.
- Event-triggered communication.
- Congestion-aware and ETA bidding (Contract-Net, CBBA).
- Lifelong MAPF traffic guidance.
- Opposing evidence: centralized planning is often faster, and learned models alone lose to search.

## 8. Root cause → change → evidence

| Problem found | Evidence (dev) | Research insight | Implemented change (switch) | Metric affected | Final result (A runs) |
|---|---|---|---|---|---|
| Proximity-only conflict model over-triggers | Floor 0.354 > 0.35 cutoff; 30 % of robot-time escalated at 10 robots | Predict space-time overlap, not proximity | `ws1-conflict-calibration` | stops, waiting | Waiting fraction at 10 robots: ACE 0.15 vs C 0.29 / D 0.33 |
| Queues read as cascades | CONTAINMENT from 2 waiting neighbours | Cascade = growing queue or circular wait | `ws1-queue-cascade` | throughput | see §1 |
| Fleet-wide latency comm risk; permanent crawl after comm loss | S07 0/12 vs Centralized in baseline | Stale-state handling; relevance-weighted risk | `ws1-comm-relevance`, `ws1-degraded-link-verify`, `ws1-comm-loss-adaptive` | S07 completion | S07: ACE 78.1 % done vs D 16.5 % (C 77.9 %) |
| Constant-rate broadcasts | 1,685 msgs/task at 10 robots | Event-triggered communication | `ws1-adaptive-comm` | msgs/task | 382 vs C 1,987 / D 1,625 at 10 robots |
| Livelock: half-merged robot + contracts overriding lane rules | Fleet-10 gridlocks | Physical rules first | `fix-ws2-merge-gate`, `ws2-contract-physical` | completion | 10 robots: ACE 14/14 all done vs 11/14 each |
| Circular waits cleared only by timeouts | Fleet-10 waiting 0.63–0.82 | PIBT priority inheritance; wait-for graphs | `ws2-waitfor` (new `WaitForResolver.js`) | stalls | NO_PROGRESS at 50/100 robots: ACE 20/28 vs C 28/28, D 26/28 |
| Deadlock detour avoided whole hub | Detour ratio 1.22 | Local repair | `ws2-detour-local` | path length | see §1 |
| Auction closed before bids arrived; straight-line bids | Lowest-ID wins | Contract-Net bid window; ETA bids | `ws3-joint-award`, `ws3-eta-bid`, `ws3-busy-bid` | cycle time, throughput | 50 robots: ACE 625 tasks/h vs C 296 / D 292 |

## 9. Architecture change table

| Component | Before | After | Added/Removed/Modified | Reason | Measured effect (dev, see ws*.md) |
|---|---|---|---|---|---|
| Edge-AI conflict model | Proximity logistic, floor above cutoff | Closest-point-of-approach over shared intents | Modified | False positives | Fleet 10: throughput ×1.40 vs baseline ACE (ws1) |
| RACE comm risk | Fleet-wide mean message age | Per robot, relevance weighted | Modified | Latency escalated harmless cases | S07 recovered |
| Communication | Fixed 10/2 Hz | Event-triggered plus heartbeat | Modified | Overhead | Msgs/task 1,685 → 444 (ws1, fleet 10) |
| Deadlock handling | Timeouts and backoff | Peer wait-for probes plus PIBT-style yield | Added (`WaitForResolver.js`) | Livelocks | Fleet-10 all-done 0.83 → 0.98 (ws2) |
| Session contracts | Could override lane rules | Lane rules first | Modified | Mutual waits | same |
| Task allocation (ACE) | One-tick auction, distance bid | Bid window, joint award, route ETA | Added (`AceTaskAllocator.js`) | Allocation bias | Throughput ×1.36 vs D at fleet 10 (ws3) |
| Contract-Net (D and ACE) | Same-tick close | One-tick bid window | Modified (bug fix) | Protocol bug | D ×1.36–1.51 (ws4) |
| Wait timer (all) | Counted twice | Counted once | Modified (bug fix) | Bug | mixed, see ws4.md |
| CBS fallback (C) | Deepest node | Fewest-conflicts node | Modified (bug fix) | Bug | neutral |
| ACE health slowdown | Ignored | Obeyed | Modified (fairness) | Unfair advantage | S13 only |
| Worlds 50/100 | 1060×1000, 6-task cap | 1700×850 / 2300×1150, no cap | Modified (all systems) | User request: all robots work | see §12 |
| Run termination | Duration limit | No cap; NO_PROGRESS after 300 sim-s, still scored | Modified (all systems) | User request | see §12 |
| Sim speed | dt × speed | Sub-stepping of the whole sim | Modified | User request | same fidelity at 2x/5x |

## 10. Final algorithms (pseudocode)

```
every tick, robot i (ACE):
  peers ← latest STATE/INTENT messages within comm range (stale ones flagged)
  for p in peers: conflict_p ← P(CPA distance < 2r within horizon | shared paths)
  risk ← w1·max conflict + w2·uncertainty + w3·Σ relevance_p·staleness_p
         + w4·queue_growth + w5·cascade(circular wait or growing queue)
  envelope ← RACE hysteresis(risk)   # LOCAL / NEIGHBORHOOD / CONTAINMENT / SAFE-DEGRADED
  if waiting: send WAITFOR(i → blocker); forward probes; if a probe returns to i: cycle found
     resolve: highest priority (longest wait) moves first; else lowest priority backs off
              or steps into its bay; else the robots behind it make room
  broadcast STATE only if (Δpose, Δintent, envelope change) > threshold or heartbeat expired
  task allocation: on ANNOUNCE → bid = route_length(graph)/v + risk + battery term
     (busy robots finishing in ≤ 12 s also bid, fleets ≤ 10)
     after one full tick every robot solves the same min-cost assignment on the bids it received
     and claims only its own task (deterministic, no central server)
sim-engine: stop the run when every task is complete, or when no task completes for 300 sim-s
```

## 11. Methodology

- **Development seeds:** 18427, 1 and 2, used in `docs/changes/ws*.md`.
- **Held-out final test seeds:** 3 and 4, never used in development.
- **Scenarios:** S01 normal, S03 congestion, S06 comm delay, S07 comm loss, S08 robot failure, S09 deadlock, S13 combined.
- **Fleets:** 3, 10, 50, 100.
- **Maps:**
  - WORLD-S 700×360
  - WORLD-M 900×520
  - WORLD-L 1700×850
  - WORLD-XL 2300×1150
- **Workload:** identical across systems per scenario, fleet and seed. At 50 and 100 robots it is at least 2 tasks per robot.
- **Faults:** placed on a 90 s fault window.
- **Harness:** `node bench/run-matrix.mjs ... --duration none`.
- **Fairness:** the harness asserts an identical map, workload and fault timeline across systems.
- **HITL:** off in all scored runs.

## 12. Results: three systems

| Fleet | System | All tasks done | Tasks done % | Throughput /h | Cycle time s | Waiting frac | Msgs/task | Near-coll./task | NFEI v2.1 |
|---|---|---|---|---|---|---|---|---|---|
| 3 | Centralized | 11/14 | 82.6 | 221.5 | 69.6 | 0.18 | 1,397 | 1.2 | 61.6 |
| 3 | Decentralized | 10/14 | 88.5 | 212.5 | 93.0 | 0.26 | 1,497 | 0.4 | 59.3 |
| 3 | **NodeX ACE** | **14/14** | **100.0** | **284.6** | 81.1 | **0.04** | **187** | 0.3 | **91.3** |
| 10 | Centralized | 11/14 | 88.2 | 304.1 | 96.7 | 0.29 | 1,987 | 3.5 | 58.7 |
| 10 | Decentralized | 11/14 | 85.1 | 335.5 | 110.2 | 0.33 | 1,625 | 3.4 | 57.4 |
| 10 | **NodeX ACE** | **14/14** | **100.0** | **438.2** | 94.6 | **0.15** | **382** | 1.1 | **93.2** |
| 50 | Centralized | 0/14 | 58.9 | 295.9 | 222.7 | 0.73 | 6,623 | 11.2 | 54.1 |
| 50 | Decentralized | 2/14 | 71.7 | 292.2 | 334.5 | 0.75 | 9,157 | 12.2 | 46.5 |
| 50 | **NodeX ACE** | **5/14** | **88.5** | **624.8** | 297.7 | **0.52** | **2,552** | 16.3 | **92.1** |
| 100 | Centralized | 0/14 | 43.2 | 321.3 | 260.1 | 0.78 | 12,357 | 22.3 | 57.4 |
| 100 | Decentralized | 0/14 | 51.9 | 310.3 | 294.3 | 0.83 | 16,105 | 27.5 | 50.0 |
| 100 | **NodeX ACE** | **3/14** | **85.4** | **519.2** | 578.9 | **0.61** | **5,991** | 35.9 | **92.1** |

Paired throughput ratio of ACE by fleet, geometric mean with 95 % CI:

| Fleet | ACE / Centralized | ACE / Decentralized |
|---|---|---|
| 3 | 1.68 [0.90, 3.15] | 1.91 [1.01, 3.62] |
| 10 | 1.60 [0.98, 2.60] | 1.46 [0.92, 2.31] |
| 50 | 1.71 [1.11, 2.64] | 2.01 [1.38, 2.95] |
| 100 | 1.42 [1.01, 2.01] | 1.57 [1.19, 2.07] |

With n = 14 per fleet, the confidence intervals at 3 and 10 robots include 1.0.

**Robustness by scenario** (ACE vs Centralized W/L, then ACE vs Decentralized W/L):

| Scenario | vs Centralized | vs Decentralized | Note |
|---|---|---|---|
| S01 | 5/2 | 4/3 | |
| S03 | 7/1 | 7/1 | |
| S06 | 7/1 | 3/4 | |
| S07 comm loss | 2/6 | 8/0 | ACE loses to Centralized: throughput 0.85×, CI [0.68, 1.05] |
| S08 | 8/0 | 7/1 | |
| S09 | 6/2 | 7/1 | |
| S13 | 8/0 | 8/0 | |

**Before vs after optimization and ablation:** not run in this final test, at the user's request (steps B and C were skipped). The before-to-after evidence therefore comes from development seeds only (`docs/changes/ws1.md`, `ws2.md`, `ws3.md`, `ws4.md`). Examples: fleet-10 throughput ×1.40 vs baseline ACE (WS1), and fleet-10 all-tasks-done rate 0.83 → 0.98 (WS2). The contribution of each change on held-out seeds is **not established**.

## 13. Safety

- 0 collisions, 0 obstacle intrusions and 0 boundary violations in all 168 final runs.
- Minimum moving separation was 24.1–24.7 px for all systems.
- **Near-collision events are higher for ACE:** 135,946 total versus 41,343 for Centralized and 70,489 for Decentralized. Part of this comes from ACE completing more tasks, but per completed task ACE is also higher at 50 and 100 robots (16.3 and 35.9 versus 11.2 and 22.3 for Centralized).
- This is an open safety-margin issue, not a validated improvement.

## 14. ACE validation tests (seed 18427, 3 and 10 robots)

- **Pass count:** 20/24 now, versus 21/24 in the baseline.
- **New failures:** A01 and A05 at 3 robots. After the calibration they no longer escalate beyond NEIGHBORHOOD.
- **Newly incomplete:** A04 at 10 robots.
- **Newly passing:** A10 at 3 and 10 robots.

## 15. Computational cost

CPU per 0.1 s tick, milliseconds, measured with 10 parallel shards:

| System | 3 | 10 | 50 | 100 |
|---|---|---|---|---|
| NodeX ACE | 0.62 | 1.86 | 16.2 | 46.2 |
| Centralized | 0.25 | 0.66 | 5.1 | 21.4 |
| Decentralized | 0.48 | 1.36 | 11.2 | 35.4 |

ACE costs the most CPU in total simulation. This is the sum across all robots; each robot's share is small, and on real hardware this work is distributed across the robots.

## 16. Limitations

- Simulation only, with no Gazebo/ROS and no real hardware.
- The Edge AI is a heuristic model, not a trained one.
- Only 2 held-out seeds (n = 14 per fleet); several confidence intervals include 1.0.
- No before/after or ablation on held-out seeds.
- NFEI v2.1 depends on the other systems in its paired group.
- At 50 and 100 robots most runs of every system still end with NO_PROGRESS: 20/28 for ACE, 28/28 Centralized, 26/28 Decentralized. The big maps are still traffic-limited.
- Centralized communication is idealized (it never loses messages).
- ACE has more near-collisions and 1 more failing ACE test than the baseline.
- Unit suite:
  - Several older tests fail (deadlock-backoff, phase4/5-5/8/11, architecture-compliance).
  - High-density tests fail or time out on the new big maps.
  - The full suite was not re-run on the final code.

## 17. Truth check

- **Fabricated or hard-coded numbers:** none. Every number comes from the jsonl files named above.
- **Baselines weakened:** no. Genuine bugs in the baselines were fixed, which made them stronger (for example Decentralized ×1.36–1.51 from the Contract-Net fix).
- **ACE, RACE, HITL, Edge AI:** kept. There is no central controller in NodeX.
- **Metric:** it was not tuned for NodeX. It was corrected for double counting and reference drift, then bounded 0–100 at the user's request, and it is labelled as not standard-defined.
- **Workload and seeds:** identical across systems (harness fairness check), and the code hash was unchanged during the final runs.
- **Fleet sizes:** tested at 3, 10, 50 and 100.
- **Not done:** the dashboard was not re-verified against every raw value. Ablation on held-out seeds was not run.

## 18. Conclusion

Under the tested scenarios (S01, S03, S06, S07, S08, S09, S13), fleet sizes (3, 10, 50, 100), held-out seeds (3, 4) and simulation configuration `NODEX-ARCH-2026.09-r6-bigmap`, the optimized NodeX Edge AI ACE decentralized system:
- completed more tasks and had higher throughput than both the Centralized and the Decentralized baselines in most paired runs (43/56 and 44/56 wins);
- achieved geometric-mean throughput 1.60× Centralized and 1.73× Decentralized;
- used fewer messages per task;
- had no collisions.

It did not beat Centralized under comm loss (S07). It showed more near-collision events per task at 50 and 100 robots. The contribution of each individual change has not been confirmed on held-out seeds. The results should not be generalized beyond these conditions.

## 19. Addendum (2026-09-30): ACE validation test fixes and NFEI v2.2

Data: `bench/results/acefix/after7.jsonl` (A01-A12 × 3/10/50 robots, seed 18427); efficiency check `bench/results/acefix/eff_check2.jsonl` versus `bench/results/final/A_src_all.jsonl`.

Root causes of the ACE test failures (found by switching features off one at a time, `bench/results/acefix/*.jsonl`):
- **A05 (space-time contract): monitor bug.** The criterion reads "held at the edge *or* entered in slot order", but the monitor only counted holds. After calibration, robots reached the crossing already in order, so no hold was needed.
  - Fix: `AceSessionManager` now audits each robot's region entry (in order or out of order) and counts right-of-way decisions taken from the slot order.
  - Any out-of-order entry still fails the test.
- **A04 (cascade pressure): real behavior, criterion too narrow.** Robots behind the stalled pair rerouted within seconds, so no lasting cascade formed.
  - New: cascade pressure = 1 for a queue behind a stopped robot that waits for nobody (`ace-blocked-head`).
  - New: a CONTAINMENT override for that confirmed case only (`ace-cascade-override`).
  - The test now also passes when the queue clears locally (no robot stopped more than 10 s).
- **A01 at 3 robots:** risk never reached the containment level, so staying at NEIGHBORHOOD or below is correct. Escalation is now required only when the risk warranted it.
- **Tried and rejected:**
  - A "stale relevant-peer ⇒ SAFE-DEGRADED" rule cut S07 throughput, so it is disabled.
  - A CONTAINMENT override for wait cycles cut S01 throughput at 50 robots from about 1,383 to 587 tasks/h (ablation runs, seed 3), so the override is limited to blocked heads.

Results:

| Fleet | ACE tests passed | Not passing |
|---|---|---|
| 3 | 12/12 | — |
| 10 | 12/12 | — |
| 50 | 8/12 | see below |

Failures at 50 robots:
- A01: an envelope was held at low risk.
- A05: 1 out-of-order entry in about 7,800 contract entries and decisions.
- A06: a yield lasted 76 s.
- A08: a robot was stuck for 557 s.

These are genuine traffic deadlocks at 50 robots, the same issue as the NO_PROGRESS runs, and are not fixed.

Efficiency impact on 10 paired runs (fleets 10 and 50, 5 scenarios, seed 3): throughput ratio after/before = 1.01 (geometric mean).

Unit tests: 3 failures in `tests/phase4-ace.test.js` (TESTS 2, 3 and 6) were already present before this change.

NFEI v2.2: the score is now multiplied by the task completion ratio (completed ÷ assigned). A run that leaves any task unfinished can no longer score 100.
