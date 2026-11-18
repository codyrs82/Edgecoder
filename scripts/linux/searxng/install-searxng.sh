#!/usr/bin/env bash
# Install SearXNG for an EdgeCoder host's local web search (docs/web-tool.md, "Searches on your own
# machine"). edgecoder-install apply runs this; it writes the settings and the unit itself
# (src/install/searxng.ts).
#
#   sudo scripts/linux/searxng/install-searxng.sh --commit <40-hex sha> --sha256 <64-hex> [--lock FILE]
#
# The release tarball carries only dist/, so edgecoder-install writes this script and the lock
# from src/install/searxng-assets.ts (generated from these files by gen-assets.mjs; a test keeps
# them equal) into /opt/edgecoder/searxng/installer/ and runs them from there.
#
# What it does (re-runnable; nothing when the pinned commit is already installed):
#   - needs Python 3.11 or newer (SearXNG uses tomllib, typing.NotRequired…): the system python3 when
#     it is 3.11+ (installing python3-venv from the distribution when missing), else a pinned
#     python-build-standalone CPython (PBS_* below), downloaded over https and checked by sha256
#     before unpacking into /opt/edgecoder/searxng/python-<version> (Ubuntu 22.04 ships 3.10);
#   - downloads https://github.com/searxng/searxng/archive/<commit>.tar.gz over https only, checks
#     its sha256 before unpacking, unpacks it root-owned into /opt/edgecoder/searxng/src-<commit>;
#   - builds a venv (/opt/edgecoder/searxng/venv-<commit>-<lock>) from requirements.lock with pip --require-hashes --only-binary=:all: (every wheel hash-pinned, nothing
#     compiled);
#   - points the venv and current symlinks at them, and keeps the previous ones only.
# Exit 0 when SearXNG is ready to start; non-zero (and nothing switched) otherwise.
set -euo pipefail

PREFIX=/opt/edgecoder/searxng
LOCK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/requirements.lock"   # --lock overrides
commit=""
sha256=""

die() { echo "install-searxng: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --commit) commit="${2:-}"; shift 2 ;;
    --sha256) sha256="${2:-}"; shift 2 ;;
    --lock) LOCK="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "--commit must be a full 40-character commit hash"
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || die "--sha256 must be 64 hex characters"
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -r "$LOCK" ] || die "missing $LOCK"

# Standalone CPython for hosts whose python3 is older than 3.11 (astral-sh/python-build-standalone,
# install_only_stripped, glibc). Checksums from the release's SHA256SUMS.
PBS_RELEASE=20261026
PBS_VERSION=3.12.16
case "$(uname -m)" in
  x86_64|amd64) PBS_ARCH=x86_64; PBS_SHA256=ce4f6d0a6cfdb3bed6e44c2f9affd85943c76a42e25ad3a259002f31d6fb8a20 ;;
  aarch64|arm64) PBS_ARCH=aarch64; PBS_SHA256=bb4b6392670c5d3f93876996fcaa19858a4a413a0c7720144c18b0d6f1f0db2d ;;
  *) PBS_ARCH=""; PBS_SHA256="" ;;
esac
system_python_ok() { command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)'; }
if system_python_ok; then
  PY=python3
  pyid="system$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
else
  PY="$PREFIX/python-$PBS_VERSION/bin/python3"
  pyid="pbs$PBS_VERSION"
fi

src="$PREFIX/src-$commit"
marker="$PREFIX/installed"
want="$commit $(sha256sum "$LOCK" | cut -d' ' -f1) $pyid"
if [ -r "$marker" ] && [ "$(cat "$marker")" = "$want" ] && [ -x "$PREFIX/venv/bin/granian" ] && [ "$(readlink "$PREFIX/current" || true)" = "$src" ]; then
  echo "install-searxng: SearXNG ${commit:0:12} is installed"
  exit 0
fi

# ---- Python 3.11+ with venv (the standalone one is fetched below, once the work dir exists) ----
export DEBIAN_FRONTEND=noninteractive
if [ "$PY" = python3 ] && ! python3 -c 'import ensurepip, venv' >/dev/null 2>&1; then
  command -v apt-get >/dev/null || die "python3 has no venv module and there is no apt-get to install it"
  pyver="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  echo "install-searxng: apt-get install python${pyver}-venv"
  apt-get update -q
  apt-get install -y -q "python${pyver}-venv" || apt-get install -y -q python3-venv
fi
command -v curl >/dev/null || die "curl not found"
command -v sha256sum >/dev/null || die "sha256sum not found"

install -d -m 0755 "$PREFIX"
work="$(mktemp -d "$PREFIX/.install-XXXXXX")"
trap 'rm -rf "$work"' EXIT

# ---- the pinned standalone Python, verified before it is unpacked (python3 older than 3.11) ----
if [ "$PY" != python3 ] && [ ! -x "$PY" ]; then
  [ -n "$PBS_ARCH" ] || die "python3 is $(python3 -V 2>&1 || echo missing) and there is no standalone Python for $(uname -m); SearXNG needs 3.11 or newer"
  pbs="cpython-$PBS_VERSION+$PBS_RELEASE-$PBS_ARCH-unknown-linux-gnu-install_only_stripped.tar.gz"
  echo "install-searxng: python3 is older than 3.11; downloading Python $PBS_VERSION for SearXNG"
  curl --proto '=https' --tlsv1.2 -fsSL --max-time 300 -o "$work/python.tar.gz" "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/${pbs//+/%2B}"
  echo "$PBS_SHA256  $work/python.tar.gz" | sha256sum -c --quiet - || die "checksum mismatch for $pbs; nothing installed"
  mkdir "$work/py"
  tar -xzf "$work/python.tar.gz" -C "$work/py" --strip-components=1 --no-same-owner --no-same-permissions
  [ -x "$work/py/bin/python3" ] && "$work/py/bin/python3" -c 'import ensurepip, venv, tomllib' || die "the standalone Python does not run here"
  chown -R root:root "$work/py"
  chmod -R u=rwX,go=rX "$work/py"
  rm -rf "$PREFIX/python-$PBS_VERSION"
  mv "$work/py" "$PREFIX/python-$PBS_VERSION"
fi

# ---- the pinned source, verified before it is unpacked ----
if [ ! -f "$src/searx/webapp.py" ]; then
  echo "install-searxng: downloading SearXNG ${commit:0:12}"
  curl --proto '=https' --tlsv1.2 -fsSL --max-time 300 -o "$work/searxng.tar.gz" "https://github.com/searxng/searxng/archive/$commit.tar.gz"
  echo "$sha256  $work/searxng.tar.gz" | sha256sum -c --quiet - || die "checksum mismatch for SearXNG $commit; nothing installed"
  mkdir "$work/src"
  tar -xzf "$work/searxng.tar.gz" -C "$work/src" --strip-components=1 --no-same-owner --no-same-permissions
  [ -f "$work/src/searx/webapp.py" ] || die "the archive has no searx/webapp.py"
  chown -R root:root "$work/src"
  chmod -R u=rwX,go=rX "$work/src"
  rm -rf "$src"
  mv "$work/src" "$src"
fi

# ---- the venv: every dependency by hash, wheels only ----
# Built where it will live (a venv's scripts name its path); "venv" is a symlink switched at the end.
venv="$PREFIX/venv-${commit:0:12}-$(sha256sum "$LOCK" | cut -c1-12)-$pyid"
if [ ! -x "$venv/bin/granian" ]; then
  echo "install-searxng: installing SearXNG's Python dependencies (hash-pinned)"
  rm -rf "$venv"
  "$PY" -m venv "$venv"
  "$venv/bin/python" -m pip install -q --disable-pip-version-check --no-cache-dir --require-hashes --only-binary=:all: --no-deps -r "$LOCK" \
    || { rm -rf "$venv"; die "pip could not install the pinned dependencies; nothing switched"; }
  "$venv/bin/python" -c 'import tomllib, typing, flask, lxml, granian, msgspec, curl_cffi; typing.NotRequired' || { rm -rf "$venv"; die "the venv does not import SearXNG's dependencies"; }
fi

# ---- switch ----
prev_src="$(readlink "$PREFIX/current" || true)"
prev_venv="$(readlink "$PREFIX/venv" || true)"
[ -L "$PREFIX/venv" ] || rm -rf "$PREFIX/venv"
ln -sfn "$venv" "$PREFIX/venv"
ln -sfn "$src" "$PREFIX/current"
# Keep the previous source and venv only.
for d in "$PREFIX"/src-* "$PREFIX"/venv-*; do
  [ -d "$d" ] || continue
  case "$d" in "$src"|"$venv"|"$prev_src"|"$prev_venv") ;; *) rm -rf "$d" ;; esac
done
chmod -R go-w "$PREFIX"
echo "$want" > "$marker"
echo "install-searxng: SearXNG ${commit:0:12} installed in $PREFIX"
