#!/bin/sh
# edgecoder-lnd-tower: LND as a watchtower server only (README.md here).
# - Chain: neutrino (compact block filters from public Bitcoin peers), so the tower does not share
#   ocean-node with the node it protects; if ocean-node is down, the tower still sees breaches.
# - Wallet: --noseedbackup creates and unlocks a wallet with no seed. It never holds funds; it
#   only anchors the tower's identity key. If the volume is lost, the tower gets a new key and
#   the client re-adds it (README: "If the tower is rebuilt").
# - Network: no Lightning P2P (--nolisten), no REST, gRPC on loopback; the tower protocol listens
#   on 9911 on Fly's private network only (fly.toml defines no public service).
set -eu
exec lnd --lnddir=/data --alias="${TOWER_ALIAS:-edgecoder-tower}" \
  --bitcoin.mainnet --bitcoin.node=neutrino \
  --fee.url="${TOWER_FEE_URL:-https://nodes.lightning.computer/fees/v1/btc-fee-estimates.json}" \
  --noseedbackup --nolisten --norest --rpclisten=[::1]:10009 \
  --watchtower.active --watchtower.listen=[::]:9911
