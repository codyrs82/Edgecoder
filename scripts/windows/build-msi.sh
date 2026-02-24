#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/windows"
STAGE_APP="$BUILD_DIR/stage-app"
PAYLOAD_DIR="$ROOT_DIR/scripts/windows/payload"
WXS_FILE="$ROOT_DIR/scripts/windows/edgecoder.wxs"
VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || true)}"

if [[ -z "${VERSION}" ]]; then
  echo "Unable to determine package version."
  echo "Pass it explicitly: scripts/windows/build-msi.sh <version>"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to prepare runtime dependencies."
  exit 1
fi

echo "Preparing EdgeCoder Windows MSI build v${VERSION}..."
rm -rf "$BUILD_DIR"
mkdir -p \
  "$BUILD_DIR/msi-stage/app" \
  "$BUILD_DIR/msi-stage/bin" \
  "$BUILD_DIR/msi-stage/config"

echo "Building project..."
npm run build --prefix "$ROOT_DIR"

echo "Staging production runtime..."
mkdir -p "$STAGE_APP"
cp -R "$ROOT_DIR/dist" "$STAGE_APP/dist"
cp "$ROOT_DIR/package.json" "$STAGE_APP/package.json"
cp "$ROOT_DIR/package-lock.json" "$STAGE_APP/package-lock.json"
npm ci --omit=dev --prefix "$STAGE_APP"

echo "Copying application payload..."
cp -R "$STAGE_APP/." "$BUILD_DIR/msi-stage/app/"

# Copy runtime script
cp "$PAYLOAD_DIR/bin/edgecoder-runtime.ps1" "$BUILD_DIR/msi-stage/bin/edgecoder-runtime.ps1"

# Copy configure script if it exists (created by Task 3)
if [[ -f "$PAYLOAD_DIR/bin/edgecoder-configure.ps1" ]]; then
  cp "$PAYLOAD_DIR/bin/edgecoder-configure.ps1" "$BUILD_DIR/msi-stage/bin/edgecoder-configure.ps1"
fi

# Copy WiX manifest into build directory with version substituted
sed "s/{{VERSION}}/${VERSION}/g" "$WXS_FILE" > "$BUILD_DIR/edgecoder.wxs"

echo ""
echo "Build staging complete."
echo ""
echo "Staged files:"
echo "  $BUILD_DIR/msi-stage/app/    - Application runtime"
echo "  $BUILD_DIR/msi-stage/bin/    - Launcher scripts"
echo "  $BUILD_DIR/msi-stage/config/ - Configuration templates"
echo "  $BUILD_DIR/edgecoder.wxs     - WiX manifest (v${VERSION})"
echo ""
echo "To build the .msi installer, run one of the following:"
echo ""
echo "  Option A - WiX Toolset (Windows):"
echo "    candle.exe -nologo -out $BUILD_DIR\\edgecoder.wixobj $BUILD_DIR\\edgecoder.wxs"
echo "    light.exe  -nologo -out $ROOT_DIR\\build\\EdgeCoder-${VERSION}-windows.msi $BUILD_DIR\\edgecoder.wixobj"
echo ""
echo "  Option B - msitools (Linux cross-compile):"
echo "    wixl -o $ROOT_DIR/build/EdgeCoder-${VERSION}-windows.msi $BUILD_DIR/edgecoder.wxs"
echo ""
