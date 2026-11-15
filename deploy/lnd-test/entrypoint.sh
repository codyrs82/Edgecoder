#!/usr/bin/env bash
# Usage: entrypoint.sh bitcoind | lnd <alias>
# Env: BTC_RPC_PASS, LND_WALLET_PASS (Fly secrets); BITCOIND_HOST (default bitcoind.process.$FLY_APP_NAME.internal)
set -euo pipefail
DATA=${DATA_DIR:-/data}
mkdir -p "$DATA"

case "${1:-}" in
  bitcoind)
    wallet=()
    [ -d "$DATA/regtest/wallets/miner" ] && wallet=(-wallet=miner)
    bitcoind "${wallet[@]}" -regtest -datadir="$DATA" -server -txindex -fallbackfee=0.0002 \
      -rpcuser=edgecoder -rpcpassword="$BTC_RPC_PASS" -rpcbind=[::] -rpcallowip=0.0.0.0/0 -rpcallowip=::/0 \
      -zmqpubrawblock=tcp://[::]:28332 -zmqpubrawtx=tcp://[::]:28333 -printtoconsole &
    btcd=$!
    trap 'kill -TERM "$btcd" 2>/dev/null' TERM INT
    # Regtest only gets blocks when someone mines them. Left idle, LND marks itself unsynced
    # (synced_to_chain=false) and invoice creation hangs, which is what broke top-ups on 2026-11-15.
    # Mine one block every REGTEST_BLOCK_INTERVAL_S (default 600) into the miner wallet; 0 disables.
    interval=${REGTEST_BLOCK_INTERVAL_S:-600}
    if [ "$interval" -gt 0 ] 2>/dev/null; then
      (
        cli() { bitcoin-cli -regtest -datadir="$DATA" -rpcuser=edgecoder -rpcpassword="$BTC_RPC_PASS" "$@"; }
        until cli getblockcount >/dev/null 2>&1; do sleep 2; done
        while sleep "$interval"; do
          addr=$(cli -rpcwallet=miner getnewaddress 2>/dev/null) || continue
          cli generatetoaddress 1 "$addr" >/dev/null 2>&1 && echo "regtest keepalive: mined block $(cli getblockcount)"
        done
      ) &
    fi
    wait "$btcd"
    ;;
  lnd)
    alias=${2:?alias}
    btc=${BITCOIND_HOST:-bitcoind.process.${FLY_APP_NAME:-local}.internal}
    host=${LND_HOST:-${alias}.process.${FLY_APP_NAME:-local}.internal}
    printf '%s' "$LND_WALLET_PASS" > "$DATA/wallet.pass"
    chmod 600 "$DATA/wallet.pass"
    unlock=()
    [ -f "$DATA/data/chain/bitcoin/regtest/wallet.db" ] && unlock=(--wallet-unlock-password-file="$DATA/wallet.pass")
    lnd --lnddir="$DATA" --alias="edgecoder-$alias" --bitcoin.active --bitcoin.regtest --bitcoin.node=bitcoind \
      --bitcoind.rpchost="$btc:18443" --bitcoind.rpcuser=edgecoder --bitcoind.rpcpass="$BTC_RPC_PASS" \
      --bitcoind.zmqpubrawblock="tcp://$btc:28332" --bitcoind.zmqpubrawtx="tcp://$btc:28333" \
      --listen=[::]:9735 --restlisten=0.0.0.0:8080 --restlisten=[::]:8080 --rpclisten=0.0.0.0:10009 --rpclisten=[::]:10009 \
      --tlsextradomain="$host" --tlsextradomain=localhost --externalip="$host" \
      --nobootstrap --accept-keysend --protocol.wumbo-channels "${unlock[@]}" &
    pid=$!
    if [ ${#unlock[@]} -eq 0 ]; then
      # First boot: create the wallet over REST and keep the seed on the volume (regtest only).
      until [ -f "$DATA/tls.cert" ] && curl -sf --cacert "$DATA/tls.cert" https://localhost:8080/v1/genseed >/dev/null; do sleep 1; done
      seed=$(curl -sf --cacert "$DATA/tls.cert" https://localhost:8080/v1/genseed | jq -c .cipher_seed_mnemonic)
      echo "$seed" > "$DATA/seed.json"; chmod 600 "$DATA/seed.json"
      pass=$(printf '%s' "$LND_WALLET_PASS" | base64 | tr -d '\n')
      curl -sf --cacert "$DATA/tls.cert" -X POST https://localhost:8080/v1/initwallet \
        -d "{\"wallet_password\":\"$pass\",\"cipher_seed_mnemonic\":$seed}" >/dev/null
      echo "wallet created"
    fi
    wait $pid
    ;;
  *) echo "usage: $0 bitcoind | lnd <alias>" >&2; exit 2 ;;
esac
