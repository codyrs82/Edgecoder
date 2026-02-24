#!/usr/bin/env bash
# build-ble-proxy.sh — compile the Swift BLE Central proxy for macOS
#
# Builds the edgecoder-ble-proxy binary from Swift source and installs it.
#
# Usage:
#   bash scripts/macos/build-ble-proxy.sh [--dest /custom/path]
#
# Default install destination: /opt/edgecoder/bin/edgecoder-ble-proxy
#
# Requirements: macOS 13+, Xcode Command Line Tools (swift 5.9+)
# The binary requires Bluetooth entitlements when distributed through an app;
# when run directly (as a background helper), macOS prompts for Bluetooth access
# via System Settings → Privacy & Security → Bluetooth.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PACKAGE_DIR="${REPO_ROOT}/src/bluetooth/swift-ble-proxy"
DEST="${1:-}"
if [[ -z "$DEST" ]]; then
  DEST="/opt/edgecoder/bin/edgecoder-ble-proxy"
fi
# Allow --dest flag
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "==> Building edgecoder-ble-proxy (Swift release)..."

# Verify swift is available
if ! command -v swift &>/dev/null; then
  echo "ERROR: swift not found. Install Xcode Command Line Tools:"
  echo "  xcode-select --install"
  exit 1
fi

SWIFT_VERSION=$(swift --version 2>&1 | head -1)
echo "    Swift: ${SWIFT_VERSION}"

# Build
cd "${PACKAGE_DIR}"
swift build -c release

BINARY="${PACKAGE_DIR}/.build/release/edgecoder-ble-proxy"
if [[ ! -f "${BINARY}" ]]; then
  echo "ERROR: Build succeeded but binary not found at ${BINARY}"
  exit 1
fi

echo "==> Build complete: ${BINARY}"

# Install
DEST_DIR="$(dirname "${DEST}")"
if [[ ! -d "${DEST_DIR}" ]]; then
  echo "==> Creating ${DEST_DIR}..."
  sudo mkdir -p "${DEST_DIR}"
fi

echo "==> Installing to ${DEST}..."
if [[ -w "${DEST_DIR}" ]]; then
  cp "${BINARY}" "${DEST}"
else
  sudo cp "${BINARY}" "${DEST}"
fi
chmod +x "${DEST}"

echo ""
echo "✓ edgecoder-ble-proxy installed to: ${DEST}"
echo ""
echo "The IDE provider server (port 4304) will auto-detect and launch it."
echo "To test manually:"
echo "  ${DEST} --port 11435"
echo "  curl http://127.0.0.1:11435/status"
echo ""
echo "Environment variables:"
echo "  BT_PROXY_PORT   — proxy HTTP port (default: 11435)"
echo "  BT_PROXY_HOST   — proxy host (default: 127.0.0.1)"
echo "  BT_STATUS_URL   — auto-set by provider-server to http://127.0.0.1:BT_PROXY_PORT/status"
