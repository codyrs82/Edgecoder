#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/linux"
PKGROOT="$BUILD_DIR/pkgroot"
STAGE_APP="$BUILD_DIR/stage-app"
SCRIPTS_DIR="$ROOT_DIR/scripts/linux/package-scripts"
PAYLOAD_DIR="$ROOT_DIR/scripts/linux/payload"
VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || true)}"

if [[ -z "${VERSION}" ]]; then
  echo "Unable to determine package version."
  echo "Pass it explicitly: scripts/linux/build-deb.sh <version>"
  exit 1
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb is required (install with: apt-get install dpkg)."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to prepare runtime dependencies."
  exit 1
fi

echo "Preparing EdgeCoder Linux .deb package v${VERSION}..."
rm -rf "$BUILD_DIR"
mkdir -p \
  "$PKGROOT/DEBIAN" \
  "$PKGROOT/usr/lib/edgecoder/app" \
  "$PKGROOT/usr/lib/edgecoder/bin" \
  "$PKGROOT/etc/edgecoder" \
  "$PKGROOT/lib/systemd/system" \
  "$PKGROOT/var/log/edgecoder"

echo "Building project..."
npm run build --prefix "$ROOT_DIR"

echo "Staging production runtime..."
mkdir -p "$STAGE_APP"
cp -R "$ROOT_DIR/dist" "$STAGE_APP/dist"
cp "$ROOT_DIR/package.json" "$STAGE_APP/package.json"
cp "$ROOT_DIR/package-lock.json" "$STAGE_APP/package-lock.json"
npm ci --omit=dev --prefix "$STAGE_APP"

echo "Copying application payload..."
cp -R "$STAGE_APP/." "$PKGROOT/usr/lib/edgecoder/app/"
cp "$PAYLOAD_DIR/bin/edgecoder-runtime.sh" "$PKGROOT/usr/lib/edgecoder/bin/edgecoder-runtime.sh"
cp "$PAYLOAD_DIR/bin/edgecoder-configure.sh" "$PKGROOT/usr/lib/edgecoder/bin/edgecoder-configure.sh"
cp "$PAYLOAD_DIR/bin/edgecoder-install-ollama.sh" "$PKGROOT/usr/lib/edgecoder/bin/edgecoder-install-ollama.sh"
cp "$PAYLOAD_DIR/etc/edgecoder/edgecoder.env.example" "$PKGROOT/etc/edgecoder/edgecoder.env.example"
cp "$PAYLOAD_DIR/lib/systemd/system/edgecoder.service" "$PKGROOT/lib/systemd/system/edgecoder.service"

# Ollama systemd service managed by EdgeCoder
OLLAMA_SERVICE_SRC="$ROOT_DIR/scripts/linux/edgecoder-ollama.service"
if [[ -f "$OLLAMA_SERVICE_SRC" ]]; then
  cp "$OLLAMA_SERVICE_SRC" "$PKGROOT/usr/lib/edgecoder/edgecoder-ollama.service"
  chmod 644 "$PKGROOT/usr/lib/edgecoder/edgecoder-ollama.service"
fi

echo "Writing DEBIAN control files..."
cat > "$PKGROOT/DEBIAN/control" <<CONTROL
Package: edgecoder
Version: ${VERSION}
Architecture: amd64
Maintainer: EdgeCoder <ops@edgecoder.io>
Depends: nodejs (>= 20)
Section: utils
Priority: optional
Description: EdgeCoder agent/coordinator runtime
 EdgeCoder is a distributed AI coding agent platform. This package
 installs the EdgeCoder runtime daemon which can operate as a swarm
 agent (worker) or a coordinator, controlled by the EDGE_RUNTIME_MODE
 environment variable in /etc/edgecoder/edgecoder.env.
CONTROL

cp "$SCRIPTS_DIR/preinst" "$PKGROOT/DEBIAN/preinst"
cp "$SCRIPTS_DIR/postinst" "$PKGROOT/DEBIAN/postinst"

chmod 755 "$PKGROOT/usr/lib/edgecoder/bin/edgecoder-runtime.sh"
chmod 755 "$PKGROOT/usr/lib/edgecoder/bin/edgecoder-configure.sh"
chmod 755 "$PKGROOT/usr/lib/edgecoder/bin/edgecoder-install-ollama.sh"
chmod 755 "$PKGROOT/DEBIAN/preinst" "$PKGROOT/DEBIAN/postinst"
chmod 644 "$PKGROOT/lib/systemd/system/edgecoder.service"
chmod 755 "$PKGROOT/var/log/edgecoder"

OUTPUT_DEB="$ROOT_DIR/build/EdgeCoder-${VERSION}-linux-amd64.deb"
echo "Building package: $OUTPUT_DEB"
dpkg-deb --build --root-owner-group "$PKGROOT" "$OUTPUT_DEB"

echo ""
echo "Package created:"
echo "  $OUTPUT_DEB"
echo ""
echo "Install with: sudo dpkg -i $OUTPUT_DEB"
