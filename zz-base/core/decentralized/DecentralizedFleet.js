// ==========================================================================
// NODEX — Fleet container for the two decentralized architectures
// Hosts the RobotAgents of ONE run (System 2 "Decentralized" or System 3
// "NodeX Edge AI ACE decentralized"). It is NOT a coordinator: it only
//   - creates / destroys the agents and the P2P bus,
//   - hands each agent its own sensor frame and ticks it,
//   - is the WMS task board (task source + completion ledger): it announces
//     tasks; awards are decided by the agents' bids,
//   - aggregates telemetry of what the agents actually did (sessions,
//     contracts, metrics) for the dashboard. It never decides for a robot.
// ==========================================================================

import { RobotAgent } from "./RobotAgent.js";
import { peerCommunicationBus, MESSAGE_TYPES } from "./PeerCommunicationBus.js";
import { TaskManager } from "../centralized/TaskManager.js";
import { MapGeometryEngine } from "../map-geometry.js";
import { canAdmitTask } from "../admission-control.js";

export const SYSTEM3_NAME = "NodeX Edge AI ACE decentralized";

export class DecentralizedFleet {
  constructor() {
    this.agents = new Map(); // robotId -> RobotAgent
    this.peerBus = peerCommunicationBus;
    this.taskRegistry = new TaskManager();
    this.taskRegistry.setClock(() => this.simTimeSeconds);
    this.events = [];
    this.simTimeSeconds = 0;
    this.activeSessions = [];
    this.contracts = [];
    this.sessionLog = [];
    this.hitlActions = 0;
    this.runStats = {
      runId: "EXP-DECENTRAL-01",
      systemMode: "decentralized",
      startTime: Date.now(),
      tasksCreated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      conflictsDetected: 0,
      replansCount: 0,
      collisionsCount: 0,
      totalWaitingTime: 0,
      peerMessagesCount: 0
    };
  }

  initializeFleet(robotCount = 3, mode = "decentralized") {
    this.reset();
    this.runStats.startTime = Date.now();
    this.runStats.systemMode = mode;
    this.runStats.runId = mode === "ace" ? "EXP-ACE-01" : "EXP-DECENTRAL-01";

    const spawnPoints = MapGeometryEngine.computeFleetSpawnPoints(robotCount);
    for (let i = 0; i < robotCount; i++) {
      const id = `R${(i + 1).toString().padStart(2, "0")}`;
      const agent = new RobotAgent(id, { x: spawnPoints[i].x, y: spawnPoints[i].y }, this.peerBus, {
        clock: () => this.simTimeSeconds * 1000,
        aceEnabled: mode === "ace",
        fleetSize: robotCount
      });
      this.agents.set(id, agent);
    }

    const modeLabel = mode === "ace" ? SYSTEM3_NAME : "Decentralized (P2P, fixed pair coordination)";
    this.logEvent("SYSTEM", "INITIALIZING", `Fleet initialized with ${robotCount} AMR agents under ${modeLabel}.`);
    // Fleet init creates robots only. Tasks are loaded by ScenarioEngine at Start.
  }

  setSystemMode(mode) {
    this.runStats.systemMode = mode;
    const isAce = mode === "ace";
    for (const agent of this.agents.values()) agent.setAceMode(isAce);
  }

  announceTask(task) {
    this.peerBus.broadcast("SYSTEM", MESSAGE_TYPES.TASK_ANNOUNCEMENT, { task });
    this.logEvent("TASK_BROADCAST", "ANNOUNCEMENT", `Task ${task.id} announced for distributed peer bidding (${task.pickup.name} → ${task.destination.name})`);
  }

  /** Loads a scenario's task set onto the task board and announces every task. */
  loadScenarioTasks(tasks) {
    this.taskRegistry.clear();
    this.taskRegistry.taskCounter = 100;
    for (const task of tasks) {
      const newTask = this.taskRegistry.createTask({
        id: task.id, pickup: task.pickup, destination: task.destination, priority: task.priority, type: task.type
      });
      // Every scenario task starts UNASSIGNED (awarded only by bidding).
      newTask.status = "UNASSIGNED";
      newTask.lastAnnouncedSimTime = this.simTimeSeconds;
      this.announceTask(newTask);
    }
    this.logEvent("SYSTEM", "TASK_LOAD", `Loaded ${tasks.length} scenario tasks onto the task board.`);
  }

  /** Adds tasks to the live board mid-run (scenario task bursts). */
  addTasks(tasks) {
    for (const task of tasks) {
      const newTask = this.taskRegistry.createTask({
        id: task.id, pickup: task.pickup, destination: task.destination, priority: task.priority, type: task.type
      });
      newTask.status = "UNASSIGNED";
      newTask.lastAnnouncedSimTime = this.simTimeSeconds;
      this.announceTask(newTask);
    }
    this.logEvent("SYSTEM", "TASK_LOAD", `Added ${tasks.length} burst tasks to the task board.`);
  }

  /**
   * Task-board re-announcement: an open task whose auction closed while every
   * agent was busy is re-broadcast periodically. The board only re-announces;
   * the award is still decided by the agents' bids.
   */
  reannounceOpenTasks() {
    const REANNOUNCE_INTERVAL_S = 1.0;
    const anyIdle = Array.from(this.agents.values()).some(a => (a.localState.status === "IDLE" || a.localState.parkingBay)
      && !a.localState.currentTaskId && !a.localState.serviceState);
    if (!anyIdle) return;
    // Throttle: when the board already has as many tasks in flight as the
    // fleet may run, re-announcing only produces futile bid storms.
    if (!canAdmitTask(this.agents.size, this.taskRegistry.getActiveTasks().length)) return;
    for (const task of this.taskRegistry.getUnassignedTasks({ orphansFirst: true })) {
      const last = task.lastAnnouncedSimTime ?? -Infinity;
      if (this.simTimeSeconds - last >= REANNOUNCE_INTERVAL_S) {
        task.lastAnnouncedSimTime = this.simTimeSeconds;
        this.peerBus.broadcast("SYSTEM", MESSAGE_TYPES.TASK_ANNOUNCEMENT, { task });
      }
    }
  }

  step(deltaTime = 0.1) {
    this.tick(deltaTime);
  }

  /**
   * One fleet tick: every agent decides for itself. `sensorFrames` (Map
   * robotId -> frame) comes from the simulator's sensor model.
   */
  tick(deltaTime, currentSimTime = null, sensorFrames = null) {
    if (currentSimTime !== null) this.simTimeSeconds = currentSimTime;
    else this.simTimeSeconds += deltaTime;

    this.reannounceOpenTasks();
    for (const agent of this.agents.values()) {
      if (sensorFrames && sensorFrames.has(agent.robotId)) agent.setSensorFrame(sensorFrames.get(agent.robotId));
      agent.tick(deltaTime, this.taskRegistry, this.simTimeSeconds);
    }

    // Ingest events from agent decision traces
    for (const agent of this.agents.values()) {
      if (agent.localDecisionTrace.length > 0) {
        const latest = agent.localDecisionTrace[0];
        if (!agent._lastLoggedDecisionSeq || latest.seq > agent._lastLoggedDecisionSeq) {
          agent._lastLoggedDecisionSeq = latest.seq;
          let evtType = latest.decision;
          if (latest.decision === "ENVELOPE_TRANSITION") {
            const toState = latest.context?.to;
            if (toState === "CONTAINMENT") evtType = "CONTAINMENT_ENTERED";
            else if (toState === "SAFE-DEGRADED") evtType = "SAFE_DEGRADED_ENTERED";
            else if (latest.context?.from === "LOCAL" && toState === "NEIGHBORHOOD") evtType = "ENVELOPE_ESCALATED";
            else evtType = "ENVELOPE_DE_ESCALATED";
          }
          this.logEvent(agent.robotId, evtType, latest.reason);
        }
      }
    }

    this.updateActiveSessions();

    const busMetrics = this.peerBus.getMetrics();
    this.runStats.peerMessagesCount = busMetrics.totalMessages;
    this.runStats.tasksCompleted = this.taskRegistry.getCompletedCount();
    this.runStats.tasksFailed = this.taskRegistry.getAllTasks().filter(t => t.status === "FAILED").length;
    let replans = 0, waiting = 0, conflicts = 0;
    for (const a of this.agents.values()) {
      replans += a.metrics.localReplans;
      waiting += a.metrics.waitingSeconds;
      conflicts += a.metrics.sensorConflictEvents;
    }
    this.runStats.replansCount = replans;
    this.runStats.totalWaitingTime = waiting;
    this.runStats.conflictsDetected = conflicts;
  }

  /**
   * Live sessions and contracts = exactly the sessions the agents currently
   * hold (telemetry, not a decision). A session leaves the live view the
   * moment its robots end it; ended sessions are kept in sessionLog.
   */
  updateActiveSessions() {
    const sessions = [];
    const contracts = [];
    const inAce = this.runStats.systemMode === "ace";
    for (const a of this.agents.values()) {
      if (!inAce && a.pair && a.pair.session) {
        const s = a.pair.session;
        const partner = this.agents.get(s.partner);
        // Report each pair once, only when both robots hold the same session.
        if (!partner || !partner.pair || !partner.pair.session || partner.pair.session.sid !== s.sid || a.robotId > s.partner) continue;
        sessions.push({
          id: s.sid,
          status: "Active",
          robots: [a.robotId, s.partner],
          size: 2,
          type: "Fixed pair P2P session",
          purpose: s.purpose,
          scope: "PAIR (2 robots, fixed)",
          reason: s.purpose === "conflict" ? "Right-of-way negotiation" : "Continuous intent refresh",
          openedAt: s.since,
          progressStatus: `${a.robotId} <-> ${s.partner} (${s.purpose})`
        });
      } else if (inAce && a.ace && a.ace.session && a.ace.session.initiator === a.robotId) {
        const s = a.ace.session;
        sessions.push({
          id: s.sid,
          status: "Active",
          robots: [...s.members],
          size: s.members.length,
          type: "ACE temporary session",
          scope: s.envelope,
          reason: `${s.envelope} envelope around (${s.region.x}, ${s.region.y})`,
          openedAt: s.openedAt,
          progressStatus: `Contract order ${s.contract.order.join(" -> ")}`
        });
        contracts.push({ ...s.contract, participants: [...s.contract.participants], cleared: [...a.ace.cleared] });
      }
    }
    const live = new Set(sessions.map(x => x.id));
    for (const prev of this.activeSessions) {
      if (!live.has(prev.id)) {
        this.sessionLog.push({ id: prev.id, robots: prev.robots, size: prev.size, type: prev.type, openedAt: prev.openedAt, closedAt: this.simTimeSeconds });
        if (this.sessionLog.length > 200) this.sessionLog.shift();
      }
    }
    this.activeSessions = sessions;
    this.contracts = contracts;
  }

  handleRobotFailure(robotId, reason = "Hardware motor stall") {
    const agent = this.agents.get(robotId);
    if (!agent) return;
    agent.localState.status = "ERROR";
    agent.localState.velocity = 0;
    agent.localState.health = 20;
    if (this.runStats.systemMode === "ace") {
      agent.localState.raceState = "SAFE-DEGRADED";
      agent.localState.envelopeRadius = 24;
      agent.localState.coordinationScope = "1 robot (safe-degraded stop)";
    }
    this.logEvent(robotId, "ROBOT_FAILED", `AMR ${robotId} failure detected (${reason}). Broadcasting state.`);
    agent.broadcastStateAndIntent();
  }

  handleCommDegradation(robotId = null) {
    if (robotId) {
      const agent = this.agents.get(robotId);
      if (agent) {
        agent.localState.isCriticalDegraded = true;
        this.logEvent(robotId, "COMM_LOSS", `Communication blackout injected on AMR ${robotId}.`);
      }
    } else {
      for (const agent of this.agents.values()) agent.localState.isCriticalDegraded = true;
      this.logEvent("SYSTEM", "COMM_LOSS", "Fleet-wide wireless latency spike & packet drop injected.");
    }
  }

  clearFaults() {
    for (const agent of this.agents.values()) {
      agent.localState.status = "IDLE";
      agent.localState.health = 98;
      agent.localState.isCriticalDegraded = false;
      agent.localState.velocity = agent.localState.targetVelocity || 1.2;
      if (this.runStats.systemMode === "ace") {
        agent.localState.raceState = "LOCAL";
        agent.localState.envelopeRadius = 18;
        agent.localState.coordinationScope = "1 robot (local)";
      }
    }
    this.logEvent("SYSTEM", "CLEAR", "All fleet faults cleared. Operating normally.");
  }

  logEvent(actor, type, desc) {
    const event = { time: new Date().toTimeString().split(" ")[0], actor, type, desc, timestamp: Date.now(), simTime: this.simTimeSeconds };
    this.events.unshift(event);
    if (this.events.length > 80) this.events.pop();
  }

  getRunStats() {
    const busMetrics = this.peerBus ? this.peerBus.getMetrics() : { totalMessages: 0, coordinationEventsCount: 0 };
    return {
      ...this.runStats,
      messagesSent: busMetrics.totalMessages,
      peerMessagesCount: busMetrics.totalMessages,
      coordinationEventsCount: busMetrics.coordinationEventsCount
    };
  }

  /** Measured architecture metrics of the active run (System 2 or System 3). */
  getArchitectureMetrics() {
    const agents = Array.from(this.agents.values());
    const sum = (f) => agents.reduce((s, a) => s + (f(a) || 0), 0);
    const r1 = (v) => Math.round(v * 10) / 10;
    const bus = this.peerBus.getMetrics();
    const bidRounds = this.taskRegistry.getAllTasks().filter(t => t.bidRound);
    const common = {
      allocation: {
        method: "Contract-Net style distributed bidding (announce -> bid -> deterministic award)",
        awardedTasks: bidRounds.length,
        avgBidsPerAward: bidRounds.length ? Math.round((bidRounds.reduce((s, t) => s + t.bidRound.bids, 0) / bidRounds.length) * 100) / 100 : null,
        ...this.taskRegistry.getTimingStats()
      },
      communication: {
        peerMessages: bus.totalMessages,
        coordinationMessages: bus.coordinationEventsCount,
        droppedMessages: bus.droppedMessages
      },
      sensorConflictEvents: sum(a => a.metrics.sensorConflictEvents),
      localReplans: sum(a => a.metrics.localReplans),
      reroutesAroundFailed: sum(a => a.metrics.reroutesAroundFailed),
      clearanceRequests: sum(a => a.metrics.clearanceRequests),
      orcaSlowdownTicks: sum(a => a.metrics.orcaSlowdownTicks),
      waitingSeconds: r1(sum(a => a.metrics.waitingSeconds))
    };
    if (this.runStats.systemMode !== "ace") {
      return {
        ...common,
        coordination: {
          model: "Fixed two-robot pairs (continuous P2P handshake)",
          pairSessions: sum(a => a.pair && a.pair.stats.sessions) / 2,
          conflictPairSessions: sum(a => a.pair && a.pair.stats.conflictSessions) / 2,
          refreshPairSessions: sum(a => a.pair && a.pair.stats.refreshSessions) / 2,
          pairRequests: sum(a => a.pair && a.pair.stats.requestsSent),
          busyRejections: sum(a => a.pair && a.pair.stats.busyRejections),
          pairWaitSeconds: r1(sum(a => a.pair && a.pair.stats.pairWaitSeconds)),
          maxSessionSize: Math.max(0, ...agents.map(a => (a.pair && a.pair.stats.maxSessionSize) || 0)),
          activeSessions: this.activeSessions.length
        },
        collisionDetection: "On-board sensors only"
      };
    }
    const risks = agents.map(a => a.localState.riskScore || 0);
    const dist = { LOCAL: 0, NEIGHBORHOOD: 0, CONTAINMENT: 0, "SAFE-DEGRADED": 0 };
    for (const a of agents) dist[a.localState.raceState] = (dist[a.localState.raceState] || 0) + 1;
    const initiated = sum(a => a.ace && a.ace.stats.sessionsInitiated);
    const inf = sum(a => a.edgeAi && a.edgeAi.stats.inferences);
    return {
      ...common,
      edgeAi: {
        model: "On-board constant-velocity forecast + logistic conflict model",
        inferences: inf,
        avgInferenceMs: inf ? Math.round((sum(a => a.edgeAi && a.edgeAi.stats.totalMs) / inf) * 1000) / 1000 : null,
        maxInferenceMs: Math.round(Math.max(0, ...agents.map(a => (a.edgeAi && a.edgeAi.stats.maxMs) || 0)) * 1000) / 1000,
        highConflictPredictions: sum(a => a.edgeAi && a.edgeAi.stats.highConflictPredictions)
      },
      race: {
        formula: "w1*conflict + w2*uncertainty + w3*commRisk + w4*queueGrowth + w5*cascadePressure",
        meanRisk: risks.length ? Math.round((risks.reduce((s, v) => s + v, 0) / risks.length) * 1000) / 1000 : 0,
        maxRisk: Math.max(0, ...risks),
        envelopeDistribution: dist,
        envelopeTransitions: sum(a => a.metrics.envelopeTransitions),
        hysteresisHolds: sum(a => a.metrics.hysteresisHolds)
      },
      sessions: {
        initiated,
        joined: sum(a => a.ace && a.ace.stats.sessionsJoined),
        active: this.activeSessions.length,
        maxGroupSize: Math.max(1, ...agents.map(a => (a.ace && a.ace.stats.maxGroupSize) || 1)),
        avgGroupSize: initiated ? Math.round((sum(a => a.ace && a.ace.stats.groupSizeSum) / initiated) * 100) / 100 : null,
        totalSeconds: r1(sum(a => a.ace && a.ace.stats.contractSeconds)),
        scopeChanges: sum(a => a.ace && a.ace.stats.scopeChanges),
        sessionReplans: sum(a => a.ace && a.ace.stats.sessionReplans)
      },
      contracts: {
        issued: sum(a => a.ace && a.ace.stats.contractsIssued),
        active: this.contracts.length,
        totalSeconds: r1(sum(a => a.ace && a.ace.stats.contractSeconds)),
        holdTicks: sum(a => a.ace && a.ace.stats.contractHolds)
      },
      conflictDetection: {
        model: "On-board sensors + Edge AI (fused)",
        sensorEvents: common.sensorConflictEvents,
        aiPredictedOnly: sum(a => a.metrics.aiPredictedConflicts),
        fusedEvents: sum(a => a.metrics.fusedConflictEvents)
      },
      hitlActions: this.hitlActions
    };
  }

  getGlobalFleetState() {
    return Array.from(this.agents.values()).map(a => ({
      ...a.localState,
      location: a.localState.currentGoal?.name || "Corridor Transit",
      riskInputs: a.localState.riskInputs,
      // UI components (RobotInspector, HitlModal, Operations) read riskComponents.
      riskComponents: a.aceEnabled && a.localState.riskInputs ? { ...a.localState.riskInputs } : null,
      architecture: a.aceEnabled ? "ace" : "decentralized"
    }));
  }

  getRobot(robotId) {
    const agent = this.agents.get(robotId);
    return agent ? agent.localState : null;
  }

  getAgent(robotId) {
    return this.agents.get(robotId) || null;
  }

  getActiveTasks() {
    return this.taskRegistry.getActiveTasks();
  }

  getCompletedTasks() {
    return this.taskRegistry.getCompletedTasks();
  }

  getEvents() {
    return [...this.events];
  }

  getActiveSessions() {
    return [...this.activeSessions];
  }

  getContracts() {
    return [...this.contracts];
  }

  getLiveAceTelemetry() {
    const agents = Array.from(this.agents.values());
    const dist = {
      local: agents.filter(a => a.localState.raceState === "LOCAL").length,
      neighborhood: agents.filter(a => a.localState.raceState === "NEIGHBORHOOD").length,
      containment: agents.filter(a => a.localState.raceState === "CONTAINMENT").length,
      safeDegraded: agents.filter(a => a.localState.raceState === "SAFE-DEGRADED").length
    };
    const avgRisk = agents.length > 0 ? agents.reduce((sum, a) => sum + (a.localState.riskScore || 0), 0) / agents.length : 0;
    return {
      systemMode: this.runStats.systemMode,
      totalRobots: agents.length,
      envelopeDistribution: dist,
      averageFleetRisk: parseFloat(avgRisk.toFixed(3)),
      activeContainmentZones: agents.filter(a => a.localState.raceState === "CONTAINMENT").map(a => a.robotId),
      activeSessions: this.getActiveSessions()
    };
  }

  reset() {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
    this.peerBus.reset();
    this.taskRegistry.clear();
    this.events = [];
    this.activeSessions = [];
    this.contracts = [];
    this.sessionLog = [];
    this.hitlActions = 0;
    this.simTimeSeconds = 0;
    this.runStats.tasksCreated = 0;
    this.runStats.tasksCompleted = 0;
    this.runStats.tasksFailed = 0;
    this.runStats.conflictsDetected = 0;
    this.runStats.replansCount = 0;
    this.runStats.collisionsCount = 0;
    this.runStats.totalWaitingTime = 0;
    this.runStats.peerMessagesCount = 0;
  }
}

export const decentralizedFleet = new DecentralizedFleet();
