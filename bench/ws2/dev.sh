#!/usr/bin/env bash
# WS2 dev bench: snapshot zz-ws2, run ACE on a matrix (3 shards), compare to baseline.
# Usage: bash bench/ws2/dev.sh <tag> [fleets] [scenarios] [seeds] [systems]
set -e
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
tag="$1"; fleets="${2:-10}"; scen="${3:-S01-S14}"; seeds="${4:-1,2,18427}"; systems="${5:-ace}"
src=$(bash bench/ws2/snap.sh "$tag")
out="bench/ws2/results/${tag}.jsonl"
mkdir -p bench/ws2/results
node bench/run-matrix.mjs --src "$src" --out "$out" --fleets "$fleets" --scenarios "$scen" --seeds "$seeds" --shards 3 --systems "$systems" --label "ws2_${tag}" > "bench/ws2/results/${tag}.runlog" 2>&1
rm -f bench/ws2/results/${tag}.shard*.jsonl
python bench/ws2/cmp.py "$out" > "bench/ws2/results/${tag}.cmp.txt"
tail -40 "bench/ws2/results/${tag}.cmp.txt"
