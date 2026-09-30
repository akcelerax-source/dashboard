// ==========================================================================
// NODEX - Central collision detector, System 1 (Centralized) only.
// Runs on the central server over the global fleet state and the global map
// (the server's own perception: fleet telemetry + warehouse model + facility
// monitoring of humans / dynamic obstacles). Detects, per central cycle:
//   - robot-robot:      footprint separation breach now or within the horizon
//   - robot-shelf:      commanded leg enters a rack (footprint-inflated)
//   - robot-boundary:   commanded leg leaves the floor
//   - restricted-area:  commanded leg enters a restricted zone
//   - dynamic-object:   human / dynamic obstacle within the stop radius
// Returns the robots the server must halt this cycle; robot-robot right of
// way is arbitrated by the ConflictManager from the same detections.
// Robot-local sensors are NOT consulted for coordination in System 1.
// ==========================================================================

import { MapGeometryEngine, ROBOT_FOOTPRINT } from "../map-geometry.js";

const HORIZON_S = 1.5;
const PX_PER_VEL = 22;
const DYNAMIC_STOP_RADIUS = 30;

export class CentralCollisionDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.counts = { robotRobot: 0, robotShelf: 0, robotBoundary: 0, restrictedArea: 0, dynamicObject: 0 };
    this._active = new Set(); // keys currently detected (count each event once)
  }

  _count(key, kind, now) {
    now.add(key);
    if (!this._active.has(key)) this.counts[kind]++;
  }

  /**
   * @param {Array} robots - global fleet state (server copy)
   * @param {Array} dynamics - humans / dynamic obstacles known to the facility model
   * @returns {{ halt: Set<string> }}
   */
  evaluate(robots, dynamics = []) {
    const now = new Set();
    const halt = new Set();
    const sep = ROBOT_FOOTPRINT.totalRadius * 2;
    const moving = robots.filter(r => !["ERROR", "error", "failed"].includes(r.status));

    for (let i = 0; i < moving.length; i++) {
      const a = moving[i];
      const av = (a.velocity || 0) * PX_PER_VEL;
      for (let j = i + 1; j < moving.length; j++) {
        const b = moving[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 80) continue;
        const bv = (b.velocity || 0) * PX_PER_VEL;
        const ax = a.x + Math.cos(a.heading || 0) * av * HORIZON_S, ay = a.y + Math.sin(a.heading || 0) * av * HORIZON_S;
        const bx = b.x + Math.cos(b.heading || 0) * bv * HORIZON_S, by = b.y + Math.sin(b.heading || 0) * bv * HORIZON_S;
        if (d < sep || Math.hypot(ax - bx, ay - by) < sep) {
          this._count(`rr:${a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id}`, "robotRobot", now);
        }
      }
    }

    for (const r of moving) {
      if (typeof r.targetX !== "number") continue;
      const leg = [{ x: r.x, y: r.y }, { x: r.targetX, y: r.targetY }];
      const hit = MapGeometryEngine.doesSegmentIntersectObstacle(leg[0], leg[1], ROBOT_FOOTPRINT.radius - 2);
      if (hit.collision) {
        const kind = hit.obstacle && hit.obstacle.type === "restricted" ? "restrictedArea" : "robotShelf";
        this._count(`${kind}:${r.id}`, kind, now);
        halt.add(r.id);
      }
      if (!MapGeometryEngine.isWithinBounds(r.targetX, r.targetY, ROBOT_FOOTPRINT.radius - 2)) {
        this._count(`bd:${r.id}`, "robotBoundary", now);
        halt.add(r.id);
      }
      if ((r.velocity || 0) > 0) {
        for (const d of dynamics) {
          const dist = Math.hypot(d.x - r.x, d.y - r.y);
          const ahead = (d.x - r.x) * Math.cos(r.heading || 0) + (d.y - r.y) * Math.sin(r.heading || 0) > 0;
          if (dist < DYNAMIC_STOP_RADIUS && ahead) {
            this._count(`dyn:${r.id}|${d.id}`, "dynamicObject", now);
            halt.add(r.id);
          }
        }
      }
    }
    this._active = now;
    return { halt };
  }

  snapshot() {
    const c = this.counts;
    return { ...c, total: c.robotRobot + c.robotShelf + c.robotBoundary + c.restrictedArea + c.dynamicObject };
  }
}
