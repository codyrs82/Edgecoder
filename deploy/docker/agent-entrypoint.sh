#!/bin/sh
# #9: start Ollama in the background unless SKIP_OLLAMA=true, then exec the command.
set -e
if [ "$SKIP_OLLAMA" != "true" ]; then
  models="${OLLAMA_MODELS:-/data/ollama}"
  if [ ! -w "$models" ]; then
    echo "[entrypoint] ERROR: OLLAMA_MODELS=$models is not writable by uid $(id -u)." >&2
    echo "[entrypoint] On Fly, run scripts/fly-post-deploy.sh (chown -R 1000:1000 $models, then restart). Ollama NOT started." >&2
  else
  ollama serve >/tmp/ollama.log 2>&1 &
  echo "[entrypoint] ollama started in background (models: $models)"
  fi
fi
exec "$@"
