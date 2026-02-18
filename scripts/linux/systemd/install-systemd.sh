#!/usr/bin/env bash

set -euo pipefail

ROLE="${1:-}"
REPO_ROOT="${EDGECODER_REPO_ROOT:-$(pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/linux/systemd/install-systemd.sh <agent|coordinator> [repo_root]

Examples:
  sudo bash scripts/linux/systemd/install-systemd.sh agent /opt/edgecoder/app
  sudo bash scripts/linux/systemd/install-systemd.sh coordinator /opt/edgecoder/app

Environment overrides:
  NODE_BIN=/usr/bin/node
  EDGECODER_REPO_ROOT=/opt/edgecoder/app
EOF
}

if [[ -z "${ROLE}" ]]; then
  usage
  exit 1
fi

if [[ $# -ge 2 ]]; then
  REPO_ROOT="$2"
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run as root (use sudo)." >&2
  exit 1
fi

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "error: Node.js binary not found. Install Node.js 20+ first." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemctl not found. This installer supports systemd hosts only." >&2
  exit 1
fi

if [[ ! -d "${REPO_ROOT}" ]]; then
  echo "error: repo root does not exist: ${REPO_ROOT}" >&2
  exit 1
fi

if [[ ! -f "${REPO_ROOT}/package.json" ]]; then
  echo "error: repo root must contain package.json: ${REPO_ROOT}" >&2
  exit 1
fi

if [[ ! -f "${REPO_ROOT}/dist/swarm/worker-runner.js" || ! -f "${REPO_ROOT}/dist/swarm/coordinator.js" ]]; then
  echo "error: build artifacts missing. Run 'npm install && npm run build' in ${REPO_ROOT} first." >&2
  exit 1
fi

if ! id edgecoder >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin edgecoder
fi

mkdir -p /etc/edgecoder
chown edgecoder:edgecoder /etc/edgecoder

case "${ROLE}" in
  agent)
    SRC_UNIT="${REPO_ROOT}/scripts/linux/systemd/edgecoder-agent.service"
    DST_UNIT="/etc/systemd/system/io.edgecoder.agent.service"
    SRC_ENV="${REPO_ROOT}/scripts/linux/systemd/agent.env.example"
    DST_ENV="/etc/edgecoder/agent.env"
    UNIT_NAME="io.edgecoder.agent.service"
    ;;
  coordinator)
    SRC_UNIT="${REPO_ROOT}/scripts/linux/systemd/edgecoder-coordinator.service"
    DST_UNIT="/etc/systemd/system/io.edgecoder.coordinator.service"
    SRC_ENV="${REPO_ROOT}/scripts/linux/systemd/coordinator.env.example"
    DST_ENV="/etc/edgecoder/coordinator.env"
    UNIT_NAME="io.edgecoder.coordinator.service"
    ;;
  *)
    echo "error: role must be 'agent' or 'coordinator'." >&2
    usage
    exit 1
    ;;
esac

if [[ ! -f "${SRC_UNIT}" ]]; then
  echo "error: missing unit template: ${SRC_UNIT}" >&2
  exit 1
fi

cp "${SRC_UNIT}" "${DST_UNIT}"
sed -i.bak "s|__REPO_ROOT__|${REPO_ROOT}|g" "${DST_UNIT}"
sed -i.bak "s|__NODE_BIN__|${NODE_BIN}|g" "${DST_UNIT}"
rm -f "${DST_UNIT}.bak"

if [[ ! -f "${DST_ENV}" ]]; then
  cp "${SRC_ENV}" "${DST_ENV}"
  chown edgecoder:edgecoder "${DST_ENV}"
  chmod 640 "${DST_ENV}"
  echo "created ${DST_ENV} from template. Update it before production use."
fi

chown edgecoder:edgecoder "${REPO_ROOT}" || true

systemctl daemon-reload
systemctl enable --now "${UNIT_NAME}"

echo
echo "Installed and started ${UNIT_NAME}"
echo "Useful checks:"
echo "  sudo systemctl status ${UNIT_NAME}"
echo "  sudo journalctl -u ${UNIT_NAME} -f"
