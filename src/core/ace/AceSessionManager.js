// ==========================================================================
// NODEX - ACE temporary coordination sessions + space-time contracts
// (System 3: NodeX Edge AI ACE decentralized only). One instance per robot.
//
// Adaptive scope: the RACE envelope state decides whether a session is
// opened and how many robots it contains:
//   LOCAL          -> no session; the robot resolves alone (1 robot)
//   NEIGHBORHOOD   -> session with the robots the sensors + Edge AI predict
//                     a conflict with (typically 2-3 robots)
//   CONTAINMENT    -> session widened to every robot inside the envelope plus
//                     queued robots sharing the contested region (N robots)
//   SAFE-DEGRADED  -> no session; explicit safe crawl (see RobotAgent)
// A session is event-driven and temporary: it carries one space-time contract
// (region + ordered time slots). Members consume the contract: the order
// decides right of way and a robot holds at the region edge until its slot.
// The session closes when every member has cleared the region, the contract
// expires, or the initiator's risk returns to LOCAL.
// ==========================================================================

import { MESSAGE_TYPES } from "../decentralized/PeerCommunicationBus.js";
import { MapGeometryEngine } from "../map-geometry.js";
import { INTERSECTION_ZONE_RADIUS } from "../intersection-reservation.js";

import { aceFeature } from "./ace-features.js";
import { WaitForResolver, WAITFOR_ENABLED, WF_PROBE, WF_RESOLVE } from "./WaitForResolver.js";

const CONTRACT_PHYSICAL = aceFeature("ws2-contract-physical");
// Local right-of-way reasons that encode a physical precedence (RobotAgent._rightOfWay).
const PHYSICAL_RULES = new Set(["Lane leader proceeds", "Merging AMR yields to lane traffic", "Holds intersection"]);

export const SLOT_SECONDS = 2.0;
const MAX_GROUP = 8;
const REGION_RADIUS = INTERSECTION_ZONE_RADIUS + 6;
const CLEAR_DIST = REGION_RADIUS + 10;

const nodeKey = (n) => `${Math.round(n.x)},${Math.round(n.y)}`;

export class AceSessionManager {
  constructor(agent) {
    this.agent = agent;
    this.session = null; // { sid, initiator, members:[ids], region, contract, openedAt, until }
    this.cleared = new Set();
    this._seq = 0;
    this.history = [];   // closed sessions (for analytics)
    this.stats = {
      sessionsInitiated: 0, sessionsJoined: 0, sessionSeconds: 0,
      maxGroupSize: 0, groupSizeSum: 0, contractsIssued: 0, contractSeconds: 0,
      contractHolds: 0, // ticks spent holding at a contract region edge
      contractDecisions: 0, // right-of-way decisions taken from the slot order
      slotOrderedEntries: 0, // own region entries that respected the contract slot order
      slotOrderViolations: 0, // own region entries ahead of an earlier slot
      scopeChanges: 0, sessionReplans: 0
    };
    // ws2-waitfor: distributed circular-wait detection / resolution.
    this.wfr = WAITFOR_ENABLED ? new WaitForResolver(agent) : null;
    this.holdFor = null; // earlier member I last held for at the region edge
  }

  get id() { return this.agent.robotId; }
  get bus() { return this.agent.peerBus; }

  members() { return this.session ? this.session.members : [this.id]; }

  groupSize() { return this.session ? this.session.members.length : 1; }

  /** Per-tick: open, maintain or close the session. */
  tick(dt, now, frame, ai) {
    const ls = this.agent.localState;
    const st = ls.raceState;
    if (this.session) {
      this.stats.sessionSeconds += dt;
      this._updateCleared(frame);
      const s = this.session;
      const others = s.members.filter(m => m !== this.id);
      const allCleared = others.every(m => this.cleared.has(m)) && this.cleared.has(this.id);
      const expired = now >= s.until;
      if (s.initiator === this.id && (allCleared || expired || st === "LOCAL" || st === "SAFE-DEGRADED")) {
        this.close(now, expired ? "EXPIRED" : allCleared ? "COMPLETED" : "RISK_CLEARED");
      } else if (s.initiator !== this.id && (expired || !frame.detections.some(d => d.id === s.initiator) && now - s.openedAt > SLOT_SECONDS)) {
        this._end(now, expired ? "EXPIRED" : "INITIATOR_LOST"); // local timeout, initiator out of range
      }
      return;
    }
    if (st !== "NEIGHBORHOOD" && st !== "CONTAINMENT") return;
    // Only a robot carrying out a task initiates coordination; an idle or
    // parked robot (e.g. staged next to a neighbour) has nothing to negotiate.
    if (!ls.currentTaskId) return;
    const group = this._selectGroup(st, frame, ai);
    if (group.length < 1) return;
    this.open(now, st, group, frame);
  }

  _selectGroup(st, frame, ai) {
    const ls = this.agent.localState;
    const radius = ls.envelopeRadius || 40;
    const perPeer = this.agent.edgeAi ? this.agent.edgeAi.perPeer : new Map();
    const picked = [];
    for (const d of frame.detections) {
      // ACE rule 3: never open a session with a merely standing robot.
      if (d.failed || this.agent._isStanding(d)) continue;
      const predicted = (perPeer.get(d.id) || 0) > 0.35;
      if (st === "NEIGHBORHOOD") {
        if (d.dist < radius || predicted) picked.push(d);
      } else {
        const peer = this.agent.peerCache.get(d.id);
        const queued = peer && (peer.status === "WAITING" || peer.waitingForNode);
        if (d.dist < radius || predicted || (queued && d.dist < radius * 2)) picked.push(d);
      }
    }
    picked.sort((a, b) => a.dist - b.dist);
    return picked.slice(0, MAX_GROUP - 1).map(d => d.id);
  }

  _region(frame, group) {
    const ls = this.agent.localState;
    const nodes = MapGeometryEngine.getActiveWaypoints() || [];
    const near = (x, y) => nodes.reduce((b, n) => (Math.hypot(n.x - x, n.y - y) < (b ? Math.hypot(b.x - x, b.y - y) : Infinity) ? n : b), null);
    // The contested region is my next intersection (where paths meet);
    // otherwise the intersection nearest to me and my closest neighbor.
    let n = typeof ls.targetX === "number" ? nodes.find(w => Math.hypot(w.x - ls.targetX, w.y - ls.targetY) < 2) : null;
    if (!n) {
      const d = frame.detections.find(x => x.id === group[0]);
      n = d ? near((ls.x + d.x) / 2, (ls.y + d.y) / 2) : near(ls.x, ls.y);
    }
    return n ? { x: n.x, y: n.y, radius: REGION_RADIUS, nodeKey: nodeKey(n) } : null;
  }

  open(now, st, group, frame) {
    const region = this._region(frame, group);
    if (!region) return;
    const members = [this.id, ...group];
    // Contract order: robots already inside the region clear it first, then by
    // distance to the region (closest first), then robot ID.
    const pos = new Map(frame.detections.map(d => [d.id, d]));
    pos.set(this.id, { x: this.agent.localState.x, y: this.agent.localState.y });
    const dist = (id) => { const p = pos.get(id); return p ? Math.hypot(p.x - region.x, p.y - region.y) : Infinity; };
    // Parked robots (no task) are not traversing the region: they are ordered
    // last and a parked robot inside the region is asked to vacate it.
    const parked = (id) => {
      if (id === this.id) return !this.agent.localState.currentTaskId;
      const p = this.agent.peerCache.get(id);
      return !!p && !p.currentTaskId && p.status !== "MOVING";
    };
    const order = [...members].sort((a, b) => {
      const pa = parked(a) ? 1 : 0, pb = parked(b) ? 1 : 0;
      const ia = dist(a) < REGION_RADIUS ? 0 : 1, ib = dist(b) < REGION_RADIUS ? 0 : 1;
      return pa - pb || ia - ib || dist(a) - dist(b) || (a < b ? -1 : 1);
    });
    for (const m of members) {
      if (m !== this.id && parked(m) && dist(m) < REGION_RADIUS) {
        const ls = this.agent.localState;
        this.bus.unicast(this.id, m, MESSAGE_TYPES.CLEARANCE_REQUEST, { x: ls.x, y: ls.y, targetX: ls.targetX, targetY: ls.targetY, hops: 0 });
      }
    }
    const sid = `ACE-${this.id}-${++this._seq}`;
    const until = now + order.length * SLOT_SECONDS + 2;
    const contract = {
      id: `STC-${sid}`,
      sessionId: sid,
      participants: order,
      order,
      region,
      resource: `Intersection (${region.x}, ${region.y})`,
      coordinates: { x: region.x, y: region.y, radius: region.radius },
      slots: order.map((id, i) => ({ robotId: id, start: now + i * SLOT_SECONDS, end: now + (i + 1) * SLOT_SECONDS })),
      timeWindow: { start: +now.toFixed(1), end: +until.toFixed(1) },
      owner: order[0],
      status: "ACTIVE",
      expiration: +until.toFixed(1),
      envelope: st,
      conflictHandling: `Space-time contract: ${order.join(" -> ")} through (${region.x}, ${region.y})`
    };
    this.session = { sid, initiator: this.id, members, region, contract, openedAt: now, until, envelope: st };
    this.cleared = new Set();
    this.stats.sessionsInitiated++;
    this.stats.contractsIssued++;
    this.stats.scopeChanges++;
    this.stats.maxGroupSize = Math.max(this.stats.maxGroupSize, members.length);
    this.stats.groupSizeSum += members.length;
    for (const m of group) this.bus.unicast(this.id, m, MESSAGE_TYPES.ACE_SESSION_OPEN, { session: this.session });
    this.agent.logDecision("ACE_SESSION_OPEN", `Opened ${st} session with ${members.length} robots; contract ${contract.id}: ${order.join(" -> ")}.`, { size: members.length });
  }

  close(now, reason) {
    if (!this.session) return;
    for (const m of this.session.members) if (m !== this.id) this.bus.unicast(this.id, m, MESSAGE_TYPES.ACE_SESSION_CLOSE, { sid: this.session.sid, reason });
    this._end(now, reason);
  }

  _end(now, reason) {
    const s = this.session;
    if (!s) return;
    const secs = now - s.openedAt;
    if (s.initiator === this.id) {
      this.stats.contractSeconds += secs;
      this.history.push({ sid: s.sid, members: s.members.length, envelope: s.envelope, openedAt: s.openedAt, closedAt: now, reason, contract: s.contract.id });
      if (this.history.length > 40) this.history.shift();
      this.agent.logDecision("ACE_SESSION_CLOSED", `Session ${s.sid} closed (${reason}) after ${secs.toFixed(1)}s; envelope contracts.`, {});
    }
    this.session = null;
    this.cleared = new Set();
    this.stats.scopeChanges++;
  }

  onMessage(msg, now) {
    const p = msg.payload || {};
    if (msg.type === WF_PROBE || msg.type === WF_RESOLVE) {
      if (this.wfr) this.wfr.onMessage(msg, now);
      return;
    }
    if (msg.type === MESSAGE_TYPES.ACE_SESSION_OPEN) {
      const inc = p.session;
      if (!inc || !inc.members.includes(this.id)) return;
      // One session at a time; overlapping sessions resolve deterministically
      // (lower session id wins), so all members converge on the same contract.
      if (this.session && this.session.sid <= inc.sid) return;
      if (this.session && this.session.initiator === this.id) this.close(now, "MERGED");
      this.session = { ...inc, members: [...inc.members], contract: { ...inc.contract } };
      this.cleared = new Set();
      this.stats.sessionsJoined++;
      this.stats.scopeChanges++;
      this.bus.unicast(this.id, msg.senderId, MESSAGE_TYPES.ACE_SESSION_JOIN, { sid: inc.sid });
    } else if (msg.type === MESSAGE_TYPES.ACE_SESSION_CLOSE) {
      if (this.session && this.session.sid === p.sid) this._end(now, p.reason || "CLOSED");
    }
  }

  _updateCleared(frame) {
    const s = this.session;
    const r = s.region;
    const pos = new Map(frame.detections.map(d => [d.id, d]));
    pos.set(this.id, { x: this.agent.localState.x, y: this.agent.localState.y });
    for (const m of s.members) {
      const p = pos.get(m);
      if (!p) { this.cleared.add(m); continue; } // out of sensor range: gone
      const d = Math.hypot(p.x - r.x, p.y - r.y);
      if (d < REGION_RADIUS) {
        const inside = (s._inside ||= new Set());
        // Contract compliance audit (own entry only): entering after every
        // member ahead in the slot order entered, cleared or forfeited.
        if (m === this.id && !inside.has(m) && s.contract && s._seenOutside?.has(m)) {
          const ahead = s.contract.order.slice(0, Math.max(0, s.contract.order.indexOf(m)));
          // Same exemptions as the edge hold: members that entered, cleared,
          // forfeited their slot or whose route does not use the region.
          const ok = ahead.every(a => inside.has(a) || this.cleared.has(a) || !this._usesRegion(a) || this._forfeited(a, this.agent.simNow));
          if (ok) this.stats.slotOrderedEntries++; else this.stats.slotOrderViolations++;
        }
        inside.add(m);
      }
      else {
        (s._seenOutside ||= new Set()).add(m); // entries are audited only from outside
        if (s._inside?.has(m) && d > CLEAR_DIST) this.cleared.add(m);
      }
    }
    // A member whose route does not pass the region is not waiting for it.
    const ls = this.agent.localState;
    const passes = (ls.currentPath || []).some(pt => Math.hypot(pt.x - r.x, pt.y - r.y) < REGION_RADIUS)
      || Math.hypot(ls.x - r.x, ls.y - r.y) < CLEAR_DIST;
    if (!passes) this.cleared.add(this.id);
  }

  /** Does a robot's route lead through the contracted region? */
  _usesRegion(id) {
    const r = this.session.region;
    const near = (pt) => pt && typeof pt.x === "number" && Math.hypot(pt.x - r.x, pt.y - r.y) < REGION_RADIUS;
    if (id === this.id) {
      const ls = this.agent.localState;
      if (!ls.currentTaskId) return false;
      return near(ls) || near({ x: ls.targetX, y: ls.targetY }) || (ls.currentPath || []).slice(0, 4).some(near);
    }
    const p = this.agent.peerCache.get(id);
    if (!p || !p.currentTaskId) return false;
    return near(p) || near({ x: p.targetX, y: p.targetY }) || (p.currentPath || []).slice(0, 4).some(near);
  }

  /** A member forfeits its slot if the slot ended before it entered the region. */
  _forfeited(id, now) {
    const s = this.session;
    const slot = s.contract.slots[s.contract.order.indexOf(id)];
    return !!slot && now >= slot.end && !(s._inside && s._inside.has(id));
  }

  /**
   * Contract right of way between me and `peerId` (null = not covered by the
   * contract: then the robot's local rule applies). The contract only
   * arbitrates robots that both compete for the contracted region.
   */
  decide(peerId, localReason = null) {
    const s = this.session;
    if (!s || !s.contract.order.includes(peerId)) return null;
    // ws2-contract-physical: the contract orders robots that compete for the
    // region; it never overrides a physical precedence (a follower cannot pass
    // its lane leader, a bay robot cannot enter an occupied lane, a robot
    // inside the hub must leave it first). Overriding those only produced
    // mutual waits that the timeout tie-break had to undo.
    if (CONTRACT_PHYSICAL && localReason && PHYSICAL_RULES.has(localReason)) return null;
    if (!this._usesRegion(this.id) || !this._usesRegion(peerId)) return null;
    if (this.cleared.has(peerId)) return { iWin: true, reason: "Contract: peer already cleared region" };
    const now = this.agent.simNow;
    const o = s.contract.order;
    let iFirst = o.indexOf(this.id) < o.indexOf(peerId);
    if (iFirst && this._forfeited(this.id, now)) iFirst = false;
    else if (!iFirst && this._forfeited(peerId, now)) iFirst = true;
    this.stats.contractDecisions++; // right of way decided by the contract slot order
    return { iWin: iFirst, reason: `Space-time contract ${s.contract.id} slot order` };
  }

  /**
   * Contract consumption at the region edge: before my slot starts I hold
   * outside the region while an earlier member that still uses the region
   * has not cleared it. From my slot start on I may enter.
   */
  mustHoldBeforeRegion(nextX, nextY, now) {
    const s = this.session;
    if (!s) return false;
    const r = s.region, ls = this.agent.localState;
    const nowIn = Math.hypot(ls.x - r.x, ls.y - r.y) < REGION_RADIUS;
    const nextIn = Math.hypot(nextX - r.x, nextY - r.y) < REGION_RADIUS;
    if (nowIn || !nextIn) return false;
    const o = s.contract.order;
    const mine = o.indexOf(this.id);
    const slot = s.contract.slots[mine];
    if (!slot || now >= slot.start) return false;
    const ahead = o.slice(0, mine).filter(m => !this.cleared.has(m) && this._usesRegion(m) && !this._forfeited(m, now));
    if (ahead.length === 0) return false;
    this.holdFor = ahead[0];
    this.stats.contractHolds++;
    return true;
  }

  snapshot() {
    const s = this.session;
    return s ? { sid: s.sid, initiator: s.initiator, members: [...s.members], envelope: s.envelope, contract: s.contract, region: s.region } : null;
  }
}
