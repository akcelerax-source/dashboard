# WS3 - ACE task allocation (flags `ws3-joint-award`, `ws3-eta-bid`, `ws3-busy-bid`)

Files: new `core/ace/AceTaskAllocator.js`; `core/decentralized/RobotAgent.js` one-line hooks (imports, `_configureArchitecture`, processInbox TASK_ANNOUNCEMENT/TASK_BID, tick bid call, `evaluateTaskBids` delegation, `checkPeerLiveness` orphan re-announce). Decentralized path unchanged. `NODEX_ABLATE=all`: 14/14 digests identical to baseline.jsonl.

## Kept
1. **ws3-joint-award** (bid window + joint award). Old: award after 1 tick, agents tick in ID order -> lowest-ID idle robot wins (empty travel 50 robots 520 px vs central 164). New: one bundled bid per robot per announcement round; award next tick when all bids delivered; each bidder solves the same min-cost assignment (first K tasks in board order, K = free admission slots) and claims only its own task; board still rejects duplicate claims. Messages/run -45..-56 %.
2. **ws3-eta-bid**: bid = graph route length / cruise speed + legacy risk/battery terms (s). Adds ~+5 % over straight-line joint award (probe p1 vs p2).
3. **ws3-busy-bid** (fleets <=10 only): robot on loaded leg finishing within 12 s bids with remaining + drop->pickup; winning keeps task open for it (not claimed while busy); stops bidding if stalled/waiting or after 12 s. Fleet 10 thr +9 % vs without (b10_v3 vs b10_v4), graph pickup distance 420->260 px in queue scenarios.

## Measured (bench/results/ws3_final.jsonl, S01/S02/S03/S12, seeds 1,2; geo-mean thr ratio)
- fleet 10: vs base ACE 1.81, vs central 1.45, vs decentral 1.36; cycle 94 vs 132 s; near 23 vs 60; stops 19.6 vs 28.1.
- fleet 50: vs base ACE 1.51, vs central 1.33, vs decentral 2.11; cycle 175 vs 223 s; near 22.4 vs 14.2 base ACE (58.9 central) - rises with work done; near/task ~ unchanged. 0 contacts.
- Broad probe (S01-S14, bench/ws3/out/b10_v6, b50_v6_noswap): fleet 10 thr 1.61x base ACE / 1.22x central; fleet 50 ~1.29x base ACE / 1.16x central. Losses: S07 comm loss (safe-degraded crawl, WS1), S09/S11 scripted, some traffic-layer gridlocks (WS2, e.g. S12/S14 n10 seed 18427).
- Not run: fleet 3/100 broad check (budget stop).

## Tried and reverted
- ws3-congestion-eta (peer queues, planned flow, own per-node wait EMA): neutral at 10 (+1 %), -3 % at 50.
- Priority re-sort of rounds: -20 % at 10 (chaotic), reverted.
- ws3-task-swap (handover before pickup + lease check): +3 % geo but 9/14 per-run worse at 10, mixed at 50, more near-collisions; reverted.
- ws3-idle-parking (nearest bay instead of home): +3 % at 10, -19 % at 50 subset, more near; reverted. Idle robots already leave stations/lanes in all systems (returnToBay), so no generic rule to propose.
