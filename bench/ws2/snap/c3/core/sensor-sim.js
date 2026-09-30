// ==========================================================================
// NODEX - On-board sensor simulation (architecture-neutral infrastructure)
// Simulates each robot's own range sensors (lidar/ToF + fiducial ID tags).
// It only produces OBSERVATIONS: what a robot can physically see within its
// sensor range. It makes no decisions; each architecture's controller decides
// what to do with them (System 2 uses them as its only collision detector,
// System 3 fuses them with Edge-AI prediction, System 1 does not use robot
// sensors for coordination: its central detector reads global state).
// ==========================================================================

import { MapGeometryEngine } from "./map-geometry.js";

export const SENSOR_RANGE = 80;          // px, forward/omni range of the on-board scanner
export const SENSOR_OBSTACLE_RANGE = 40; // px, rack/wall proximity ranging

// Deterministic noise so runs reproduce (S10 sensor uncertainty).
let noiseSeed = 7;
function noise() {
  noiseSeed = (noiseSeed * 1103515245 + 12345) % 2147483648;
  return noiseSeed / 2147483648 - 0.5;
}
export function resetSensorNoise(seed = 7) { noiseSeed = seed; }

/**
 * One sensor frame for robot `self`: detections of other robots within range
 * (position, velocity estimate, distance, bearing) and nearby static
 * obstacles. `poseUncertainty` (0..1) adds range noise.
 */
export function senseFrame(self, robots, dynamicObstacles = []) {
  const detections = [];
  const sigma = (self.poseUncertainty || 0) * 12; // px of noise at full uncertainty
  for (const o of robots) {
    if (o.id === self.id) continue;
    const dx = o.x - self.x, dy = o.y - self.y;
    const dist = Math.hypot(dx, dy);
    if (dist > SENSOR_RANGE) continue;
    const nx = sigma ? noise() * sigma : 0, ny = sigma ? noise() * sigma : 0;
    const v = o.velocity || 0, h = o.heading || 0;
    detections.push({
      id: o.id,                   // fiducial tag read by the scanner
      x: o.x + nx,
      y: o.y + ny,
      vx: Math.cos(h) * v,
      vy: Math.sin(h) * v,
      dist: Math.hypot(o.x + nx - self.x, o.y + ny - self.y),
      bearing: Math.atan2(dy, dx),
      moving: v > 0.01,
      failed: ["ERROR", "error", "failed"].includes(o.status)
    });
  }
  detections.sort((a, b) => a.dist - b.dist);
  const obstacleHits = [];
  for (const d of dynamicObstacles) {
    const dist = Math.hypot(d.x - self.x, d.y - self.y);
    if (dist < SENSOR_RANGE) obstacleHits.push({ id: d.id, x: d.x, y: d.y, dist, dynamic: true, kind: d.kind || "obstacle", radius: d.radius || 12, static: !!d.static });
  }
  const rack = MapGeometryEngine.isPointInObstacle(self.x, self.y, SENSOR_OBSTACLE_RANGE);
  if (rack.collision) obstacleHits.push({ id: rack.obstacle.id, dist: SENSOR_OBSTACLE_RANGE, dynamic: false });
  return { robotId: self.id, detections, obstacles: obstacleHits };
}
