// ==========================================================================
// NODEX ACE - RACE (Risk-Adaptive Coordination Envelope) Evaluator
// Implementation of Section 5 algorithms from Master Engineering Report
// ==========================================================================

// Envelope radius per ACE state (px). Small by design: the baseline envelope
// is just outside the robot footprint and grows only when RACE escalates.
export const ENVELOPE_RADIUS = { LOCAL: 18, NEIGHBORHOOD: 40, CONTAINMENT: 60, "SAFE-DEGRADED": 24 };

export class RaceEvaluator {
  constructor(customConfig = {}) {
    // 5.1 Task Bid Weights (calibrated parameters)
    this.bidWeights = {
      w_d: 0.35, // Distance
      w_t: 0.25, // Completion Time
      w_b: 0.15, // Battery cost/constraint
      w_l: 0.15, // Current workload
      w_r: 0.10, // Current risk
      ...customConfig.bidWeights
    };

    // 5.2 RACE Risk Weights: R_base = w1*C + w2*U + w3*CR + w4*Q + w5*CP
    this.riskWeights = {
      w1: 0.35, // C: Conflict
      w2: 0.15, // U: Uncertainty
      w3: 0.20, // CR: Communication Risk
      w4: 0.15, // Q: Queue Growth
      w5: 0.15, // CP: Cascade Pressure
      ...customConfig.riskWeights
    };

    // 5.4 Hysteresis Thresholds & Persistence Settings
    this.thresholds = {
      T_local_enter: 0.50,         // Enter NEIGHBORHOOD from LOCAL
      T_neigh_enter: 0.70,         // Enter CONTAINMENT from NEIGHBORHOOD
      T_contain_exit: 0.55,        // Exit CONTAINMENT back to NEIGHBORHOOD
      T_neigh_exit: 0.35,          // Exit NEIGHBORHOOD back to LOCAL
      T_degraded_enter: 0.85,      // Enter SAFE-DEGRADED on extreme risk
      T_degraded_exit: 0.68,       // Exit SAFE-DEGRADED back to CONTAINMENT
      ...customConfig.thresholds
    };

    this.persistenceSamplesRequired = customConfig.persistenceSamplesRequired || 3; // N samples
    this.minimumDwellTimeSeconds = customConfig.minimumDwellTimeSeconds || 4.0;      // 4.0s minimum dwell time
  }

  /**
   * 5.1 Calculate Task Bid Cost C_i = w_d*D + w_t*T + w_b*B + w_l*L + w_r*R
   */
  calculateTaskBidCost({ distance, estTime, batteryLevel, workload, risk }) {
    const dNorm = Math.min(1.0, distance / 100.0);
    const tNorm = Math.min(1.0, estTime / 300.0);
    const bNorm = Math.max(0.0, 1.0 - batteryLevel / 100.0);
    const lNorm = Math.min(1.0, workload / 5.0);
    const rNorm = Math.min(1.0, Math.max(0.0, risk || 0));

    const cost =
      this.bidWeights.w_d * dNorm +
      this.bidWeights.w_t * tNorm +
      this.bidWeights.w_b * bNorm +
      this.bidWeights.w_l * lNorm +
      this.bidWeights.w_r * rNorm;

    return parseFloat(cost.toFixed(3));
  }

  /**
   * 5.2 Calculate Normalized RACE Risk R_base = w1*C + w2*U + w3*CR + w4*Q + w5*CP
   */
  calculateRaceRisk({ conflict, uncertainty, commRisk, queueGrowth, cascadePressure }) {
    const c = Math.max(0, Math.min(1, conflict || 0));
    const u = Math.max(0, Math.min(1, uncertainty || 0));
    const cr = Math.max(0, Math.min(1, commRisk || 0));
    const q = Math.max(0, Math.min(1, queueGrowth || 0));
    const cp = Math.max(0, Math.min(1, cascadePressure || 0));

    const r_base =
      this.riskWeights.w1 * c +
      this.riskWeights.w2 * u +
      this.riskWeights.w3 * cr +
      this.riskWeights.w4 * q +
      this.riskWeights.w5 * cp;

    return parseFloat(Math.min(1.0, Math.max(0.0, r_base)).toFixed(3));
  }

  calculateRisk(inputs) {
    return this.calculateRaceRisk(inputs);
  }

  evaluateLocalAgentEnvelope(robot, riskInputs = {}, currentTimeSeconds = 0) {
    if (typeof riskInputs === "object" && robot.riskScore === undefined) {
      robot.riskScore = this.calculateRisk(riskInputs);
    }
    return this.evaluateEnvelopeState(robot, currentTimeSeconds, riskInputs);
  }

  /**
   * Generates a descriptive reason based on the dominant risk contributors.
   */
  explainRiskDominance(inputs, targetState, isEscalation) {
    const scored = [
      { name: "trajectory conflict", val: (inputs.conflict || 0) * this.riskWeights.w1 },
      { name: "uncertain peer information", val: (inputs.uncertainty || 0) * this.riskWeights.w2 },
      { name: "wireless communication latency/staleness", val: (inputs.commRisk || 0) * this.riskWeights.w3 },
      { name: "corridor queue contention", val: (inputs.queueGrowth || 0) * this.riskWeights.w4 },
      { name: "cascade propagation pressure", val: (inputs.cascadePressure || 0) * this.riskWeights.w5 }
    ].sort((a, b) => b.val - a.val);

    const dominant = scored[0].name;

    if (isEscalation) {
      return `Escalated to ${targetState} driven by elevated ${dominant}.`;
    } else {
      return `De-escalated to ${targetState} as ${dominant} cleared and minimum dwell elapsed.`;
    }
  }

  /**
   * De-escalation target: once the dwell and persistence of the current state
   * are satisfied, the envelope contracts straight to the lowest state the
   * risk justifies (coordination ends when the need ends) instead of spending
   * another full dwell in every intermediate state. `floor` is the next state
   * down; the risk decides how much further it may go.
   */
  _releaseTarget(risk, floor) {
    if (risk <= this.thresholds.T_neigh_exit) return "LOCAL";
    if (floor === "CONTAINMENT" && risk <= this.thresholds.T_contain_exit) return "NEIGHBORHOOD";
    return floor;
  }

  /**
   * 5.4 Evaluate Hysteresis State Machine for an AMR
   */
  evaluateEnvelopeState(robot, currentTimeSeconds, riskInputs = {}) {
    if (robot.isCriticalDegraded || robot.status === "error" || robot.status === "failed") {
      const prev = robot.raceState || "LOCAL";
      robot.raceState = "SAFE-DEGRADED";
      robot.envelopeRadius = ENVELOPE_RADIUS["SAFE-DEGRADED"];
      robot.coordinationScope = "1 robot (safe-degraded crawl)";
      return {
        transitioned: prev !== "SAFE-DEGRADED",
        previousState: prev,
        currentState: "SAFE-DEGRADED",
        previousEnvelope: prev,
        currentEnvelope: "SAFE-DEGRADED",
        risk: robot.riskScore || 1.0,
        transitionDirection: prev !== "SAFE-DEGRADED" ? "ESCALATE" : "HOLD",
        transitionReason: "Hardware/actuator failure or communication blackout reported.",
        reason: "Hardware/actuator failure or communication blackout reported.",
        hysteresisState: prev !== "SAFE-DEGRADED" ? "ESCALATING" : "HOLD",
        timestamp: Date.now()
      };
    }

    const currentRisk = robot.riskScore !== undefined ? robot.riskScore : 0;
    const currentState = robot.raceState || "LOCAL";

    if (!robot._hysteresis) {
      robot._hysteresis = {
        stateEnteredTime: currentTimeSeconds,
        samplesAbove: 0,
        samplesBelow: 0,
        lastHoldReason: null
      };
    }

    const h = robot._hysteresis;
    const dwellElapsed = (currentTimeSeconds - h.stateEnteredTime) >= this.minimumDwellTimeSeconds;

    let nextState = currentState;
    let transitionReason = null;
    let isEscalation = false;
    let isHold = false;

    // 1. Extreme Risk Check -> SAFE-DEGRADED
    if (currentRisk >= this.thresholds.T_degraded_enter && currentState !== "SAFE-DEGRADED") {
      h.samplesAbove++;
      if (h.samplesAbove >= this.persistenceSamplesRequired) {
        nextState = "SAFE-DEGRADED";
        isEscalation = true;
        transitionReason = this.explainRiskDominance(riskInputs, "SAFE-DEGRADED", true);
        h.stateEnteredTime = currentTimeSeconds;
        h.samplesAbove = 0;
        h.samplesBelow = 0;
      }
    } else if (currentState === "SAFE-DEGRADED") {
      if (currentRisk <= this.thresholds.T_degraded_exit && dwellElapsed) {
        h.samplesBelow++;
        if (h.samplesBelow >= this.persistenceSamplesRequired) {
          nextState = this._releaseTarget(currentRisk, "CONTAINMENT");
          transitionReason = this.explainRiskDominance(riskInputs, nextState, false);
          h.stateEnteredTime = currentTimeSeconds;
          h.samplesAbove = 0;
          h.samplesBelow = 0;
        }
      } else {
        h.samplesBelow = 0;
        if (currentRisk <= this.thresholds.T_degraded_exit && !dwellElapsed) {
          isHold = true;
          h.lastHoldReason = `Hysteresis hold in SAFE-DEGRADED: risk (${currentRisk.toFixed(2)}) below exit threshold, awaiting dwell time (${(this.minimumDwellTimeSeconds - (currentTimeSeconds - h.stateEnteredTime)).toFixed(1)}s remaining).`;
        }
      }
    } else if (currentState === "LOCAL") {
      if (currentRisk >= this.thresholds.T_local_enter) {
        h.samplesAbove++;
        if (h.samplesAbove >= this.persistenceSamplesRequired) {
          nextState = "NEIGHBORHOOD";
          isEscalation = true;
          transitionReason = this.explainRiskDominance(riskInputs, "NEIGHBORHOOD", true);
          h.stateEnteredTime = currentTimeSeconds;
          h.samplesAbove = 0;
          h.samplesBelow = 0;
        }
      } else {
        h.samplesAbove = 0;
      }
    } else if (currentState === "NEIGHBORHOOD") {
      if (currentRisk >= this.thresholds.T_neigh_enter) {
        h.samplesAbove++;
        if (h.samplesAbove >= this.persistenceSamplesRequired) {
          nextState = "CONTAINMENT";
          isEscalation = true;
          transitionReason = this.explainRiskDominance(riskInputs, "CONTAINMENT", true);
          h.stateEnteredTime = currentTimeSeconds;
          h.samplesAbove = 0;
          h.samplesBelow = 0;
        }
      } else if (currentRisk <= this.thresholds.T_neigh_exit && dwellElapsed) {
        h.samplesBelow++;
        if (h.samplesBelow >= this.persistenceSamplesRequired) {
          nextState = "LOCAL";
          transitionReason = this.explainRiskDominance(riskInputs, "LOCAL", false);
          h.stateEnteredTime = currentTimeSeconds;
          h.samplesAbove = 0;
          h.samplesBelow = 0;
        }
      } else {
        h.samplesAbove = 0;
        h.samplesBelow = 0;
        // Check for hysteresis hold
        if (currentRisk <= this.thresholds.T_local_enter && currentRisk > this.thresholds.T_neigh_exit) {
          isHold = true;
          h.lastHoldReason = `Hysteresis hold in NEIGHBORHOOD: risk (${currentRisk.toFixed(2)}) between exit (${this.thresholds.T_neigh_exit}) and entry (${this.thresholds.T_local_enter}). Flapping prevented.`;
        } else if (currentRisk <= this.thresholds.T_neigh_exit && !dwellElapsed) {
          isHold = true;
          h.lastHoldReason = `Hysteresis hold in NEIGHBORHOOD: dwell time active (${(this.minimumDwellTimeSeconds - (currentTimeSeconds - h.stateEnteredTime)).toFixed(1)}s remaining).`;
        }
      }
    } else if (currentState === "CONTAINMENT") {
      if (currentRisk <= this.thresholds.T_contain_exit && dwellElapsed) {
        h.samplesBelow++;
        if (h.samplesBelow >= this.persistenceSamplesRequired) {
          nextState = this._releaseTarget(currentRisk, "NEIGHBORHOOD");
          transitionReason = this.explainRiskDominance(riskInputs, nextState, false);
          h.stateEnteredTime = currentTimeSeconds;
          h.samplesAbove = 0;
          h.samplesBelow = 0;
        }
      } else {
        h.samplesBelow = 0;
        if (currentRisk <= this.thresholds.T_neigh_enter && currentRisk > this.thresholds.T_contain_exit) {
          isHold = true;
          h.lastHoldReason = `Hysteresis hold in CONTAINMENT: risk (${currentRisk.toFixed(2)}) between exit (${this.thresholds.T_contain_exit}) and entry (${this.thresholds.T_neigh_enter}).`;
        } else if (currentRisk <= this.thresholds.T_contain_exit && !dwellElapsed) {
          isHold = true;
          h.lastHoldReason = `Hysteresis hold in CONTAINMENT: dwell time active (${(this.minimumDwellTimeSeconds - (currentTimeSeconds - h.stateEnteredTime)).toFixed(1)}s remaining).`;
        }
      }
    }

    const transitioned = nextState !== currentState;
    robot.raceState = nextState;

    // Envelope radius follows the RACE state. The coordination scope (group
    // size) is set by the ACE session manager from the robots actually in the
    // session; here only the baseline label is set.
    robot.envelopeRadius = ENVELOPE_RADIUS[nextState];
    if (transitioned) {
      robot.coordinationScope = nextState === "SAFE-DEGRADED" ? "1 robot (safe-degraded crawl)" : nextState === "LOCAL" ? "1 robot (local)" : robot.coordinationScope;
    }

    const transitionDir = isEscalation ? "ESCALATE" : transitioned ? "DE_ESCALATE" : "HOLD";
    const tReason = transitionReason || (isHold ? h.lastHoldReason : "Normal operation within envelope thresholds.");
    const hState = isHold ? "HOLD" : transitioned ? (isEscalation ? "ESCALATING" : "DE_ESCALATING") : "STABLE";

    return {
      transitioned,
      isHold,
      holdReason: isHold ? h.lastHoldReason : null,
      previousState: currentState,
      currentState: nextState,
      previousEnvelope: currentState,
      currentEnvelope: nextState,
      risk: currentRisk,
      transitionDirection: transitionDir,
      transitionReason: tReason,
      reason: tReason,
      hysteresisState: hState,
      timestamp: Date.now()
    };
  }

  /**
   * 5.5 Spatiotemporal Conflict Detection
   * SpatialOverlap(path_A, path_B) AND TemporalOverlap(t_A, t_B)
   */
  detectSpatiotemporalConflict(robotA, robotB, thresholdDist = 28) {
    if (!robotA || !robotB || robotA.id === robotB.id) return null;

    const dx = robotA.x - robotB.x;
    const dy = robotA.y - robotB.y;
    const currentDist = Math.hypot(dx, dy);

    // Immediate proximity check
    if (currentDist < thresholdDist) {
      return {
        robotA: robotA.id,
        robotB: robotB.id,
        timeToConflict: 0.0,
        conflictPoint: { x: (robotA.x + robotB.x) / 2, y: (robotA.y + robotB.y) / 2 },
        severity: "HIGH"
      };
    }

    // Predict 0.5 to 3.0 seconds forward along heading & velocity
    const speedA = robotA.velocity || 1.2;
    const speedB = robotB.velocity || 1.2;
    // Within the 3 s horizon the pair can close at most (speedA + speedB) * 60
    // px; farther pairs can never conflict (exact bound, not a heuristic).
    if (currentDist - (Math.abs(speedA) + Math.abs(speedB)) * 3.0 * 20 >= thresholdDist) return null;

    for (let t = 0.5; t <= 3.0; t += 0.5) {
      const futureAx = robotA.x + Math.cos(robotA.heading || 0) * speedA * t * 20;
      const futureAy = robotA.y + Math.sin(robotA.heading || 0) * speedA * t * 20;

      const futureBx = robotB.x + Math.cos(robotB.heading || 0) * speedB * t * 20;
      const futureBy = robotB.y + Math.sin(robotB.heading || 0) * speedB * t * 20;

      const futureDist = Math.hypot(futureAx - futureBx, futureAy - futureBy);
      if (futureDist < thresholdDist) {
        return {
          robotA: robotA.id,
          robotB: robotB.id,
          timeToConflict: parseFloat(t.toFixed(1)),
          conflictPoint: { x: (futureAx + futureBx) / 2, y: (futureAy + futureBy) / 2 },
          severity: t < 1.5 ? "HIGH" : "MEDIUM"
        };
      }
    }

    return null;
  }

  /**
   * 5.6 Deadlock Detection - cycle in wait_for_graph
   */
  detectDeadlock(waitGraph) {
    const visited = new Set();
    const recStack = new Set();
    const cycles = [];

    const dfs = (node, path) => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      const neighbors = waitGraph[node] || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, [...path]);
        } else if (recStack.has(neighbor)) {
          const cycleStartIdx = path.indexOf(neighbor);
          if (cycleStartIdx !== -1) {
            cycles.push(path.slice(cycleStartIdx));
          }
        }
      }

      recStack.delete(node);
    };

    for (const node of Object.keys(waitGraph)) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
  }
}

export const raceEvaluator = new RaceEvaluator();
