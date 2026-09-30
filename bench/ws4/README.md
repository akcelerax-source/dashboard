WS4 (baseline integrity) helper scripts. Plain node / python, never picked up by
bench/vitest.config.js (no *.run.js here) nor by the default test glob.

- probe.mjs     quick runs of a few configs; prints headline numbers and whether
                the det_digest equals the baseline row (SRC, SYSTEMS, FLEETS, SCENARIOS, SEEDS, OUT)
- cmp.py        candidate jsonl vs same-system baseline rows, per system x fleet
- cbsprobe.mjs  centralized CBS plans / truncations / residual conflicts
- stuck.mjs     prints task holders that have not moved for > STILL s (one config)
- tests/        tests/*.test.js re-pointed at zz-ws4 (run with
                npx vitest run --config bench/ws4/vitest.tests.config.js)

Variants are selected with NODEX_ABLATE (flags: fix-wait-timer, fix-cnp-window,
fix-cnp-committed, fix-cbs-fallback, fix-health-speed).
