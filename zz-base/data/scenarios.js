// ==========================================================================
// NODEX ACE - 14 System Comparison Scenarios, 12 ACE Tests & Map Registry
// Each scenario/test has full conditions, trigger timing, metrics, and
// acceptance criteria — used by ScenarioEngine to apply real sim conditions.
// ==========================================================================

export const TEST_TYPES = {
  SCENARIO: "scenario",
  ACE_TEST: "aceTest"
};

// ---------------------------------------------------------------------------
// 14 SYSTEM COMPARISON SCENARIOS
// ---------------------------------------------------------------------------

export const SCENARIOS = [
  {
    id: "C01", code: "S01",
    name: "Normal Warehouse Operation",
    description: "Standard pick/place operations under nominal load without induced faults. Used as baseline comparison across all three architectures.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 15,
      commLossRate: 0.0,
      healthDegradation: false
    },
    fault: "none",
    triggerAt: null,
    robotCount: 3,
    duration: 600,
    expectedBehavior: "All 3 architectures complete tasks without incident. ACE operates within LOCAL envelope.",
    expectedEnvelope: "LOCAL",
    metrics: ["taskCompletionTime","throughput","robotUtilization","systemHealth"],
    completionCriteria: { minThroughput: 1, zeroCollisions: true },
    failureCriteria: { anyCollision: true }
  },
  {
    id: "C02", code: "S02",
    name: "High Task Load",
    description: "Task arrival rate exceeds 2.5x nominal queue depth. Multiple tasks compete for robot resources simultaneously.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "HIGH",
      taskMultiplier: 2.5,
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 15,
      commLossRate: 0.0
    },
    fault: "task_burst",
    triggerAt: 5,
    robotCount: 10,
    duration: 600,
    expectedBehavior: "Decentralized task bidding distributes workload. ACE prevents queue cascade pressure from escalating risk above NEIGHBORHOOD.",
    expectedEnvelope: "NEIGHBORHOOD",
    metrics: ["taskCompletionTime","queueGrowth","robotUtilization","throughput"],
    completionCriteria: { minThroughput: 2 },
    failureCriteria: { queueGrowthAbove: 10 }
  },
  {
    id: "C03", code: "S03",
    name: "High Traffic / Congestion",
    description: "Narrow aisle bottleneck with bidirectional robot flow. High-density robot traffic creates increased interaction and queueing.",
    conditions: {
      trafficLevel: "HIGH",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 20,
      commLossRate: 0.0,
      robotCount: 20
    },
    fault: "congestion",
    triggerAt: 0,
    robotCount: 20,
    duration: 600,
    expectedBehavior: "ACE expands envelope to NEIGHBORHOOD, preventing bottleneck gridlock. Centralized assigns right-of-way sequentially. Decentralized negotiates peer-to-peer.",
    expectedEnvelope: "NEIGHBORHOOD",
    metrics: ["conflictFrequency","waitingTime","throughput","coordinationOverhead","raceRisk"],
    completionCriteria: { zeroCollisions: true },
    failureCriteria: { deadlockCount: 3 }
  },
  {
    id: "C04", code: "S04",
    name: "Crossing / Bottleneck Conflict",
    description: "Two robots on intersecting trajectories at Aisle A-12 crossing. Tests right-of-way arbitration mechanism.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 15,
      commLossRate: 0.0,
      seedCrossingConflict: true
    },
    fault: "crossing_conflict",
    triggerAt: 0,
    robotCount: 3,
    duration: 300,
    expectedBehavior: "Space-time contract negotiation assigns right-of-way cleanly. Centralized assigns priority. ACE negotiates peer contract.",
    expectedEnvelope: "NEIGHBORHOOD",
    metrics: ["conflictResolutionTime","waitingTime","contractsNegotiated"],
    completionCriteria: { zeroCollisions: true, conflictsResolved: 1 },
    failureCriteria: { anyCollision: true }
  },
  {
    id: "C05", code: "S05",
    name: "Dynamic Obstacle",
    description: "Sudden pallet drop or human worker crossing active transport lane. Obstacle appears during active robot navigation.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: true,
      obstacleAt: { x: 352, y: 305 },
      commLatencyMs: 15,
      commLossRate: 0.0
    },
    fault: "dynamic_obstacle",
    triggerAt: 30,
    robotCount: 3,
    duration: 300,
    expectedBehavior: "Robots detect and replan around obstacle. ACE risk increases transiently. All architectures avoid obstacle.",
    expectedEnvelope: "NEIGHBORHOOD",
    metrics: ["reroutes","waitingTime","obstacleAvoidanceTime"],
    completionCriteria: { zeroCollisions: true },
    failureCriteria: { anyCollision: true }
  },
  {
    id: "C06", code: "S06",
    name: "Communication Delay",
    description: "Network latency increases to 350ms in high-rack metal zones. Affects coordination layer bandwidth.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "DEGRADED",
      commLatencyMs: 350,
      commLossRate: 0.05,
      dynamicObstacles: false
    },
    fault: "comm_delay",
    triggerAt: 10,
    robotCount: 3,
    duration: 600,
    expectedBehavior: "RACE increases communication-risk component. ACE enlarges safety buffer. Centralized becomes less responsive.",
    expectedEnvelope: "NEIGHBORHOOD",
    metrics: ["communicationRisk","coordinationLatency","throughput"],
    completionCriteria: { minThroughput: 0.5 },
    failureCriteria: { communicationRiskAbove: 0.8 }
  },
  {
    id: "C07", code: "S07",
    name: "Communication Loss",
    description: "Dead zone causing 5-second packet drops on target peer cluster. Tests graceful degradation.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "LOSS",
      commLatencyMs: 1000,
      commLossRate: 0.8,
      dynamicObstacles: false
    },
    fault: "comm_loss",
    triggerAt: 20,
    robotCount: 3,
    duration: 600,
    expectedBehavior: "Graceful degradation into SAFE-DEGRADED without system panic. ACE enables local-only operation. Centralized partially fails.",
    expectedEnvelope: "SAFE-DEGRADED",
    metrics: ["safeDegradedDuration","communicationRisk","tasksCompletedDuringLoss"],
    completionCriteria: { noPanic: true },
    failureCriteria: { systemStop: true }
  },
  {
    id: "C08", code: "S08",
    name: "Robot Failure",
    description: "R02 suffers sudden drive motor fault at 00:02:15 while carrying Task T-204. Tests task reallocation and fleet recovery.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 15,
      commLossRate: 0.0,
      targetFailureRobot: "R02"
    },
    fault: "robot_failure",
    triggerAt: 135,
    robotCount: 3,
    duration: 600,
    expectedBehavior: "Failed robot isolates itself; task lease expires; nearest peer re-bids and recovers task. Centralized re-assigns from server. ACE peer reallocation.",
    expectedEnvelope: "NEIGHBORHOOD",
    metrics: ["failureDetectionTime","taskReallocationTime","fleetRecovery"],
    completionCriteria: { taskReallocated: true },
    failureCriteria: { taskLost: true }
  },
  {
    id: "C09", code: "S09",
    name: "Deadlock Scenario",
    description: "Cyclic 4-robot wait-for dependency in cross aisle intersection. Tests deadlock detection and resolution.",
    conditions: {
      trafficLevel: "HIGH",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 15,
      commLossRate: 0.0,
      seedDeadlock: true
    },
    fault: "deadlock",
    triggerAt: 0,
    robotCount: 10,
    duration: 300,
    expectedBehavior: "Deadlock detection algorithm detects wait-for cycle and triggers backoff/replan. Centralized resolves via global view. ACE resolves via peer detection.",
    expectedEnvelope: "CONTAINMENT",
    metrics: ["deadlockDetectionTime","deadlockResolutionTime","deadlockCount"],
    completionCriteria: { deadlocksResolved: 1 },
    failureCriteria: { deadlockPersistsBeyond: 60 }
  },
  {
    id: "C10", code: "S10",
    name: "Sensor / Localization Uncertainty",
    description: "LiDAR feature-drop causes pose covariance to surge above 0.35m. Tests uncertainty propagation.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 15,
      commLossRate: 0.0,
      uncertaintyLevel: "HIGH",
      poseUncertaintyM: 0.35
    },
    fault: "sensor_noise",
    triggerAt: 15,
    robotCount: 3,
    duration: 600,
    expectedBehavior: "RACE uncertainty input scales velocity limit and expands clearance buffer. ACE adapts coordination scope.",
    expectedEnvelope: "NEIGHBORHOOD",
    metrics: ["uncertaintyRisk","velocityAdaptation","collisionCloseCallCount"],
    completionCriteria: { zeroCollisions: true },
    failureCriteria: { anyCollision: true }
  },
  {
    id: "C11", code: "S11",
    name: "Task Lease Expiry / Reallocation",
    description: "Robot stalled due to obstacle; lease TTL expires after 45 seconds. Tests contract-net reallocation.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: true,
      obstacleAt: { x: 212, y: 305 },
      commLatencyMs: 15,
      commLossRate: 0.0,
      leaseTtlSeconds: 45
    },
    fault: "lease_expiry",
    triggerAt: 20,
    robotCount: 3,
    duration: 600,
    expectedBehavior: "Contract-Net auction triggers automated task reallocation without central server. Previous robot releases lease. New robot picks up task.",
    expectedEnvelope: "LOCAL",
    metrics: ["leaseExpiryCount","reallocationTime","taskContinuityRate"],
    completionCriteria: { taskReallocated: true },
    failureCriteria: { taskLost: true }
  },
  {
    id: "C12", code: "S12",
    name: "Progressive Robot Health Degradation",
    description: "Battery voltage sag and traction motor heat warning on R02. Health degrades progressively over 5 minutes.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 15,
      commLossRate: 0.0,
      healthDegradation: true,
      targetHealthRobot: "R02",
      degradationRate: 0.5
    },
    fault: "health_degrade",
    triggerAt: 30,
    robotCount: 3,
    duration: 600,
    expectedBehavior: "Health monitor lowers bidding capacity. Auto-dispatches to charging dock when health < 30%. ACE health factor increases risk contribution.",
    expectedEnvelope: "NEIGHBORHOOD",
    metrics: ["healthDegradationRate","taskRedistribution","chargingDispatch"],
    completionCriteria: { robotReachesCharger: true },
    failureCriteria: { robotHealthZero: true }
  },
  {
    id: "C13", code: "S13",
    name: "Combined Stress Scenario",
    description: "Concurrent communication latency + robot stall + 2x task surge. Maximum resilience boundary test.",
    conditions: {
      trafficLevel: "HIGH",
      taskLoad: "HIGH",
      taskMultiplier: 2.0,
      communication: "DEGRADED",
      commLatencyMs: 250,
      commLossRate: 0.1,
      dynamicObstacles: true,
      healthDegradation: true,
      targetFailureRobot: "R03",
      targetHealthRobot: "R02"
    },
    fault: "stress_test",
    triggerAt: 30,
    robotCount: 10,
    duration: 900,
    expectedBehavior: "Resilience boundary test. ACE preserves fleet throughput without single failure cascade. Centralized may partially fail. Decentralized degrades gracefully.",
    expectedEnvelope: "CONTAINMENT",
    metrics: ["systemResilience","throughput","failureCascadeCount","taskCompletionRate"],
    completionCriteria: { minThroughput: 0.3 },
    failureCriteria: { completeSystemStop: true }
  },
  {
    id: "C14", code: "S14",
    name: "Central Coordinator / Central Link Failure",
    description: "Central dispatch server drops offline while peer network remains active. Tests architecture dependency.",
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      dynamicObstacles: false,
      commLatencyMs: 15,
      commLossRate: 0.0,
      centralCoordinatorFailure: true
    },
    fault: "central_link_failure",
    triggerAt: 60,
    robotCount: 3,
    duration: 600,
    expectedBehavior: "CENTRALIZED: Fleet stops or degrades severely. DECENTRALIZED: Continues normally (no central dependency). ACE: Continues via peer coordination.",
    expectedEnvelope: "LOCAL",
    metrics: ["architectureDependency","throughputAfterFailure","recoveryTime"],
    completionCriteria: { architectureDemonstrated: true },
    failureCriteria: { aceStopsDueToCoordinatorLoss: true }
  }
];

// ---------------------------------------------------------------------------
// 12 ACE TESTS  (A01 – A12)
// ---------------------------------------------------------------------------

export const ACE_TESTS = [
  {
    id: "A01", code: "A01",
    name: "Adaptive Coordination Lifecycle",
    description: "Verify full ACE lifecycle transition: LOCAL → NEIGHBORHOOD → CONTAINMENT → SAFE-DEGRADED as risk escalates.",
    purpose: "Validate that ACE coordination envelope transitions are driven by real risk, not timers.",
    triggerCondition: "Progressively increase conflict risk in 4 steps (0.3, 0.55, 0.72, 0.9)",
    expectedAceResponse: "Each threshold crossed triggers envelope expansion. Hysteresis prevents flapping.",
    triggerAt: 10,
    robotCount: 3,
    duration: 300,
    conditions: {
      trafficLevel: "HIGH",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      seedCrossingConflict: true,
      progressiveRiskEscalation: true
    },
    metrics: ["envelopeTransitions","raceRiskScore","hysteresisHold"],
    passCriteria: "All 4 transitions occur in correct order. No flapping within 4s dwell window.",
    failCriteria: "Transition skipped, reversed, or occurs without risk crossing threshold."
  },
  {
    id: "A02", code: "A02",
    name: "Multi-Factor Risk Composition",
    description: "Verify that RACE risk score correctly composes conflict + uncertainty + commRisk + queueGrowth + cascadePressure.",
    purpose: "Validate the risk model produces correct combined scores for each input factor.",
    triggerCondition: "Set each risk component independently and verify composite score.",
    expectedAceResponse: "Combined risk = weighted sum. Individual factors produce isolated responses.",
    triggerAt: 5,
    robotCount: 3,
    duration: 180,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      multiFactorRiskTest: true
    },
    metrics: ["raceRiskScore","riskComponents","weightValidation"],
    passCriteria: "Risk score within ±0.05 of expected weighted sum for each test input.",
    failCriteria: "Any factor dominates incorrectly or composite score deviates > 0.1."
  },
  {
    id: "A03", code: "A03",
    name: "Communication-Risk Adaptation",
    description: "Increase communication risk factor and verify adaptive coordination response.",
    purpose: "Validate that comm degradation directly influences RACE risk and ACE envelope expansion.",
    triggerCondition: "Inject comm latency 350ms at t=10s, loss 50% at t=30s.",
    expectedAceResponse: "Communication risk factor rises. Envelope expands to NEIGHBORHOOD then CONTAINMENT.",
    triggerAt: 10,
    robotCount: 3,
    duration: 300,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "DEGRADED",
      commLatencyMs: 350,
      commLossRate: 0.5
    },
    metrics: ["communicationRisk","envelopeExpansion","safeSpeedCap"],
    passCriteria: "commRisk > 0.6 when latency > 300ms. NEIGHBORHOOD engaged.",
    failCriteria: "Envelope stays LOCAL despite high comm risk."
  },
  {
    id: "A04", code: "A04",
    name: "Cascade Pressure Handling",
    description: "Increase cascade pressure (stalled robots creating queue backup) and verify containment response.",
    purpose: "Validate that queue backup triggers CONTAINMENT envelope and speed reduction.",
    triggerCondition: "Stall 2 robots in bottleneck to create cascade pressure > 0.7.",
    expectedAceResponse: "Cascade pressure component escalates risk. CONTAINMENT envelope activated.",
    triggerAt: 15,
    robotCount: 10,
    duration: 300,
    conditions: {
      trafficLevel: "HIGH",
      taskLoad: "HIGH",
      communication: "NOMINAL",
      cascadePressureTest: true
    },
    metrics: ["cascadePressure","envelopeState","queueDepth","throughput"],
    passCriteria: "CONTAINMENT activated when cascade pressure > 0.7.",
    failCriteria: "Queue grows unbounded without envelope response."
  },
  {
    id: "A05", code: "A05",
    name: "Space-Time Contract",
    description: "Create a crossing conflict and verify that a valid space-time contract is negotiated and honored.",
    purpose: "Validate peer-to-peer contract negotiation for shared resource access.",
    triggerCondition: "Seed R01 and R02 on crossing trajectories at (352, 305).",
    expectedAceResponse: "Contract negotiated. Winner traverses. Yielder holds. Contract released after traversal.",
    triggerAt: 0,
    robotCount: 3,
    duration: 180,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      seedCrossingConflict: true
    },
    metrics: ["contractsNegotiated","contractDuration","rightOfWayAssigned"],
    passCriteria: "1 contract negotiated. 0 collisions. Yielder resumes after winner clears.",
    failCriteria: "Collision occurs OR contract never negotiated."
  },
  {
    id: "A06", code: "A06",
    name: "Conflict Detection & Resolution",
    description: "Create a potential conflict between converging robots and verify detection and resolution pipeline.",
    purpose: "Validate that the conflict detection system identifies and resolves robot-robot conflicts.",
    triggerCondition: "Place R01 and R02 converging at < 40px separation.",
    expectedAceResponse: "Conflict detected. Priority assigned. One robot yields. Conflict cleared within 10s.",
    triggerAt: 0,
    robotCount: 3,
    duration: 180,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      seedConflict: true
    },
    metrics: ["conflictDetectionTime","conflictResolutionTime","yieldingRobot"],
    passCriteria: "Conflict detected within 2s. Resolved within 10s. 0 collisions.",
    failCriteria: "Collision occurs OR conflict unresolved after 30s."
  },
  {
    id: "A07", code: "A07",
    name: "Peer-Based Coordination",
    description: "Verify that robots coordinate directly with peers without any central coordinator involvement.",
    purpose: "Validate decentralized peer coordination under ACE mode.",
    triggerCondition: "Run S01 scenario in ACE mode with coordinator disabled.",
    expectedAceResponse: "Robots exchange peer messages, negotiate contracts, complete tasks without central server.",
    triggerAt: 0,
    robotCount: 3,
    duration: 300,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      forcePeerOnly: true
    },
    metrics: ["peerMessages","contractsNegotiated","centralCoordinatorCalls"],
    passCriteria: "Zero central coordinator calls. All tasks completed via peer negotiation.",
    failCriteria: "Central coordinator used OR tasks incomplete."
  },
  {
    id: "A08", code: "A08",
    name: "Deadlock Detection & Resolution",
    description: "Create conditions producing a cyclic deadlock and verify detection and resolution.",
    purpose: "Validate wait-for graph detection and backoff/replan resolution.",
    triggerCondition: "Seed 3 robots in cyclic wait pattern at crossing aisles.",
    expectedAceResponse: "Wait-for cycle detected within 5s. Backoff triggered on 1 robot. Deadlock resolved.",
    triggerAt: 0,
    robotCount: 3,
    duration: 180,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      seedDeadlock: true
    },
    metrics: ["deadlockDetectionTime","deadlockResolutionTime","backoffCount"],
    passCriteria: "Deadlock detected < 5s. Resolved < 30s. 0 collisions.",
    failCriteria: "Deadlock persists beyond 60s OR collision occurs."
  },
  {
    id: "A09", code: "A09",
    name: "Dynamic Task Reallocation",
    description: "Trigger task reallocation (via lease expiry or robot failure) and verify seamless reassignment.",
    purpose: "Validate that the Contract-Net protocol reallocates tasks correctly.",
    triggerCondition: "Fail R02 at t=30s while it holds Task T-01.",
    expectedAceResponse: "Task lease released. Contract-Net auction triggers. Nearest eligible robot re-bids and takes task.",
    triggerAt: 30,
    robotCount: 3,
    duration: 300,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      targetFailureRobot: "R02"
    },
    metrics: ["reallocationTime","taskCompletionRate","auctionWinner"],
    passCriteria: "Task reallocated within 15s. Task eventually completed by new robot.",
    failCriteria: "Task lost OR reallocation takes > 60s."
  },
  {
    id: "A10", code: "A10",
    name: "Health-Aware Adaptation",
    description: "Degrade robot health progressively and verify health-aware task assignment and speed adaptation.",
    purpose: "Validate that degraded health reduces bidding priority and triggers charging dispatch.",
    triggerCondition: "Degrade R02 health from 100% to 15% over 3 minutes.",
    expectedAceResponse: "Bidding weight decreases. Task reassigned. R02 dispatched to charging dock.",
    triggerAt: 30,
    robotCount: 3,
    duration: 300,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      healthDegradation: true,
      targetHealthRobot: "R02",
      degradationRate: 0.4
    },
    metrics: ["healthDegradationRate","biddingWeight","chargingDispatch"],
    passCriteria: "R02 dispatched to charger when health < 30%.",
    failCriteria: "R02 continues full operations despite critical health."
  },
  {
    id: "A11", code: "A11",
    name: "Safe-Degraded Operation",
    description: "Trigger conditions requiring SAFE-DEGRADED mode and verify correct system behavior.",
    purpose: "Validate that SAFE-DEGRADED mode activates when risk is critical and maintains minimum-safe operation.",
    triggerCondition: "Combine comm loss + health degradation + cascading faults to push risk > 0.85.",
    expectedAceResponse: "SAFE-DEGRADED envelope activates. Speed capped at 0.3 m/s. Non-critical tasks suspended.",
    triggerAt: 10,
    robotCount: 3,
    duration: 300,
    conditions: {
      trafficLevel: "HIGH",
      taskLoad: "NORMAL",
      communication: "LOSS",
      commLossRate: 0.8,
      healthDegradation: true,
      targetHealthRobot: "R02"
    },
    metrics: ["envelopeState","speedCap","tasksCompleted","systemStability"],
    passCriteria: "SAFE-DEGRADED activated. No complete system stop. Speed < 0.35 m/s.",
    failCriteria: "Complete system stop OR collision in SAFE-DEGRADED mode."
  },
  {
    id: "A12", code: "A12",
    name: "Human-In-the-Loop Control",
    description: "Verify full HITL intervention flow: autonomous operation → intervention request → human decision → robot action → return to autonomous.",
    purpose: "Validate end-to-end HITL pipeline including safety validation and audit logging.",
    triggerCondition: "At t=20s, operator dispatches Hold Fleet command via HITL panel.",
    expectedAceResponse: "Command passes safety validation. All robots stop. Audit logged. Operator releases via Resume. Robots return to autonomous.",
    triggerAt: 20,
    robotCount: 3,
    duration: 180,
    conditions: {
      trafficLevel: "NORMAL",
      taskLoad: "NORMAL",
      communication: "NOMINAL",
      hitlTest: true
    },
    metrics: ["hitlLatency","safetyValidationResult","robotStopTime","auditLog","resumeTime"],
    passCriteria: "All robots stop within 1s of command. Audit entry created. Robots resume on RESUME command.",
    failCriteria: "Any robot ignores HITL command OR safety validation bypassed."
  }
];

// ---------------------------------------------------------------------------
// MAP REGISTRY
// ---------------------------------------------------------------------------

export const MAPS_REGISTRY = [
  {
    id: "WH-A",
    name: "Warehouse-A v3",
    version: "v3.2.1",
    facility: "Main Facility, Coimbatore",
    area: "50,000 m²",
    zonesCount: 5,
    checksum: "sha256:7f9a88c42b10",
    description: "Approved SIH prototype layout with high-bay storage, crossing aisles, and charging zone.",
    isDefault: true
  },
  {
    id: "WH-B",
    name: "Warehouse-B v2",
    version: "v2.0.4",
    facility: "Regional Hub, Bangalore",
    area: "85,000 m²",
    zonesCount: 8,
    checksum: "sha256:3a1c84d99e01",
    description: "Multi-tier mezzanine warehouse with dense cross-docking lanes."
  },
  {
    id: "WH-C",
    name: "Warehouse-C v1",
    version: "v1.5.0",
    facility: "Fulfillment Center, Chennai",
    area: "35,000 m²",
    zonesCount: 4,
    checksum: "sha256:99e2f41bc887",
    description: "High-speed goods-to-person picking facility."
  }
];
