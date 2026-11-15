#!/bin/sh
# Entrypoint of deploy/gpu-agent/Dockerfile.inference (runbook: deploy/gpu-agent/README.md).
# Checks the agent's settings, starts Ollama on loopback, pulls OLLAMA_MODEL into the /data volume
# the first time, then execs the command (the agent). Secrets are never printed.
#
# EDGECODER_SKIP_CHECKS=1 skips the settings check and Ollama, for running another command in the
# image (e.g. `docker run --rm -e EDGECODER_SKIP_CHECKS=1 IMAGE ollama --version`).
set -eu

log() { echo "[inference-entrypoint] $*"; }
die() { echo "[inference-entrypoint] ERROR: $*" >&2; exit 1; }

if [ "${EDGECODER_SKIP_CHECKS:-}" = 1 ]; then exec "$@"; fi

# ---- settings ----
[ -n "${COORDINATOR_URL:-}" ] || die "COORDINATOR_URL is not set (the coordinator this agent joins, https://...)."
case "$COORDINATOR_URL" in https://*|http://127.0.0.1*|http://localhost*) ;; *) die "COORDINATOR_URL must be https:// (got a non-https URL)." ;; esac
[ -n "${AGENT_ID:-}" ] || die "AGENT_ID is not set: use the node id you enrolled in the portal (the registration token is bound to it)."
[ -n "${AGENT_REGISTRATION_TOKEN:-}" ] || die "AGENT_REGISTRATION_TOKEN is not set: enrol AGENT_ID in the portal and pass the token it returns."
if [ "${SANDBOX_MODE:-none}" != none ]; then
  die "SANDBOX_MODE=${SANDBOX_MODE} in the inference-only image: there is no Docker here to sandbox task code. Leave it at none."
fi
log "agent ${AGENT_ID}: inference-only (SANDBOX_MODE=none, AGENT_INFERENCE_ONLY=${AGENT_INFERENCE_ONLY:-unset}), model ${OLLAMA_MODEL:-unset}"

if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null | sed 's/^/[inference-entrypoint] GPU: /' \
    || log "WARNING: nvidia-smi is present but failed; Ollama may fall back to CPU."
else
  log "WARNING: no nvidia-smi in the container: no GPU was passed in (docker run --gpus all / the host's GPU option). Ollama will run on CPU."
fi

# ---- Ollama ----
models="${OLLAMA_MODELS:-/data/ollama}"
mkdir -p "$models" 2>/dev/null || true
[ -w "$models" ] || die "OLLAMA_MODELS=$models is not writable by uid $(id -u); mount a volume owned by uid $(id -u) (or let the image create /data)."
# Ollama reads OLLAMA_HOST as host:port; the agent reads the same variable as a URL.
ollama_addr="${OLLAMA_HOST:-http://127.0.0.1:11434}"
ollama_addr="${ollama_addr#http://}"
ollama_log="${OLLAMA_LOG:-/tmp/ollama.log}"
OLLAMA_HOST="$ollama_addr" ollama serve >>"$ollama_log" 2>&1 &
log "ollama serve started on $ollama_addr (log: $ollama_log, models: $models)"

i=0
until OLLAMA_HOST="$ollama_addr" ollama list >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { tail -n 20 "$ollama_log" >&2 || true; die "ollama did not come up within 60 s"; }
  sleep 1
done
if [ -n "${OLLAMA_MODEL:-}" ]; then
  if OLLAMA_HOST="$ollama_addr" ollama show "$OLLAMA_MODEL" >/dev/null 2>&1; then
    log "model $OLLAMA_MODEL already in $models"
  else
    log "pulling $OLLAMA_MODEL into $models (first start; several GB)"
    OLLAMA_HOST="$ollama_addr" ollama pull "$OLLAMA_MODEL" || die "could not pull $OLLAMA_MODEL"
  fi
fi
# Which processor Ollama found (CUDA, or CPU when the GPU is not visible).
grep -m 3 -i -E 'inference compute|no compatible GPUs' "$ollama_log" 2>/dev/null | sed 's/^/[inference-entrypoint] ollama: /' || true

exec "$@"
