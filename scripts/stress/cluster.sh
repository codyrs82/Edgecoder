# shellcheck shell=bash
# Local stress cluster definition (sourced by scripts/stress/up.sh, down.sh and the chaos helpers).
#
# Plain `docker run` on purpose: the harness must work where only the docker CLI is installed (no
# compose plugin). Every resource is named ec-stress-* and labelled
# com.docker.compose.project=ec-stress, so `docker compose -p ec-stress down -v` also removes it
# where compose exists. Host ports: 127.0.0.1 only, 56000-56199.
#
#   ec-stress-pg           Postgres 16 (shared by portal and both coordinators)
#   ec-stress-btc          bitcoind regtest          } deploy/lnd-test image and entrypoint
#   ec-stress-lnd-hub      LND: the coordinators' node }
#   ec-stress-lnd-payee    LND: buyers' and providers' wallet (pays top-ups, receives payouts)
#   ec-stress-inference    inference service, /decompose fallback only (no model)
#   ec-stress-portal       portal (accounts, API keys, node enrolment, /v1)
#   ec-stress-coord-a/-b   coordinators, NODE_ENV=production, peered by key (MESH_PEER_ALLOWLIST @url pins)
#
# Production hosts resolve to 0.0.0.0 inside every app container (--add-host), so a
# misconfiguration can never reach them; api.ipapi.is (the portal's IP lookup) likewise.

STRESS_NET=ec-stress-net
STRESS_APP_IMAGE="${STRESS_APP_IMAGE:-ec-stress-app:local}"
STRESS_LND_IMAGE="${STRESS_LND_IMAGE:-ec-stress-lnd:local}"
STRESS_PG_IMAGE="${STRESS_PG_IMAGE:-postgres:16@sha256:5db6dac2ef5dcff512f4f00a009c3c332b9f2f28f24277175bf3e4a3d02ef83a}"
STRESS_LABEL=(--label com.docker.compose.project=ec-stress --label ec-stress=1)
STRESS_NO_PROD=()
for h in edgecoder.io www.edgecoder.io portal.edgecoder.io coordinator.edgecoder.io docs.edgecoder.io \
  edgecoder-seed.fly.dev edgecoder-seed-eu.fly.dev edgecoder-portal.fly.dev api.ipapi.is; do
  STRESS_NO_PROD+=(--add-host "$h:0.0.0.0")
done

stress_build_images() {
  if [ "${STRESS_REBUILD:-0}" = "1" ] || ! docker image inspect "$STRESS_APP_IMAGE" >/dev/null 2>&1; then
    echo "[cluster] building $STRESS_APP_IMAGE from deploy/docker/Dockerfile.agent (current tree)"
    docker build -q -f deploy/docker/Dockerfile.agent -t "$STRESS_APP_IMAGE" . >/dev/null
  fi
  if [ "${STRESS_REBUILD:-0}" = "1" ] || ! docker image inspect "$STRESS_LND_IMAGE" >/dev/null 2>&1; then
    echo "[cluster] building $STRESS_LND_IMAGE from deploy/lnd-test"
    docker build -q -t "$STRESS_LND_IMAGE" deploy/lnd-test >/dev/null
  fi
}

# IPv6 on: the deploy/lnd-test entrypoint binds bitcoind RPC and LND to [::] (as on Fly).
stress_network() {
  docker network inspect "$STRESS_NET" >/dev/null 2>&1 || docker network create --ipv6 "${STRESS_LABEL[@]}" "$STRESS_NET" >/dev/null
}

stress_run() { # stress_run <name> <docker run args...>
  local name="$1"; shift
  docker run -d --name "$name" --hostname "$name" --network "$STRESS_NET" "${STRESS_LABEL[@]}" "$@" >/dev/null
}

stress_start_pg() {
  stress_run ec-stress-pg -e POSTGRES_USER=edgecoder -e POSTGRES_PASSWORD="$STRESS_PG_PASSWORD" -e POSTGRES_DB=edgecoder \
    -v ec-stress-pg-data:/var/lib/postgresql/data -p "127.0.0.1:${STRESS_PG_PORT}:5432" \
    "$STRESS_PG_IMAGE" postgres -c max_connections=300
}

stress_start_btc() {
  stress_run ec-stress-btc -e BTC_RPC_PASS="$STRESS_BTC_RPC_PASS" -v ec-stress-btc-data:/data "$STRESS_LND_IMAGE" bitcoind
}

stress_start_lnd() { # stress_start_lnd <hub|payee> <host port>
  stress_run "ec-stress-lnd-$1" -e BTC_RPC_PASS="$STRESS_BTC_RPC_PASS" -e LND_WALLET_PASS="$STRESS_LND_WALLET_PASS" \
    -e BITCOIND_HOST=ec-stress-btc -e LND_HOST="ec-stress-lnd-$1" -v "ec-stress-$1-data:/data" \
    -p "127.0.0.1:$2:8080" "$STRESS_LND_IMAGE" lnd "$1"
}

stress_start_inference() {
  # No model here: /decompose returns its one-subtask fallback (input = the prompt), so every code
  # subtask's correct output is a pure function of the prompt.
  stress_run ec-stress-inference "${STRESS_NO_PROD[@]}" -e NODE_ENV=production -e HOST=0.0.0.0 -e SKIP_OLLAMA=true \
    -e INFERENCE_AUTH_TOKEN="$STRESS_INFERENCE_TOKEN" -e DECOMPOSE_MODEL_TIMEOUT_MS=0 \
    "$STRESS_APP_IMAGE" node dist/inference/service.js
}

stress_start_portal() {
  # As in tests/e2e/docker-compose.scale.yml: the portal is the account service, not the system under
  # test for production rules (production mode needs real email and https URLs). Coordinators are
  # NODE_ENV=production, so their registration and payment rules are the production ones.
  stress_run ec-stress-portal "${STRESS_NO_PROD[@]}" -e NODE_ENV=test -e HOST=0.0.0.0 -e SKIP_OLLAMA=true \
    -e PORTAL_DATABASE_URL="postgresql://edgecoder:${STRESS_PG_PASSWORD}@ec-stress-pg:5432/edgecoder" \
    -e PORTAL_SERVICE_TOKEN="$STRESS_PORTAL_TOKEN" -e WALLET_SECRET_PEPPER="$STRESS_WALLET_PEPPER" -e RESEND_API_KEY= \
    -e COORDINATOR_DISCOVERY_URLS=http://ec-stress-coord-a:4301,http://ec-stress-coord-b:4301 \
    -e REGISTRY_FALLBACK_URLS=http://ec-stress-coord-a:4301 \
    -e PORTAL_PUBLIC_URL="http://127.0.0.1:${STRESS_PORTAL_PORT}" \
    -p "127.0.0.1:${STRESS_PORTAL_PORT}:4310" "$STRESS_APP_IMAGE" node dist/portal/server.js
}

stress_coordinator_env() { # one -e per line, read by stress_start_coordinator
  cat <<EOF
NODE_ENV=production
HOST=0.0.0.0
SKIP_OLLAMA=true
LOCAL_MODEL_PROVIDER=edgecoder-local
OLLAMA_AUTO_INSTALL=false
DATABASE_URL=postgresql://edgecoder:${STRESS_PG_PASSWORD}@ec-stress-pg:5432/edgecoder
MESH_AUTH_TOKEN=${STRESS_MESH_TOKEN}
ADMIN_API_TOKEN=${STRESS_ADMIN_TOKEN}
PORTAL_SERVICE_URL=http://ec-stress-portal:4310
PORTAL_SERVICE_TOKEN=${STRESS_PORTAL_TOKEN}
PAYMENT_WEBHOOK_SECRET=${STRESS_WEBHOOK_SECRET}
INFERENCE_AUTH_TOKEN=${STRESS_INFERENCE_TOKEN}
INFERENCE_URL=http://ec-stress-inference:4302
METRICS_TOKEN=${STRESS_METRICS_TOKEN}
MESH_PEER_ALLOWLIST=${STRESS_PEER_ALLOWLIST}
BITCOIN_NETWORK=regtest
ECONOMY_PAYMENTS_ENABLED=true
LIGHTNING_PROVIDER=lnd
LND_REST_URL=https://ec-stress-lnd-hub:8080
LND_MACAROON_HEX=${STRESS_HUB_MACAROON_HEX}
LND_TLS_CERT_BASE64=${STRESS_HUB_TLS_CERT_BASE64}
RATE_ORACLE_ENABLED=false
RESULT_VERIFICATION_RATE=${STRESS_VERIFICATION_RATE}
RESULT_VERIFICATION_TIMEOUT_MS=${STRESS_VERIFICATION_TIMEOUT_MS}
RESULT_VERIFICATION_REPLICA_CLAIM_TIMEOUT_MS=${STRESS_REPLICA_CLAIM_TIMEOUT_MS}
PAYOUT_EARNINGS_HOLD_MS=${STRESS_EARNINGS_HOLD_MS}
PAYOUT_MIN_SATS=${STRESS_PAYOUT_MIN_SATS}
PAYOUT_MAX_SINGLE_SATS=${STRESS_PAYOUT_MAX_SINGLE_SATS}
PAYOUT_MAX_ACCOUNT_DAILY_SATS=${STRESS_PAYOUT_MAX_ACCOUNT_DAILY_SATS}
PAYOUT_MAX_GLOBAL_DAILY_SATS=${STRESS_PAYOUT_MAX_GLOBAL_DAILY_SATS}
LEDGER_VERIFY_INTERVAL_MS=${STRESS_LEDGER_VERIFY_INTERVAL_MS}
COORDINATOR_PEER_CACHE_FILE=/tmp/coordinator-peer-cache.json
EOF
}

stress_start_coordinator() { # stress_start_coordinator <a|b> <host port>
  local self="coord-$1" other env_file
  [ "$1" = a ] && other=coord-b || other=coord-a
  env_file="$STRESS_SECRETS_DIR/$self.env"
  { stress_coordinator_env; echo "COORDINATOR_PEER_ID=$self"; echo "COORDINATOR_PUBLIC_URL=http://ec-stress-$self:4301"; echo "COORDINATOR_BOOTSTRAP_URLS=http://ec-stress-$other:4301"; } > "$env_file"
  chmod 600 "$env_file"
  # The identity key is a multi-line PEM, so it is read from the mounted secrets dir at start.
  stress_run "ec-stress-$self" "${STRESS_NO_PROD[@]}" --env-file "$env_file" -v "$STRESS_SECRETS_DIR/$self.key:/stress-secrets/key.pem:ro" \
    -p "127.0.0.1:$2:4301" "$STRESS_APP_IMAGE" \
    sh -c 'COORDINATOR_PRIVATE_KEY_PEM="$(cat /stress-secrets/key.pem)" exec node dist/swarm/coordinator.js'
}

stress_settings_defaults() {
  export STRESS_PG_PORT="${STRESS_PG_PORT:-56010}" STRESS_PORTAL_PORT="${STRESS_PORTAL_PORT:-56020}"
  export STRESS_COORD_A_PORT="${STRESS_COORD_A_PORT:-56001}" STRESS_COORD_B_PORT="${STRESS_COORD_B_PORT:-56002}"
  export STRESS_HUB_REST_PORT="${STRESS_HUB_REST_PORT:-56030}" STRESS_PAYEE_REST_PORT="${STRESS_PAYEE_REST_PORT:-56031}"
  export STRESS_VERIFICATION_RATE="${STRESS_VERIFICATION_RATE:-0.3}"
  export STRESS_VERIFICATION_TIMEOUT_MS="${STRESS_VERIFICATION_TIMEOUT_MS:-60000}"
  export STRESS_REPLICA_CLAIM_TIMEOUT_MS="${STRESS_REPLICA_CLAIM_TIMEOUT_MS:-20000}"
  export STRESS_EARNINGS_HOLD_MS="${STRESS_EARNINGS_HOLD_MS:-60000}"
  export STRESS_PAYOUT_MIN_SATS="${STRESS_PAYOUT_MIN_SATS:-100}"
  export STRESS_PAYOUT_MAX_SINGLE_SATS="${STRESS_PAYOUT_MAX_SINGLE_SATS:-5000}"
  export STRESS_PAYOUT_MAX_ACCOUNT_DAILY_SATS="${STRESS_PAYOUT_MAX_ACCOUNT_DAILY_SATS:-20000}"
  export STRESS_PAYOUT_MAX_GLOBAL_DAILY_SATS="${STRESS_PAYOUT_MAX_GLOBAL_DAILY_SATS:-60000}"
  export STRESS_LEDGER_VERIFY_INTERVAL_MS="${STRESS_LEDGER_VERIFY_INTERVAL_MS:-300000}"
}

stress_wait_healthy() { # stress_wait_healthy <url> <seconds>
  local i
  for i in $(seq 1 "$2"); do
    curl -sf "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
