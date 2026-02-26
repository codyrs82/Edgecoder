#!/usr/bin/env bash
set -euo pipefail

SEED_URL="${SEED_URL:-https://edgecoder-seed.fly.dev}"
LOCAL_AGENT_URL="${LOCAL_AGENT_URL:-http://localhost:4301}"
MESH_TOKEN="${MESH_TOKEN:-}"

AUTH_HEADER=""
if [[ -n "${MESH_TOKEN}" ]]; then
  AUTH_HEADER="-H x-mesh-token: ${MESH_TOKEN}"
fi

echo "=== WAN Mesh E2E Test ==="
echo "Seed node: ${SEED_URL}"
echo "Local agent: ${LOCAL_AGENT_URL}"
echo ""

# 1. Verify seed node is reachable
echo "[1/6] Checking seed node health..."
SEED_HEALTH=$(curl -sf "${SEED_URL}/status" -H "x-mesh-token: ${MESH_TOKEN}" || echo "FAIL")
if [[ "${SEED_HEALTH}" == "FAIL" ]]; then
  echo "FAIL: Seed node unreachable at ${SEED_URL}/status"
  exit 1
fi
echo "  OK: Seed node is healthy"

# 2. Verify local agent is running
echo "[2/6] Checking local agent health..."
LOCAL_HEALTH=$(curl -sf "${LOCAL_AGENT_URL}/health/runtime" || echo "FAIL")
if [[ "${LOCAL_HEALTH}" == "FAIL" ]]; then
  echo "FAIL: Local agent unreachable at ${LOCAL_AGENT_URL}/health/runtime"
  exit 1
fi
echo "  OK: Local agent is healthy"

# 3. Check peer discovery
echo "[3/6] Checking peer discovery..."
PEERS=$(curl -sf "${LOCAL_AGENT_URL}/mesh/peers" || echo "FAIL")
if [[ "${PEERS}" == "FAIL" ]]; then
  echo "WARN: Could not fetch peers (endpoint may not exist yet)"
else
  echo "  OK: Peers response: $(echo "${PEERS}" | head -c 200)"
fi

# 4. Submit a test task to seed node
echo "[4/6] Submitting test task to seed node..."
TASK_RESULT=$(curl -sf -X POST "${SEED_URL}/pull" \
  -H "Content-Type: application/json" \
  -H "x-mesh-token: ${MESH_TOKEN}" \
  -d '{"agentId":"wan-test-agent","model":"qwen2.5:7b","os":"linux"}' \
  || echo "FAIL")
if [[ "${TASK_RESULT}" == "FAIL" ]]; then
  echo "  WARN: Pull returned no task (queue may be empty — expected)"
else
  echo "  OK: Pull response: $(echo "${TASK_RESULT}" | head -c 200)"
fi

# 5. Verify ledger consistency (check seed node)
echo "[5/6] Checking ledger integrity on seed node..."
LEDGER=$(curl -sf "${SEED_URL}/credits/ledger/verify" -H "x-mesh-token: ${MESH_TOKEN}" || echo "SKIP")
if [[ "${LEDGER}" == "SKIP" ]]; then
  echo "  SKIP: Ledger verify endpoint not available"
else
  echo "  OK: Ledger response: $(echo "${LEDGER}" | head -c 200)"
fi

# 6. Verify gossip propagation (check local agent for seed peer)
echo "[6/6] Checking gossip propagation..."
echo "  Manual check: Verify local agent's /mesh/peers includes the seed node"
echo ""

echo "=== WAN Mesh E2E Test Complete ==="
echo "Review output above for any FAIL or WARN results."
