#!/usr/bin/env bash
# #70: build the VS Code extension .vsix from source, as the vscode-v* release does.
#   bash scripts/release/package-vscode.sh vscode-v0.1.0 out   # release: tag must match the version
#   bash scripts/release/package-vscode.sh "" out              # local/PR build: no tag check
# Writes <outdir>/edgecoder-vscode-<version>.vsix and <outdir>/SHA256SUMS. Uses the extension's
# own lockfile (npm ci) and the @vscode/vsce pinned there; nothing is downloaded at a floating version.
set -euo pipefail
TAG="${1:-}"
OUT="${2:-out}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXT="$ROOT/extensions/vscode"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

VERSION="$(node -p "require('$EXT/package.json').version")"
if [ -n "$TAG" ]; then
  [[ "$TAG" =~ ^vscode-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "bad tag $TAG (expected vscode-vX.Y.Z)" >&2; exit 1; }
  [ "${TAG#vscode-v}" = "$VERSION" ] || { echo "tag $TAG does not match extensions/vscode/package.json version $VERSION; bump the version first" >&2; exit 1; }
fi

cd "$EXT"
# Install scripts are not needed: the extension is plain tsc output with no runtime dependencies.
npm ci --ignore-scripts --no-audit --no-fund
npm run compile
VSIX="edgecoder-vscode-${VERSION}.vsix"
# vscode:prepublish compiles again inside vsce; --no-dependencies because the extension bundles none.
npm run package -- --out "$OUT/$VSIX"

# Fail if build output we never want to ship slipped in (source maps, sources, node_modules).
listing="$(npx --no-install vsce ls --no-dependencies)"
if printf '%s\n' "$listing" | grep -Eq '(^|/)(src/|node_modules/)|\.map$'; then
  printf '%s\n' "$listing" >&2
  echo "unexpected files in the .vsix (see .vscodeignore)" >&2
  exit 1
fi

cd "$OUT"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$VSIX" > SHA256SUMS; else shasum -a 256 "$VSIX" > SHA256SUMS; fi
cat SHA256SUMS
