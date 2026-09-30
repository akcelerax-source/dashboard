#!/bin/bash
# Final held-out runs B, C, D (seeds 3,4). Run from project root.
cd "$(dirname "$0")/../.."
SC=S01,S03,S06,S07,S08,S09,S13
O=bench/results/final
node bench/run-matrix.mjs --src zz-base --out $O/B_base_ace.jsonl --systems ace --fleets 3,10,50,100 --scenarios $SC --seeds 3,4 --shards 5 --label final_B_ace 2>/dev/null &
node bench/run-matrix.mjs --src zz-base --out $O/B_base_cd.jsonl --systems centralized,decentralized --fleets 50,100 --scenarios $SC --seeds 3,4 --shards 5 --label final_B_cd 2>/dev/null &
wait
WS1=ws1-adaptive-comm,ws1-comm-loss-adaptive,ws1-comm-relevance,ws1-conflict-calibration,ws1-degraded-link-verify,ws1-queue-cascade
WS2=ws2-contract-physical,ws2-detour-local,ws2-waitfor
WS3=ws3-busy-bid,ws3-eta-bid,ws3-joint-award
for pair in "all:all" "ws1:$WS1" "ws2:$WS2" "ws3:$WS3"; do
  name=${pair%%:*}; list=${pair#*:}
  NODEX_ABLATE=$list node bench/run-matrix.mjs --src src --out $O/C_$name.jsonl --systems ace --fleets 10,50 --scenarios $SC --seeds 3,4 --shards 10 --label final_C_$name 2>/dev/null
done
node bench/run-matrix.mjs --src src --out $O/D_acetests.jsonl --systems ace --fleets 3,10 --scenarios A01-A12 --seeds 18427 --shards 10 --label final_D 2>/dev/null
echo ALLDONE
