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
//
// r6 (WS1) calibration, each gated by an ace-features switch:
//   ws1-conflict-calibration  conflict = genuine future space-time overlap:
//       both robots are forecast along their own planned path / shared intent
//       over the horizon; a pair is a conflict only when the forecast
//       separation falls below the separation minimum while closing, and the
//       geometry is head-on, crossing, or a stagnant (jammed) leader. A robot
//       following a progressing leader in its lane is not a conflict (the lane
//       speed adaptation handles it), so co-moving / queued robots are no
//       longer "predicted" merely for being near.
//   ws1-queue-cascade  queue growth = a growing queue (trend) plus the level
//       only when the local queue is stagnant; cascade pressure = the local
//       wait-for chain through this robot (from sensors + peer intents) and
//       circular blocking, instead of a shared-waypoint count.
//   ws1-comm-relevance  link risk = per-robot staleness of the information
//       from the neighbours that matter to this robot (sensed, or able to
//       reach its sensor range within the horizon), measured against each
//       sender's advertised heartbeat; latency that leaves that information
//       fresh does not raise risk.
//   ws1-degraded-link-verify  a reported radio blackout forces the
//       SAFE-DEGRADED envelope only until the robot has verified its link
//       (fresh peer messages sent after the fault from every sensed neighbour).
// ==========================================================================

import { aceFeature } from "./ace-features.js";
import { SENSOR_RANGE } from "../sensor-sim.js";

const HORIZON_S = 3.0;
const PX_PER_VEL = 22;
const SAFE_SEP = 32;
const W = { bias: -3.2, closeness: 4.2, urgency: 2.6, headOn: 1.4 }; // logistic weights

// WS1 switches (read once per process; NODEX_ABLATE disables them).
const F_CONFLICT = aceFeature("ws1-conflict-calibration");
const F_QUEUE = aceFeature("ws1-queue-cascade");
const F_COMM = aceFeature("ws1-comm-relevance");
// Measured harmful in S07 comm loss (bench/results/acefix): disabled.
const F_STALE_DEGRADE = false && aceFeature("ace-stale-degrade");
const F_BLOCKED_HEAD = aceFeature("ace-blocked-head");
const F_VERIFY = aceFeature("ws1-degraded-link-verify");

const V_CRUISE = 1.2 * PX_PER_VEL;   // nominal cruise, px/s
const STEP_S = 0.25;                 // forecast sampling step
const SEP_CONFLICT = SAFE_SEP + 8;   // forecast separation below this = overlap
export const JAM_SECONDS = 5.0;      // stationary this long = stagnant, not a flowing queue
const INTENT_FRESH_MS = 2000;        // shared intent older than this is not used for the forecast
const HB_DEFAULT_MS = 250;           // senders that advertise no heartbeat (fixed 4 Hz)
const LAT_TOL_MS = 250;              // normal delivery latency allowance
const STALE_SPAN_MS = 2000;          // excess age at which link risk saturates
const BLOCK_RADIUS = 48;             // wait-for edge: blocker this close ahead
const LANE_HALF_WIDTH = 20;
const CONFLICT_CLASSES = new Set(["headon", "cross", "blocked"]);

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const isFailed = (s) => s === "ERROR" || s === "error" || s === "failed";

/** Points ahead of `pos` on `path` starting at the waypoint equal to `target`. */
function pathAhead(pos, target, path, maxLen) {
  const pts = [{ x: pos.x, y: pos.y }];
  if (!target || typeof target.x !== "number") return pts;
  pts.push({ x: target.x, y: target.y });
  if (!Array.isArray(path) || path.length === 0) return pts;
  // The target may occur twice on a route (out and back): take the
  // occurrence whose incoming leg passes closest to the robot.
  let best = -1, bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (Math.abs(p.x - target.x) > 1 || Math.abs(p.y - target.y) > 1) continue;
    const q = i > 0 ? path[i - 1] : p;
    const dx = p.x - q.x, dy = p.y - q.y, l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((pos.x - q.x) * dx + (pos.y - q.y) * dy) / l2)) : 0;
    const d = Math.hypot(q.x + u * dx - pos.x, q.y + u * dy - pos.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return pts;
  let len = Math.hypot(target.x - pos.x, target.y - pos.y);
  for (let k = best + 1; k < path.length && len < maxLen; k++) {
    const a = pts[pts.length - 1], b = path[k];
    len += Math.hypot(b.x - a.x, b.y - a.y);
    pts.push({ x: b.x, y: b.y });
  }
  return pts;
}

/** Position and unit direction after travelling `s` px along polyline `pts`. */
function along(pts, s) {
  let rem = s;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1e-6) continue;
    const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
    if (rem <= l) return { x: a.x + ux * rem, y: a.y + uy * rem, ux, uy };
    rem -= l;
  }
  const last = pts[pts.length - 1];
  const dir = firstDir(pts);
  return { x: last.x, y: last.y, ux: dir ? dir.ux : 0, uy: dir ? dir.uy : 0 };
}

function firstDir(pts) {
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[0].x, dy = pts[i].y - pts[0].y, l = Math.hypot(dx, dy);
    if (l > 1) return { ux: dx / l, uy: dy / l };
  }
  return null;
}

export class EdgeAiPredictor {
  constructor(agent) {
    this.agent = agent;
    this.tracks = new Map();      // peerId -> { x, y, vx, vy, t, resid, stillSince }
    this.queueHistory = [];       // [{ t, waiting }]
    this.perPeer = new Map();     // peerId -> predicted conflict probability
    this.perClass = new Map();    // peerId -> interaction class (ws1-conflict-calibration)
    this.selfStillSince = null;   // sim s since this robot stands with a task
    this.linkFaultAt = null;      // sim ms of the reported radio fault
    this.linkVerifiedAt = null;   // sim ms the link was verified after it
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
        if (d.moving) tr.stillSince = null;
        else if (tr.stillSince === null || tr.stillSince === undefined) tr.stillSince = now;
      } else {
        this.tracks.set(d.id, { x: d.x, y: d.y, vx: d.vx * PX_PER_VEL, vy: d.vy * PX_PER_VEL, t: now, resid: 0, stillSince: d.moving ? null : now });
      }
    }
    for (const id of this.tracks.keys()) if (!seen.has(id) && now - this.tracks.get(id).t > 2) this.tracks.delete(id);
    const ls = this.agent.localState;
    const selfStill = (ls.velocity || 0) < 0.01 && !!ls.currentTaskId && !ls.handling;
    if (!selfStill) this.selfStillSince = null;
    else if (this.selfStillSince === null) this.selfStillSince = now;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ws1-conflict-calibration: path-aware closest approach
  // ─────────────────────────────────────────────────────────────────────────

  /** My forecast: along my own planned path at cruise speed while I hold work. */
  _selfForecast(ls) {
    const busy = !!(ls.currentTaskId || ls.parkingBay || ls._maneuver) && !ls.handling;
    const going = ls.status === "MOVING" || ls.status === "WAITING" || ls.status === "ASSIGNED";
    const v = busy && going ? (ls.targetVelocity || 1.2) * PX_PER_VEL : 0;
    const pts = pathAhead({ x: ls.x, y: ls.y }, { x: ls.targetX, y: ls.targetY }, ls.plannedPath, V_CRUISE * HORIZON_S + 40);
    return { pts, v, dir: firstDir(pts) };
  }

  /** Peer forecast from its sensed state plus its shared intent (if fresh). */
  _peerForecast(d, tr, nowMs) {
    const peer = this.agent.peerCache.get(d.id);
    const fresh = peer && nowMs - (peer.lastSeen ?? -Infinity) <= INTENT_FRESH_MS;
    const v = Math.hypot(d.vx, d.vy) * PX_PER_VEL;
    const pos = { x: d.x, y: d.y };
    let pts = null;
    if (fresh && typeof peer.targetX === "number") {
      pts = pathAhead(pos, { x: peer.targetX, y: peer.targetY }, peer.currentPath, V_CRUISE * HORIZON_S + 40);
    }
    if (!pts || pts.length < 2 || !firstDir(pts)) {
      const tv = Math.hypot(tr.vx, tr.vy);
      pts = tv > 1 ? [pos, { x: pos.x + (tr.vx / tv) * 200, y: pos.y + (tr.vy / tv) * 200 }] : [pos];
    }
    return { pts, v, dir: firstDir(pts), peer };
  }

  /**
   * Interaction of me with one sensed robot over the horizon:
   *   clear     forecast separation stays above the overlap distance
   *   steady    not closing (queued / co-moving at constant gap, separating)
   *   follow    same-direction lane following behind a progressing leader
   *   headon / cross   opposing / crossing space-time overlap
   *   blocked   my path runs into a same-lane leader that is stagnant
   */
  _classify(me, pf, d, tr, now) {
    let dmin = Infinity, tmin = 0, atMe = null, atPeer = null;
    for (let k = 0; k * STEP_S <= HORIZON_S + 1e-9; k++) {
      const t = k * STEP_S;
      const a = along(me.pts, me.v * t), b = along(pf.pts, pf.v * t);
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist < dmin - 1e-9) { dmin = dist; tmin = t; atMe = a; atPeer = b; }
    }
    const d0 = Math.hypot(d.x - this.agent.localState.x, d.y - this.agent.localState.y);
    if (dmin >= SEP_CONFLICT) return { cls: "clear", dmin, tmin };
    if (d0 - dmin <= 2) return { cls: "steady", dmin, tmin };
    const md = me.v > 0 && atMe && (atMe.ux || atMe.uy) ? atMe : me.dir;
    const pd = pf.v > 0 && atPeer && (atPeer.ux || atPeer.uy) ? { ux: atPeer.ux, uy: atPeer.uy } : pf.dir;
    if (!md || !pd) return { cls: "cross", dmin, tmin };
    const mx = md.ux, my = md.uy;
    const dot = mx * pd.ux + my * pd.uy;
    if (dot < -0.7) return { cls: "headon", dmin, tmin };
    if (dot > 0.7) {
      const ls = this.agent.localState;
      const ahead = (d.x - ls.x) * mx + (d.y - ls.y) * my > 0;
      if (!ahead) return { cls: "follow", dmin, tmin }; // it follows me: its job
      const still = tr && tr.stillSince !== null && tr.stillSince !== undefined ? now - tr.stillSince : 0;
      return { cls: still >= JAM_SECONDS ? "blocked" : "follow", dmin, tmin };
    }
    return { cls: "cross", dmin, tmin };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ws1-queue-cascade: local wait-for graph from sensors + peer intents
  // ─────────────────────────────────────────────────────────────────────────

  _waitGraph(frame, now, nowMs) {
    const ls = this.agent.localState;
    const peers = this.agent.peerCache;
    const nodes = [];
    const meStalled = this.selfStillSince !== null;
    const myDir = (() => {
      const dx = (ls.targetX ?? ls.x) - ls.x, dy = (ls.targetY ?? ls.y) - ls.y, m = Math.hypot(dx, dy);
      return m > 1 ? { ux: dx / m, uy: dy / m } : null;
    })();
    nodes.push({ id: this.agent.robotId, x: ls.x, y: ls.y, stalled: meStalled, dir: myDir,
      still: meStalled ? now - this.selfStillSince : 0, wfn: ls.waitingForNode || null, claim: this.agent.nodeClaim?.key || null });
    for (const d of frame.detections) {
      if (d.failed || (this.agent._isStanding && this.agent._isStanding(d))) continue;
      const p = peers.get(d.id);
      const fresh = p && nowMs - (p.lastSeen ?? -Infinity) <= INTENT_FRESH_MS;
      const busy = fresh && (p.currentTaskId || p.status === "WAITING" || p.waitingForNode) && !p.handling;
      let dir = null;
      if (fresh && typeof p.targetX === "number") {
        const dx = p.targetX - d.x, dy = p.targetY - d.y, m = Math.hypot(dx, dy);
        if (m > 1) dir = { ux: dx / m, uy: dy / m };
      }
      const tr = this.tracks.get(d.id);
      nodes.push({ id: d.id, x: d.x, y: d.y, stalled: !d.moving && !!busy, moving: !!d.moving, dir,
        still: tr && tr.stillSince !== null && tr.stillSince !== undefined ? now - tr.stillSince : 0,
        wfn: fresh ? p.waitingForNode || null : null, claim: fresh && p.nodeClaim ? p.nodeClaim.key : null,
        waits: fresh ? (!!p.isYielding || !!p.waitingForNode) : true });
    }
    // Wait-for edge X -> Y: stalled X is held by Y (Y just ahead in X's lane,
    // or Y holds the intersection X queues for).
    const next = new Map();
    for (const x of nodes) {
      if (!x.stalled) continue;
      let by = null;
      if (x.wfn) by = nodes.find(y => y !== x && y.claim === x.wfn) || null;
      if (!by && x.dir) {
        let bestAlong = Infinity;
        for (const y of nodes) {
          if (y === x) continue;
          const rx = y.x - x.x, ry = y.y - x.y;
          const al = rx * x.dir.ux + ry * x.dir.uy;
          const lat = Math.abs(rx * x.dir.uy - ry * x.dir.ux);
          if (al > 4 && al < BLOCK_RADIUS && lat < LANE_HALF_WIDTH && al < bestAlong) { bestAlong = al; by = y; }
        }
      }
      if (by) next.set(x.id, by);
    }
    const me = nodes[0];
    // Forward chain from me (who holds me, transitively) and cycle check.
    let cycle = false, forward = 0, head = me;
    const seen = new Set([me.id]);
    for (let cur = next.get(me.id); cur; cur = next.get(cur.id)) {
      if (cur.id === me.id) { cycle = true; break; }
      if (seen.has(cur.id)) break;
      seen.add(cur.id); forward++; head = cur;
    }
    // Robots held (transitively) by me.
    let behind = 0;
    for (const x of nodes) {
      if (x === me) continue;
      let cur = next.get(x.id), hops = 0;
      while (cur && hops < nodes.length) { if (cur.id === me.id) { behind++; break; } cur = next.get(cur.id); hops++; }
    }
    const chain = 1 + forward + behind;
    const stagnant = cycle || (forward > 0 && head.still >= JAM_SECONDS) || (me.stalled && me.still >= JAM_SECONDS);
    // Involved: I stand in the queue, or a stalled robot is ahead in my lane.
    let involved = me.stalled;
    if (!involved && myDir) {
      for (const y of nodes) {
        if (y === me || !y.stalled) continue;
        const rx = y.x - ls.x, ry = y.y - ls.y;
        const al = rx * myDir.ux + ry * myDir.uy;
        if (al > 0 && al < SENSOR_RANGE && Math.abs(rx * myDir.uy - ry * myDir.ux) < LANE_HALF_WIDTH) { involved = true; break; }
      }
    }
    // Blocked head: the robot at the front of my queue is stopped, waits for
    // nobody (its own broadcast says it is not waiting / yielding) and has not
    // moved for JAM_SECONDS (fault / stall / obstacle).
    // Like a cycle, that queue cannot clear by waiting.
    // Head stillness is tracked from sensing only; my own stall time behind it
    // is the robust measure that the queue is not moving.
    const blockedHead = F_BLOCKED_HEAD && forward > 0 && head.waits === false && !head.moving
      && Math.max(head.still, me.still) >= JAM_SECONDS;
    return { cycle, chain, stagnant, involved, blockedHead };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ws1-comm-relevance: staleness of the information that matters to me
  // ─────────────────────────────────────────────────────────────────────────

  _relevantStaleness(frame, nowMs) {
    const ls = this.agent.localState;
    const peers = this.agent.peerCache;
    const sensed = new Map();
    for (const d of frame.detections) sensed.set(d.id, d);
    let risk = 0, stale = 0;
    for (const peer of peers.values()) {
      if (peer.id === this.agent.robotId || isFailed(peer.status)) continue;
      const age = Math.max(0, nowMs - (peer.lastSeen ?? nowMs));
      const promised = (peer.hbMs ?? HB_DEFAULT_MS) + LAT_TOL_MS;
      if (age <= promised) continue;
      let w;
      const d = sensed.get(peer.id);
      if (d) w = d.failed ? 0 : 1;
      else {
        if (typeof peer.x !== "number") continue;
        // Could it reach my sensor range within the horizon (both driving)?
        const reach = SENSOR_RANGE + 2 * V_CRUISE * (HORIZON_S + age / 1000);
        const dist = Math.hypot(peer.x - ls.x, peer.y - ls.y);
        w = clamp01((reach - dist) / (reach - SENSOR_RANGE));
      }
      if (w <= 0) continue;
      risk = Math.max(risk, w * clamp01((age - promised) / STALE_SPAN_MS));
      if (age > promised + 250) stale = Math.max(stale, w * Math.min(1, age / 4000));
    }
    for (const d of frame.detections) if (!peers.has(d.id) && !d.failed) { risk = 1; stale = Math.max(stale, 0.75); }
    return { risk: clamp01(risk), stale: clamp01(stale) };
  }

  /** ws1-degraded-link-verify: is a reported radio blackout still unverified? */
  _blackout(frame, nowMs) {
    const ls = this.agent.localState;
    if (!ls.isCriticalDegraded) { this.linkFaultAt = null; this.linkVerifiedAt = null; return false; }
    if (!F_VERIFY) return true;
    if (this.linkFaultAt === null) this.linkFaultAt = nowMs;
    if (this.linkVerifiedAt !== null) return false;
    // Verified once messages SENT after the fault arrived from every sensed
    // neighbour (at least one peer): the robot hears its surroundings again.
    const peers = this.agent.peerCache;
    let heard = 0;
    for (const p of peers.values()) if (p.id !== this.agent.robotId && (p.lastSeen ?? -Infinity) > this.linkFaultAt) heard++;
    if (heard === 0) return true;
    for (const d of frame.detections) {
      if (d.failed) continue;
      const p = peers.get(d.id);
      if (!p || !((p.lastSeen ?? -Infinity) > this.linkFaultAt)) return true;
    }
    this.linkVerifiedAt = nowMs;
    return false;
  }

  infer(frame, now) {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const ls = this.agent.localState;
    const peers = this.agent.peerCache;
    const hx = (ls.targetX ?? ls.x) - ls.x, hy = (ls.targetY ?? ls.y) - ls.y;
    const hm = Math.hypot(hx, hy) || 1;
    const myV = ls.status === "MOVING" ? (ls.targetVelocity || 1.2) * PX_PER_VEL : 0;
    const mvx = (hx / hm) * myV, mvy = (hy / hm) * myV;
    const nowMs = this.agent.now();
    const me = F_CONFLICT ? this._selfForecast(ls) : null;

    let conflict = 0, residSum = 0, residN = 0, waitingNear = 0, shared = 0, inRange = 0;
    const myNext = (ls.currentPath || []).slice(1, 4);
    this.perPeer = new Map();
    this.perClass = new Map();
    for (const d of frame.detections) {
      // Failed / merely standing robots are static obstacles for the local
      // planner, not interaction partners: no conflict prediction for them.
      if (d.failed || (this.agent._isStanding && this.agent._isStanding(d))) continue;
      inRange++;
      const tr = this.tracks.get(d.id) || { x: d.x, y: d.y, vx: 0, vy: 0, resid: 0 };
      residSum += tr.resid; residN++;
      let prob;
      if (F_CONFLICT) {
        const pf = this._peerForecast(d, tr, nowMs);
        const c = this._classify(me, pf, d, tr, now);
        this.perClass.set(d.id, c.cls);
        const genuine = CONFLICT_CLASSES.has(c.cls);
        const z = W.bias + W.closeness * clamp01(1 - c.dmin / (SAFE_SEP * 2))
          + (genuine ? W.urgency * clamp01(1 - c.tmin / HORIZON_S) : 0)
          + (c.cls === "headon" ? W.headOn : 0);
        prob = sigmoid(z);
      } else {
        // Closest approach of the two constant-velocity forecasts in the horizon.
        const rx = tr.x - ls.x, ry = tr.y - ls.y, vx = tr.vx - mvx, vy = tr.vy - mvy;
        const vv = vx * vx + vy * vy;
        const tca = vv > 1e-6 ? Math.max(0, Math.min(HORIZON_S, -(rx * vx + ry * vy) / vv)) : 0;
        const dmin = Math.hypot(rx + vx * tca, ry + vy * tca);
        const headOn = (mvx * tr.vx + mvy * tr.vy) < -1 ? 1 : 0;
        const z = W.bias + W.closeness * clamp01(1 - dmin / (SAFE_SEP * 2)) + W.urgency * clamp01(1 - tca / HORIZON_S) + W.headOn * headOn;
        prob = sigmoid(z);
      }
      this.perPeer.set(d.id, prob);
      conflict = Math.max(conflict, prob);
      const peer = peers.get(d.id);
      if (peer && (peer.status === "WAITING" || peer.status === "BLOCKED" || peer.waitingForNode)) waitingNear++;
      if (!F_QUEUE && peer && Array.isArray(peer.currentPath) && myNext.length) {
        const theirs = peer.currentPath.slice(0, 4);
        if (myNext.some(a => theirs.some(b => Math.hypot(a.x - b.x, a.y - b.y) < 24))) shared += peer.status === "WAITING" ? 1.5 : 1;
      }
    }

    // Link quality: age of the peer information this robot relies on.
    const blackout = this._blackout(frame, nowMs);
    let commRisk, maxStale = 0;
    if (F_COMM) {
      const rel = this._relevantStaleness(frame, nowMs);
      commRisk = blackout ? 1 : rel.risk;
      maxStale = rel.stale;
      // Relevant-peer information saturated stale (>= STALE_SPAN_MS beyond the
      // promised heartbeat) for 1 s: coordination with those peers cannot be
      // trusted, so behave as in a link blackout (SAFE-DEGRADED) until fresh.
      if (rel.risk >= 1) this.staleSatSince ??= nowMs; else this.staleSatSince = null;
      this.staleBlackout = F_STALE_DEGRADE && this.staleSatSince !== null && nowMs - this.staleSatSince >= 1000;
    } else {
      // (every peer in its cache; robots seen but never heard count as stale).
      let ageSum = 0, ageN = 0;
      for (const peer of peers.values()) {
        if (peer.id === this.agent.robotId) continue;
        const age = Math.max(0, nowMs - (peer.lastSeen ?? nowMs));
        ageSum += age; ageN++;
        if (age > 1500) maxStale = Math.max(maxStale, Math.min(1, age / 4000));
      }
      for (const d of frame.detections) if (!peers.has(d.id)) { ageSum += 3000; ageN++; }
      commRisk = blackout ? 1 : clamp01(ageN ? (ageSum / ageN) / 2500 : 0);
    }

    // Queue growth: trend of waiting neighbors over the last 3 s.
    this.queueHistory.push({ t: now, waiting: waitingNear });
    while (this.queueHistory.length && now - this.queueHistory[0].t > 3) this.queueHistory.shift();
    const first = this.queueHistory[0];
    const slope = first && now - first.t > 0.5 ? (waitingNear - first.waiting) / (now - first.t) : 0;
    let queueGrowth, cascadePressure;
    let graph = null;
    if (F_QUEUE) {
      // A queue is a risk when it grows toward me or stagnates around me;
      // robots waiting in a flowing line are normal traffic.
      graph = this._waitGraph(frame, now, nowMs);
      queueGrowth = graph.involved ? clamp01(Math.max(0, slope) * 0.8 + (graph.stagnant ? waitingNear / 2 : 0)) : 0;
      cascadePressure = graph.cycle || graph.blockedHead ? 1 : clamp01((graph.chain - 1) / (graph.stagnant ? 2 : 4));
    } else {
      queueGrowth = clamp01(Math.max(0, slope) * 0.8 + waitingNear / 2);
      cascadePressure = clamp01(shared / 2);
    }

    const uncertainty = blackout ? 1
      : clamp01(Math.max(maxStale, (residN ? residSum / residN / 10 : 0) + (ls.poseUncertainty || 0) + commRisk * 0.3));
    const out = {
      conflict: clamp01(conflict),
      uncertainty,
      commRisk,
      queueGrowth,
      cascadePressure,
      confidence: clamp01(1 - uncertainty * 0.6)
    };
    // Extra (non-RACE) outputs used by the robot's own envelope behaviour.
    if (F_CONFLICT) out.perClass = this.perClass;
    if (F_VERIFY) out.blackout = blackout || !!(F_COMM && this.staleBlackout);
    out.blockedHead = !!(graph && graph.blockedHead);
    if (F_QUEUE || F_CONFLICT) out.selfStallS = this.selfStillSince === null ? 0 : now - this.selfStillSince;
    if (graph) out.stagnant = graph.stagnant;
    const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    this.stats.inferences++;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    if (out.conflict > 0.5) this.stats.highConflictPredictions++;
    this.stats.lastOutput = out;
    return out;
  }
}
