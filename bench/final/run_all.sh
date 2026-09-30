#!/bin/bash
# Final held-out runs (seeds 3,4) on the frozen src tree. Run from anywhere.
# A: src, 3 systems, all switches ON (optimized NodeX + fix-* baselines)
# C: ablations (ACE only, fleets 10,50): ws1 / ws2 / ws3 groups off
# D: ACE tests A01-A12, fleets 3,10, seed 18427
# B: "before" = src with NODEX_ABLATE=all (every ws*/fix-* switch off), 3 systems
#    (also serves as ablation "all" for ACE at fleets 10,50: identical config)
cd "$(dirname "$0")/../.."
SC=S01,S03,S06,S07,S08,S09,S13
O=bench/results/final
unset NODEX_ABLATE
node bench/run-matrix.mjs --src src --out $O/A_src_all.jsonl --systems centralized,decentralized,ace --fleets 3,10,50,100 --scenarios $SC --seeds 3,4 --shards 10 --duration none --label final_A 2>/dev/null
NODEX_ABLATE=all node bench/run-matrix.mjs --src src --out $O/B_before.jsonl --systems centralized,decentralized,ace --fleets 3,10,50,100 --scenarios $SC --seeds 3,4 --shards 10 --duration none --label final_B_before 2>/dev/null
WS1=ws1-adaptive-comm,ws1-comm-loss-adaptive,ws1-comm-relevance,ws1-conflict-calibration,ws1-degraded-link-verify,ws1-queue-cascade
WS2=ws2-contract-physical,ws2-detour-local,ws2-waitfor
WS3=ws3-busy-bid,ws3-eta-bid,ws3-joint-award
for pair in "ws1:$WS1" "ws2:$WS2" "ws3:$WS3"; do
  name=${pair%%:*}; list=${pair#*:}
  NODEX_ABLATE=$list node bench/run-matrix.mjs --src src --out $O/C_$name.jsonl --systems ace --fleets 10,50 --scenarios $SC --seeds 3,4 --shards 10 --duration none --label final_C_$name 2>/dev/null
done
node bench/run-matrix.mjs --src src --out $O/D_acetests.jsonl --systems ace --fleets 3,10 --scenarios A01-A12 --seeds 18427 --shards 10 --duration none --label final_D 2>/dev/null
find src/core -type f | sort | xargs sha1sum > bench/final/src_core_sha1_end.txt
echo ALLDONE
