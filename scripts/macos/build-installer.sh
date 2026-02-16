#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/macos"
PKGROOT="$BUILD_DIR/pkgroot"
STAGE_APP="$BUILD_DIR/stage-app"
SCRIPTS_DIR="$ROOT_DIR/scripts/macos/package-scripts"
PAYLOAD_DIR="$ROOT_DIR/scripts/macos/payload"
VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || true)}"

if [[ -z "${VERSION}" ]]; then
  echo "Unable to determine package version."
  echo "Pass it explicitly: scripts/macos/build-installer.sh <version>"
  exit 1
fi

if ! command -v pkgbuild >/dev/null 2>&1; then
  echo "pkgbuild is required (Xcode command line tools)."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to prepare runtime dependencies."
  exit 1
fi

echo "Preparing EdgeCoder macOS installer v${VERSION}..."
rm -rf "$BUILD_DIR"
mkdir -p "$PKGROOT/opt/edgecoder" "$PKGROOT/etc/edgecoder" "$BUILD_DIR"

echo "Building project..."
npm run build --prefix "$ROOT_DIR"

echo "Staging production runtime..."
mkdir -p "$STAGE_APP"
cp -R "$ROOT_DIR/dist" "$STAGE_APP/dist"
cp "$ROOT_DIR/package.json" "$STAGE_APP/package.json"
cp "$ROOT_DIR/package-lock.json" "$STAGE_APP/package-lock.json"
npm ci --omit=dev --prefix "$STAGE_APP"

echo "Copying payload..."
cp -R "$STAGE_APP" "$PKGROOT/opt/edgecoder/app"
cp -R "$PAYLOAD_DIR/bin" "$PKGROOT/opt/edgecoder/bin"
cp -R "$PAYLOAD_DIR/opt/edgecoder/install" "$PKGROOT/opt/edgecoder/install"
cp "$PAYLOAD_DIR/etc/edgecoder/edgecoder.env.example" "$PKGROOT/etc/edgecoder/edgecoder.env.example"

chmod 755 "$PKGROOT/opt/edgecoder/bin/edgecoder-runtime.sh"
chmod 755 "$SCRIPTS_DIR/preinstall" "$SCRIPTS_DIR/postinstall"

OUTPUT_PKG="$ROOT_DIR/build/EdgeCoder-${VERSION}-macos-installer.pkg"
echo "Building package: $OUTPUT_PKG"
pkgbuild \
  --root "$PKGROOT" \
  --identifier "io.edgecoder.runtime" \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --install-location "/" \
  "$OUTPUT_PKG"

echo ""
echo "Installer created:"
echo "  $OUTPUT_PKG"
