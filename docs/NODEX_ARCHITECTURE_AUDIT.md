# NodeX Architecture Audit — Centralized vs Decentralized vs NodeX ACE

Date: 2026-09-28. Scope: `src/core/**` and `src/data/scenarios.js`, read-only. `zz-base/` ignored.
All claims cite `file:line` relative to `src/core/` unless stated otherwise.

---

## 0. Shared execution layer (applies to all three systems)

| Item | Value / behavior | Source |
|---|---|---|
| Kinematics | `step = speed * simDt * 22 px`; speed = controller command | `sim-engine.js:260-287` |
| Separation guard | move refused if it closes to < `2*16-2 = 30 px` of any robot | `sim-engine.js:274`, `map-geometry.js:130-134` |
| Cruise speed | `targetVelocity 1.2` (26.4 px/s) for every robot | `RobotAgent.js:88`, `CentralizedCoordinator.js:217` |
| Load/unload dwell | 1.0 s each | `task-lifecycle.js:32-33` |
| Admission cap | fleets > 10 robots: max **6** concurrent tasks (all systems) | `admission-control.js:10-19`, `AssignmentEngine.js:107-112`, `RobotAgent.js:714`, `DecentralizedFleet.js:122` |
| Sensor model | omni 80 px, deterministic LCG noise `poseUncertainty*12 px` | `sensor-sim.js:13-51` |
| Run wall budget | 90 s × simSpeed, identical per mode | `sim-lifecycle.js:26,342` |
| Randomness | **No `Math.random` anywhere in `src/core`** (only a comment, `CentralizedCoordinator.js:527`). Loss is LCG-seeded (`PeerCommunicationBus.js:60-64`, `CentralizedCoordinator.js:134-138`), sensor noise LCG (`sensor-sim.js:17-22`). Tick dt comes from rAF wall time capped 0.1 s (`sim-engine.js:297`), so live runs are **frame-rate dependent** (RACE persistence counts samples/ticks, not seconds: `race-evaluator.js:43`). The headless `experiment-runner` uses fixed dt and is reproducible. |
| stalledDuration | incremented **twice** per tick for WAITING robots in Systems 2/3: by the engine (`sim-engine.js:652`) and by the agent (`RobotAgent.js:1025`), then copied back (`RobotAgent.js:294`). All "> N s" wait thresholds in agents fire at ≈ N/2 s sim time. Affects Decentralized and ACE equally. |

---

## 1. Centralized (System 1)

**Task allocation — genuine.** Every 0.5 s central cycle (`CentralizedCoordinator.js:29,289-293`) runs a Hungarian batch solve (`AssignmentEngine.js:105-138`, `HungarianAssignment.js`) on idle robots × the top‑priority admissible tasks. Cost = `1.0*euclid(robot,pickup) + 250*workload − 0.5*battery − 40*priorityLevel` (`AssignmentEngine.js:47-69,124-127`). Distance is straight-line, not path length. Excludes battery < 15, health < 30 (`AssignmentEngine.js:26-42`).

**Global state.** Authoritative `fleetState` Map (`CentralizedCoordinator.js:38`); the engine mutates the same objects (state.robots = fleetState values, `:240`, `sim-engine.js:564`). Uplink counter +N every tick (`:271`).

**Path planning — CBS is real.** `CBSPlanner.js`:
- High level: best-first on cost (sum of arrival times), tie → deeper (`:226`); first conflict split into two children, one constraint each, only that agent replanned (`:236-254`).
- Conflicts: vertex (overlapping node-occupancy intervals, goal held +2 steps) and **head-on edge swaps only** (`:179-204`); same-direction following is not a conflict.
- Constraints: vertex `(node, t)` single-step; edge `(u→v, [t0,t1])` (`:238-246`).
- Low level: space-time A* on (node, goal-phase, t) with wait action, reverse-Dijkstra heuristic cached per goal (`:70-95,102-161`), failed robots/static obstacles as `blockedNodes` (`CentralizedCoordinator.js:660-667`).
- Bounds: `MAX_CT_NODES = 120` (`:25`), low-level 40 000 expansions (`:133`), horizon 360 steps × 1 s (`:26`). On truncation returns the **deepest** node (`:233`), not the fewest-conflict node as the header comment claims (`:18-20`); `countConflicts` is binary (`:206-209`, unused).
- Discretization: 1 s steps, edge cost rounded to ≥1 step (`:23,29`).
- Replan: on new assignment, fault, or every 8 s (`CentralizedCoordinator.js:30,622-627`). Wait steps become `cbsSchedule` holds, each capped 6 s and skipped if the node already has a queue (`:31,325-341`).
- Scalability: CBS only plans task holders, which the admission cap limits to **6** at 50/100 robots, so CBS stays small. Without the cap, `findConflict` is O(A²·V²) per CT node and 120 CT nodes would truncate routinely at ~50 agents. ConflictManager (`ConflictManager.js:23-73`) and CentralCollisionDetector (`CentralCollisionDetector.js:48-62`) are O(N²) over the whole fleet each tick.

**Traffic / deadlock.** Central collision detector: 1.5 s linear projection; halts on rack/boundary/restricted legs and dynamic objects < 30 px ahead (`CentralCollisionDetector.js:18-20,42-90`). ConflictManager: pairs < 48 px and closing (stationary robots projected at velocity `|| 1`, i.e. assumed moving — over-conservative, `ConflictManager.js:47-52`) or < 32 px; priority: parked < active, merging yields, lane leader, intersection queue/holder, task priority, distance to waypoint, ID (`:82-154`). Loser WAIT; replan avoiding contested edge after 3 s (`:194-226`). Back-off retreat after 1.5 s for head-on (`CentralizedCoordinator.js:376-390`). Central FIFO intersection reservation table (`intersection-reservation.js`, `CentralizedCoordinator.js:779-785`). Central traffic recovery evicts parked node-holders after 1 s, clears parked blockers after 2 s (`traffic-recovery.js:213-256`).

**Failure recovery.** Failed robot's task released to queue; next Hungarian cycle reassigns; CBS replans around it (`CentralizedCoordinator.js:556-586`). Server outage → fleet-wide safe hold (`:275-286`). Robot link loss → 10 s safe stop of that robot (`:127-132`, `sim-engine.js:739-741`). Link latency/loss delays/retransmits commands in real sim time (`:722-743`).

**Local execution.** Speed = `targetVelocity` with **no ORCA factor** (`sim-engine.js:578`); robots hold on central halt / schedule hold / WAITING (`sim-engine.js:572-577`).

**Advantages / handicaps.** + global knowledge, central FIFO reservations, no ORCA slowdown, no peer handshake. − conflict detector over-triggers on stationary robots (`ConflictManager.js:47-52`); comm faults cause real delays (only system where latency is physical); server outage = full stop.

---

## 2. Decentralized (System 2)

**Bidding.** Announcement from task board (`DecentralizedFleet.js:76-79`), re-announced every 1 s while any robot idle and admission allows (`:115-130`). Bid cost = `1.0*euclid(robot,pickup) + 250*0 − 0.5*battery` (`RobotAgent.js:653-656`) — **distance + battery only; workload hard-coded 0**. Award after **one tick** (`ticksElapsed >= 1`, `RobotAgent.js:672-673`): agents tick sequentially R01→RN (`DecentralizedFleet.js:145-148`) and messages are delivered synchronously (`PeerCommunicationBus.js:105-127`), so the lowest-ID eligible robot evaluates its auction having seen only its own bid and claims the task; a later robot that "wins" is rejected by the board (`RobotAgent.js:710-713`). Effective allocation is **ID-order greedy**, and a task whose lowest bidder already took another task falls through to the 1 s re-announce. Same for ACE.

**Fixed-scope continuous coordination** (`FixedPairCoordinator.js`): candidates = robots within `PAIR_RANGE 80 px` (`:23`, `RobotAgent.js:417`); `PAIR_SCOPE_RADIUS 22 px` is drawn only (`components/WarehouseMap.js:959`). Continuous refresh sessions 0.4 s with each task-holding neighbour at most every 1.5 s (`:24-27,87-99`); conflict sessions 1.2 s, max 6 s (`:25-26`); request timeout 0.6 s, busy back-off 0.3 s (`:28,79,164`); arbiter = lower ID (`:189-191`); agreement TTL 8 s (`:33`). **Unpaired conflicting peer ⇒ forced yield** (`RobotAgent.js:994-999`) until a pair forms; resolved by the mutual-wait rule after 1.5 s (≈0.75 s with double counting, `RobotAgent.js:41,1007-1012`). This is a deliberate baseline handicap.

**Communication model** (`PeerCommunicationBus.js`): global broadcast (no range), synchronous delivery; `latencyMs` does **not** delay delivery, it only back-dates `lastSeen` (`:91-92`, `RobotAgent.js:576,587`); loss is per-recipient LCG drop (`:108,118`). Counts messages per `send` (a broadcast = 1) (`:95`); **no byte accounting**. State broadcast 4 Hz (`RobotAgent.js:113,454`) plus intent broadcast whenever a path exists (`:1734-1741`).

**ORCA.** Along-lane speed factor for a robot ahead within 20 px lateral: `tau=(along−32)/closing`; if τ < 1.5 s, factor = `max(0.3, 1−0.5(1−τ/1.5))` (`RobotAgent.js:467-487`); applied by the engine (`sim-engine.js:657`). Both decentralized systems.

**Deadlock / replanning.** Retreat or turn-back replan after 1.5 s head-on (`RobotAgent.js:1032-1040`, `deadlock-backoff.js:28`); local replan avoiding contested edge after 3 s, 4th attempt → QUEUE_HOLD, reset after 10 s (`RobotAgent.js:1041,1611-1653`); corridor rule hold ≤ 6 s or bounded detour (+100 px) (`:57,1268-1320`); winner-blocked back-off (`:1362-1384`); clearance requests to parked robots after 2 s stuck (`:1393-1430`); failed robots / pallets rerouted around from sensors (`:1100-1207`).

**Orphaned tasks.** Peer dead if status ERROR or silent > 5 s (`RobotAgent.js:1681`); board lease released and task re-announced by the detecting peer (`:1697-1707`); failed robot drops stale claim once re-awarded (`:363-367`).

---

## 3. NodeX ACE (System 3)

### 3.1 Every code path that differs from Decentralized
| # | Location | Difference |
|---|---|---|
| 1 | `RobotAgent.js:143-167` | builds EdgeAiPredictor + AceSessionManager instead of FixedPairCoordinator |
| 2 | `RobotAgent.js:368-373` | failed robot: SAFE-DEGRADED labels, closes session |
| 3 | `RobotAgent.js:386` | standing robots excluded from sensor-conflict events |
| 4 | `RobotAgent.js:391-414` | Edge AI → RACE → hysteresis → `adaptBehaviorToEnvelope` → session tick (vs `pair.tick`) |
| 5 | `RobotAgent.js:454,490-513` | broadcast period 250/100/100/500 ms by state; targetVelocity 1.2/1.2/**0.6/0.25**; CONTAINMENT detour trigger |
| 6 | `RobotAgent.js:631` | `ACE_*` messages to session manager |
| 7 | `RobotAgent.js:657-660` | bid += `0.10*risk*120` (≤ 12 px) |
| 8 | `RobotAgent.js:854-857` | `mayEnter` blocked by contract slot hold |
| 9 | `RobotAgent.js:984,1000-1003` | standing peers skipped; contract `decide()` replaces local rule, **no pair wait** |
| 10 | `RobotAgent.js:1115` | standing robots added to local blockage map → `_avoidBlockages` reroutes |
| 11 | `RobotAgent.js:1415-1418` | vs standing robot: reroute first, clearance request only after 6 s stuck |
| 12 | `RobotAgent.js:1631-1638` | deadlock replan avoids **all edges of the contract hub** |
| 13 | `sim-engine.js:88-93`, `:833-839`, `hitl-controller.js:77-82` | HITL flags honoured only in ACE |
| 14 | `DecentralizedFleet.js:246-250,274-278` | failure / clear-fault labels |
| 15 | `EdgeAiPredictor.js:101,110`, `race-evaluator.js:136-153` | `isCriticalDegraded` (comm_loss fault) forces SAFE-DEGRADED; ignored by System 2 |
| 16 | `sim-engine.js:666-694`, `experiment-runner.js:171-186,269-315` | telemetry only |

### 3.2 Feature verdicts
| Feature | Implementation | Influences | Verdict |
|---|---|---|---|
| Local state | same `localState` as System 2 (`RobotAgent.js:77-105`) | — | Genuine (shared) |
| Peer cache | same, fleet-wide (global broadcast) (`:550-590`) | freshness checks, Edge AI commRisk | Genuine (shared); not "local" — contains all N robots |
| Intent exchange | same STATE/INTENT broadcasts (`:1712-1742`); only rate differs (100 ms in NEIGH/CONT) | fresher peer info | Genuine; only the rate is ACE-specific |
| Edge AI (`EdgeAiPredictor.js`) | constant-velocity tracks (`:33-51`); logistic `σ(−3.2 + 4.2·closeness + 2.6·urgency + 1.4·headOn)`, 3 s horizon, SAFE_SEP 32 (`:15-18,72-81`); commRisk = mean peer age/2500 (`:92-101`); queueGrowth = slope·0.8 + waiting/2 (`:104-108`); cascade = shared-path count/2 (`:84-87,112`); latency = measured CPU ms, no simulated latency (`:54,121-124`) | RACE inputs; session membership (`perPeer > 0.35`, `AceSessionManager.js:88`); bid (via risk) | Genuine but heuristic (no learned model). **Calibration bug:** with zero relative velocity, `urgency = 1` ⇒ `z ≥ −0.6` ⇒ `p ≥ 0.354 > 0.35` for **any** non-standing robot in sensor range, so every co-moving/queued neighbour is "predicted" into the session. Does not influence path planning or yield decisions directly. |
| RACE | `R = 0.35C + 0.15U + 0.20CR + 0.15Q + 0.15CP` (`race-evaluator.js:23-30,70-85`); inputs from sensors+Edge AI (`RobotAgent.js:313-341`); conflict = max(sensor, AI); sensor conflict = 1 if any non-standing robot < 36 px, linear 36–64 px, **≥ 0.6 whenever the robot itself is WAITING/yielding** (`:320-325`); U ≥ 0.55·C and CP ≥ 0.45·C when C > 0.5 (`:333-336`) | envelope state | Genuine runtime signals, all normalised 0..1. Self-referential waiting term and C/U/CP coupling make proximity alone reach 0.50. |
| Hysteresis | thresholds enter 0.50 / 0.70 / 0.85, exit 0.35 / 0.55 / 0.68; 3 consecutive samples; 4.0 s min dwell (`race-evaluator.js:33-44,135-270`); de-escalation may skip levels (`:126-130`) | state | Genuine. Persistence is per tick (≈ 50 ms at 60 fps), dwell is sim seconds. |
| Envelope states | LOCAL: 4 Hz, v 1.2, no session. NEIGHBORHOOD: 10 Hz, v 1.2, session radius 40. CONTAINMENT: 10 Hz, **v ≤ 0.6**, session radius 60 + queued robots ≤ 120 px, **detour when WAITING > 2 s**. SAFE-DEGRADED: 2 Hz, **v 0.25**, no session (`RobotAgent.js:490-513`, `race-evaluator.js:8`, `AceSessionManager.js:80-99`). `envelopeRadius` is used only for session group radius (`AceSessionManager.js:82`). | speed, message rate, session scope, detours | Genuine (they change motion). |
| Sessions / contracts | opened by task holders in NEIGH/CONT with ≥ 1 peer; ≤ 8 members (`AceSessionManager.js:25,71-78,98`); region = my next intersection (`:101-113`); order = inside-region, distance, ID, parked last (`:131-135`); 2 s slots, expiry `n·2+2 s` (`:24,143,152`); lower sid wins on overlap (`:199`); close on all-cleared / expiry / initiator back to LOCAL (`:64-68`); member drops if initiator unseen > 2 s (`:66-67`). Effects: `decide()` right-of-way (`:256-267`), region-edge hold until slot start (`:274-289`), parked members sent CLEARANCE_REQUEST (`:136-141`), deadlock replan avoids whole hub (`RobotAgent.js:1631-1638`). Expansion/contraction = re-selection on each new session; a live session's membership never changes. | yields, holds, detours | Genuine. |
| HITL | ENTIRE_FLEET / ROBOT_GROUP / INDIVIDUAL; hold → speed 0, speed_limit → cap, safe_stop → treated as failure + re-auction (`hitl-controller.js:53-134`, `sim-engine.js:88-93`); `REROUTE` action declared but **not implemented** (`hitl-controller.js:24,113-133`). Disarmed by default (`state.js:134`); only ACE test A12 arms it automatically (`scenario-engine.js:460-471`). | motion | Genuine when used; autonomous runs are HITL-free. Pre-flight "HITL watchdog" check always passes (`sim-lifecycle.js:228-232`) — cosmetic. |
| Dead RACE code | `calculateTaskBidCost`, `detectSpatiotemporalConflict`, `detectDeadlock` (wait-for-graph) are never called at runtime (`race-evaluator.js:50-65,308-390`); `checkSpatialConflictWithPeer` unused in tick (`RobotAgent.js:221-230`) | nothing | Cosmetic |
| experiment-runner ACE comm | writes `r.commRisk` onto snapshots that agents never read (`experiment-runner.js:171-186`); `escalationsCount/deEscalationsCount` read from fields that do not exist (`:270-273`) → always 0 | nothing | Cosmetic |

---

## 4. Mechanisms that can make NodeX slower than Decentralized (ranked)

Risk arithmetic used below: with sensor conflict C = 1 (a non-standing robot < 36 px — normal ORCA/queue spacing is 30–32 px), `R ≥ 0.35 + 0.15·0.55 + 0.15·0.45 = 0.50` before commRisk ⇒ **NEIGHBORHOOD after 3 ticks** (`RobotAgent.js:322,333-336`, `race-evaluator.js:34,205-214`). One waiting neighbour adds Q = 0.5 (+0.075) and shared path CP 0.75 (+0.045); two waiting neighbours ⇒ R ≈ 0.74 ⇒ **CONTAINMENT**.

1. **CONTAINMENT speed cap 0.6 (50 %)** — `RobotAgent.js:499-501`. Reached by ordinary hub queues (2 waiting neighbours). Held ≥ 4 s dwell + 3 samples ≤ 0.55 (`race-evaluator.js:44,251-259`); a waiting robot cannot drop below ~0.30 while waiting (self-term `RobotAgent.js:325`), so the cap persists through the whole queue plus ≥ 4 s after. Stacks multiplicatively with ORCA (≥ 0.3) (`sim-engine.js:657`).
2. **Permanent SAFE-DEGRADED crawl 0.25 (21 %) after a comm_loss fault** — `sim-engine.js:742` → `DecentralizedFleet.js:259` sets `isCriticalDegraded`, which forces SAFE-DEGRADED every tick (`race-evaluator.js:136-153`) and `targetVelocity 0.25` (`RobotAgent.js:508-511`) until an operator clearFaults. The same fault has **no effect** in Decentralized (flag unread) and a 10 s stop in Centralized. Hits S06/S07/S13 and A03/A11 (`scenario-engine.js:367-371,395,474-503`). The crawling lane leader then queues followers → cascades them into CONTAINMENT (item 1).
3. **Comm-latency-driven escalation** — commRisk = mean peer age/2500 over the whole fleet cache (`EdgeAiPredictor.js:92-101`); uncertainty takes `maxStale` for ages > 1.5 s (`:98,110-111`). S07 (1000 ms, 80 % loss) drives CR,U → 1 ⇒ R ≥ 0.35 with no conflict, ≥ 0.85 with one ⇒ SAFE-DEGRADED 0.25 for ≥ 4 s. The latency itself is not physical for peers (delivery is instant, `PeerCommunicationBus.js:91-92`), so ACE slows down for a delay that costs Decentralized nothing.
4. **Contract slot holds at intersections** — `AceSessionManager.js:274-289` via `RobotAgent.js:854-857`: member k holds at region edge until `openedAt + 2k s` while an earlier member still "uses" the region, up to 7×2 = **14 s** for an 8-robot session (`:24-25,152`). Sessions reopen immediately while the robot stays in NEIGHBORHOOD (`:71-78`), and membership is inflated by the Edge-AI calibration bug (§3.2).
5. **CONTAINMENT_DETOUR and hub-wide avoidance** — every tick in CONTAINMENT with `WAITING && stalledDuration > 2 s` (≈ 1 s sim with double counting) → `recoverFromDeadlock` (`RobotAgent.js:504-507`), whose avoid-set is **all edges of the session hub** (`:1631-1638`) → long detours; 4th attempt → QUEUE_HOLD (`:1617-1624`). System 2 replans only after 3 s and avoids one edge.
6. **Unbounded detours around "standing" robots** — any robot stopped ≥ 1 s without a task, loading/unloading (1 s dwell), or HITL-held is a blockage (`RobotAgent.js:48,1076-1092,1115`); `_avoidBlockages` reroutes proactively every 3 s per blocker with no length cap and may turn back (`:1168-1207`, `traffic-recovery.js:85-113`), whereas the corridor detour is capped at +100 px (`RobotAgent.js:1313`). Parked-robot clearance request is delayed from 2 s to **6 s** when a detour exists (`:51,1415-1418`).
7. **ACE ignores standing robots as conflict partners** (`RobotAgent.js:984`) so it drives up to the physics separation guard and stalls (`sim-engine.js:274`) instead of yielding early; recovery then depends on items 6/5.
8. **Contract order overrides the local right-of-way rules** (`RobotAgent.js:1000-1003`, `AceSessionManager.js:256-267`): distance-to-region order can contradict "merging yields to lane traffic" / "holds intersection" (`RobotAgent.js:955-957`), producing mutual waits resolved only by the 1.5 s tie-break (`:1007-1012`).
9. **Hysteresis latency** — 4 s minimum dwell in every elevated state (`race-evaluator.js:44`) keeps speed caps and sessions alive after the cause clears.
10. **Extra message volume** — 10 Hz broadcasts in NEIGH/CONT and 2 Hz in SAFE-DEGRADED (`RobotAgent.js:497,500,509`) plus ACE_SESSION_* unicasts. No effect on motion (delivery is synchronous) but it inflates the message KPI; the bus counts sends, not bytes (`PeerCommunicationBus.js:95`).

Not a slowdown: Edge AI runs synchronously with no simulated latency (`EdgeAiPredictor.js:54,121`); broadcast in LOCAL equals System 2 (250 ms).

ACE advantages over System 2 (for balance): no pair wait for unpaired conflicts (`RobotAgent.js:994-999` applies to System 2 only); health-degradation speed reduction is **erased** in ACE because `adaptBehaviorToEnvelope` rewrites `targetVelocity = 1.2` every tick in LOCAL/NEIGH (`RobotAgent.js:495,498` vs `scenario-engine.js:645-649`).

---

## 5. Fairness check

| Aspect | Same? | Evidence |
|---|---|---|
| Map / spawn points | Yes | `MapGeometryEngine.computeFleetSpawnPoints` in both fleets (`CentralizedCoordinator.js:199`, `DecentralizedFleet.js:54`) |
| Workload | Yes (deterministic generators, same task ids) | `scenario-engine.js:246-279,1343-1375` |
| Speeds / dwell | Yes nominally; ACE overrides targetVelocity by state and ignores health slow-down | `RobotAgent.js:490-513`, `scenario-engine.js:645-649` |
| Admission cap | Yes | `admission-control.js` |
| Robot failure | Equivalent (task released, re-allocated) | `CentralizedCoordinator.js:556-586`, `RobotAgent.js:1678-1708` |
| comm_loss fault | **No**: Central 10 s stop; Decentralized no effect; ACE permanent 0.25 crawl | `sim-engine.js:739-742`, `DecentralizedFleet.js:255-266` |
| Link latency | **No**: physical command delay only in Centralized; peers only see older timestamps, which only ACE's risk engine penalises | `CentralizedCoordinator.js:722-743`, `PeerCommunicationBus.js:91-92` |
| Conflict negotiation | **No**: System 2 forced pair-wait handicap by design | `RobotAgent.js:994-999`, `FixedPairCoordinator.js:10-17` |
| ORCA | Centralized has none | `sim-engine.js:578` vs `:657` |
| Message metric | Not comparable: central counts uplink per robot per tick, peers count sends | `CentralizedCoordinator.js:271`, `PeerCommunicationBus.js:95` |
| Hidden delays | None found (no sleeps/timeouts); all holds are listed in §4 | — |
| Auction | ID-order bias identical for Systems 2/3 | `RobotAgent.js:669-693` |

---

## 6. Gap matrix

| Component | Centralized | Decentralized | NodeX ACE | Current issue |
|---|---|---|---|---|
| Task allocation | Hungarian batch every 0.5 s, euclid+battery+priority | CNP bid, euclid − 0.5·battery, workload 0 | same + 0.10·risk·120 | Euclid not path cost; 1-tick award ⇒ ID-order greedy, 1 s re-announce gaps (`RobotAgent.js:672`) |
| Fleet state | Global authoritative Map | Fleet-wide peer cache via global broadcast | same | "Local" cache is actually global; no comm range |
| Local autonomy | None (execution only) | Full local A*, rules | same + envelope behaviors | — |
| Path planning | Real CBS (vertex + head-on edge), 120 CT nodes, 1 s steps | Local A* on own graph | same; replans avoid whole hub in sessions | CBS returns deepest not best on truncation; no following conflicts |
| Conflict detection | Central O(N²) proximity + 1.5 s projection; stationary treated as moving | Sensors < 48 px | Sensors + Edge AI fused | Edge-AI p ≥ 0.354 for any co-moving robot (threshold 0.35) |
| Coordination | Central arbitration + FIFO node table | Fixed 2-robot pairs, forced wait when unpaired | Temporary sessions ≤ 8, 2 s slot contracts | Slot holds up to 14 s; contract can contradict lane rules |
| Communication | Uplink/downlink, real latency/loss with retransmit | Instant global bus; latency = timestamp only; no bytes | same, 4/10/2 Hz by state | Latency not physical for peers; counts not comparable |
| Risk awareness | None | None | RACE weighted sum, hysteresis | Proximity alone ⇒ 0.50 = escalation threshold; WAITING self-term keeps risk ≥ 0.30 |
| Congestion prediction | None (CBS is plan-time only) | None | queueGrowth/cascade from peer waits | Used only to escalate (slow down), never to reroute early |
| Deadlock recovery | Back-off 1.5 s, replan 3 s, node eviction | Back-off, turn-back, replan 3 s, QUEUE_HOLD | same + CONTAINMENT detour at 2 s, hub-wide avoid | Wait-for-graph `detectDeadlock` unused; double-counted stall timers |
| Failure recovery | Release + Hungarian reassign; CBS replan | Liveness 5 s / ERROR → re-announce | same | comm_loss asymmetric (see §5) |
| Edge AI | — | — | CV forecast + fixed logistic, synchronous | Heuristic, uncalibrated; no latency model; not used for planning |
| HITL | Rejected | Rejected | 3 scopes, hold/limit/safe-stop | REROUTE unimplemented; readiness check hard-coded pass |

---

## 7. NodeX ACE control flow per tick

1. `SimEngine.update(dt)` (`sim-engine.js:438`): sim clock += dt·speed; auto-finish / duration checks; `scenarioEngine.processTimedEvents` (faults, link conditions); step humans; build world objects.
2. `_updateDecentralized` (`:628`): snapshot truth (`getGlobalFleetState`, copies of each `localState`); `senseFrame` per robot, O(N²) (`:632`, `sensor-sim.js:29`).
3. `DecentralizedFleet.tick` (`DecentralizedFleet.js:140`): re-announce open tasks (1 s, admission-gated); for each agent in ID order: `setSensorFrame`, `agent.tick`.
4. `RobotAgent.tick` (`RobotAgent.js:352-450`):
   a. `processInbox`: peer cache, intents, announcements → bid broadcast, bids, clearance, `ACE_*` session messages.
   b. ERROR → SAFE-DEGRADED, close session, broadcast, return.
   c. `_updateStanding`, `_updateBlockages` (standing robots become blockages), sensor-conflict flag, ORCA factor.
   d. Edge AI `observe` + `infer` → `computeRaceInputs` → `calculateRaceRisk` → `evaluateEnvelopeState` (hysteresis) → `adaptBehaviorToEnvelope` (broadcast rate, targetVelocity, CONTAINMENT detour) → `ace.tick` (close/open session, contract) → scope labels.
   e. `evaluateTaskBids` (award after 1 tick) → `claimTaskOwnership` (local A* via pickup).
   f. `checkPeerLiveness` (orphan re-announce), `_trackPickup`, `_expireNodeClaim`, `_tickService`.
   g. Handling dwell, or task: `reconcileTaskOwnership`, `_avoidBlockages`, `evaluatePeerConflicts` (standing skipped, `ace.decide` contract right-of-way, mutual-wait, retreat/turn-back, replan), `evaluateStuck`, `repairOwnRoute`, `checkTaskCompletion`; or idle: clearance / return-to-bay.
   h. `_maybeBroadcast` (period by envelope state) → STATE_UPDATE + INTENT_UPDATE.
5. Fleet: log latest decision per agent, `updateActiveSessions`, aggregate stats.
6. Engine motion per robot (`sim-engine.js:636-663`): skip failed / handling / WAITING (stalledDuration += dt); `commanded = targetVelocity × orcaFactor`; `applyOperatorOverrides` (scenario stall, HITL hold/limit); `_move` with `agent.mayEnter` (contract region hold → bay-merge gate → corridor rule → node-claim mutex); `updatePhysicalState` back into the agent.
7. Publish: fleet RACE aggregate, coordination state, KPIs, events, sessions, contracts; physics monitor; timeline / ACE test monitor sampling; architecture metrics every 0.5 s.
