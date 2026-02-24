#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="tests/e2e/docker-compose.scale.yml"
SEED_URL="http://localhost:4301"
WORKERS="${WORKERS:-10}"
WAIT_SECS="${WAIT_SECS:-60}"

echo "=== Scale Test: ${WORKERS} workers ==="
echo ""

# 1. Build and start
echo "[1/5] Starting seed node + ${WORKERS} workers..."
docker compose -f "${COMPOSE_FILE}" up -d --build --scale worker="${WORKERS}"

# 2. Wait for seed node
echo "[2/5] Waiting for seed node to be healthy (up to ${WAIT_SECS}s)..."
for i in $(seq 1 "${WAIT_SECS}"); do
  if curl -sf "${SEED_URL}/status" >/dev/null 2>&1; then
    echo "  Seed node healthy after ${i}s"
    break
  fi
  sleep 1
done

# 3. Wait for workers to register
echo "[3/5] Waiting 30s for workers to register..."
sleep 30

# 4. Check registered agents
echo "[4/5] Checking registered agents..."
STATUS=$(curl -sf "${SEED_URL}/status" || echo "{}")
echo "  Status: $(echo "${STATUS}" | head -c 500)"

# 5. Verify mesh connectivity
echo "[5/5] Verifying mesh..."
HEALTH=$(curl -sf "${SEED_URL}/health/runtime" || echo "FAIL")
echo "  Health: $(echo "${HEALTH}" | head -c 200)"
echo ""

echo "=== Scale Test Complete ==="
echo "To tear down: docker compose -f ${COMPOSE_FILE} down -v"
