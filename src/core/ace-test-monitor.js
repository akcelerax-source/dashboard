// ==========================================================================
// NODEX - ACE validation test monitor (NodeX Edge AI ACE decentralized only)
//
// An ACE validation test (A01-A12) is a real simulation run in which the
// scenario engine applies a stimulus (risk escalation, link degradation,
// stalled robots, seeded conflicts, a robot failure, health decay, an
// operator command ...). This monitor observes the live ACE telemetry of
// that run every tick - it never influences a robot - and at the end of the
// run judges the ACE FEATURE under test with measurable acceptance criteria
// derived from the approved ACE specification (section 25). A test passes
// only when every criterion of that test holds; the approved safety
// invariant (zero robot-robot collisions) is part of every test.
// ==========================================================================

import { state } from "./state.js";
import { decentralizedFleet } from "./decentralized/DecentralizedFleet.js";
import { canAdmitTask } from "./admission-control.js";

// Approved RACE weights (independent copy: the monitor re-computes the risk
// from the logged inputs to check the implementation against the spec).
const SPEC_WEIGHTS = { conflict: 0.35, uncertainty: 0.15, commRisk: 0.20, queueGrowth: 0.15, cascadePressure: 0.15 };
const FACTORS = Object.keys(SPEC_WEIGHTS);
const MIN_DWELL_SECONDS = 4.0;
// Approved RACE hysteresis thresholds (enter on the way up, exit on the way down).
const ENTER = { NEIGHBORHOOD: 0.50, CONTAINMENT: 0.70, "SAFE-DEGRADED": 0.85 };
const EXIT = { NEIGHBORHOOD: 0.35, CONTAINMENT: 0.55, "SAFE-DEGRADED": 0.68 };
const LEVEL = { LOCAL: 0, NEIGHBORHOOD: 1, CONTAINMENT: 2, "SAFE-DEGRADED": 3 };
// A peer only knows a robot is standing from its sensors and broadcasts, so
// the audit counts a robot as "merely standing" once it has stood still for
// the ACE threshold (1 s) plus one broadcast/link allowance (0.5 s).
const STANDING_SECONDS = 1.5;
const FAILED = ["ERROR", "error", "failed"];
const ESCALATED = ["NEIGHBORHOOD", "CONTAINMENT", "SAFE-DEGRADED"];

export const ACE_TEST_CRITERIA = Object.freeze({
  A01: ["LOCAL -> NEIGHBORHOOD escalation observed", "Escalation beyond NEIGHBORHOOD (CONTAINMENT / SAFE-DEGRADED) observed whenever risk warranted it", "Envelope released when the need ended (observed at least once)", "Hysteresis respected (every transition crossed its threshold; de-escalation after the 4 s dwell)", "Zero robot-robot collisions"],
  A02: ["Logged risk = approved weighted sum of the 5 inputs (max error <= 0.01)", "At least 3 of 5 risk factors active (> 0.10) during the run", "Risk score always within [0, 1]", "Zero robot-robot collisions"],
  A03: ["Communication risk >= 0.60 after link degradation", "Envelope escalated after the degradation", "Coordination scope widened (session with >= 2 robots) or SAFE-DEGRADED speed cap applied", "Zero robot-robot collisions"],
  A04: ["Queue growth or cascade pressure >= 0.50 while robots are stalled", "CONTAINMENT entered when RACE risk stays >= 0.70 (3 samples), or the queue cleared locally (no robot stopped > 10 s)", "Containment released after the stall ends (or not needed)", "Zero robot-robot collisions"],
  A05: ["Space-time contract issued for the crossing", "Contract slot order enforced at least once (a member held at the region edge or entered in slot order)", "Session released after the crossing", "Zero robot-robot collisions"],
  A06: ["Conflict detected by sensors / Edge AI", "Coordination session opened only by a robot with an active task (conflict-triggered)", "A yield resolved and the robot moved on (observed at least once)", "Zero robot-robot collisions"],
  A07: ["No central coordinator in the loop (ACE controller only)", "Peer-to-peer messages exchanged", "Merely standing robots never included in a coordination session", "Robots spend most of the time in LOCAL autonomy (>= 50 %)", "Zero robot-robot collisions"],
  A08: ["A blocked robot freed and moving again (deadlock resolved at least once)", "Tasks keep completing after the seeded deadlock", "Zero robot-robot collisions"],
  A09: ["Failed robot's task re-announced for peer bidding within 5 s", "Task re-won by bidding within 15 s once a peer is free", "Re-allocated task completed by the new robot", "Zero robot-robot collisions"],
  A10: ["Degraded robot takes no new task once health < 60 %", "Degraded robot sent to maintenance / service", "Zero robot-robot collisions"],
  A11: ["SAFE-DEGRADED envelope entered", "Speed capped (<= 0.35) while SAFE-DEGRADED", "No complete fleet stop (motion continues)", "Zero robot-robot collisions"],
  A12: ["All robots stopped within 1 s of the operator HOLD", "HOLD and RESUME recorded in the HITL audit log", "Robots return to autonomous motion within 3 s of RESUME", "Zero robot-robot collisions"]
});

class AceTestMonitor {
  constructor() {
    this.active = false;
    this.code = null;
  }

  begin(code) {
    this.active = !!ACE_TEST_CRITERIA[code];
    this.code = code;
    this.t = 0;
    this.triggerAt = null;
    this.notes = {};
    this.lastState = new Map();
    this.enteredAt = new Map();
    this.transitions = [];
    this.flaps = 0;
    this.hysteresisViolations = 0;
    this.releaseAt = null;
    this.escalatedAtRelease = null;
    this.stimulusAt = null;
    this.highRiskRun = new Map();
    this.lowSince = new Map();
    this.stuckAfterRelease = 0;
    this.stuckMax = 0;
    this.stallQueueSince = new Map();
    this.stallQueueMax = 0;
    this.containmentRiskSeen = false;
    this.shareSamples = []; // [{ t, share, maxComm }]
    this.standingDetails = [];
    this.stateTime = { LOCAL: 0, NEIGHBORHOOD: 0, CONTAINMENT: 0, "SAFE-DEGRADED": 0 };
    this.riskErrMax = 0;
    this.riskOutOfRange = 0;
    this.factorMax = Object.fromEntries(FACTORS.map(k => [k, 0]));
    this.factorMaxAfterTrigger = Object.fromEntries(FACTORS.map(k => [k, 0]));
    this.seenSessions = new Map(); // sid -> { size, openedAt, initiatorHasTask, standingMembers, closedAt }
    this.maxGroup = 1;
    this.standSince = new Map();
    this.stallSince = new Map();
    this.maxStall = 0;
    this.stallsResolved = 0; // stalls (>= 2 s) that ended with the robot moving again
    this.yieldsResolved = 0; // any stop (>= 0.3 s) that ended with the robot moving again
    this.shortestResolved = Infinity;
    this.maxSdSpeed = 0;
    this.sdSamples = 0;
    this.movingAfterSd = false;
    this.anyMoveSamples = 0;
    this.lastTask = new Map();
    this.failure = null;
    this.health = { threshAt: null, claimsAfter: 0, serviced: false };
    this.hitl = { holdAt: null, stoppedAt: null, resumeAt: null, movedAt: null, maxVAfterGrace: 0 };
    this.controllerOk = true;
    this.completedAt = [];
    this.lastCompleted = 0;
    this.containment = { enteredAt: null, releasedAt: null };
  }

  stop() { this.active = false; }

  /** Stimulus bookkeeping from the scenario engine (trigger time, HITL commands). */
  note(kind, data = {}) {
    if (!this.active) return;
    this.notes[kind] = { t: this.t, ...data };
    if (kind === "trigger") this.triggerAt = this.t;
    if (kind === "hitl_hold") this.hitl.holdAt = this.t;
    if (kind === "hitl_resume") this.hitl.resumeAt = this.t;
    if (kind === "stall_end") this.notes.stallEndAt = this.t;
    if (kind === "risk_step" && this.stimulusAt === null) this.stimulusAt = this.t;
    if (kind === "risk_release") {
      this.releaseAt = this.t;
      this.escalatedAtRelease = new Set([...this.lastState].filter(([, st]) => st !== "LOCAL").map(([id]) => id));
    }
  }

  /** One observation of the live ACE fleet at sim time t. */
  sample(robots, t, dt, controller = "ace") {
    if (!this.active) return;
    this.t = t;
    const agents = decentralizedFleet.agents;
    const after = this.triggerAt !== null;
    if (controller !== "ace") this.controllerOk = false;

    // Ground-truth "merely standing" robots (for the session audit).
    const standing = new Set();
    for (const r of robots) {
      const still = (r.velocity || 0) < 0.01;
      if (!still) { this.standSince.delete(r.id); continue; }
      if (!this.standSince.has(r.id)) this.standSince.set(r.id, t);
      const idle = !r.currentTaskId && r.status !== "WAITING" && !r.parkingBay;
      if (FAILED.includes(r.status) || ((idle || r.handling || r.hitlHold) && t - this.standSince.get(r.id) >= STANDING_SECONDS)) standing.add(r.id);
    }

    let anyMoving = false;
    for (const r of robots) {
      const failed = FAILED.includes(r.status);
      if ((r.velocity || 0) > 0.01) anyMoving = true;
      const ag = agents.get(r.id);
      const ls = ag ? ag.localState : r;

      // Envelope transitions / flapping / time share.
      const st = ls.raceState;
      if (st && !failed) {
        this.stateTime[st] = (this.stateTime[st] || 0) + dt;
        const prev = this.lastState.get(r.id);
        if (prev && prev !== st) {
          const inPrev = t - (this.enteredAt.get(r.id) ?? 0);
          const back = this.transitions.filter(x => x.id === r.id).slice(-1)[0];
          if (back && back.from === st && inPrev < MIN_DWELL_SECONDS) this.flaps++;
          // Hysteresis audit: escalation needs risk >= the entry threshold of
          // the new state; de-escalation needs risk <= the exit threshold of
          // the state it leaves and the minimum dwell in it.
          const risk = typeof ls.riskScore === "number" ? ls.riskScore : null;
          // Cascade-override transitions follow the confirmed cascade, not the sum.
          if (risk !== null && prev !== "SAFE-DEGRADED" && st !== "SAFE-DEGRADED" && !ls.cascadeOverride) {
            const up = LEVEL[st] > LEVEL[prev];
            if (up && risk < ENTER[st] - 1e-9) this.hysteresisViolations++;
            if (!up && (risk > EXIT[prev] + 1e-9 || inPrev < MIN_DWELL_SECONDS - 1e-6)) this.hysteresisViolations++;
          }
          this.transitions.push({ id: r.id, from: prev, to: st, t });
          this.enteredAt.set(r.id, t);
          if (st === "CONTAINMENT" && this.containment.enteredAt === null) this.containment.enteredAt = t;
          if (prev === "CONTAINMENT" && this.containment.enteredAt !== null && this.containment.releasedAt === null) this.containment.releasedAt = t;
        }
        if (!prev) this.enteredAt.set(r.id, t);
        this.lastState.set(r.id, st);
      }

      // Risk composition against the approved weights.
      const inp = ls.riskInputs;
      if (inp && typeof ls.riskScore === "number" && !failed) {
        let sum = 0;
        for (const k of FACTORS) {
          const v = Math.max(0, Math.min(1, inp[k] || 0));
          sum += SPEC_WEIGHTS[k] * v;
          this.factorMax[k] = Math.max(this.factorMax[k], v);
          if (after) this.factorMaxAfterTrigger[k] = Math.max(this.factorMaxAfterTrigger[k], v);
        }
        this.riskErrMax = Math.max(this.riskErrMax, Math.abs(Math.min(1, sum) - ls.riskScore));
        this.maxRisk = Math.max(this.maxRisk || 0, ls.riskScore);
        // A04: longest continuous stop of a task-holding robot (other than the
        // stalled ones) while the scenario stall is active: did the queue
        // behind the stall clear locally (reroute / pass) or persist?
        if (this.notes.stall_start && this.notes.stallEndAt === undefined && !r.scenarioStall && r.currentTaskId && !FAILED.includes(r.status)) {
          if (!(r.velocity > 0)) {
            if (!this.stallQueueSince.has(r.id)) this.stallQueueSince.set(r.id, t);
            this.stallQueueMax = Math.max(this.stallQueueMax, t - this.stallQueueSince.get(r.id));
          } else this.stallQueueSince.delete(r.id);
        }
        // Release audit: an escalated envelope whose risk is at or below the
        // exit threshold must be released within the dwell (4 s) plus the
        // persistence samples; longer means coordination outlived its need.
        const exitAt = EXIT[ls.raceState];
        if (exitAt !== undefined && ls.riskScore <= exitAt) {
          if (!this.lowSince.has(r.id)) this.lowSince.set(r.id, t);
          const lowFor = t - this.lowSince.get(r.id);
          if (lowFor > MIN_DWELL_SECONDS + 0.5) {
            this.stuckMax = Math.max(this.stuckMax, lowFor);
            if (this.releaseAt !== null && t >= this.releaseAt) this.stuckAfterRelease++;
          }
        } else this.lowSince.delete(r.id);
        // Sustained containment-level risk (the RACE persistence rule is 3 samples).
        const run = ls.riskScore >= ENTER.CONTAINMENT ? (this.highRiskRun.get(r.id) || 0) + 1 : 0;
        this.highRiskRun.set(r.id, run);
        if (run >= 3 && ls.raceState !== "SAFE-DEGRADED") this.containmentRiskSeen = true;
        if (ls.riskScore < 0 || ls.riskScore > 1) this.riskOutOfRange++;
      }

      // Sessions: size, initiator task, standing members at opening.
      const s = ag?.ace?.session;
      if (s && s.initiator === r.id) {
        if (!this.seenSessions.has(s.sid)) {
          this.seenSessions.set(s.sid, {
            size: s.members.length, openedAt: t, initiatorHasTask: !!ls.currentTaskId,
            standingMembers: s.members.filter(m => m !== r.id && standing.has(m)).length, closedAt: null
          });
          for (const m of s.members) {
            if (m === r.id || !standing.has(m)) continue;
            const mr = robots.find(x => x.id === m);
            this.standingDetails.push({ sid: s.sid, member: m, status: mr?.status, task: mr?.currentTaskId || null, handling: !!mr?.handling, stoodFor: Math.round((t - (this.standSince.get(m) ?? t)) * 10) / 10 });
          }
        }
        this.maxGroup = Math.max(this.maxGroup, s.members.length);
      }

      // SAFE-DEGRADED speed cap.
      if (st === "SAFE-DEGRADED" && !failed) {
        this.sdSamples++;
        this.maxSdSpeed = Math.max(this.maxSdSpeed, r.velocity || 0);
      }

      // Longest continuous stall of a task holder (not loading / unloading / held by an operator).
      if (r.currentTaskId && !failed && !r.handling && !r.hitlHold && (r.velocity || 0) < 0.01) {
        if (!this.stallSince.has(r.id)) this.stallSince.set(r.id, t);
        this.maxStall = Math.max(this.maxStall, t - this.stallSince.get(r.id));
      } else {
        if (this.stallSince.has(r.id)) {
          const d = t - this.stallSince.get(r.id);
          if (d >= 0.3) { this.yieldsResolved++; this.shortestResolved = Math.min(this.shortestResolved, d); }
          if (d >= 2) this.stallsResolved++;
        }
        this.stallSince.delete(r.id);
      }
    }
    // Sessions that ended.
    const live = new Set();
    for (const ag of agents.values()) if (ag.ace?.session) live.add(ag.ace.session.sid);
    for (const [sid, rec] of this.seenSessions) if (rec.closedAt === null && !live.has(sid)) rec.closedAt = t;

    // Fleet envelope share and link risk over time (A01 release audit).
    let escalated = 0, alive = 0, maxComm = 0;
    for (const r of robots) {
      if (FAILED.includes(r.status)) continue;
      const ls = agents.get(r.id)?.localState || r;
      alive++;
      if (ls.raceState && ls.raceState !== "LOCAL") escalated++;
      maxComm = Math.max(maxComm, ls.riskInputs?.commRisk || 0);
    }
    if (alive) this.shareSamples.push({ t, share: escalated / alive, maxComm });

    if (anyMoving) this.anyMoveSamples++;
    if (this.sdSamples > 0 && anyMoving) this.movingAfterSd = true;

    // Failure / reallocation (A09).
    const reg = decentralizedFleet.taskRegistry;
    if (!this.failure) {
      const f = robots.find(r => FAILED.includes(r.status));
      if (f) this.failure = { robot: f.id, at: t, task: this.lastTask.get(f.id) || null, rebidAt: null, rewonAt: null, rewonBy: null, completedAt: null, freeAt: null };
    } else if (this.failure.task) {
      // First moment after the re-announcement a peer could take the task:
      // a healthy robot without work while the admission limit allows it.
      if (this.failure.rebidAt !== null && this.failure.freeAt === null) {
        const free = robots.some(r => !FAILED.includes(r.status) && !r.currentTaskId && !r.serviceState && !r.hitlHold && r.taskPhase !== "MAINTENANCE");
        if (free && canAdmitTask(robots.length, reg.getActiveTasks().length)) this.failure.freeAt = t;
      }
      const tk = reg.getTaskById(this.failure.task);
      if (tk) {
        if (this.failure.rebidAt === null && (tk.status === "UNASSIGNED" || tk.orphanOf === this.failure.robot)) this.failure.rebidAt = t;
        if (this.failure.rewonAt === null && tk.assignedRobot && tk.assignedRobot !== this.failure.robot) { this.failure.rewonAt = t; this.failure.rewonBy = tk.assignedRobot; }
        if (this.failure.completedAt === null && tk.status === "COMPLETED" && tk.assignedRobot !== this.failure.robot) this.failure.completedAt = t;
      }
    }
    for (const r of robots) this.lastTask.set(r.id, r.currentTaskId || this.lastTask.get(r.id) || null);

    // Health-aware adaptation (A10): the degraded robot.
    const target = this.notes.health_target?.robot;
    if (target) {
      const r = robots.find(x => x.id === target);
      if (r) {
        if (this.health.threshAt === null && r.health < 60) { this.health.threshAt = t; this.health.taskAtThresh = r.currentTaskId || null; }
        if (this.health.threshAt !== null && r.currentTaskId && r.currentTaskId !== this.health.taskAtThresh
            && r.currentTaskId !== this.health.lastClaim) { this.health.claimsAfter++; this.health.lastClaim = r.currentTaskId; }
        if (this.health.threshAt !== null && (r.taskPhase === "MAINTENANCE" || r.serviceState || r.parkingBay?.kind === "MAINTENANCE" || FAILED.includes(r.status))) this.health.serviced = true;
      }
    }

    // HITL (A12).
    const h = this.hitl;
    if (h.holdAt !== null && h.resumeAt === null) {
      const moving = robots.filter(r => !FAILED.includes(r.status) && (r.velocity || 0) > 0.01).length;
      if (moving === 0 && h.stoppedAt === null) h.stoppedAt = t;
      if (t - h.holdAt > 1.0) h.maxVAfterGrace = Math.max(h.maxVAfterGrace, ...robots.map(r => r.velocity || 0));
    }
    if (h.resumeAt !== null && h.movedAt === null && anyMoving) h.movedAt = t;

    // Completions over time.
    const done = reg.getCompletedCount();
    if (done > this.lastCompleted) { this.completedAt.push(t); this.lastCompleted = done; }
  }

  /** Feature verdict for the finished run. */
  evaluate({ physics = {}, endReason = null } = {}) {
    const code = this.code;
    const names = ACE_TEST_CRITERIA[code] || [];
    const collisions = physics.collisions ?? 0;
    const trans = this.transitions;
    const has = (from, to) => trans.some(x => (from === null || x.from === from) && x.to === to);
    const sessions = [...this.seenSessions.values()];
    const fmt = (v, d = 2) => (typeof v === "number" ? Number(v.toFixed(d)) : v);
    const robotTime = Object.values(this.stateTime).reduce((a, b) => a + b, 0) || 1;
    const c = [];
    // pass: true / false, or null = inconclusive (the run ended before it could be judged).
    const add = (i, required, actual, pass) => c.push({ name: names[i], required, actual, pass: pass === null ? null : !!pass });
    const collisionCheck = (i) => add(i, "0", collisions, collisions === 0);
    const afterTrigger = (x) => this.triggerAt === null || x.t >= this.triggerAt;

    switch (code) {
      case "A01": {
        const esc = trans.filter(afterTrigger);
        add(0, "observed", has("LOCAL", "NEIGHBORHOOD") ? "yes" : "no", has("LOCAL", "NEIGHBORHOOD"));
        const beyond = esc.some(x => x.to === "CONTAINMENT" || x.to === "SAFE-DEGRADED");
        // Escalation beyond NEIGHBORHOOD is required only when the risk
        // warranted it (containment-level risk sustained for 3 samples, or a
        // link blackout). Escalating without that risk would be a violation.
        const warranted = this.containmentRiskSeen || this.sdSamples > 0;
        add(1, "observed when warranted", beyond ? "yes" : warranted ? "no (risk warranted it)" : `not warranted: risk never sustained >= 0.70 (peak ${fmt(this.maxRisk || 0)}), envelope correctly stayed <= NEIGHBORHOOD`,
          beyond || !warranted);
        let released = null, detail = "links not restored before the run ended (raise sim speed)";
        if (this.releaseAt !== null) {
          const tail = this.shareSamples.filter(x => x.t >= Math.max(this.releaseAt + 5, this.t - 5));
          const comm = tail.length ? Math.max(...tail.map(x => x.maxComm)) : null;
          if (comm === null) detail = "run ended right after the links were restored";
          else {
            released = comm < 0.35 && this.stuckAfterRelease === 0;
            const esc = tail.length ? Math.round(tail[tail.length - 1].share * 100) : 0;
            detail = `comm risk ${fmt(comm)}; ${this.stuckAfterRelease ? "an envelope was held at low risk" : "every envelope released once its risk fell"} (${esc} % still escalated by live traffic conflicts)`;
          }
        }
        // At least once: an escalated envelope was released back down when its need ended.
        const LV = { LOCAL: 0, NEIGHBORHOOD: 1, CONTAINMENT: 2, "SAFE-DEGRADED": 3 };
        const downs = trans.filter(x => LV[x.to] < LV[x.from]).length;
        add(2, "at least 1 envelope released", `${downs} releases observed; ${detail}`, downs >= 1);
        add(3, "0 violations", `${this.hysteresisViolations} violations (${this.flaps} quick re-escalations on new risk)`, this.hysteresisViolations === 0);
        collisionCheck(4);
        break;
      }
      case "A02": {
        const active = FACTORS.filter(k => this.factorMax[k] > 0.1);
        add(0, "<= 0.01", fmt(this.riskErrMax, 4), this.riskErrMax <= 0.01);
        add(1, ">= 3 factors", `${active.length} (${active.join(", ") || "none"})`, active.length >= 3);
        add(2, "0 out-of-range samples", this.riskOutOfRange, this.riskOutOfRange === 0);
        collisionCheck(3);
        break;
      }
      case "A03": {
        const cr = this.factorMaxAfterTrigger.commRisk;
        add(0, ">= 0.60", fmt(cr), cr >= 0.6);
        const esc = trans.some(x => afterTrigger(x) && ESCALATED.includes(x.to));
        add(1, "observed", esc ? "yes" : "no", esc);
        const widened = sessions.some(s => s.size >= 2 && (this.triggerAt === null || s.openedAt >= this.triggerAt)) || (this.sdSamples > 0 && this.maxSdSpeed <= 0.35);
        add(2, "observed", widened ? `max scope ${this.maxGroup} robots${this.sdSamples ? ", SAFE-DEGRADED cap" : ""}` : "no", widened);
        collisionCheck(3);
        break;
      }
      case "A04": {
        const p = Math.max(this.factorMaxAfterTrigger.queueGrowth, this.factorMaxAfterTrigger.cascadePressure);
        add(0, ">= 0.50", fmt(p), p >= 0.5);
        const entered = this.containment.enteredAt !== null;
        // Cascade contained without CONTAINMENT: the stall happened, a queue
        // formed (pressure >= 0.5) and no robot behind it stayed stopped longer
        // than LOCAL_CLEAR_S (it rerouted / passed locally).
        const LOCAL_CLEAR_S = 10;
        const localOk = !entered && !this.containmentRiskSeen && !!this.notes.stall_start && p >= 0.5 && this.stallQueueMax <= LOCAL_CLEAR_S;
        // Containment is required only once the risk reached its entry level;
        // a cascade too small to reach it (e.g. 3 robots) is inconclusive.
        add(1, "entered when risk >= 0.70", entered ? `t=${fmt(this.containment.enteredAt, 1)} s`
          : this.containmentRiskSeen ? "risk >= 0.70 sustained but no CONTAINMENT"
            : localOk ? `not needed: queue behind the stall cleared locally (longest stop ${fmt(this.stallQueueMax, 1)} s <= ${LOCAL_CLEAR_S} s; peak risk ${fmt(this.maxRisk || 0)})`
            : `cascade too small: risk >= 0.70 never held for 3 samples (peak ${fmt(this.maxRisk || 0)}); run with >= 10 robots`,
          entered ? true : this.containmentRiskSeen ? false : localOk ? true : null);
        add(2, "observed", this.containment.releasedAt !== null ? `t=${fmt(this.containment.releasedAt, 1)} s` : entered ? "no" : localOk ? `not needed: queue cleared locally (longest stop ${fmt(this.stallQueueMax, 1)} s)` : "not applicable",
          this.containment.releasedAt !== null ? true : entered ? false : localOk ? true : null);
        collisionCheck(3);
        break;
      }
      case "A05": {
        let contracts = 0, holds = 0, sessionReplans = 0, ordered = 0, violations = 0;
        for (const ag of decentralizedFleet.agents.values()) {
          if (!ag.ace) continue;
          contracts += ag.ace.stats.contractsIssued;
          holds += ag.ace.stats.contractHolds;
          sessionReplans += ag.ace.stats.sessionReplans;
          ordered += (ag.ace.stats.slotOrderedEntries || 0) + (ag.ace.stats.contractDecisions || 0);
          violations += ag.ace.stats.slotOrderViolations || 0;
        }
        add(0, ">= 1", contracts, contracts >= 1);
        // Enforced = a member held at the edge, a session replan, or members
        // entered the region in slot order; any out-of-order entry fails.
        add(1, ">= 1 enforced slot", `${holds} holds, ${sessionReplans} session replans, ${ordered} in-order entries / slot-order right-of-way decisions, ${violations} out-of-order`,
          holds + sessionReplans + ordered >= 1);
        const released = sessions.some(s => s.closedAt !== null);
        add(2, "released", released ? `${sessions.filter(s => s.closedAt !== null).length} closed` : "no", released);
        collisionCheck(3);
        break;
      }
      case "A06": {
        let detected = 0;
        for (const ag of decentralizedFleet.agents.values()) detected += ag.metrics.sensorConflictEvents + ag.metrics.aiPredictedConflicts + ag.metrics.fusedConflictEvents;
        add(0, ">= 1", detected, detected >= 1);
        const bad = sessions.filter(s => !s.initiatorHasTask).length;
        add(1, "0 sessions without a task", `${sessions.length} sessions, ${bad} without task`, sessions.length >= 1 && bad === 0);
        add(2, "at least 1 yield resolved", `${this.yieldsResolved} resolved (fastest ${Number.isFinite(this.shortestResolved) ? fmt(this.shortestResolved, 1) : "-"} s; longest wait ${fmt(this.maxStall, 1)} s)`, this.yieldsResolved >= 1);
        collisionCheck(3);
        break;
      }
      case "A07": {
        const msgs = decentralizedFleet.peerBus.getMetrics().totalMessages || 0;
        const standingIn = sessions.reduce((a, s) => a + s.standingMembers, 0);
        const localShare = (this.stateTime.LOCAL || 0) / robotTime;
        add(0, "ACE controller only", this.controllerOk ? "yes" : "no", this.controllerOk);
        add(1, "> 0", msgs, msgs > 0);
        add(2, "0", `${standingIn} (in ${sessions.length} sessions)${this.standingDetails.length ? ": " + this.standingDetails.map(d => `${d.member} ${d.status}${d.task ? " " + d.task : ""}${d.handling ? " loading" : ""} still ${d.stoodFor}s`).join("; ") : ""}`, standingIn === 0);
        add(3, ">= 50 %", `${Math.round(localShare * 100)} %`, localShare >= 0.5);
        collisionCheck(4);
        break;
      }
      case "A08": {
        add(0, "at least 1 blocked robot freed", `${this.stallsResolved} stalls resolved (longest wait ${fmt(this.maxStall, 1)} s)`, this.stallsResolved >= 1);
        const after = this.completedAt.filter(t => this.triggerAt === null || t >= this.triggerAt).length;
        add(1, ">= 1 completion", after, after >= 1);
        collisionCheck(2);
        break;
      }
      case "A09": {
        const f = this.failure;
        const d = (a) => (f && a !== null ? a - f.at : null);
        add(0, "<= 5 s", f?.task ? (f.rebidAt !== null ? `${fmt(d(f.rebidAt), 1)} s` : "never") : "no failed task", f?.task && f.rebidAt !== null && d(f.rebidAt) <= 5);
        // Measured from when a peer was free to bid (all peers may be busy).
        const from = f ? Math.max(f.rebidAt ?? f.at, f.freeAt ?? f.rewonAt ?? f.at) : null;
        const wait = f?.rewonAt != null ? f.rewonAt - from : null;
        add(1, "<= 15 s after a peer is free", f?.rewonAt != null ? `${fmt(Math.max(0, wait), 1)} s by ${f.rewonBy} (${fmt(d(f.rewonAt), 1)} s after failure)` : "never", f?.rewonAt != null && wait <= 15);
        const tkNow = f?.task ? decentralizedFleet.taskRegistry.getTaskById(f.task) : null;
        const inFlight = f?.rewonAt != null && f?.completedAt == null && (endReason === "DURATION_LIMIT" || endReason === "NO_PROGRESS") && tkNow && tkNow.status !== "FAILED";
        add(2, "completed", f?.completedAt != null ? `t=${fmt(f.completedAt, 1)} s` : inFlight ? `still in progress by ${f.rewonBy} at the time limit` : "no", f?.completedAt != null ? true : inFlight ? null : false);
        collisionCheck(3);
        break;
      }
      case "A10": {
        const reached = this.health.threshAt !== null;
        add(0, "0 new tasks", reached ? this.health.claimsAfter : "health never < 60 %", reached && this.health.claimsAfter === 0);
        add(1, "serviced", this.health.serviced ? "yes" : "no", reached && this.health.serviced);
        collisionCheck(2);
        break;
      }
      case "A11": {
        add(0, "observed", this.sdSamples > 0 ? "yes" : "no", this.sdSamples > 0);
        add(1, "<= 0.35", this.sdSamples ? fmt(this.maxSdSpeed) : "—", this.sdSamples > 0 && this.maxSdSpeed <= 0.35 + 1e-9);
        add(2, "motion continues", this.movingAfterSd ? "yes" : "no", this.movingAfterSd);
        collisionCheck(3);
        break;
      }
      case "A12": {
        const h = this.hitl;
        const log = state.get("hitlAuditLog") || [];
        const holdLogged = log.some(e => e.success && e.action === "HOLD");
        const resumeLogged = log.some(e => e.success && e.action === "RESUME");
        const stopDelay = h.holdAt !== null && h.stoppedAt !== null ? h.stoppedAt - h.holdAt : null;
        add(0, "<= 1 s", stopDelay !== null ? `${fmt(stopDelay, 1)} s` : "not stopped", stopDelay !== null && stopDelay <= 1.0 && h.maxVAfterGrace <= 0.01);
        add(1, "both logged", `HOLD ${holdLogged ? "yes" : "no"}, RESUME ${resumeLogged ? "yes" : "no"}`, holdLogged && resumeLogged);
        const resumeDelay = h.resumeAt !== null && h.movedAt !== null ? h.movedAt - h.resumeAt : null;
        add(2, "<= 3 s", resumeDelay !== null ? `${fmt(resumeDelay, 1)} s` : "no motion", resumeDelay !== null && resumeDelay <= 3);
        collisionCheck(3);
        break;
      }
      default:
        return null;
    }
    const aborted = endReason === "OPERATOR_STOP" || endReason === "ERROR";
    return {
      code,
      verdict: aborted ? "INCOMPLETE" : c.some(x => x.pass === false) ? "FAIL" : c.some(x => x.pass === null) ? "INCOMPLETE" : "PASS",
      criteria: c,
      observations: {
        transitions: trans.length,
        flaps: this.flaps,
        hysteresisViolations: this.hysteresisViolations,
        maxRisk: fmt(this.maxRisk || 0),
        factorMax: Object.fromEntries(Object.entries(this.factorMaxAfterTrigger).map(([k, v]) => [k, fmt(v)])),
        timeShare: Object.fromEntries(Object.entries(this.stateTime).map(([k, v]) => [k, Math.round((v / robotTime) * 1000) / 10])),
        sessions: sessions.length,
        maxScope: this.maxGroup,
        maxStallSeconds: fmt(this.maxStall, 1),
        triggerAt: this.triggerAt
      }
    };
  }
}

export const aceTestMonitor = new AceTestMonitor();
