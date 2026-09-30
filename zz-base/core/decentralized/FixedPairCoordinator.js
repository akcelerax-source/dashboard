// ==========================================================================
// NODEX - System 2 (Decentralized, no ACE): fixed two-robot coordination.
// One instance per robot (runs on the robot). There is no scheduler: pairs
// form by a peer handshake over the P2P bus.
//
//   PAIR_REQUEST -> PAIR_ACCEPT | PAIR_BUSY -> PAIR_INTENT (both)
//   -> PAIR_DECISION (right of way, decided by the lower robot ID of the pair
//      from both intents) -> PAIR_RELEASE
//
// Invariants (the baseline being demonstrated):
//   - A session has EXACTLY two robots; a robot is in at most one session.
//   - The scope never grows: a third robot that needs to coordinate with a
//     busy robot is rejected (PAIR_BUSY) and must wait and retry.
//   - Coordination is continuous: every robot keeps refreshing intent with
//     the robots in its sensor range even when there is no conflict.
//   - Right-of-way between two robots may only be negotiated inside their
//     session; the outcome (agreement) persists while they stay close.
// ==========================================================================

import { MESSAGE_TYPES } from "./PeerCommunicationBus.js";

export const PAIR_SCOPE_RADIUS = 22;     // px, drawn fixed coordination scope
export const PAIR_RANGE = 80;            // px, candidates = robots in sensor range
const REFRESH_SESSION_S = 0.4;           // intent refresh session length
const CONFLICT_SESSION_S = 1.2;          // right-of-way negotiation session length
const MAX_SESSION_S = 6.0;               // a conflict session is never held longer
const REFRESH_INTERVAL_S = 1.5;          // re-pair with the same neighbor at most this often
const REQUEST_TIMEOUT_S = 0.6;
const AGREEMENT_RELEASE_DIST = 70;       // agreement dropped once the pair separates
// A right-of-way agreement is renegotiated after this long: the situation it
// was made for (who was nearer the node) may no longer hold, and a stale
// agreement kept two blocked robots waiting on each other forever.
const AGREEMENT_TTL_S = 8.0;

export class FixedPairCoordinator {
  constructor(agent) {
    this.agent = agent;
    this.session = null;        // { sid, partner, since, until, purpose }
    this.pending = null;        // { sid, peerId, at, purpose }
    this.urgent = null;         // peer I must negotiate with (conflict)
    this.lastPairedAt = new Map();
    this.backoffUntil = new Map(); // peerId -> retry time after PAIR_BUSY
    this.agreements = new Map();   // peerId -> { iWin, reason }
    this.partnerIntent = null;
    this._seq = 0;
    this.stats = {
      sessions: 0, conflictSessions: 0, refreshSessions: 0,
      requestsSent: 0, busyRejections: 0, timeouts: 0,
      pairWaitSeconds: 0, sessionSeconds: 0, maxSessionSize: 0
    };
  }

  get bus() { return this.agent.peerBus; }
  get id() { return this.agent.robotId; }

  isPairedWith(peerId) { return !!this.session && this.session.partner === peerId; }
  inSession() { return !!this.session; }

  /** A conflict partner I need to negotiate with (set by conflict evaluation). */
  needPartner(peerId) {
    if (!this.isPairedWith(peerId)) this.urgent = peerId;
  }

  tick(dt, now, sensedIds) {
    if (this.session) {
      this.stats.sessionSeconds += dt;
      const s = this.session;
      const partnerNear = sensedIds.has(s.partner);
      if (now >= s.until || now - s.since > MAX_SESSION_S || !partnerNear) this.release(now, "complete");
      else if (s.purpose === "conflict" && this.urgent === s.partner) s.until = Math.max(s.until, now + 0.3);
    }
    // Agreements persist only while the two robots are still close.
    for (const [peerId, a] of this.agreements) {
      if (!sensedIds.has(peerId) || now - (a.at ?? now) > AGREEMENT_TTL_S) this.agreements.delete(peerId);
    }
    if (this.session) { this.urgent = null; return; }
    if (this.pending && now - this.pending.at > REQUEST_TIMEOUT_S) {
      this.stats.timeouts++;
      this.backoffUntil.set(this.pending.peerId, now + 0.3);
      this.pending = null;
    }
    if (this.pending) return;

    let target = null, purpose = "refresh";
    if (this.urgent && sensedIds.has(this.urgent) && (this.backoffUntil.get(this.urgent) || 0) <= now) {
      target = this.urgent; purpose = "conflict";
    } else if (this.agent.localState.currentTaskId) {
      // Continuous coordination: refresh with the stalest neighbor in range
      // that is itself working a task. Idle / parked robots take no part in
      // intent refresh (they coordinate only on a real conflict).
      let best = null, bestAge = -1;
      for (const pid of sensedIds) {
        if ((this.backoffUntil.get(pid) || 0) > now) continue;
        if (!this.agent.peerCache?.get(pid)?.currentTaskId) continue;
        const age = now - (this.lastPairedAt.get(pid) ?? -Infinity);
        if (age >= REFRESH_INTERVAL_S && age > bestAge) { best = pid; bestAge = age; }
      }
      target = best;
    }
    this.urgent = null;
    if (target) this.request(target, purpose, now);
  }

  request(peerId, purpose, now) {
    const sid = `PAIR-${this.id}-${++this._seq}`;
    this.pending = { sid, peerId, at: now, purpose };
    this.stats.requestsSent++;
    this.bus.unicast(this.id, peerId, MESSAGE_TYPES.PAIR_REQUEST, { sid, purpose });
  }

  _open(sid, partner, purpose, now) {
    const len = purpose === "conflict" ? CONFLICT_SESSION_S : REFRESH_SESSION_S;
    this.session = { sid, partner, since: now, until: now + len, purpose };
    this.stats.sessions++;
    if (purpose === "conflict") this.stats.conflictSessions++; else this.stats.refreshSessions++;
    this.stats.maxSessionSize = 2;
    this.lastPairedAt.set(partner, now);
    const ls = this.agent.localState;
    this.bus.unicast(this.id, partner, MESSAGE_TYPES.PAIR_INTENT, {
      sid, x: ls.x, y: ls.y, targetX: ls.targetX, targetY: ls.targetY, status: ls.status,
      currentTaskId: ls.currentTaskId, path: (ls.currentPath || []).slice(0, 6), waitingForNode: ls.waitingForNode || null
    });
  }

  release(now, reason = "complete") {
    if (!this.session) return;
    const { partner, sid } = this.session;
    this.bus.unicast(this.id, partner, MESSAGE_TYPES.PAIR_RELEASE, { sid, reason });
    this.lastPairedAt.set(partner, now);
    this.session = null;
    this.partnerIntent = null;
  }

  onMessage(msg, now) {
    const p = msg.payload || {};
    const from = msg.senderId;
    switch (msg.type) {
      case MESSAGE_TYPES.PAIR_REQUEST: {
        // Crossed requests: the lower robot ID's request wins.
        if (this.pending && this.pending.peerId === from && !this.session) {
          if (from < this.id) this.pending = null; else return;
        }
        if (this.session || this.pending || this.agent.localState.status === "ERROR") {
          this.bus.unicast(this.id, from, MESSAGE_TYPES.PAIR_BUSY, { sid: p.sid });
          return;
        }
        this.bus.unicast(this.id, from, MESSAGE_TYPES.PAIR_ACCEPT, { sid: p.sid });
        this._open(p.sid, from, p.purpose, now);
        break;
      }
      case MESSAGE_TYPES.PAIR_ACCEPT:
        if (this.pending && this.pending.sid === p.sid && !this.session) {
          const purpose = this.pending.purpose;
          this.pending = null;
          this._open(p.sid, from, purpose, now);
        } else {
          // Stale accept (I already paired elsewhere): release it at once.
          this.bus.unicast(this.id, from, MESSAGE_TYPES.PAIR_RELEASE, { sid: p.sid, reason: "stale" });
        }
        break;
      case MESSAGE_TYPES.PAIR_BUSY:
        if (this.pending && this.pending.sid === p.sid) {
          this.stats.busyRejections++;
          this.backoffUntil.set(from, now + 0.3);
          this.pending = null;
        }
        break;
      case MESSAGE_TYPES.PAIR_INTENT:
        if (this.session && this.session.sid === p.sid) this.partnerIntent = { ...p, id: from };
        break;
      case MESSAGE_TYPES.PAIR_DECISION:
        if (this.session && this.session.sid === p.sid) {
          this.agreements.set(from, { iWin: p.winner === this.id, reason: `decided by ${from}: ${p.reason}`, at: now });
        }
        break;
      case MESSAGE_TYPES.PAIR_RELEASE:
        if (this.session && this.session.sid === p.sid) {
          this.lastPairedAt.set(from, now);
          this.session = null;
          this.partnerIntent = null;
        }
        break;
      default:
        break;
    }
  }

  /** The pair member with the lower robot ID arbitrates right of way. */
  isArbiterFor(peerId) {
    return this.id < peerId;
  }

  /**
   * Arbiter side: records the decision and sends it to the partner once per
   * session. The partner adopts it on PAIR_DECISION.
   */
  agree(peerId, iWin, reason) {
    if (!this.isPairedWith(peerId)) return this.agreements.get(peerId) || null;
    const prev = this.agreements.get(peerId);
    this.agreements.set(peerId, { iWin, reason, at: prev && prev.iWin === iWin ? prev.at : this.agent.simNow });
    if (!prev || prev.iWin !== iWin || this.session.decided !== true) {
      this.session.decided = true;
      this.bus.unicast(this.id, peerId, MESSAGE_TYPES.PAIR_DECISION, { sid: this.session.sid, winner: iWin ? this.id : peerId, reason });
    }
    return this.agreements.get(peerId);
  }

  agreementWith(peerId) {
    return this.agreements.get(peerId) || null;
  }

  noteWait(dt) { this.stats.pairWaitSeconds += dt; }

  snapshot() {
    return {
      inSession: !!this.session,
      partner: this.session ? this.session.partner : null,
      sessionId: this.session ? this.session.sid : null,
      purpose: this.session ? this.session.purpose : null
    };
  }
}
