#!/usr/bin/env bash

set -euo pipefail

DEFAULT_MODEL="${OLLAMA_MODEL:-qwen2.5-coder:1.5b}"

ollama_bin() {
  local candidate
  if candidate="$(command -v ollama 2>/dev/null)"; then
    printf "%s\n" "$candidate"
    return 0
  fi
  for candidate in /usr/local/bin/ollama /opt/homebrew/bin/ollama; do
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
  echo "Installing Ollama (best-effort)..."
  if curl -fsSL https://ollama.com/install.sh | sh; then
    ollama_path="$(ollama_bin)" || true
    if [[ -n "${ollama_path:-}" ]]; then
      echo "Ollama installed at: $ollama_path"
    fi
  fi
  if [[ -z "${ollama_path:-}" ]]; then
    echo "Warning: automatic Ollama install did not complete."
    echo "Install manually from https://ollama.com/download if needed."
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
