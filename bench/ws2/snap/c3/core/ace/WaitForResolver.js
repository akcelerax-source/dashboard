// ==========================================================================
// NODEX ACE - distributed wait-for cycle detection and resolution
// (System 3 only, feature "ws2-waitfor"). One instance per robot.
//
// Every robot knows whom it is waiting for right now:
//   yield    - it yields right of way to that peer (a rule decision),
//   contract - it holds at a contract region edge for an earlier member,
//   block    - its next step would close below the engine's 30 px
//              separation to that robot (physical),
//   node     - that robot occupies / holds the intersection it must enter,
//   corridor - that robot is oncoming on the lane it must enter,
//   merge    - that robot is at the lane point it must merge onto,
//   hold     - it holds in a back-off refuge until that robot passed.
// A robot that has made no progress for PROBE_AFTER_S sends a probe along
// its wait-for edge (edge chasing, Chandy-Misra-Haas 1983). A stalled
// receiver appends itself and forwards the probe along its own edge. A probe
// that returns to its origin has travelled a circular wait; its path lists
// every member with its edge kind, whether the edge is physical, how long
// the member has waited and whether it can back off. Only the member with
// the lowest id resolves, so each cycle gets exactly one decision:
//   - if some member waits voluntarily (yield / contract edge whose next step
//     is physically free), the one that has waited longest proceeds
//     (PIBT-style priority: waiting time, then id);
//   - otherwise (all edges physical) the member that has waited least and
//     can move away backs off (retreat to a refuge, turn back, or - for a
//     robot caught half-way out of its bay - step back into the bay).
// Everything uses the robot's own state, its sensors and peer messages.
// ==========================================================================

import { aceFeature } from "./ace-features.js";
import { MapGeometryEngine, ROBOT_FOOTPRINT } from "../map-geometry.js";
import { startBackoff, retreatFeasible } from "../deadlock-backoff.js";

export const WAITFOR_ENABLED = aceFeature("ws2-waitfor");

export const WF_PROBE = "ACE_WF_PROBE";
export const WF_RESOLVE = "ACE_WF_RESOLVE";

const PROBE_AFTER_S = 1.0;     // no progress this long before probing
const PROBE_EVERY_S = 1.0;     // probe period while stalled
const FORWARD_AFTER_S = 0.5;   // a member must itself be stalled this long
const OVERRIDE_S = 3.0;        // right-of-way override granted to a proceeding member
const RESOLVE_COOLDOWN_S = 3.0;
const MAX_HOPS = 10;
const SEP = ROBOT_FOOTPRINT.totalRadius * 2 - 2;   // engine separation guard (30 px)
const BAY_OFFSET = ROBOT_FOOTPRINT.totalRadius * 2 + 2; // bay row distance from a centerline (34 px)
const VOLUNTARY = new Set(["yield", "contract"]);

export class WaitForResolver {
  constructor(agent) {
    this.agent = agent;
    this.wf = null;               // { id, kind, phys }
    this.noProgressSince = null;
    this._lastPos = null;
    this._lastProbe = -Infinity;
    this.override = null;         // { peerId, until }
    this._resolved = new Map();   // cycle key -> sim time
    this._canBack = { at: -Infinity, v: false };
    this.stats = { probes: 0, forwards: 0, cycles: 0, proceeds: 0, backoffs: 0 };
  }

  get id() { return this.agent.robotId; }

  /** Right-of-way override for `peerId` granted by a cycle resolution. */
  overrides(peerId, now) {
    const o = this.override;
    return !!o && now < o.until && (peerId === undefined || o.peerId === peerId);
  }

  /** Per tick, after the robot's traffic decisions (ACE agents only). */
  update(now) {
    const a = this.agent, ls = a.localState;
    const moved = !this._lastPos || Math.hypot(ls.x - this._lastPos.x, ls.y - this._lastPos.y) > 0.05;
    this._lastPos = { x: ls.x, y: ls.y };
    if (moved || this.noProgressSince === null) this.noProgressSince = now;
    if (this.override && now >= this.override.until) this.override = null;
    this.wf = this._edge(moved);
    if (!this.wf) return;
    if (now - this.noProgressSince < PROBE_AFTER_S || now - this._lastProbe < PROBE_EVERY_S) return;
    this._lastProbe = now;
    this.stats.probes++;
    a.peerBus.unicast(this.id, this.wf.id, WF_PROBE, { origin: this.id, path: [this._node(now)] });
  }

  /** My current wait-for edge, or null when I am not waiting on a robot. */
  _edge(moved) {
    const a = this.agent, ls = a.localState;
    if (!ls.currentTaskId || ls.handling || ls.hitlHold || ls.status === "ERROR") return null;
    const m = ls._maneuver;
    if (m) return m.phase === "hold" && m.blockerId ? { id: m.blockerId, kind: "hold", phys: true } : null;
    if (a._yieldTo) return { id: a._yieldTo, kind: "yield", phys: !!this._physBlocker() };
    if (moved) return null;
    const pb = this._physBlocker();
    if (pb) return { id: pb, kind: "block", phys: true };
    const perm = a._permBy;
    if (perm && perm.id) return { id: perm.id, kind: perm.kind, phys: !VOLUNTARY.has(perm.kind) || !!this._physBlocker() };
    return null;
  }

  /**
   * The robot my next step toward my target would close on below the
   * engine's separation distance (from my own sensor frame), or null.
   */
  _physBlocker() {
    const a = this.agent, ls = a.localState;
    const hx = ls.targetX - ls.x, hy = ls.targetY - ls.y, hm = Math.hypot(hx, hy);
    if (!(hm > 1)) return null;
    const step = Math.min(hm, 2.5);
    const nx = ls.x + (hx / hm) * step, ny = ls.y + (hy / hm) * step;
    let best = null, bd = Infinity;
    for (const d of a._frame().detections) {
      const dn = Math.hypot(d.x - nx, d.y - ny);
      if (dn < SEP && dn < d.dist && d.dist < bd) { best = d.id; bd = d.dist; }
    }
    return best;
  }

  _node(now) {
    return { id: this.id, kind: this.wf.kind, phys: this.wf.phys, waited: +(now - this.noProgressSince).toFixed(2), back: this._canBackOff(now) };
  }

  onMessage(msg, now) {
    const p = msg.payload || {};
    if (msg.type === WF_PROBE) {
      if (p.origin === this.id) { this._onCycle(p.path || [], now); return; }
      const path = p.path || [];
      if (!this.wf || path.length >= MAX_HOPS || path.some(n => n.id === this.id)) return;
      if (now - this.noProgressSince < FORWARD_AFTER_S) return;
      this.stats.forwards++;
      this.agent.peerBus.unicast(this.id, this.wf.id, WF_PROBE, { origin: p.origin, path: [...path, this._node(now)] });
    } else if (msg.type === WF_RESOLVE) {
      // Act only if the edge the decision was made on still holds.
      if (!this.wf || this.wf.id !== p.peerId) return;
      this._apply(p.action, p.peerId, now, p.cycle || []);
    }
  }

  _onCycle(path, now) {
    if (path.length < 2 || !this.wf) return;
    const ids = path.map(n => n.id);
    if (ids.some(i => i < this.id)) return; // the lowest id member resolves
    const key = [...ids].sort().join(",");
    if (now - (this._resolved.get(key) ?? -Infinity) < RESOLVE_COOLDOWN_S) return;
    this._resolved.set(key, now);
    if (this._resolved.size > 64) this._resolved.delete(this._resolved.keys().next().value);
    this.stats.cycles++;
    const next = (i) => ids[(i + 1) % ids.length];
    // PIBT-style priority: longer wait first, then lower id.
    const prio = (u, v) => v.n.waited - u.n.waited || (u.n.id < v.n.id ? -1 : 1);
    const members = path.map((n, i) => ({ n, peer: next(i) }));
    const voluntary = members.filter(x => VOLUNTARY.has(x.n.kind) && !x.n.phys).sort(prio);
    let pick = null, action = null;
    if (voluntary.length) { pick = voluntary[0]; action = "proceed"; }
    else {
      const backers = members.filter(x => x.n.back).sort(prio);
      if (backers.length) { pick = backers[backers.length - 1]; action = "backoff"; }
    }
    this.agent.logDecision("ACE_WAITFOR_CYCLE", `Circular wait ${ids.join(" -> ")} -> ${ids[0]} (${path.map(n => n.kind).join("/")}); ${pick ? `${pick.n.id} ${action === "proceed" ? "proceeds" : "backs off"}` : "no member can move; waiting"}.`, { cycle: ids });
    if (!pick) return;
    if (pick.n.id === this.id) this._apply(action, pick.peer, now, ids);
    else this.agent.peerBus.unicast(this.id, pick.n.id, WF_RESOLVE, { action, peerId: pick.peer, cycle: ids });
  }

  _apply(action, peerId, now, cycle) {
    const a = this.agent;
    if (action === "proceed") {
      this.override = { peerId, until: now + OVERRIDE_S };
      this.stats.proceeds++;
      a.logDecision("ACE_WAITFOR_PROCEED", `Wait-for cycle ${cycle.join(" -> ")}: I have waited longest; proceeding before ${peerId}.`);
      return;
    }
    if (this._backOff(peerId)) {
      this.stats.backoffs++;
      this._canBack = { at: -Infinity, v: false };
      a.logDecision("ACE_WAITFOR_BACKOFF", `Wait-for cycle ${cycle.join(" -> ")}: backing off to release ${peerId}.`);
      a.broadcastStateAndIntent();
    }
  }

  /** Can I physically move out of the way (cached briefly)? */
  _canBackOff(now) {
    if (now - this._canBack.at < 0.5) return this._canBack.v;
    const a = this.agent, ls = a.localState;
    let v = false;
    if (!ls._maneuver && !ls.hitlHold) {
      v = !!this._bayStepBack(false);
      if (!v) {
        const blocker = this._peerState(this.wf && this.wf.id);
        v = retreatFeasible(ls, a._neighborStates(), blocker);
      }
    }
    this._canBack = { at: now, v };
    return v;
  }

  _peerState(id) {
    if (!id) return null;
    const a = this.agent;
    return a._sensedPeers(200).find(p => p.id === id) || a.peerCache.get(id) || null;
  }

  _backOff(peerId) {
    const a = this.agent, ls = a.localState;
    if (ls._maneuver || ls.hitlHold) return false;
    if (this._bayStepBack(true, peerId)) return true;
    const blocker = this._peerState(peerId);
    if (blocker && a._turnBackReplan(blocker)) return true;
    return startBackoff(ls, blocker, a._neighborStates());
  }

  /**
   * A robot caught part-way between its bay and the lane (inside the lane's
   * separation band, off the centerline) steps straight back into the bay
   * cell behind it and re-merges once the lane point is clear. Uses the
   * shared back-off maneuver state, so tickBackoff drives the hold/resume.
   */
  _bayStepBack(apply, blockerId = null) {
    const a = this.agent, ls = a.localState;
    const foot = MapGeometryEngine.projectToNearestAisle(ls.x, ls.y);
    if (!foot) return null;
    const gap = Math.hypot(ls.x - foot.x, ls.y - foot.y);
    if (gap < 3 || gap >= SEP) return null;
    const ux = (ls.x - foot.x) / gap, uy = (ls.y - foot.y) / gap;
    const bay = { x: foot.x + ux * BAY_OFFSET, y: foot.y + uy * BAY_OFFSET };
    if (!MapGeometryEngine.isOffLane(bay.x, bay.y) || !MapGeometryEngine.isWithinBounds(bay.x, bay.y, ROBOT_FOOTPRINT.radius)
        || MapGeometryEngine.isPointInObstacle(bay.x, bay.y, ROBOT_FOOTPRINT.radius).collision) return null;
    if (a._frame().detections.some(d => Math.hypot(d.x - bay.x, d.y - bay.y) < SEP)) return null;
    if (!apply) return bay;
    const path = ls.currentPath && ls.currentPath.length ? ls.currentPath : (ls.plannedPath || []);
    const ti = path.findIndex(p => Math.hypot(p.x - ls.targetX, p.y - ls.targetY) < 1);
    const resumePath = ti >= 0 ? path.slice(ti).map(p => ({ x: p.x, y: p.y })) : [{ x: foot.x, y: foot.y }];
    ls._maneuver = {
      phase: "retreat", intersection: { x: foot.x, y: foot.y }, refuge: bay, blockerId: blockerId || null,
      holdElapsed: 0, totalElapsed: 0, resumePath, origin: { x: foot.x, y: foot.y }, parked: false
    };
    ls.plannedPath = [{ x: bay.x, y: bay.y }];
    ls.currentPath = ls.plannedPath;
    ls._cursorPath = null;
    ls.pathCursor = 0;
    ls.prevX = ls.x;
    ls.prevY = ls.y;
    ls.targetX = bay.x;
    ls.targetY = bay.y;
    ls.heading = Math.atan2(bay.y - ls.y, bay.x - ls.x);
    ls.status = "MOVING";
    ls.isYielding = false;
    ls.stalledDuration = 0;
    return bay;
  }
}
