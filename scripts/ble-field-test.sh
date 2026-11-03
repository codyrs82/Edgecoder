#!/usr/bin/env bash
# scripts/ble-field-test.sh — BLE mesh between two real machines, no network involved.
#
# Run this on two Macs near each other at the same time (within a few meters, Bluetooth on).
# Each starts a throwaway agent that is offline on purpose (its coordinator address goes nowhere),
# so the only way it can reach the other machine is Bluetooth. Each one advertises, scans, and
# sends one coding task to the first EdgeCoder peer it finds; the peer runs it on its own Ollama
# and answers over BLE.
#
# Pass: both print "BLE peers (offline): <the other machine>" and "[BLE-TEST] response from ...
# status=completed". macOS asks once to allow Bluetooth for the app running this (Terminal).
#
# Uses the installed app's agent and Node when present, else this repo's build.
#   bash scripts/ble-field-test.sh            # 3 minutes
#   BLE_TEST_MINUTES=5 bash scripts/ble-field-test.sh
#   BLE_TEST_AGENT=repo bash scripts/ble-field-test.sh   # this repo's build, not the app's

set -euo pipefail

APP_AGENT="/Applications/EdgeCoder.app/Contents/Resources/agent"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${BLE_TEST_AGENT:-app}" != "repo" ] && [ -f "$APP_AGENT/dist/swarm/worker-runner.js" ]; then
  AGENT_DIR="$APP_AGENT"; NODE="$APP_AGENT/node/node"
else
  AGENT_DIR="$REPO_DIR"; NODE="$(command -v node)"
fi
MINUTES="${BLE_TEST_MINUTES:-3}"
MODEL="${BLE_TEST_MODEL:-$(curl -s http://127.0.0.1:11434/api/tags 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s).models.map(x=>x.name).filter(n=>!/embed/.test(n));process.stdout.write(m.find(n=>/coder/.test(n))||m[0]||"")}catch{}})')}"
HOST_TAG="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
SCRATCH="$(mktemp -d -t edgecoder-ble)"
LOG="$SCRATCH/agent.log"

echo "EdgeCoder BLE field test on $HOST_TAG"
echo "  agent: $AGENT_DIR"
echo "  model: ${MODEL:-none (install one in EdgeCoder first)}"
echo "  log:   $LOG"
echo "  running ${MINUTES} min; start it on the other Mac now."
[ -n "$MODEL" ] || { echo "No Ollama model found on this Mac."; exit 1; }

env HOME="$SCRATCH" AGENT_ID="ble-test-$HOST_TAG" COORDINATOR_URL="http://127.0.0.1:9" \
  LOCAL_MODEL_PROVIDER=ollama-local OLLAMA_MODEL="$MODEL" OLLAMA_AUTO_INSTALL=false \
  SANDBOX_MODE=none AGENT_MODE=swarm-only BLE_TEST_ENABLED=true LOCAL_FORWARD_PORT=0 \
  "$NODE" "$AGENT_DIR/dist/swarm/worker-runner.js" >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; true' EXIT

deadline=$(( $(date +%s) + MINUTES * 60 ))
shown=0
while [ "$(date +%s)" -lt "$deadline" ] && kill -0 "$PID" 2>/dev/null; do
  lines=$(grep -E "\[BLE\] (noble|bleno) state|advertising as|BLE peers|BLE-TEST|BLE mesh|\[BLE\] task|connecting to peer|subscribed" "$LOG" 2>/dev/null || true)
  n=$(printf '%s\n' "$lines" | grep -c . || true)
  if [ "$n" -gt "$shown" ]; then printf '%s\n' "$lines" | tail -n +"$((shown + 1))"; shown=$n; fi
  if grep -q "is not installed (it is an optionalDependency" "$LOG" 2>/dev/null; then
    echo "FAIL: this EdgeCoder install has no Bluetooth modules (fixed in desktop 1.4.25; update the app)."; exit 1
  fi
  if grep -q "\[BLE-TEST\] response from" "$LOG" 2>/dev/null && grep -q "\[BLE\] task .* completed" "$LOG" 2>/dev/null; then
    echo "PASS: sent a task over BLE and served one."; exit 0
  fi
  sleep 3
done
if grep -q "\[BLE-TEST\] response from" "$LOG" 2>/dev/null; then echo "PARTIAL: this Mac's task was answered over BLE; it didn't serve one (the other Mac may have finished first)."; exit 0; fi
if grep -q "BLE peers (offline)" "$LOG" 2>/dev/null; then echo "PARTIAL: found the other Mac but no task finished in time. Full log: $LOG"; exit 1; fi
echo "FAIL: no EdgeCoder peer found over Bluetooth. Full log: $LOG"; exit 1
