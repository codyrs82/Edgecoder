#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/edgecoder/app"
ENV_FILE="${EDGECODER_ENV_FILE:-/etc/edgecoder/edgecoder.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

# LaunchDaemons may not define HOME. Ollama panics without it.
if [[ -z "${HOME:-}" ]]; then
  if [[ -n "${SUDO_USER:-}" ]]; then
    export HOME="/Users/${SUDO_USER}"
  else
    export HOME="/var/root"
  fi
fi

resolve_node_bin() {
  local candidate

  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    printf "%s\n" "$NODE_BIN"
    return 0
  fi

  if candidate="$(command -v node 2>/dev/null)"; then
    printf "%s\n" "$candidate"
    return 0
  fi

  for candidate in \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/opt/local/bin/node"; do
    if [[ -x "$candidate" ]]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done

  if [[ -n "${SUDO_USER:-}" ]]; then
    local nvm_root="/Users/${SUDO_USER}/.nvm/versions/node"
    if [[ -d "$nvm_root" ]]; then
      candidate="$(ls -1d "$nvm_root"/v*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
      if [[ -n "$candidate" && -x "$candidate" ]]; then
        printf "%s\n" "$candidate"
        return 0
      fi
    fi
  fi

  return 1
}

NODE_BIN="$(resolve_node_bin || true)"
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
