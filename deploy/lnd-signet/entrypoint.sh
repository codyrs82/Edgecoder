#!/usr/bin/env bash
# Mutinynet bitcoind + LND on one machine (see Dockerfile, README.md). Test coins only.
# Env (fly.toml): LND_ALIAS, LND_EXTERNAL_IP (optional), BITCOIN_PRUNE_MB, BITCOIN_DBCACHE_MB.
# No Fly secrets are needed.
#
# Volume layout (/data):
#   bitcoin/   bitcoind datadir (pruned); RPC by cookie, loopback only
#   lnd/       lnd datadir
#   secrets/   mode 700. wallet.pass (the unlock password) and seed.json (the 24-word seed), both
#              mode 600, generated on first boot. TEST NETWORK ONLY: on mainnet the seed never
#              touches a disk (deploy/lnd-mainnet). Nothing here is ever printed.
#   coordinator.macaroon   the coordinators' scoped macaroon, baked on first boot
set -euo pipefail
DATA=/data
APP=${FLY_APP_NAME:-edgecoder-lnd-signet}
SECRETS=$DATA/secrets
LND_DIR=$DATA/lnd
CHAIN_DIR=$LND_DIR/data/chain/bitcoin/signet
BTC_CONF=/etc/bitcoin-mutinynet.conf

# Volumes mount as root: hand them to the lightning user, then re-run this script as that user.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA"
  chown -R lightning:lightning "$DATA"
  exec setpriv --reuid=1000 --regid=1000 --init-groups "$0" "$@"
fi

umask 077
mkdir -p "$DATA/bitcoin" "$LND_DIR" "$SECRETS"
chmod 700 "$SECRETS"
log() { echo "[entrypoint] $*"; }
bcli() { bitcoin-cli -conf="$BTC_CONF" -datadir="$DATA/bitcoin" "$@"; }

pids=()
lnd_pid= btc_pid=
shutdown() {
  local code=${1:-0}
  log "stopping"
  [ -n "${lnd_pid:-}" ] && kill -TERM "$lnd_pid" 2>/dev/null && wait "$lnd_pid" 2>/dev/null || true
  [ -n "${btc_pid:-}" ] && kill -TERM "$btc_pid" 2>/dev/null && wait "$btc_pid" 2>/dev/null || true
  exit "$code"
}
trap 'shutdown 0' TERM INT

bitcoind -conf="$BTC_CONF" -datadir="$DATA/bitcoin" \
  -prune="${BITCOIN_PRUNE_MB:-4000}" -dbcache="${BITCOIN_DBCACHE_MB:-450}" &
btc_pid=$!
pids+=("$btc_pid")
# lnd exits if bitcoind's RPC is not answering when it starts.
until bcli getblockchaininfo >/dev/null 2>&1; do
  kill -0 "$btc_pid" 2>/dev/null || { log "bitcoind exited"; exit 1; }
  sleep 2
done
log "bitcoind RPC up"

# First boot: a random wallet password, kept on the volume (mode 600, never printed).
if [ ! -s "$SECRETS/wallet.pass" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '\n=+/' > "$SECRETS/wallet.pass"
  chmod 600 "$SECRETS/wallet.pass"
  log "generated wallet password (stored on the volume)"
fi

external=()
[ -n "${LND_EXTERNAL_IP:-}" ] && external=(--externalip="$LND_EXTERNAL_IP:9735")
# REST on [::]:8080: Fly's private network (6PN) only, since fly.toml defines no public service
# for 8080. gRPC on loopback (lnc). P2P 9735 ([::] is dual-stack, so IPv4 too) is public so
# peers and the faucet can reach us.
# --routing.assumechanvalid: bitcoind is pruned (BITCOIN_PRUNE_MB), so most Mutinynet channels'
# funding blocks are gone. Without this, lnd fetches each one from bitcoind's P2P peers to check
# gossip; those fetches never finish and block the gossiper, so even our own channels never reach
# the graph and every payment fails with "insufficient local balance". Test network only: never
# use this on mainnet with a pruned bitcoind (run an unpruned node there instead).
lnd --lnddir="$LND_DIR" --alias="${LND_ALIAS:-edgecoder-signet}" \
  --bitcoin.signet --bitcoin.node=bitcoind \
  --bitcoind.rpchost=127.0.0.1:38332 --bitcoind.rpccookie="$DATA/bitcoin/signet/.cookie" \
  --bitcoind.zmqpubrawblock=tcp://127.0.0.1:28332 --bitcoind.zmqpubrawtx=tcp://127.0.0.1:28333 \
  --bitcoind.estimatemode=ECONOMICAL \
  --listen=[::]:9735 --restlisten=[::]:8080 --rpclisten=127.0.0.1:10009 \
  --tlsextradomain="$APP.internal" --tlsextradomain="app.process.$APP.internal" --tlsextradomain=localhost \
  "${external[@]}" \
  --wallet-unlock-password-file="$SECRETS/wallet.pass" --wallet-unlock-allow-create \
  --protocol.wumbo-channels --protocol.option-scid-alias --accept-keysend \
  --maxpendingchannels=5 --db.bolt.auto-compact --routing.assumechanvalid &
lnd_pid=$!
pids+=("$lnd_pid")

# First boot: create the wallet over REST on loopback. The seed is written to the volume (mode
# 600) and the request body goes through a mode-600 temp file, so neither appears on a command
# line or in the logs.
init_wallet() {
  local cert=$LND_DIR/tls.cert
  until [ -f "$cert" ] && curl -sf --cacert "$cert" https://localhost:8080/v1/genseed -o /dev/null; do
    [ -f "$CHAIN_DIR/wallet.db" ] && return 0
    sleep 2
  done
  [ -f "$CHAIN_DIR/wallet.db" ] && return 0
  local tmp; tmp=$(mktemp -d)
  curl -sf --cacert "$cert" https://localhost:8080/v1/genseed -o "$tmp/genseed.json"
  jq -c .cipher_seed_mnemonic "$tmp/genseed.json" > "$SECRETS/seed.json"
  chmod 600 "$SECRETS/seed.json"
  jq -n --rawfile pass "$SECRETS/wallet.pass" --slurpfile seed "$SECRETS/seed.json" \
    '{wallet_password: ($pass | @base64), cipher_seed_mnemonic: $seed[0]}' > "$tmp/init.json"
  if curl -sf --cacert "$cert" -X POST https://localhost:8080/v1/initwallet -d @"$tmp/init.json" -o /dev/null; then
    log "wallet created (seed stored on the volume)"
  else
    log "wallet creation failed"
  fi
  rm -rf "$tmp"
}

# Bake the coordinators' macaroon once lnd's RPC is up: invoices, payments, balances, and the
# payment/invoice lookups reconciliation uses. Not admin.macaroon.
bake_macaroon() {
  [ -s "$DATA/coordinator.macaroon" ] && return 0
  until lncli --lnddir="$LND_DIR" --network=signet bakemacaroon --save_to "$DATA/coordinator.macaroon" \
      info:read invoices:read invoices:write offchain:read offchain:write onchain:read >/dev/null 2>&1; do
    kill -0 "$lnd_pid" 2>/dev/null || return 0
    sleep 10
  done
  chmod 600 "$DATA/coordinator.macaroon"
  log "baked coordinator.macaroon"
}

if [ ! -f "$CHAIN_DIR/wallet.db" ]; then init_wallet & fi
bake_macaroon &

# If either daemon exits, stop the other and exit so Fly restarts the machine.
wait -n "${pids[@]}" || true
log "a daemon exited; stopping the machine"
shutdown 1
