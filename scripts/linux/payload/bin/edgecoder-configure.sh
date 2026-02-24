#!/usr/bin/env bash

set -euo pipefail

ENV_FILE="/etc/edgecoder/edgecoder.env"
ENV_EXAMPLE="/etc/edgecoder/edgecoder.env.example"
SERVICE="edgecoder"

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
EdgeCoder environment setup (Linux).

Usage:
  sudo /usr/lib/edgecoder/bin/edgecoder-configure.sh   # interactive prompt
  sudo edgecoder --token YOUR_TOKEN                     # quick-connect
  sudo edgecoder configure --token YOUR_TOKEN           # quick-connect (alias)

Options:
  --token TOKEN   Configure this node as a worker with the given registration
                  token and restart the service. Non-interactive; intended for
                  copy-paste from the portal download page.
  --help          Show this help message.
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# --token quick-connect handler
# ---------------------------------------------------------------------------
# Accepts:
#   edgecoder-configure.sh --token TOKEN
#   edgecoder-configure.sh configure --token TOKEN   (alias from CLI wrapper)
# ---------------------------------------------------------------------------

# Helper: upsert KEY=VALUE in a file. If the key exists (commented or not),
# replace the line; otherwise append.  NOTE: Linux sed uses -i (no empty arg).
write_or_update_env() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^#?${key}=" "$file" 2>/dev/null; then
    sed -i "s|^#*${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

_resolve_token_arg() {
  # Pattern 1: --token TOKEN
  if [[ "${1:-}" == "--token" ]]; then
    printf '%s' "${2:-}"
    return
  fi
  # Pattern 2: configure --token TOKEN  (CLI wrapper alias)
  if [[ "${1:-}" == "configure" && "${2:-}" == "--token" ]]; then
    printf '%s' "${3:-}"
    return
  fi
}

_TOKEN="$(_resolve_token_arg "${@}")"

if [[ "${1:-}" == "--token" || ( "${1:-}" == "configure" && "${2:-}" == "--token" ) ]]; then
  if [[ -z "$_TOKEN" ]]; then
    echo "Error: --token requires a non-empty TOKEN argument." >&2
    echo "" >&2
    echo "Usage:" >&2
    echo "  sudo edgecoder --token YOUR_TOKEN" >&2
    exit 1
  fi

  # 1. Ensure config directory exists
  mkdir -p /etc/edgecoder

  # 2. Prepare env file: back up existing or seed from example
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    echo "Backed up existing config to ${ENV_FILE}.bak.*"
  elif [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
  else
    # Seed a minimal file so write_or_update_env has something to work with
    touch "$ENV_FILE"
  fi

  # 3. Write the quick-connect values
  write_or_update_env "$ENV_FILE" "AGENT_REGISTRATION_TOKEN" "$_TOKEN"
  write_or_update_env "$ENV_FILE" "EDGE_RUNTIME_MODE"        "worker"
  write_or_update_env "$ENV_FILE" "COORDINATOR_URL"           "https://coordinator.edgecoder.io"
  write_or_update_env "$ENV_FILE" "AGENT_OS"                  "linux"

  chmod 600 "$ENV_FILE"

  # 4. Summary
  echo ""
  echo "EdgeCoder quick-connect configured successfully!"
  echo ""
  echo "  Config file : $ENV_FILE"
  echo "  Mode        : worker"
  echo "  Coordinator : https://coordinator.edgecoder.io"
  echo "  Token       : ${_TOKEN:0:8}...${_TOKEN: -4} (truncated)"
  echo ""

  # 5. Restart or advise
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    echo "Restarting EdgeCoder service..."
    systemctl restart "$SERVICE"
    echo "Service restarted."
  else
    echo "EdgeCoder service is not running yet."
    echo "Start it with:"
    echo "  sudo systemctl enable --now $SERVICE"
  fi

  echo ""
  echo "View your nodes at: https://portal.edgecoder.io/portal/nodes"
  exit 0
fi

# ---------------------------------------------------------------------------
# Interactive fallback (simple token prompt)
# ---------------------------------------------------------------------------

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "No interactive terminal detected."
  echo "Run this from a terminal, for example:"
  echo "  sudo /usr/lib/edgecoder/bin/edgecoder-configure.sh"
  echo ""
  echo "Or use non-interactive quick-connect:"
  echo "  sudo edgecoder --token YOUR_TOKEN"
  exit 1
fi

echo ""
echo "EdgeCoder Linux setup"
echo "This configures $ENV_FILE for the systemd runtime."
echo ""

if [[ -f "$ENV_FILE" ]]; then
  read -r -p "Existing config found. Overwrite it? [no]: " overwrite
  overwrite="${overwrite:-no}"
  overwrite="$(printf "%s" "$overwrite" | tr '[:upper:]' '[:lower:]')"
  if [[ "$overwrite" != "yes" && "$overwrite" != "y" ]]; then
    echo "Keeping existing config: $ENV_FILE"
    exit 0
  fi
fi

read -r -p "Enter your AGENT_REGISTRATION_TOKEN: " TOKEN_INPUT

if [[ -z "$TOKEN_INPUT" ]]; then
  echo "Error: token cannot be empty." >&2
  exit 1
fi

# Prepare env file
mkdir -p /etc/edgecoder
if [[ -f "$ENV_EXAMPLE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
else
  touch "$ENV_FILE"
fi

write_or_update_env "$ENV_FILE" "AGENT_REGISTRATION_TOKEN" "$TOKEN_INPUT"
write_or_update_env "$ENV_FILE" "EDGE_RUNTIME_MODE"        "worker"
write_or_update_env "$ENV_FILE" "COORDINATOR_URL"           "https://coordinator.edgecoder.io"
write_or_update_env "$ENV_FILE" "AGENT_OS"                  "linux"

chmod 600 "$ENV_FILE"

echo ""
echo "Config saved to: $ENV_FILE"
echo ""
echo "  Mode        : worker"
echo "  Coordinator : https://coordinator.edgecoder.io"
echo "  Token       : ${TOKEN_INPUT:0:8}...${TOKEN_INPUT: -4} (truncated)"
echo ""

# Restart service if available
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE" >/dev/null 2>&1 || true
  echo "Service restarted. Check status with: systemctl status $SERVICE"
else
  echo "Start the service with: sudo systemctl enable --now $SERVICE"
fi

echo ""
echo "View your nodes at: https://portal.edgecoder.io/portal/nodes"
echo "Edit config later:  sudo nano $ENV_FILE"
