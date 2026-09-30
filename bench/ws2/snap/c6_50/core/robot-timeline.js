// ==========================================================================
// NODEX - Robot activity timeline recorder
// Samples every robot's measured activity (from its task phase, status and
// velocity) on simulation time and keeps it as state segments. Identical for
// all three architectures; it only observes, it never decides. The Explain
// Simulation screen draws these segments as the Robot Activity Timeline.
// ==========================================================================

export const TIMELINE_STATES = Object.freeze(["moving", "picking", "placing", "charging", "idle", "blocked", "failed"]);

const SAMPLE_SECONDS = 0.5;
const MAX_SEGMENTS_PER_ROBOT = 600;

/** Activity of one robot right now (one of TIMELINE_STATES). */
export function activityOf(r) {
  if (["ERROR", "error", "failed"].includes(r.status)) return "failed";
  const phase = r.taskPhase;
  if (phase === "LOADING") return "picking";
  if (phase === "UNLOADING") return "placing";
  if (phase === "CHARGING" || r.status === "CHARGING" || r.status === "charging") return "charging";
  if ((r.velocity || 0) > 0.01) return "moving";
  if (r.status === "WAITING" || r.isYielding || r.currentTaskId || r.parkingBay) return "blocked";
  return "idle";
}

export class RobotTimelineRecorder {
  constructor() {
    this.reset();
  }

  reset() {
    this.tracks = new Map(); // robotId -> [{ state, start, end }]
    this.lastSample = -Infinity;
    this.lastTime = 0;
  }

  /** Records the fleet at sim time `t` (seconds); cheap to call every tick. */
  sample(robots, t) {
    if (t - this.lastSample < SAMPLE_SECONDS && t >= this.lastSample) return;
    this.lastSample = t;
    this.lastTime = t;
    for (const r of robots) {
      const st = activityOf(r);
      let segs = this.tracks.get(r.id);
      if (!segs) { segs = []; this.tracks.set(r.id, segs); }
      const last = segs[segs.length - 1];
      if (last && last.state === st) { last.end = t; continue; }
      if (last) last.end = t;
      segs.push({ state: st, start: t, end: t });
      if (segs.length > MAX_SEGMENTS_PER_ROBOT) {
        // Fold the two oldest segments together (keeps the run's span).
        const [a, b] = segs.splice(0, 2);
        segs.unshift({ state: a.end - a.start >= b.end - b.start ? a.state : b.state, start: a.start, end: b.end });
      }
    }
  }

  /**
   * Timeline in seconds: [{ robot, segments: [{ state, start, end }] }].
   * `maxRobots` / `minSegmentSeconds` bound the size for archived runs.
   */
  snapshot({ maxRobots = Infinity, minSegmentSeconds = 0 } = {}) {
    const ids = [...this.tracks.keys()].sort().slice(0, maxRobots);
    return ids.map(id => {
      const out = [];
      for (const s of this.tracks.get(id)) {
        const seg = { state: s.state, start: s.start, end: Math.max(s.end, s.start) };
        const prev = out[out.length - 1];
        if (prev && (prev.state === seg.state || seg.end - seg.start < minSegmentSeconds)) { prev.end = seg.end; continue; }
        out.push(seg);
      }
      return { robot: id, segments: out };
    });
  }
}

export const robotTimeline = new RobotTimelineRecorder();
