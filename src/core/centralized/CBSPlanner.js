// ==========================================================================
// NODEX - Conflict-Based Search (CBS), System 1 (Centralized) only.
// Multi-agent path finding on the warehouse aisle graph, run by the central
// server over every robot that holds a task.
//
//   High level: best-first search over a constraint tree. Each node holds a
//   constraint set and one timed path per agent; the first conflict found
//   (vertex or head-on lane conflict) is split into two children, each adding
//   one constraint to one of the two agents, and only that agent is replanned.
//   Low level: space-time A* on (node, goal phase, time) with wait actions,
//   respecting vertex constraints (agent may not occupy node n at t) and lane
//   constraints (agent may not start traversing u->v during [t0, t1]).
//
// Aisles are single lanes: two robots may not traverse the same edge in
// opposite directions at overlapping times (head-on). Following on the same
// edge is allowed when they enter at different times.
//
// Bounded: after MAX_CT_NODES expansions the best node found so far (fewest
// conflicts) is returned and `truncated` is reported; residual conflicts are
// then handled at run time by the central conflict manager.
// ==========================================================================

import { aceFeature } from "../ace/ace-features.js";

// WS4 fix-cbs-fallback: on truncation return the best node found so far as the
// header documents (fewest conflicts, then lowest cost), not the deepest one.
const FIX_CBS_FALLBACK = aceFeature("fix-cbs-fallback");

export const CBS_STEP_SECONDS = 1.0;      // one discrete time step
export const ROBOT_SPEED_PX_S = 1.2 * 22; // nominal cruise speed (engine: velocity * 22 px/s)
const MAX_CT_NODES = 120;
const HORIZON = 360;                       // steps (6 min) per agent plan
const GOAL_HOLD = 2;                       // steps an agent occupies its final goal

const edgeSteps = (cost) => Math.max(1, Math.round(cost / (ROBOT_SPEED_PX_S * CBS_STEP_SECONDS)));

/** Binary heap keyed by f then g (larger g first: deeper nodes first on ties). */
class Heap {
  constructor(less) { this.a = []; this.less = less; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

export class CBSPlanner {
  /** @param {Map} graph - GlobalPlanner.graph: id -> { node, neighbors:[{id,node,cost}] } */
  constructor(graph) {
    this.setGraph(graph);
    this.stats = { runs: 0, ctNodesExpanded: 0, conflictsResolved: 0, truncatedRuns: 0, lowLevelCalls: 0, lastPlanMs: 0, totalPlanMs: 0 };
  }

  setGraph(graph) {
    this.graph = graph;
    this._distCache = new Map();
  }

  /** Time-to-go (steps) from every node to `goalId` (reverse Dijkstra, cached). */
  _distTo(goalId) {
    if (this._distCache.has(goalId)) return this._distCache.get(goalId);
    const dist = new Map([[goalId, 0]]);
    const open = [[0, goalId]];
    while (open.length) {
      open.sort((x, y) => x[0] - y[0]);
      const [d, u] = open.shift();
      if (d > (dist.get(u) ?? Infinity)) continue;
      for (const nb of this.graph.get(u)?.neighbors || []) {
        const nd = d + edgeSteps(nb.cost);
        if (nd < (dist.get(nb.id) ?? Infinity)) { dist.set(nb.id, nd); open.push([nd, nb.id]); }
      }
    }
    this._distCache.set(goalId, dist);
    return dist;
  }

  _h(nodeId, phase, goals) {
    let h = 0, cur = nodeId;
    for (let k = phase; k < goals.length; k++) {
      const d = this._distTo(goals[k]).get(cur);
      if (d === undefined) return Infinity;
      h += d; cur = goals[k];
    }
    return h;
  }

  /**
   * Space-time A* for one agent under `cons` (its own constraints).
   * Returns [{ id, t }] with one entry per time step the agent reaches a node
   * (waits repeat the node), or null.
   */
  lowLevel(agent, cons) {
    this.stats.lowLevelCalls++;
    const goals = agent.goals;
    const vertexBan = new Set(cons.filter(c => c.type === "vertex").map(c => `${c.node}@${c.t}`));
    const edgeBans = cons.filter(c => c.type === "edge");
    const blockedNodes = agent.blockedNodes || new Set();
    const banned = (node, t) => vertexBan.has(`${node}@${t}`) || blockedNodes.has(node);
    const edgeBanned = (u, v, t) => edgeBans.some(c => c.u === u && c.v === v && t >= c.t0 && t <= c.t1);
    // Last time any vertex constraint touches the final goal: the agent must
    // not "finish" before it (it would be sitting there).
    const finalGoal = goals[goals.length - 1];
    let lastGoalBan = -1;
    for (const c of cons) if (c.type === "vertex" && c.node === finalGoal) lastGoalBan = Math.max(lastGoalBan, c.t);

    const t0 = agent.startTime;
    // The agent is committed to reaching its start node at t0; a constraint
    // there cannot be satisfied (that branch is infeasible).
    if (vertexBan.has(`${agent.start}@${t0}`)) return null;
    let phase0 = 0;
    while (phase0 < goals.length && goals[phase0] === agent.start) phase0++;
    const h0 = this._h(agent.start, phase0, goals);
    if (!Number.isFinite(h0)) return null;
    const open = new Heap((x, y) => x.f < y.f || (x.f === y.f && x.g > y.g));
    const seen = new Set();
    open.push({ id: agent.start, phase: phase0, t: t0, g: 0, f: h0, parent: null, via: null });
    let expansions = 0;
    while (open.size) {
      const cur = open.pop();
      const key = `${cur.id}|${cur.phase}|${cur.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (++expansions > 40000) break;
      if (cur.phase === goals.length && cur.t > lastGoalBan) {
        const out = [];
        for (let n = cur; n; n = n.parent) {
          out.push({ id: n.id, t: n.t });
          // Intermediate steps while on an edge are implicit (arrival only).
        }
        return out.reverse();
      }
      if (cur.t - t0 > HORIZON) continue;
      // Wait action.
      if (!banned(cur.id, cur.t + 1)) {
        const g = cur.g + 1;
        open.push({ id: cur.id, phase: cur.phase, t: cur.t + 1, g, f: g + this._h(cur.id, cur.phase, goals), parent: cur });
      }
      for (const nb of this.graph.get(cur.id)?.neighbors || []) {
        const d = edgeSteps(nb.cost);
        const ta = cur.t + d;
        if (banned(nb.id, ta) || edgeBanned(cur.id, nb.id, cur.t)) continue;
        let phase = cur.phase;
        while (phase < goals.length && goals[phase] === nb.id) phase++;
        const h = this._h(nb.id, phase, goals);
        if (!Number.isFinite(h)) continue;
        const g = cur.g + d;
        open.push({ id: nb.id, phase, t: ta, g, f: g + h, parent: cur });
      }
    }
    return null;
  }

  /** Occupancy intervals: node visits [arrive, depart] and edge traversals (depart, arrive). */
  _intervals(path) {
    const visits = [], edges = [];
    let i = 0;
    while (i < path.length) {
      let j = i;
      while (j + 1 < path.length && path[j + 1].id === path[i].id) j++;
      const last = j === path.length - 1;
      visits.push({ node: path[i].id, a: path[i].t, d: last ? path[j].t + GOAL_HOLD : path[j].t });
      if (!last) edges.push({ u: path[j].id, v: path[j + 1].id, s: path[j].t, e: path[j + 1].t });
      i = j + 1;
    }
    return { visits, edges };
  }

  /** First conflict between any two agents' paths, or null. */
  findConflict(paths) {
    const ids = Object.keys(paths);
    const iv = {};
    for (const id of ids) iv[id] = this._intervals(paths[id]);
    let best = null;
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const A = iv[ids[x]], B = iv[ids[y]];
        for (const va of A.visits) for (const vb of B.visits) {
          if (va.node !== vb.node) continue;
          const t = Math.max(va.a, vb.a);
          if (t <= Math.min(va.d, vb.d) && (!best || t < best.t)) {
            best = { type: "vertex", a: ids[x], b: ids[y], node: va.node, t };
          }
        }
        for (const ea of A.edges) for (const eb of B.edges) {
          if (!(ea.u === eb.v && ea.v === eb.u)) continue; // head-on on one lane
          if (ea.s < eb.e && eb.s < ea.e) {
            const t = Math.max(ea.s, eb.s);
            if (!best || t < best.t) best = { type: "edge", a: ids[x], b: ids[y], ea, eb, t };
          }
        }
      }
    }
    return best;
  }

  countConflicts(paths) {
    // Cheap measure for picking the best truncated node: 0 or 1+ (first found).
    return this.findConflict(paths) ? 1 : 0;
  }

  /**
   * Number of conflicts (vertex overlaps + head-on lane swaps, same
   * definitions as findConflict) over all agent pairs (fix-cbs-fallback).
   */
  countAllConflicts(paths) {
    const ids = Object.keys(paths);
    const iv = {};
    for (const id of ids) iv[id] = this._intervals(paths[id]);
    let n = 0;
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const A = iv[ids[x]], B = iv[ids[y]];
        for (const va of A.visits) for (const vb of B.visits) {
          if (va.node === vb.node && Math.max(va.a, vb.a) <= Math.min(va.d, vb.d)) n++;
        }
        for (const ea of A.edges) for (const eb of B.edges) {
          if (ea.u === eb.v && ea.v === eb.u && ea.s < eb.e && eb.s < ea.e) n++;
        }
      }
    }
    return n;
  }

  /**
   * @param {Array} agents - [{ id, start, startTime, goals:[nodeId...], blockedNodes:Set }]
   * @returns {{ paths: Object<id, [{id,t}]>, conflictsResolved, ctNodes, truncated, ms, unsolved:[] }}
   */
  plan(agents) {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.stats.runs++;
    const root = { cons: {}, paths: {}, cost: 0, depth: 0 };
    const unsolved = [];
    for (const ag of agents) {
      root.cons[ag.id] = [];
      const p = this.lowLevel(ag, []);
      if (p) { root.paths[ag.id] = p; root.cost += p[p.length - 1].t - ag.startTime; } else unsolved.push(ag.id);
    }
    const byId = new Map(agents.map(a => [a.id, a]));
    const open = new Heap((x, y) => x.cost < y.cost || (x.cost === y.cost && x.depth > y.depth));
    open.push(root);
    let expanded = 0, resolved = 0, best = root, truncated = false, solved = false;
    const popped = []; // fix-cbs-fallback: every node found to still conflict
    while (open.size) {
      const node = open.pop();
      const conflict = this.findConflict(node.paths);
      if (!conflict) { best = node; solved = true; break; }
      if (FIX_CBS_FALLBACK) popped.push(node);
      else if (node.depth > best.depth) best = node;
      if (++expanded > MAX_CT_NODES) { truncated = true; break; }
      resolved++;
      for (const who of [conflict.a, conflict.b]) {
        let c;
        if (conflict.type === "vertex") {
          c = { type: "vertex", node: conflict.node, t: conflict.t };
        } else {
          // Forbid `who` from entering its lane while the other one is on it.
          const mine = who === conflict.a ? conflict.ea : conflict.eb;
          const other = who === conflict.a ? conflict.eb : conflict.ea;
          const dur = mine.e - mine.s;
          c = { type: "edge", u: mine.u, v: mine.v, t0: other.s - dur + 1, t1: other.e - 1 };
        }
        const cons = { ...node.cons, [who]: [...node.cons[who], c] };
        const p = this.lowLevel(byId.get(who), cons[who]);
        if (!p) continue;
        const paths = { ...node.paths, [who]: p };
        const oldP = node.paths[who];
        const cost = node.cost - (oldP[oldP.length - 1].t) + p[p.length - 1].t;
        open.push({ cons, paths, cost, depth: node.depth + 1 });
      }
    }
    if (FIX_CBS_FALLBACK && !solved && popped.length) {
      // Not solved within the bound: the best node found so far is the one
      // with the fewest conflicts (then the lowest cost), as documented above.
      let bestN = Infinity;
      for (const nd of popped) {
        const n = this.countAllConflicts(nd.paths);
        if (n < bestN || (n === bestN && nd.cost < best.cost)) { bestN = n; best = nd; }
      }
    }
    const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    this.stats.ctNodesExpanded += expanded;
    this.stats.conflictsResolved += resolved;
    if (truncated) this.stats.truncatedRuns++;
    this.stats.lastPlanMs = Math.round(ms * 100) / 100;
    this.stats.totalPlanMs += ms;
    return { paths: best.paths, conflictsResolved: resolved, ctNodes: expanded, truncated, ms, unsolved, residualConflict: !!this.findConflict(best.paths) };
  }
}
