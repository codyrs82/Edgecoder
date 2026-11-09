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
SERVICE_USER="_edgecoder"
MODELS_DIR="/var/lib/edgecoder/ollama"

# True when PATH resolves to a file that root alone can change: it and every directory above it
# are owned by root and not group- or world-writable (the same rule as src/install/binaries.ts).
# Package scripts run as root and must never execute a binary another user could swap
# (Homebrew under /opt/homebrew or /usr/local, nvm under $HOME, /Applications).
root_controlled() {
  local p="$1" st
  [[ -e "$p" ]] || return 1
  if command -v realpath >/dev/null 2>&1; then p="$(realpath "$p")" || return 1
  elif [[ -L "$p" ]]; then return 1; fi
  while :; do
    st="$(stat -f '%u %Lp' "$p" 2>/dev/null)" || return 1
    [[ "${st%% *}" == 0 ]] || return 1
    (( (8#${st##* } & 8#022) == 0 )) || return 1
    [[ "$p" == / ]] && return 0
    p="$(dirname "$p")"
  done
}

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

run_ollama() { "$ollama_path" "$@"; }

# --- Install Ollama binary ---
if [[ "$(id -u)" -eq 0 ]]; then
  # As root (the .pkg postinstall), never run an ollama another user can replace (Homebrew,
  # /Applications/Ollama.app): use only the pinned, root-owned copy, which the
  # io.edgecoder.ollama daemon also runs. Serve and pull as the service account, not root.
  ollama_path="$OLLAMA_DIR/ollama"
  if ! { [[ -x "$ollama_path" ]] && root_controlled "$ollama_path"; }; then
    command -v curl >/dev/null 2>&1 || { echo "curl is required to install Ollama automatically."; exit 0; }
    echo "Installing Ollama $OLLAMA_VERSION from the pinned release archive..."
    if ! install_pinned_ollama || ! root_controlled "$ollama_path"; then
      echo "Warning: automatic Ollama install did not complete."
      exit 0
    fi
  fi
  echo "Ollama at: $ollama_path"
  if ! dscl . -read "/Users/$SERVICE_USER" UniqueID >/dev/null 2>&1; then
    echo "Service account $SERVICE_USER missing; the model will be pulled on first use."
    exit 0
  fi
  run_ollama() { /usr/bin/sudo -u "$SERVICE_USER" /usr/bin/env HOME="$MODELS_DIR" OLLAMA_MODELS="$MODELS_DIR" "$ollama_path" "$@"; }
elif ollama_path="$(ollama_bin)"; then
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
    run_ollama serve >/dev/null 2>&1 &
  fi
  sleep 1
done

if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  if run_ollama pull "$DEFAULT_MODEL"; then
    echo "Model $DEFAULT_MODEL pulled successfully."
  else
    echo "Warning: could not pull $DEFAULT_MODEL. It will be pulled on first use."
  fi
else
  echo "Warning: Ollama not responding. Model will be pulled on first use."
fi

exit 0
