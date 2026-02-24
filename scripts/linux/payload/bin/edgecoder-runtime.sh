#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/usr/lib/edgecoder/app"
ENV_FILE="${EDGECODER_ENV_FILE:-/etc/edgecoder/edgecoder.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "node binary not found. Install Node.js 20+ and set NODE_BIN in $ENV_FILE." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "EdgeCoder app directory not found at $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

MODE="${EDGE_RUNTIME_MODE:-worker}"
case "$MODE" in
  worker)
    exec "$NODE_BIN" "dist/swarm/worker-runner.js"
    ;;
  all-in-one)
    exec "$NODE_BIN" "dist/index.js"
    ;;
  coordinator)
    exec "$NODE_BIN" "dist/swarm/coordinator.js"
    ;;
  control-plane)
    exec "$NODE_BIN" "dist/control-plane/server.js"
    ;;
  inference)
    exec "$NODE_BIN" "dist/inference/service.js"
    ;;
  ide-provider)
    exec "$NODE_BIN" "dist/apps/ide/provider-server.js"
    ;;
  *)
    echo "Unsupported EDGE_RUNTIME_MODE: $MODE" >&2
    exit 1
    ;;
esac
