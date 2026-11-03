#!/usr/bin/env bash
# scripts/bundle-agent-resources.sh
# Copies the compiled agent runtime into Tauri's resource directory
# so the .app bundle is self-contained.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$ROOT_DIR/desktop/src-tauri/resources/agent"

echo "=== Bundling agent into Tauri resources ==="

# Clean previous bundle
rm -rf "$RESOURCE_DIR"
mkdir -p "$RESOURCE_DIR"

# Build the TypeScript project
echo "Building TypeScript..."
npm run build --prefix "$ROOT_DIR"

# Copy compiled output
cp -R "$ROOT_DIR/dist" "$RESOURCE_DIR/dist"
cp "$ROOT_DIR/package.json" "$RESOURCE_DIR/package.json"
cp "$ROOT_DIR/package-lock.json" "$RESOURCE_DIR/package-lock.json"

# Install production dependencies (--ignore-scripts to avoid BLE native
# module build failures), then rebuild just better-sqlite3 which needs its
# native binding for the worker's SQLite store.
echo "Installing production dependencies..."
npm ci --omit=dev --ignore-scripts --prefix "$RESOURCE_DIR"

echo "Rebuilding better-sqlite3 native binding..."
cd "$RESOURCE_DIR" && npx --yes node-gyp-build node_modules/better-sqlite3 2>/dev/null \
  || npm rebuild better-sqlite3 --prefix "$RESOURCE_DIR"
cd "$ROOT_DIR"

# BLE mesh: noble (scan) and bleno (advertise) are native and were skipped by --ignore-scripts.
# Build them against the Node shipped below, so the app's agent can use Bluetooth. Best effort:
# without them the agent runs with BLE off and says so in its log.
echo "Building Bluetooth (BLE mesh) native modules..."
for mod in @abandonware/noble @abandonware/bleno; do
  if [ -d "$RESOURCE_DIR/node_modules/$mod" ]; then
    (cd "$RESOURCE_DIR/node_modules/$mod" && npx --yes node-gyp rebuild >/dev/null 2>&1) \
      && echo "  built $mod" \
      || echo "  WARNING: could not build $mod; BLE mesh will be off in this build"
  fi
done
"$(node -p 'process.execPath')" -e "require('$RESOURCE_DIR/node_modules/@abandonware/noble'); require('$RESOURCE_DIR/node_modules/@abandonware/bleno'); console.log('  BLE modules load'); process.exit(0)" 2>/dev/null \
  || echo "  WARNING: BLE modules don't load with the bundled Node"

# Ship the Node runtime the native modules were just built against, so the app doesn't depend
# on a Node install on the user's machine (the desktop shell prefers this one).
NODE_BIN="$(node -p 'process.execPath')"
mkdir -p "$RESOURCE_DIR/node"
case "$NODE_BIN" in
  *.exe) cp "$NODE_BIN" "$RESOURCE_DIR/node/node.exe" ;;
  *) cp "$NODE_BIN" "$RESOURCE_DIR/node/node" && chmod 755 "$RESOURCE_DIR/node/node" ;;
esac
echo "Bundled Node $(node -v) from $NODE_BIN"

# macOS notarization: every binary in the bundle must be signed with the Developer ID, the hardened
# runtime and a secure timestamp. Tauri signs the app, not these resources, so sign the bundled Node
# and every native module (.node, .dylib) here when a signing identity is available (the release
# workflow imports the certificate and sets EDGECODER_CODESIGN_IDENTITY).
if [ "$(uname)" = "Darwin" ] && [ -n "${EDGECODER_CODESIGN_IDENTITY:-}" ]; then
  ENTITLEMENTS="$ROOT_DIR/desktop/src-tauri/agent-node.entitlements"
  signed=0
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q "Mach-O"; then
      if [ "$f" = "$RESOURCE_DIR/node/node" ]; then
        codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$EDGECODER_CODESIGN_IDENTITY" "$f"
      else
        codesign --force --options runtime --timestamp --sign "$EDGECODER_CODESIGN_IDENTITY" "$f"
      fi
      signed=$((signed + 1))
    fi
  done < <(find "$RESOURCE_DIR" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -perm -u+x \) -print0)
  echo "Signed $signed binaries in the agent bundle for notarization"
  # Every Mach-O must now verify, or notarization rejects the app.
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q "Mach-O" || continue
    codesign --verify --strict "$f" || { echo "ERROR: $f did not verify after signing"; exit 1; }
  done < <(find "$RESOURCE_DIR" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -perm -u+x \) -print0)
fi

echo "Agent bundled to: $RESOURCE_DIR"
du -sh "$RESOURCE_DIR"
