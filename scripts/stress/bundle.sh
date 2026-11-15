#!/usr/bin/env bash
# Bundle the load generator into single Node ESM files (no node_modules needed at the destination):
#   .stress-runs/bundle/edgecoder-stress.mjs          load generator + invariant checks (run.ts)
#   .stress-runs/bundle/edgecoder-stress-report.mjs   merge results from several load generators (report.ts)
#   .stress-runs/bundle/stress-run.sh                 wrapper: target + scenario + scale from env
#   .stress-runs/bundle/targets/*.json                target profiles
# Runs with plain `node` >= 22 (the deploy/docker/Dockerfile.agent image has node 22). Uses the
# esbuild already in node_modules; nothing is installed.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-.stress-runs/bundle}"
mkdir -p "$OUT/targets"
BANNER='import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'
for entry in run:edgecoder-stress report:edgecoder-stress-report; do
  src="${entry%%:*}"; name="${entry##*:}"
  npx --no-install esbuild "scripts/stress/$src.ts" --bundle --platform=node --format=esm --target=node22 \
    --external:pg-native --banner:js="$BANNER" --log-level=warning --outfile="$OUT/$name.mjs"
done
cp scripts/stress/remote/stress-run.sh "$OUT/stress-run.sh"
chmod +x "$OUT/stress-run.sh"
cp scripts/stress/targets/*.json "$OUT/targets/"
( cd "$OUT" && shasum -a 256 edgecoder-stress.mjs edgecoder-stress-report.mjs stress-run.sh > SHA256SUMS )
echo "[bundle] $(cd "$OUT" && pwd): $(du -h "$OUT/edgecoder-stress.mjs" | cut -f1) load generator, $(du -h "$OUT/edgecoder-stress-report.mjs" | cut -f1) report merger"
