// ==========================================================================
// NODEX - Edge AI predictor (System 3: NodeX Edge AI ACE decentralized only)
// Runs ON each robot (edge node) over that robot's own sensor frames and peer
// cache. It is a lightweight on-board predictive model, not a trained neural
// network: constant-velocity trajectory forecasting per tracked neighbor plus
// a logistic conflict model with fixed calibrated weights, and online
// estimators for uncertainty, link quality, queue growth and cascade pressure.
// It never plans for other robots and has no fleet-wide view.
//
// Outputs (all 0..1) feed the RACE risk engine together with the raw sensor
// observations (see RobotAgent.computeRaceInputs):
//   conflict, uncertainty, commRisk, queueGrowth, cascadePressure, confidence
// ==========================================================================

const HORIZON_S = 3.0;
const PX_PER_VEL = 22;
const SAFE_SEP = 32;
const W = { bias: -3.2, closeness: 4.2, urgency: 2.6, headOn: 1.4 }; // logistic weights

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class EdgeAiPredictor {
  constructor(agent) {
    this.agent = agent;
    this.tracks = new Map();      // peerId -> { x, y, vx, vy, t, resid }
    this.queueHistory = [];       // [{ t, waiting }]
    this.perPeer = new Map();     // peerId -> predicted conflict probability
    this.stats = { inferences: 0, totalMs: 0, maxMs: 0, lastOutput: null, highConflictPredictions: 0 };
  }

  /** Track update from one sensor frame (sim time `now`, seconds). */
  observe(frame, now) {
    const seen = new Set();
    for (const d of frame.detections) {
      seen.add(d.id);
      const tr = this.tracks.get(d.id);
      if (tr) {
        const dt = Math.max(1e-3, now - tr.t);
        // Prediction residual of the previous estimate -> uncertainty.
        const px = tr.x + tr.vx * dt, py = tr.y + tr.vy * dt;
        const resid = Math.hypot(d.x - px, d.y - py);
        tr.resid = tr.resid * 0.8 + resid * 0.2;
        tr.vx = (d.x - tr.x) / dt; tr.vy = (d.y - tr.y) / dt;
        tr.x = d.x; tr.y = d.y; tr.t = now;
      } else {
        this.tracks.set(d.id, { x: d.x, y: d.y, vx: d.vx * PX_PER_VEL, vy: d.vy * PX_PER_VEL, t: now, resid: 0 });
      }
    }
    for (const id of this.tracks.keys()) if (!seen.has(id) && now - this.tracks.get(id).t > 2) this.tracks.delete(id);
  }

  infer(frame, now) {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const ls = this.agent.localState;
    const peers = this.agent.peerCache;
    const hx = (ls.targetX ?? ls.x) - ls.x, hy = (ls.targetY ?? ls.y) - ls.y;
    const hm = Math.hypot(hx, hy) || 1;
    const myV = ls.status === "MOVING" ? (ls.targetVelocity || 1.2) * PX_PER_VEL : 0;
    const mvx = (hx / hm) * myV, mvy = (hy / hm) * myV;

    let conflict = 0, residSum = 0, residN = 0, waitingNear = 0, shared = 0, inRange = 0;
    const myNext = (ls.currentPath || []).slice(1, 4);
    this.perPeer = new Map();
    for (const d of frame.detections) {
      // Failed / merely standing robots are static obstacles for the local
      // planner, not interaction partners: no conflict prediction for them.
      if (d.failed || (this.agent._isStanding && this.agent._isStanding(d))) continue;
      inRange++;
      const tr = this.tracks.get(d.id) || { x: d.x, y: d.y, vx: 0, vy: 0, resid: 0 };
      residSum += tr.resid; residN++;
      // Closest approach of the two constant-velocity forecasts in the horizon.
      const rx = tr.x - ls.x, ry = tr.y - ls.y, vx = tr.vx - mvx, vy = tr.vy - mvy;
      const vv = vx * vx + vy * vy;
      const tca = vv > 1e-6 ? Math.max(0, Math.min(HORIZON_S, -(rx * vx + ry * vy) / vv)) : 0;
      const dmin = Math.hypot(rx + vx * tca, ry + vy * tca);
      const headOn = (mvx * tr.vx + mvy * tr.vy) < -1 ? 1 : 0;
      const z = W.bias + W.closeness * clamp01(1 - dmin / (SAFE_SEP * 2)) + W.urgency * clamp01(1 - tca / HORIZON_S) + W.headOn * headOn;
      const prob = sigmoid(z);
      this.perPeer.set(d.id, prob);
      conflict = Math.max(conflict, prob);
      const peer = peers.get(d.id);
      if (peer && (peer.status === "WAITING" || peer.status === "BLOCKED" || peer.waitingForNode)) waitingNear++;
      if (peer && Array.isArray(peer.currentPath) && myNext.length) {
        const theirs = peer.currentPath.slice(0, 4);
        if (myNext.some(a => theirs.some(b => Math.hypot(a.x - b.x, a.y - b.y) < 24))) shared += peer.status === "WAITING" ? 1.5 : 1;
      }
    }

    // Link quality: age of the peer information this robot relies on
    // (every peer in its cache; robots seen but never heard count as stale).
    let ageSum = 0, ageN = 0, maxStale = 0;
    const nowMs = this.agent.now();
    for (const peer of peers.values()) {
      if (peer.id === this.agent.robotId) continue;
      const age = Math.max(0, nowMs - (peer.lastSeen ?? nowMs));
      ageSum += age; ageN++;
      if (age > 1500) maxStale = Math.max(maxStale, Math.min(1, age / 4000));
    }
    for (const d of frame.detections) if (!peers.has(d.id)) { ageSum += 3000; ageN++; }
    const commRisk = ls.isCriticalDegraded ? 1 : clamp01(ageN ? (ageSum / ageN) / 2500 : 0);

    // Queue growth: trend of waiting neighbors over the last 3 s.
    this.queueHistory.push({ t: now, waiting: waitingNear });
    while (this.queueHistory.length && now - this.queueHistory[0].t > 3) this.queueHistory.shift();
    const first = this.queueHistory[0];
    const slope = first && now - first.t > 0.5 ? (waitingNear - first.waiting) / (now - first.t) : 0;
    const queueGrowth = clamp01(Math.max(0, slope) * 0.8 + waitingNear / 2);

    const uncertainty = ls.isCriticalDegraded ? 1
      : clamp01(Math.max(maxStale, (residN ? residSum / residN / 10 : 0) + (ls.poseUncertainty || 0) + commRisk * 0.3));
    const cascadePressure = clamp01(shared / 2);
    const out = {
      conflict: clamp01(conflict),
      uncertainty,
      commRisk,
      queueGrowth,
      cascadePressure,
      confidence: clamp01(1 - uncertainty * 0.6)
    };
    const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    this.stats.inferences++;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    if (out.conflict > 0.5) this.stats.highConflictPredictions++;
    this.stats.lastOutput = out;
    return out;
  }
}
