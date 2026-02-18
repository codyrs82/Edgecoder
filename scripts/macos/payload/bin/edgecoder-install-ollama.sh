#!/usr/bin/env bash

set -euo pipefail

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

if ollama_path="$(ollama_bin)"; then
  echo "Ollama already installed at: $ollama_path"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install Ollama automatically."
  exit 0
fi

echo "Installing Ollama (best-effort)..."
if curl -fsSL https://ollama.com/install.sh | sh; then
  if ollama_path="$(ollama_bin)"; then
    echo "Ollama installed at: $ollama_path"
    exit 0
  fi
fi

echo "Warning: automatic Ollama install did not complete."
echo "Install manually from https://ollama.com/download if needed."
exit 0
