#!/usr/bin/env bash
# Give each seed a permanent Ed25519 identity key (COORDINATOR_PRIVATE_KEY_PEM). Without it a seed
# makes a new key on every deploy or restart, and every agent that pinned the old one refuses it.
# Skips a seed that already has the secret (rotating is a deliberate act: see going-to-mainnet.md).
# The key goes straight from node into `fly secrets import`; nothing is printed or kept on disk.
# Run from the repo root. Setting the secret restarts the seed once.
set -euo pipefail
export FLY_API_TOKEN="${FLY_API_TOKEN:-$(cat ~/.config/edgecoder/fly.token)}"
for app in edgecoder-seed edgecoder-seed-eu; do
  if fly secrets list -a "$app" --json | jq -e '.[] | select(.name=="COORDINATOR_PRIVATE_KEY_PEM")' >/dev/null; then
    echo "$app: already has COORDINATOR_PRIVATE_KEY_PEM, left alone"
    continue
  fi
  # fly secrets import takes a multi-line value inside triple quotes. Its errors can quote the
  # input, so they are replaced with a fixed message.
  node -e 'const { generateKeyPairSync } = require("node:crypto");
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    process.stdout.write(`COORDINATOR_PRIVATE_KEY_PEM="""${pem.trim()}"""\n`);' \
    | fly secrets import -a "$app" >/dev/null 2>&1 || { echo "$app: fly secrets import failed" >&2; exit 1; }
  echo "$app: key set"
done
sleep 20
for h in coordinator.edgecoder.io coordinator-eu.edgecoder.io; do
  printf '%s ' "$h"; curl -s -m 10 "https://$h/identity" | jq -r .trustEntry
done
