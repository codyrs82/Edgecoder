#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder, LLC
# SPDX-License-Identifier: BUSL-1.1
#
# Bootstrap a full EdgeCoder GPU agent on a fresh Ubuntu 24.04 GPU VM (e.g. Vultr). Run as root.
# Runbook: deploy/gpu-agent/README.md. Safe to run again: every step checks before it changes.
#
#   1. checks the NVIDIA driver is already installed and new enough for Ollama (it never installs
#      or guesses a driver);
#   2. installs Docker Engine from Docker's apt repository, its signing key checked against a
#      pinned fingerprint, for the swarm task sandbox (SANDBOX_MODE=docker);
#   3. runs deploy/install.sh, the regular Linux installer: pinned + checksummed Node.js 22 and
#      Ollama, a minisign-verified EdgeCoder agent release (or an explicit --from-source build),
#      the NVIDIA container toolkit (pinned key), then `edgecoder-install apply`, which enrols the
#      node with the portal API key and creates systemd services running as the non-root
#      `edgecoder` user (in the docker group), with Ollama pinned to the GPU;
#   4. points the agent at its local Ollama (LOCAL_MODEL_PROVIDER=ollama-local) and restarts it.
#
# Inputs (environment; put them after sudo, which drops the environment):
#   COORDINATOR_URL       required, https://
#   PORTAL_URL            required, https://
#   EDGECODER_ENROLL_KEY  portal API key (eck_...). Required on the first run; later runs reuse
#                         the registration token already in /etc/edgecoder/agent-0.env.
#   OLLAMA_MODEL          optional, default qwen3.5:9b
#   AGENT_ID_PREFIX       optional node id prefix (default: hostname). edgecoder-install names
#                         the node <prefix>-gpu (one GPU) or <prefix>-gpu<N> (several).
#   MESH_AUTH_TOKEN       optional; the coordinator hands it out on registration.
#   EDGECODER_VERSION     optional agent release to install (default: latest agent-v* release)
#   EDGECODER_FROM_SOURCE_REF  optional git branch/tag: build UNVERIFIED source instead of a
#                         signed release (e.g. a regtest branch). Built as the unprivileged
#                         `edgecoder-build` user, never as root.
# Nothing downloaded is piped into a shell, and no secret is printed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Docker Release (CE deb) <docker@docker.com>; the same pin as deploy/install.sh and docs/install.md.
DOCKER_REPO_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# Ollama needs NVIDIA driver 550 or newer (docs/gpu.mdx in the pinned Ollama release).
MIN_NVIDIA_DRIVER_MAJOR=550
DEFAULT_MODEL=qwen3.5:9b
BUILD_USER=edgecoder-build
ENV_DIR=/etc/edgecoder

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

fetch() { curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 -o "$2" "$1"; }

check_url() {
  local name="$1" value="${2:-}"
  [ -n "$value" ] || die "$name is not set"
  [[ "$value" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || die "$name must be a plain https:// URL"
}

preflight() {
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo -E is not enough: pass the variables after sudo, see README)"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || die "this script targets Ubuntu 24.04; found ${PRETTY_NAME:-unknown}"
  [ "${VERSION_ID:-}" = 24.04 ] || warn "tested for Ubuntu 24.04; found $VERSION_ID (continuing)"
  [ "$(uname -m)" = x86_64 ] || die "expected an x86_64 VM; found $(uname -m)"
  check_url COORDINATOR_URL "${COORDINATOR_URL:-}"
  check_url PORTAL_URL "${PORTAL_URL:-}"
  OLLAMA_MODEL="${OLLAMA_MODEL:-$DEFAULT_MODEL}"
  [[ "$OLLAMA_MODEL" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?$ ]] || die "OLLAMA_MODEL is not a model tag"
  if [ -n "${AGENT_ID_PREFIX:-}" ]; then
    [[ "$AGENT_ID_PREFIX" =~ ^[a-z0-9][a-z0-9-]{1,60}$ ]] || die "AGENT_ID_PREFIX: use 2-61 lowercase letters, digits or '-'"
  fi
  if [ -n "${EDGECODER_FROM_SOURCE_REF:-}" ]; then
    [[ "$EDGECODER_FROM_SOURCE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "EDGECODER_FROM_SOURCE_REF is not a branch or tag name"
  fi
  INSTALL_SH=""
  for c in "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/../install.sh"; do
    if [ -f "$c" ]; then INSTALL_SH="$c"; break; fi
  done
  [ -n "$INSTALL_SH" ] || die "deploy/install.sh not found next to this script or in its parent directory; copy both (README, step 3)"
}

# ---------------------------------------------------------------- NVIDIA driver ----
check_driver() {
  log "NVIDIA driver"
  if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L >/dev/null 2>&1; then
    cat >&2 <<MSG
error: no working NVIDIA driver (nvidia-smi is missing or cannot see a GPU).
This script does not install drivers. Re-create the VM from the provider's GPU image that ships
the NVIDIA driver (on Vultr: a GPU plan with an NVIDIA-enabled OS image), or install the driver
the provider documents for this GPU, reboot, check that \`nvidia-smi\` lists the card, then
run this script again.
MSG
    exit 1
  fi
  nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader
  local ver major
  ver="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1 | tr -d ' ')"
  major="${ver%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || die "could not read the NVIDIA driver version ('$ver')"
  [ "$major" -ge "$MIN_NVIDIA_DRIVER_MAJOR" ] || die "NVIDIA driver $ver is older than $MIN_NVIDIA_DRIVER_MAJOR, which Ollama requires; upgrade it the way the provider documents"
  local small
  small="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | awk '$1 < 12000' | wc -l | tr -d ' ')"
  [ "$small" = 0 ] || warn "$small GPU(s) report under 12 GB; $OLLAMA_MODEL needs about 12 GB (README, 'What to rent')"
}

# ----------------------------------------------------------------------- Docker ----
install_docker() {
  log "Docker Engine"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  if command -v docker >/dev/null 2>&1; then
    echo "docker already installed: $(docker --version)"
  else
    local tmp keyring=/etc/apt/keyrings/docker.gpg npub fpr arch codename
    tmp="$(mktemp -d)"
    fetch https://download.docker.com/linux/ubuntu/gpg "$tmp/key.asc" || die "could not download Docker's repo key"
    # Exactly one primary key, the pinned one, and only that key goes into the keyring.
    npub="$(gpg --show-keys --with-colons "$tmp/key.asc" 2>/dev/null | awk -F: '$1 == "pub"' | wc -l | tr -d ' ')"
    [ "$npub" = 1 ] || die "Docker repo key file holds $npub keys, expected exactly 1"
    fpr="$(gpg --show-keys --with-colons "$tmp/key.asc" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
    [ "$fpr" = "$DOCKER_REPO_FINGERPRINT" ] || die "Docker repo key fingerprint is '$fpr', expected $DOCKER_REPO_FINGERPRINT"
    mkdir -m 700 "$tmp/gnupg"
    GNUPGHOME="$tmp/gnupg" gpg --batch --quiet --import "$tmp/key.asc" 2>/dev/null || die "could not read Docker's repo key"
    install -d -m 0755 /etc/apt/keyrings
    GNUPGHOME="$tmp/gnupg" gpg --batch --export "$DOCKER_REPO_FINGERPRINT" > "$keyring.new"
    [ -s "$keyring.new" ] || die "could not export the pinned Docker key"
    chmod 0644 "$keyring.new" && mv "$keyring.new" "$keyring"
    rm -rf "$tmp"
    arch="$(dpkg --print-architecture)"
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    echo "deb [arch=$arch signed-by=$keyring] https://download.docker.com/linux/ubuntu $codename stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null
  fi
  systemctl enable --now docker >/dev/null
  docker info --format '{{.ServerVersion}}' >/dev/null || die "the Docker daemon is not answering"
}

# ------------------------------------------------------------ EdgeCoder agent ----
existing_token() {
  # Reuse the token a previous run wrote, without printing it.
  [ -f "$ENV_DIR/agent-0.env" ] || return 1
  sed -n 's/^AGENT_REGISTRATION_TOKEN=\(..*\)$/\1/p' "$ENV_DIR/agent-0.env" | head -n1
}

install_agent() {
  log "EdgeCoder agent (deploy/install.sh -> edgecoder-install apply)"
  local args=(--coordinator-url "$COORDINATOR_URL" --portal-url "$PORTAL_URL" --sandbox docker --model "$OLLAMA_MODEL" --pull-models)
  [ -n "${AGENT_ID_PREFIX:-}" ] && args+=(--agent-id-prefix "$AGENT_ID_PREFIX")
  [ -n "${EDGECODER_VERSION:-}" ] && args+=(--version "$EDGECODER_VERSION")
  local token=""
  token="$(existing_token || true)"
  if [ -z "$token" ] && [ -z "${EDGECODER_ENROLL_KEY:-}" ]; then
    die "EDGECODER_ENROLL_KEY is not set and no earlier registration token was found"
  fi
  if [ -n "${EDGECODER_FROM_SOURCE_REF:-}" ]; then
    id -u "$BUILD_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$BUILD_USER"
    args+=(--from-source --ref "$EDGECODER_FROM_SOURCE_REF")
    # install.sh builds as SUDO_USER (never root) and needs sudo to switch to it.
    command -v sudo >/dev/null 2>&1 || apt-get install -y -qq sudo >/dev/null
  fi
  # Secrets reach the installer through its environment (the names edgecoder-install reads),
  # never through argv, which every local user can see in the process list.
  (
    unset EDGECODER_API_KEY EDGECODER_REGISTRATION_TOKEN EDGECODER_MESH_TOKEN
    if [ -n "$token" ]; then
      echo "reusing the registration token in $ENV_DIR/agent-0.env"
      export EDGECODER_REGISTRATION_TOKEN="$token"
    else
      export EDGECODER_API_KEY="$EDGECODER_ENROLL_KEY"
    fi
    unset EDGECODER_ENROLL_KEY
    if [ -n "${MESH_AUTH_TOKEN:-}" ]; then export EDGECODER_MESH_TOKEN="$MESH_AUTH_TOKEN"; fi
    unset MESH_AUTH_TOKEN
    if [ -n "${EDGECODER_FROM_SOURCE_REF:-}" ]; then export SUDO_USER="$BUILD_USER"; fi
    exec bash "$INSTALL_SH" "${args[@]}"
  )
}

use_local_ollama() {
  log "Agent model provider: local Ollama"
  # edgecoder-install writes LOCAL_MODEL_PROVIDER=edgecoder-local (the built-in offline provider);
  # this host has a GPU Ollama, so the agent uses it. Re-running this script re-applies it.
  local f changed=0
  for f in "$ENV_DIR"/agent-*.env; do
    [ -f "$f" ] || continue
    if grep -q '^LOCAL_MODEL_PROVIDER=ollama-local$' "$f"; then continue; fi
    if grep -q '^LOCAL_MODEL_PROVIDER=' "$f"; then
      sed -i 's/^LOCAL_MODEL_PROVIDER=.*$/LOCAL_MODEL_PROVIDER=ollama-local/' "$f"
    else
      echo 'LOCAL_MODEL_PROVIDER=ollama-local' >> "$f"
    fi
    changed=1
  done
  if [ "$changed" = 1 ]; then
    local units
    units="$(systemctl list-unit-files 'edgecoder-agent-*.service' --no-legend | awk '{print $1}')"
    # shellcheck disable=SC2086
    [ -z "$units" ] || systemctl restart $units
  fi
}

verify() {
  log "Checks"
  id -nG edgecoder | tr ' ' '\n' | grep -qx docker || die "the edgecoder service user is not in the docker group"
  echo "edgecoder user groups: $(id -nG edgecoder)"
  local u failed=0
  for u in $(systemctl list-unit-files 'edgecoder-*.service' --no-legend | awk '{print $1}'); do
    printf '%-36s %s\n' "$u" "$(systemctl is-active "$u" || true)"
    systemctl is-active --quiet "$u" || failed=1
  done
  grep -h '^\(AGENT_ID\|SANDBOX_MODE\|LOCAL_MODEL_PROVIDER\|OLLAMA_MODEL\|COORDINATOR_URL\)=' "$ENV_DIR"/agent-*.env
  [ "$failed" = 0 ] || warn "a service is not active: journalctl -u <unit> -n 50"
  cat <<NEXT

Next: watch the agent register and build its sandbox images
  journalctl -fu edgecoder-agent-0
then check it on the coordinator (README, "Check the agent registered").
NEXT
}

main() {
  preflight
  check_driver
  install_docker
  install_agent
  use_local_ollama
  verify
}

# EDGECODER_BOOTSTRAP_LIB=1 defines the functions without running anything (tests).
if [ "${EDGECODER_BOOTSTRAP_LIB:-}" != 1 ]; then main "$@"; fi
