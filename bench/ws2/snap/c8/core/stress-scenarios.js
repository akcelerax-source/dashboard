// ==========================================================================
// NODEX ACE — Phase 6 Progressive Stress Scenario Framework (Levels 1 to 10)
// Configures deterministic, identical testing conditions across Centralized,
// Decentralized, and ACE/RACE architectures.
// ==========================================================================

import { WAREHOUSE_TASK_LOCATIONS } from "./centralized/TaskManager.js";

export const STRESS_SCENARIOS = [
  {
    level: 1,
    scenarioId: "STRESS-L01",
    name: "Normal Operation (Nominal Flow)",
    description: "Standard pick/place operations under nominal load without induced faults or bottlenecks.",
    map: "WH-A",
    robotCount: 3,
    randomSeed: 10001,
    initialPositions: [
      { id: "R1", x: 145, y: 165 },
      { id: "R2", x: 620, y: 165 },
      { id: "R3", x: 352, y: 455 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 145, y: 165 }, destination: { x: 352, y: 165 }, priority: "MEDIUM" },
      { id: "T-02", pickup: { x: 620, y: 165 }, destination: { x: 800, y: 455 }, priority: "HIGH" },
      { id: "T-03", pickup: { x: 352, y: 455 }, destination: { x: 145, y: 455 }, priority: "LOW" }
    ],
    obstacles: [],
    dynamicEvents: [],
    communicationConditions: { packetLossRate: 0.0, latencyMs: 15, jitterMs: 2 },
    failureConditions: { failedRobots: [] },
    riskConditions: { expectedMaxRisk: 0.25, dominantEnvelope: "LOCAL" },
    expectedBehavior: "All 3 architectures complete tasks without incident; ACE operates strictly within LOCAL envelope (zero unnecessary escalation).",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      maxEscalations: 0,
      completionRateMin: 100
    }
  },
  {
    level: 2,
    scenarioId: "STRESS-L02",
    name: "Moderate Congestion",
    description: "5 AMRs operating in shared bidirectional corridors with localized traffic crossings.",
    map: "WH-A",
    robotCount: 5,
    randomSeed: 10002,
    initialPositions: [
      { id: "R1", x: 145, y: 165 },
      { id: "R2", x: 352, y: 165 },
      { id: "R3", x: 620, y: 165 },
      { id: "R4", x: 145, y: 305 },
      { id: "R5", x: 620, y: 305 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 145, y: 165 }, destination: { x: 620, y: 165 }, priority: "MEDIUM" },
      { id: "T-02", pickup: { x: 620, y: 165 }, destination: { x: 145, y: 165 }, priority: "HIGH" },
      { id: "T-03", pickup: { x: 352, y: 165 }, destination: { x: 352, y: 455 }, priority: "MEDIUM" },
      { id: "T-04", pickup: { x: 145, y: 305 }, destination: { x: 620, y: 305 }, priority: "LOW" },
      { id: "T-05", pickup: { x: 620, y: 305 }, destination: { x: 145, y: 305 }, priority: "HIGH" }
    ],
    obstacles: [],
    dynamicEvents: [],
    communicationConditions: { packetLossRate: 0.02, latencyMs: 25, jitterMs: 5 },
    failureConditions: { failedRobots: [] },
    riskConditions: { expectedMaxRisk: 0.45, dominantEnvelope: "LOCAL" },
    expectedBehavior: "Smooth conflict avoidance in corridors; minimal queueing; ACE holds LOCAL with minor transient risk elevations.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 90
    }
  },
  {
    level: 3,
    scenarioId: "STRESS-L03",
    name: "High Congestion",
    description: "7 AMRs concentrated in central warehouse corridors causing queue buildup at main crossings.",
    map: "WH-A",
    robotCount: 7,
    randomSeed: 10003,
    initialPositions: [
      { id: "R1", x: 145, y: 165 },
      { id: "R2", x: 212, y: 165 },
      { id: "R3", x: 352, y: 165 },
      { id: "R4", x: 620, y: 165 },
      { id: "R5", x: 145, y: 305 },
      { id: "R6", x: 352, y: 305 },
      { id: "R7", x: 620, y: 305 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 145, y: 165 }, destination: { x: 620, y: 305 }, priority: "HIGH" },
      { id: "T-02", pickup: { x: 620, y: 165 }, destination: { x: 145, y: 305 }, priority: "MEDIUM" },
      { id: "T-03", pickup: { x: 352, y: 165 }, destination: { x: 352, y: 455 }, priority: "HIGH" },
      { id: "T-04", pickup: { x: 212, y: 165 }, destination: { x: 620, y: 165 }, priority: "LOW" },
      { id: "T-05", pickup: { x: 145, y: 305 }, destination: { x: 620, y: 165 }, priority: "MEDIUM" },
      { id: "T-06", pickup: { x: 352, y: 305 }, destination: { x: 145, y: 165 }, priority: "HIGH" },
      { id: "T-07", pickup: { x: 620, y: 305 }, destination: { x: 352, y: 165 }, priority: "LOW" }
    ],
    obstacles: [],
    dynamicEvents: [],
    communicationConditions: { packetLossRate: 0.05, latencyMs: 50, jitterMs: 10 },
    failureConditions: { failedRobots: [] },
    riskConditions: { expectedMaxRisk: 0.62, dominantEnvelope: "NEIGHBORHOOD" },
    expectedBehavior: "Queue accumulation triggers RACE risk increase; ACE escalates to NEIGHBORHOOD for robots near hotspot; de-escalation holds properly.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 80
    }
  },
  {
    level: 4,
    scenarioId: "STRESS-L04",
    name: "Multiple Simultaneous Conflicts",
    description: "6 AMRs converging simultaneously on intersecting trajectory paths at Central Crossing (352, 305).",
    map: "WH-A",
    robotCount: 6,
    randomSeed: 10004,
    initialPositions: [
      { id: "R1", x: 145, y: 305 },
      { id: "R2", x: 620, y: 305 },
      { id: "R3", x: 352, y: 165 },
      { id: "R4", x: 352, y: 455 },
      { id: "R5", x: 212, y: 305 },
      { id: "R6", x: 500, y: 305 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 145, y: 305 }, destination: { x: 620, y: 305 }, priority: "HIGH" },
      { id: "T-02", pickup: { x: 620, y: 305 }, destination: { x: 145, y: 305 }, priority: "HIGH" },
      { id: "T-03", pickup: { x: 352, y: 165 }, destination: { x: 352, y: 455 }, priority: "MEDIUM" },
      { id: "T-04", pickup: { x: 352, y: 455 }, destination: { x: 352, y: 165 }, priority: "MEDIUM" },
      { id: "T-05", pickup: { x: 212, y: 305 }, destination: { x: 352, y: 455 }, priority: "LOW" },
      { id: "T-06", pickup: { x: 500, y: 305 }, destination: { x: 352, y: 165 }, priority: "LOW" }
    ],
    obstacles: [],
    dynamicEvents: [],
    communicationConditions: { packetLossRate: 0.03, latencyMs: 30, jitterMs: 5 },
    failureConditions: { failedRobots: [] },
    riskConditions: { expectedMaxRisk: 0.68, dominantEnvelope: "NEIGHBORHOOD" },
    expectedBehavior: "Multi-robot priority arbitration; non-overlapping space-time contracts negotiated; zero collisions.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 80
    }
  },
  {
    level: 5,
    scenarioId: "STRESS-L05",
    name: "Severe Coordination Pressure",
    description: "8 AMRs operating in dense proximity around main storage racks; multiple overlapping missions.",
    map: "WH-A",
    robotCount: 8,
    randomSeed: 10005,
    initialPositions: [
      { id: "R1", x: 145, y: 165 }, { id: "R2", x: 212, y: 165 },
      { id: "R3", x: 352, y: 165 }, { id: "R4", x: 620, y: 165 },
      { id: "R5", x: 145, y: 305 }, { id: "R6", x: 212, y: 305 },
      { id: "R7", x: 352, y: 305 }, { id: "R8", x: 620, y: 305 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 145, y: 165 }, destination: { x: 620, y: 305 }, priority: "HIGH" },
      { id: "T-02", pickup: { x: 620, y: 165 }, destination: { x: 145, y: 305 }, priority: "HIGH" },
      { id: "T-03", pickup: { x: 212, y: 165 }, destination: { x: 352, y: 455 }, priority: "MEDIUM" },
      { id: "T-04", pickup: { x: 352, y: 165 }, destination: { x: 212, y: 305 }, priority: "MEDIUM" },
      { id: "T-05", pickup: { x: 145, y: 305 }, destination: { x: 620, y: 165 }, priority: "LOW" },
      { id: "T-06", pickup: { x: 212, y: 305 }, destination: { x: 145, y: 165 }, priority: "LOW" },
      { id: "T-07", pickup: { x: 352, y: 305 }, destination: { x: 620, y: 455 }, priority: "HIGH" },
      { id: "T-08", pickup: { x: 620, y: 305 }, destination: { x: 352, y: 165 }, priority: "MEDIUM" }
    ],
    obstacles: [],
    dynamicEvents: [],
    communicationConditions: { packetLossRate: 0.05, latencyMs: 40, jitterMs: 8 },
    failureConditions: { failedRobots: [] },
    riskConditions: { expectedMaxRisk: 0.76, dominantEnvelope: "CONTAINMENT" },
    expectedBehavior: "ACE expands to CONTAINMENT in hotspot region; coordinates clustered peers while un-impacted periphery remains LOCAL.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 70
    }
  },
  {
    level: 6,
    scenarioId: "STRESS-L06",
    name: "Communication Degradation",
    description: "Wireless network suffers 350ms latency and 25% packet drop in metal rack sector.",
    map: "WH-A",
    robotCount: 4,
    randomSeed: 10006,
    initialPositions: [
      { id: "R1", x: 145, y: 165 },
      { id: "R2", x: 352, y: 165 },
      { id: "R3", x: 620, y: 165 },
      { id: "R4", x: 352, y: 305 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 145, y: 165 }, destination: { x: 620, y: 165 }, priority: "HIGH" },
      { id: "T-02", pickup: { x: 620, y: 165 }, destination: { x: 145, y: 165 }, priority: "MEDIUM" },
      { id: "T-03", pickup: { x: 352, y: 165 }, destination: { x: 352, y: 455 }, priority: "LOW" },
      { id: "T-04", pickup: { x: 352, y: 305 }, destination: { x: 145, y: 305 }, priority: "HIGH" }
    ],
    obstacles: [],
    dynamicEvents: [
      { type: "COMM_DEGRADATION", startSec: 2, endSec: 10, latencyMs: 350, packetLoss: 0.25 }
    ],
    communicationConditions: { packetLossRate: 0.25, latencyMs: 350, jitterMs: 50 },
    failureConditions: { failedRobots: [] },
    riskConditions: { expectedMaxRisk: 0.72, dominantEnvelope: "NEIGHBORHOOD" },
    expectedBehavior: "RACE detects communication risk; expands safety footprint; robots slow to buffer distance; recovers when comms normalize.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 75
    }
  },
  {
    level: 7,
    scenarioId: "STRESS-L07",
    name: "Robot Failure (Actuator Stall)",
    description: "AMR R2 suffers sudden drive fault mid-transit carrying a critical task; peer detection & re-bidding.",
    map: "WH-A",
    robotCount: 4,
    randomSeed: 10007,
    initialPositions: [
      { id: "R1", x: 145, y: 165 },
      { id: "R2", x: 352, y: 165 },
      { id: "R3", x: 620, y: 165 },
      { id: "R4", x: 352, y: 305 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 145, y: 165 }, destination: { x: 620, y: 455 }, priority: "MEDIUM" },
      { id: "T-02", pickup: { x: 352, y: 165 }, destination: { x: 145, y: 455 }, priority: "HIGH" },
      { id: "T-03", pickup: { x: 620, y: 165 }, destination: { x: 145, y: 165 }, priority: "LOW" },
      { id: "T-04", pickup: { x: 352, y: 305 }, destination: { x: 620, y: 165 }, priority: "MEDIUM" }
    ],
    obstacles: [],
    dynamicEvents: [
      { type: "ROBOT_FAILURE", robotId: "R2", triggerSec: 3 }
    ],
    communicationConditions: { packetLossRate: 0.02, latencyMs: 20, jitterMs: 3 },
    failureConditions: { failedRobots: ["R2"] },
    riskConditions: { expectedMaxRisk: 0.88, dominantEnvelope: "SAFE-DEGRADED" },
    expectedBehavior: "R2 transitions to SAFE-DEGRADED and halts; task lease expires; nearest peer (R4 or R1) claims task via distributed bidding; remaining fleet completes work.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 75
    }
  },
  {
    level: 8,
    scenarioId: "STRESS-L08",
    name: "Cascade Pressure Scenario",
    description: "Localized disruption in Aisle A causes queue accumulation and upstream delay propagation.",
    map: "WH-A",
    robotCount: 5,
    randomSeed: 10008,
    initialPositions: [
      { id: "R1", x: 352, y: 165 },
      { id: "R2", x: 280, y: 165 },
      { id: "R3", x: 212, y: 165 },
      { id: "R4", x: 145, y: 165 },
      { id: "R5", x: 352, y: 305 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 352, y: 165 }, destination: { x: 620, y: 165 }, priority: "MEDIUM" },
      { id: "T-02", pickup: { x: 280, y: 165 }, destination: { x: 620, y: 165 }, priority: "MEDIUM" },
      { id: "T-03", pickup: { x: 212, y: 165 }, destination: { x: 620, y: 165 }, priority: "HIGH" },
      { id: "T-04", pickup: { x: 145, y: 165 }, destination: { x: 620, y: 165 }, priority: "LOW" },
      { id: "T-05", pickup: { x: 352, y: 305 }, destination: { x: 352, y: 165 }, priority: "HIGH" }
    ],
    obstacles: [],
    dynamicEvents: [
      { type: "CORRIDOR_HOLD", robotId: "R1", durationSec: 4 }
    ],
    communicationConditions: { packetLossRate: 0.02, latencyMs: 20, jitterMs: 3 },
    failureConditions: { failedRobots: [] },
    riskConditions: { expectedMaxRisk: 0.74, dominantEnvelope: "CONTAINMENT" },
    expectedBehavior: "Queue buildup increases cascade pressure (CP factor); RACE elevates envelope to CONTAINMENT; prevents gridlock domino spreading.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 80
    }
  },
  {
    level: 9,
    scenarioId: "STRESS-L09",
    name: "Deadlock-like Scenario",
    description: "4 AMRs on cross paths forming mutual cyclic wait-for dependency in cross-corridor intersection.",
    map: "WH-A",
    robotCount: 4,
    randomSeed: 10009,
    initialPositions: [
      { id: "R1", x: 300, y: 305 },
      { id: "R2", x: 400, y: 305 },
      { id: "R3", x: 352, y: 250 },
      { id: "R4", x: 352, y: 360 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 300, y: 305 }, destination: { x: 450, y: 305 }, priority: "HIGH" },
      { id: "T-02", pickup: { x: 400, y: 305 }, destination: { x: 250, y: 305 }, priority: "HIGH" },
      { id: "T-03", pickup: { x: 352, y: 250 }, destination: { x: 352, y: 400 }, priority: "MEDIUM" },
      { id: "T-04", pickup: { x: 352, y: 360 }, destination: { x: 352, y: 200 }, priority: "MEDIUM" }
    ],
    obstacles: [],
    dynamicEvents: [],
    communicationConditions: { packetLossRate: 0.02, latencyMs: 25, jitterMs: 4 },
    failureConditions: { failedRobots: [] },
    riskConditions: { expectedMaxRisk: 0.78, dominantEnvelope: "CONTAINMENT" },
    expectedBehavior: "Cycle detection algorithm detects wait-for cycle; lower priority AMRs back off or replan around crossing; deadlock broken in < 3s without manual intervention.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 75
    }
  },
  {
    level: 10,
    scenarioId: "STRESS-L10",
    name: "Combined Stress Scenario (Full Multi-Fault)",
    description: "High robot density (8 AMRs) + narrow corridor + comms loss + AMR drive stall + dynamic task arrival.",
    map: "WH-A",
    robotCount: 8,
    randomSeed: 10010,
    initialPositions: [
      { id: "R1", x: 145, y: 165 }, { id: "R2", x: 212, y: 165 },
      { id: "R3", x: 352, y: 165 }, { id: "R4", x: 620, y: 165 },
      { id: "R5", x: 145, y: 305 }, { id: "R6", x: 352, y: 305 },
      { id: "R7", x: 500, y: 305 }, { id: "R8", x: 620, y: 305 }
    ],
    tasks: [
      { id: "T-01", pickup: { x: 145, y: 165 }, destination: { x: 620, y: 305 }, priority: "HIGH" },
      { id: "T-02", pickup: { x: 620, y: 165 }, destination: { x: 145, y: 305 }, priority: "MEDIUM" },
      { id: "T-03", pickup: { x: 212, y: 165 }, destination: { x: 352, y: 455 }, priority: "HIGH" },
      { id: "T-04", pickup: { x: 352, y: 165 }, destination: { x: 145, y: 165 }, priority: "LOW" },
      { id: "T-05", pickup: { x: 145, y: 305 }, destination: { x: 620, y: 165 }, priority: "HIGH" },
      { id: "T-06", pickup: { x: 352, y: 305 }, destination: { x: 145, y: 455 }, priority: "LOW" },
      { id: "T-07", pickup: { x: 500, y: 305 }, destination: { x: 212, y: 165 }, priority: "MEDIUM" },
      { id: "T-08", pickup: { x: 620, y: 305 }, destination: { x: 352, y: 165 }, priority: "HIGH" }
    ],
    obstacles: [],
    dynamicEvents: [
      { type: "ROBOT_FAILURE", robotId: "R3", triggerSec: 3 },
      { type: "COMM_DEGRADATION", startSec: 4, endSec: 9, latencyMs: 400, packetLoss: 0.30 }
    ],
    communicationConditions: { packetLossRate: 0.30, latencyMs: 400, jitterMs: 60 },
    failureConditions: { failedRobots: ["R3"] },
    riskConditions: { expectedMaxRisk: 0.92, dominantEnvelope: "SAFE-DEGRADED" },
    expectedBehavior: "All resilience mechanisms active: R3 enters SAFE-DEGRADED, comms risk expands safety clearance, tasks reallocated, zero collisions, safe degradation prioritized over throughput.",
    successCriteria: {
      zeroCollisions: true,
      zeroShelfViolations: true,
      completionRateMin: 60
    }
  }
];

export function getStressScenarioByLevel(lvl) {
  return STRESS_SCENARIOS.find(s => s.level === lvl) || STRESS_SCENARIOS[0];
}

export function getStressScenarioById(id) {
  return STRESS_SCENARIOS.find(s => s.scenarioId === id) || STRESS_SCENARIOS[0];
}
