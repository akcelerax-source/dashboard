# zz-base

Frozen copy of `src/` from before the optimization work streams (ws1 to ws4). The benchmark harness runs it as the baseline tree:

```bash
node bench/run-matrix.mjs --src zz-base --out bench/results/baseline.jsonl --fleets 3,10,50,100 --scenarios S01-S14 --seeds 18427,1,2 --shards 5
```

Do not edit this folder. Change `src/` instead.
