#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder, LLC
# SPDX-License-Identifier: BUSL-1.1
#
# sign-release.sh — Run in CI after build to create a signed release manifest.
#
# Required environment variables:
#   RELEASE_SIGNING_PRIVATE_KEY — Base64-encoded Ed25519 private key PEM
#
# Usage:
#   ./scripts/sign-release.sh [version]
#
# Output:
#   release-manifest.json  — Manifest with artifacts, hashes, and version
#   release-manifest.sig   — Ed25519 signature over the manifest

set -euo pipefail

VERSION="${1:-$(node -p "require('./package.json').version")}"
DIST_DIR="${DIST_DIR:-dist}"
BUILD_DIR="${BUILD_DIR:-build}"

if [ -z "${RELEASE_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "ERROR: RELEASE_SIGNING_PRIVATE_KEY not set" >&2
  exit 1
fi

echo "==> Computing dist tree hash for ${DIST_DIR}/"
HASH_OUTPUT=$(npx tsx scripts/compute-dist-hash.ts "${DIST_DIR}")
DIST_TREE_HASH=$(echo "${HASH_OUTPUT}" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).distTreeHash")

echo "==> Dist tree hash: ${DIST_TREE_HASH}"

# Compute per-artifact SHA-256 for release assets
ARTIFACTS="[]"
if [ -d "${BUILD_DIR}" ]; then
  ARTIFACTS=$(find "${BUILD_DIR}" -type f \( -name "*.pkg" -o -name "*.deb" -o -name "*.msi" \) | sort | while read -r f; do
    NAME=$(basename "$f")
    HASH=$(sha256sum "$f" | cut -d' ' -f1)
    echo "{\"name\":\"${NAME}\",\"sha256\":\"${HASH}\"}"
  done | jq -s '.')
fi

# Build release manifest
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MANIFEST=$(jq -n \
  --arg version "${VERSION}" \
  --arg distTreeHash "${DIST_TREE_HASH}" \
  --arg timestamp "${TIMESTAMP}" \
  --argjson artifacts "${ARTIFACTS}" \
  '{version: $version, artifacts: $artifacts, distTreeHash: $distTreeHash, timestamp: $timestamp}')

echo "${MANIFEST}" > release-manifest.json
echo "==> Created release-manifest.json"

# Sign the manifest with Ed25519
TMPKEY=$(mktemp)
echo "${RELEASE_SIGNING_PRIVATE_KEY}" | base64 -d > "${TMPKEY}"
SIGNATURE=$(openssl pkeyutl -sign -inkey "${TMPKEY}" \
  -rawin -in <(echo -n "${MANIFEST}") | base64 -w0 2>/dev/null || \
  openssl pkeyutl -sign -inkey "${TMPKEY}" \
  -rawin -in <(echo -n "${MANIFEST}") | base64)
rm -f "${TMPKEY}"

echo "${SIGNATURE}" > release-manifest.sig
echo "==> Created release-manifest.sig"
echo "==> Release signing complete for v${VERSION}"
