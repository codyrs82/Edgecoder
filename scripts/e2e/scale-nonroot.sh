#!/usr/bin/env bash
# #31 blocker: run the scale stack (tests/e2e/docker-compose.scale.yml) with the
# non-root images from #9 and fail if anything needs root. CI-only throwaway values.
set -euo pipefail

COMPOSE_FILE="tests/e2e/docker-compose.scale.yml"
SEED_URL="http://127.0.0.1:4301"
PORTAL_URL="http://127.0.0.1:${SCALE_PORTAL_PORT:-4310}"
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
# Workers start after the enrolment key exists (step 2), so bring up the seed side first.
dc up -d --build --wait seed-node || fail "seed/portal failed to start (healthcheck or a container exited; logs below)"

echo "[1/6] Waiting for seed node (up to ${WAIT_SECS}s)..."
ok=""
for i in $(seq 1 "$WAIT_SECS"); do
  if status >/dev/null 2>&1; then ok=1; echo "  healthy after ${i}s"; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "seed node never became healthy"

echo "[2/6] Creating a verified portal user and an enrolment API key (#96)..."
# The production enrolment path: a portal account with a verified email owns the nodes, and
# each worker enrols itself with that account's API key (as `edgecoder-install --enroll` does).
# The only shortcut is marking the email verified in SQL, standing in for clicking the emailed
# link (this stack sends no email); tests/e2e/setup/global-setup.ts does the same.
email="scale-$(openssl rand -hex 4)@example.com"
password="$(openssl rand -hex 16)"
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.argv[1]];if(v===undefined)process.exit(1);console.log(v)})' "$1"; }
post() { curl -sS --fail-with-body -X POST -H 'content-type: application/json' "$@"; }
signup=$(post -d "{\"email\":\"$email\",\"password\":\"$password\",\"displayName\":\"Scale Test\"}" "$PORTAL_URL/auth/signup") \
  || fail "portal signup failed: $signup"
user_id=$(printf '%s' "$signup" | json userId) || fail "signup returned no userId: $signup"
dc exec -T postgres psql -v ON_ERROR_STOP=1 -q -U "${POSTGRES_USER:-edgecoder}" -d "${POSTGRES_DB:-edgecoder}" \
  -c "UPDATE portal_users SET email_verified = TRUE, verified_at_ms = $(date +%s)000 WHERE user_id = '$user_id';" \
  || fail "could not mark the test user's email verified"
login=$(post -d "{\"email\":\"$email\",\"password\":\"$password\"}" "$PORTAL_URL/auth/login") || fail "portal login failed: $login"
session=$(printf '%s' "$login" | json sessionToken) || fail "login returned no session token"
keyres=$(post -H "authorization: Bearer $session" -d '{"name":"scale-e2e"}' "$PORTAL_URL/portal/api/keys") \
  || fail "could not create a portal API key: $keyres"
SCALE_ENROLL_KEY=$(printf '%s' "$keyres" | json key) || fail "API key response had no key"
export SCALE_ENROLL_KEY
echo "  user $user_id ready; starting ${WORKERS} workers"
dc up -d --build --scale worker="${WORKERS}" worker || fail "workers failed to start (logs below)"

echo "[3/6] Letting workers run for ${SETTLE_SECS}s..."
sleep "$SETTLE_SECS"

echo "[4/6] Checking every app container is non-root and still running..."
for svc in seed-node portal worker; do
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

echo "[5/6] Scanning logs for permission errors..."
logs=$(dc logs --no-color seed-node portal worker 2>&1 || true)
# Capture first, then test: piping straight into `head` lets SIGPIPE (141) under
# pipefail turn a flood of matches into a pass.
hits=$(printf '%s\n' "$logs" | grep -Ei "EACCES|EPERM|permission denied|operation not permitted" || true)
if [ -n "$hits" ]; then
  echo "$(printf '%s\n' "$hits" | wc -l) matching line(s); first 20:"
  printf '%s\n' "$hits" | head -n 20 || true
  fail "permission errors in container logs (non-root regression; see above)"
fi

echo "[6/6] Checking every worker registered and none got blacklisted (#96)..."
# A regression that re-registers every tick trips the coordinator's BHV008
# registration-storm rule within seconds and shows up here as blacklistedAgents > 0.
# Workers register with portal-validated tokens (step 2). The seed's own embedded agent
# (loopback self-registration) is also listed, so count only the portal-enrolled workers:
# distinct worker-* ids whose enrollmentReason is "ok". EXPECT_REGISTERED=0 skips this (debugging only).
capacity=$(curl -sf -H "x-mesh-token: ${MESH_TOKEN}" "$SEED_URL/capacity" || fail "GET /capacity failed")
counts=$(printf '%s' "$capacity" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const w=new Set((j.agents||[]).filter(a=>/^worker-/.test(a.agentId)&&a.enrollmentReason==="ok"&&!a.blacklisted).map(a=>a.agentId));console.log(j.totals.agentsConnected, j.totals.blacklistedAgents, w.size)})')
read -r connected blacklisted enrolled <<<"$counts"
echo "  agentsConnected=$connected blacklistedAgents=$blacklisted portalEnrolledWorkers=$enrolled (expected $WORKERS enrolled / 0 blacklisted)"
[ "$blacklisted" = "0" ] || fail "$blacklisted agent(s) were blacklisted during the settle window"
if [ "${EXPECT_REGISTERED:-1}" = "1" ]; then
  [ "$enrolled" -ge "$WORKERS" ] || fail "expected $WORKERS portal-enrolled workers, coordinator sees $enrolled (see the seed log for registration_token_required / node_* reasons)"
fi
echo "  status: $(status | head -c 500)"
echo "=== Non-root scale test passed ==="
