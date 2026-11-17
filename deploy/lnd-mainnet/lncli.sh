#!/usr/bin/env bash
# `lnc <command>`: lncli for this node (mainnet, data in /data). Run inside the lnd machine:
#   fly ssh console -a edgecoder-lnd --select   (pick the lnd machine), then e.g. `lnc getinfo`.
# Runs as the lightning user so files it creates (macaroons) stay readable by lnd.
# lnd's gRPC listens on [::]:10009 and lncli's default 127.0.0.1:10009 is refused there, so this
# defaults to [::1]:10009 unless the caller passes --rpcserver.
set -euo pipefail
rpc=(--rpcserver=[::1]:10009)
for a in "$@"; do case "$a" in --rpcserver | --rpcserver=*) rpc=() ;; esac; done
cmd=(lncli --lnddir=/data --network=mainnet ${rpc[@]+"${rpc[@]}"} "$@")
if [ "$(id -u)" = 0 ]; then exec setpriv --reuid=1000 --regid=1000 --init-groups "${cmd[@]}"; fi
exec "${cmd[@]}"
