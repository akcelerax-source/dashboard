# Tests

Vitest regression suites. They drive the simulator, the three coordination systems (centralized, decentralized, NodeX ACE) and the app state headlessly, without a browser.

```bash
npm install
npm test
npx vitest run tests/traffic-control.test.js
```

| Suite | Covers |
|-------|--------|
| `architecture-compliance` | The three systems stay separate; HITL only in ACE; world size scales with fleet |
| `phase2-centralized`, `phase3-decentralized`, `phase4-ace` | Per-system behavior |
| `phase5-*`, `phase8-integration`, `integration-audit`, `pre-integration` | End-to-end lifecycle wiring |
| `phase6-stress`, `high-density` | 50 and 100 robot fleets, scenario faults |
| `phase7-functional`, `phase9-simulation-window` | Functional and simulation-window behavior |
| `phase10-lifecycle-analytics`, `phase11-coordination-fixes` | Task lifecycle, analytics selection, re-allocation |
| `deadlock-backoff`, `traffic-control` | Corridor deadlock recovery and traffic control |
| `sim-lifecycle-hitl` | Simulation lifecycle and human-in-the-loop control |
| `nfei-v2` | NodeX Fleet Efficiency Index |

Benchmark runs (`bench/*.run.js`) are not matched by the default glob. See [../bench/README.md](../bench/README.md).
