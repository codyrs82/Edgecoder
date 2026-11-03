#!/usr/bin/env bash
# Point the seed coordinators at the regtest hub: bake a payout-scoped macaroon on the hub and
# stage it plus the hub's TLS cert as Fly secrets on both seeds. Nothing is printed.
# Run from the repo root with FLY_API_TOKEN set (or ~/.config/edgecoder/fly.token present).
set -euo pipefail
export FLY_API_TOKEN="${FLY_API_TOKEN:-$(cat ~/.config/edgecoder/fly.token)}"
A=edgecoder-lnd-test
HUB=$(fly machines list -a "$A" --json | jq -r '.[] | select(.config.metadata.fly_process_group=="hub") | .id')
run() { fly ssh console -a "$A" --machine "$HUB" -q -C "$1" 2>/dev/null | { grep -v '^Connecting' || true; }; }
run "lncli --lnddir=/data --network=regtest bakemacaroon --save_to /data/payout.macaroon info:read invoices:read invoices:write offchain:read offchain:write onchain:read" >/dev/null
umask 077
f=$(mktemp)
trap 'rm -f "$f"' EXIT
mac=$(run "od -An -tx1 -v /data/payout.macaroon" | tr -d ' \n\r')
cert=$(run "base64 -w0 /data/tls.cert" | tr -d '\n\r')
[ ${#mac} -gt 100 ] && printf %s "$cert" | base64 -d | grep -q 'BEGIN CERTIFICATE' || { echo "could not read macaroon/cert from hub" >&2; exit 1; }
printf 'LND_MACAROON_HEX=%s\nLND_TLS_CERT_BASE64=%s\n' "$mac" "$cert" > "$f"
for app in edgecoder-seed edgecoder-seed-eu; do fly secrets import -a "$app" --stage < "$f" >/dev/null && echo "staged on $app"; done
