#!/usr/bin/env bash
# #31 blocker: run the scale stack (tests/e2e/docker-compose.scale.yml) with the
# non-root images from #9 and fail if anything needs root. CI-only throwaway values.
set -euo pipefail

COMPOSE_FILE="tests/e2e/docker-compose.scale.yml"
SEED_URL="http://127.0.0.1:4301"
WORKERS="${WORKERS:-3}"
WAIT_SECS="${WAIT_SECS:-120}"
SETTLE_SECS="${SETTLE_SECS:-45}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 16)}"
# Must match the compose default (placeholder, scale tests only); /status needs it since #40.
MESH_TOKEN="${MESH_AUTH_TOKEN:-scale-test-placeholder-mesh-token}"
status() { curl -sf -H "x-mesh-token: ${MESH_TOKEN}" "$SEED_URL/status"; }
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }
fail() { echo "::error::$*"; exit 1; }
# On any failure, print recent container logs to the job log (the artifact has the full set).
trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo "--- last 200 log lines per service ---"; dc logs --no-color --tail 200 || true; fi' EXIT

echo "=== Non-root scale test: ${WORKERS} workers ==="
dc up -d --build --scale worker="${WORKERS}" || fail "stack failed to start (seed healthcheck or a container exited; logs below)"

echo "[1/4] Waiting for seed node (up to ${WAIT_SECS}s)..."
ok=""
for i in $(seq 1 "$WAIT_SECS"); do
  if status >/dev/null 2>&1; then ok=1; echo "  healthy after ${i}s"; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "seed node never became healthy"

echo "[2/4] Letting workers run for ${SETTLE_SECS}s..."
sleep "$SETTLE_SECS"

echo "[3/4] Checking every app container is non-root and still running..."
for svc in seed-node worker; do
  ids=$(dc ps -q "$svc")
  [ -n "$ids" ] || fail "no containers for $svc"
  n=0
  for id in $ids; do
    n=$((n + 1))
    state=$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}} exit={{.State.ExitCode}}' "$id")
    echo "  $svc/$n: $state"
    case "$state" in running*) ;; *) fail "$svc container $id is not running ($state)";; esac
    case "$state" in *"restarts=0 "*) ;; *) fail "$svc container $id restarted ($state)";; esac
    uid=$(docker exec "$id" id -u)
    [ "$uid" != "0" ] || fail "$svc container $id runs as root"
    echo "    uid=$uid"
  done
  [ "$svc" != worker ] || [ "$n" -eq "$WORKERS" ] || fail "expected $WORKERS workers, found $n"
done

echo "[4/4] Scanning logs for permission errors..."
logs=$(dc logs --no-color seed-node worker 2>&1 || true)
# Capture first, then test: piping straight into `head` lets SIGPIPE (141) under
# pipefail turn a flood of matches into a pass.
hits=$(printf '%s\n' "$logs" | grep -Ei "EACCES|EPERM|permission denied|operation not permitted" || true)
if [ -n "$hits" ]; then
  echo "$(printf '%s\n' "$hits" | wc -l) matching line(s); first 20:"
  printf '%s\n' "$hits" | head -n 20 || true
  fail "permission errors in container logs (non-root regression; see above)"
fi

# Informational: registration depends on the portal, which this stack doesn't run.
echo "  status: $(status | head -c 500)"
echo "=== Non-root scale test passed ==="
