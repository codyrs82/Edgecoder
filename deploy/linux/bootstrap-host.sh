#!/usr/bin/env bash

set -euo pipefail

ROLE="${1:-}"
REPO_URL="${2:-}"
REPO_REF="${3:-main}"
INSTALL_DIR="${4:-/opt/edgecoder/app}"
NODE_MAJOR="${NODE_MAJOR:-22}"

usage() {
  cat <<'EOF'
Usage:
  sudo bash deploy/linux/bootstrap-host.sh <agent|coordinator> <repo_url> [repo_ref] [install_dir]

Examples:
  sudo bash deploy/linux/bootstrap-host.sh agent https://github.com/your-org/Edgecoder.git main /opt/edgecoder/app
  sudo bash deploy/linux/bootstrap-host.sh coordinator https://github.com/your-org/Edgecoder.git main /opt/edgecoder/app
  sudo bash deploy/linux/bootstrap-host.sh seed https://github.com/your-org/Edgecoder.git main /opt/edgecoder/app

Notes:
  - Supports Debian/Ubuntu hosts with systemd.
  - Installs Node.js (major version controlled by NODE_MAJOR, default 22).
  - Builds EdgeCoder and installs the selected systemd service.
EOF
}

if [[ -z "${ROLE}" || -z "${REPO_URL}" ]]; then
  usage
  exit 1
fi

if [[ "${ROLE}" != "agent" && "${ROLE}" != "coordinator" && "${ROLE}" != "seed" ]]; then
  echo "error: role must be 'agent', 'coordinator', or 'seed'." >&2
  usage
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run as root (use sudo)." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemd is required for this bootstrap path." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git

# Legacy path: deploy/install.sh (signed release, pinned Node/Ollama) is the supported installer.
echo "warning: bootstrap-host.sh builds an unsigned branch; prefer deploy/install.sh" >&2

# NodeSource's repo key (NSolid <nsolid-gpg@nodesource.com>), pinned; checked 2026-11-14 against the
# served key, keys.openpgp.org and keyserver.ubuntu.com. The file must hold exactly this one key, and
# only it is written to the keyring.
NODESOURCE_FINGERPRINT="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  ns_tmp="$(mktemp -d)"
  curl -fsSL --proto '=https' -o "$ns_tmp/key.asc" https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
  ns_pub="$(gpg --show-keys --with-colons "$ns_tmp/key.asc" | awk -F: '$1 == "pub"' | wc -l | tr -d ' ')"
  ns_fpr="$(gpg --show-keys --with-colons "$ns_tmp/key.asc" | awk -F: '$1 == "fpr" { print $10; exit }')"
  if [[ "$ns_pub" != 1 || "$ns_fpr" != "$NODESOURCE_FINGERPRINT" ]]; then
    echo "error: NodeSource key is not the pinned $NODESOURCE_FINGERPRINT (got $ns_pub key(s), first $ns_fpr)" >&2
    exit 1
  fi
  mkdir -m 700 "$ns_tmp/gnupg"
  GNUPGHOME="$ns_tmp/gnupg" gpg --batch --quiet --import "$ns_tmp/key.asc"
  GNUPGHOME="$ns_tmp/gnupg" gpg --batch --export "$NODESOURCE_FINGERPRINT" > /etc/apt/keyrings/nodesource.gpg
  rm -rf "$ns_tmp"
fi
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list

apt-get update
apt-get install -y nodejs

# Fetch and build as the invoking (non-root) user, never as root: dependency install scripts and
# the build run unsigned code. The tree is handed to root afterwards.
BUILD_USER="${SUDO_USER:-}"
if [[ -z "$BUILD_USER" || "$BUILD_USER" == root ]]; then
  echo "error: run this with sudo from a normal account; the source is fetched and built as that user, not root." >&2
  exit 1
fi
as_builder() { runuser -u "$BUILD_USER" -- "$@"; }
install -d /opt/edgecoder
install -d -o "$BUILD_USER" "${INSTALL_DIR}"
chown -R "$BUILD_USER" "${INSTALL_DIR}"
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  as_builder git -C "${INSTALL_DIR}" fetch --all --tags
  as_builder git -C "${INSTALL_DIR}" checkout "${REPO_REF}"
  as_builder git -C "${INSTALL_DIR}" pull --ff-only
else
  find "${INSTALL_DIR}" -mindepth 1 -delete
  as_builder git clone --branch "${REPO_REF}" "${REPO_URL}" "${INSTALL_DIR}"
fi

pushd "${INSTALL_DIR}" >/dev/null
if [[ -f package-lock.json ]]; then
  as_builder npm ci
else
  as_builder npm install
fi
as_builder npm run build
chown -R root:root "${INSTALL_DIR}"
bash scripts/linux/systemd/install-systemd.sh "${ROLE}" "${INSTALL_DIR}"
popd >/dev/null

echo
echo "Bootstrap complete for role: ${ROLE}"
echo "Next steps:"
echo "  1) Edit /etc/edgecoder/${ROLE}.env"
echo "  2) Restart service: sudo systemctl restart io.edgecoder.${ROLE}.service"
echo "  3) Approve node in control plane after first registration attempt"

if [[ "${ROLE}" == "seed" ]]; then
  echo "  NOTE: Ensure EDGE_RUNTIME_MODE=all-in-one is set in /etc/edgecoder/seed.env"
fi
