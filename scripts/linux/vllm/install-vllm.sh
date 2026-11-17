#!/usr/bin/env bash
# Install vLLM for an EdgeCoder agent on Ubuntu with NVIDIA GPUs (docs/inference-engines.md).
#
#   sudo scripts/linux/vllm/install-vllm.sh --profile a16x2 [--instance 0] [--download] [--start]
#   sudo scripts/linux/vllm/install-vllm.sh --profile a100-80 --download --start
#   profiles: a16x2, a100-80, a100-40, gpu-48gb, gpu-24gb (edgecoder-install --vllm-profile auto picks one)
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
#   - --start: holds edgecoder-ollama-<instance> off (its GPU memory) with the same marker and
#     drop-in edgecoder-install uses (/etc/edgecoder/vllm-<instance>.active and
#     edgecoder-ollama-<instance>.service.d/vllm-switch.conf, ConditionPathExists=!marker, so the
#     agent unit's Wants= cannot start it), enables and starts edgecoder-vllm@<instance>, and
#     waits until /v1/models answers.
# It does not touch the agent's env file. Point the agent at vLLM with
#   edgecoder-install apply --engine vllm
# which writes the env lines, the marker and the drop-in, and keeps them on every later run.
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
usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

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
    # One 80 GB card (A100 80 GB, H100; more KV cache on bigger cards). FP8 weights ~31 GB;
    # 0.92 x 80 = 73.6 GB - 31 - ~4 (activations, CUDA graphs) = ~38 GB KV, ~400K tokens.
    model="${model:-Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8}"
    gpus="${gpus:-0}"
    args="${args:---max-model-len 65536 --gpu-memory-utilization 0.92 --max-num-seqs 32 --enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_xml}"
    slots=12
    ;;
  a100-40)
    # One A100 40 GB. AWQ ~17 GB (FP8's 31 GB would leave ~3 GB of KV cache):
    # 0.92 x 40 = 36.8 GB - 17 - ~3 = ~17 GB KV at 96 KiB/token, ~170K tokens: 2.6 full 64K calls.
    model="${model:-QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ}"
    gpus="${gpus:-0}"
    args="${args:---max-model-len 65536 --gpu-memory-utilization 0.92 --max-num-seqs 8 --enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_xml}"
    slots=4
    ;;
  gpu-48gb)
    # One 44-48 GB card (RTX A6000, L40S, A40, RTX 6000 Ada). AWQ ~17 GB:
    # 0.92 x 45-48 = 41-44 GB - 17 - ~3 = ~21-24 GB KV, ~215-245K tokens: 3.3-3.7 full 64K calls.
    model="${model:-QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ}"
    gpus="${gpus:-0}"
    args="${args:---max-model-len 65536 --gpu-memory-utilization 0.92 --max-num-seqs 12 --enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_xml}"
    slots=6
    ;;
  gpu-24gb)
    # One 22-37 GB card (A10, L4, RTX 3090/4090/5090): tight. AWQ ~17 GB; 0.95 x 24 = 22.8 GB - 17
    # - ~2.5 (small batches: --max-num-batched-tokens 2048) = ~3 GB KV, ~30K tokens: 16K context,
    # one call at a time (a second short one fits).
    model="${model:-QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ}"
    gpus="${gpus:-0}"
    args="${args:---max-model-len 16384 --gpu-memory-utilization 0.95 --max-num-seqs 2 --max-num-batched-tokens 2048 --enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_xml}"
    slots=1
    ;;
  "")
    [ -n "$model" ] && [ -n "$gpus" ] && [ -n "$args" ] || die "give --profile a16x2|a100-80|a100-40|gpu-48gb|gpu-24gb, or all of --model, --gpus and --args"
    slots=""
    ;;
  *) die "unknown profile: $profile (a16x2, a100-80, a100-40, gpu-48gb, gpu-24gb)" ;;
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
# vLLM needs a final Python 3.11.4+ (up to 3.14). Ubuntu 22.04 ships 3.10, and its "python3.11"
# package is a pre-release (3.11.0rc1) that PyTorch can't run on. Use a good system Python when
# there is one; otherwise a standalone CPython 3.12 managed by uv under $PREFIX (no system change).
export DEBIAN_FRONTEND=noninteractive
py_ok() { "$1" -c 'import sys; v=sys.version_info; sys.exit(0 if v.releaselevel == "final" and (3, 11, 4) <= v[:3] and v[:2] < (3, 15) else 1)' 2>/dev/null; }
PY=""
for v in 3.14 3.13 3.12 3.11; do command -v "python$v" >/dev/null && py_ok "python$v" && { PY="$(command -v "python$v")"; break; }; done
STANDALONE=0
if [ -z "$PY" ]; then
  command -v curl >/dev/null || { apt-get update -q; apt-get install -y -q curl; }
  export UV_INSTALL_DIR="$PREFIX/uv" UV_PYTHON_INSTALL_DIR="$PREFIX/python" UV_NO_MODIFY_PATH=1
  install -d -m 0755 "$PREFIX"
  [ -x "$PREFIX/uv/uv" ] || { echo "install-vllm: installing uv (Python manager) in $PREFIX/uv"; curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null; }
  echo "install-vllm: installing a standalone Python 3.12 in $PREFIX/python"
  "$PREFIX/uv/uv" python install 3.12 >/dev/null || die "could not install Python 3.12; vLLM needs Python 3.11.4 to 3.14"
  PY="$("$PREFIX/uv/uv" python find 3.12)"
  py_ok "$PY" || die "Python at $PY is not usable for vLLM"
  STANDALONE=1
fi
pyver="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
need=()
if [ "$STANDALONE" = 0 ]; then
  "$PY" -c 'import ensurepip' >/dev/null 2>&1 || need+=("python${pyver}-venv")
  [ -f "/usr/include/python${pyver}/Python.h" ] || need+=("python${pyver}-dev")
fi
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
# A venv from an older Python (e.g. 3.10 on Ubuntu 22.04) can't hold this vLLM: rebuild it.
if [ -x "$PREFIX/venv/bin/python" ] && ! py_ok "$PREFIX/venv/bin/python"; then
  echo "install-vllm: rebuilding the venv with Python $pyver"; rm -rf "$PREFIX/venv"
fi
if [ ! -x "$PREFIX/venv/bin/python" ]; then "$PY" -m venv "$PREFIX/venv"; fi
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
    # Not a mask: edgecoder-install rewrites the Ollama unit file on every run, which would lift it.
    marker="$ETC/vllm-$instance.active"
    dropin="/etc/systemd/system/edgecoder-ollama-$instance.service.d/vllm-switch.conf"
    echo "install-vllm: holding edgecoder-ollama-$instance off ($marker; undo: edgecoder-install apply --engine ollama)"
    printf '# install-vllm.sh: instance %s runs its model on vLLM (edgecoder-vllm@%s); its Ollama stays off.\n' "$instance" "$instance" > "$marker"
    chmod 0644 "$marker"
    install -d -m 0755 "$(dirname "$dropin")"
    printf '[Unit]\nConditionPathExists=!%s\n' "$marker" > "$dropin"
    chmod 0644 "$dropin"
    systemctl unmask "edgecoder-ollama-$instance.service" >/dev/null 2>&1 || true
    systemctl daemon-reload
    systemctl disable --now "edgecoder-ollama-$instance.service" || true
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

Next: point agent $instance at vLLM (re-runs and upgrades keep it there):
  sudo edgecoder-install apply --engine vllm --vllm-model $model${slots:+ --vllm-slots $slots}
It writes EDGECODER_ENGINE=vllm, VLLM_URL=http://127.0.0.1:$port, VLLM_MODEL and VLLM_MAX_SLOTS
into $ETC/agent-$instance.env, keeps edgecoder-ollama-$instance off and restarts the agent.
Back to Ollama: sudo edgecoder-install apply --engine ollama
NEXT
