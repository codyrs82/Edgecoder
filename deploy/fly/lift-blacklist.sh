#!/usr/bin/env bash
# Lift an agent's blacklist on both seeds: bash deploy/fly/lift-blacklist.sh <agentId> [reason]
# Calls each seed's own admin route from inside the machine, so the admin token never leaves it.
set -euo pipefail
agent=${1:?usage: lift-blacklist.sh <agentId> [reason]}
reason=${2:-lifted by operator}
[[ "$agent" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad agent id" >&2; exit 1; }
export FLY_API_TOKEN="${FLY_API_TOKEN:-$(cat ~/.config/edgecoder/fly.token)}"
body=$(jq -cn --arg r "$reason" '{reason: $r}' | base64 | tr -d '\n')
for app in edgecoder-seed edgecoder-seed-eu; do
  printf '%s: ' "$app"
  fly ssh console -a "$app" -q -C "node -e \"fetch('http://127.0.0.1:4301/security/blacklist/$agent/lift',{method:'POST',headers:{'content-type':'application/json','x-admin-token':process.env.ADMIN_API_TOKEN,'x-mesh-token':process.env.MESH_AUTH_TOKEN},body:Buffer.from('$body','base64').toString()}).then(async r=>console.log(r.status,JSON.stringify((await r.json()).error??'lifted')))\"" 2>&1 | grep -v '^Connecting' | tail -1
done
