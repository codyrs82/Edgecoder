#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder, LLC
# SPDX-License-Identifier: BUSL-1.1
#
# Build the prebuilt agent tarball that deploy/install.sh and deploy/install.ps1 install:
#
#   bash scripts/release/package-agent.sh <tag> <target> <out-dir>
#   e.g. bash scripts/release/package-agent.sh agent-v1.5.0 linux-x64 out/
#
# Run it on the target OS/arch (native modules such as better-sqlite3 are fetched or compiled
# for the Node running it, which must be the version pinned in the installers). It writes
# <out-dir>/edgecoder-agent-<tag>-<target>.tar.gz containing edgecoder/ with dist/, package.json,
# package-lock.json, production node_modules and edgecoder-release.json. Signing happens later,
# over SHA256SUMS of all targets (.github/workflows/agent-release.yml).
set -euo pipefail

TAG="${1:?usage: package-agent.sh <tag> <target> <out-dir>}"
TARGET="${2:?usage: package-agent.sh <tag> <target> <out-dir>}"
OUT="${3:?usage: package-agent.sh <tag> <target> <out-dir>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[[ "$TAG" =~ ^agent-v[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "tag must look like agent-v1.2.3, got $TAG" >&2; exit 1; }
case "$TARGET" in linux-x64|linux-arm64|darwin-x64|darwin-arm64|win-x64) ;; *) echo "unknown target $TARGET" >&2; exit 1 ;; esac

cd "$ROOT"
if [ "${SKIP_BUILD:-}" != 1 ]; then
  npm ci --no-audit --no-fund --loglevel=error
  npm run build
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/edgecoder"
mkdir -p "$STAGE"
cp -R dist "$STAGE/dist"
cp package.json package-lock.json "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
printf '{"tag":"%s","target":"%s","commit":"%s","node":"%s"}\n' "$TAG" "$TARGET" "$COMMIT" "$(node -p process.versions.node)" > "$STAGE/edgecoder-release.json"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
NAME="edgecoder-agent-$TAG-$TARGET.tar.gz"
(cd "$WORK" && tar -czf "$OUT/$NAME" edgecoder)
echo "$OUT/$NAME"
