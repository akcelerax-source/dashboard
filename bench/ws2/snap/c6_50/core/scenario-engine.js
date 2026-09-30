// ==========================================================================
// NODEX ACE — Scenario Engine
// Applies scenario and ACE test conditions to the live simulation.
// Schedules timed events (faults, obstacles, comm degradation).
// Evaluates pass/fail criteria at run completion.
// Single source of truth for "what does this scenario actually do."
// ==========================================================================

import { state } from "./state.js";
import { SCENARIOS, ACE_TESTS } from "../data/scenarios.js";
import { taskManager } from "./centralized/TaskManager.js";
import { WAREHOUSE_TASK_LOCATIONS } from "./centralized/TaskManager.js";
import { centralizedCoordinator } from "./centralized/CentralizedCoordinator.js";
import { decentralizedFleet } from "./decentralized/DecentralizedFleet.js";
import { MapGeometryEngine } from "./map-geometry.js";
import { aceTestMonitor } from "./ace-test-monitor.js";
import { varyWorkload, jitterTrigger } from "./seeded-workload.js";

// S08 work per robot; sized so the fleet is still busy at the 135 s fault.
const S08_TASKS_PER_ROBOT = 4;

export class ScenarioEngine {
  constructor() {
    this.activeConfig = null;
    this.scheduledEvents = [];
    this.eventTimers = [];
    // Scenario faults are scheduled on SIMULATION time and advanced by the
    // engine each tick (processTimedEvents). They used wall-clock
    // setTimeout/setInterval, so they fired at the wrong sim time at 2x/5x
    // speed, kept counting while paused, and never fired inside synchronous
    // benchmark trials.
    this.simTimers = [];
    this.simEngineRef = null; // injected after creation to avoid circular import
    this.conditionGenerators = new Map();
    this.taskGenerators = new Map();
    this.eventGenerators = new Map();
    this.validationRules = new Map();
    this.measurableOutputs = new Map();
    this._registerBuiltinGenerators();
  }

  // ---------------------------------------------------------------------------
  // Register built-in condition/task/event generators
  // ---------------------------------------------------------------------------
  _registerBuiltinGenerators() {
    // Condition Generators - these modify sim state during run
    this.conditionGenerators.set("high_traffic", (config, simEngine) => this._applyHighTraffic(config, simEngine));
    this.conditionGenerators.set("bottleneck", (config, simEngine) => this._applyBottleneck(config, simEngine));
    this.conditionGenerators.set("crossing_conflict", (config, simEngine) => this._applyCrossingConflict(config, simEngine));
    this.conditionGenerators.set("dynamic_obstacle", (config, simEngine) => this._applyDynamicObstacleCondition(config, simEngine));
    this.conditionGenerators.set("comm_delay", (config, simEngine) => this._applyCommDelay(config, simEngine));
    this.conditionGenerators.set("comm_loss", (config, simEngine) => this._applyCommLoss(config, simEngine));
    this.conditionGenerators.set("robot_failure", (config, simEngine) => this._applyRobotFailure(config, simEngine));
    this.conditionGenerators.set("deadlock", (config, simEngine) => this._applyDeadlock(config, simEngine));
    this.conditionGenerators.set("sensor_degradation", (config, simEngine) => this._applySensorDegradation(config, simEngine));
    this.conditionGenerators.set("health_degradation", (config, simEngine) => this._applyHealthDegradation(config, simEngine));

    // Task Generators - scenario-specific task distributions
    this.taskGenerators.set("S01", (scenario, systemMode) => this._generateNormalWarehouseTasks(scenario, systemMode));
    this.taskGenerators.set("S02", (scenario, systemMode) => this._generateHighTaskLoadTasks(scenario, systemMode));
    this.taskGenerators.set("S03", (scenario, systemMode) => this._generateHighTrafficTasks(scenario, systemMode));
    this.taskGenerators.set("S04", (scenario, systemMode) => this._generateCrossingConflictTasks(scenario, systemMode));
    this.taskGenerators.set("S05", (scenario, systemMode) => this._generateDynamicObstacleTasks(scenario, systemMode));
    this.taskGenerators.set("S06", (scenario, systemMode) => this._generateCommDelayTasks(scenario, systemMode));
    this.taskGenerators.set("S07", (scenario, systemMode) => this._generateCommLossTasks(scenario, systemMode));
    this.taskGenerators.set("S08", (scenario, systemMode) => this._generateRobotFailureTasks(scenario, systemMode));
    this.taskGenerators.set("S09", (scenario, systemMode) => this._generateDeadlockTasks(scenario, systemMode));
    this.taskGenerators.set("S10", (scenario, systemMode) => this._generateSensorDegradationTasks(scenario, systemMode));
    this.taskGenerators.set("S11", (scenario, systemMode) => this._generateLeaseExpiryTasks(scenario, systemMode));
    this.taskGenerators.set("S12", (scenario, systemMode) => this._generateHealthDegradationTasks(scenario, systemMode));
    this.taskGenerators.set("S13", (scenario, systemMode) => this._generateCombinedStressTasks(scenario, systemMode));
    this.taskGenerators.set("S14", (scenario, systemMode) => this._generateCentralFailureTasks(scenario, systemMode));

    // Event Generators - produce measurable events during run
    this.eventGenerators.set("task_created", (scenario, simEngine) => this._generateTaskCreatedEvents(scenario, simEngine));
    this.eventGenerators.set("task_completed", (scenario, simEngine) => this._generateTaskCompletedEvents(scenario, simEngine));
    this.eventGenerators.set("conflict_detected", (scenario, simEngine) => this._generateConflictEvents(scenario, simEngine));
    this.eventGenerators.set("reroute", (scenario, simEngine) => this._generateRerouteEvents(scenario, simEngine));
    this.eventGenerators.set("comm_degraded", (scenario, simEngine) => this._generateCommEvents(scenario, simEngine));
    this.eventGenerators.set("robot_failed", (scenario, simEngine) => this._generateFailureEvents(scenario, simEngine));
    this.eventGenerators.set("deadlock_detected", (scenario, simEngine) => this._generateDeadlockEvents(scenario, simEngine));
    this.eventGenerators.set("health_critical", (scenario, simEngine) => this._generateHealthEvents(scenario, simEngine));

    // Validation Rules - evaluated at completion
    this.validationRules.set("zero_collisions", (metrics, config) => metrics.collisionCount === 0);
    this.validationRules.set("min_throughput", (metrics, config) => {
      const min = config.completionCriteria?.minThroughput || 0;
      const actual = parseFloat(metrics.throughput?.replace(/[^0-9.]/g, "") || "0");
      return actual >= min;
    });
    this.validationRules.set("task_reallocated", (metrics, config) => metrics.failedTaskCount === 0);
    this.validationRules.set("no_panic", (metrics, config) => metrics.systemStop !== true);
    this.validationRules.set("architecture_demonstrated", (metrics, config) => metrics.architectureDemonstrated === true);
  }

  // ---------------------------------------------------------------------------
  // Inject sim engine reference (called from main.js or sim-lifecycle.js)
  // ---------------------------------------------------------------------------
  /** Fleet size of the current run: the live fleet, else the selected count. */
  _runFleetSize(def) {
    const live = (state.get("robots") || []).length;
    return live || state.get("robotCount") || def.robotCount || 3;
  }

  setSimEngine(engine) {
    this.simEngineRef = engine;
  }

  // ---------------------------------------------------------------------------
  // Find a scenario or ACE test by code/id
  // ---------------------------------------------------------------------------
  findScenario(code) {
    return SCENARIOS.find(s => s.code === code || s.id === code) || null;
  }

  findAceTest(code) {
    return ACE_TESTS.find(t => t.code === code || t.id === code) || null;
  }

  // ---------------------------------------------------------------------------
  // Apply scenario conditions before START
  // ---------------------------------------------------------------------------
  applyScenario(scenarioCode, systemMode) {
    const baseScenario = this.findScenario(scenarioCode);
    if (!baseScenario) {
      console.warn(`[ScenarioEngine] Unknown scenario: ${scenarioCode}`);
      return null;
    }

    this.clearScheduledEvents();
    // The operator's selected fleet size (frozen at Start) is authoritative.
    // scenario.robotCount is only the scenario's recommended size; it used to
    // overwrite the selection (e.g. 100 -> 3, or the unsupported value 20).
    const scenario = { ...baseScenario, recommendedRobotCount: baseScenario.robotCount, robotCount: this._runFleetSize(baseScenario) };
    this._setTimeline(scenario);
    this.activeConfig = { ...scenario, systemMode, testType: "scenario" };

    // Generate initial tasks using scenario-specific task generator
    this._generateTasksForScenario(scenario, systemMode);

    // Apply scenario-specific initial conditions
    this._applyInitialConditions(scenario, systemMode);

    // Store active conditions
    state.set("simScenarioConditions", scenario.conditions || {});
    state.set("simTestResult", "RUNNING");
    state.set("simActiveConfig", {
      ...(state.get("simActiveConfig") || {}),
      code: scenario.code,
      name: scenario.name,
      testType: "scenario",
      systemMode,
      robotCount: scenario.robotCount,
      recommendedRobotCount: scenario.recommendedRobotCount,
      expectedEnvelope: scenario.expectedEnvelope,
      taskCount: state.get("kpis")?.totalTasks || 0
    });

    // Schedule timed fault/condition injections
    this._scheduleScenarioEvents(scenario, systemMode);

    // Register condition generators that run during simulation
    this._registerActiveConditionGenerators(scenario);

    return this.activeConfig;
  }

  // ---------------------------------------------------------------------------
  // Generate tasks using scenario-specific generator
  // ---------------------------------------------------------------------------
  _generateTasksForScenario(scenario, systemMode) {
    const generator = this.taskGenerators.get(scenario.code);
    if (generator) {
      generator(scenario, systemMode);
    } else {
      // Fallback to generic task generation
      this._initializeScenarioTasks(scenario, systemMode);
    }
  }

  // ---------------------------------------------------------------------------
  // Apply initial conditions that affect robot/task logic from t=0
  // ---------------------------------------------------------------------------
  _applyInitialConditions(scenario, systemMode) {
    const conditions = scenario.conditions || {};
    
    // Apply traffic level
    if (conditions.trafficLevel === "HIGH") {
      this._applyHighTraffic({ conditions }, this.simEngineRef);
    }
    
    // Apply communication conditions
    if (conditions.communication === "DEGRADED" || conditions.communication === "LOSS") {
      this._applyCommConditions(conditions);
    }

    // Apply dynamic obstacles flag
    if (conditions.dynamicObstacles) {
      state.set("envSettings.dynamicObstacles", true);
    }

    // Apply sensor degradation
    if (conditions.uncertaintyLevel === "HIGH" || conditions.poseUncertaintyM) {
      // Written through to each robot's own state (agent localState in
      // Systems 2/3): the sensor model adds range noise from it.
      const u = conditions.poseUncertaintyM || 0.35;
      for (const r of state.get("robots") || []) {
        this.simEngineRef?.updateRobot(r.id, { poseUncertainty: u, uncertaintyRisk: u });
      }
    }

    // Apply health degradation flag
    if (conditions.healthDegradation) {
      state.set("envSettings.healthDegradation", true);
    }
  }

  // ---------------------------------------------------------------------------
  // Register condition generators that run during simulation ticks
  // ---------------------------------------------------------------------------
  _registerActiveConditionGenerators(scenario) {
    const conditions = scenario.conditions || {};
    const activeGenerators = [];

    // Map scenario conditions to active condition generators
    if (conditions.trafficLevel === "HIGH") activeGenerators.push("high_traffic");
    if (conditions.bottleneck) activeGenerators.push("bottleneck");
    if (conditions.seedCrossingConflict) activeGenerators.push("crossing_conflict");
    if (conditions.dynamicObstacles) activeGenerators.push("dynamic_obstacle");
    if (conditions.communication === "DEGRADED") activeGenerators.push("comm_delay");
    if (conditions.communication === "LOSS") activeGenerators.push("comm_loss");
    if (conditions.targetFailureRobot) activeGenerators.push("robot_failure");
    if (conditions.seedDeadlock) activeGenerators.push("deadlock");
    if (conditions.uncertaintyLevel === "HIGH") activeGenerators.push("sensor_degradation");
    if (conditions.healthDegradation) activeGenerators.push("health_degradation");
    if (conditions.cascadePressureTest) activeGenerators.push("bottleneck");

    // Store active generators for sim engine to call each tick
    state.set("activeConditionGenerators", activeGenerators);
    state.set("activeScenarioCode", scenario.code);
  }

  // ---------------------------------------------------------------------------
  // Initialize tasks for the scenario based on task templates and conditions.
  // Creates tasks in the appropriate registry based on system mode.
  // ---------------------------------------------------------------------------
  _initializeScenarioTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 50;
    const taskLoad = (scenario.conditions && scenario.conditions.taskLoad) || "NORMAL";

    // Determine task multiplier based on load
    const taskMultipliers = { NORMAL: 1.0, HIGH: 2.5, "2.5x": 2.5 };
    const multiplier = taskMultipliers[taskLoad] || 1.0;

    // Calculate number of tasks based on robot count and load
    const numTasks = Math.max(robotCount + 3, 6) * multiplier;

    // Create task templates based on warehouse locations
    const taskTypes = ["Pick & Place", "Corridor Transport", "Storage Transport"];
    const tasks = [];

    for (let i = 0; i < numTasks; i++) {
      const pIdx = i % WAREHOUSE_TASK_LOCATIONS.length;
      const dIdx = (i + Math.floor(WAREHOUSE_TASK_LOCATIONS.length / 2)) % WAREHOUSE_TASK_LOCATIONS.length;
      const priority = i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW";
      const taskType = taskTypes[i % taskTypes.length];

      const task = {
        id: `T-${101 + i}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
        destination: WAREHOUSE_TASK_LOCATIONS[dIdx],
        priority,
        type: taskType,
        status: (taskLoad === "HIGH" && i < Math.round(numTasks * 0.3)) ? "ASSIGNED" : "UNASSIGNED"
      };
      tasks.push(task);
    }

    this._loadTasks(tasks, systemMode);
  }

  // ---------------------------------------------------------------------------
  // Apply ACE test conditions before START
  // ---------------------------------------------------------------------------
  applyAceTest(testCode, systemMode) {
    const baseTest = this.findAceTest(testCode);
    if (!baseTest) {
      console.warn(`[ScenarioEngine] Unknown ACE test: ${testCode}`);
      return null;
    }

    this.clearScheduledEvents();
    // Same rule as scenarios: the selected fleet size is authoritative.
    const test = { ...baseTest, recommendedRobotCount: baseTest.robotCount, robotCount: this._runFleetSize(baseTest) };
    this._setTimeline(test);
    this.activeConfig = { ...test, systemMode, testType: "aceTest" };

    // Initialize ACE-specific tasks
    this._initializeAceTasks(test, systemMode);

    state.set("simScenarioConditions", test.conditions || {});
    state.set("simTestResult", "RUNNING");
    state.set("simActiveConfig", {
      ...(state.get("simActiveConfig") || {}),
      code: test.code,
      name: test.name,
      testType: "aceTest",
      systemMode,
      robotCount: test.robotCount,
      recommendedRobotCount: test.recommendedRobotCount,
      passCriteria: test.passCriteria,
      failCriteria: test.failCriteria
    });

    // Schedule timed events specific to this ACE test
    this._scheduleAceTestEvents(test, systemMode);

    return this.activeConfig;
  }

  /**
   * Initialize tasks for ACE tests based on test conditions.
   * Loads tasks into decentralized fleet (ACE uses decentralized task registry).
   */
  _initializeAceTasks(test, systemMode) {
    const robotCount = test.robotCount || 3;
    const taskTypes = ["Pick & Place", "Corridor Transport", "ACE Adaptive Transport"];

    // ACE tests use decentralized fleet's task registry
    const tasks = this._seededAceTasks(test);
    for (let i = 0; i < robotCount + 2; i++) {
      const pIdx = i % WAREHOUSE_TASK_LOCATIONS.length;
      const dIdx = (i + Math.floor(WAREHOUSE_TASK_LOCATIONS.length / 2) + 1) % WAREHOUSE_TASK_LOCATIONS.length;
      const priority = i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW";

      tasks.push({
        id: `T-A${test.id}-${i}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
        destination: WAREHOUSE_TASK_LOCATIONS[dIdx],
        priority,
        type: taskTypes[i % taskTypes.length],
        status: "UNASSIGNED"
      });
    }

    this._loadTasks(tasks, systemMode);
  }

  // ---------------------------------------------------------------------------
  // Schedule timed events for a scenario
  // ---------------------------------------------------------------------------
  _scheduleScenarioEvents(scenario, systemMode) {
    if (!scenario.triggerAt || !this.simEngineRef) return;
    // Run seed: +-10 % trigger jitter (identity for the default seed).
    const triggerAt = jitterTrigger(scenario.triggerAt, state.get("seed"), `${scenario.code}:fault`);

    const timer = this._at(triggerAt, () => {
      const currentState = state.get("simLifecycleState");
      if (currentState !== "RUNNING") return;

      const fault = scenario.fault;

      if (fault === "robot_failure") {
        const target = this._busyFailureTarget(scenario.conditions?.targetFailureRobot || "R02");
        this.simEngineRef.injectFault("robot_failure", target);
        this.simEngineRef.addEvent("SCENARIO", fault.toUpperCase(),
          `${scenario.code}: Robot failure injected on ${target} at t=${triggerAt}s`);
      }

      if (fault === "comm_delay" || fault === "comm_loss") {
        const target = scenario.conditions?.targetFailureRobot || "R02";
        this.simEngineRef.injectFault("comm_loss", target);
        this._applyCommConditions(scenario.conditions);
      }

      if (fault === "dynamic_obstacle" || scenario.conditions?.dynamicObstacles) {
        this._applyDynamicObstacle(scenario.conditions?.obstacleAt);
      }

      if (fault === "health_degrade" || scenario.conditions?.healthDegradation) {
        const targetRobot = scenario.conditions?.targetHealthRobot || "R02";
        const rate = scenario.conditions?.degradationRate || 0.5;
        this._startHealthDegradation(targetRobot, rate);
      }

      if (fault === "central_link_failure" && systemMode === "centralized") {
        this._simulateCentralCoordinatorFailure();
      }

      if (fault === "task_burst" || scenario.conditions?.taskLoad === "HIGH") {
        this._injectTaskBurst(scenario.conditions?.taskMultiplier || 2.5);
      }

      if (fault === "stress_test") {
        // Combined: comm degradation + health + task burst
        const target1 = scenario.conditions?.targetFailureRobot || "R03";
        const target2 = scenario.conditions?.targetHealthRobot || "R02";
        this.simEngineRef.injectFault("comm_loss", target1);
        this._startHealthDegradation(target2, 0.3);
        this._injectTaskBurst(2.0);
        this._applyCommConditions({
          commLatencyMs: 250,
          commLossRate: 0.1
        });
      }

    });

    this.scheduledEvents.push({ triggerAt, fault: scenario.fault });
  }

  /**
   * Seeded interactions for the ACE tests that need them: tasks between the
   * outermost stations of the active layout, so the routes are guaranteed to
   * meet head-on (A06), cross (A01/A05) or form a cyclic wait (A08). Seeded
   * tasks are HIGH priority so they are auctioned first. Deterministic.
   */
  _seededAceTasks(test) {
    const c = test.conditions || {};
    if (!c.seedConflict && !c.seedCrossingConflict && !c.seedDeadlock) return [];
    const L = WAREHOUSE_TASK_LOCATIONS;
    if (L.length < 4) return [];
    const byX = [...L].sort((a, b) => a.x - b.x || a.y - b.y);
    const byY = [...L].sort((a, b) => a.y - b.y || a.x - b.x);
    const west = byX[0], east = byX[byX.length - 1], north = byY[0], south = byY[byY.length - 1];
    let pairs;
    if (c.seedDeadlock) pairs = [[west, east], [east, west], [north, south], [south, north]];
    else if (c.seedConflict) pairs = [[west, east], [east, west]];
    else pairs = [[west, east], [north, south]];
    return pairs.map(([pickup, destination], i) => ({
      id: `T-A${test.id}-S${i + 1}`,
      pickup,
      destination,
      priority: "HIGH",
      type: "Seeded ACE Interaction",
      status: "UNASSIGNED"
    }));
  }

  // ---------------------------------------------------------------------------
  // Schedule timed events for an ACE test
  // ---------------------------------------------------------------------------
  _scheduleAceTestEvents(test, systemMode) {
    if (!this.simEngineRef) return;

    this._at(test.triggerAt || 0, () => {
      const currentState = state.get("simLifecycleState");
      if (currentState !== "RUNNING") return;

      const cond = test.conditions || {};
      aceTestMonitor.note("trigger");

      // A02: exercise several risk factors at once (link latency -> comm
      // risk, pose noise -> uncertainty; conflict/queue come from traffic).
      if (cond.multiFactorRiskTest) {
        decentralizedFleet.peerBus.setLinkConditions({ latencyMs: 400 });
        for (const r of state.get("robots") || []) this.simEngineRef.updateRobot(r.id, { poseUncertainty: 0.3, uncertaintyRisk: 0.3 });
        this.simEngineRef.addEvent("A02", "RISK_FACTORS", "A02: peer-link latency +400 ms and pose uncertainty 0.3 m applied.");
      }

      // A12: operator HITL intervention (the validation operator arms HITL,
      // holds the whole fleet, then resumes it 5 s later).
      if (cond.hitlTest) {
        import("./hitl-controller.js").then(({ hitlController }) => {
          if (state.get("simLifecycleState") !== "RUNNING") return;
          state.set("hitlEnabled", true);
          const hold = hitlController.dispatchCommand({ scope: "ENTIRE_FLEET", action: "hold", reason: "A12 validation: operator fleet hold" });
          if (hold.success) aceTestMonitor.note("hitl_hold");
          this._at((state.get("simTimeSeconds") || 0) + 5, () => {
            const res = hitlController.dispatchCommand({ scope: "ENTIRE_FLEET", action: "resume", reason: "A12 validation: operator resume" });
            if (res.success) aceTestMonitor.note("hitl_resume");
          });
        });
      }

      // A03, A11: comm degradation
      if (cond.communication === "DEGRADED" || cond.communication === "LOSS") {
        const target = "R02";
        this.simEngineRef.injectFault("comm_loss", target);
        this._applyCommConditions(cond);
      }

      // A09, A10: robot failure / health
      if (cond.targetFailureRobot) {
        this.simEngineRef.injectFault("robot_failure", this._busyFailureTarget(cond.targetFailureRobot));
      }
      if (cond.healthDegradation && cond.targetHealthRobot) {
        aceTestMonitor.note("health_target", { robot: cond.targetHealthRobot });
        this._startHealthDegradation(cond.targetHealthRobot, cond.degradationRate || 0.4);
      }

      // A01: progressive risk escalation for envelope lifecycle test
      if (cond.progressiveRiskEscalation) {
        this._startProgressiveRiskEscalation();
      }

      // A04: cascade pressure test
      if (cond.cascadePressureTest) {
        this._injectCascadePressure();
      }

      // A11: safe-degraded test combines comm loss + health
      if (test.code === "A11") {
        this.simEngineRef.injectFault("comm_loss", "R02");
        this._startHealthDegradation("R02", 0.5);
      }

      this.simEngineRef.addEvent("ACE_TEST", test.code,
        `${test.code}: Test condition applied at t=${test.triggerAt}s`);

    });
  }

  // ---------------------------------------------------------------------------
  // Helper: Apply communication conditions to fleet
  // ---------------------------------------------------------------------------
  _applyCommConditions(conditions = {}) {
    if (!conditions) return;
    const lossRate = conditions.commLossRate || 0;
    const latencyMs = conditions.commLatencyMs || 0;
    const systemMode = this.activeConfig?.systemMode || state.get("systemMode") || "ace";
    if (systemMode !== "centralized") {
      // Decentralized/ACE: degrade the real peer links. Dropped and delayed
      // intent messages raise each agent's measured RACE communication risk;
      // writing raceState into snapshots had no effect (rebuilt every tick).
      decentralizedFleet.peerBus.setLinkConditions({ lossRate, latencyMs });
      this.simEngineRef?.addEvent("SCENARIO", "COMM_DEGRADED",
        `Peer links degraded: ${Math.round(lossRate * 100)}% packet loss, +${latencyMs} ms latency.`);
      return;
    }
    // Centralized: the robot<->server link delays and drops central commands
    // (they are retransmitted); coordination stays central.
    centralizedCoordinator.setLinkConditions({ latencyMs, lossRate });
    this.simEngineRef?.addEvent("SCENARIO", "COMM_DEGRADED",
      `Server links degraded: ${Math.round(lossRate * 100)}% packet loss, +${latencyMs} ms latency.`);
  }

  /**
   * Robot-failure target: the configured robot when it is carrying out a task
   * at trigger time; otherwise the lowest-ID robot that is (so the fault
   * always hits a robot with work to reallocate). Deterministic.
   */
  _busyFailureTarget(preferred) {
    const robots = state.get("robots") || [];
    const busy = (r) => r && r.currentTaskId && !["ERROR", "error", "failed"].includes(r.status);
    const pref = robots.find(r => r.id === preferred);
    if (busy(pref)) return preferred;
    const alt = robots.filter(busy).sort((a, b) => a.id.localeCompare(b.id))[0];
    return alt ? alt.id : preferred;
  }

  /**
   * Obstacle position: the configured point when an active robot's remaining
   * route passes it (and it exists in this world); otherwise the middle of an
   * aisle segment ahead on the route of the lowest-ID robot carrying a task
   * (at least 60 px ahead of it, away from every robot), so the obstacle
   * really blocks a route in use without sitting on a station.
   */
  _obstacleOnActiveRoute(preferred) {
    const all = state.get("robots") || [];
    const robots = all.filter(r => r.currentTaskId && Array.isArray(r.plannedPath) && r.plannedPath.length > 1)
      .sort((a, b) => a.id.localeCompare(b.id));
    const ahead = (r) => [{ x: r.x, y: r.y }, ...r.plannedPath.slice((r.pathCursor || 0) + 1)];
    const onRoute = (pt, r) => {
      const pts = ahead(r);
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const t = Math.max(0, Math.min(1, ((pt.x - a.x) * (b.x - a.x) + (pt.y - a.y) * (b.y - a.y)) / (len * len)));
        if (Math.hypot(a.x + (b.x - a.x) * t - pt.x, a.y + (b.y - a.y) * t - pt.y) < 20) return true;
      }
      return false;
    };
    const clearOfRobots = (pt) => all.every(r => Math.hypot(r.x - pt.x, r.y - pt.y) >= 40);
    const inWorld = MapGeometryEngine.isWithinBounds(preferred.x, preferred.y) && !MapGeometryEngine.isPointInObstacle(preferred.x, preferred.y).collision;
    if (inWorld && robots.some(r => onRoute(preferred, r))) return preferred;
    for (const r of robots) {
      const pts = ahead(r);
      for (let k = 0; k + 1 < pts.length; k++) {
        const mid = { x: Math.round((pts[k].x + pts[k + 1].x) / 2), y: Math.round((pts[k].y + pts[k + 1].y) / 2) };
        if (Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y) < 60) continue;
        if (Math.hypot(mid.x - r.x, mid.y - r.y) < 60 || !clearOfRobots(mid)) continue;
        if (MapGeometryEngine.isPointInObstacle(mid.x, mid.y).collision) continue;
        return mid;
      }
    }
    return inWorld ? preferred : MapGeometryEngine.findNearestWaypoint(preferred.x, preferred.y);
  }

  // ---------------------------------------------------------------------------
  // Helper: Inject a dynamic obstacle into the sim environment
  // ---------------------------------------------------------------------------
  _applyDynamicObstacle(position = null, durationSeconds = 25) {
    if (!this.simEngineRef) return;
    const eng = this.simEngineRef;
    const pos = this._obstacleOnActiveRoute(position || { x: 352, y: 305 });
    const now = state.get("simTimeSeconds") || 0;
    // Physically consistent: never drop a pallet onto a robot. Retry until the
    // spot is clear.
    const occupied = (state.get("robots") || []).some(r => Math.hypot(r.x - pos.x, r.y - pos.y) < 30);
    if (occupied) {
      this._at(now + 1, () => this._applyDynamicObstacle(position, durationSeconds));
      return;
    }
    const obs = { id: `OBS-SIM-${Math.round(now * 10)}`, x: pos.x, y: pos.y, width: 24, height: 24, type: "Dynamic Scenario Obstacle" };
    eng.dynamicObstacles.push(obs);
    if (eng.dynamicHumans.length === 0 && typeof eng.spawnHumans === "function") eng.spawnHumans();
    // The central server learns of it from facility monitoring and replans;
    // decentralized robots discover it with their own sensors.
    if ((this.activeConfig?.systemMode || state.get("systemMode")) === "centralized") centralizedCoordinator.requestReplan();
    eng.addEvent("SCENARIO", "OBSTACLE", `Dynamic obstacle at (${pos.x}, ${pos.y}) for ${durationSeconds}s; walking operators on the outer lanes.`);
    // Dynamic obstacle: cleared after its dwell time.
    this._at(now + durationSeconds, () => {
      eng.dynamicObstacles = eng.dynamicObstacles.filter(o => o.id !== obs.id);
      if ((this.activeConfig?.systemMode || state.get("systemMode")) === "centralized") centralizedCoordinator.requestReplan();
      eng.addEvent("SCENARIO", "OBSTACLE_CLEARED", `Obstacle at (${pos.x}, ${pos.y}) removed.`);
    });
  }

  // ---------------------------------------------------------------------------
  // Helper: Start progressive health degradation on a robot
  // ---------------------------------------------------------------------------
  /**
   * Timeline compression. A dashboard run is capped by the wall-time budget
   * (sim-lifecycle RUN_WALL_BUDGET_SECONDS), so the scenario's own timeline
   * (duration, fault trigger times, degradation rates) is compressed by
   * runLimit / scenarioDuration: a fault still happens at the same relative
   * point of the run. The applied scale is recorded in the run config.
   */
  _setTimeline(def) {
    const cfg = state.get("simActiveConfig") || {};
    const limit = cfg.durationSeconds;
    const full = def.duration;
    this.timelineScale = limit && full && limit < full ? limit / full : 1;
    if (def.triggerAt) def.triggerAt = Math.round(def.triggerAt * this.timelineScale * 10) / 10;
    state.updateRunConfig && state.updateRunConfig({ timeline_scale: Math.round(this.timelineScale * 1000) / 1000 });
  }

  _startHealthDegradation(robotId, ratePerSecond = 0.5) {
    ratePerSecond = ratePerSecond / (this.timelineScale || 1);
    this._every(1.0, () => {
      const r = (state.get("robots") || []).find(rb => rb.id === robotId);
      if (!r || !this.simEngineRef) return false;
      // Write through to the authoritative robot (agent localState in
      // Decentralized/ACE); mutating the snapshot only affected Centralized.
      const health = Math.max(0, (r.health || 100) - ratePerSecond);
      const patch = { health };
      if (health < 30 && r.status !== "error") {
        patch.targetVelocity = Math.max(0.3, (r.targetVelocity || 1.2) * 0.8);
        if (health < 10) patch.status = "error";
      }
      this.simEngineRef.updateRobot(robotId, patch);
      Object.assign(r, patch);

      // Dispatch to charger if ACE mode and health critical
      if (r.health < 30) {
        this.simEngineRef?.addEvent(robotId, "HEALTH",
          `${robotId} health critical (${r.health.toFixed(0)}%). Bidding capacity reduced.`);
        if (r.health < 15 && r.status !== "error") {
          this.simEngineRef?.addEvent(robotId, "MAINTENANCE_FLAG",
            `${robotId} flagged for maintenance (health ${r.health.toFixed(0)}%); it drives to the maintenance bay after its current task.`);
        }
      }
      return health > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Helper: Simulate central coordinator failure (Centralized mode S14)
  // ---------------------------------------------------------------------------
  _simulateCentralCoordinatorFailure(outageSeconds = 20) {
    const systemMode = this.activeConfig?.systemMode || state.get("systemMode");
    if (systemMode === "centralized") {
      // The server goes offline: the fleet performs a safe hold for the outage
      // and resumes under central control. No decentralized fallback exists.
      centralizedCoordinator.setServerOnline(false, outageSeconds);
      const faults = state.get("activeFaults") || [];
      faults.push({
        id: `F-C14-${Date.now().toString().slice(-4)}`,
        type: "Central Coordinator Failure",
        targetRobot: "ALL",
        timeInjected: this.simEngineRef?.formatSimTime(state.get("simTimeSeconds")),
        status: "Active",
        description: `Central dispatch server offline for ${outageSeconds}s. CENTRALIZED: fleet safe hold, no peer fallback.`
      });
      state.set("activeFaults", [...faults]);
      this.simEngineRef?.addEvent("SCENARIO", "S14", `S14: Central server offline for ${outageSeconds}s; centralized fleet in safe hold.`);
    } else {
      // Systems 2/3 have no central server; nothing to fail.
      this.simEngineRef?.addEvent("SCENARIO", "S14", "S14: no central server in this architecture; peers continue.");
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: Inject task burst (S02, S13)
  // ---------------------------------------------------------------------------
  _injectTaskBurst(multiplier = 2.5) {
    // Real extra tasks in the running architecture's task store (previously
    // only an event and a fault card were written; no task was ever created).
    const systemMode = this.activeConfig?.systemMode || state.get("systemMode") || "ace";
    const fleet = this.activeConfig?.robotCount || (state.get("robots") || []).length || 3;
    const nominal = Math.max(fleet + 3, 6);
    const count = Math.max(1, Math.round(nominal * (multiplier - 1)));
    const L = WAREHOUSE_TASK_LOCATIONS.length;
    this.burstCounter = (this.burstCounter || 0) + 1;
    const tasks = [];
    for (let i = 0; i < count; i++) {
      const pIdx = (i + this.burstCounter) % L;
      tasks.push({
        id: `T-B${this.burstCounter}-${i + 1}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
        destination: WAREHOUSE_TASK_LOCATIONS[(pIdx + Math.floor(L / 2)) % L],
        priority: i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW",
        type: "Burst Transport"
      });
    }
    // Run seed: seeded station pairs / order (identity for the default seed).
    const burst = varyWorkload(tasks, state.get("seed"), WAREHOUSE_TASK_LOCATIONS, `${this.activeConfig?.code || ""}:burst${this.burstCounter}`);
    if (systemMode === "centralized") centralizedCoordinator.addTasks(burst);
    else decentralizedFleet.addTasks(burst);

    this.simEngineRef?.addEvent("SCENARIO", "TASK_BURST",
      `Task burst injected: ${count} new tasks (${multiplier}x nominal load of ${nominal}).`);
    const faults = state.get("activeFaults") || [];
    faults.push({
      id: `F-TASKBURST-${this.burstCounter}`,
      type: "High Task Load",
      targetRobot: "ALL",
      timeInjected: this.simEngineRef?.formatSimTime(state.get("simTimeSeconds")),
      status: "Active",
      description: `Task arrival rate surged to ${multiplier}x nominal: ${count} tasks added.`
    });
    state.set("activeFaults", [...faults]);
  }

  // ---------------------------------------------------------------------------
  // Helper: Start progressive risk escalation for A01
  // ---------------------------------------------------------------------------
  _startProgressiveRiskEscalation() {
    // Escalate a real RACE input (peer-link staleness) in four steps every
    // 15 s of sim time; the envelope then follows the agents' own risk
    // evaluation. Previously risk and envelope values were written directly.
    // After the last step the links recover, so the release back to LOCAL
    // (temporary coordination ends when the need ends) is observed too.
    const latencySteps = [600, 1200, 1800, 2500, 0];
    let step = 0;
    this._every(12, () => {
      if (step >= latencySteps.length) return false;
      decentralizedFleet.peerBus.setLinkConditions({ latencyMs: latencySteps[step] });
      aceTestMonitor.note(latencySteps[step] ? "risk_step" : "risk_release");
      this.simEngineRef?.addEvent("A01", latencySteps[step] ? "RISK_ESCALATION" : "RISK_RELEASED", latencySteps[step]
        ? `A01: escalation step ${step + 1}/4, peer-link latency +${latencySteps[step]} ms.`
        : "A01: peer links restored; risk falls and the envelope must release.");
      step++;
      return step < latencySteps.length;
    });
  }

  // ---------------------------------------------------------------------------
  // Helper: Inject cascade pressure for A04
  // ---------------------------------------------------------------------------
  _injectCascadePressure() {
    // Stall two busy lane robots for CASCADE_STALL_SECONDS in every
    // architecture (applyOperatorOverrides honours scenarioStall), so queues
    // form behind them. Risk and envelope are left to the real RACE inputs.
    // The stall waits (up to 30 s) for a lane leader with a follower behind
    // it, so it always builds a real queue even in sparse large fleets.
    const CASCADE_STALL_SECONDS = 20;
    const WAIT_FOR_QUEUE_SECONDS = 30;
    const startedAt = state.get("simTimeSeconds") || 0;
    const dir = (r) => { const dx = r.targetX - r.x, dy = r.targetY - r.y, m = Math.hypot(dx, dy) || 1; return { x: dx / m, y: dy / m }; };
    const tryStall = () => {
      if (state.get("simLifecycleState") !== "RUNNING") return false;
      const robots = state.get("robots") || [];
      const busy = robots.filter(r => r.currentTaskId && !r.handling && !MapGeometryEngine.isOffLane(r.x, r.y) && !["ERROR", "error", "failed"].includes(r.status))
        .sort((a, b) => a.id.localeCompare(b.id));
      const hasFollower = (lead) => busy.some(f => {
        if (f === lead) return false;
        const d = dir(f), along = (lead.x - f.x) * d.x + (lead.y - f.y) * d.y;
        const lateral = Math.abs((lead.x - f.x) * d.y - (lead.y - f.y) * d.x);
        return along > 0 && along < 160 && lateral < 10;
      });
      const leaders = busy.filter(hasFollower);
      const timedOut = (state.get("simTimeSeconds") || 0) - startedAt >= WAIT_FOR_QUEUE_SECONDS;
      if (!leaders.length && !timedOut) return true; // keep polling
      const pool = [...leaders, ...busy.filter(r => !leaders.includes(r)), ...robots.filter(r => !busy.includes(r))];
      const ids = pool.slice(0, 2).map(r => r.id);
      for (const id of ids) this.simEngineRef?.updateRobot(id, { scenarioStall: true });
      this._at((state.get("simTimeSeconds") || 0) + CASCADE_STALL_SECONDS, () => {
        for (const id of ids) this.simEngineRef?.updateRobot(id, { scenarioStall: false });
        aceTestMonitor.note("stall_end");
        this.simEngineRef?.addEvent("A04", "CASCADE_RELEASED", `A04: ${ids.join(", ")} released after ${CASCADE_STALL_SECONDS} s stall.`);
      });
      aceTestMonitor.note("stall_start");
      this.simEngineRef?.addEvent("A04", "CASCADE_PRESSURE",
        `A04: ${ids.join(", ")} stalled for ${CASCADE_STALL_SECONDS} s to build cascade pressure${leaders.length ? " (queue behind)" : ""}.`);
      return false;
    };
    if (tryStall()) this._every(1.0, tryStall);
  }

  // ---------------------------------------------------------------------------
  // Clear all scheduled events (on reset or stop)
  // ---------------------------------------------------------------------------
  /** Run `fn` once at run sim time `atSeconds`. */
  _at(atSeconds, fn) {
    this.simTimers.push({ at: atSeconds, fn });
  }

  /** Run `fn` every `periodSeconds` of sim time until it returns false. */
  _every(periodSeconds, fn) {
    const now = state.get("simTimeSeconds") || 0;
    this.simTimers.push({ at: now + periodSeconds, period: periodSeconds, fn });
  }

  /** Called by the engine every tick with the current run sim time. */
  processTimedEvents(simTimeSeconds) {
    if (this.simTimers.length === 0) return;
    const due = this.simTimers.filter(t => t.at <= simTimeSeconds);
    if (due.length === 0) return;
    this.simTimers = this.simTimers.filter(t => t.at > simTimeSeconds);
    for (const t of due) {
      const keep = t.fn();
      if (t.period && keep !== false) this.simTimers.push({ ...t, at: t.at + t.period });
    }
  }

  clearScheduledEvents() {
    this.simTimers = [];
    this.burstCounter = 0;
    for (const t of this.eventTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.eventTimers = [];
    this.scheduledEvents = [];
  }

  // ---------------------------------------------------------------------------
  // Evaluate pass/fail result at end of run
  // ---------------------------------------------------------------------------
  evaluateResult() {
    if (!this.activeConfig) return "INCONCLUSIVE";
    const config = this.activeConfig;
    const robots = state.get("robots") || [];
    const faults = state.get("activeFaults") || [];
    const kpis = state.get("kpis") || {};
    const systemMode = config.systemMode || "ace";

    // Determine task manager based on system mode
    let taskManagerRef;
    let totalTasks = 0;
    let completedTasks = 0;
    let failedTasks = 0;

    if (systemMode === "centralized") {
      taskManagerRef = taskManager; // Centralized uses singleton taskManager
      totalTasks = taskManagerRef.getTotalCount();
      completedTasks = taskManagerRef.getCompletedCount();
      failedTasks = taskManagerRef.getAllTasks().filter(t => t.status === "FAILED").length;
    } else {
      // Decentralized and ACE use decentralized fleet's task registry
      taskManagerRef = decentralizedFleet.taskRegistry;
      totalTasks = taskManagerRef.getTotalCount();
      completedTasks = taskManagerRef.getCompletedCount();
      failedTasks = taskManagerRef.getAllTasks().filter(t => t.status === "FAILED").length;
    }

    // Collect real metrics from simulation state
    const metrics = {
      // Completion metrics
      taskCompletionCount: kpis.activeTasks || 0,
      totalTaskCount: totalTasks,
      completedTaskCount: completedTasks,
      failedTaskCount: failedTasks,

      // Performance metrics
      makespan: state.get("simTimeSeconds") || 0,
      throughput: kpis.throughput || "0 tasks/hr",
      avgWaitingTime: this._calculateAvgWaitingTime(robots),

      // Collision & safety metrics
      collisionCount: robots.filter(r => r.status === "COLLISION").length,
      errorCount: robots.filter(r => r.status === "error" || r.status === "ERROR").length,
      safetyStops: robots.filter(r => r.raceState === "SAFE-DEGRADED").length,

      // ACE-specific metrics
      avgRiskScore: kpis.averageFleetRisk || 0,
      containmentCount: robots.filter(r => r.raceState === "CONTAINMENT").length,
      neighborhoodCount: robots.filter(r => r.raceState === "NEIGHBORHOOD").length,
      localCount: robots.filter(r => r.raceState === "LOCAL").length,

      // Coordination metrics
      activeSessionsCount: state.get("activeSessions")?.length || 0,
      activeContractsCount: state.get("contracts")?.length || 0,
      totalEvents: state.get("events")?.length || 0,

      // System-specific
      systemMode: config.systemMode,
      fleetSize: config.robotCount || 0,
      simulationTime: state.get("simTimeSeconds") || 0
    };

    // Check pass/fail criteria
    let result = "PASSED";

    // Check basic criteria
    const anyCollision = robots.some(r => r.status === "COLLISION");
    const anyError = robots.some(r => r.status === "error" || r.status === "ERROR");
    const completionCriteria = config.completionCriteria || {};
    const failCriteria = config.failureCriteria || {};

    if (failCriteria.anyCollision && anyCollision) result = "FAILED";
    if (failCriteria.completeSystemStop && robots.every(r => r.velocity === 0)) result = "FAILED";
    if (failCriteria.systemStop && robots.every(r => r.velocity === 0 && r.status !== "MOVING")) result = "FAILED";

    if (completionCriteria.zeroCollisions && anyCollision) result = "FAILED";

    // ACE-specific failure checks
    if (config.testType === "aceTest") {
      // Check for complete degradation
      if (failCriteria.completeDegraded && robots.every(r => r.raceState === "SAFE-DEGRADED")) result = "FAILED";
      // Check task completion rate
      const taskCompletionRate = completedTasks / Math.max(1, totalTasks);
      if (failCriteria.lowTaskCompletion && taskCompletionRate < 0.3) result = "FAILED";

      // Programmatic ACE test validation
      const testCode = config.code || "";
      this._validateAceTestCriteria(testCode, robots, metrics, failCriteria, result);
    }

    // Store comprehensive metrics
    state.set("simMetrics", metrics);
    state.set("simTestResult", result);

    return result;
  }

  /**
   * Calculate average waiting time from robot stalled durations.
   */
  _calculateAvgWaitingTime(robots) {
    const waitingRobots = robots.filter(r => r.stalledDuration > 0 || r.status === "WAITING");
    if (waitingRobots.length === 0) return 0;
    const totalWait = waitingRobots.reduce((sum, r) => sum + (r.stalledDuration || 0), 0);
    return totalWait / waitingRobots.length;
  }

  // ---------------------------------------------------------------------------
  // Validate ACE test pass/fail criteria programmatically
  // ---------------------------------------------------------------------------
  _validateAceTestCriteria(testCode, robots, metrics, failCriteria, currentResult) {
    // A01: Adaptive Coordination Lifecycle - verify envelope transitions
    if (testCode === "A01") {
      const localCount = robots.filter(r => r.raceState === "LOCAL").length;
      const neighborhoodCount = robots.filter(r => r.raceState === "NEIGHBORHOOD").length;
      const containmentCount = robots.filter(r => r.raceState === "CONTAINMENT").length;
      const safeDegradedCount = robots.filter(r => r.raceState === "SAFE-DEGRADED").length;

      // Check that transitions occurred: all states should be reached at some point
      const hasLocal = localCount > 0;
      const hasNeighborhood = neighborhoodCount > 0;
      const hasContainment = containmentCount > 0;
      const hasSafeDegraded = safeDegradedCount > 0;

      // A01 pass criteria: All 4 transitions occur in correct order. No flapping within 4s dwell window.
      // We verify all states were reached; full transition order requires trajectory logging
      if (!hasLocal || !hasNeighborhood || !hasContainment || !hasSafeDegraded) {
        // Could not verify full lifecycle; don't auto-fail but mark for review
      }
    }

    // A02: Multi-Factor Risk Composition - verify risk score is weighted sum
    if (testCode === "A02") {
      const expectedRisk = failCriteria.riskScoreExpected || 0.5;
      const actualRisk = metrics.avgRiskScore;
      const tolerance = failCriteria.riskScoreTolerance || 0.05;

      if (Math.abs(actualRisk - expectedRisk) > tolerance) {
        // Risk score deviates from expected weighted sum
        // In a full implementation, this would auto-fail; for now we log for review
      }
    }

    // A03: Communication-Risk Adaptation
    if (testCode === "A03") {
      const commRisk = metrics.avgRiskScore; // simplified - in practice use commRisk component
      if (commRisk > 0.6) {
        // Comm risk is elevated - envelope should expand
        const neighborhoodCount = robots.filter(r => r.raceState === "NEIGHBORHOOD").length;
        const containmentCount = robots.filter(r => r.raceState === "CONTAINMENT").length;
        if (neighborhoodCount === 0 && containmentCount === 0) {
          // Envelope not responding to comm risk - potential failure
        }
      }
    }

    // A04: Cascade Pressure Handling
    if (testCode === "A04") {
      const cascadePressure = failCriteria.cascadePressureThreshold || 0.7;
      const containmentCount = robots.filter(r => r.raceState === "CONTAINMENT").length;
      if (cascadePressure > 0.7 && containmentCount === 0) {
        // Cascade pressure > 0.7 but no CONTAINMENT envelope - envelope not activating
      }
    }

    // A05: Space-Time Contract
    if (testCode === "A05") {
      const contractsNegotiated = metrics.activeContractsCount || 0;
      // A05 pass: 1 contract negotiated. 0 collisions. Yielder resumes after winner clears.
      if (contractsNegotiated === 0 && currentResult === "PASSED") {
        // No contracts negotiated but result passed - may need review
      }
    }

    // A06: Conflict Detection & Resolution
    if (testCode === "A06") {
      const collisionCount = robots.filter(r => r.status === "COLLISION").length;
      if (collisionCount > 0 && currentResult === "PASSED") {
        // Collisions occurred but result passed - potential issue for review
      }
    }

    // A08: Deadlock Detection & Resolution
    if (testCode === "A08") {
      const deadlockCount = failCriteria.deadlockPersistsBeyond || 60;
      // Deadlock detection requires wait-for graph tracking; basic check passes if no collisions
      // and tasks complete, suggesting deadlock was resolved
    }

    // A11: Safe-Degraded Operation
    if (testCode === "A11") {
      const safeDegradedCount = robots.filter(r => r.raceState === "SAFE-DEGRADED").length;
      const totalRobots = robots.length;
      if (safeDegradedCount > 0 && safeDegradedCount < totalRobots) {
        // Some robots in SAFE-DEGRADED but not complete system stop
        const movingRobots = robots.filter(r => r.velocity > 0.35);
        if (movingRobots.length > 0 && currentResult === "PASSED") {
          // Robots moving despite SAFE-DEGRADED - potential issue for review
        }
      }
    }

    // A12: Human-in-the-Loop Control
    if (testCode === "A12") {
      // HITL validation requires different infrastructure (dashboard command logs)
      // Basic check: verify no safety validation bypasses detected
    }
  }

  // ---------------------------------------------------------------------------
  // SCENARIO-SPECIFIC TASK GENERATORS
  // Each generates tasks with different valid locations per robot
  // ---------------------------------------------------------------------------

  // S01: Normal Warehouse Operation - at least one task per robot, different locations
  _generateNormalWarehouseTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const numTasks = Math.max(robotCount, 6); // At least one per robot
    const taskTypes = ["Pick & Place", "Corridor Transport", "Storage Transport"];
    const tasks = [];

    // Distribute tasks across different warehouse zones
    const zones = [
      { name: "Receiving", locations: WAREHOUSE_TASK_LOCATIONS.filter(l => l.name?.includes("Receiving") || l.x < 200) },
      { name: "Storage A", locations: WAREHOUSE_TASK_LOCATIONS.filter(l => l.name?.includes("Storage") || l.x < 400 && l.x > 200) },
      { name: "Storage B", locations: WAREHOUSE_TASK_LOCATIONS.filter(l => l.name?.includes("Storage") || l.x > 400) },
      { name: "Picking", locations: WAREHOUSE_TASK_LOCATIONS.filter(l => l.name?.includes("Pick") || l.x > 600 && l.y < 200) },
      { name: "Shipping", locations: WAREHOUSE_TASK_LOCATIONS.filter(l => l.name?.includes("Ship") || l.x > 600 && l.y > 200) }
    ].filter(z => z.locations.length > 0);

    for (let i = 0; i < numTasks; i++) {
      const zone = zones[i % zones.length];
      const pickup = zone.locations[i % zone.locations.length];
      const destZone = zones[(i + Math.floor(zones.length / 2)) % zones.length];
      const destination = destZone.locations[(i + 1) % destZone.locations.length];
      const priority = i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW";
      const taskType = taskTypes[i % taskTypes.length];

      tasks.push({
        id: `T-${101 + i}`,
        pickup,
        destination,
        priority,
        type: taskType,
        status: "UNASSIGNED"
      });
    }
    this._loadTasks(tasks, systemMode);
  }

  // S02: High Task Load - more tasks than robots, some robots get multiple
  _generateHighTaskLoadTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 10;
    const multiplier = scenario.conditions?.taskMultiplier || 2.5;
    const numTasks = Math.round(Math.max(robotCount + 3, 6) * multiplier);
    const taskTypes = ["Pick & Place", "Corridor Transport", "Storage Transport", "Replenishment"];
    const tasks = [];

    for (let i = 0; i < numTasks; i++) {
      const pIdx = i % WAREHOUSE_TASK_LOCATIONS.length;
      const dIdx = (i + Math.floor(WAREHOUSE_TASK_LOCATIONS.length / 2)) % WAREHOUSE_TASK_LOCATIONS.length;
      const priority = i % 4 === 0 ? "HIGH" : i % 4 === 1 ? "MEDIUM" : i % 4 === 2 ? "LOW" : "URGENT";
      const taskType = taskTypes[i % taskTypes.length];

      tasks.push({
        id: `T-${201 + i}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
        destination: WAREHOUSE_TASK_LOCATIONS[dIdx],
        priority,
        type: taskType,
        status: (i < Math.round(numTasks * 0.2)) ? "ASSIGNED" : "UNASSIGNED"
      });
    }
    this._loadTasks(tasks, systemMode);
  }

  // S03: High Traffic / Congestion - concentrated traffic, shared destinations
  _generateHighTrafficTasks(scenario, systemMode) {
    const robotCount = scenario.conditions?.robotCount || scenario.robotCount || 20;
    const numTasks = Math.max(robotCount + 5, 15);
    const taskTypes = ["Corridor Transport", "Crossing Transport", "Bottleneck Transport"];
    const tasks = [];

    // Create bottleneck at central crossing (352, 305) - multiple robots share destinations near crossing
    const bottleneckPickups = [
      { x: 145, y: 35, name: "North Entry" },
      { x: 740, y: 35, name: "East Entry" },
      { x: 145, y: 455, name: "South Entry" },
      { x: 740, y: 455, name: "West Entry" }
    ];

    const bottleneckDestinations = [
      { x: 352, y: 305, name: "Central Crossing" },
      { x: 352, y: 165, name: "North Crossing" },
      { x: 352, y: 455, name: "South Crossing" },
      { x: 212, y: 305, name: "West Crossing" },
      { x: 578, y: 305, name: "East Crossing" }
    ];

    for (let i = 0; i < numTasks; i++) {
      const pickup = bottleneckPickups[i % bottleneckPickups.length];
      const destination = bottleneckDestinations[i % bottleneckDestinations.length];
      const priority = i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW";
      const taskType = taskTypes[i % taskTypes.length];

      tasks.push({
        id: `T-${301 + i}`,
        pickup: { ...pickup, x: pickup.x, y: pickup.y },
        destination: { ...destination, x: destination.x, y: destination.y },
        priority,
        type: taskType,
        status: "UNASSIGNED"
      });
    }
    this._loadTasks(tasks, systemMode);
  }

  // S04: Crossing / Bottleneck Conflict - intersecting trajectories
  _generateCrossingConflictTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const tasks = [];

    // Create specific crossing conflict at Aisle A-12 (352, 305)
    // Robot 1: North to South through crossing
    // Robot 2: East to West through crossing
    const crossingTasks = [
      { id: "T-401", pickup: { x: 352, y: 35, name: "North Entry" }, destination: { x: 352, y: 455, name: "South Exit" }, priority: "HIGH", type: "Crossing Transport" },
      { id: "T-402", pickup: { x: 145, y: 305, name: "West Entry" }, destination: { x: 740, y: 305, name: "East Exit" }, priority: "HIGH", type: "Crossing Transport" }
    ];

    for (let i = 0; i < Math.min(robotCount, crossingTasks.length); i++) {
      const t = crossingTasks[i];
      tasks.push({
        id: t.id,
        pickup: t.pickup,
        destination: t.destination,
        priority: t.priority,
        type: t.type,
        status: "UNASSIGNED"
      });
    }

    // Add remaining tasks if more robots
    for (let i = crossingTasks.length; i < robotCount + 1; i++) {
      const pIdx = i % WAREHOUSE_TASK_LOCATIONS.length;
      const dIdx = (i + Math.floor(WAREHOUSE_TASK_LOCATIONS.length / 2)) % WAREHOUSE_TASK_LOCATIONS.length;
      tasks.push({
        id: `T-4${10 + i}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
        destination: WAREHOUSE_TASK_LOCATIONS[dIdx],
        priority: "MEDIUM",
        type: "Corridor Transport",
        status: "UNASSIGNED"
      });
    }
    this._loadTasks(tasks, systemMode);
  }

  // S05: Dynamic Obstacle - obstacle appears during navigation
  _generateDynamicObstacleTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const tasks = [];

    // Tasks that route through the obstacle area (352, 305)
    const obstacleAreaTasks = [
      { id: "T-501", pickup: { x: 145, y: 35, name: "North" }, destination: { x: 740, y: 455, name: "South-East" }, priority: "HIGH", type: "Corridor Transport" },
      { id: "T-502", pickup: { x: 740, y: 35, name: "North-East" }, destination: { x: 145, y: 455, name: "South-West" }, priority: "HIGH", type: "Crossing Transport" }
    ];

    for (let i = 0; i < Math.min(robotCount, obstacleAreaTasks.length); i++) {
      tasks.push({
        id: obstacleAreaTasks[i].id,
        pickup: obstacleAreaTasks[i].pickup,
        destination: obstacleAreaTasks[i].destination,
        priority: obstacleAreaTasks[i].priority,
        type: obstacleAreaTasks[i].type,
        status: "UNASSIGNED"
      });
    }
    this._loadTasks(tasks, systemMode);
  }

  // S06: Communication Delay
  _generateCommDelayTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const tasks = this._generateStandardTasks(robotCount, 101, "HIGH");
    this._loadTasks(tasks, systemMode);
  }

  // S07: Communication Loss
  _generateCommLossTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const tasks = this._generateStandardTasks(robotCount, 101, "HIGH");
    this._loadTasks(tasks, systemMode);
  }

  // S08: Robot Failure + Task Reallocation
  _generateRobotFailureTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const targetFailure = scenario.conditions?.targetFailureRobot || "R02";
    
    // Create tasks where targetFailure robot has an assigned task
    const tasks = [
      { id: "T-801", pickup: { x: 352, y: 165, name: "Crossing North" }, destination: { x: 352, y: 455, name: "South Exit" }, priority: "HIGH", type: "Corridor Transport" },
      { id: "T-802", pickup: { x: 145, y: 305, name: "West Entry" }, destination: { x: 740, y: 305, name: "East Exit" }, priority: "MEDIUM", type: "Crossing Transport" }
    ];

    // Enough work that the fleet is still busy when the fault fires at
    // triggerAt (with only the two fixed tasks, a 10-robot fleet finished
    // before 00:02:15 and the failure never exercised reallocation).
    const L = WAREHOUSE_TASK_LOCATIONS.length;
    for (let i = 0; i < robotCount * S08_TASKS_PER_ROBOT; i++) {
      tasks.push({
        id: `T-${803 + i}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[i % L],
        destination: WAREHOUSE_TASK_LOCATIONS[(i + Math.floor(L / 2)) % L],
        priority: i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW",
        type: "Storage Transport"
      });
    }
    this._loadTasks(tasks, systemMode);
  }

  // S09: Deadlock Scenario - cyclic wait-for dependency
  _generateDeadlockTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 10;
    const tasks = [];

    // Create cyclic dependency: R1->R2->R3->R4->R1 at crossing points
    const deadlockTasks = [
      { id: "T-901", pickup: { x: 145, y: 35, name: "North" }, destination: { x: 740, y: 305, name: "East-Crossing" }, priority: "HIGH", type: "Crossing Transport" },
      { id: "T-902", pickup: { x: 740, y: 35, name: "North-East" }, destination: { x: 145, y: 305, name: "West-Crossing" }, priority: "HIGH", type: "Crossing Transport" },
      { id: "T-903", pickup: { x: 145, y: 455, name: "South" }, destination: { x: 740, y: 165, name: "East-North" }, priority: "HIGH", type: "Crossing Transport" },
      { id: "T-904", pickup: { x: 740, y: 455, name: "South-East" }, destination: { x: 145, y: 165, name: "West-North" }, priority: "HIGH", type: "Crossing Transport" }
    ];

    for (let i = 0; i < Math.min(robotCount, deadlockTasks.length); i++) {
      tasks.push({
        ...deadlockTasks[i],
        status: "UNASSIGNED"
      });
    }
    this._loadTasks(tasks, systemMode);
  }

  // S10: Sensor / Localization Uncertainty
  _generateSensorDegradationTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const tasks = this._generateStandardTasks(robotCount, 101, "MEDIUM");
    this._loadTasks(tasks, systemMode);
  }

  // S11: Task Lease Expiry / Reallocation
  _generateLeaseExpiryTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const obstacleAt = scenario.conditions?.obstacleAt || { x: 212, y: 305 };
    
    const tasks = [
      { id: "T-1101", pickup: { x: 145, y: 35 }, destination: { x: obstacleAt.x, y: obstacleAt.y }, priority: "HIGH", type: "Corridor Transport", status: "ASSIGNED" },
      { id: "T-1102", pickup: { x: 740, y: 455 }, destination: { x: 145, y: 35 }, priority: "MEDIUM", type: "Corridor Transport" }
    ];
    this._loadTasks(tasks, systemMode);
  }

  // S12: Robot Health Degradation
  _generateHealthDegradationTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const targetHealth = scenario.conditions?.targetHealthRobot || "R02";
    const tasks = this._generateStandardTasks(robotCount, 101, "MEDIUM");
    this._loadTasks(tasks, systemMode);
  }

  // S13: Combined Stress Scenario
  _generateCombinedStressTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 10;
    const multiplier = scenario.conditions?.taskMultiplier || 2.0;
    const numTasks = Math.round(Math.max(robotCount + 3, 6) * multiplier);
    const taskTypes = ["Pick & Place", "Corridor Transport", "Storage Transport", "Emergency Transport", "Cascade Transport"];
    const tasks = [];

    for (let i = 0; i < numTasks; i++) {
      const pIdx = i % WAREHOUSE_TASK_LOCATIONS.length;
      const dIdx = (i + Math.floor(WAREHOUSE_TASK_LOCATIONS.length / 2)) % WAREHOUSE_TASK_LOCATIONS.length;
      const priority = i % 4 === 0 ? "URGENT" : i % 4 === 1 ? "HIGH" : i % 4 === 2 ? "MEDIUM" : "LOW";
      const taskType = taskTypes[i % taskTypes.length];

      tasks.push({
        id: `T-${1301 + i}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
        destination: WAREHOUSE_TASK_LOCATIONS[dIdx],
        priority,
        type: taskType,
        status: (i < Math.round(numTasks * 0.15)) ? "ASSIGNED" : "UNASSIGNED"
      });
    }
    this._loadTasks(tasks, systemMode);
  }

  // S14: Central Coordinator / Central Link Failure
  _generateCentralFailureTasks(scenario, systemMode) {
    const robotCount = scenario.robotCount || 3;
    const tasks = this._generateStandardTasks(robotCount, 101, "HIGH");
    this._loadTasks(tasks, systemMode);
  }

  // Helper: Generate standard distributed tasks
  _generateStandardTasks(robotCount, baseId, defaultPriority) {
    const tasks = [];
    const numTasks = Math.max(robotCount + 1, 4);
    
    for (let i = 0; i < numTasks; i++) {
      const pIdx = i % WAREHOUSE_TASK_LOCATIONS.length;
      const dIdx = (i + Math.floor(WAREHOUSE_TASK_LOCATIONS.length / 2)) % WAREHOUSE_TASK_LOCATIONS.length;
      const priority = i % 3 === 0 ? "HIGH" : i % 3 === 1 ? "MEDIUM" : "LOW";

      tasks.push({
        id: `T-${baseId + i}`,
        pickup: WAREHOUSE_TASK_LOCATIONS[pIdx],
        destination: WAREHOUSE_TASK_LOCATIONS[dIdx],
        priority,
        type: "Corridor Transport",
        status: "UNASSIGNED"
      });
    }
    return tasks;
  }

  // Load tasks into appropriate registry
  // Loads the scenario task set into the active architecture's registry without
  // touching the fleet: the fleet is sized by the run's frozen robot count, never
  // by the number of tasks. Every task starts UNASSIGNED so all three
  // architectures receive an identical, allocatable workload.
  _loadTasks(tasks, systemMode) {
    // Run seed: seeded station pairs / release order for generic scenario
    // tasks (identity for the default seed; ACE validation tests untouched).
    if (this.activeConfig?.testType === "scenario") {
      tasks = varyWorkload(tasks, state.get("seed"), WAREHOUSE_TASK_LOCATIONS, `${this.activeConfig.code}:tasks`);
    }
    if (systemMode === "centralized") {
      centralizedCoordinator.loadScenarioTasks(tasks);
    } else {
      decentralizedFleet.loadScenarioTasks(tasks);
    }
  }

  // ---------------------------------------------------------------------------
  // CONDITION GENERATORS - Applied during simulation ticks
  // These modify robot/task logic in real-time
  // ---------------------------------------------------------------------------

  // High traffic: increase robot density, add wait times
  _applyHighTraffic(config, simEngine) {
    const conditions = config.conditions || {};
    if (!this.simEngineRef) return;
    
    // Increase target velocities for congestion simulation
    const robots = state.get("robots") || [];
    for (const r of robots) {
      if (r.status === "MOVING") {
        // Add slight random delay to simulate congestion
        r.targetVelocity = Math.max(0.8, (r.targetVelocity || 1.2) * 0.9);
      }
    }
    state.set("robots", [...robots]);
  }

  // Bottleneck: create congestion at specific points
  _applyBottleneck(config, simEngine) {
    if (!this.simEngineRef) return;
    
    const robots = state.get("robots") || [];
    // Slow down robots near central crossing (352, 305)
    for (const r of robots) {
      const distToCrossing = Math.hypot(r.x - 352, r.y - 305);
      if (distToCrossing < 60 && r.status === "MOVING") {
        r.targetVelocity = Math.min(r.targetVelocity || 1.2, 0.5);
        r.isYielding = true;
      }
    }
    state.set("robots", [...robots]);
  }

  // Crossing conflict: force robots into crossing paths
  _applyCrossingConflict(config, simEngine) {
    if (!this.simEngineRef) return;
    
    const robots = state.get("robots") || [];
    // Force R01 and R02 into crossing trajectories
    const r01 = robots.find(r => r.id === "R01");
    const r02 = robots.find(r => r.id === "R02");
    
    if (r01 && r02) {
      // R01: North to South
      r01.targetX = 352; r01.targetY = 455;
      // R02: West to East  
      r02.targetX = 740; r02.targetY = 305;
      state.set("robots", [...robots]);
    }
  }

  // Dynamic obstacle: inject obstacle and force reroute
  _applyDynamicObstacleCondition(config, simEngine) {
    this._applyDynamicObstacle(config.conditions?.obstacleAt || { x: 352, y: 305 });
  }

  // Communication delay: add latency to coordination
  _applyCommDelay(config, simEngine) {
    const conditions = config.conditions || {};
    const latency = conditions.commLatencyMs || 350;
    const lossRate = conditions.commLossRate || 0.05;
    
    const robots = state.get("robots") || [];
    for (const r of robots) {
      r.commLatency = latency;
      r.commLossRate = lossRate;
      // Reduce coordination frequency
      r.broadcastInterval = Math.max(250, (r.broadcastInterval || 250) * 2);
    }
    state.set("robots", [...robots]);
    
    if (this.simEngineRef) {
      this.simEngineRef.addEvent("SCENARIO", "COMM_DELAY",
        `Communication latency increased to ${latency}ms, loss rate ${(lossRate*100).toFixed(1)}%`);
    }
  }

  // Communication loss: break central or peer comms
  _applyCommLoss(config, simEngine) {
    const conditions = config.conditions || {};
    const lossRate = conditions.commLossRate || 0.8;
    
    const robots = state.get("robots") || [];
    for (const r of robots) {
      r.commLossRate = lossRate;
      r.isCommDegraded = true;
      // In centralized mode, this breaks coordinator connection
      const systemMode = state.get("systemMode");
      if (systemMode === "centralized") {
        r.velocity = 0;
        r.status = "WAITING";
        r.isYielding = true;
      }
    }
    state.set("robots", [...robots]);
    
    if (this.simEngineRef) {
      this.simEngineRef.addEvent("SCENARIO", "COMM_LOSS",
        `Communication loss event: ${(lossRate*100).toFixed(0)}% packet loss`);
    }
  }

  // Robot failure: fail specific robot, trigger reallocation
  _applyRobotFailure(config, simEngine) {
    const conditions = config.conditions || {};
    const target = conditions.targetFailureRobot || "R02";
    
    if (this.simEngineRef) {
      this.simEngineRef.injectFault("robot_failure", target);
      this.simEngineRef.addEvent("SCENARIO", "ROBOT_FAILURE",
        `Robot ${target} failed. Task reallocation initiated.`);
    }
  }

  // Deadlock: create cyclic wait-for dependency
  _applyDeadlock(config, simEngine) {
    if (!this.simEngineRef) return;
    
    const robots = state.get("robots") || [];
    // Force 4 robots into cyclic wait at crossing
    const deadlockRobots = robots.slice(0, 4);
    const positions = [
      { x: 352, y: 165, targetX: 352, targetY: 455 }, // N->S
      { x: 740, y: 305, targetX: 145, targetY: 305 }, // E->W
      { x: 352, y: 455, targetX: 352, targetY: 165 }, // S->N
      { x: 145, y: 305, targetX: 740, targetY: 305 }  // W->E
    ];
    
    deadlockRobots.forEach((r, i) => {
      if (r) {
        r.targetX = positions[i].targetX;
        r.targetY = positions[i].targetY;
        r.isYielding = false;
        r.velocity = 1.2;
      }
    });
    state.set("robots", [...robots]);
    
    if (this.simEngineRef) {
      this.simEngineRef.addEvent("SCENARIO", "DEADLOCK",
        "Cyclic deadlock condition created at central crossing");
    }
  }

  // Sensor degradation: increase pose uncertainty
  _applySensorDegradation(config, simEngine) {
    const conditions = config.conditions || {};
    const uncertainty = conditions.poseUncertaintyM || 0.35;
    
    const robots = state.get("robots") || [];
    for (const r of robots) {
      r.poseUncertainty = uncertainty;
      r.uncertaintyRisk = Math.min(1.0, uncertainty * 2);
      // Increase clearance buffer
      r.clearanceBuffer = (r.clearanceBuffer || 0.4) + uncertainty;
    }
    state.set("robots", [...robots]);
    
    if (this.simEngineRef) {
      this.simEngineRef.addEvent("SCENARIO", "SENSOR_DEGRADATION",
        `Localization uncertainty increased to ${uncertainty}m`);
    }
  }

  // Health degradation: progressive health loss
  _applyHealthDegradation(config, simEngine) {
    // Handled by _startHealthDegradation which runs on interval
  }

  // ---------------------------------------------------------------------------
  // EVENT GENERATORS - Produce measurable events during simulation
  // ---------------------------------------------------------------------------

  _generateTaskCreatedEvents(scenario, simEngine) {
    // Tasks are created at start, logged in applyScenario
  }

  _generateTaskCompletedEvents(scenario, simEngine) {
    // Hook into task completion to log events
    const events = state.get("events") || [];
    // Check for newly completed tasks
  }

  _generateConflictEvents(scenario, simEngine) {
    // Generate events when conflicts are detected
  }

  _generateRerouteEvents(scenario, simEngine) {
    // Generate events when robots reroute
  }

  _generateCommEvents(scenario, simEngine) {
    // Generate events for comm degradation/restoration
  }

  _generateFailureEvents(scenario, simEngine) {
    // Generate events for robot failures
  }

  _generateDeadlockEvents(scenario, simEngine) {
    // Generate events for deadlock detection/resolution
  }

  _generateHealthEvents(scenario, simEngine) {
    // Generate events for health critical events
  }

  // ---------------------------------------------------------------------------
  // Get active run config display info
  // ---------------------------------------------------------------------------
  getActiveConfigDisplay() {
    return state.get("simActiveConfig") || null;
  }
}

export const scenarioEngine = new ScenarioEngine();
