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

# Install production dependencies only
echo "Installing production dependencies..."
npm ci --omit=dev --prefix "$RESOURCE_DIR"

echo "Agent bundled to: $RESOURCE_DIR"
du -sh "$RESOURCE_DIR"
