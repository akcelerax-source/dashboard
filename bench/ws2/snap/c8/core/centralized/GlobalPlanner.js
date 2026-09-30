// ==========================================================================
// NODEX ACE — Centralized Global Path Planner
// Graph-based A* path planning operating strictly on warehouse corridor graph
// Guarantees shelf obstacle clearance, boundary containment, and minimal cost
// ==========================================================================

import {
  MapGeometryEngine,
  ROBOT_FOOTPRINT
} from "../map-geometry.js";

/** Canonical, direction-independent key for the graph edge between two waypoint ids. */
function edgeKey(idA, idB) {
  return [idA, idB].sort().join("|");
}

export class GlobalPlanner {
  constructor() {
    this.waypoints = MapGeometryEngine.getActiveWaypoints();
    this.graph = this.buildNavigationGraph();
    this._layoutRef = MapGeometryEngine.generatedLayout;
  }

  /**
   * Every planner instance (agents' local planners, the back-off planner)
   * rebuilds its graph when the active layout changes; only the global
   * planner was rebuilt before, so others planned on a stale grid.
   */
  _ensureCurrentLayout() {
    if (this._layoutRef !== MapGeometryEngine.generatedLayout) {
      this._layoutRef = MapGeometryEngine.generatedLayout;
      this.rebuildGraph();
    }
  }

  /**
   * Rebuild the navigation graph from current map layout.
   * Call this when the map layout changes (e.g., adaptive regeneration).
   */
  rebuildGraph() {
    this._layoutRef = MapGeometryEngine.generatedLayout;
    this.waypoints = MapGeometryEngine.getActiveWaypoints();
    this.graph = this.buildNavigationGraph();
  }

  /**
   * Constructs an adjacency list graph from the warehouse driving aisles.
   * Nodes are waypoints at aisle intersections. Edges connect adjacent nodes along straight aisles.
   */
  buildNavigationGraph() {
    const graph = new Map();
    const aisles = MapGeometryEngine.getActiveAisles();

    // Initialize nodes
    for (const wp of this.waypoints) {
      graph.set(wp.id, {
        node: wp,
        neighbors: []
      });
    }

    // Connect along horizontal aisles
    for (const h of aisles.horizontal) {
      const aisleWps = this.waypoints
        .filter(wp => wp.y === h.y)
        .sort((a, b) => a.x - b.x);

      for (let i = 0; i < aisleWps.length - 1; i++) {
        const u = aisleWps[i];
        const v = aisleWps[i + 1];

        // Verify edge does not cross any shelf
        const edgeCheck = MapGeometryEngine.doesSegmentIntersectObstacle(u, v, ROBOT_FOOTPRINT.radius);
        if (!edgeCheck.collision) {
          const dist = Math.hypot(v.x - u.x, v.y - u.y);
          graph.get(u.id).neighbors.push({ id: v.id, node: v, cost: dist });
          graph.get(v.id).neighbors.push({ id: u.id, node: u, cost: dist });
        }
      }
    }

    // Connect along vertical aisles
    for (const v of aisles.vertical) {
      const aisleWps = this.waypoints
        .filter(wp => wp.x === v.x)
        .sort((a, b) => a.y - b.y);

      for (let i = 0; i < aisleWps.length - 1; i++) {
        const u = aisleWps[i];
        const v2 = aisleWps[i + 1];

        // Verify edge does not cross any shelf
        const edgeCheck = MapGeometryEngine.doesSegmentIntersectObstacle(u, v2, ROBOT_FOOTPRINT.radius);
        if (!edgeCheck.collision) {
          const dist = Math.hypot(v2.x - u.x, v2.y - u.y);
          graph.get(u.id).neighbors.push({ id: v2.id, node: v2, cost: dist });
          graph.get(v2.id).neighbors.push({ id: u.id, node: u, cost: dist });
        }
      }
    }

    return graph;
  }

  /**
   * Finds the nearest legal waypoint reachable from a given point without crossing obstacles.
   * Prefers waypoints on the same aisle (same x or y) for valid corridor connections.
   */
  findNearestReachableWaypoint(x, y, radius = ROBOT_FOOTPRINT.radius) {
    this._ensureCurrentLayout();
    const target = { x, y };
    const aisles = MapGeometryEngine.getActiveAisles();
    
    // First, find which aisle the point is on (or nearest to)
    let onHorizontalAisle = null;
    let onVerticalAisle = null;
    let minHDist = Infinity;
    let minVDist = Infinity;
    
    for (const h of aisles.horizontal) {
      if (x >= h.minX - radius && x <= h.maxX + radius) {
        const dist = Math.abs(h.y - y);
        if (dist < minHDist) {
          minHDist = dist;
          onHorizontalAisle = h;
        }
      }
    }
    for (const v of aisles.vertical) {
      if (y >= v.minY - radius && y <= v.maxY + radius) {
        const dist = Math.abs(v.x - x);
        if (dist < minVDist) {
          minVDist = dist;
          onVerticalAisle = v;
        }
      }
    }

    // Collect candidates, preferring waypoints on the same aisle
    const candidates = [...this.waypoints].map(wp => {
      let priority = 0;
      // High priority if on same horizontal aisle
      if (onHorizontalAisle && wp.hAisle === onHorizontalAisle.id) priority += 100;
      // High priority if on same vertical aisle
      if (onVerticalAisle && wp.vAisle === onVerticalAisle.id) priority += 100;
      // Medium priority if on any aisle the point is on
      if (onHorizontalAisle && wp.hAisle === onHorizontalAisle.id) priority += 50;
      if (onVerticalAisle && wp.vAisle === onVerticalAisle.id) priority += 50;
      
      return {
        wp,
        dist: Math.hypot(wp.x - x, wp.y - y),
        priority
      };
    }).sort((a, b) => b.priority - a.priority || a.dist - b.dist);

    for (const c of candidates) {
      const check = MapGeometryEngine.doesSegmentIntersectObstacle(target, c.wp, radius);
      if (!check.collision) {
        return c.wp;
      }
    }

    // Fallback: any reachable waypoint
    for (const c of candidates) {
      const check = MapGeometryEngine.doesSegmentIntersectObstacle(target, c.wp, radius);
      if (!check.collision) {
        return c.wp;
      }
    }

    // Final fallback to nearest geometric waypoint
    return MapGeometryEngine.findNearestWaypoint(x, y);
  }

  /**
   * Returns the graph neighbors of the waypoint nearest to (x, y): the
   * waypoint node itself plus its list of {id, node, cost} neighbors along
   * connected aisle edges. Used by deadlock back-off recovery to pick a
   * genuine "previous" retreat point when a robot has no usable path
   * history of its own (e.g. it's already sitting on the waypoint).
   */
  neighborsOf(x, y) {
    this._ensureCurrentLayout();
    const wp = this.findNearestReachableWaypoint(x, y);
    if (!wp) return null;
    const entry = this.graph.get(wp.id);
    return entry ? { node: wp, neighbors: entry.neighbors } : { node: wp, neighbors: [] };
  }

  /**
   * Returns the canonical key for the graph edge nearest to the segment from
   * `fromPoint` to `toPoint`, or null when the endpoints resolve to the same
   * waypoint. Used to identify the specific corridor segment two robots are
   * contesting in a head-on conflict, so a replan can be forced off it.
   */
  contestedEdgeKey(fromPoint, toPoint) {
    this._ensureCurrentLayout();
    const a = this.findNearestReachableWaypoint(fromPoint.x, fromPoint.y);
    const b = this.findNearestReachableWaypoint(toPoint.x, toPoint.y);
    if (!a || !b || a.id === b.id) return null;
    return edgeKey(a.id, b.id);
  }

  /**
   * Plans an optimal, collision-free route from start to destination using A*.
   * Returns an array of waypoints [{x, y}, ...].
   * Uses corridor planner for start/end connections to guarantee validity.
   *
   * `options.avoidEdges` (a Set of edgeKey strings) forces the search off
   * specific graph edges — used by deadlock/head-on recovery so a replan
   * doesn't just recompute the same contested corridor segment.
   */
  planPath(start, goal, options = {}) {
    this._ensureCurrentLayout();
    // A robot parked in an off-lane bay first steps straight onto its aisle;
    // the direct-line shortcut would otherwise drive it sideways through the
    // neighbouring bays.
    // Same for a robot part-way between its bay and the lane (it is no longer
    // "off-lane" but not on the centerline either): step onto the lane first.
    const entry = MapGeometryEngine.projectToNearestAisle(start.x, start.y);
    if (entry && Math.hypot(entry.x - start.x, entry.y - start.y) > 3) {
      if (!MapGeometryEngine.doesSegmentIntersectObstacle(start, entry, ROBOT_FOOTPRINT.radius).collision) {
        const rest = MapGeometryEngine.orthogonalizePath(this._planPathRaw(entry, goal, options));
        return [{ x: start.x, y: start.y }, ...rest];
      }
    }
    return MapGeometryEngine.orthogonalizePath(this._planPathRaw(start, goal, options));
  }

  _planPathRaw(start, goal, options = {}) {
    const avoidEdges = options.avoidEdges instanceof Set && options.avoidEdges.size > 0 ? options.avoidEdges : null;
    const clampedStart = MapGeometryEngine.clampToBounds(start.x, start.y, ROBOT_FOOTPRINT.radius);
    const clampedGoal = MapGeometryEngine.clampToBounds(goal.x, goal.y, ROBOT_FOOTPRINT.radius);

    // Direct line-of-sight check: if direct segment is collision-free and on same aisle.
    // Skipped when avoiding edges — the direct segment may itself be the contested
    // edge, and this shortcut bypasses the graph (and its exclusions) entirely.
    if (!avoidEdges) {
      const directCheck = MapGeometryEngine.doesSegmentIntersectObstacle(clampedStart, clampedGoal, ROBOT_FOOTPRINT.radius);
      if (!directCheck.collision) {
        // Check if start and goal share a straight axis (same aisle)
        if (Math.abs(clampedStart.x - clampedGoal.x) < 2 || Math.abs(clampedStart.y - clampedGoal.y) < 2) {
          return [
            { x: clampedStart.x, y: clampedStart.y },
            { x: clampedGoal.x, y: clampedGoal.y }
          ];
        }
      }
    }

    // Connect to graph
    const startWp = this.findNearestReachableWaypoint(clampedStart.x, clampedStart.y);
    const goalWp = this.findNearestReachableWaypoint(clampedGoal.x, clampedGoal.y);

    if (!startWp || !goalWp) {
      // Fallback to corridor planner
      return MapGeometryEngine.planCorridorPath(clampedStart.x, clampedStart.y, clampedGoal.x, clampedGoal.y);
    }

    // Run A* search on the graph
    let pathNodes = this.runAStar(startWp.id, goalWp.id, avoidEdges);
    if (avoidEdges && pathNodes.length <= 1) {
      // No route avoids the contested edge (e.g. it's the only connection) —
      // fall back to the unrestricted search rather than returning a dead end.
      pathNodes = this.runAStar(startWp.id, goalWp.id);
    }

    // Construct full path using corridor planner for start/end segments
    const fullPath = [];

    // Start segment: use corridor planner from clampedStart to startWp
    const startSegment = MapGeometryEngine.planCorridorPath(clampedStart.x, clampedStart.y, startWp.x, startWp.y);
    fullPath.push(...startSegment);

    // Middle segments: graph path (already validated edges)
    for (const node of pathNodes) {
      const last = fullPath[fullPath.length - 1];
      if (!last || Math.hypot(last.x - node.x, last.y - node.y) > 2) {
        fullPath.push({ x: node.x, y: node.y });
      }
    }

    // Goal segment: use corridor planner from last waypoint to clampedGoal
    const lastWp = fullPath[fullPath.length - 1];
    if (Math.hypot(lastWp.x - clampedGoal.x, lastWp.y - clampedGoal.y) > 2) {
      const goalSegment = MapGeometryEngine.planCorridorPath(lastWp.x, lastWp.y, clampedGoal.x, clampedGoal.y);
      // Skip first point as it's already in fullPath
      for (let i = 1; i < goalSegment.length; i++) {
        fullPath.push(goalSegment[i]);
      }
    }

    // Validate full path (should always pass now)
    const validation = MapGeometryEngine.validatePath(fullPath, ROBOT_FOOTPRINT.radius);
    if (!validation.isValid) {
      console.warn(`[GlobalPlanner] Planned path failed validation: ${validation.reason}. Using full corridor planner.`);
      return MapGeometryEngine.planCorridorPath(clampedStart.x, clampedStart.y, clampedGoal.x, clampedGoal.y);
    }

    return fullPath;
  }

  /**
   * Internal A* search implementation.
   */
  runAStar(startId, goalId, avoidEdgeKeys = null) {
    if (startId === goalId) {
      const node = this.graph.get(startId)?.node;
      return node ? [node] : [];
    }

    const openSet = new Set([startId]);
    const cameFrom = new Map();

    const gScore = new Map();
    const fScore = new Map();

    for (const id of this.graph.keys()) {
      gScore.set(id, Infinity);
      fScore.set(id, Infinity);
    }

    gScore.set(startId, 0);
    const startNode = this.graph.get(startId).node;
    const goalNode = this.graph.get(goalId).node;
    fScore.set(startId, Math.hypot(goalNode.x - startNode.x, goalNode.y - startNode.y));

    while (openSet.size > 0) {
      // Find node in openSet with lowest fScore
      let currentId = null;
      let lowestF = Infinity;
      for (const id of openSet) {
        const score = fScore.get(id);
        if (score < lowestF) {
          lowestF = score;
          currentId = id;
        }
      }

      if (currentId === goalId) {
        // Reconstruct path
        const path = [];
        let curr = currentId;
        while (curr) {
          path.unshift(this.graph.get(curr).node);
          curr = cameFrom.get(curr);
        }
        return path;
      }

      openSet.delete(currentId);
      const currentEntry = this.graph.get(currentId);

      for (const neighbor of currentEntry.neighbors) {
        if (avoidEdgeKeys && avoidEdgeKeys.has(edgeKey(currentId, neighbor.id))) continue;
        const tentativeG = gScore.get(currentId) + neighbor.cost;
        if (tentativeG < gScore.get(neighbor.id)) {
          cameFrom.set(neighbor.id, currentId);
          gScore.set(neighbor.id, tentativeG);
          const h = Math.hypot(goalNode.x - neighbor.node.x, goalNode.y - neighbor.node.y);
          fScore.set(neighbor.id, tentativeG + h);
          openSet.add(neighbor.id);
        }
      }
    }

    // No path found on graph, return direct start and goal
    return [startNode, goalNode];
  }

  /**
   * Calculates total Euclidean length of a waypoint path.
   */
  calculatePathLength(path) {
    if (!path || path.length < 2) return 0;
    let len = 0;
    for (let i = 0; i < path.length - 1; i++) {
      len += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    }
    return len;
  }
}

export const globalPlanner = new GlobalPlanner();
