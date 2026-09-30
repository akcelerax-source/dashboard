# Benchmark Harness

Headless benchmark for the three coordination systems. It runs scenario and ACE-test matrices through the real simulator, writes one JSONL line per run, and analyzes the results.

Raw output (`*.jsonl`, `snap/`, `out/`) is not committed. Regenerate it with the commands below. Markdown analyses and summary JSON stay in `results/`.

## Files

| File | Purpose |
|------|---------|
| `bench.run.js` | Vitest runner. Parameters via env vars: `SRC`, `SYSTEMS`, `FLEETS`, `SCENARIOS`, `SEEDS`, `KIND`, `DURATION`, `OUT`, `LABEL`, `SHARD`. |
| `vitest.config.js` | Benchmark-only Vitest config (matches `bench/**/*.run.js`). |
| `run-matrix.mjs` | Runs `bench.run.js` in parallel shard processes and merges the JSONL. |
| `check-determinism.mjs` | Checks that repeated runs have equal `det_digest`. |
| `analyze.py` | Per system x fleet x scenario statistics (mean, median, std, 95% CI) and paired ACE-vs-baseline comparison. Stdlib only. |
| `import_to_dashboard.py` | Imports runs into the dashboard's shared run history (backend must run). |
| `lib.js` | Shared helpers. |
| `final/` | Held-out final runs (`run_all.sh`) and analysis. |
| `patches/` | Diff of each work stream (ws1 to ws4). |
| `ws1/` to `ws4/` | Per-work-stream diagnostic scripts. |

## Usage

```bash
# One quick run
SRC=src SYSTEMS=ace FLEETS=10 SCENARIOS=S01 npx vitest run --config bench/vitest.config.js

# Full baseline matrix
node bench/run-matrix.mjs --src zz-base --out bench/results/baseline.jsonl \
  --fleets 3,10,50,100 --scenarios S01-S14 --seeds 18427,1,2 --shards 5

# Analyze
python bench/analyze.py bench/results/baseline.jsonl --md bench/results/baseline_analysis.md

# Determinism check
node bench/check-determinism.mjs bench/results/determinism.jsonl

# Final held-out runs
bash bench/final/run_all.sh
```

`--src zz-base` is the frozen baseline tree. `--src src` is the current code. `NODEX_ABLATE` switches individual fixes off for ablation runs. See [../docs/NODEX_EXPERIMENT_CONFIGURATION.md](../docs/NODEX_EXPERIMENT_CONFIGURATION.md).
