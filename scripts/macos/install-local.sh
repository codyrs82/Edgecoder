#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_PATH="${1:-$ROOT_DIR/build/EdgeCoder-$(node -p "require('$ROOT_DIR/package.json').version")-macos-installer.pkg}"

if [[ ! -f "$PKG_PATH" ]]; then
  echo "Installer package not found at:"
  echo "  $PKG_PATH"
  echo "Building installer first..."
  npm run build:macos-installer --prefix "$ROOT_DIR"
fi

echo "Installing package:"
echo "  $PKG_PATH"
sudo installer -pkg "$PKG_PATH" -target /

echo
echo "Starting interactive EdgeCoder configuration wizard..."
sudo /opt/edgecoder/bin/edgecoder-configure.sh

echo
echo "Ensuring Ollama is installed (best-effort)..."
sudo /opt/edgecoder/bin/edgecoder-install-ollama.sh

echo
echo "Restarting service with updated config..."
sudo launchctl kickstart -k system/io.edgecoder.runtime

echo
echo "Done. Useful checks:"
echo "  sudo launchctl print system/io.edgecoder.runtime"
echo "  sudo tail -f /var/log/edgecoder/runtime.log /var/log/edgecoder/runtime.err.log"
