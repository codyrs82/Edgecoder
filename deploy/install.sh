#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder, LLC
# SPDX-License-Identifier: BUSL-1.1
#
# EdgeCoder one-line installer for Linux and macOS (docs/install.md).
#
#   curl -fsSL https://edgecoder.io/install.sh | sudo bash -s -- --mesh-token <token> [options]
#
# Installs Node 22, Ollama and (Linux) Docker + the NVIDIA container toolkit when a GPU is
# present, builds EdgeCoder into /opt/edgecoder/app, then hands every option to the shared
# installer (`edgecoder-install apply`), which detects the hardware and creates one agent per
# GPU. The Windows installer (deploy/install.ps1) and the .pkg/.deb/.msi packages run the same
# `edgecoder-install`, so the options are identical everywhere: run with --help to list them.
set -euo pipefail

REPO_URL="${EDGECODER_REPO_URL:-https://github.com/codyrs82/Edgecoder.git}"
REPO_REF="${EDGECODER_REPO_REF:-main}"
INSTALL_DIR="${EDGECODER_INSTALL_DIR:-/opt/edgecoder/app}"
NODE_MAJOR=22

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

OS="$(uname -s)"
case "$OS" in Linux|Darwin) ;; *) die "unsupported OS $OS (Windows: deploy/install.ps1)";; esac
need_root

# ------------------------------------------------------------ base tools ----
# Needed whether or not Node is already present: git for the clone, zstd because Ollama's Linux
# release is a .tar.zst (its installer exits "requires zstd" without it), gnupg for the apt keys.
ensure_base() {
  [ "$OS" = "Linux" ] || return 0
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg git zstd >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q ca-certificates curl gnupg2 git zstd
  fi
}

# ----------------------------------------------------------------- Node ----
# macOS: the agent daemons run as _edgecoder from root-owned binaries. Homebrew's node lives in a
# user-owned prefix and links Homebrew dylibs, so it cannot be used (edgecoder-install refuses it);
# install the self-contained nodejs.org build into a root-owned dir instead, checksum-verified.
MAC_NODE_DIR=/opt/edgecoder/node
ensure_mac_node() {
  if [ -x "$MAC_NODE_DIR/bin/node" ] && [ "$("$MAC_NODE_DIR/bin/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; then
    export PATH="$MAC_NODE_DIR/bin:$PATH"; return
  fi
  log "Installing Node.js $NODE_MAJOR (nodejs.org build) into $MAC_NODE_DIR"
  local arch base tmp tarball
  arch="$(uname -m)"; [ "$arch" = "arm64" ] || arch="x64"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  tarball="$(awk '{print $2}' "$tmp/SHASUMS256.txt" | grep -E "^node-v[0-9.]+-darwin-${arch}\.tar\.gz$" | head -n1)"
  [ -n "$tarball" ] || die "no Node.js $NODE_MAJOR darwin-$arch build at $base"
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
  ( cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null ) || die "Node.js download failed its checksum"
  rm -rf "$MAC_NODE_DIR" && mkdir -p "$MAC_NODE_DIR"
  tar -xzf "$tmp/$tarball" -C "$MAC_NODE_DIR" --strip-components 1
  chown -R root:wheel "$MAC_NODE_DIR" && chmod -R go-w "$MAC_NODE_DIR"
  rm -rf "$tmp"
  export PATH="$MAC_NODE_DIR/bin:$PATH"
}

ensure_node() {
  if [ "$OS" = "Darwin" ]; then ensure_mac_node; return; fi
  # Find an existing Node >= NODE_MAJOR. Put its dir on PATH so npm/node work below too. A node a
  # user can replace is copied to a root-owned dir by edgecoder-install before the services use it.
  for c in "$(command -v node 2>/dev/null)" /usr/local/bin/node /usr/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    if [ "$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; then
      case ":$PATH:" in *":$(dirname "$c"):"*) :;; *) export PATH="$(dirname "$c"):$PATH";; esac
      return
    fi
  done
  log "Installing Node.js $NODE_MAJOR"
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    [ -f /etc/apt/keyrings/nodesource.gpg ] || curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null && dnf install -y -q nodejs
  else
    die "install Node.js $NODE_MAJOR+ and re-run"
  fi
}

# --------------------------------------------------------------- Ollama ----
ensure_ollama() {
  if command -v ollama >/dev/null 2>&1; then return; fi
  log "Installing Ollama"
  if [ "$OS" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then sudo -u "${SUDO_USER:-$(whoami)}" brew install ollama >/dev/null
    else curl -fsSL https://ollama.com/download/Ollama-darwin.zip -o /tmp/ollama.zip && ditto -x -k /tmp/ollama.zip /Applications && ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama; fi
  else
    # Quiet on success; on failure show Ollama's own output (it prints its errors on stdout).
    curl -fsSL https://ollama.com/install.sh | sh >/tmp/edgecoder-ollama-install.log 2>&1 || { cat /tmp/edgecoder-ollama-install.log >&2; die "Ollama install failed"; }
    systemctl disable --now ollama >/dev/null 2>&1 || true   # EdgeCoder runs its own per-GPU instances
  fi
}

# --------------------------------------------------------------- Docker ----
ensure_docker() {
  [ "$OS" = "Linux" ] || return 0
  if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker (swarm task sandbox)"
    curl -fsSL https://get.docker.com | sh >/dev/null
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  if command -v nvidia-smi >/dev/null 2>&1 && ! command -v nvidia-ctk >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    log "Installing the NVIDIA container toolkit"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -qq && apt-get install -y -qq nvidia-container-toolkit >/dev/null
    nvidia-ctk runtime configure --runtime=docker >/dev/null && systemctl restart docker
  fi
}

# ---------------------------------------------------------------- build ----
ensure_app() {
  log "EdgeCoder source -> $INSTALL_DIR ($REPO_REF)"
  if [ -d "$INSTALL_DIR/.git" ]; then
    # Move to exactly what the remote has for REPO_REF (a branch, tag or commit). `pull --ff-only || true`
    # silently kept the old build whenever the branch had been rewritten.
    git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
    git -C "$INSTALL_DIR" fetch -q --tags --force origin
    if git -C "$INSTALL_DIR" rev-parse -q --verify "refs/remotes/origin/$REPO_REF" >/dev/null; then
      git -C "$INSTALL_DIR" checkout -q -B "$REPO_REF" "refs/remotes/origin/$REPO_REF"
    else
      git -C "$INSTALL_DIR" checkout -q --detach "$REPO_REF"
    fi
  else
    # A non-git directory here (old app, half-done clone) makes git clone fail "already exists".
    [ -e "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")" && git clone -q --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
  fi
  ( cd "$INSTALL_DIR" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent )
}

ensure_base; ensure_node; ensure_ollama; ensure_docker; ensure_app
# A wrapper, not a symlink: scripts/edgecoder-install finds dist/ relative to its own path, which a
# symlink in /usr/local/bin turns into /usr/local/dist (same wrapper as the .deb/.pkg postinstall).
rm -f /usr/local/bin/edgecoder-install
printf '#!/bin/sh\nexec "%s" "%s/dist/install/cli.js" "$@"\n' "$(command -v node)" "$INSTALL_DIR" > /usr/local/bin/edgecoder-install
chmod 755 /usr/local/bin/edgecoder-install

log "Installer"
exec node "$INSTALL_DIR/dist/install/cli.js" apply --app-dir "$INSTALL_DIR" "$@"
