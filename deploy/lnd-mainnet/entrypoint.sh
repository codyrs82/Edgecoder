#!/usr/bin/env bash
# Usage: entrypoint.sh lnd | bitcoind
#
# BITCOIND_MODE picks LND's chain backend (README.md):
#   external (default)  an existing, unpruned Bitcoin Core outside this app (ocean-node, reached
#                       over Fly's private network as a WireGuard peer). No bitcoind runs here.
#                       Secrets: BITCOIND_RPC_USER, BITCOIND_RPC_PASS, LND_WALLET_PASS.
#                       Env: BITCOIND_HOST (6PN address or name), BITCOIND_RPC_PORT (8332),
#                       BITCOIND_ZMQ_BLOCK, BITCOIND_ZMQ_TX (default tcp://[host]:28332 / :28333),
#                       BITCOIND_ESTIMATEMODE (ECONOMICAL), BITCOIND_LABEL (ocean-node, for logs).
#   bundled             the fallback: the pruned Bitcoin Core in this app's `bitcoind` process
#                       group (fly.bundled.toml). Secrets: BTC_RPC_PASS, LND_WALLET_PASS.
#                       Env: BITCOIN_PRUNE_MB, BITCOIN_DBCACHE_MB.
# Both: LND_ALIAS, LND_EXTERNAL_IP (optional).
#
# The wallet is never created here. On first boot lnd waits for `lnc create`, run by the
# operator over `fly ssh console`, so the 24-word seed is shown on their terminal only and is
# never written to the volume, the logs or anywhere else.
set -euo pipefail
DATA=/data
APP=${FLY_APP_NAME:-edgecoder-lnd}
MODE=${BITCOIND_MODE:-external}
# Where the generated config and password files go: the machine's rootfs, gone on restart.
# Overridable for tests only.
RUN=${LND_RUN_DIR:-/tmp}

# Volumes mount as root: hand them to the lightning user, then re-run this script as that user.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA"
  chown -R lightning:lightning "$DATA"
  exec setpriv --reuid=1000 --regid=1000 --init-groups "$0" "$@"
fi

# Passwords go into config files in $RUN (machine rootfs, gone on restart), never onto a command
# line (where `ps`, Fly's deploy output and crash reports would show them), into the logs or onto
# the volume.
umask 077

# getblockchaininfo -> one log line (no credentials in it).
SUMMARY='.result | "chain=\(.chain) blocks=\(.blocks) headers=\(.headers) initialblockdownload=\(.initialblockdownload) pruned=\(.pruned)"'

log() { echo "entrypoint: $*" >&2; }

# A value written into an INI-style config line must be a single line.
one_line() {
  case "$2" in *$'\n'* | *$'\r'*) log "$1 must be a single line"; exit 1 ;; esac
}

# host -> what goes before ":port" in a URL: IPv6 literals get brackets, names and IPv4 do not.
bracket() {
  local h=${1#[}; h=${h%]}
  case "$h" in *:*) printf '[%s]' "$h" ;; *) printf '%s' "$h" ;; esac
}

# tcp_open host port: can we open a TCP connection (5 s limit)? host without brackets.
tcp_open() {
  local t=()
  command -v timeout > /dev/null && t=(timeout 5)
  ${t[@]+"${t[@]}"} bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2> /dev/null
}

# tcp://[h]:p or tcp://h:p -> "h p" (h without brackets).
split_url() {
  local hp=${1#tcp://} h p
  p=${hp##*:}; h=${hp%:*}; h=${h#[}; h=${h%]}
  printf '%s %s' "$h" "$p"
}

# One authenticated JSON-RPC call. The credentials go to curl in a config file, not argv.
# Prints the HTTP status, and leaves the body in $RUN/rpc.json.
rpc() {
  local esc_user esc_pass
  esc_user=$(printf '%s' "$BITCOIND_RPC_USER" | sed 's/[\\"]/\\&/g')
  esc_pass=$(printf '%s' "$BITCOIND_RPC_PASS" | sed 's/[\\"]/\\&/g')
  printf 'user = "%s:%s"\n' "$esc_user" "$esc_pass" > "$RUN/curl-rpc.conf"
  curl -sS -o "$RUN/rpc.json" -w '%{http_code}' --max-time 10 -K "$RUN/curl-rpc.conf" \
    -H 'content-type: text/plain' \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"edgecoder-lnd\",\"method\":\"$1\",\"params\":[]}" \
    "http://$RPC_HOSTPORT/" 2> /dev/null || true
}

# Block until the external node answers getblockchaininfo with our credentials, logging why not.
wait_for_backend() {
  local label=${BITCOIND_LABEL:-ocean-node} every=${BITCOIND_WAIT_INTERVAL:-10} code chain summary
  local rpc_h=${RPC_HOSTPORT%:*} rpc_p=${RPC_HOSTPORT##*:}
  rpc_h=${rpc_h#[}; rpc_h=${rpc_h%]}
  while :; do
    if ! tcp_open "$rpc_h" "$rpc_p"; then
      log "waiting for $label RPC at $RPC_HOSTPORT (not reachable; is the WireGuard peer up?)"
    else
      code=$(rpc getblockchaininfo)
      case "$code" in
        200) break ;;
        401) log "waiting for $label RPC at $RPC_HOSTPORT: it rejected BITCOIND_RPC_USER/BITCOIND_RPC_PASS (401)" ;;
        403) log "waiting for $label RPC at $RPC_HOSTPORT: getblockchaininfo is not in this user's rpcwhitelist (403)" ;;
        *) log "waiting for $label RPC at $RPC_HOSTPORT: getblockchaininfo answered HTTP ${code:-none}" ;;
      esac
    fi
    sleep "$every"
  done
  chain=$(jq -r '.result.chain' "$RUN/rpc.json")
  if [ "$chain" != main ]; then
    log "$label at $RPC_HOSTPORT is on chain '$chain', not mainnet; refusing to start lnd"
    exit 1
  fi
  summary=$(jq -r "$SUMMARY" "$RUN/rpc.json")
  log "$label RPC at $RPC_HOSTPORT is up: $summary"
  [ "$(jq -r '.result.pruned' "$RUN/rpc.json")" = false ] \
    || log "WARNING: $label is pruned; external mode expects an unpruned node (README.md)"
  rm -f "$RUN/rpc.json"
  local url hp
  for url in "$ZMQ_BLOCK" "$ZMQ_TX"; do
    hp=$(split_url "$url")
    # shellcheck disable=SC2086 # "host port"
    tcp_open $hp || log "WARNING: $label ZMQ at $url is not reachable; lnd needs it for new blocks and transactions"
  done
}

lnd_common=(
  --lnddir="$DATA" --alias="${LND_ALIAS:-edgecoder}"
  --bitcoin.mainnet --bitcoin.node=bitcoind
)
lnd_tail() {
  local host="lnd.process.$APP.internal" external=()
  [ -n "${LND_EXTERNAL_IP:-}" ] && external=(--externalip="$LND_EXTERNAL_IP:9735")
  LND_TAIL=(
    --listen=0.0.0.0:9735 --restlisten=[::]:8080 --rpclisten=[::]:10009
    --tlsextradomain="$host" --tlsextradomain=localhost ${external[@]+"${external[@]}"}
    --wallet-unlock-password-file="$RUN/wallet.pass" --wallet-unlock-allow-create
    --minchansize=100000 --coop-close-target-confs=6
  )
}

case "$MODE" in
  external | bundled) ;;
  *) log "BITCOIND_MODE must be external or bundled, not '$MODE'"; exit 2 ;;
esac

case "${1:-}" in
  bitcoind)
    if [ "$MODE" != bundled ]; then
      log "BITCOIND_MODE=$MODE: this app runs no bitcoind (deploy fly.bundled.toml for the bundled node)"
      exit 2
    fi
    : "${BTC_RPC_PASS:?BTC_RPC_PASS is not set (fly secrets set -a $APP BTC_RPC_PASS=...)}"
    # RPC and ZMQ listen on Fly's private network only (no public service is defined for them),
    # and RPC accepts only loopback (bitcoin-cli in the machine) and 6PN addresses. P2P is
    # outbound only.
    printf 'rpcuser=edgecoder\nrpcpassword=%s\n' "$BTC_RPC_PASS" > "$RUN/bitcoin.conf"
    exec bitcoind -conf="$RUN/bitcoin.conf" -datadir="$DATA" -printtoconsole -server \
      -prune="${BITCOIN_PRUNE_MB:-50000}" -dbcache="${BITCOIN_DBCACHE_MB:-2000}" \
      -rpcbind=127.0.0.1 -rpcbind=[::] -rpcallowip=127.0.0.1 -rpcallowip=fdaa::/16 \
      -zmqpubrawblock=tcp://[::]:28332 -zmqpubrawtx=tcp://[::]:28333 \
      -listen=0 -discover=0
    ;;
  lnd)
    : "${LND_WALLET_PASS:?LND_WALLET_PASS is not set (deploy/lnd-mainnet/README.md, step 2)}"
    lnd_tail
    if [ "$MODE" = bundled ]; then
      : "${BTC_RPC_PASS:?BTC_RPC_PASS is not set (fly secrets set -a $APP BTC_RPC_PASS=...)}"
      btc="bitcoind.process.$APP.internal"
      # The unlock password and the bitcoind RPC password live in $RUN, not on the volume, so a
      # volume snapshot carries neither.
      printf '%s' "$LND_WALLET_PASS" > "$RUN/wallet.pass"
      printf '[Bitcoind]\nbitcoind.rpcuser=edgecoder\nbitcoind.rpcpass=%s\n' "$BTC_RPC_PASS" > "$RUN/lnd.conf"
      exec lnd --configfile="$RUN/lnd.conf" "${lnd_common[@]}" \
        --bitcoind.rpchost="$btc:8332" \
        --bitcoind.zmqpubrawblock="tcp://$btc:28332" --bitcoind.zmqpubrawtx="tcp://$btc:28333" \
        --bitcoind.estimatemode=ECONOMICAL \
        "${LND_TAIL[@]}"
    fi
    # External: every bitcoind.* setting goes into the config file, none onto the command line.
    : "${BITCOIND_HOST:?BITCOIND_HOST is not set (fly.toml [env]: the 6PN address or name of ocean-node)}"
    : "${BITCOIND_RPC_USER:?BITCOIND_RPC_USER is not set (fly secrets set -a $APP --stage BITCOIND_RPC_USER=...)}"
    : "${BITCOIND_RPC_PASS:?BITCOIND_RPC_PASS is not set (fly secrets set -a $APP --stage BITCOIND_RPC_PASS=...)}"
    case "$BITCOIND_HOST" in REPLACE*) log "BITCOIND_HOST is still the fly.toml placeholder; set ocean-node's 6PN address"; exit 2 ;; esac
    h=$(bracket "$BITCOIND_HOST")
    RPC_HOSTPORT="$h:${BITCOIND_RPC_PORT:-8332}"
    ZMQ_BLOCK=${BITCOIND_ZMQ_BLOCK:-tcp://$h:28332}
    ZMQ_TX=${BITCOIND_ZMQ_TX:-tcp://$h:28333}
    ESTIMATE=${BITCOIND_ESTIMATEMODE:-ECONOMICAL}
    for v in BITCOIND_HOST BITCOIND_RPC_PORT BITCOIND_ZMQ_BLOCK BITCOIND_ZMQ_TX BITCOIND_ESTIMATEMODE BITCOIND_RPC_USER BITCOIND_RPC_PASS; do
      one_line "$v" "${!v:-}"
    done
    case "$ESTIMATE" in ECONOMICAL | CONSERVATIVE) ;; *) log "BITCOIND_ESTIMATEMODE must be ECONOMICAL or CONSERVATIVE"; exit 2 ;; esac
    wait_for_backend
    printf '%s' "$LND_WALLET_PASS" > "$RUN/wallet.pass"
    {
      printf '[Bitcoind]\n'
      printf 'bitcoind.rpchost=%s\n' "$RPC_HOSTPORT"
      printf 'bitcoind.rpcuser=%s\n' "$BITCOIND_RPC_USER"
      printf 'bitcoind.rpcpass=%s\n' "$BITCOIND_RPC_PASS"
      printf 'bitcoind.zmqpubrawblock=%s\n' "$ZMQ_BLOCK"
      printf 'bitcoind.zmqpubrawtx=%s\n' "$ZMQ_TX"
      printf 'bitcoind.estimatemode=%s\n' "$ESTIMATE"
    } > "$RUN/lnd.conf"
    rm -f "$RUN/curl-rpc.conf"
    log "starting lnd with the external backend at $RPC_HOSTPORT"
    # An unpruned backend serves every historical block, so none of the pruned-node settings
    # (routing.assumechanvalid and the like) are set.
    exec lnd --configfile="$RUN/lnd.conf" "${lnd_common[@]}" "${LND_TAIL[@]}"
    ;;
  *) echo "usage: $0 lnd | bitcoind" >&2; exit 2 ;;
esac
