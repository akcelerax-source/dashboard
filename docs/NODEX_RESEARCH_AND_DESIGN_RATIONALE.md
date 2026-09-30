# NodeX ACE-AMR — Research Review and Design Rationale

Compiled: 2026-09-28. Scope: evidence base for making NodeX Edge-AI ACE measurably more efficient than the
Centralized (CBS/global planner + central assignment) and Decentralized (Contract-Net + fixed-scope
neighbour coordination + ORCA-style avoidance) baselines **without weakening the baselines**.

## How to read this document

Source labels:

| Label | Meaning |
|---|---|
| **Published standard** | Adopted, in-force standard / specification |
| **Draft** | Committee/enquiry draft (CD/DIS/prEN). Not adopted. Never cite as a requirement |
| **Peer-reviewed paper** | Journal or refereed conference (AAAI, IJCAI, IROS, RA-L, T-RO, AAMAS, SoCS, ICLR ...) |
| **Preprint** | arXiv / under review. Findings not yet peer-validated |
| **Technical report** | Institutional report (e.g. CMU-RI TR, Amazon Science paper without confirmed venue) |
| **Industry guidance** | Vendor/association/press material, handbooks |

Verification markers: **[V]** = content retrieved and read during this review (abstract, press release, spec
text or extracted PDF text). **[V-abs]** = only abstract/landing page or search snippet read; fine details
not verified. **[U]** = not verified; do not rely on it without checking.

Numbers quoted below are those reported by the authors; none has been reproduced in the NodeX simulator.

---

## 1. Standards

| Name | Status | What it establishes | What it does NOT establish | URL |
|---|---|---|---|---|
| **VDA 5050 v3.0.0** (VDA/VDMA, communication interface between mobile robots and master/fleet control) | **Published standard / open specification.** GitHub release tag 3.0.0 dated 2026-03-19; VDA press release April 2026 **[V]** | JSON/MQTT interface. v3.0 adds support for freely navigating robots: **planned-path sharing** with fleet control; a **zone concept** with contour-based zones (BLOCKED, LINE_GUIDED, RELEASE, COORDINATED_REPLANNING, SPEED_LIMIT, ACTION) and kinematic-centre-based zones (PRIORITY, PENALTY, DIRECTED, BIDIRECTED) **[V]**. RELEASE zones use a `zoneRequest` → GRANTED/REJECTED response with optional `leaseExpiry`; COORDINATED_REPLANNING forbids autonomous replanning unless fleet control grants a submitted trajectory (NURBS) **[V]**. State messages are **event-driven, at least every 30 s**; optional high-rate `visualization` topic for position/planned path **[V]**. v2.1 (2023) introduced corridors **[V]**. Robots plan their own route between waypoints; fleet control keeps traffic influence **[V]** | Scope explicitly excludes traffic-management logic: routing, prioritisation, congestion handling and deadlock-resolution algorithms are **not** specified **[V]**. It does not define KPIs, efficiency, or a decentralized peer-to-peer protocol (robot↔robot). It does not say on-robot planning is better or worse than central planning | https://github.com/VDA5050/VDA5050/releases ; https://raw.githubusercontent.com/VDA5050/VDA5050/main/VDA5050_EN.md ; https://www.vda.de/en/press/press-releases/2026/260421_PM_VDA_5050_EN |
| **ISO 3691-4:2023** Industrial trucks — Safety requirements and verification — Part 4: Driverless industrial trucks and their systems | **Published standard** **[V-abs]** | Safety requirements and verification for driverless trucks incl. AMRs; operating-zone preparation (Annex A); zone categories such as operating hazard zones (reduced speed, additional warnings) and restricted zones; personnel detection and stopping requirements (per secondary summaries) **[V-abs]** | Not a fleet-efficiency, traffic-management or KPI standard. It does not certify any coordination algorithm. A simulator cannot claim "ISO 3691-4 compliance" | https://www.iso.org/standard/83545.html |
| **ISO/CD → ISO/DIS 3691-4** (next edition) | **Draft** (committee/DIS stage; ISO lists the CD as project 88615; search snippets indicate a DIS with a 2026-09 revision date) **[V-abs]** — iso.org returned 403, stage not directly confirmed | Intended to replace ISO 3691-4:2023 | **Not adopted.** Must not be cited as a requirement or for any content | https://www.iso.org/standard/88615.html |
| **ISO 22400-2:2014** Automation systems and integration — KPIs for manufacturing operations management — Part 2 | **Published standard** **[V]** (preview pages read) | Structured KPI description (name, formula, unit, range, trend, timing, audience, effect model) and **time elements** (POT, PBT, APT, AUBT, AUPT, AOET, AQT, ATT, ADET, ADOT ...) at the MOM/MES level (IEC 62264 Level 3) for *work units* **[V]**. ~34 KPIs incl. throughput rate, allocation ratio, utilization efficiency, availability, effectiveness, OEE, NEE **[V-abs]**. Formulas verified from secondary sources: Availability = APT/PBT; Effectiveness = PRI×PQ/APT; Quality rate = GQ/PQ; OEE = Availability × Effectiveness × Quality rate; Throughput rate = PQ/AOET; Allocation ratio = ΣAUBT/AOET (index of waiting/delay in order lead time) **[V-abs]** | It does **not** define an AMR/mobile-robot fleet efficiency index, any MAPF metric (makespan, sum-of-costs), or any SAW/MCDA composite. Its only composites are equipment-effectiveness products (OEE, NEE). Using its time model for robots is an *analogy* (robot = work unit), not conformance | https://www.iso.org/standard/54497.html ; https://cdn.standards.iteh.ai/samples/54497/10e33d2a34c144558b5e3024ee5e1cb0/ISO-22400-2-2014.pdf ; https://reference.opcfoundation.org/MachineTool/v101/docs/C.2 |
| **ANSI/A3 R15.08-1:2020 (R2026), R15.08-2:2023** Industrial Mobile Robots — Safety | **Published standard** (Part 3 for users in preparation) **[V-abs]** | Part 1: IMR safety; Part 2: integration of IMR systems/applications incl. **IMR fleets (IMRF)** **[V-abs]** | Safety only; no efficiency or traffic-optimisation metrics | https://webstore.ansi.org/standards/ria/ansia3r15082023 ; https://blog.ansi.org/ansi/ansi-a3-r15-08-1-2020-r2026-mobile-robot-safety/ |
| **IEEE 1872-2015 / IEEE 1872.2-2021** Ontologies for Robotics & Automation / Autonomous Robotics | **Published standard** **[V-abs]** | Core ontology (CORA) and AuR extensions for knowledge representation | No performance metrics, no coordination algorithms | https://ieeexplore.ieee.org/document/7084073/ ; https://standards.ieee.org/ieee/1872.2/7094/ |
| **ISO 18646-2:2024** Service robots — performance criteria — navigation | **Published standard** **[V-abs]** | Single-robot navigation test methods | Not fleet coordination; not industrial AMR fleets | https://www.iso.org/sectors/engineering/robotics (search result) |
| **ASTM F45** (A-UGV / AGV performance test methods) | Committee with published test methods (docking, navigation, terminology) **[V-abs]** | Single-vehicle performance test methods, NIST-supported | No fleet-level composite efficiency index | https://www.nist.gov/programs-projects/astm-committee-f45-driverless-automatic-guided-industrial-vehicles |

**Consequences for NodeX**

* NodeX may say its fleet control *uses concepts aligned with* VDA 5050 v3.0 (zones, path sharing, release
  leases, event-driven state) — never that the simulator "implements" or "is certified to" VDA 5050.
* Safety standards (ISO 3691-4, R15.08) justify **safety gating** and zone speed limits as design
  intent only; they give no efficiency credit.
* ISO 22400-2 can be used for **time-element vocabulary** (busy vs. queuing vs. transport time,
  allocation ratio) as an analogy. It cannot be cited as the source of NEEI.

---

## 2. KPI methodology findings

### 2.1 Is there a standardized AMR fleet composite efficiency formula?

**No.** None of the standards reviewed (VDA 5050 v3.0, ISO 3691-4:2023, ISO 22400-2:2014, ANSI/A3 R15.08,
IEEE 1872/1872.2, ISO 18646-2, ASTM F45) defines a composite efficiency index for AMR fleets or multi-robot
coordination. VDA 5050 explicitly excludes traffic management logic. ISO 22400-2's composites (OEE, NEE)
are equipment-effectiveness products for manufacturing work units. Vendor "fleet health scores" exist
(Industry guidance, proprietary) but are not standards. Therefore **NEEI must remain labelled a
NodeX-defined experimental index** (as `src/data/neei.js` already states).

### 2.2 How the research community reports performance

| Metric | Definition as used in literature | Source |
|---|---|---|
| **Throughput** (lifelong MAPF) | "average number of goal locations visited per timestep" | Li et al., RHCR, AAAI 2021 **[V]** |
| **Tasks finished over horizon** | LoRR objective: maximise total tasks finished in a fixed horizon; online — agents *wait while the planner is still computing* (planning time is charged) | Chan et al., LoRR, ICAPS 2024 demo/competition paper **[V]** |
| **Service time** (MAPD) | average timesteps from task *added* until completed; algorithm "solves" instance iff service time bounded | Ma et al., AAMAS 2017 **[V]** |
| **Makespan / sum-of-costs** | one-shot MAPF only; CBS optimal for SoC; EECBS bounded-suboptimal | Sharon et al. 2015; Li et al. 2021 **[V-abs]** |
| **Throughput (tasks/unit time)** in production-like sortation | "number of tasks completed per unit time" | Yu & Wolf (Amazon Robotics), congestion prediction **[V]** |
| POGEMA protocol | success, path cost/throughput, coordination/congestion, scalability, out-of-distribution | Skrynnik et al., ICLR 2025 **[V-abs]** |

Practical rules derived from these sources:

1. **Lifelong/continuous workloads → throughput (tasks per sim-hour) is the primary metric**, not makespan.
   Makespan is only meaningful for a finite batch where every system completes all tasks.
2. **Charge planning/negotiation time to the system** (LoRR convention). If the centralized planner or an
   ACE session takes wall/sim time, robots must wait during it in the simulation; otherwise decentralized
   and centralized systems are compared unfairly in either direction.
3. **Report service time (task age at completion) distribution**, not only mean — auctions and priority
   schemes can starve individual tasks.
4. **Waiting fraction** = Σ waiting robot-time / Σ active robot-time is the MAPF analogue of ISO 22400
   `1 − allocation ratio`; it is the most direct congestion signal.
5. **Allocation latency** (task release → assignment) has no standard definition; define it in the report.

### 2.3 Composite index methodology (SAW / MCDA)

Source: Nardo, Saisana, Saltelli, Tarantola, Hoffmann, Giovannini, *Handbook on Constructing Composite
Indicators*, OECD/JRC 2008 (Industry guidance / methodological handbook) **[V-abs]**:
<https://publications.jrc.ec.europa.eu/repository/handle/JRC47008>. Key points: explicit theoretical
framework; normalisation choice changes rankings; **collinear indicators double-count** (two indicators
measuring one dimension give it weight w1+w2); linear aggregation is fully compensatory; sensitivity/
uncertainty analysis of weights is required.

Implications for NEEI v1.1 (current file `src/data/neei.js`):

* **Double counting risk:** for a run that completes all tasks, `T_ref/T_actual` and `X_actual/X_ref` are
  nearly the same quantity (throughput = tasks / time) → effectively 0.50 weight on speed. Either drop one
  (keep throughput for lifelong runs, makespan for batch runs) or report the correlation and keep both
  knowingly.
* **Relative-to-best normalisation** (`X/X_ref`) makes the index depend on which runs are in the reference
  set; publish the reference set with every score (already done) and add a sensitivity table (±0.1 weights).
* **Safety as gate, not component** is consistent with the handbook's non-compensability argument (a
  collision should not be compensable by throughput). Keep, but also report near-misses / minimum
  separation so the gate is not blind to risk.
* Always show raw KPIs next to NEEI; the index must never be the only evidence of "more efficient".

---

## 3. Topic sections

### 3.1 Centralized planning (baseline strength)

| Source | Type | Key point |
|---|---|---|
| Sharon, Stern, Felner, Sturtevant, *Conflict-based search for optimal MAPF*, Artificial Intelligence 219, 2015. https://www.sciencedirect.com/science/article/pii/S0004370214001386 | Peer-reviewed **[V-abs]** | Two-level: high-level constraint tree over conflicts, low-level single-agent search; optimal SoC |
| Li, Ruml, Koenig, *EECBS*, AAAI 2021. https://ojs.aaai.org/index.php/AAAI/article/view/17466 | Peer-reviewed **[V-abs]** | Bounded-suboptimal CBS (EES high level, focal low level, bypass, prioritized conflicts, symmetry reasoning); much faster than ECBS |
| Ma, Harabor, Stuckey, Li, Koenig, *Searching with Consistent Prioritization (PBS)*, AAAI 2019. https://arxiv.org/pdf/1812.06356 | Peer-reviewed **[V-abs]** | Searches over partial priority orders; strong quality/success at prioritized-planning speed; incomplete in general |
| Li, Tinka, Kiesel, Durham, Kumar, Koenig, *Lifelong MAPF in Large-Scale Warehouses (RHCR)*, AAAI 2021. https://arxiv.org/abs/2005.07371 | Peer-reviewed **[V]** | Windowed MAPF: resolve collisions only for w steps, replan every h ≤ w. Full-horizon resolution "often unnecessary" in lifelong settings; too small w can create **deadlocks** → progress potential function; scales to 1,000 agents |
| Okumura, *LaCAM*, AAAI 2023. https://arxiv.org/abs/2211.13432 | Peer-reviewed **[V-abs]** | Configuration-space search using PIBT as successor generator; very fast, strong for hundreds+ agents |
| Hönig, Kiesel, Tinka, Durham, Ayanian, *Persistent and robust execution of MAPF schedules in warehouses*, RA-L 4(2) 2019. https://whoenig.github.io/publications/2019_RA-L_Hoenig.pdf | Peer-reviewed **[V-abs]** | **Action Dependency Graph (ADG)**: execute a plan by precedence (who passes a vertex first) rather than by timestamp; tolerates delays, collision- and deadlock-free |

Implementable insights:

* **C1 — Keep the centralized baseline strong:** windowed replanning (RHCR-style, w≈5–20 steps, h≤w) and
  ADG execution are standard; a baseline that replans full horizons each step or executes by timestamp
  is a straw man.
* **C2 — Charge planning time** (see §2.2). CBS/EECBS runtime grows sharply with density; that is a real,
  legitimate cost of centralization — but only if it is simulated honestly.
* **C3 — ADG-style precedence execution** is the right primitive for NodeX coordination sessions too: a
  session outputs an *ordering* over contested vertices, not a timed trajectory.

### 3.2 Decentralized coordination

| Source | Type | Key point |
|---|---|---|
| Smith, *The Contract Net Protocol*, IEEE Trans. Computers 29(12), 1980. https://www.reidgsmith.com/The_Contract_Net_Protocol_Dec-1980.pdf | Peer-reviewed **[V-abs]** | Manager announces, contractors bid, manager awards |
| Dias, Zlot, Kalra, Stentz, *Market-based multirobot coordination: a survey*, Proc. IEEE 94(7), 2006. https://www.ri.cmu.edu/pub_files/2006/7/01677943-1.pdf | Peer-reviewed (survey) **[V-abs]** | Market methods: good efficiency/robustness trade-off; bid quality depends on cost model |
| Choi, Brunet, How, *Consensus-based decentralized auctions (CBAA/CBBA)*, IEEE T-RO 25(4), 2009. https://dspace.mit.edu/handle/1721.1/52330 | Peer-reviewed **[V-abs]** | Auction + local consensus on winning bids; provably converges to conflict-free assignment; robust to inconsistent situational awareness and topology changes |
| Okumura, Machida, Défago, Tamura, *PIBT*, IJCAI 2019 / AIJ 2022. https://arxiv.org/abs/1901.11282 | Peer-reviewed **[V]** | Priority p_i(t) = timesteps since last goal update + unique tie-break ε_i ∈ [0,1). Higher-priority agent pushing a lower one makes the lower one **inherit** priority; **backtracking** if the pushed agent cannot move. Reachability guaranteed on graphs where adjacent nodes lie on a cycle (e.g. biconnected). **"can be fully decentralized without global communication"** |
| Okumura, Tamura, Défago, *Time-Independent Planning (Causal-PIBT)*, AAAI 2021. https://ojs.aaai.org/index.php/AAAI/article/view/17347 | Peer-reviewed **[V-abs]** | Asynchronous, distributed PIBT variant with dependency tracking and deadlock detection/recovery |
| Ma, Li, Kumar, Koenig, *Lifelong MAPF for Online Pickup and Delivery (TP/TPTS)*, AAMAS 2017. https://www.ifaamas.org/Proceedings/aamas2017/pdfs/p837.pdf | Peer-reviewed **[V]** | Token Passing solves all **well-formed** MAPD instances; TP "can easily be extended to a fully distributed" algorithm; TPTS (task swaps) needs limited communication and "balances well" between TP and centralized. Notes that decentralized reactive and prioritized path planning "can result in deadlocks" |
| van den Berg, Guy, Lin, Manocha, *Reciprocal n-body collision avoidance (ORCA)*, ISRR 2009/2011. https://gamma.cs.unc.edu/ORCA/publications/ORCA.pdf | Peer-reviewed **[V-abs]** | Each agent takes half the responsibility; LP per step; no communication |
| Čáp, Gregoire, Frazzoli, *Provably safe and deadlock-free execution of multi-robot plans under delaying disturbances*, arXiv 1603.08582 (IROS 2016, venue [U]) | Preprint/peer-reviewed **[V]** | Reactive collision avoidance "may lead to deadlocks"; precedence-preserving execution of coordinated plans is safe and deadlock-free and more efficient than reactive techniques |
| Maoudj & Christensen, *Improved decentralized cooperative MAPF for robots with limited communication*, Swarm Intelligence 2023. https://link.springer.com/article/10.1007/s11721-023-00230-7 | Peer-reviewed **[V-abs]** | Decentralized MAPF under limited comm range in warehouses; trades optimality for scalability |

Implementable insights:

* **D1 — PIBT-style priority inheritance for the NEIGHBORHOOD envelope.** Replace pairwise "who yields"
  heuristics with: priority = steps since last goal progress + ε_id; when a robot needs a cell occupied by a
  lower-priority robot, that robot inherits priority and must move away (recursively), backtracking if
  stuck. Local, deterministic, no global search, resolves many deadlocks and starvation (waiting robots'
  priority rises every step).
* **D2 — ORCA-only local avoidance is known to deadlock in symmetric/narrow situations** (Robotica paper,
  Čáp et al.). On a grid, ORCA should be a last-layer safety filter, not the coordination mechanism.
* **D3 — Well-formed endpoints (TP):** robots park/idle only at non-task endpoints and never block pickup/
  drop nodes. Cheap, provably prevents a class of lifelong deadlocks; apply identically to all three systems.
* **D4 — CBBA consensus on bids** avoids duplicate awards under stale info; Contract-Net with a single
  manager round is weaker when information is stale.

### 3.3 Edge AI / learned coordination

| Source | Type | Key point |
|---|---|---|
| Li, Gama, Ribeiro, Prorok, *GNNs for decentralized multi-robot path planning*, IROS 2020. https://www.researchgate.net/publication/349280870 | Peer-reviewed **[V-abs]** | Local-comm GNN imitating a centralized expert |
| Li, Lin, Liu, Prorok, *MAGAT*, RA-L 6(3) 2021. https://github.com/proroklab/magat_pathplanning | Peer-reviewed **[V-abs]** | Attention over neighbour messages; approaches a coupled centralized expert |
| Veerapaneni et al., *Work Smarter Not Harder: Simple IL with CS-PIBT outperforms large-scale IL for MAPF*, arXiv 2409.14491 (2024) | Preprint **[V-abs]** | Large-scale imitation alone does "not produce impressive results"; adding **CS-PIBT collision shield** gives large gains; recommends always comparing against PIBT and using models for longer-horizon reasoning |
| Jiang et al., *SILLM: Scalable IL for lifelong MAPF (10,000 robots)*, arXiv 2410.21415 (2024) | Preprint **[V-abs]** | Learned policy + guidance + CS-PIBT: +16% over WPPL at 10k agents; learning wins only when combined with search-based guidance and a collision shield |
| Skrynnik et al., *POGEMA*, ICLR 2025. https://arxiv.org/abs/2407.14931 | Peer-reviewed **[V-abs]** | Unified benchmark; secondary sources report search-based LaCAM/RHCR still dominate pure learning **[U for that specific claim]** |
| Yu & Wolf (Amazon Robotics), *Congestion Prediction for Large Fleets of Mobile Robots* (Amazon Science PDF; venue [U]). https://cdn.amazon.science/8c/e5/80b4bc184aebb861fa764f8173cc/congestion-prediction-for-large-fleets-of-mobile-robots.pdf | Technical report / peer-reviewed venue [U] **[V]** | ConvLSTM predicts per-node delay over 6×10 s windows from history + planned paths. **Using predictions in the planner: +4.4% throughput.** Delay RMSE (0–10 s horizon): zero-baseline 1.90 s, **naive "last-10-s history" baseline 1.19 s**, ConvLSTM 0.92 s |
| Zahrádka, Woller et al., *Should I Replan? Learning to spot the right time in robust MAPF execution*, arXiv 2604.25567 (2026) | Preprint **[V-abs]** | Small FF network on ADG features decides *when* to replan; up to 94.6% of achievable delay reduction |
| Pham & Bera, *CRAMP: crowd-aware MAPF with GNN local comm*, arXiv 2309.10275 (IROS 2024 per authors) | Preprint/peer-reviewed **[V-abs]** | Crowd-density-aware decentralized RL; up to 59% makespan/collision improvement vs decentralized baselines |

Implementable insights:

* **E1 — Predict delay, not collision.** The most useful learned quantity is expected *delay per node per
  horizon window* (Yu & Wolf). In a 3–100 robot JS simulator a **non-learned predictor** (exponential moving
  average of observed waiting per node + planned-path occupancy counts) captures most of the benefit
  (history baseline already beats zero baseline by ~37% RMSE). Treat any learned model as an increment
  that must beat this EMA baseline.
* **E2 — Always wrap the predictor with a hard collision shield** (PIBT/reservation). A predictor must only
  bias *which* move/route is chosen, never be the safety mechanism.
* **E3 — Event-triggered inference:** run the predictor/RACE only when (a) a robot's planned path enters a
  node whose predicted delay exceeds a threshold, (b) a neighbour set changes, or (c) progress stalls — the
  "should I replan" result shows the decision of *when* to act matters as much as what to do.
* **E4 — When learning hurts:** out-of-distribution maps/densities, no collision shield, and comparisons
  without a PIBT/greedy baseline (Veerapaneni et al.). NodeX must report an "ACE without Edge-AI (rule
  only)" ablation.

### 3.4 Communication

| Source | Type | Key point |
|---|---|---|
| VDA 5050 v3.0 (above) | Published standard **[V]** | State published on relevant events or ≥ every 30 s; separate optional high-rate visualization topic |
| Ma, Luo, Pan, *Learning Selective Communication for MAPF (DCC)*, RA-L 2021. https://arxiv.org/abs/2109.05413 | Peer-reviewed **[V-abs]** | Broadcast is redundant and can impair cooperation; communicate with a neighbour only if its presence would change the agent's decision |
| Event-triggered multi-agent control literature, e.g. *Event-based distributed LQG for multi-robot coordination*, arXiv 2504.03125; *Time- vs event-triggered consensus*, arXiv 2303.11097 | Preprints **[V-abs]** | Transmit when state deviation from last broadcast exceeds a threshold (relative + absolute term); large message reductions with bounded error |
| Čáp et al.; Hönig et al. (above) | **[V]/[V-abs]** | Precedence-based execution tolerates delays that break time-indexed plans |

Implementable insights:

* **M1 — Event-triggered state broadcast:** send position/intent when (i) the robot deviates from its
  broadcast plan by ≥1 cell or ≥1 step of delay, (ii) its next-k-cell intent changes, (iii) it enters/leaves
  a zone, or (iv) a heartbeat timeout (VDA-style "event or every N s"). Count messages as a KPI.
* **M2 — Decision-causal neighbour selection:** only include neighbours whose planned next-k cells
  intersect the robot's own next-k cells (or who are within 2 cells); do not broadcast to fixed scopes.
* **M3 — Stale-state handling:** every received state carries a timestamp; treat an intent older than τ as
  *unknown occupancy* (conservatively reserve the robot's reachable set for age steps). Never plan through
  a stale neighbour's last-known cell.

### 3.5 Task allocation

| Source | Type | Key point |
|---|---|---|
| Ma et al., TP/TPTS, AAMAS 2017 (above) | Peer-reviewed **[V]** | Task swaps improve service time with limited communication |
| Liu, Ma, Li, Koenig, *Task and Path Planning for MAPD*, AAMAS 2019. https://www.ifaamas.org/Proceedings/aamas2019/pdfs/p1152.pdf | Peer-reviewed **[V-abs]** | Joint target assignment + path finding for lifelong MAPD |
| Zhang, Chen, Harabor, Le Bodic, Stuckey, *Flow-Based Task Assignment for Large-Scale Online MAPD*, arXiv 2508.05890 (2025) | Preprint **[V]** | Congestion-aware edge cost for assignment: `FCost(e) = 1 + p_v2 + c_e`, with vertex congestion `p_v = ceil((n_v−1)/2)` and contraflow `c_e = f(v1,v2)·f(v2,v1)`; or execution-based `PCost(e) = 1 + W_e/N_e` (average observed waiting, decayed). Min-cost flow assignment. +10.6% (600 agents) to +15.9% (20k) throughput vs greedy; reassigning every step can time out on huge maps |
| Koenig, Tovey, Lagoudakis et al., *The power of sequential single-item auctions*, AAAI 2006 (venue per citation, [U]) | Peer-reviewed **[V-abs]** | SSI: each round awards one task to the robot whose team-cost increase is smallest; regret clearing variants |
| Choi et al. CBBA (above) | Peer-reviewed **[V-abs]** | Marginal-gain bundle bids + consensus |

Implementable insights:

* **T1 — Congestion-aware bid:** `bid = ETA_free(robot→pickup) + Σ_{e∈path} predictedDelay(e) +
  queueDelay(pickup) + remainingWork(robot)`, where predictedDelay uses PCost (observed average waiting,
  exponentially decayed) and queueDelay = robots already assigned/heading to that pickup × service time.
* **T2 — Bounded task swapping:** before pickup, allow swap if two robots' summed ETA drops by > δ
  (hysteresis to avoid oscillation); limit to one swap per task.
* **T3 — Regret-aware award:** award first the task whose (second-best bid − best bid) is largest.
* **T4 — Reassignment cadence:** re-auction unstarted tasks on events (robot freed, big delay) rather than
  every tick.

### 3.6 Deadlock / cascade control and traffic guidance

| Source | Type | Key point |
|---|---|---|
| Chen, Harabor, Li, Stuckey, *Traffic Flow Optimisation for Lifelong MAPF*, AAAI 2024. https://arxiv.org/abs/2308.11234 | Peer-reviewed **[V]** | Guide paths computed with lexicographic cost (contraflow `f(u,v)·f(v,u)`, then `1 + p_v`), iteratively refined; PIBT follows guide heuristic. Warehouse throughput ≈23.6 vs 19.3 tasks/step for plain PIBT (~+22%); shifts peak-throughput density upward. (Sortation figure from tool summary not reliable — [U]) |
| Zhang, Jiang, Bhatt, Nikolaidis, Li, *Guidance Graph Optimization for Lifelong MAPF*, IJCAI 2024. https://arxiv.org/abs/2402.01446 | Peer-reviewed **[V]** | Directed edge weights + wait costs, optimized (CMA-ES/PIU): +8.6% to +17.7% throughput vs human crisscross highways; **soft** (asymmetric cost) directionality beats strict one-way |
| Cohen, Uras, Koenig, *Feasibility study: Using highways for bounded-suboptimal MAPF*, SoCS 2015 | Peer-reviewed **[V-abs]** | Inflate cost of non-highway moves by factor w → fewer head-on conflicts |
| Jiang, Zhang, Veerapaneni, Li, *Scaling Lifelong MAPF to More Realistic Settings*, SoCS 2024. https://arxiv.org/abs/2404.16162 | Peer-reviewed **[V-abs]** | Congestion and myopia are central; guidance/traffic rules, future prediction and **choosing the right number of agents** matter |
| Arita & Okumura, *Local Guidance for Configuration-Based MAPF*, AAAI-26 (arXiv 2510.19072); *Lifelong LaCAM with Local Guidance*, SoCS 2026 (arXiv 2605.16855) | Peer-reviewed (accepted) **[V-abs]** | Guidance computed only in each agent's vicinity, recomputed as agents move, improves quality at moderate cost; lifelong version surpasses existing planners in dense settings |
| Yoo, Sim, Cho, Jang (authorship [U]), *Cyclic deadlock prediction and avoidance for zone-controlled AGV system*, Int. J. Production Economics (2005, [U]). https://www.sciencedirect.com/science/article/abs/pii/S0925527302003705 | Peer-reviewed **[V-abs]** (search snippet only) | Project each vehicle's position one zone-step ahead; detect cycles in the resulting wait-for digraph before granting |
| Li et al., RHCR (above) | **[V]** | Short windows can livelock/deadlock; use a progress potential to detect it |

Implementable insights:

* **G1 — Wait-for-graph cycle detection:** each step, edge A→B if A's next cell is held/reserved by B. A
  cycle = circular wait. Resolve by PIBT push of the lowest-priority member into a free side cell, or, for
  a 2-cycle in a corridor, reverse the robot with fewer followers. Detect *before* granting a reservation
  (zone-control literature) rather than after a timeout.
* **G2 — Soft directional guidance:** add asymmetric costs to aisle edges (e.g. +0.5 against preferred
  direction) plus contraflow penalty `f(u,v)·f(v,u)` from currently planned paths. Soft, not strict one-way.
* **G3 — Congestion-propagation guard:** if a node's waiting count exceeds k, raise its cost for new plans
  and stop admitting new robots into the region (VDA 5050 RELEASE-zone-like lease).
* **G4 — Fleet-size/density admission:** throughput peaks then drops with density; admission control of
  robots into hot regions is legitimate and should be available to all systems for fairness when it is a
  generic traffic rule.

---

## 4. Opposing evidence / risks of decentralization

1. **Centralized is often faster/more efficient.** Jamshidpey et al. (arXiv 2408.06553, 2025; Artificial Life
   and Robotics 2025 per Springer listing) found centralized behaviours "often faster and more efficient",
   with decentralized advantages in fault tolerance/scalability smaller than expected **[V-abs]**. NodeX
   should expect the centralized baseline to win at low density and small fleets.
2. **Reactive avoidance deadlocks.** ORCA-type methods deadlock in symmetric/narrow configurations
   (Robotica paper; Čáp et al. **[V]**); decentralized prioritized planning can deadlock (Ma et al. 2017 **[V]**).
3. **Learned models alone underperform search** (Veerapaneni et al. 2024 **[V-abs]**). SILLM's gains depend on
   guidance + CS-PIBT. A simple history-average predictor gets much of the delay-prediction accuracy
   (Yu & Wolf **[V]**).
4. **Myopia and congestion.** Local decisions without global flow information create congestion; the best
   lifelong results use *global* guidance (Chen et al. 2024; Zhang et al. 2024 **[V]**). Pure local
   coordination has no mechanism for global flow balancing.
5. **Consensus/communication overhead.** Auction and consensus rounds cost time and messages; if the
   simulator does not charge negotiation latency, decentralized/ACE results are inflated.
6. **Evaluation bias risks.** Tuning NodeX on the evaluation scenarios, giving NodeX generic traffic rules
   (well-formed endpoints, soft highways, admission control) but not the baselines, or comparing
   against a time-indexed-execution centralized baseline with no windowing, would each fake an advantage.
7. **No standard backs a composite "efficiency" claim.** Any NEEI-based claim is NodeX-defined.

Mitigations: ablations (ACE rule-only vs with predictor), identical generic traffic rules for all systems
where they are not the contribution, seeds ≥ 10 with CIs, held-out scenarios, charge planning time.

---

## 5. Ranked improvements for NodeX (most promising, implementable)

Each item: research basis → mechanism → metric expected to move. Items marked **(generic)** are traffic
rules that must also be offered to the baselines when they are not NodeX-specific; NodeX's legitimate edge
is in *when/where* it escalates (ACE envelope) and in prediction-driven assignment.

| # | Improvement | Research basis | Mechanism (grid/graph, 3–100 robots) | Metric to move |
|---|---|---|---|---|
| 1 | **PIBT-style priority inheritance + backtracking inside NEIGHBORHOOD/CONTAINMENT sessions** | Okumura et al. IJCAI'19/AIJ'22; Causal-PIBT AAAI'21 | priority = steps since last goal progress + ε_id; pushes propagate priority; backtrack if pushed robot has no free cell; sessions output a vertex *precedence order* (ADG-style) | waiting fraction ↓, deadlock/stall count ↓, throughput ↑, tail service time ↓ |
| 2 | **Wait-for-graph cycle detection before reservation grant** (replaces timeout-based backoff) | Zone-control AGV deadlock prediction; RHCR deadlock example; Causal-PIBT deadlock detection | build A→B "waits-for" edges each step; on cycle, trigger CONTAINMENT with PIBT push/reversal of min-priority member | deadlock recoveries ↓ time-to-recover, throughput ↑ |
| 3 | **Delay predictor = EMA of observed waiting per node + planned-path occupancy, feeding RACE** (learned model only if it beats EMA) | Yu & Wolf (history baseline strong, +4.4% throughput with predictions); Flow-based MAPD PCost | predictedDelay(v,t+k) = EMA_wait(v) + α·(planned occupants of v in window k); RACE risk = f(predicted delay, contraflow, density) | prediction RMSE vs realised wait, waiting fraction ↓ |
| 4 | **Congestion-aware Contract-Net bids** | Flow-based MAPD (FCost/PCost); SSI auctions; CBBA | bid = ETA_free + Σ predictedDelay on route + queue at pickup + residual work; regret-first award | allocation quality: service time ↓, empty-travel ↓, throughput ↑ |
| 5 | **Contraflow-penalised soft guidance (generic)** | Chen et al. AAAI'24 (~+22% warehouse throughput); Zhang et al. IJCAI'24 (soft > strict one-way) | edge cost = 1 + p_v + f(u,v)·f(v,u) from current plans; small asymmetric aisle bias | head-on conflicts ↓, throughput ↑ at high density |
| 6 | **Event-triggered intent broadcast + decision-causal neighbour sets** | DCC (Ma, Luo, Pan RA-L'21); event-triggered control; VDA 5050 event/heartbeat rule | broadcast only on deviation/intent change/zone transition/heartbeat; neighbours = robots whose next-k cells intersect | messages per task ↓ (report it), no loss of throughput |
| 7 | **Stale-state conservatism** | Čáp et al.; Hönig ADG; VDA 5050 timestamps/leases | intent older than τ → reserve reachable set; leases (VDA RELEASE-like) with expiry for contested zones | collisions/near-misses stay 0 under comm delay; robustness in comm-degraded scenarios |
| 8 | **Bounded task swapping with hysteresis** | TPTS (Ma et al. AAMAS'17) | swap before pickup if ΣETA improves > δ; ≤1 swap/task | service time ↓, makespan ↓ for batch runs |
| 9 | **Event-triggered escalation of the ACE envelope ("should I escalate?")** | Zahrádka et al. 2026 (learn when to replan); RHCR progress potential | escalate LOCAL→NEIGHBORHOOD only when predicted delay > θ or progress potential stalls for m steps; de-escalate with hysteresis | session count ↓, session overhead ↓, throughput ↑ |
| 10 | **Well-formed endpoints and hot-zone admission leases (generic)** | TP well-formedness; SoCS'24 agent-number insight; VDA RELEASE zones | idle robots park only at non-task endpoints; cap concurrent robots in a hot zone via leases | deadlocks near stations ↓, throughput ↑ at high fleet size |

Also required for credible claims (not an algorithm): charge planning/negotiation time; ≥10 seeds with
95% CI; held-out scenarios; ablation "ACE rule-only" vs "ACE + predictor"; publish NEEI reference set and a
weight-sensitivity table; resolve the throughput/time-efficiency double counting in NEEI.

---

## Source list (retrieved during this review)

Standards/specs: VDA 5050 releases & spec (GitHub, VDA press) [V]; ISO 3691-4:2023 page [V-abs]; ISO/CD 3691-4
(88615) [V-abs, 403]; ISO 22400-2:2014 preview (iTeh) [V]; OPC UA MachineTool C.2 KPI formulas (Industry guidance) [V];
ANSI/A3 R15.08 [V-abs]; IEEE 1872/1872.2 [V-abs]; ISO 18646-2 [V-abs]; ASTM F45/NIST [V-abs].
Methodology: OECD/JRC Composite Indicators Handbook 2008 [V-abs]; LoRR (Chan et al., ICAPS 2024) [V]; POGEMA [V-abs].
Algorithms: CBS, EECBS, PBS, RHCR [V], LaCAM, PIBT [V], Causal-PIBT, TP/TPTS [V], MAPD task+path, Flow-based MAPD [V],
Traffic Flow Optimisation [V], Guidance Graph Optimization [V], highways (Cohen et al.), Local guidance / LLLG, SSI auctions,
CBBA, Contract Net, market survey, ORCA, Čáp et al. [V], Hönig ADG, GNN/MAGAT, CS-PIBT, SILLM, Yu & Wolf [V],
"Should I Replan?", DCC, CRAMP, Maoudj & Christensen, Jamshidpey et al., SoCS 2024 challenges.
Not verified / not relied upon: sortation-center figure in Chen et al. summary; exact authorship/year of the
zone-control cyclic-deadlock paper; exact venue of Yu & Wolf; the "centralized degrades beyond 30 tasks" claim
from arXiv 1803.04781 (PDF unreadable; excluded).
