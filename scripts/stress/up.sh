#!/usr/bin/env bash
# Bring up the local stress cluster (definition: scripts/stress/cluster.sh, plain docker run):
#   1. generate throwaway secrets and two coordinator identity keys (allowlist computed from them),
#   2. start Postgres + bitcoind + LND hub/payee, fund the payee and open payee -> hub (with push,
#      so both directions have liquidity: top-ups flow payee -> hub, payouts hub -> payee),
#   3. start inference, portal and both coordinators with the hub's macaroon/cert,
#   4. create portal accounts (providers and buyers) with API keys,
#   5. write .stress-runs/local/credentials.json (mode 600) and print what the load generator needs.
# Regtest only; nothing leaves this machine. Secrets are written to files, never printed.
#
# Knobs (env): STRESS_PROVIDERS (4) STRESS_BUYERS (3) and the STRESS_* defaults in cluster.sh
# (verification rate, earnings hold, payout caps); STRESS_REBUILD=1 rebuilds the images. Re-running up.sh on a running stack is not
# supported: run scripts/stress/down.sh first.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
RUN_DIR="${STRESS_RUN_DIR:-$ROOT/.stress-runs/local}"
SECRETS_DIR="$RUN_DIR/secrets"
# shellcheck source=scripts/stress/cluster.sh
. scripts/stress/cluster.sh
PROVIDERS="${STRESS_PROVIDERS:-4}"
BUYERS="${STRESS_BUYERS:-3}"
WAIT_SECS="${WAIT_SECS:-180}"

stress_settings_defaults
for p in "$STRESS_PG_PORT" "$STRESS_PORTAL_PORT" "$STRESS_COORD_A_PORT" "$STRESS_COORD_B_PORT" "$STRESS_HUB_REST_PORT" "$STRESS_PAYEE_REST_PORT"; do
  if [ "$p" -lt 56000 ] || [ "$p" -gt 56199 ]; then echo "port $p is outside 56000-56199" >&2; exit 1; fi
done

fail() { echo "[up] ERROR: $*" >&2; exit 1; }
log() { echo "[up] $*"; }
rand() { openssl rand -hex "${1:-24}"; }
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let v=JSON.parse(d);for(const k of process.argv[1].split("."))v=v?.[k];if(v===undefined)process.exit(1);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
wait_for() {
  local what="$1"; shift
  for _ in $(seq 1 "$WAIT_SECS"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}

if docker ps -a --format '{{.Names}}' | grep -q '^ec-stress-'; then
  fail "ec-stress-* containers already exist; run scripts/stress/down.sh first"
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$RUN_DIR" "$SECRETS_DIR"
umask 077

# ── 1. secrets ───────────────────────────────────────────────────────────────────────────
ENV_FILE="$RUN_DIR/stack.env"
{
  echo "STRESS_PG_PASSWORD=$(rand 16)"
  echo "STRESS_MESH_TOKEN=$(rand)"
  echo "STRESS_ADMIN_TOKEN=$(rand)"
  echo "STRESS_PORTAL_TOKEN=$(rand)"
  echo "STRESS_WEBHOOK_SECRET=$(rand)"
  echo "STRESS_INFERENCE_TOKEN=$(rand 32)"
  echo "STRESS_METRICS_TOKEN=$(rand)"
  echo "STRESS_WALLET_PEPPER=$(rand)"
  echo "STRESS_BTC_RPC_PASS=$(rand)"
  echo "STRESS_LND_WALLET_PASS=$(rand 16)"
} > "$ENV_FILE"
# Coordinator identity keys (Ed25519), and the allowlist pinning each peer's key and URL.
node --input-type=module -e '
import { generateKeyPairSync, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const dir = process.argv[1];
const entries = [];
for (const id of ["coord-a", "coord-b"]) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(`${dir}/${id}.key`, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o644 });
  const fp = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  entries.push(`${id}:${fp}@http://ec-stress-${id}:4301`);
}
process.stdout.write(entries.join(","));
' "$SECRETS_DIR" > "$SECRETS_DIR/allowlist"
echo "STRESS_PEER_ALLOWLIST=$(cat "$SECRETS_DIR/allowlist")" >> "$ENV_FILE"
# The containers run as uid 1000 (node): the key files must be readable inside the mount.
chmod 755 "$SECRETS_DIR"; chmod 644 "$SECRETS_DIR"/coord-*.key
set -a; . "$ENV_FILE"; set +a
export STRESS_SECRETS_DIR="$SECRETS_DIR"
stress_build_images
stress_network

# ── 2. chain + Lightning ─────────────────────────────────────────────────────────────────
log "starting Postgres, bitcoind and LND (hub, payee)"
stress_start_pg
stress_start_btc
btc_ready() { docker exec ec-stress-btc bitcoin-cli -regtest -datadir=/data -rpcuser=edgecoder -rpcpassword="$STRESS_BTC_RPC_PASS" getblockchaininfo; }
wait_for "bitcoind" btc_ready
stress_start_lnd hub "$STRESS_HUB_REST_PORT"
stress_start_lnd payee "$STRESS_PAYEE_REST_PORT"
btc() { docker exec ec-stress-btc bitcoin-cli -regtest -datadir=/data -rpcuser=edgecoder -rpcpassword="$STRESS_BTC_RPC_PASS" "$@"; }
lncli() { local n="$1"; shift; docker exec "ec-stress-lnd-$n" lncli --lnddir=/data --network=regtest "$@"; }
wait_for "hub RPC" lncli hub getinfo
wait_for "payee RPC" lncli payee getinfo
PAYEE_ADDR=$(lncli payee newaddress p2wkh | json address) || fail "payee newaddress"
btc generatetoaddress 101 "$PAYEE_ADDR" >/dev/null
synced() { [ "$(lncli "$1" getinfo | json synced_to_chain)" = "true" ]; }
wait_for "hub synced" synced hub
wait_for "payee synced" synced payee
funded() { [ "$(lncli payee walletbalance | json confirmed_balance)" -gt 0 ]; }
wait_for "payee coinbase" funded
HUB_PUBKEY=$(lncli hub getinfo | json identity_pubkey)
wait_for "payee -> hub connect" lncli payee connect "${HUB_PUBKEY}@ec-stress-lnd-hub:9735"
# 10M sat channel, 4M pushed to the hub: the hub can pay ~4M of payouts before top-ups refill it.
lncli payee openchannel --node_key "$HUB_PUBKEY" --local_amt 10000000 --push_amt 4000000 >/dev/null || fail "openchannel"
btc generatetoaddress 6 "$PAYEE_ADDR" >/dev/null
active() { [ "$(lncli "$1" listchannels --active_only | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).channels.length))')" -ge 1 ]; }
wait_for "payee channel active" active payee
wait_for "hub channel active" active hub

hexof() { docker exec "ec-stress-lnd-$1" cat /data/data/chain/bitcoin/regtest/admin.macaroon | od -An -v -tx1 | tr -d ' \n'; }
b64of() { docker exec "ec-stress-lnd-$1" cat /data/tls.cert | base64 | tr -d '\n'; }
export STRESS_HUB_MACAROON_HEX="$(hexof hub)" STRESS_HUB_TLS_CERT_BASE64="$(b64of hub)"
export PAYEE_MACAROON_HEX="$(hexof payee)" PAYEE_TLS_B64="$(b64of payee)"
{ echo "STRESS_HUB_MACAROON_HEX=$STRESS_HUB_MACAROON_HEX"; echo "STRESS_HUB_TLS_CERT_BASE64=$STRESS_HUB_TLS_CERT_BASE64"; } >> "$ENV_FILE"

# ── 3. application ───────────────────────────────────────────────────────────────────────
log "starting inference, portal and coordinators A and B"
pg_ready() { docker exec ec-stress-pg pg_isready -U edgecoder; }
wait_for "postgres" pg_ready
COORD_A="http://127.0.0.1:$STRESS_COORD_A_PORT"; COORD_B="http://127.0.0.1:$STRESS_COORD_B_PORT"
PORTAL="http://127.0.0.1:$STRESS_PORTAL_PORT"
stress_start_inference
stress_start_portal
stress_wait_healthy "$PORTAL/health" "$WAIT_SECS" || { docker logs --tail 60 ec-stress-portal >&2; fail "portal not healthy"; }
stress_start_coordinator a "$STRESS_COORD_A_PORT"
stress_start_coordinator b "$STRESS_COORD_B_PORT"
for c in a b; do
  port=$([ "$c" = a ] && echo "$STRESS_COORD_A_PORT" || echo "$STRESS_COORD_B_PORT")
  stress_wait_healthy "http://127.0.0.1:$port/health/runtime" "$WAIT_SECS" || { docker logs --tail 80 "ec-stress-coord-$c" >&2; fail "coord-$c not healthy"; }
done
peered() { curl -sf -H "x-mesh-token: $STRESS_MESH_TOKEN" "$1/mesh/peers" | grep -q "$2"; }
wait_for "coord-a to peer with coord-b" peered "$COORD_A" coord-b
wait_for "coord-b to peer with coord-a" peered "$COORD_B" coord-a
log "coordinators are peered"

# ── 4. accounts ──────────────────────────────────────────────────────────────────────────
post() { curl -sS --fail-with-body -X POST -H 'content-type: application/json' "$@"; }
psql_exec() { docker exec -i ec-stress-pg psql -v ON_ERROR_STOP=1 -q -U edgecoder -d edgecoder "$@"; }
ACCOUNTS_JSON="$RUN_DIR/accounts.ndjson"; : > "$ACCOUNTS_JSON"
make_account() {
  local role="$1" i="$2" email password signup user_id login session keyres key
  email="stress-${role}-${i}-$(rand 3)@example.com"
  password="$(rand 16)"
  signup=$(post -d "{\"email\":\"$email\",\"password\":\"$password\",\"displayName\":\"Stress $role $i\"}" "$PORTAL/auth/signup") || fail "signup: $signup"
  user_id=$(printf '%s' "$signup" | json userId) || fail "signup returned no userId"
  # The one shortcut, as in scripts/e2e/scale-nonroot.sh and tests/e2e/setup/global-setup.ts:
  # mark the email verified in SQL, standing in for clicking the emailed link (no email here).
  psql_exec -c "UPDATE portal_users SET email_verified = TRUE, verified_at_ms = $(date +%s)000 WHERE user_id = '$user_id';" || fail "verify $email"
  login=$(post -d "{\"email\":\"$email\",\"password\":\"$password\"}" "$PORTAL/auth/login") || fail "login: $login"
  session=$(printf '%s' "$login" | json sessionToken) || fail "no session"
  keyres=$(post -H "authorization: Bearer $session" -d '{"name":"stress"}' "$PORTAL/portal/api/keys") || fail "api key: $keyres"
  key=$(printf '%s' "$keyres" | json key) || fail "no key"
  printf '{"role":"%s","email":"%s","userId":"%s","accountId":"acct-%s","apiKey":"%s"}\n' "$role" "$email" "$user_id" "$user_id" "$key" >> "$ACCOUNTS_JSON"
}
log "creating $PROVIDERS provider and $BUYERS buyer accounts"
for i in $(seq 1 "$PROVIDERS"); do make_account provider "$i"; done
for i in $(seq 1 "$BUYERS"); do make_account buyer "$i"; done

# ── 5. credentials + target ──────────────────────────────────────────────────────────────
CREDS="$RUN_DIR/credentials.json"
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const [accountsPath, out] = process.argv.slice(1);
const e = process.env;
const accounts = readFileSync(accountsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const creds = {
  accounts,
  tokens: { admin: e.STRESS_ADMIN_TOKEN, portalService: e.STRESS_PORTAL_TOKEN, mesh: e.STRESS_MESH_TOKEN, metrics: e.STRESS_METRICS_TOKEN },
  lnd: {
    payee: { restUrl: `https://127.0.0.1:${e.STRESS_PAYEE_REST_PORT}`, macaroonHex: e.PAYEE_MACAROON_HEX, tlsCertBase64: e.PAYEE_TLS_B64 },
    hub: { restUrl: `https://127.0.0.1:${e.STRESS_HUB_REST_PORT}`, macaroonHex: e.STRESS_HUB_MACAROON_HEX, tlsCertBase64: e.STRESS_HUB_TLS_CERT_BASE64 }
  },
  postgresUrl: `postgresql://edgecoder:${e.STRESS_PG_PASSWORD}@127.0.0.1:${e.STRESS_PG_PORT}/edgecoder`
};
writeFileSync(out, JSON.stringify(creds, null, 2), { mode: 0o600 });
' "$ACCOUNTS_JSON" "$CREDS"
rm -f "$ACCOUNTS_JSON"
# Settings the invariant checker compares against (no secrets).
cat > "$RUN_DIR/stack-settings.json" <<JSON
{
  "earningsHoldMs": $STRESS_EARNINGS_HOLD_MS,
  "payoutMinSats": $STRESS_PAYOUT_MIN_SATS,
  "payoutMaxSingleSats": $STRESS_PAYOUT_MAX_SINGLE_SATS,
  "payoutMaxAccountDailySats": $STRESS_PAYOUT_MAX_ACCOUNT_DAILY_SATS,
  "payoutMaxGlobalDailySats": $STRESS_PAYOUT_MAX_GLOBAL_DAILY_SATS,
  "verificationRate": $STRESS_VERIFICATION_RATE
}
JSON
log "stack is up"
cat <<EOF
  coordinators : $COORD_A (coord-a)  $COORD_B (coord-b)
  portal       : $PORTAL
  postgres     : 127.0.0.1:$STRESS_PG_PORT (password in $ENV_FILE)
  credentials  : $CREDS (mode 600; API keys, tokens, LND payee/hub macaroons)
Run a scenario:
  npx tsx scripts/stress/run.ts --target scripts/stress/targets/local.json --scenario smoke
Tear down:
  scripts/stress/down.sh
EOF
