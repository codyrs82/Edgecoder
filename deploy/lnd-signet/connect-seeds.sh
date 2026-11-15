#!/usr/bin/env bash
# THE SIGNET SWITCH (README.md, "Switch the coordinators to signet"). Do not run without the
# owner's go-ahead: it moves the live coordinators off regtest, and the shared ledger must be
# reset to signet in the same window (scripts/ledger-reset-network.ts).
#
# Stages on both seeds, as Fly secrets (secrets override the same names in the seeds' fly.toml
# [env]): the node's TLS cert and its scoped coordinator macaroon, LND_REST_URL and
# BITCOIN_NETWORK=signet. --stage means nothing changes until the seeds are next deployed or
# restarted (README step S4). Nothing secret is printed.
# Run from the repo root with FLY_API_TOKEN set (or ~/.config/edgecoder/fly.token present).
set -euo pipefail
[ "${1:-}" = "--i-have-the-owners-go-ahead" ] || { echo "usage: $0 --i-have-the-owners-go-ahead" >&2; exit 2; }
export FLY_API_TOKEN="${FLY_API_TOKEN:-$(cat ~/.config/edgecoder/fly.token)}"
A=edgecoder-lnd-signet
run() { fly ssh console -a "$A" -q -C "$1" 2>/dev/null | { grep -v '^Connecting' || true; }; }
umask 077
f=$(mktemp)
trap 'rm -f "$f"' EXIT
mac=$(run "od -An -tx1 -v /data/coordinator.macaroon" | tr -d ' \n\r')
cert=$(run "base64 -w0 /data/lnd/tls.cert" | tr -d '\n\r')
[ ${#mac} -gt 100 ] && printf %s "$cert" | base64 -d | grep -q 'BEGIN CERTIFICATE' || { echo "could not read macaroon/cert from $A" >&2; exit 1; }
{
  printf 'LND_MACAROON_HEX=%s\nLND_TLS_CERT_BASE64=%s\n' "$mac" "$cert"
  printf 'LIGHTNING_PROVIDER=lnd\nLND_REST_URL=https://%s.internal:8080\nBITCOIN_NETWORK=signet\n' "$A"
} > "$f"
for app in edgecoder-seed edgecoder-seed-eu; do fly secrets import -a "$app" --stage < "$f" >/dev/null && echo "staged on $app"; done
