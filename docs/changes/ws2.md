# WS2 — ACE sessions, deadlock recovery, detours

Bench: `bench/ws2/results/*.jsonl` (compare `bench/ws2/cmp.py`, diag `bench/ws2/stall.diag.js`).
Diagnosis (stall classifier): 10-robot gridlocks were NOT slot holds (contract holds 2-10 robot-s/run) but
circular waits through physics: a bay robot stopped half-merged at 29-30 px from the lane (isOffLane=29 px
vs separation guard 30 px) blocks lane traffic while yielding to it ("Merging AMR yields"); contract order
then overrides lane rules, sessions reopen with same order -> livelock.

| ID | Component | Change | Effect |
|---|---|---|---|
| fix-ws2-merge-gate | RobotAgent mayEnter / _rightOfWay | bay gate + "in bay" use the 30 px separation band (bug shared by dec+ace; decentralized impact not yet re-measured) | removes half-merge wedge (S06/S10 s1-2 gridlocks) |
| ws2-contract-physical | AceSessionManager.decide | contract never overrides lane-leader / merging / holds-intersection | fewer mutual waits |
| ws2-waitfor | new ace/WaitForResolver.js + hooks | edge-chasing wait-for probes (yield/contract/block/node/corridor/merge/hold edges) over peer bus; lowest-id member resolves: longest-waiting voluntary waiter proceeds (PIBT priority), else least-waited backs off (retreat / turn-back / bay step-back), else PIBT push (followers make room); lane realign when stuck straddling lane edge | gridlocks 7->1 of 42 at fleet 10 |
| ws2-detour-local | recoverFromDeadlock | avoid only the contested edge, not whole contract hub | thr 10: 300.8->313.3, near 32.6->26.6 |

Tried/reverted: ws2-detour-cap (decline detour > lane+100 px): fleet-10 completion 0.98->0.90 (c7.jsonl). Slot-hold PIBT ordering (suspect 1) not implemented: holds measured negligible.

Measured (mean, vs baseline ace/dec/cen):
- Fleet 10, S01-S14 x seeds 1,2,18427 (c8.jsonl): all-done 0.98 (0.83/0.90/0.90); thr 313 (255/277/306); makespan 188 s (265/233/211); stops 22.7 (22.3/25.4/17.7); near 26.6 (37.6/32.3/31.2); W/L vs ace 24/13, dec 24/9, cen 21/19.
- Fleet 50, S01-S14 x 1,2 (c8_50.jsonl): thr 343 (327/303/369); stops 8.6 (9.0/6.3/5.4); near 52 (67/30/52); vs cen 7/20.
- Final check S01,S09,S10,S13 x 10,50 x 1,2 (final.jsonl): 10: all done, thr 316 (148/293/288), 8/0 vs ace; 50: thr 366 (355/356/363).
- Collisions 0 everywhere. NODEX_ABLATE=all reproduces baseline ace (ablall.jsonl, identical tasks + sim time).
Regressions/open: S02 10 s18427 head-on multi-robot lane livelock (43/53); centralized still better at 50; ACE tests A01-A12 and fleet 3/100 not re-run (budget).
