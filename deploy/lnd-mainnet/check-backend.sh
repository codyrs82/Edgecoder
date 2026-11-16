#!/usr/bin/env bash
# Pre-flight for external mode: can the lnd machine reach ocean-node's RPC and ZMQ ports, and does
# the limited RPC user work? Prints no credentials.
#
# From the repo root (runs itself inside the lnd machine over `fly ssh console`):
#   deploy/lnd-mainnet/check-backend.sh                  # uses the machine's BITCOIND_* env
#   deploy/lnd-mainnet/check-backend.sh --host fdaa:...  # before the deploy: ports only
# Inside the machine (the image installs it as check-backend):
#   check-backend [--host H] [--rpc-port P] [--zmq-block URL] [--zmq-tx URL]
#
# Before the external-mode deploy the running machine has neither the BITCOIND_* env nor the
# staged secrets, so only the ports are checked; after it, the RPC user is checked too.
set -euo pipefail

if [ -z "${FLY_MACHINE_ID:-}" ] && [ -z "${CHECK_BACKEND_IN_MACHINE:-}" ] && ! command -v lnd > /dev/null; then
  # On the operator's laptop: ship this script to the lnd machine and run it there with the same
  # arguments. base64 keeps it intact through fly ssh's command line.
  A=${APP:-edgecoder-lnd}
  machine=$(fly machines list -a "$A" --json | jq -r '.[] | select(.config.metadata.fly_process_group=="lnd") | .id')
  [ -n "$machine" ] || { echo "no lnd machine in $A" >&2; exit 1; }
  b64=$(base64 < "$0" | tr -d '\n')
  args=""
  for a in "$@"; do
    case "$a" in *[!A-Za-z0-9.:/_\[\]-]*) echo "unexpected characters in argument: $a" >&2; exit 2 ;; esac
    args="$args $a"
  done
  exec fly ssh console -a "$A" --machine "$machine" -q \
    -C "bash -c 'echo $b64 | base64 -d > /tmp/check-backend.sh && CHECK_BACKEND_IN_MACHINE=1 bash /tmp/check-backend.sh$args'"
fi

host=${BITCOIND_HOST:-} rpc_port=${BITCOIND_RPC_PORT:-8332}
zmq_block=${BITCOIND_ZMQ_BLOCK:-} zmq_tx=${BITCOIND_ZMQ_TX:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host=$2; zmq_block=; zmq_tx=; shift 2 ;;
    --rpc-port) rpc_port=$2; shift 2 ;;
    --zmq-block) zmq_block=$2; shift 2 ;;
    --zmq-tx) zmq_tx=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$host" ] || { echo "no host: set BITCOIND_HOST in fly.toml or pass --host" >&2; exit 2; }

bare=${host#[}; bare=${bare%]}
case "$bare" in *:*) h="[$bare]" ;; *) h=$bare ;; esac
zmq_block=${zmq_block:-tcp://$h:28332}
zmq_tx=${zmq_tx:-tcp://$h:28333}

fail=0
ok() { echo "  ok    $*"; }
bad() { echo "  FAIL  $*"; fail=1; }

tcp_open() { timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2> /dev/null; }
check_port() { # label host port
  if tcp_open "$2" "$3"; then ok "$1 reachable"; else bad "$1 not reachable (WireGuard peer down, wrong address, or bound elsewhere)"; fi
}
url_check() { # label tcp://host:port
  local hp=${2#tcp://} hh p
  p=${hp##*:}; hh=${hp%:*}; hh=${hh#[}; hh=${hh%]}
  check_port "$1 $2" "$hh" "$p"
}

echo "backend: $h"
echo "dns:"
if [[ "$bare" == *:* || "$bare" =~ ^[0-9.]+$ ]]; then
  ok "$bare is an address literal"
elif getent ahosts "$bare" > /dev/null 2>&1; then
  ok "$bare resolves to $(getent ahosts "$bare" | awk 'NR==1{print $1}')"
else
  bad "$bare does not resolve"
fi
echo "ports:"
check_port "RPC $h:$rpc_port" "$bare" "$rpc_port"
url_check "ZMQ rawblock" "$zmq_block"
url_check "ZMQ rawtx" "$zmq_tx"

echo "rpc (limited user):"
if [ -z "${BITCOIND_RPC_USER:-}" ] || [ -z "${BITCOIND_RPC_PASS:-}" ]; then
  echo "  skip  BITCOIND_RPC_USER/BITCOIND_RPC_PASS are not in this machine's env yet (staged secrets arrive with the deploy)"
else
  dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
  ( umask 077
    printf 'user = "%s:%s"\n' "$(printf '%s' "$BITCOIND_RPC_USER" | sed 's/[\\"]/\\&/g')" \
      "$(printf '%s' "$BITCOIND_RPC_PASS" | sed 's/[\\"]/\\&/g')" > "$dir/curl.conf" )
  call() { # method params-json -> HTTP status; body in $dir/out.json
    curl -sS -o "$dir/out.json" -w '%{http_code}' --max-time 15 -K "$dir/curl.conf" -H 'content-type: text/plain' \
      --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"check\",\"method\":\"$1\",\"params\":$2}" "http://$h:$rpc_port/" 2> /dev/null || true
  }
  code=$(call getblockchaininfo '[]')
  case "$code" in
    200)
      summary=$(jq -r '.result | "chain=\(.chain) blocks=\(.blocks) headers=\(.headers) initialblockdownload=\(.initialblockdownload) pruned=\(.pruned)"' "$dir/out.json")
      ok "getblockchaininfo: $summary"
      [ "$(jq -r .result.chain "$dir/out.json")" = main ] || bad "not mainnet"
      [ "$(jq -r .result.pruned "$dir/out.json")" = false ] || bad "pruned; external mode expects an unpruned node"
      [ "$(jq -r .result.initialblockdownload "$dir/out.json")" = false ] || bad "still in initial block download"
      ;;
    401) bad "getblockchaininfo: 401, the node rejected BITCOIND_RPC_USER/BITCOIND_RPC_PASS" ;;
    403) bad "getblockchaininfo: 403, not in the user's rpcwhitelist" ;;
    *) bad "getblockchaininfo: HTTP ${code:-none}" ;;
  esac
  if [ "$code" = 200 ]; then
    # The calls LND v0.21.8 makes on a bitcoind backend (entrypoint.sh: LND_BITCOIND_RPCS says
    # why each is needed). Each probe is harmless: read-only, or given an invalid argument so the
    # node rejects it after the whitelist check (HTTP 500, not 403). getinfo no longer exists in
    # Bitcoin Core, so an allowed getinfo answers 404 (method not found), which is what lnd needs.
    # Response bodies (getpeerinfo lists the node's peers) stay in $dir and are never printed.
    genesis=000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f
    zero=0000000000000000000000000000000000000000000000000000000000000000
    echo "rpcwhitelist (403 = blocked):"
    for probe in \
      "getbestblockhash []" "getblockcount []" "getblockhash [0]" "getnetworkinfo []" \
      "getblockheader [\"$genesis\"]" "getblock [\"$genesis\",0]" "estimatesmartfee [6]" \
      "getrawtransaction [\"$zero\"]" "gettxout [\"$zero\",0]" "getmempoolentry [\"$zero\"]" \
      "sendrawtransaction [\"00\"]" "testmempoolaccept [[\"00\"]]" "getzmqnotifications []" \
      "getrawmempool []" \
      "getinfo []" "getdeploymentinfo []" "getmempoolinfo []" "uptime []" "getpeerinfo []" \
      "gettxspendingprevout [[]]"; do
      m=${probe%% *}; code=$(call "$m" "${probe#* }")
      case "$code" in
        200 | 404 | 500) ok "$m" ;;
        403) bad "$m blocked by rpcwhitelist" ;;
        *) bad "$m: HTTP ${code:-none}" ;;
      esac
    done
  fi
fi

if [ "$fail" = 0 ]; then echo "PASS"; else echo "FAILED"; exit 1; fi
