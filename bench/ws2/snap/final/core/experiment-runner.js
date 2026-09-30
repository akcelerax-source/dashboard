// ==========================================================================
// NODEX ACE — Common Experiment Runner & Comparative Stress Evaluation Engine
// Executes identical scenarios across Centralized, Decentralized, and ACE/RACE
// with zero state leakage, zero fabricated metrics, and rigorous safety verification.
// ==========================================================================

import { state } from "./state.js";
import { simEngine } from "./sim-engine.js";
import { systemManager } from "./adapters/SystemManager.js";
import { decentralizedFleet } from "./decentralized/DecentralizedFleet.js";
import { centralizedCoordinator } from "./centralized/CentralizedCoordinator.js";
import { taskManager, WAREHOUSE_TASK_LOCATIONS } from "./centralized/TaskManager.js";
import { MapGeometryEngine, WAREHOUSE_DIMENSIONS, ROBOT_FOOTPRINT } from "./map-geometry.js";
import { RaceEvaluator } from "./race-evaluator.js";
import { STRESS_SCENARIOS, getStressScenarioById, getStressScenarioByLevel } from "./stress-scenarios.js";

export class ExperimentRunner {
  constructor() {
    this.experimentHistory = [];
    this.currentExperiment = null;
  }

  /**
   * Generates a deterministic set of test tasks for a scenario.
   */
  generateScenarioTasks(scenarioId = "S08", count = 6) {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      const pIdx = i % WAREHOUSE_TASK_LOCATIONS.length;
      const dIdx = (i + 4) % WAREHOUSE_TASK_LOCATIONS.length;
      tasks.push({
        id: `EXP-T${(i + 1).toString().padStart(2, "0")}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
        destination: WAREHOUSE_TASK_LOCATIONS[dIdx],
        priority: i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW"
      });
    }
    return tasks;
  }

  /**
   * Executes a single experiment trial for a specific system mode.
   * @param {string} systemMode - "centralized" | "decentralized" | "ace"
   * @param {object} config - Configuration object
   * @returns {object} Result of the experiment trial
   */
  runTrial(systemMode, config = {}) {
    try {
      return this._runTrial(systemMode, config);
    } finally {
      MapGeometryEngine.worldTierOverride = null; // next fleet build reloads its own world
    }
  }

  _runTrial(systemMode, config = {}) {
    // Check if a predefined stress scenario was specified
    const stressScenario = config.stressScenario ||
      (config.scenarioId && config.scenarioId.startsWith("STRESS-") ? getStressScenarioById(config.scenarioId) : null) ||
      (config.level ? getStressScenarioByLevel(config.level) : null);

    const scenarioId = stressScenario ? stressScenario.scenarioId : (config.scenarioId || "S08");
    const robotCount = stressScenario ? stressScenario.robotCount : (config.robotCount || 3);
    const seed = stressScenario ? stressScenario.randomSeed : (config.seed || 18427);
    const durationSeconds = config.durationSeconds || (stressScenario ? 12 : 15);
    const dt = config.dt || 0.1;
    const dynamicEvents = stressScenario ? [...(stressScenario.dynamicEvents || [])] : (config.dynamicEvents || []);
    const experimentId = `EXP-${systemMode.toUpperCase()}-${Date.now().toString().slice(-4)}`;

    // 1. Switch system cleanly and initialize simulation to identical initial state
    systemManager.switchSystem(systemMode);
    // Stress scenarios carry fixed coordinates of the reference (10-robot)
    // world; pin that world for the trial.
    MapGeometryEngine.worldTierOverride = stressScenario ? 10 : null;
    simEngine.initialize({
      robotCount,
      systemMode,
      scenarioId,
      seed,
      map: config.map || "WH-A"
    });

    // Explicitly align robot initial coordinates if specified in scenario
    if (stressScenario && Array.isArray(stressScenario.initialPositions)) {
      const liveRobots = state.get("robots") || [];
      for (let i = 0; i < Math.min(liveRobots.length, stressScenario.initialPositions.length); i++) {
        const initPos = stressScenario.initialPositions[i];
        simEngine.updateRobot(liveRobots[i].id, {
          x: initPos.x,
          y: initPos.y,
          prevX: initPos.x,
          prevY: initPos.y,
          targetX: initPos.x,
          targetY: initPos.y,
          velocity: 0,
          status: "IDLE"
        });
      }
    }

    const tasks = (stressScenario && stressScenario.tasks) ? stressScenario.tasks : (config.tasks || this.generateScenarioTasks(scenarioId, Math.max(3, robotCount)));
    
    // 2. Load the identical task set into the active architecture. (Centralized
    // previously kept the coordinator's own seeded tasks and continuous task
    // generation on top of these, so it was measured on a different workload.)
    if (systemMode === "centralized") {
      centralizedCoordinator.loadScenarioTasks(tasks);
    } else {
      decentralizedFleet.loadScenarioTasks(tasks.map(t => ({
        ...t,
        type: systemMode === "ace" ? "ACE Adaptive Transport" : "Decentralized P2P Transport"
      })));
    }

    // Tracking metrics
    let totalWaitTime = 0;
    let collisionsCount = 0;
    let nearConflictsCount = 0;
    let shelfViolationsCount = 0;
    let boundaryViolationsCount = 0;
    let totalTravelDist = 0;

    // ACE-specific tracking
    let raceEvalsCount = 0;
    let localDuration = 0;
    let neighborhoodDuration = 0;
    let containmentDuration = 0;
    let safeDegradedDuration = 0;
    let escalationsCount = 0;
    let deEscalationsCount = 0;
    let hysteresisHoldsCount = 0;
    const riskHistory = [];

    const totalSteps = Math.floor(durationSeconds / dt);
    const bounds = WAREHOUSE_DIMENSIONS.bounds;
    const handledEvents = new Set();
    const registry = systemMode === "centralized" ? taskManager : decentralizedFleet.taskRegistry;
    let allTasksDoneAt = null; // sim time at which every trial task was completed

    // 3. Step simulation deterministically
    for (let step = 0; step < totalSteps; step++) {
      const currentTime = parseFloat((step * dt).toFixed(2));

      // Handle dynamic events
      for (let eIdx = 0; eIdx < dynamicEvents.length; eIdx++) {
        const evt = dynamicEvents[eIdx];
        if (evt.type === "ROBOT_FAILURE" && !handledEvents.has(`FAIL_${evt.robotId}`)) {
          if (currentTime >= (evt.triggerSec || 3)) {
            handledEvents.add(`FAIL_${evt.robotId}`);
            simEngine.updateRobot(evt.robotId, {
              status: "error",
              isCriticalDegraded: true,
              velocity: 0,
              raceState: "SAFE-DEGRADED"
            });
            if (systemMode !== "centralized") {
              const agent = decentralizedFleet.getAgent(evt.robotId);
              if (agent) {
                agent.localState.status = "error";
                agent.localState.isCriticalDegraded = true;
                agent.localState.raceState = "SAFE-DEGRADED";
              }
              // Task lease release for re-bidding
              const activeTask = decentralizedFleet.taskRegistry.getActiveTaskForRobot(evt.robotId);
              if (activeTask) {
                decentralizedFleet.taskRegistry.releaseTask(activeTask.id, "Robot actuator stall");
              }
            }
          }
        } else if (evt.type === "COMM_DEGRADATION") {
          if (currentTime >= evt.startSec && currentTime <= evt.endSec) {
            if (systemMode === "ace") {
              // Inject elevated communication risk into robots
              const curRobots = state.get("robots") || [];
              for (const r of curRobots) {
                r.commRisk = evt.packetLoss ? Math.min(1.0, evt.packetLoss * 2.5) : 0.65;
              }
            }
          } else if (currentTime > evt.endSec) {
            const curRobots = state.get("robots") || [];
            for (const r of curRobots) {
              if (r.commRisk) r.commRisk = 0.05;
            }
          }
        } else if (evt.type === "CORRIDOR_HOLD") {
          if (currentTime >= 1.0 && currentTime <= (1.0 + (evt.durationSec || 4))) {
            simEngine.updateRobot(evt.robotId, {
              velocity: 0,
              isYielding: true,
              status: "WAITING"
            });
          }
        }
      }

      simEngine.step(dt);
      if (allTasksDoneAt === null && tasks.length > 0 && registry.getCompletedCount() >= tasks.length) {
        allTasksDoneAt = parseFloat((currentTime + dt).toFixed(2));
      }
      const robots = state.get("robots") || [];

      for (let i = 0; i < robots.length; i++) {
        const r = robots[i];
        if (r.status === "WAITING" || r.isYielding) {
          totalWaitTime += dt;
        }

        // Safety check 1: Shelf & restricted obstacle penetrations
        const obsCheck = MapGeometryEngine.isPointInObstacle(r.x, r.y, ROBOT_FOOTPRINT.radius);
        if (obsCheck.collision) {
          shelfViolationsCount++;
        }

        // Safety check 2: Warehouse map boundary violations
        if (r.x < bounds.minX || r.x > bounds.maxX || r.y < bounds.minY || r.y > bounds.maxY) {
          boundaryViolationsCount++;
        }

        // Safety check 3: Physical overlap between robots (< 24px between centers is physical collision)
        for (let j = i + 1; j < robots.length; j++) {
          const other = robots[j];
          const dist = Math.hypot(r.x - other.x, r.y - other.y);
          if (dist < 24) {
            collisionsCount++;
          } else if (dist < 48) {
            nearConflictsCount++;
          }
        }

        // Check ACE envelope metrics
        if (systemMode === "ace") {
          raceEvalsCount++;
          if (r.raceState === "LOCAL") localDuration += dt;
          else if (r.raceState === "NEIGHBORHOOD") neighborhoodDuration += dt;
          else if (r.raceState === "CONTAINMENT") containmentDuration += dt;
          else if (r.raceState === "SAFE-DEGRADED") safeDegradedDuration += dt;

          if (r.riskScore !== undefined) {
            riskHistory.push({ time: currentTime, robotId: r.id, risk: r.riskScore });
          }
        }
      }
    }

    // 4. Collect final metrics from real simulation state
    const finalRobots = state.get("robots") || [];
    for (const r of finalRobots) {
      totalTravelDist += (r.traveledDistance || 0);
    }

    let completedTasks = 0;
    let totalMessages = 0;
    let replansCount = 0;
    let conflictsCount = 0;

    if (systemMode === "centralized") {
      const stats = centralizedCoordinator.getRunStats();
      completedTasks = stats.tasksCompleted;
      replansCount = stats.replansCount || 0;
      conflictsCount = stats.conflictsDetected || 0;
      // The centralized coordinator does not count dispatch messages. (This was
      // stats.tasksAssigned * 2: an invented model over a missing field = NaN.)
      totalMessages = null;
    } else {
      const stats = decentralizedFleet.getRunStats();
      completedTasks = stats ? stats.tasksCompleted : 0;
      totalMessages = (stats && typeof stats.messagesSent === "number") ? stats.messagesSent : ((stats && stats.peerMessagesCount) || 0);
      replansCount = (stats && stats.replansCount) || 0;
      conflictsCount = (stats && stats.conflictsDetected) || 0;

      if (systemMode === "ace") {
        escalationsCount = stats.escalationsCount || 0;
        deEscalationsCount = stats.deEscalationsCount || 0;
        hysteresisHoldsCount = stats.hysteresisHolds || 0;
      }
    }

    const throughput = durationSeconds > 0
      ? Math.round((completedTasks / durationSeconds) * 3600)
      : 0;

    const trialResult = {
      experimentId,
      systemMode,
      scenarioId,
      seed,
      robotCount,
      durationSeconds,
      metrics: {
        // Time until every trial task was completed; null if the trial window
        // ended first (this used to report the trial duration itself).
        completionTime: allTasksDoneAt,
        trialDurationSeconds: durationSeconds,
        tasksCompleted: completedTasks,
        totalTasks: tasks.length,
        completionRatePct: tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0,
        throughputTasksPerHour: throughput,
        averageWaitTimeSeconds: parseFloat((totalWaitTime / Math.max(1, robotCount)).toFixed(2)),
        totalTravelDistancePx: Math.round(totalTravelDist),
        replansCount,
        conflictsCount,
        collisionsCount,
        nearConflictsCount,
        shelfViolations: shelfViolationsCount,
        boundaryViolations: boundaryViolationsCount,
        messagesCount: totalMessages
      },
      aceMetrics: systemMode === "ace" ? {
        raceEvaluationsCount: raceEvalsCount,
        localDurationSec: parseFloat(localDuration.toFixed(1)),
        neighborhoodDurationSec: parseFloat(neighborhoodDuration.toFixed(1)),
        containmentDurationSec: parseFloat(containmentDuration.toFixed(1)),
        safeDegradedDurationSec: parseFloat(safeDegradedDuration.toFixed(1)),
        escalationsCount,
        deEscalationsCount,
        hysteresisHoldsCount,
        riskSamplesCount: riskHistory.length
      } : null,
      status: "COMPLETED",
      timestamp: new Date().toISOString()
    };

    this.experimentHistory.push(trialResult);
    return trialResult;
  }

  /**
   * Calculates comparative percentage improvement between a baseline and a new system.
   */
  static calculateImprovement(baselineVal, newVal, lowerIsBetter = true) {
    // A metric that was not measured for either side has no comparison.
    if (!Number.isFinite(baselineVal) || !Number.isFinite(newVal)) return null;
    if (baselineVal === 0 && newVal === 0) return 0.0;
    if (baselineVal === 0) {
      return lowerIsBetter ? (newVal > 0 ? -100.0 : 0.0) : 100.0;
    }
    let pct;
    if (lowerIsBetter) {
      pct = ((baselineVal - newVal) / baselineVal) * 100;
    } else {
      pct = ((newVal - baselineVal) / baselineVal) * 100;
    }
    return parseFloat(pct.toFixed(1));
  }

  /**
   * Trials drive the shared simulation engine, so they must never overlap a
   * live run and must hand the operator's configuration back afterwards
   * (previously a benchmark left the live view on ACE with the benchmark's
   * fleet size and cleared events, and silently destroyed an active run).
   */
  _assertNoLiveRun() {
    const lc = state.get("simLifecycleState");
    if (["RUNNING", "PAUSED", "STARTING", "STOPPING"].includes(lc)) {
      throw new Error(`Benchmark refused: a live run is ${lc}. Stop or reset it first.`);
    }
  }

  _snapshotLiveConfig() {
    return {
      systemMode: state.get("systemMode"),
      robotCount: state.get("robotCount"),
      selectedScenario: state.get("selectedScenario"),
      selectedMap: state.get("selectedMap"),
      simTestType: state.get("simTestType")
    };
  }

  _restoreLiveConfig(snap) {
    systemManager.switchSystem(snap.systemMode);
    state.set("robotCount", snap.robotCount);
    state.set("selectedScenario", snap.selectedScenario);
    state.set("selectedMap", snap.selectedMap);
    state.set("simTestType", snap.simTestType);
    state.set("activeConditionGenerators", []);
    simEngine.reset(false);
  }

  /**
   * Executes a full 3-way comparative evaluation under identical initial conditions.
   * @param {object} config - Scenario configuration
   * @returns {object} Comparative evaluation dataset
   */
  runComparison(config = {}) {
    this._assertNoLiveRun();
    const liveSnapshot = this._snapshotLiveConfig();
    try {
      return this._runComparison(config);
    } finally {
      MapGeometryEngine.worldTierOverride = null;
      this._restoreLiveConfig(liveSnapshot);
    }
  }

  _runComparison(config = {}) {
    const stressScenario = config.stressScenario ||
      (config.scenarioId && config.scenarioId.startsWith("STRESS-") ? getStressScenarioById(config.scenarioId) : null) ||
      (config.level ? getStressScenarioByLevel(config.level) : null);

    const scenarioConfig = {
      scenarioId: stressScenario ? stressScenario.scenarioId : (config.scenarioId || "S08"),
      robotCount: stressScenario ? stressScenario.robotCount : (config.robotCount || 3),
      seed: stressScenario ? stressScenario.randomSeed : (config.seed || 18427),
      durationSeconds: config.durationSeconds || (stressScenario ? 12 : 12),
      dt: config.dt || 0.1,
      stressScenario
    };

    console.log(`[ExperimentRunner] Starting 3-way comparative evaluation for ${scenarioConfig.scenarioId}...`);

    // Run identical scenario across all three architectures
    const centralizedResult = this.runTrial("centralized", scenarioConfig);
    const decentralizedResult = this.runTrial("decentralized", scenarioConfig);
    const aceResult = this.runTrial("ace", scenarioConfig);

    const mC = centralizedResult.metrics;
    const mD = decentralizedResult.metrics;
    const mA = aceResult.metrics;

    const comparisons = {
      decentralizedVsCentralized: {
        waitingTime: ExperimentRunner.calculateImprovement(mC.averageWaitTimeSeconds, mD.averageWaitTimeSeconds, true),
        conflicts: ExperimentRunner.calculateImprovement(mC.conflictsCount, mD.conflictsCount, true),
        messages: ExperimentRunner.calculateImprovement(mC.messagesCount, mD.messagesCount, true),
        throughput: ExperimentRunner.calculateImprovement(mC.throughputTasksPerHour, mD.throughputTasksPerHour, false)
      },
      aceVsDecentralized: {
        waitingTime: ExperimentRunner.calculateImprovement(mD.averageWaitTimeSeconds, mA.averageWaitTimeSeconds, true),
        conflicts: ExperimentRunner.calculateImprovement(mD.conflictsCount, mA.conflictsCount, true),
        messages: ExperimentRunner.calculateImprovement(mD.messagesCount, mA.messagesCount, true),
        throughput: ExperimentRunner.calculateImprovement(mD.throughputTasksPerHour, mA.throughputTasksPerHour, false)
      },
      aceVsCentralized: {
        waitingTime: ExperimentRunner.calculateImprovement(mC.averageWaitTimeSeconds, mA.averageWaitTimeSeconds, true),
        conflicts: ExperimentRunner.calculateImprovement(mC.conflictsCount, mA.conflictsCount, true),
        messages: ExperimentRunner.calculateImprovement(mC.messagesCount, mA.messagesCount, true),
        throughput: ExperimentRunner.calculateImprovement(mC.throughputTasksPerHour, mA.throughputTasksPerHour, false)
      }
    };

    const comparisonReport = {
      scenarioId: scenarioConfig.scenarioId,
      scenarioName: stressScenario ? stressScenario.name : scenarioConfig.scenarioId,
      seed: scenarioConfig.seed,
      robotCount: scenarioConfig.robotCount,
      durationSeconds: scenarioConfig.durationSeconds,
      timestamp: new Date().toISOString(),
      rawMetrics: {
        centralized: mC,
        decentralized: mD,
        ace: mA
      },
      aceMetrics: aceResult.aceMetrics,
      comparativeImprovements: comparisons
    };

    return comparisonReport;
  }

  /**
   * Executes Hysteresis Stress Test (Sections 19, 20, 21):
   * Runs an oscillating risk sequence around escalation boundary to contrast
   * state machine with hysteresis ENABLED vs DISABLED.
   */
  runHysteresisComparison(riskSequence = [0.59, 0.61, 0.60, 0.62, 0.59, 0.61, 0.60]) {
    // 1. With Hysteresis Enabled (Production defaults: N=3 samples, dwell=4.0s, separate enter/exit)
    const evaluatorEnabled = new RaceEvaluator({
      persistenceSamplesRequired: 3,
      minimumDwellTimeSeconds: 4.0
    });

    const robotEnabled = { id: "R-HYST-ON", raceState: "LOCAL", riskScore: 0.20 };
    const enabledHistory = [];
    let enabledTransitions = 0;
    let enabledHolds = 0;

    let simTime = 0;
    for (let i = 0; i < riskSequence.length; i++) {
      simTime += 0.5; // step 0.5s per sample
      const rVal = riskSequence[i];
      robotEnabled.riskScore = rVal;
      const res = evaluatorEnabled.evaluateEnvelopeState(robotEnabled, simTime, { conflict: rVal });

      if (res.transitioned) enabledTransitions++;
      if (res.transitionDirection === "HOLD") enabledHolds++;

      enabledHistory.push({
        step: i + 1,
        time: simTime,
        risk: rVal,
        envelope: robotEnabled.raceState,
        transitioned: res.transitioned,
        direction: res.transitionDirection,
        holdReason: res.transitionDirection === "HOLD" ? (res.reason || res.transitionReason) : null
      });
    }

    // 2. With Hysteresis Disabled (N=1 sample, dwell=0s, single symmetric boundary at 0.60)
    const disabledThreshold = 0.60;
    let disabledState = "LOCAL";
    const disabledHistory = [];
    let disabledTransitions = 0;

    simTime = 0;
    for (let i = 0; i < riskSequence.length; i++) {
      simTime += 0.5;
      const rVal = riskSequence[i];
      const prevState = disabledState;
      const targetState = rVal >= disabledThreshold ? "NEIGHBORHOOD" : "LOCAL";
      const transitioned = prevState !== targetState;
      if (transitioned) {
        disabledTransitions++;
        disabledState = targetState;
      }

      disabledHistory.push({
        step: i + 1,
        time: simTime,
        risk: rVal,
        envelope: disabledState,
        transitioned,
        direction: transitioned ? (targetState === "NEIGHBORHOOD" ? "ESCALATE" : "DE-ESCALATE") : "HOLD"
      });
    }

    const report = {
      testName: "Hysteresis Boundary Oscillation & Flapping Suppression Test",
      riskSequence,
      thresholds: {
        productionEntry: 0.50,
        productionNeighEntry: 0.70,
        unDampedBoundary: disabledThreshold,
        persistenceSamples: 3,
        dwellTimeSeconds: 4.0
      },
      results: {
        hysteresisEnabled: {
          totalTransitions: enabledTransitions,
          totalHolds: enabledHolds,
          finalEnvelope: robotEnabled.raceState,
          history: enabledHistory
        },
        hysteresisDisabled: {
          totalTransitions: disabledTransitions,
          totalHolds: 0,
          finalEnvelope: disabledState,
          history: disabledHistory
        },
        suppressionEfficacyPct: disabledTransitions > 0
          ? parseFloat((((disabledTransitions - enabledTransitions) / disabledTransitions) * 100).toFixed(1))
          : 100.0
      },
      conclusion: enabledTransitions < disabledTransitions
        ? "PASS: Hysteresis mechanism successfully suppressed high-frequency threshold flapping."
        : "FAIL: Hysteresis failed to suppress state oscillation."
    };

    return report;
  }

  /**
   * Executes the full 10-level progressive stress test matrix.
   */
  runFullStressMatrix() {
    const results = [];
    for (const scenario of STRESS_SCENARIOS) {
      console.log(`[ExperimentRunner] Executing Stress Level ${scenario.level}: ${scenario.name}...`);
      const comp = this.runComparison({
        stressScenario: scenario,
        durationSeconds: 10
      });
      results.push({
        level: scenario.level,
        scenarioId: scenario.scenarioId,
        name: scenario.name,
        comparison: comp
      });
    }
    return results;
  }

  getHistory() {
    return this.experimentHistory;
  }

  clearHistory() {
    this.experimentHistory = [];
  }
}

export const experimentRunner = new ExperimentRunner();
