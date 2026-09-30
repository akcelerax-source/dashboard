# WS1 changes (RACE calibration, Edge AI, envelope, comm) — zz-ws1

All gated; NODEX_ABLATE=all reproduces baseline digests (S01/S06/S07 n=10 checked, e.g. S06/10/2 a5f3dca9).

| Flag | Component | Old | New |
|---|---|---|---|
| ws1-conflict-calibration | EdgeAiPredictor, RobotAgent.computeRaceInputs | logistic floor p>=0.354 for any neighbour; sensor proximity + self-wait = conflict | path/intent CPA over 3 s; conflict only head-on/crossing/stagnant (>=5 s) leader; following/queue not conflict; self-wait only after 5 s stall |
| ws1-queue-cascade | EdgeAiPredictor | Q = waiting/2 level; CP = shared-waypoint count (route start, buggy) | Q = growth (+level only if stagnant, involved); CP = local wait-for chain / cycle |
| ws1-comm-relevance | EdgeAiPredictor | fleet mean age/2500 | per-robot max staleness of relevant neighbours vs advertised heartbeat |
| ws1-degraded-link-verify | EdgeAi, race-evaluator | comm_loss flag -> SAFE-DEGRADED 0.25 forever | forced SD until fresh post-fault msgs from sensed peers; 4 s dwell from entry |
| ws1-adaptive-comm (+ws1-comm-loss-adaptive) | RobotAgent broadcast/inbox | STATE+full INTENT 4/10/2 Hz fixed | event-triggered STATE (move 6.6/2.6 px, state change), heartbeat 1000/500/250 ms, shortened by measured seq-gap loss; INTENT on route change / 4 hb |

Reverted: ws1-envelope-clear-path (CONTAINMENT/SD speed when lane clear) — ablation on 42 runs n=10 showed no gain (1.37 vs 1.40 geo thr ratio), noisy near-collisions.

## Measured (bench/results/ws1_v2_f10.jsonl, 42 runs n=10, all S01-S14 x 3 seeds)
Thr geo ratio vs baseACE 1.40, vs DEC 1.31, vs CEN 1.07; W/L/T vs CEN 19/23/0 (base 15/27). Done 99.7 % (base 97.3). Msgs/task 444 (base 1685), KB/task 174 (560). Near 37.4 (base 37.6). Ablation (ws1_abl_*_f10.jsonl): removing queue-cascade 1.08, adaptive-comm 1.15, comm-relevance 1.25, conflict-cal 1.33, link-verify 1.32.

Final (ws1_final.jsonl, S01,S06,S07,S13 x n10,50 x seeds 1,2): n10 thr ratio A/D/C 2.55/2.05/1.15, W/L vs CEN 4/4; n50 1.33/1.52/1.11, 4/4. Msgs/task n50 3987 vs CEN 5657. 0 collisions/contacts/intrusions.

## Regressions
- Near-collisions n50 281 vs baseACE 206 (S07 n50 ~1000-1400; oscillating turn-back/reroute livelocks near failed/head-on robots, WS2 logic, exposed as flows unblock).
- ACE tests (ws1_acetests.jsonl) 20/24 PASS: A01/3 (no escalation beyond NEIGHBORHOOD: fewer false conflicts) and A05/3 (0 contract holds) regress; A10/10 now PASS. n=10 all 12 PASS except none.
- tests/phase4-ace TEST 7 (stale single peer -> commRisk>0.5) may fail: relevance-weighted.
