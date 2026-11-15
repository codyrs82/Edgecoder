#!/usr/bin/env bash
# Tear down the local stress cluster: every container, volume and network named ec-stress-*
# (explicit names only; nothing else is touched). Run artifacts under .stress-runs/ are kept;
# KEEP_SECRETS=0 also deletes .stress-runs/local/ (the per-run throwaway secrets).
set -euo pipefail
cd "$(dirname "$0")/../.."
for name in $(docker ps -a --format '{{.Names}}' | grep '^ec-stress-' || true); do
  docker rm -f -v "$name" >/dev/null && echo "[down] removed container $name"
done
for vol in $(docker volume ls --format '{{.Name}}' | grep '^ec-stress-' || true); do
  docker volume rm "$vol" >/dev/null && echo "[down] removed volume $vol"
done
if docker network inspect ec-stress-net >/dev/null 2>&1; then docker network rm ec-stress-net >/dev/null && echo "[down] removed network ec-stress-net"; fi
if [ "${KEEP_SECRETS:-1}" = "0" ]; then rm -rf .stress-runs/local; fi
echo "[down] ec-stress stack removed"
