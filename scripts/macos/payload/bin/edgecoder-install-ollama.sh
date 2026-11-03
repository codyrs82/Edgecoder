#!/usr/bin/env bash

set -euo pipefail

DEFAULT_MODEL="${OLLAMA_MODEL:-qwen3.5:9b}"

# Ollama comes only from its official release archive, pinned to this version and SHA-256
# (source of truth: src/install/ollama-pins.ts; tests/install/ollama-pins.test.ts keeps these in
# sync). Nothing downloaded is piped into a shell.
OLLAMA_VERSION=0.40.7
OLLAMA_ASSET="ollama-darwin.tgz"
OLLAMA_SHA256="6c8b378e423a4c959b586c0bb62865d20ae057e817f1a8ee10abcc44bde6abab"
OLLAMA_DIR="/opt/edgecoder/ollama"

install_pinned_ollama() {
  local tmp got
  tmp="$(mktemp -d)"
  if ! curl -fsSL --proto '=https' -o "$tmp/$OLLAMA_ASSET" "https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/$OLLAMA_ASSET"; then
    rm -rf "$tmp"; echo "Download of $OLLAMA_ASSET failed."; return 1
  fi
  got="$(shasum -a 256 "$tmp/$OLLAMA_ASSET" | awk '{print $1}')"
  if [[ "$got" != "$OLLAMA_SHA256" ]]; then
    rm -rf "$tmp"; echo "Checksum mismatch for $OLLAMA_ASSET (expected $OLLAMA_SHA256, got $got); not installing it."; return 1
  fi
  # Root-owned, outside /usr/local (which Homebrew makes user-writable on Intel Macs).
  rm -rf "$OLLAMA_DIR" && mkdir -p "$OLLAMA_DIR"
  tar -xzf "$tmp/$OLLAMA_ASSET" -C "$OLLAMA_DIR" --no-same-owner
  if [[ "$(id -u)" -eq 0 ]]; then chown -R root:wheel "$OLLAMA_DIR" && chmod -R go-w "$OLLAMA_DIR"; fi
  rm -rf "$tmp"
}

ollama_bin() {
  local candidate
  if candidate="$(command -v ollama 2>/dev/null)"; then
    printf "%s\n" "$candidate"
    return 0
  fi
  for candidate in /opt/edgecoder/ollama/ollama /usr/local/bin/ollama /opt/homebrew/bin/ollama; do
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

# --- Pull default model ---
echo "Pulling default model: $DEFAULT_MODEL ..."

# Ensure Ollama is serving (wait up to 15s)
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    break
  fi
  if [[ $i -eq 1 ]]; then
    echo "Waiting for Ollama to be ready..."
    # Start ollama serve in background if not already running
    "$ollama_path" serve >/dev/null 2>&1 &
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
