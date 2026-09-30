// ==========================================================================
// NODEX ACE - Intersection Reservation (shared execution-layer traffic rule)
// Every aisle intersection (navigation waypoint) is a mutex. A robot must
// hold a node's reservation before its footprint enters the node's zone and
// otherwise stops at the zone edge; reservations are granted FIFO and
// released when the holder leaves the zone.
//
// Why: aisles are single lanes and S01 hubs see several robots converge from
// different aisles at once. Pairwise back-off (deadlock-backoff.js) resolves
// one conflict at a time, but at 10+ robots arrivals outpaced it and hubs
// jammed. Serialising access to each hub keeps the node itself clear so the
// pairwise back-off only has to handle lane conflicts.
//
// The rule lives in the physical execution layer (SimEngine) and applies
// identically to Centralized, Decentralized and ACE, so it does not favour
// any architecture. Head-on lane conflicts and parked robots are still
// resolved by each architecture's own back-off logic.
// ==========================================================================

import { MapGeometryEngine } from "./map-geometry.js";

// A robot waiting at the zone edge must stay clear of a robot passing through
// the node centre: 32px > the engine's 30px separation threshold. Adjacent
// nodes are >= 67px apart, so zones never overlap.
export const INTERSECTION_ZONE_RADIUS = 32;
const RELEASE_HYSTERESIS = 4;

/**
 * True if the robot is inside any intersection zone. A robot in a zone holds
 * (or is about to hold) that node's reservation and has right of way over
 * robots outside it: the others are waiting for it to clear the node, so
 * making it yield inside the zone deadlocks the whole hub.
 */
export function inIntersectionZone(r) {
  return (MapGeometryEngine.getActiveWaypoints() || [])
    .some(n => Math.hypot(n.x - r.x, n.y - r.y) < INTERSECTION_ZONE_RADIUS);
}

/**
 * Same-direction pair on one lane: returns the robot ahead (the leader), else
 * null. A follower can never pass its leader, so making the leader wait for it
 * deadlocks both; the leader always proceeds. Shared by both arbiters.
 */
export function laneLeader(a, b) {
  const dir = (r) => {
    const dx = (r.targetX ?? r.x) - r.x, dy = (r.targetY ?? r.y) - r.y;
    const m = Math.hypot(dx, dy);
    return m > 1 ? { x: dx / m, y: dy / m } : null;
  };
  const da = dir(a), db = dir(b);
  if (!da || !db || da.x * db.x + da.y * db.y < 0.9) return null;
  const along = (b.x - a.x) * da.x + (b.y - a.y) * da.y;       // b ahead of a?
  const lateral = Math.abs((b.x - a.x) * da.y - (b.y - a.y) * da.x);
  if (lateral > 6) return null;                                  // not one lane
  return along > 0 ? b : a;
}

/**
 * True when robot `r`'s current leg (position -> target) passes through the
 * zone of node `n`: it needs that intersection next even when the node is not
 * its waypoint (straight legs skip intermediate nodes).
 */
export function legPassesNode(r, n) {
  const ax = r.x, ay = r.y, bx = r.targetX ?? r.x, by = r.targetY ?? r.y;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((n.x - ax) * dx + (n.y - ay) * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx - n.x, ay + t * dy - n.y) < INTERSECTION_ZONE_RADIUS;
}

const nodeKey = (n) => `${Math.round(n.x)},${Math.round(n.y)}`;

export class IntersectionReservations {
  constructor() {
    this.reset();
  }

  reset() {
    this.holders = new Map();   // nodeKey -> robotId
    this.queues = new Map();    // nodeKey -> [robotId, ...] (FIFO)
    this.requested = new Set(); // `${nodeKey}|${robotId}` requested this tick
  }

  nodes() {
    return MapGeometryEngine.getActiveWaypoints() || [];
  }

  /**
   * Once per engine tick, before any movement: release reservations whose
   * holder has left the zone (or no longer exists) and drop queued requests
   * that were not renewed during the previous tick (robot rerouted, stopped
   * for another reason, or was removed), so stale entries never block a queue.
   */
  beginTick(robots) {
    const byId = new Map(robots.map(r => [r.id, r]));
    const nodesByKey = new Map(this.nodes().map(n => [nodeKey(n), n]));

    for (const [key, holderId] of this.holders) {
      const holder = byId.get(holderId);
      const node = nodesByKey.get(key);
      if (!holder || !node || Math.hypot(holder.x - node.x, holder.y - node.y) > INTERSECTION_ZONE_RADIUS + RELEASE_HYSTERESIS) {
        this.holders.delete(key);
      }
    }
    for (const [key, queue] of this.queues) {
      const kept = queue.filter(id => this.requested.has(`${key}|${id}`) && byId.has(id));
      if (kept.length) this.queues.set(key, kept); else this.queues.delete(key);
    }
    this.requested.clear();
  }

  /**
   * May robot `r` move to (nextX, nextY)? True unless the move enters the zone
   * of a node reserved by someone else (or with robots queued ahead of it).
   * Entering a free node grants the reservation. A robot already inside a
   * zone may always move (leaving, or repositioning inside), so the rule can
   * never trap a robot that spawned or was stopped inside one.
   */
  tryEnter(r, nextX, nextY) {
    for (const node of this.nodes()) {
      const key = nodeKey(node);
      const nowIn = Math.hypot(r.x - node.x, r.y - node.y) < INTERSECTION_ZONE_RADIUS;
      const nextIn = Math.hypot(nextX - node.x, nextY - node.y) < INTERSECTION_ZONE_RADIUS;
      const holder = this.holders.get(key);

      if (nowIn) {
        if (!holder) this.holders.set(key, r.id); // occupying it: make that explicit
        continue;
      }
      if (!nextIn || holder === r.id) continue;

      const queue = this.queues.get(key) || [];
      if (!queue.includes(r.id)) queue.push(r.id);
      this.queues.set(key, queue);
      this.requested.add(`${key}|${r.id}`);

      if (!holder && queue[0] === r.id) {
        this.holders.set(key, r.id);
        queue.shift();
        if (!queue.length) this.queues.delete(key);
        continue;
      }
      this.lastBlockedKey = key;
      return false;
    }
    return true;
  }

  /** Read-only view for diagnostics/UI: nodeKey -> { holder, queue }. */
  snapshot() {
    const out = {};
    for (const [key, holder] of this.holders) out[key] = { holder, queue: [...(this.queues.get(key) || [])] };
    for (const [key, queue] of this.queues) if (!out[key]) out[key] = { holder: null, queue: [...queue] };
    return out;
  }
}
