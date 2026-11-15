#!/usr/bin/env bash
# `lnc <command>`: lncli for this node (Mutinynet = signet, data in /data/lnd). Run inside the machine:
#   fly ssh console -a edgecoder-lnd-signet, then e.g. `lnc getinfo`.
# Runs as the lightning user so files it creates (macaroons) stay readable by lnd.
set -euo pipefail
cmd=(lncli --lnddir=/data/lnd --network=signet "$@")
if [ "$(id -u)" = 0 ]; then exec setpriv --reuid=1000 --regid=1000 --init-groups "${cmd[@]}"; fi
exec "${cmd[@]}"
