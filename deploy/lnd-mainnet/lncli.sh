#!/usr/bin/env bash
# `lnc <command>`: lncli for this node (mainnet, data in /data). Run inside the lnd machine:
#   fly ssh console -a edgecoder-lnd --select   (pick the lnd machine), then e.g. `lnc getinfo`.
# Runs as the lightning user so files it creates (macaroons) stay readable by lnd.
set -euo pipefail
cmd=(lncli --lnddir=/data --network=mainnet "$@")
if [ "$(id -u)" = 0 ]; then exec setpriv --reuid=1000 --regid=1000 --init-groups "${cmd[@]}"; fi
exec "${cmd[@]}"
