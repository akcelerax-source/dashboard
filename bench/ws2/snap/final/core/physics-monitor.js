// ==========================================================================
// NODEX - Physical safety monitor (architecture-neutral simulation integrity)
// Ground-truth accounting of what physically happened, identical for every
// architecture: footprint overlaps between robots, footprint intrusion into
// racks/restricted zones, and boundary violations. This is the simulator's
// referee, not a controller: it never commands a robot. Controller-side
// collision DETECTION is architecture-specific (central detector, local
// sensors, sensors + Edge AI) and is counted by each controller.
// ==========================================================================

import { MapGeometryEngine, ROBOT_FOOTPRINT } from "./map-geometry.js";

const CONTACT = ROBOT_FOOTPRINT.radius * 2;          // 24 px: footprints touch
const NEAR = ROBOT_FOOTPRINT.totalRadius * 2 - 4;     // 28 px: safety margins overlap

export class PhysicsMonitor {
  constructor() {
    this.reset();
  }

  reset() {
    this.collisions = 0;       // new robot-robot footprint contacts
    this.nearCollisions = 0;   // new safety-margin intrusions without contact
    this.obstacleIntrusions = 0;
    this.boundaryViolations = 0;
    this._contact = new Set();
    this._near = new Set();
    this._inObstacle = new Set();
    this._outOfBounds = new Set();
  }

  /** Counts each contact once, when it begins (not on every frame). */
  observe(robots) {
    const contact = new Set(), near = new Set();
    for (let i = 0; i < robots.length; i++) {
      const a = robots[i];
      for (let j = i + 1; j < robots.length; j++) {
        const b = robots[j];
        const dx = a.x - b.x;
        if (dx > NEAR || dx < -NEAR) continue;
        const d = Math.hypot(dx, a.y - b.y);
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (d < CONTACT) contact.add(key);
        else if (d < NEAR) near.add(key);
      }
    }
    for (const k of contact) if (!this._contact.has(k)) this.collisions++;
    for (const k of near) if (!this._near.has(k) && !this._contact.has(k)) this.nearCollisions++;
    this._contact = contact;
    this._near = near;

    const inObs = new Set(), out = new Set();
    for (const r of robots) {
      if (MapGeometryEngine.isPointInObstacle(r.x, r.y, ROBOT_FOOTPRINT.radius - 1).collision) inObs.add(r.id);
      if (!MapGeometryEngine.isWithinBounds(r.x, r.y, ROBOT_FOOTPRINT.radius - 1)) out.add(r.id);
    }
    for (const id of inObs) if (!this._inObstacle.has(id)) this.obstacleIntrusions++;
    for (const id of out) if (!this._outOfBounds.has(id)) this.boundaryViolations++;
    this._inObstacle = inObs;
    this._outOfBounds = out;
  }

  snapshot() {
    return {
      collisions: this.collisions,
      nearCollisions: this.nearCollisions,
      obstacleIntrusions: this.obstacleIntrusions,
      boundaryViolations: this.boundaryViolations
    };
  }
}
