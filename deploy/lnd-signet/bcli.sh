#!/usr/bin/env bash
# `bcli <command>`: bitcoin-cli for this node's Mutinynet bitcoind (cookie auth, as the lightning user).
set -euo pipefail
cmd=(bitcoin-cli -conf=/etc/bitcoin-mutinynet.conf -datadir=/data/bitcoin "$@")
if [ "$(id -u)" = 0 ]; then exec setpriv --reuid=1000 --regid=1000 --init-groups "${cmd[@]}"; fi
exec "${cmd[@]}"
