# WS4 — baseline integrity (fix- flags)

Tree `zz-ws4/`, patch `bench/patches/ws4.diff`. Dev seeds 18427,1,2; S01-S14; fleets 10,50.
Baseline = `bench/results/baseline.jsonl` (verified: `NODEX_ABLATE=all` in zz-ws4 gives identical det_digest, 6/6 configs checked).
Compare tool: `python bench/ws4/cmp.py <jsonl>` (paired vs same-system baseline row). Collisions 0 in every run.

## WS4-1 `fix-wait-timer` — centralized, decentralized, ace
- Old: WAITING robot's `stalledDuration` += dt twice per tick: controller (`RobotAgent.js` evaluatePeerConflicts; `CentralizedCoordinator.js` ROBOT_WAITING) + engine (`sim-engine.js:574,652`). Every ">N s" rule (mutual-wait 1.5, retreat 1.5, replan 3.0, ACE containment detour 2.0) fired at N/2. Audit missed that centralized is affected too.
- New: engine is the single clock; controller increments removed (gated).
- Measured (`ws4_wait.jsonl`, geo thr ratio / W-L-T vs own baseline):
  C 10: 1.02, 24/13/5, all-done 35 vs 38 | C 50: 1.14, 29/4/9
  D 10: 0.95, 19/14/9, all-done 36 vs 38 | D 50: 1.05, 21/10/11
  A 10: 1.19, 22/14/6, all-done 39 vs 35 | A 50: 1.01, 19/12/11
  Near-coll roughly unchanged (C10 40 vs 31). Small fleets: chaotic gridlock flips both ways (e.g. C S02 s18427 permanent 10-robot head-on on y=305 lane — same deadlock class exists in baseline, other seeds).
- Status: kept; net positive for all three.

## WS4-2 `fix-cnp-window` + WS4-3 `fix-cnp-committed` — decentralized, ace (shared path)
- Old: `evaluateTaskBids` closed an auction when `ticksElapsed >= 1`, i.e. in the same tick the bid was created (50 ms window dead code). Agents tick R01..RN, bids of later robots arrive after close and are dropped: lowest-ID eligible idle robot always wins, distance ignored. Contradicts own comment "every eligible peer bids; lowest cost wins".
- New: close at `ticksElapsed >= 2` (or 50 ms): all bids in. Award only among bidders still free (peer's own state broadcast shows no other task) so multiple simultaneous auctions don't stall on a busy winner.
- Measured (`ws4_cnpcbs.jsonl`, both flags):
  D 10: thr 359 vs 277 (1.36), 35/6/1, all-done 39 vs 38 | D 50: 447 vs 288 (1.51), 39/2/1, done 66.4 % vs 52.4 %
  A 10: 339 vs 255 (1.43), 35/7/0, all-done 38 vs 35 | A 50: 457 vs 312 (1.43), 38/3/1, done 69.1 % vs 53.8 %
  cycle D50 174 vs 201 s, A50 177 vs 210 s; near-coll D10 22 vs 32, A50 71 vs 64.
  Window-only variant started (`ws4_cnpwin`) but stopped on wrap-up: committed-bidder share not isolated.
- Status: kept. Largest baseline handicap found; decentralized throughput changes most. WS3 owns ACE allocation; this is the minimal shared-path fix.

## WS4-4 `fix-cbs-fallback` — centralized
- Old: on MAX_CT_NODES truncation (151/4171 plans in the dev matrix, up to 71/132 in C S13 10 s18427) CBS returned the deepest CT node; header documents "fewest conflicts".
- New: among expanded nodes, fewest conflicts (all pairs, same definitions) then lowest cost; computed only when unsolved.
- Measured (`ws4_cnpcbs.jsonl`): C 10 geo 1.00 (8/6/28), C 50 1.01 (3/1/38); truncated plans 96/4240; S08 0.83 (3 losses), S13 1.07. Neutral.
- Status: kept (genuine, documented-intent bug, neutral). Droppable if merge wants minimal set.

## WS4-5 `fix-health-speed` — ace advantage removed (C, D no-op)
- Old: S12/S13/A10/A11 health degradation lowers `targetVelocity`; ACE `adaptBehaviorToEnvelope` rewrites it to 1.2 every tick in LOCAL/NEIGH, so a degraded ACE robot kept full speed.
- New: degradation also records `healthSpeedCap`; engine `applyOperatorOverrides` caps speed for every system.
- Measured (`ws4_health.shard0.jsonl`, partial 31/36): C and D bit-identical to baseline (det_digest SAME, 20 runs). ACE changed in 5 runs: S13 10 s18427 51 vs 50, s1 50 vs 48, s2 50 vs 51; S13 50 s18427 66 vs 39; S12 10 s1 same result.
- Status: kept (fairness).

## Reviewed, kept as is (architecture, not bugs)
- Decentralized unpaired-conflict pair wait (`RobotAgent.js` ~1034-1038): defined System-2 invariant (FixedPairCoordinator header).
- No ORCA in centralized: central halts + separation guard replace it.
- ConflictManager projects stationary robots at speed 1: heuristic, not changed.
- comm_loss: injection identical (same call, target, time; fairness fingerprint equal). Effects differ: C 10 s safe stop of target; D none (flag unread, peer blackout not modelled); A permanent SAFE-DEGRADED (WS1).
- Reported asymmetry (not fixed): centralized uplink is lossless/zero-latency and halts/waits bypass the lossy link; only route commands are delayed/dropped. Peers lose 80 % of all messages in S07. Favors centralized in S06/S07/S13.
- Reported (not fixed): false peer-death under 80 % loss (5 s silence, latency back-dated) releases live robots' tasks; the second claimer keeps a task completed by the first (`reconcileTaskOwnership` checks assignedRobot). Plausible cause of decentralized S07 collapse.

## Not done (wrap-up)
Combined all-fix matrix, fleets 3/100, unit suite on zz-ws4 (`bench/ws4/vitest.tests.config.js` prepared), CBS residual-conflict probe (`bench/ws4/cbsprobe.mjs`).
