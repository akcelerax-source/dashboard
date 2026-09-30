// ==========================================================================
// NodeX optimization feature switches (ablation support)
//
// Every NodeX improvement made during the r6 efficiency optimization is
// gated by a named switch so its contribution can be measured by turning
// it off. All switches are ON by default. For ablation runs set the env
// variable NODEX_ABLATE to a comma-separated list of names to disable, or
// "all" to disable every switch (reproduces the pre-optimization behavior).
// In the browser there is no process.env, so every switch stays ON.
// ==========================================================================

const readDisabled = () => {
  try {
    const raw = typeof process !== "undefined" && process.env ? process.env.NODEX_ABLATE || "" : "";
    return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
};

const disabled = readDisabled();

/** True when the named NodeX improvement is enabled for this run. */
export function aceFeature(name) {
  return !disabled.has("all") && !disabled.has(name);
}

/** Names disabled for this process (recorded with each benchmark run). */
export function disabledAceFeatures() {
  return [...disabled];
}
