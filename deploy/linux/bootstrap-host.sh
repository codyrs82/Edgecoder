#!/usr/bin/env bash

set -euo pipefail

ROLE="${1:-}"
REPO_URL="${2:-}"
REPO_REF="${3:-main}"
INSTALL_DIR="${4:-/opt/edgecoder/app}"
NODE_MAJOR="${NODE_MAJOR:-20}"

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
  - Installs Node.js (major version controlled by NODE_MAJOR, default 20).
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

install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
fi
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list

apt-get update
apt-get install -y nodejs

install -d /opt/edgecoder
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  git -C "${INSTALL_DIR}" fetch --all --tags
  git -C "${INSTALL_DIR}" checkout "${REPO_REF}"
  git -C "${INSTALL_DIR}" pull --ff-only
else
  rm -rf "${INSTALL_DIR}"
  git clone --branch "${REPO_REF}" "${REPO_URL}" "${INSTALL_DIR}"
fi

pushd "${INSTALL_DIR}" >/dev/null
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build
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
