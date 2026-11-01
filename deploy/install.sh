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

# ----------------------------------------------------------------- Node ----
ensure_node() {
  # Find an existing Node >= NODE_MAJOR even when sudo reset PATH and hid the user's node
  # (Homebrew on /opt/homebrew/bin, nvm, etc.). Put its dir on PATH so npm/node work below too.
  for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    if [ "$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; then
      case ":$PATH:" in *":$(dirname "$c"):"*) :;; *) export PATH="$(dirname "$c"):$PATH";; esac
      return
    fi
  done
  log "Installing Node.js $NODE_MAJOR"
  if [ "$OS" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then sudo -u "${SUDO_USER:-$(whoami)}" brew install node@$NODE_MAJOR >/dev/null && brew link --overwrite node@$NODE_MAJOR >/dev/null 2>&1 || true
    else
      pkg="/tmp/node-$NODE_MAJOR.pkg"; arch="$(uname -m)"; [ "$arch" = "arm64" ] || arch="x64"
      ver="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(v["version"] for v in json.load(sys.stdin) if v["version"].startswith("v'$NODE_MAJOR'.")))')"
      curl -fsSL "https://nodejs.org/dist/$ver/node-$ver.pkg" -o "$pkg" && installer -pkg "$pkg" -target / >/dev/null
    fi
  else
    export DEBIAN_FRONTEND=noninteractive
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg git >/dev/null
      install -m 0755 -d /etc/apt/keyrings
      [ -f /etc/apt/keyrings/nodesource.gpg ] || curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
      apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
    elif command -v dnf >/dev/null 2>&1; then
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null && dnf install -y -q nodejs
    else
      die "install Node.js $NODE_MAJOR+ and re-run"
    fi
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
    curl -fsSL https://ollama.com/install.sh | sh >/dev/null
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
    git -C "$INSTALL_DIR" fetch -q --all --tags && git -C "$INSTALL_DIR" checkout -q "$REPO_REF" && git -C "$INSTALL_DIR" pull -q --ff-only || true
  else
    # A non-git directory here (old app, half-done clone) makes git clone fail "already exists".
    [ -e "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")" && git clone -q --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
  fi
  ( cd "$INSTALL_DIR" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent )
}

ensure_node; ensure_ollama; ensure_docker; ensure_app
ln -sf "$INSTALL_DIR/scripts/edgecoder-install" /usr/local/bin/edgecoder-install 2>/dev/null || true

log "Installer"
exec node "$INSTALL_DIR/dist/install/cli.js" apply --app-dir "$INSTALL_DIR" "$@"
