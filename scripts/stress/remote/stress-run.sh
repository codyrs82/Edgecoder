#!/bin/sh
# Load-generator wrapper for a remote VM (shipped next to edgecoder-stress.mjs by scripts/stress/bundle.sh).
#
#   STRESS_TARGET=targets/live-regtest.json STRESS_SCENARIO=ramp STRESS_AGENTS=40 ./stress-run.sh
#
# Env:
#   STRESS_TARGET        target profile (default targets/live-regtest.json next to this script)
#   STRESS_SCENARIO      scenario name (required)
#   STRESS_CREDENTIALS   credentials file (default /stress/credentials.json); read, never printed
#   STRESS_REGION        label for this load generator (default $FLY_REGION, else hostname)
#   STRESS_RUN_ID        shared id across the regions of one run (default: generated)
#   STRESS_OUT_DIR       where results.json/report.md go (default /stress/out/<run>-<scenario>-<region>)
#   STRESS_AGENTS, STRESS_BUYERS, STRESS_DURATION_SEC, STRESS_RATE, ...  scale (see run.ts)
# Output: results.json in STRESS_OUT_DIR, and the same JSON as one line on stdout (progress on stderr).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
: "${STRESS_SCENARIO:?set STRESS_SCENARIO (node $here/edgecoder-stress.mjs --list)}"
export STRESS_TARGET="${STRESS_TARGET:-$here/targets/live-regtest.json}"
export STRESS_CREDENTIALS="${STRESS_CREDENTIALS:-/stress/credentials.json}"
export STRESS_REGION="${STRESS_REGION:-${FLY_REGION:-$(hostname | cut -c1-16)}}"
export STRESS_RUN_ID="${STRESS_RUN_ID:-$(date -u +%y%m%d%H%M)}"
export STRESS_OUT_DIR="${STRESS_OUT_DIR:-/stress/out/${STRESS_RUN_ID}-${STRESS_SCENARIO}-${STRESS_REGION}}"
[ -r "$STRESS_CREDENTIALS" ] || { echo "credentials file $STRESS_CREDENTIALS is not readable" >&2; exit 2; }
mkdir -p "$STRESS_OUT_DIR"
exec node "$here/edgecoder-stress.mjs" --stdout "$@"
