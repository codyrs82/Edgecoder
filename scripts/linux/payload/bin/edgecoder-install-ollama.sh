#!/usr/bin/env bash

set -euo pipefail

DEFAULT_MODEL="${OLLAMA_MODEL:-qwen3.5:9b}"
OLLAMA_SERVICE="edgecoder-ollama"
OLLAMA_SERVICE_FILE="/etc/systemd/system/${OLLAMA_SERVICE}.service"
OLLAMA_SERVICE_SRC="/usr/lib/edgecoder/edgecoder-ollama.service"

# Ollama comes only from its official release archive, pinned to this version and SHA-256
# (source of truth: src/install/ollama-pins.ts; tests/install/ollama-pins.test.ts keeps these in
# sync). Nothing downloaded is piped into a shell.
OLLAMA_VERSION=0.40.7
ollama_asset() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "ollama-linux-amd64.tar.zst 7f082e625b4c334df84ed1558fe282d6d8091fe3545790aef30b3a9c50d44d41" ;;
    aarch64|arm64) echo "ollama-linux-arm64.tar.zst c74249e87795b1437ce0f484adfd05b4628d7497472c475b13ec6db69ecc69cf" ;;
    *) return 1 ;;
  esac
}

install_pinned_ollama() {
  local spec name sum tmp got
  spec="$(ollama_asset)" || { echo "No pinned Ollama build for $(uname -m)."; return 1; }
  name="${spec%% *}"; sum="${spec##* }"
  command -v zstd >/dev/null 2>&1 || { echo "zstd is required to unpack Ollama's release archive."; return 1; }
  tmp="$(mktemp -d)"
  if ! curl -fsSL --proto '=https' -o "$tmp/$name" "https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/$name"; then
    rm -rf "$tmp"; echo "Download of $name failed."; return 1
  fi
  got="$(sha256sum "$tmp/$name" | awk '{print $1}')"
  if [[ "$got" != "$sum" ]]; then
    rm -rf "$tmp"; echo "Checksum mismatch for $name (expected $sum, got $got); not installing it."; return 1
  fi
  # The layout Ollama's own installer uses: /usr/local/bin/ollama and /usr/local/lib/ollama.
  rm -rf /usr/local/lib/ollama
  zstd -q -dc "$tmp/$name" | tar -xf - -C /usr/local --no-same-owner
  rm -rf "$tmp"
}

ollama_bin() {
  local candidate
  if candidate="$(command -v ollama 2>/dev/null)"; then
    printf "%s\n" "$candidate"
    return 0
  fi
  for candidate in /usr/local/bin/ollama /usr/bin/ollama; do
    if [[ -x "$candidate" ]]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done
  return 1
}

# --- Install Ollama binary ---
if ollama_path="$(ollama_bin)"; then
  echo "Ollama already installed at: $ollama_path"
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install Ollama automatically."
    exit 0
  fi
  echo "Installing Ollama $OLLAMA_VERSION from the pinned release archive..."
  if install_pinned_ollama; then
    ollama_path="$(ollama_bin)" || true
    if [[ -n "${ollama_path:-}" ]]; then
      echo "Ollama installed at: $ollama_path"
    fi
  fi
  if [[ -z "${ollama_path:-}" ]]; then
    echo "Warning: automatic Ollama install did not complete."
    echo "Install Ollama manually (https://github.com/ollama/ollama/releases) if needed."
    exit 0
  fi
fi

# --- Install and enable the systemd service for Ollama ---
if command -v systemctl >/dev/null 2>&1; then
  if [[ -f "$OLLAMA_SERVICE_SRC" && ! -f "$OLLAMA_SERVICE_FILE" ]]; then
    echo "Installing ${OLLAMA_SERVICE} systemd service..."
    cp "$OLLAMA_SERVICE_SRC" "$OLLAMA_SERVICE_FILE"
    chmod 644 "$OLLAMA_SERVICE_FILE"
    systemctl daemon-reload
  fi

  # Create the ollama user/group if not present.
  if ! id -u ollama >/dev/null 2>&1; then
    useradd -r -s /bin/false -U -m -d /usr/share/ollama ollama 2>/dev/null || true
  fi

  systemctl enable "$OLLAMA_SERVICE" >/dev/null 2>&1 || true
  systemctl start "$OLLAMA_SERVICE" >/dev/null 2>&1 || true
fi

# --- Pull default model ---
echo "Pulling default model: $DEFAULT_MODEL ..."

# Ensure Ollama is serving (wait up to 15s)
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    break
  fi
  if [[ $i -eq 1 ]]; then
    echo "Waiting for Ollama to be ready..."
    # If systemd didn't start it, try starting directly as a fallback
    if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      "$ollama_path" serve >/dev/null 2>&1 &
    fi
  fi
  sleep 1
done

if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  if "$ollama_path" pull "$DEFAULT_MODEL"; then
    echo "Model $DEFAULT_MODEL pulled successfully."
  else
    echo "Warning: could not pull $DEFAULT_MODEL. It will be pulled on first use."
  fi
else
  echo "Warning: Ollama not responding. Model will be pulled on first use."
fi

exit 0
