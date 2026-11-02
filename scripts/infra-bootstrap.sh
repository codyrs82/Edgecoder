#!/usr/bin/env bash
# EdgeCoder infrastructure node bootstrap (architecture step 5; docs/infra-node.md).
# Brings up deploy/infra/docker-compose.yml on this host and leaves it ready to earn from the
# network fee pool. Idempotent: run it again after editing deploy/infra/.env or to repair.
#
#   scripts/infra-bootstrap.sh --signet            # default chain; also --testnet | --mainnet
#   scripts/infra-bootstrap.sh --mainnet --prune 50000 --coordinator-url https://infra.example:4301 \
#       --account-id <portal account> --lightning-address you@infra.example --external-ip 203.0.113.9
#   scripts/infra-bootstrap.sh --with-electrs      # add the indexer profile (needs --prune 0)
#   scripts/infra-bootstrap.sh --no-up             # only write .env, configs and secrets
#
# What it does, in order:
#   1. checks docker compose v2, openssl and curl
#   2. writes deploy/infra/.env from .env.example (secrets generated with openssl; existing
#      values are kept, flags override)
#   3. renders deploy/infra/generated/{bitcoin.conf,lnd.conf} from the templates
#   4. creates deploy/infra/secrets/lnd-wallet-password (mode 600)
#   5. docker compose up -d --build
#   6. waits for bitcoind RPC and creates the anchor wallet
#   7. creates (or restores from deploy/infra/secrets/lnd-seed.txt) and unlocks the lnd wallet
#      through the REST WalletUnlocker, non-interactively
#   8. prints the coordinator URL, the lnd pubkey and the next steps
# Runs on Linux and macOS (bash 3.2, BSD or GNU sed/awk/base64; no GNU-only flags).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
INFRA_DIR="$REPO_ROOT/deploy/infra"
ENV_FILE="$INFRA_DIR/.env"
EXAMPLE_FILE="$INFRA_DIR/.env.example"
GEN_DIR="$INFRA_DIR/generated"
SECRETS_DIR="$INFRA_DIR/secrets"
WALLET_PW_FILE="$SECRETS_DIR/lnd-wallet-password"
SEED_FILE="$SECRETS_DIR/lnd-seed.txt"
MIN_PRUNE_MIB=550

log() { printf '[infra-bootstrap] %s\n' "$*"; }
warn() { printf '[infra-bootstrap] WARNING: %s\n' "$*" >&2; }
die() { printf '[infra-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --signet | --testnet | --mainnet   Chain (BITCOIN_NETWORK signet | testnet | bitcoin). Default: value in .env, else signet.
  --prune MIB                        0 keeps the full chain; otherwise >= 550 (BITCOIN_PRUNE).
  --with-electrs | --without-electrs Add or remove the "indexer" compose profile (COMPOSE_PROFILES).
  --coordinator-url URL              COORDINATOR_PUBLIC_URL (what agents and peers connect to).
  --account-id ID                    INFRA_HOST_ACCOUNT_ID (portal account that is paid).
  --lightning-address ADDR           INFRA_HOST_LIGHTNING_ADDRESS (user@domain payouts go to).
  --portal-token TOKEN               PORTAL_SERVICE_TOKEN issued by the portal operator.
  --registration-token TOKEN         COORDINATOR_REGISTRATION_TOKEN from the network operator.
  --external-ip HOST[:PORT]          LND_EXTERNAL_IP advertised for inbound channels.
  --alias NAME                       LND_ALIAS.
  --no-up                            Write .env, configs and secrets; do not start anything.
  --no-wallet                        Start the stack but skip the bitcoind/lnd wallet steps.
  -h, --help                         This text.
EOF
}

network="" prune="" electrs="" coordinator_url="" account_id="" lightning_address=""
portal_token="" registration_token="" external_ip="" alias="" no_up=0 no_wallet=0
value_of() { [ $# -ge 2 ] || die "$1 needs a value"; printf '%s' "$2"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --signet) network=signet ;;
    --testnet) network=testnet ;;
    --mainnet) network=bitcoin ;;
    --prune) prune=$(value_of "$@"); shift ;;
    --prune=*) prune="${1#*=}" ;;
    --with-electrs) electrs=yes ;;
    --without-electrs) electrs=no ;;
    --coordinator-url) coordinator_url=$(value_of "$@"); shift ;;
    --coordinator-url=*) coordinator_url="${1#*=}" ;;
    --account-id) account_id=$(value_of "$@"); shift ;;
    --account-id=*) account_id="${1#*=}" ;;
    --lightning-address) lightning_address=$(value_of "$@"); shift ;;
    --lightning-address=*) lightning_address="${1#*=}" ;;
    --portal-token) portal_token=$(value_of "$@"); shift ;;
    --portal-token=*) portal_token="${1#*=}" ;;
    --registration-token) registration_token=$(value_of "$@"); shift ;;
    --registration-token=*) registration_token="${1#*=}" ;;
    --external-ip) external_ip=$(value_of "$@"); shift ;;
    --external-ip=*) external_ip="${1#*=}" ;;
    --alias) alias=$(value_of "$@"); shift ;;
    --alias=*) alias="${1#*=}" ;;
    --no-up) no_up=1 ;;
    --no-wallet) no_wallet=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# ---- 1. prerequisites --------------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required: $2"; }
need docker "install Docker Engine (Linux) or Docker Desktop (macOS)"
need openssl "used to generate secrets and the bitcoind rpcauth line"
need curl "used to talk to the lnd REST API on ${LND_REST_BIND:-127.0.0.1:8080}"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required (the 'docker compose' plugin, not docker-compose v1)"
if [ "$no_up" -eq 0 ]; then
  docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable (is it running, and can this user use it?)"
fi
[ -f "$EXAMPLE_FILE" ] || die "missing $EXAMPLE_FILE"
[ -f "$INFRA_DIR/docker-compose.yml" ] || die "missing $INFRA_DIR/docker-compose.yml"

# ---- 2. .env -----------------------------------------------------------------------------
# KEY=value lines, no quoting, no `$` (docker compose would interpolate it). Comments are kept.
get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    awk -v k="$1" -v v="$2" 'BEGIN { FS = "=" } $1 == k && !done { print k "=" v; done = 1; next } { print }' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
set_if_given() { [ -n "$2" ] && set_env "$1" "$2" || true; }
ensure_secret() { # name bytes
  if [ -z "$(get_env "$1")" ]; then
    set_env "$1" "$(openssl rand -hex "$2")"
    log "generated $1"
  fi
}
check_clean() { # name value: single line, no $
  case "$2" in
    *'$'*) die "$1 must not contain '\$' (docker compose interpolates it)" ;;
    *' '*) die "$1 must not contain spaces" ;;
  esac
}

umask 077
if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  log "created $ENV_FILE from .env.example"
fi
chmod 600 "$ENV_FILE"

set_if_given BITCOIN_NETWORK "$network"
network=$(get_env BITCOIN_NETWORK)
[ -n "$network" ] || { network=signet; set_env BITCOIN_NETWORK signet; }
case "$network" in
  bitcoin) chain=main; lnd_network=mainnet; p2p_port=8333 ;;
  testnet) chain=test; lnd_network=testnet; p2p_port=18333 ;;
  signet) chain=signet; lnd_network=signet; p2p_port=38333 ;;
  *) die "BITCOIN_NETWORK must be bitcoin, testnet or signet (got '$network')" ;;
esac
set_env BITCOIN_CHAIN "$chain"
set_env LND_NETWORK "$lnd_network"
set_env BITCOIN_P2P_PORT "$p2p_port"

set_if_given BITCOIN_PRUNE "$prune"
prune=$(get_env BITCOIN_PRUNE)
[ -n "$prune" ] || { prune=0; set_env BITCOIN_PRUNE 0; }
case "$prune" in
  ''|*[!0-9]*) die "BITCOIN_PRUNE must be 0 or a whole number of MiB (got '$prune')" ;;
esac
if [ "$prune" -ne 0 ] && [ "$prune" -lt "$MIN_PRUNE_MIB" ]; then
  die "BITCOIN_PRUNE must be 0 (full node) or at least $MIN_PRUNE_MIB MiB (got $prune)"
fi
dbcache=$(get_env BITCOIN_DBCACHE)
[ -n "$dbcache" ] || { dbcache=2000; set_env BITCOIN_DBCACHE 2000; }
case "$dbcache" in ''|*[!0-9]*) die "BITCOIN_DBCACHE must be a whole number of MiB" ;; esac

case "$electrs" in
  yes) profiles=indexer ;;
  no) profiles="" ;;
  *) profiles=$(get_env COMPOSE_PROFILES) ;;
esac
services="coordinator,bitcoind,lightning"
case ",$profiles," in
  *,indexer,*)
    [ "$prune" -eq 0 ] || die "the indexer profile (electrs) needs an unpruned node: use --prune 0 or --without-electrs"
    services="$services,electrs" ;;
  ,,) ;;
  *) die "COMPOSE_PROFILES may only contain 'indexer' (got '$profiles')" ;;
esac
set_env COMPOSE_PROFILES "$profiles"
set_env INFRA_HOST_SERVICES "$services"

set_if_given COORDINATOR_PUBLIC_URL "$coordinator_url"
set_if_given INFRA_HOST_ACCOUNT_ID "$account_id"
set_if_given INFRA_HOST_LIGHTNING_ADDRESS "$lightning_address"
set_if_given PORTAL_SERVICE_TOKEN "$portal_token"
set_if_given COORDINATOR_REGISTRATION_TOKEN "$registration_token"
set_if_given LND_EXTERNAL_IP "$external_ip"
set_if_given LND_ALIAS "$alias"
for name in BITCOIND_RPC_USER BITCOIND_WALLET_NAME LND_ALIAS LND_EXTERNAL_IP LND_REST_BIND ELECTRS_BIND \
            POSTGRES_USER POSTGRES_DB COORDINATOR_PUBLIC_URL PORTAL_SERVICE_URL INFRA_HOST_ACCOUNT_ID \
            INFRA_HOST_LIGHTNING_ADDRESS COORDINATOR_BOOTSTRAP_URLS; do
  check_clean "$name" "$(get_env "$name")"
done

ensure_secret BITCOIND_RPC_PASSWORD 24
ensure_secret BITCOIND_RPCAUTH_SALT 16
ensure_secret POSTGRES_PASSWORD 24
ensure_secret MESH_AUTH_TOKEN 32
ensure_secret ADMIN_API_TOKEN 32
ensure_secret INFERENCE_AUTH_TOKEN 32
ensure_secret PAYMENT_WEBHOOK_SECRET 32

coordinator_url=$(get_env COORDINATOR_PUBLIC_URL)
case "$coordinator_url" in
  *CHANGE-ME*|'') warn "COORDINATOR_PUBLIC_URL is not set; pass --coordinator-url https://<your host>:4301 (agents and peers need it)" ;;
esac
[ -n "$(get_env INFRA_HOST_ACCOUNT_ID)" ] || warn "INFRA_HOST_ACCOUNT_ID is empty: this host will heartbeat but cannot be paid (--account-id)"
[ -n "$(get_env PORTAL_SERVICE_TOKEN)" ] || warn "PORTAL_SERVICE_TOKEN is empty: the coordinator refuses to start in production without it (--portal-token)"

# ---- 3. render bitcoin.conf and lnd.conf ---------------------------------------------------
# rpcauth = user:salt$HMAC_SHA256(key = salt, msg = password), the same as share/rpcauth/rpcauth.py.
rpc_user=$(get_env BITCOIND_RPC_USER)
rpc_pass=$(get_env BITCOIND_RPC_PASSWORD)
rpc_salt=$(get_env BITCOIND_RPCAUTH_SALT)
rpc_hmac=$(printf '%s' "$rpc_pass" | openssl dgst -sha256 -hmac "$rpc_salt" | awk '{ print $NF }')
rpcauth="$rpc_user:$rpc_salt\$$rpc_hmac"
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
render() { # template destination [NAME=value ...]
  local tpl="$1" dest="$2" expr=""
  shift 2
  for kv in "$@"; do
    expr="$expr -e s|__${kv%%=*}__|$(sed_escape "${kv#*=}")|g"
  done
  # shellcheck disable=SC2086
  sed $expr "$tpl" > "$dest.tmp"
  chmod 600 "$dest.tmp"
  mv "$dest.tmp" "$dest"
}
mkdir -p "$GEN_DIR" "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
ext_ip=$(get_env LND_EXTERNAL_IP)
if [ -n "$ext_ip" ]; then ext_line="externalip=$ext_ip"; else ext_line="# externalip: LND_EXTERNAL_IP is empty, nothing advertised"; fi
render "$INFRA_DIR/bitcoin.conf.template" "$GEN_DIR/bitcoin.conf" \
  "BITCOIN_CHAIN=$chain" "BITCOIN_PRUNE=$prune" "BITCOIN_DBCACHE=$dbcache" "BITCOIND_RPCAUTH=$rpcauth"
render "$INFRA_DIR/lnd.conf.template" "$GEN_DIR/lnd.conf" \
  "LND_ALIAS=$(get_env LND_ALIAS)" "LND_NETWORK=$lnd_network" "LND_EXTERNALIP_LINE=$ext_line" \
  "BITCOIND_RPC_USER=$rpc_user" "BITCOIND_RPC_PASSWORD=$rpc_pass"
if grep -q '__[A-Z_]*__' "$GEN_DIR/bitcoin.conf" "$GEN_DIR/lnd.conf"; then
  die "unreplaced placeholder in $GEN_DIR: $(grep -o '__[A-Z_]*__' "$GEN_DIR"/*.conf | tr '\n' ' ')"
fi
log "rendered $GEN_DIR/bitcoin.conf and $GEN_DIR/lnd.conf (network $network, prune $prune, profiles '${profiles:-none}')"

# ---- 4. lnd wallet password ----------------------------------------------------------------
if [ ! -s "$WALLET_PW_FILE" ]; then
  openssl rand -hex 24 | tr -d '\n' > "$WALLET_PW_FILE"
  log "created $WALLET_PW_FILE"
fi
chmod 600 "$WALLET_PW_FILE"

if [ "$no_up" -eq 1 ]; then
  log "--no-up: configuration written. Start with: docker compose -f $INFRA_DIR/docker-compose.yml up -d --build"
  exit 0
fi

# ---- 5. start the stack --------------------------------------------------------------------
compose() { docker compose --project-directory "$INFRA_DIR" -f "$INFRA_DIR/docker-compose.yml" "$@"; }
log "docker compose up -d --build (first build takes a few minutes)"
compose up -d --build

# wait LABEL SECONDS COMMAND...: retries every 5 s until the command succeeds; 1 on timeout.
wait_for() {
  local label="$1" limit="$2" waited=0
  shift 2
  until "$@" >/dev/null 2>&1; do
    if [ "$waited" -ge "$limit" ]; then return 1; fi
    if [ $((waited % 30)) -eq 0 ]; then log "waiting for $label (${waited}s)"; fi
    sleep 5
    waited=$((waited + 5))
  done
  return 0
}

if [ "$no_wallet" -eq 1 ]; then
  log "--no-wallet: stack started; wallet steps skipped"
  exit 0
fi

# ---- 6. bitcoind RPC and the anchor wallet -------------------------------------------------
bcli() { compose exec -T bitcoind bitcoin-cli -conf=/etc/bitcoin/bitcoin.conf -datadir=/data "$@"; }
wait_for "bitcoind RPC" 600 bcli getblockchaininfo || die "bitcoind RPC did not come up; see: docker compose -f $INFRA_DIR/docker-compose.yml logs bitcoind"
wallet=$(get_env BITCOIND_WALLET_NAME)
if bcli listwallets 2>/dev/null | grep -q "\"$wallet\""; then
  log "anchor wallet '$wallet' is loaded"
elif bcli -named createwallet wallet_name="$wallet" load_on_startup=true >/dev/null 2>&1; then
  log "created anchor wallet '$wallet' (loads on every start)"
elif bcli -named loadwallet filename="$wallet" load_on_startup=true >/dev/null 2>&1; then
  log "loaded existing anchor wallet '$wallet'"
else
  die "could not create or load bitcoind wallet '$wallet'"
fi
blocks=$(bcli getblockchaininfo 2>/dev/null | sed -n 's/^ *"blocks": *\([0-9]*\),*$/\1/p')
progress=$(bcli getblockchaininfo 2>/dev/null | sed -n 's/^ *"verificationprogress": *\([0-9.]*\),*$/\1/p')
log "bitcoind: chain $chain, blocks ${blocks:-?}, verification progress ${progress:-?}"

# ---- 7. lnd wallet (REST WalletUnlocker, no prompts) ------------------------------------------
rest_bind=$(get_env LND_REST_BIND)
case "$rest_bind" in 0.0.0.0:*|'[::]':*|:*) rest_bind="127.0.0.1:${rest_bind##*:}" ;; esac
rest="https://$rest_bind"
lnd_state() { curl -sk --max-time 5 "$rest/v1/state" 2>/dev/null | sed -n 's/.*"state": *"\([A-Z_]*\)".*/\1/p'; }
lnd_rest_up() { [ -n "$(lnd_state)" ]; }
wait_for "lnd REST on $rest" 300 lnd_rest_up || die "lnd REST did not answer on $rest; see: docker compose -f $INFRA_DIR/docker-compose.yml logs lnd"
state=$(lnd_state)
log "lnd wallet state: $state"
wallet_pw_b64=$(printf '%s' "$(cat "$WALLET_PW_FILE")" | base64 | tr -d '\n')
post_json() { curl -sk --max-time 120 -X POST -H 'content-type: application/json' --data "$2" "$rest$1"; }

if [ "$state" = "NON_EXISTING" ]; then
  recovery=""
  if [ -s "$SEED_FILE" ]; then
    words=$(tr -s ' \n' '  ' < "$SEED_FILE" | sed 's/^ *//; s/ *$//')
    recovery=',"recovery_window":2500'
    log "restoring the lnd wallet from $SEED_FILE (recovery window 2500)"
  else
    seed_json=$(curl -sk --max-time 30 "$rest/v1/genseed")
    words=$(printf '%s' "$seed_json" | sed -n 's/.*"cipher_seed_mnemonic": *\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ' | sed 's/^ *//; s/ *$//')
    [ "$(printf '%s\n' "$words" | wc -w | tr -d ' ')" = "24" ] || die "genseed did not return a 24-word seed: $seed_json"
    printf '%s\n' "$words" > "$SEED_FILE"
    chmod 600 "$SEED_FILE"
    log "lnd seed written to $SEED_FILE (mode 600). BACK IT UP OFFLINE: it is the only way to recover funds."
  fi
  words_json=$(printf '%s\n' "$words" | awk '{ for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i > 1 ? "," : ""), $i }')
  resp=$(post_json /v1/initwallet "{\"wallet_password\":\"$wallet_pw_b64\",\"cipher_seed_mnemonic\":[$words_json]$recovery}")
  printf '%s' "$resp" | grep -q '"admin_macaroon"' || die "lnd initwallet failed: $resp"
  log "lnd wallet created; it unlocks itself from $WALLET_PW_FILE on every start"
elif [ "$state" = "LOCKED" ]; then
  resp=$(post_json /v1/unlockwallet "{\"wallet_password\":\"$wallet_pw_b64\"}")
  [ "$resp" = "{}" ] || die "lnd unlockwallet failed (is $WALLET_PW_FILE the password this wallet was created with?): $resp"
  log "lnd wallet unlocked"
fi

lnd_ready() { case "$(lnd_state)" in RPC_ACTIVE|SERVER_ACTIVE) return 0 ;; *) return 1 ;; esac; }
if ! wait_for "lnd RPC (waits for bitcoind to sync)" 180 lnd_ready; then
  warn "lnd is still waiting for the chain backend (state $(lnd_state)); it will finish on its own once bitcoind is synced"
fi
lncli_() { compose exec -T lnd lncli --lnddir=/data/lnd --network="$lnd_network" "$@"; }
pubkey=$(lncli_ getinfo 2>/dev/null | sed -n 's/^ *"identity_pubkey": *"\([0-9a-f]*\)".*/\1/p' | head -n 1)

# ---- 8. summary ---------------------------------------------------------------------------
coordinator_ok=no
if wait_for "coordinator /health/runtime" 120 curl -sf --max-time 5 http://127.0.0.1:4301/health/runtime; then coordinator_ok=yes; fi
cat <<EOF

================================================================================
EdgeCoder infrastructure node: $network ($services)
  compose project : $INFRA_DIR/docker-compose.yml
  coordinator     : $coordinator_url  (local health: http://127.0.0.1:4301/health/runtime, up: $coordinator_ok)
  lnd pubkey      : ${pubkey:-not available yet: docker compose -f $INFRA_DIR/docker-compose.yml exec lnd lncli --lnddir=/data/lnd --network=$lnd_network getinfo}
  lnd P2P         : ${ext_ip:-<LND_EXTERNAL_IP unset>}:9735
  secrets         : $ENV_FILE, $WALLET_PW_FILE, $SEED_FILE (back the seed up offline)

Next steps
  1. Firewall: allow inbound TCP $p2p_port (bitcoind), 9735 (lnd) and 4301 (coordinator, ideally behind TLS on 443).
     Everything else (RPC, ZMQ, REST, Postgres, ports 4302/4303) stays on this host.
  2. Fund lnd and open a channel to a well-connected peer:
       docker compose -f $INFRA_DIR/docker-compose.yml exec lnd lncli --lnddir=/data/lnd --network=$lnd_network newaddress p2tr
       docker compose -f $INFRA_DIR/docker-compose.yml exec lnd lncli --lnddir=/data/lnd --network=$lnd_network openchannel --node_key <pubkey> --connect <host:9735> --local_amt 1000000
  3. Set INFRA_HOST_ACCOUNT_ID (portal account) and INFRA_HOST_LIGHTNING_ADDRESS (user@domain,
     e.g. served by this lnd) in $ENV_FILE, then flip ECONOMY_PAYMENTS_ENABLED=true and re-run this script.
     The coordinator heartbeats "$services" to the fee pool; payouts need both values.
  4. Logs: docker compose -f $INFRA_DIR/docker-compose.yml logs -f edgecoder lnd bitcoind
================================================================================
EOF
