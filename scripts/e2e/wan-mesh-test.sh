#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder
# SPDX-License-Identifier: BUSL-1.1
#
# WAN mesh check: read-only probes of a seed coordinator and a local node. Sends no work, pulls no
# tasks and changes nothing. MESH_TOKEN (optional) is sent as x-mesh-token and never printed.
#
#   SEED_URL=https://coordinator.edgecoder.io LOCAL_AGENT_URL=http://localhost:4301 MESH_TOKEN=... \
#     scripts/e2e/wan-mesh-test.sh
set -euo pipefail

SEED_URL="${SEED_URL:-https://coordinator.edgecoder.io}"
LOCAL_AGENT_URL="${LOCAL_AGENT_URL:-http://localhost:4301}"
MESH_TOKEN="${MESH_TOKEN:-}"

hdr=()
[[ -n "${MESH_TOKEN}" ]] && hdr=(-H "x-mesh-token: ${MESH_TOKEN}")
get() { curl -sf --max-time 20 ${hdr[@]+"${hdr[@]}"} "$1"; }

echo "=== WAN Mesh E2E Test (read-only) ==="
echo "Seed node: ${SEED_URL}"
echo "Local agent: ${LOCAL_AGENT_URL}"
echo ""

echo "[1/5] Seed node health (GET /health/runtime)..."
if ! SEED_HEALTH=$(get "${SEED_URL}/health/runtime"); then
  echo "FAIL: Seed node unreachable at ${SEED_URL}/health/runtime"
  exit 1
fi
echo "  OK: $(echo "${SEED_HEALTH}" | head -c 200)"

echo "[2/5] Local node health (GET /health/runtime)..."
if ! LOCAL_HEALTH=$(get "${LOCAL_AGENT_URL}/health/runtime"); then
  echo "FAIL: Local node unreachable at ${LOCAL_AGENT_URL}/health/runtime"
  exit 1
fi
echo "  OK: $(echo "${LOCAL_HEALTH}" | head -c 200)"

echo "[3/5] Seed identity (GET /identity)..."
if IDENTITY=$(get "${SEED_URL}/identity"); then
  echo "  OK: $(echo "${IDENTITY}" | head -c 200)"
else
  echo "  WARN: /identity not readable"
fi

echo "[4/5] Peer discovery (GET /mesh/peers on both)..."
for u in "${SEED_URL}" "${LOCAL_AGENT_URL}"; do
  if PEERS=$(get "${u}/mesh/peers"); then
    echo "  OK: ${u}: $(echo "${PEERS}" | head -c 200)"
  else
    echo "  WARN: ${u}/mesh/peers not readable (mesh token needed?)"
  fi
done

echo "[5/5] Ledger ordering chain (GET /ledger/verify)..."
if LEDGER=$(get "${SEED_URL}/ledger/verify"); then
  echo "  OK: $(echo "${LEDGER}" | head -c 200)"
  if echo "${LEDGER}" | grep -q '"ok":false'; then echo "FAIL: ledger chain does not verify"; exit 1; fi
else
  echo "  SKIP: /ledger/verify not readable (mesh token needed?)"
fi

echo ""
echo "=== WAN Mesh E2E Test Complete ==="
echo "Manual check: the local node's /mesh/peers should include the seed. Review any FAIL or WARN above."
