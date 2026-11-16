#!/usr/bin/env bash
# Install vLLM for an EdgeCoder agent on Ubuntu with NVIDIA GPUs (docs/inference-engines.md).
#
#   sudo scripts/linux/vllm/install-vllm.sh --profile a16x2 [--instance 0] [--download] [--start]
#   sudo scripts/linux/vllm/install-vllm.sh --profile a100-80 --download --start
#   sudo scripts/linux/vllm/install-vllm.sh --model Org/Repo --gpus 0 --args "--max-model-len 32768 ..."
#
# What it does (re-runnable):
#   - checks the NVIDIA driver (it never installs or changes a driver) and Python 3.10-3.14;
#   - installs python3-venv, python3-dev and gcc from Ubuntu's archive (Triton compiles small
#     kernels at run time and needs them);
#   - creates a venv in /opt/edgecoder/vllm/venv with vllm==$VLLM_VERSION from PyPI;
#   - writes /etc/edgecoder/vllm-<instance>.env from the profile (kept if it exists);
#   - installs the edgecoder-vllm@.service unit;
#   - --download: fetches the model weights into /var/lib/edgecoder/hf as the edgecoder user;
#   - --start: stops and masks edgecoder-ollama-<instance> (its GPU memory; masked so the agent
#     unit's Wants= does not start it again), enables and starts edgecoder-vllm@<instance>, and
#     waits until /v1/models answers.
# It does not touch the agent's env file: switching the agent to vLLM is a separate step
# (the lines to add are printed at the end).
set -euo pipefail

VLLM_VERSION="${VLLM_VERSION:-0.33.0}"
PREFIX=/opt/edgecoder/vllm
STATE=/var/lib/edgecoder
ETC=/etc/edgecoder
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/edgecoder-vllm@.service"
SERVICE_USER=edgecoder

profile=""
instance=0
model=""
gpus=""
args=""
download=0
start=0

die() { echo "install-vllm: $*" >&2; exit 1; }
usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="${2:-}"; shift 2 ;;
    --instance) instance="${2:-}"; shift 2 ;;
    --model) model="${2:-}"; shift 2 ;;
    --gpus) gpus="${2:-}"; shift 2 ;;
    --args) args="${2:-}"; shift 2 ;;
    --vllm-version) VLLM_VERSION="${2:-}"; shift 2 ;;
    --download) download=1; shift ;;
    --start) start=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 2 ;;
  esac
done

[[ "$instance" =~ ^[0-9]{1,2}$ ]] || die "--instance must be a number"
[[ "$VLLM_VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || die "--vllm-version must look like 0.33.0"
port=$((8000 + instance))

case "$profile" in
  a16x2)
    model="${model:-QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ}"
    gpus="${gpus:-0,1}"
    args="${args:---tensor-parallel-size 2 --max-model-len 65536 --gpu-memory-utilization 0.92 --max-num-seqs 8 --max-num-batched-tokens 4096 --enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_xml}"
    slots=2
    ;;
  a100-80)
    model="${model:-Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8}"
    gpus="${gpus:-0}"
    args="${args:---max-model-len 65536 --gpu-memory-utilization 0.92 --max-num-seqs 32 --enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_xml}"
    slots=12
    ;;
  "")
    [ -n "$model" ] && [ -n "$gpus" ] && [ -n "$args" ] || die "give --profile a16x2|a100-80, or all of --model, --gpus and --args"
    slots=""
    ;;
  *) die "unknown profile: $profile (a16x2, a100-80)" ;;
esac
[[ "$model" =~ ^[A-Za-z0-9._/-]+$ ]] || die "--model must be a Hugging Face repo id or a path"
[[ "$gpus" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "--gpus must be a list such as 0,1"
case "$args" in *[\"\'\`\$\;\&\|\<\>]*) die "--args may not contain quotes or shell characters" ;; esac

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -r /etc/os-release ] && . /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "install-vllm: not Ubuntu (${ID:-unknown}); continuing, but only Ubuntu 22.04/24.04 is tested" >&2

# ---- NVIDIA driver: required, never installed here ----
command -v nvidia-smi >/dev/null || die "nvidia-smi not found: install the NVIDIA driver (550 or newer) first"
nvidia-smi --query-gpu=index,name,memory.total,compute_cap,driver_version --format=csv,noheader \
  || die "nvidia-smi cannot talk to the driver"
driver_major="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)"
[ "${driver_major:-0}" -ge 550 ] || die "NVIDIA driver $driver_major is too old (550 or newer)"
for g in ${gpus//,/ }; do
  nvidia-smi -i "$g" --query-gpu=index --format=csv,noheader >/dev/null 2>&1 || die "GPU $g not found"
  cc="$(nvidia-smi -i "$g" --query-gpu=compute_cap --format=csv,noheader | tr -d ' ')"
  awk -v c="$cc" 'BEGIN { exit !(c + 0 >= 7.0) }' || die "GPU $g has compute capability $cc; vLLM needs 7.0 or newer"
done

# ---- Python ----
command -v python3 >/dev/null || die "python3 not found"
pyver="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
python3 -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 15) else 1)' || die "Python $pyver: vLLM needs 3.10 to 3.14"
export DEBIAN_FRONTEND=noninteractive
need=()
python3 -c 'import ensurepip' >/dev/null 2>&1 || need+=("python${pyver}-venv")
[ -f "/usr/include/python${pyver}/Python.h" ] || need+=("python${pyver}-dev")
command -v gcc >/dev/null || need+=(gcc)
if [ "${#need[@]}" -gt 0 ]; then
  echo "install-vllm: apt-get install ${need[*]}"
  apt-get update -q
  apt-get install -y -q "${need[@]}"
fi

# ---- service user and directories ----
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 0755 "$PREFIX"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE/vllm" "$STATE/vllm/cache" "$STATE/hf"
install -d -m 0755 "$ETC"

# ---- vLLM in its own venv ----
if [ ! -x "$PREFIX/venv/bin/python" ]; then python3 -m venv "$PREFIX/venv"; fi
have="$("$PREFIX/venv/bin/python" -c 'import importlib.metadata as m; print(m.version("vllm"))' 2>/dev/null || true)"
if [ "$have" != "$VLLM_VERSION" ]; then
  echo "install-vllm: installing vllm==$VLLM_VERSION (several GB: PyTorch and CUDA libraries)"
  "$PREFIX/venv/bin/pip" install -q --upgrade pip
  "$PREFIX/venv/bin/pip" install -q "vllm==$VLLM_VERSION"
fi
"$PREFIX/venv/bin/vllm" --version >/dev/null || die "vllm did not install"
echo "install-vllm: vllm $("$PREFIX/venv/bin/python" -c 'import importlib.metadata as m; print(m.version("vllm"))')"

# ---- env file (kept when it exists) ----
envfile="$ETC/vllm-$instance.env"
if [ -e "$envfile" ]; then
  echo "install-vllm: keeping $envfile"
else
  umask 027
  cat > "$envfile" <<ENV
# Written by install-vllm.sh ($profile); see scripts/linux/vllm/vllm.env.example.
VLLM_MODEL_ID=$model
VLLM_PORT=$port
CUDA_VISIBLE_DEVICES=$gpus
VLLM_ARGS="$args"
HF_HUB_OFFLINE=$([ "$download" -eq 1 ] && echo 1 || echo 0)
ENV
  chown "root:$SERVICE_USER" "$envfile"
  chmod 0640 "$envfile"
  echo "install-vllm: wrote $envfile"
fi

install -m 0644 "$UNIT_SRC" /etc/systemd/system/edgecoder-vllm@.service
systemctl daemon-reload

# ---- weights ----
if [ "$download" -eq 1 ]; then
  echo "install-vllm: downloading $model into $STATE/hf"
  # Passed as an argument, never interpolated into the Python source.
  runuser -u "$SERVICE_USER" -- env HOME="$STATE/vllm" HF_HOME="$STATE/hf" HF_HUB_DISABLE_TELEMETRY=1 \
    "$PREFIX/venv/bin/python" -c 'import sys; from huggingface_hub import snapshot_download; print(snapshot_download(sys.argv[1]))' "$model"
fi

# ---- start ----
if [ "$start" -eq 1 ]; then
  if systemctl list-unit-files "edgecoder-ollama-$instance.service" --no-legend 2>/dev/null | grep -q .; then
    echo "install-vllm: stopping and masking edgecoder-ollama-$instance (undo: systemctl unmask edgecoder-ollama-$instance)"
    systemctl stop "edgecoder-ollama-$instance.service" || true
    systemctl mask "edgecoder-ollama-$instance.service"
  fi
  systemctl enable "edgecoder-vllm@$instance.service"
  systemctl restart "edgecoder-vllm@$instance.service"
  echo "install-vllm: waiting for vLLM on 127.0.0.1:$port (first start compiles kernels; up to 15 min)"
  for _ in $(seq 1 180); do
    if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$port/v1/models"; then
      echo "install-vllm: vLLM is serving: $(curl -fsS -m 3 "http://127.0.0.1:$port/v1/models")"
      break
    fi
    systemctl is-active --quiet "edgecoder-vllm@$instance.service" || die "edgecoder-vllm@$instance stopped; see journalctl -u edgecoder-vllm@$instance"
    sleep 5
  done
fi

cat <<NEXT

Next: point agent $instance at vLLM. Add to $ETC/agent-$instance.env:
  EDGECODER_ENGINE=vllm
  VLLM_URL=http://127.0.0.1:$port
  VLLM_MODEL=$model${slots:+
  VLLM_MAX_SLOTS=$slots}
then: systemctl restart edgecoder-agent-$instance
Back to Ollama: remove those lines, then
  systemctl disable --now edgecoder-vllm@$instance
  systemctl unmask edgecoder-ollama-$instance && systemctl start edgecoder-ollama-$instance
  systemctl restart edgecoder-agent-$instance
NEXT
