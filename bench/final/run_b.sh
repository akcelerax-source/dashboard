#!/bin/bash
# Run B on zz-base-final (= zz-base + src/core/ace/ace-features.js, needed because
# zz-base/core/scenario-engine.js was mirrored from src and imports it).
# NODEX_ABLATE=all turns off the only flag it gates (fix-health-speed), so the
# tree is the pre-optimization code (digests verified vs baseline.jsonl).
cd "$(dirname "$0")/../.."
until grep -q ALLDONE bench/results/final/run_bcd.log; do sleep 15; done
SC=S01,S03,S06,S07,S08,S09,S13
O=bench/results/final
export NODEX_ABLATE=all
node bench/run-matrix.mjs --src zz-base-final --out $O/B_base_ace.jsonl --systems ace --fleets 3,10,50,100 --scenarios $SC --seeds 3,4 --shards 5 --label final_B_ace 2>/dev/null &
node bench/run-matrix.mjs --src zz-base-final --out $O/B_base_cd.jsonl --systems centralized,decentralized --fleets 50,100 --scenarios $SC --seeds 3,4 --shards 5 --label final_B_cd 2>/dev/null &
wait
echo BDONE
