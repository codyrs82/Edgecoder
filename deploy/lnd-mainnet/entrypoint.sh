#!/usr/bin/env bash
# Usage: entrypoint.sh bitcoind | lnd
# Secrets (fly secrets set -a edgecoder-lnd): BTC_RPC_PASS, LND_WALLET_PASS.
# Env (fly.toml): LND_ALIAS, LND_EXTERNAL_IP (optional), BITCOIN_PRUNE_MB, BITCOIN_DBCACHE_MB.
#
# The wallet is never created here. On first boot lnd waits for `lnc create`, run by the
# operator over `fly ssh console`, so the 24-word seed is shown on their terminal only and is
# never written to the volume, the logs or anywhere else.
set -euo pipefail
DATA=/data
APP=${FLY_APP_NAME:-edgecoder-lnd}

# Volumes mount as root: hand them to the lightning user, then re-run this script as that user.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA"
  chown -R lightning:lightning "$DATA"
  exec setpriv --reuid=1000 --regid=1000 --init-groups "$0" "$@"
fi

: "${BTC_RPC_PASS:?BTC_RPC_PASS is not set (fly secrets set -a $APP BTC_RPC_PASS=...)}"

# Passwords go into config files in /tmp (machine rootfs, gone on restart), never onto a command
# line (where `ps`, Fly's deploy output and crash reports would show them) or onto the volume.
umask 077

case "${1:-}" in
  bitcoind)
    # RPC and ZMQ listen on Fly's private network only (no public service is defined for them),
    # and RPC accepts only loopback (bitcoin-cli in the machine) and 6PN addresses. P2P is
    # outbound only.
    printf 'rpcuser=edgecoder\nrpcpassword=%s\n' "$BTC_RPC_PASS" > /tmp/bitcoin.conf
    exec bitcoind -conf=/tmp/bitcoin.conf -datadir="$DATA" -printtoconsole -server \
      -prune="${BITCOIN_PRUNE_MB:-50000}" -dbcache="${BITCOIN_DBCACHE_MB:-2000}" \
      -rpcbind=127.0.0.1 -rpcbind=[::] -rpcallowip=127.0.0.1 -rpcallowip=fdaa::/16 \
      -zmqpubrawblock=tcp://[::]:28332 -zmqpubrawtx=tcp://[::]:28333 \
      -listen=0 -discover=0
    ;;
  lnd)
    : "${LND_WALLET_PASS:?LND_WALLET_PASS is not set (deploy/lnd-mainnet/README.md, step 2)}"
    btc="bitcoind.process.$APP.internal"
    host="lnd.process.$APP.internal"
    # The unlock password and the bitcoind RPC password live in /tmp, not on the volume, so a
    # volume snapshot carries neither.
    printf '%s' "$LND_WALLET_PASS" > /tmp/wallet.pass
    printf '[Bitcoind]\nbitcoind.rpcuser=edgecoder\nbitcoind.rpcpass=%s\n' "$BTC_RPC_PASS" > /tmp/lnd.conf
    external=()
    [ -n "${LND_EXTERNAL_IP:-}" ] && external=(--externalip="$LND_EXTERNAL_IP:9735")
    exec lnd --configfile=/tmp/lnd.conf --lnddir="$DATA" --alias="${LND_ALIAS:-edgecoder}" \
      --bitcoin.mainnet --bitcoin.node=bitcoind \
      --bitcoind.rpchost="$btc:8332" \
      --bitcoind.zmqpubrawblock="tcp://$btc:28332" --bitcoind.zmqpubrawtx="tcp://$btc:28333" \
      --bitcoind.estimatemode=ECONOMICAL \
      --listen=0.0.0.0:9735 --restlisten=[::]:8080 --rpclisten=[::]:10009 \
      --tlsextradomain="$host" --tlsextradomain=localhost "${external[@]}" \
      --wallet-unlock-password-file=/tmp/wallet.pass --wallet-unlock-allow-create \
      --minchansize=100000 --coop-close-target-confs=6
    ;;
  *) echo "usage: $0 bitcoind | lnd" >&2; exit 2 ;;
esac
