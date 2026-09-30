#!/usr/bin/env bash
# Snapshot zz-ws2 into bench/ws2/snap/<tag> so long benchmark runs are not
# affected by later edits. Usage: bash bench/ws2/snap.sh <tag>
set -e
root="$(cd "$(dirname "$0")/../.." && pwd)"
tag="$1"
[ -n "$tag" ] || { echo "usage: snap.sh <tag>"; exit 1; }
dst="$root/bench/ws2/snap/$tag"
rm -rf "$dst"
mkdir -p "$dst"
cp -r "$root/zz-ws2/core" "$root/zz-ws2/data" "$dst/"
[ -d "$root/zz-ws2/components" ] && cp -r "$root/zz-ws2/components" "$dst/" || true
echo "bench/ws2/snap/$tag"
