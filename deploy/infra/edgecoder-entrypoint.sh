#!/bin/sh
# Entrypoint wrapper for the edgecoder service in deploy/infra/docker-compose.yml.
# lnd keeps its admin macaroon as a binary file (mode 600, uid 1000) in its own volume, which is
# mounted read-only at /lnd. The coordinator wants it hex-encoded in LND_MACAROON_HEX
# (src/economy/lightning.ts), so: wait for lnd's TLS cert and macaroon to exist (they appear
# once the wallet is created by scripts/infra-bootstrap.sh), hex-encode, export, exec.
# Runs as user `node` in node:22-bookworm-slim: POSIX sh, coreutils `od`, no xxd.
set -eu

macaroon="${LND_MACAROON_PATH:-/lnd/data/chain/bitcoin/${LND_NETWORK:-signet}/admin.macaroon}"
tls_cert="${LND_TLS_CERT_PATH:-/lnd/tls.cert}"
wait_seconds="${LND_MACAROON_WAIT_SECONDS:-900}"

if [ "${LIGHTNING_PROVIDER:-}" = "lnd" ] && [ -z "${LND_MACAROON_HEX:-}" ]; then
  waited=0
  while [ ! -r "$macaroon" ] || [ ! -r "$tls_cert" ]; do
    if [ "$waited" -ge "$wait_seconds" ]; then
      echo "[entrypoint] ERROR: no readable lnd macaroon at $macaroon (or cert at $tls_cert) after ${wait_seconds}s." >&2
      echo "[entrypoint] Create the wallet first: scripts/infra-bootstrap.sh (it initialises lnd non-interactively)." >&2
      exit 1
    fi
    if [ $((waited % 60)) -eq 0 ]; then
      echo "[entrypoint] waiting for lnd wallet: $macaroon (${waited}s)"
    fi
    sleep 5
    waited=$((waited + 5))
  done
  LND_MACAROON_HEX="$(od -An -v -tx1 "$macaroon" | tr -d ' \n')"
  if [ -z "$LND_MACAROON_HEX" ]; then
    echo "[entrypoint] ERROR: $macaroon is empty" >&2
    exit 1
  fi
  export LND_MACAROON_HEX
  echo "[entrypoint] lnd macaroon loaded (${#LND_MACAROON_HEX} hex chars) from $macaroon"
fi

exec "$@"
