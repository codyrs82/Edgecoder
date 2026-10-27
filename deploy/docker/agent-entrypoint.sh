#!/bin/sh
# #9: start Ollama in the background unless SKIP_OLLAMA=true, then exec the command.
set -e
if [ "$SKIP_OLLAMA" != "true" ]; then
  ollama serve >/tmp/ollama.log 2>&1 &
  echo "[entrypoint] ollama started in background (models: ${OLLAMA_MODELS:-default})"
fi
exec "$@"
