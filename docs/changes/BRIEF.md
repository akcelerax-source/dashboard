# NodeX r6 optimization: shared brief for workstream agents

Project: `C:\Users\kames\claude dashboard\Dashboard control` (vanilla JS ES modules, vitest 5).
Three systems: centralized, decentralized, ace (NodeX Edge AI ACE decentralized).
Goal: make NodeX ACE genuinely more efficient than BOTH baselines through real
algorithmic/architectural improvements, proven by simulation.

## Read first
- `docs/NODEX_ARCHITECTURE_AUDIT.md`: code audit with file:line and the ranked slowdown suspects.
- `docs/NODEX_RESEARCH_AND_DESIGN_RATIONALE.md`: research and the ranked improvement list.
- `bench/results/BASELINE_SUMMARY.md` and `bench/results/baseline_analysis.md`: measured baseline.
- `docs/NODEX_EXPERIMENT_CONFIGURATION.md`: how the harness works.
- `docs/NODEX_EFFICIENCY_INDEX_VALIDATION.md`: NFEI v2 (throughput-dominated, centralized-referenced).

## Non-negotiable rules
- No fake efficiency. Never hard-code results, fabricate telemetry, weaken or delay
  centralized/decentralized, or change metrics.
- NodeX stays decentralized. No hidden central controller, no global oracle that a
  real robot could not have. Robots may use only their own state plus what they
  receive from peers over the PeerCommunicationBus (or their own sensors).
- Keep ACE, RACE, the four envelope states (LOCAL, NEIGHBORHOOD, CONTAINMENT,
  SAFE-DEGRADED), Edge AI and HITL. Each state must keep changing a real decision.
- Decentralized keeps its fixed-scope continuous coordination. Do not add ACE
  features to it.
- Safety: 0 collisions, 0 obstacle intrusions, 0 boundary violations. Near-collisions
  must not become significantly worse. Real comm loss must still be handled safely.
- Fleet sizes are only 3, 10, 50, 100.

## Working rules
- Work ONLY in your own copy `zz-wsN/` (a full copy of `src/`). Never edit `src/`,
  `zz-base/`, other `zz-ws*` copies, or the harness files in `bench/` (you may add
  new scripts under `bench/wsN/`).
- Gate every NodeX change with `aceFeature("<name>")` from `core/ace/ace-features.js`
  (import path relative to your file). Use short kebab names with your prefix,
  e.g. `ws1-edge-calibration`. With `NODEX_ABLATE=all` ACE must behave exactly as
  the baseline: verify by re-running a few ACE configurations with
  `NODEX_ABLATE=all` and comparing to the matching rows of `bench/results/baseline.jsonl`
  (identical task counts and completion time).
- A genuine bug shared by several systems may be fixed for all of them only when
  it is clearly a bug (not a tuning choice). Gate it with a `fix-` prefixed name,
  explain it, and measure its effect on each affected system.
- Method: hypothesis, one coherent change, dev bench, compare, keep or revert,
  next. Don't tune parameters until a score appears; prefer principled values and
  check they hold across scenarios and fleets.
- Seeds: DEV seeds are 18427, 1, 2 only. Seeds 3, 4, 5 and above are the held-out
  FINAL TEST set: never run them.
- CPU: the machine has 12 cores shared by 4 agents. Use at most 3 parallel shards
  (`--shards 3`, or 3 background vitest processes).
- Harness: `node bench/run-matrix.mjs --src zz-wsN --out bench/results/wsN_<tag>.jsonl
  --fleets 10,50 --scenarios S01,S06 --seeds 1,2 --shards 3 --label wsN_<tag>`,
  then `python bench/analyze.py <jsonl> --md <md> --json <json>`. Single runs:
  env SRC, SYSTEMS, FLEETS, SCENARIOS, SEEDS, OUT, LABEL with
  `npx vitest run --config bench/vitest.config.js`. `NODEX_ABLATE` env is
  inherited by the vitest workers. 100-robot ACE runs take about 100 s each.
  Compare your ACE rows against the same scenario/fleet/seed rows in
  `bench/results/baseline.jsonl` (baseline ace, decentralized, centralized).
- Bash breaks heredocs with apostrophes; write scripts with the Write tool.
- Before finishing, run a broad dev check of your final version: ace on all
  S01-S14 at fleets 10 and 50 with seeds 1,2, plus 3 and 100 on at least 4
  scenarios. Report regressions honestly.

## Deliverables
1. `bench/patches/wsN.diff`: `diff -ruN src zz-wsN` limited to your changes.
2. `docs/changes/wsN.md`: one entry per kept change with Change ID, Component,
   Old behavior, Problem, Evidence, New behavior, Reason, Expected effect,
   Measured effect (numbers with the jsonl file they come from), Regression status.
   Also list changes you tried and reverted, with their measured effect.
3. Final reply (<= 500 words): kept changes and flag names, measured effect vs
   baseline ace/decentralized/centralized by fleet (throughput, tasks done, cycle
   time, stops, near-collisions), regressions, files touched (with line ranges in
   RobotAgent.js so the merge can be planned).
