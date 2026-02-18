#!/usr/bin/env bash

set -euo pipefail

ENV_FILE="/etc/edgecoder/edgecoder.env"
ENV_EXAMPLE="/etc/edgecoder/edgecoder.env.example"

prompt_text() {
  local prompt="$1"
  local default_value="$2"
  local input
  if [[ -n "$default_value" ]]; then
    read -r -p "$prompt [$default_value]: " input
    printf "%s\n" "${input:-$default_value}"
  else
    read -r -p "$prompt: " input
    printf "%s\n" "$input"
  fi
}

prompt_choice() {
  local prompt="$1"
  local default_value="$2"
  shift 2
  local options=("$@")
  local input normalized option
  while true; do
    if [[ -n "$default_value" ]]; then
      read -r -p "$prompt [$default_value]: " input
      input="${input:-$default_value}"
    else
      read -r -p "$prompt: " input
    fi
    normalized="$(printf "%s" "$input" | tr '[:upper:]' '[:lower:]')"
    # Accept short yes/no aliases.
    if [[ "$normalized" == "y" ]]; then
      normalized="yes"
    elif [[ "$normalized" == "n" ]]; then
      normalized="no"
    fi
    for option in "${options[@]}"; do
      if [[ "$normalized" == "$option" ]]; then
        printf "%s\n" "$normalized"
        return 0
      fi
    done
    echo "Please enter one of: ${options[*]}" >&2
  done
}

prompt_bool() {
  local prompt="$1"
  local default_value="$2"
  local raw
  while true; do
    read -r -p "$prompt [$default_value]: " raw
    raw="$(printf "%s" "${raw:-$default_value}" | tr '[:upper:]' '[:lower:]')"
    case "$raw" in
      true|false)
        printf "%s\n" "$raw"
        return 0
        ;;
      *)
        echo "Please enter true or false."
        ;;
    esac
  done
}

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
EdgeCoder environment setup wizard.

Usage:
  sudo /opt/edgecoder/bin/edgecoder-configure.sh
EOF
  exit 0
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "No interactive terminal detected."
  echo "Run this from a terminal, for example:"
  echo "  sudo /opt/edgecoder/bin/edgecoder-configure.sh"
  exit 1
fi

echo
echo "EdgeCoder macOS setup wizard"
echo "This configures /etc/edgecoder/edgecoder.env for launchd runtime."
echo

if [[ -f "$ENV_FILE" ]]; then
  overwrite="$(prompt_choice "Existing config found. Overwrite it?" "no" yes no)"
  if [[ "$overwrite" != "yes" ]]; then
    echo "Keeping existing config: $ENV_FILE"
    exit 0
  fi
fi

echo
echo "1) Runtime profile"
echo "   - worker: mesh worker agent (most common)"
echo "   - ide-provider: local IDE provider service (:4304)"
echo "   - coordinator/control-plane/inference/all-in-one: advanced service roles"
EDGE_RUNTIME_MODE="$(prompt_choice "EDGE_RUNTIME_MODE" "worker" worker ide-provider coordinator control-plane inference all-in-one)"

echo
echo "2) Agent identity (used for worker profile; safe to keep for other modes)"
echo "   If you do not have an AGENT_ID yet:"
echo "   1) Open https://portal.edgecoder.io/portal"
echo "   2) Register/sign in and verify email"
echo "   3) Enroll a node and use that node id as AGENT_ID"
AGENT_ID="$(prompt_text "AGENT_ID (unique node id)" "mac-worker-001")"
AGENT_OS="$(prompt_choice "AGENT_OS" "macos" macos ubuntu debian windows ios)"
echo "   AGENT_MODE choices:"
echo "   - swarm-only: compute only"
echo "   - ide-enabled: compute + IDE-capable flag"
AGENT_MODE="$(prompt_choice "AGENT_MODE" "swarm-only" swarm-only ide-enabled)"
echo "   AGENT_CLIENT_TYPE identifies runtime flavor in coordinator telemetry."
echo "   Keep default for normal EdgeCoder workers."
echo "   Examples: edgecoder-native | openclaw | claude-local"
AGENT_CLIENT_TYPE="$(prompt_text "AGENT_CLIENT_TYPE (runtime flavor label)" "edgecoder-native")"

echo
echo "3) Portal enrollment link (how node binds to your user account)"
echo "   If you do not know AGENT_ID or AGENT_REGISTRATION_TOKEN yet:"
echo "   1) Open https://portal.edgecoder.io/portal"
echo "   2) Register/sign in and verify email"
echo "   3) Enroll a node and copy:"
echo "      - node id -> AGENT_ID"
echo "      - registrationToken -> AGENT_REGISTRATION_TOKEN"
AGENT_REGISTRATION_TOKEN="$(prompt_text "AGENT_REGISTRATION_TOKEN" "")"

echo
echo "4) Coordinator and mesh auth"
COORDINATOR_URL="$(prompt_text "COORDINATOR_URL" "https://coordinator.edgecoder.io")"
echo "   MESH_AUTH_TOKEN is a shared secret set by the coordinator operator."
echo "   For managed enrollment, you can usually leave this blank."
echo "   The coordinator can auto-provision it after successful node enrollment."
echo "   If required in your environment, ask admin for it or self-host generate one:"
echo "     openssl rand -hex 32"
echo "   Then set that same token on coordinator and agent."
MESH_AUTH_TOKEN="$(prompt_text "MESH_AUTH_TOKEN" "")"
COORDINATOR_MESH_TOKEN="$(prompt_text "COORDINATOR_MESH_TOKEN (optional; blank = same as MESH_AUTH_TOKEN)" "")"
if [[ -z "$COORDINATOR_MESH_TOKEN" ]]; then
  COORDINATOR_MESH_TOKEN="$MESH_AUTH_TOKEN"
fi

echo
echo "5) Model provider"
echo "   LOCAL_MODEL_PROVIDER decides which local model runtime this node uses."
echo "   - edgecoder-local: default built-in provider (recommended if unsure)"
echo "   - ollama-local: use local Ollama daemon/models on this machine"
echo "   Choose ollama-local only if Ollama is installed and you want Ollama models."
LOCAL_MODEL_PROVIDER="$(prompt_choice "LOCAL_MODEL_PROVIDER" "edgecoder-local" edgecoder-local ollama-local)"
if [[ "$LOCAL_MODEL_PROVIDER" == "ollama-local" ]]; then
  echo "   OLLAMA_MODEL is the model tag Ollama should run/pull."
  echo "   Common examples: qwen2.5-coder:latest | llama3.1:8b | codellama:13b"
  echo "   Model availability depends on your Ollama catalog and machine resources."
  OLLAMA_MODEL="$(prompt_text "OLLAMA_MODEL" "qwen2.5-coder:latest")"
  echo "   OLLAMA_HOST options:"
  echo "   - blank: default local host (http://127.0.0.1:11434)"
  echo "   - http://127.0.0.1:11434 : explicit local host"
  echo "   - http://<ip-or-host>:11434 : remote/shared Ollama host"
  OLLAMA_HOST="$(prompt_text "OLLAMA_HOST (blank for local default)" "")"
  OLLAMA_AUTO_INSTALL="$(prompt_bool "OLLAMA_AUTO_INSTALL (auto pull model at startup)" "false")"
else
  echo "   Using edgecoder-local; Ollama-specific settings will be kept at defaults."
  OLLAMA_AUTO_INSTALL="false"
  OLLAMA_MODEL="qwen2.5-coder:latest"
  OLLAMA_HOST=""
fi

echo
echo "6) Optional tuning"
echo "   MAX_CONCURRENT_TASKS controls how many coordinator tasks this agent runs at once."
echo "   - 1: safest/recommended default (stable resource usage)"
echo "   - higher values: more throughput, but more CPU/RAM contention"
echo "   Start with 1; increase gradually only on stronger machines."
MAX_CONCURRENT_TASKS="$(prompt_text "MAX_CONCURRENT_TASKS" "1")"
echo "   PEER_OFFER_COOLDOWN_MS is the wait time between peer-direct work offers when idle."
echo "   - lower (e.g. 5000): more aggressive peer offers, more network chatter"
echo "   - higher (e.g. 30000+): calmer network behavior, slower peer-direct utilization"
echo "   20000 is a balanced default for most deployments."
PEER_OFFER_COOLDOWN_MS="$(prompt_text "PEER_OFFER_COOLDOWN_MS" "20000")"

mkdir -p /etc/edgecoder
cat >"$ENV_FILE" <<EOF
EDGE_RUNTIME_MODE=$EDGE_RUNTIME_MODE
AGENT_ID=$AGENT_ID
AGENT_OS=$AGENT_OS
AGENT_MODE=$AGENT_MODE
AGENT_CLIENT_TYPE=$AGENT_CLIENT_TYPE
AGENT_REGISTRATION_TOKEN=$AGENT_REGISTRATION_TOKEN
COORDINATOR_URL=$COORDINATOR_URL
MESH_AUTH_TOKEN=$MESH_AUTH_TOKEN
COORDINATOR_MESH_TOKEN=$COORDINATOR_MESH_TOKEN
LOCAL_MODEL_PROVIDER=$LOCAL_MODEL_PROVIDER
OLLAMA_AUTO_INSTALL=$OLLAMA_AUTO_INSTALL
OLLAMA_MODEL=$OLLAMA_MODEL
OLLAMA_HOST=$OLLAMA_HOST
MAX_CONCURRENT_TASKS=$MAX_CONCURRENT_TASKS
PEER_OFFER_COOLDOWN_MS=$PEER_OFFER_COOLDOWN_MS
EOF
chmod 600 "$ENV_FILE"

echo
echo "Saved config to: $ENV_FILE"
if [[ -z "$AGENT_REGISTRATION_TOKEN" && "$EDGE_RUNTIME_MODE" == "worker" ]]; then
  echo "Warning: AGENT_REGISTRATION_TOKEN is empty. Worker registration will fail until this is set."
fi
echo "If you need to edit later: sudo nano $ENV_FILE"
