const CM = await import("../src/core/centralized/ConflictManager.js");
export function track(mods, trk, t) {
  for (const r of mods.state.get("robots") || []) {
    let e = trk.get(r.id);
    if (!e) { e = { x: r.x, y: r.y, t }; trk.set(r.id, e); }
    if (Math.hypot(r.x - e.x, r.y - e.y) > 3) { e.x = r.x; e.y = r.y; e.t = t; }
  }
}
export function dump(mods, system, say, t, trk) {
  const M = mods.MapGeometryEngine;
  const robots = mods.state.get("robots") || [];
  const reg = system === "centralized" ? mods.taskManager : mods.decentralizedFleet.taskRegistry;
  const tasks = reg.getAllTasks();
  const ts = {}; for (const k of tasks) ts[k.status] = (ts[k.status] || 0) + 1;
  const wps = M.getActiveWaypoints();
  const stations = mods.WAREHOUSE_TASK_LOCATIONS;
  const byId = new Map(robots.map(r => [r.id, r]));
  const stuck = robots.filter(r => t - trk.get(r.id).t >= 60);
  const cls = {}; const inc = (k) => cls[k] = (cls[k] || 0) + 1;
  const blocker = new Map();
  for (const r of stuck) {
    const hasTask = !!(r.currentTaskId || r.currentTask);
    const inZone = wps.some(n => Math.hypot(n.x - r.x, n.y - r.y) < 32);
    const atSt = stations.some(s => Math.hypot(s.x - r.x, s.y - r.y) < 20);
    const off = M.isOffLane(r.x, r.y);
    // blocker: nearest robot within 36 px roughly ahead
    const hx = (r.targetX ?? r.x) - r.x, hy = (r.targetY ?? r.y) - r.y, hm = Math.hypot(hx, hy) || 1;
    let b = null, bd = 1e9;
    for (const o of robots) { if (o === r) continue; const dx = o.x - r.x, dy = o.y - r.y, d = Math.hypot(dx, dy);
      if (d < 40 && (dx * hx + dy * hy) / hm > 0.3 * d && d < bd) { bd = d; b = o; } }
    if (!b && r.waitingForNode) { const [nx, ny] = String(r.waitingForNode).split(",").map(Number);
      for (const o of robots) if (o !== r && Math.hypot(o.x - nx, o.y - ny) < 32) { b = o; break; } }
    const ag = system !== "centralized" ? mods.decentralizedFleet.getAgent(r.id) : null;
    if (!b && system === "centralized" && r.isYielding) { const c = CM.conflictManager.getActiveConflictList().find(c => c.loserId === r.id); if (c && byId.has(c.winnerId)) b = byId.get(c.winnerId); }
    if (ag && r.__why === "permission" && ag._permBy && byId.has(ag._permBy.id)) b = byId.get(ag._permBy.id);
    if (!b && ag && r.isYielding && ag._yieldTo && byId.has(ag._yieldTo)) b = byId.get(ag._yieldTo);
    if (b) blocker.set(r.id, b.id);
    const why = (mods.state.get("simTimeSeconds") - (r.__whyT ?? -99) < 1) ? r.__why : "-";
    const k = [hasTask ? "task" : "notask", r.status, r.handling ? "handling" : "", r.isYielding ? "yield" : "", "why=" + why,
      inZone ? "zone" : off ? "offlane" : "lane", M.moveWithLane(r.x, r.y, r.targetX, r.targetY) ? "" : "WRONGWAY", atSt ? "station" : "", b ? "blk" : "noblk", r.taskPhase || ""].filter(Boolean).join("|");
    inc(k);
  }
  // cycles
  const seen = new Set(); let cycles = 0, cycSizes = [];
  for (const id of blocker.keys()) {
    const path = []; let cur = id; const idx = new Map();
    while (cur && !idx.has(cur) && blocker.has(cur)) { idx.set(cur, path.length); path.push(cur); cur = blocker.get(cur); }
    if (cur && idx.has(cur)) { const cyc = path.slice(idx.get(cur)).sort().join(","); if (!seen.has(cyc)) { seen.add(cyc); cycles++; cycSizes.push(path.length - idx.get(cur)); } }
  }
  // root-cause classification of wait-for chains
  const rc = {}; const rinc = (k) => rc[k] = (rc[k] || 0) + 1;
  const desc = (x) => { const o = byId.get(x); const off = M.isOffLane(o.x, o.y); const z = wps.some(n => Math.hypot(n.x - o.x, n.y - o.y) < 32);
    const ag2 = system !== "centralized" ? mods.decentralizedFleet.getAgent(o.id) : null; const pk = o.__why === "permission" && ag2 && ag2._permBy ? ":perm-" + ag2._permBy.kind : o.__why ? ":" + o.__why : "";
    return `${o.currentTaskId ? "T" : "noT"}:${o.status}${pk}${o.handling ? ":handling" : ""}:${off ? "bay" : z ? "zone" : "lane"}${M.moveWithLane(o.x, o.y, o.targetX, o.targetY) ? "" : ":wrong"}`; };
  for (const r of stuck) { if (!(r.currentTaskId)) continue;
    const path = [r.id]; let cur = r.id; const idx = new Map([[cur, 0]]);
    while (blocker.has(cur)) { cur = blocker.get(cur); if (idx.has(cur)) break; idx.set(cur, path.length); path.push(cur); }
    if (blocker.has(cur) && idx.has(cur)) { const cyc = path.slice(idx.get(cur)); const k = `CYCLE${cyc.length}[${cyc.map(desc).sort().join(" ")}]`; if (!rc[k] && process.env.CYC) for (const id of cyc) { const o = byId.get(id); say("    cyc", id, Math.round(o.x), Math.round(o.y), "->", Math.round(o.targetX), Math.round(o.targetY), o.status, o.__why, "wfn", o.waitingForNode, "yield", o.isYielding, "man", o._maneuver ? o._maneuver.phase : "-", "pc", o.pathCursor, "res", system === "centralized" && o.waitingForNode ? JSON.stringify(mods.centralizedCoordinator.intersections.snapshot()[o.waitingForNode]) : "", "conf", system === "centralized" ? JSON.stringify(CM.conflictManager.getActiveConflictList().filter(c => c.loserId === o.id || c.winnerId === o.id).map(c => [c.winnerId, c.loserId, c.reason])) : "", "dec", (() => { const a = system !== "centralized" ? mods.decentralizedFleet.getAgent(o.id) : null; const d = a && a.localDecisionTrace[0]; return d ? JSON.stringify(a._permBy) + " " + d.decision + ":" + d.reason + "@" + (d.simTime||0).toFixed(0) + " yt=" + a._yieldTo : ""; })(), JSON.stringify((o.plannedPath||[]).slice(0,5).map(p=>[Math.round(p.x),Math.round(p.y)]))); } rinc(k); }
    else if (process.env.CYC && !rc[`ROOT[${desc(cur)}${cur === r.id ? ":self" : ""}]`]) { const o = byId.get(cur); say("    root", cur, Math.round(o.x), Math.round(o.y), "->", Math.round(o.targetX), Math.round(o.targetY), o.status, o.__why, "wfn", o.waitingForNode, "yield", o.isYielding, "man", o._maneuver ? o._maneuver.phase : "-", "pc", o.pathCursor, "res", system === "centralized" && o.waitingForNode ? JSON.stringify(mods.centralizedCoordinator.intersections.snapshot()[o.waitingForNode]) : "", "conf", system === "centralized" ? JSON.stringify(CM.conflictManager.getActiveConflictList().filter(c => c.loserId === o.id || c.winnerId === o.id).map(c => [c.winnerId, c.loserId, c.reason])) : "", "dec", (() => { const a = system !== "centralized" ? mods.decentralizedFleet.getAgent(o.id) : null; const d = a && a.localDecisionTrace[0]; return d ? JSON.stringify(a._permBy) + " " + d.decision + ":" + d.reason + "@" + (d.simTime||0).toFixed(0) + " yt=" + a._yieldTo : ""; })(), JSON.stringify((o.plannedPath||[]).slice(0,5).map(p=>[Math.round(p.x),Math.round(p.y)]))); }
    if (!(blocker.has(cur) && idx.has(cur))) rinc(`ROOT[${desc(cur)}${cur === r.id ? ":self" : ""}]`);
    continue;
  }
  say("  ROOTS", JSON.stringify(Object.entries(rc).sort((a, b) => b[1] - a[1])));
  say("END", system, "t", t.toFixed(0), "robots", robots.length, "stuck60", stuck.length, "tasks", JSON.stringify(ts), "cycles", cycles, JSON.stringify(cycSizes));
  for (const [k, v] of Object.entries(cls).sort((a, b) => b[1] - a[1])) say("  ", v, k);
  if (process.env.DETAIL) for (const r of stuck.slice(0, +process.env.DETAIL)) say("   R", r.id, Math.round(r.x), Math.round(r.y), "->", Math.round(r.targetX), Math.round(r.targetY), r.status, r.__why, "wfn", r.waitingForNode, "blk", blocker.get(r.id), "task", r.currentTaskId, "stuckFor", (t - trk.get(r.id).t).toFixed(0), M.moveWithLane(r.x, r.y, r.targetX, r.targetY) ? "" : "WRONGWAY", "path", JSON.stringify((r.plannedPath||[]).slice(0,6).map(p=>[Math.round(p.x),Math.round(p.y)])));
}
export const CMlist = () => CM.conflictManager.getActiveConflictList();
