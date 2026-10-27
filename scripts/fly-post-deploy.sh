#!/usr/bin/env bash
# #9: one-time steps after the first deploy of the non-root agent image to Fly.
# Gated with the deploy itself: refuses to run unless DEPLOY_ENABLED=true (see #31).
#
#   DEPLOY_ENABLED=true FLY_API_TOKEN=... scripts/fly-post-deploy.sh deploy/fly/fly.seed-node.toml
#
# For configs that mount the Ollama models volume (/data/ollama), this:
#   1. chowns the volume to the `node` user (uid 1000). New Fly volumes are root-owned
#      and the mount hides the image's own chown. `fly ssh console` runs as root.
#   2. restarts the app so Ollama starts with a writable models dir.
# Then, for every config, it smoke-tests the portal's /health.
set -euo pipefail

if [ "${DEPLOY_ENABLED:-}" != "true" ]; then
  echo "fly-post-deploy: DEPLOY_ENABLED is not 'true'; deploys are disabled until #31. Nothing done." >&2
  exit 1
fi

cfg="${1:?usage: fly-post-deploy.sh <deploy/fly/*.toml> [portal-health-url]}"
portal_health="${2:-${PORTAL_HEALTH_URL:-https://edgecoder-portal.fly.dev/health}}"
app=$(sed -n 's/^app = "\(.*\)"/\1/p' "$cfg" | head -1)
[ -n "$app" ] || { echo "fly-post-deploy: no app name in $cfg" >&2; exit 1; }

if grep -q 'destination = "/data/ollama"' "$cfg"; then
  echo "fly-post-deploy: $app: chown -R 1000:1000 /data/ollama"
  flyctl ssh console --app "$app" -C "chown -R 1000:1000 /data/ollama"
  echo "fly-post-deploy: $app: restart"
  flyctl apps restart "$app"
  flyctl status --app "$app"
fi

echo "fly-post-deploy: smoke-testing portal at $portal_health"
for i in $(seq 1 20); do
  if curl -fsS "$portal_health" -o /dev/null; then
    echo "fly-post-deploy: portal healthy"
    exit 0
  fi
  sleep 6
done
echo "fly-post-deploy: portal smoke test failed: $portal_health" >&2
exit 1
