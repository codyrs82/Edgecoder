#!/usr/bin/env bash
# Bootstrap (or re-deploy) the whole EdgeCoder stack into a Fly.io organization of its own.
#
#   FLY_API_TOKEN=... scripts/fly-bootstrap-org.sh <fly-org-slug> [app-prefix]
#
# What it does, idempotently (safe to re-run; existing apps/volumes/secrets are kept):
#   1. creates the apps  <prefix>-seed (ord), <prefix>-seed-eu (cdg), <prefix>-portal (ord)
#      and, only when BITCOIND_RPC_URL is set, <prefix>-anchor-proxy
#   2. creates one Fly Postgres cluster <prefix>-pg and attaches it:
#        seeds  -> DATABASE_URL          (database <prefix>_seed)
#        portal -> PORTAL_DATABASE_URL   (database <prefix>_portal)
#   3. creates the Ollama model volumes (ollama_data in ord, ollama_data_eu in cdg)
#   4. generates every shared secret the services require in production (NODE_ENV=production
#      fails fast without them, see src/common/env-guard.ts and src/*/config.ts) and sets them;
#      values are written once to .fly-bootstrap/<org>.env (chmod 600, git-ignored)
#   5. renders deploy/fly/*.toml for the prefix/domain into .fly-bootstrap/<org>/ and deploys
#      seeds first, then the portal, then (optionally) the anchor proxy
#   6. runs the #9 post-deploy step on each seed (chown the volume to uid 1000, restart)
#   7. smoke-tests /health/runtime, /status, /capacity on the seeds and /health on the portal
#
# Inputs (environment):
#   FLY_API_TOKEN            required unless `fly auth whoami` already works
#   APP_PREFIX               default: second argument, else "edgecoder"
#   PORTAL_DOMAIN            custom portal host (e.g. edgecoder.io). Default: <prefix>-portal.fly.dev.
#                            With a custom domain the script also runs `fly certs add`; you then
#                            point DNS at the app (fly certs show prints the records).
#   RESEND_API_KEY           required by the portal in production (email verification). The
#                            script refuses to continue without it unless ALLOW_PLACEHOLDER_RESEND=1
#                            (portal boots, signup email never arrives).
#   RESEND_FROM_EMAIL        default: noreply@<PORTAL_DOMAIN>
#   OAUTH_GOOGLE_CLIENT_ID / OAUTH_GOOGLE_CLIENT_SECRET / OAUTH_MICROSOFT_CLIENT_ID /
#   OAUTH_MICROSOFT_CLIENT_SECRET   optional SSO, forwarded to the portal when set
#   BITCOIND_RPC_URL / BITCOIND_RPC_USER / BITCOIND_RPC_PASSWORD / BITCOIND_WALLET_NAME
#                            when set, the anchor proxy is deployed and the seeds get
#                            BITCOIN_ANCHOR_PROVIDER=anchor-proxy pointed at it
#   SKIP_DEPLOY=1            create apps/db/volumes/secrets only, don't build or deploy
#   SKIP_PG=1                don't create/attach Postgres (you set DATABASE_URL / PORTAL_DATABASE_URL yourself)
#   PG_REGION                default ord;  PG_VM_SIZE default shared-cpu-1x;  PG_VOLUME_GB default 10
#   OLLAMA_VOLUME_GB         default 20
#
# Requirements: flyctl >= 0.3 on PATH, curl, openssl, python3 (TOML rewrite). Run from the repo root.
set -euo pipefail

ORG="${1:?usage: fly-bootstrap-org.sh <fly-org-slug> [app-prefix]}"
APP_PREFIX="${APP_PREFIX:-${2:-edgecoder}}"
SEED="${APP_PREFIX}-seed"
SEED_EU="${APP_PREFIX}-seed-eu"
PORTAL="${APP_PREFIX}-portal"
ANCHOR="${APP_PREFIX}-anchor-proxy"
PG_APP="${APP_PREFIX}-pg"
PORTAL_DOMAIN="${PORTAL_DOMAIN:-${PORTAL}.fly.dev}"
PORTAL_URL="https://${PORTAL_DOMAIN}"
SEED_URL="https://${SEED}.fly.dev"
SEED_EU_URL="https://${SEED_EU}.fly.dev"
ANCHOR_URL="https://${ANCHOR}.fly.dev"
OUT_DIR=".fly-bootstrap"
RENDER_DIR="${OUT_DIR}/${ORG}"
SECRETS_FILE="${OUT_DIR}/${ORG}.env"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n==> %s\n' "$*"; }
die() { echo "fly-bootstrap: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
need flyctl; need curl; need openssl; need python3
fly() { flyctl "$@"; }

[ -f deploy/fly/fly.seed-node.toml ] || die "run from the repository root (deploy/fly/*.toml not found)"
fly auth whoami >/dev/null 2>&1 || die "not logged in: set FLY_API_TOKEN or run 'fly auth login'"
fly orgs list 2>/dev/null | grep -qw -- "$ORG" || die "org '$ORG' not found in 'fly orgs list' (create it in the Fly dashboard first)"

if [ -z "${RESEND_API_KEY:-}" ] && [ "${ALLOW_PLACEHOLDER_RESEND:-0}" != "1" ]; then
  die "RESEND_API_KEY is required by the portal in production (signup email). Export it, or ALLOW_PLACEHOLDER_RESEND=1 to deploy a portal whose signup emails never send."
fi
WITH_ANCHOR=0
if [ -n "${BITCOIND_RPC_URL:-}" ]; then
  [ -n "${BITCOIND_RPC_USER:-}" ] && [ -n "${BITCOIND_RPC_PASSWORD:-}" ] || die "BITCOIND_RPC_URL is set but BITCOIND_RPC_USER / BITCOIND_RPC_PASSWORD are not"
  WITH_ANCHOR=1
fi

mkdir -p "$RENDER_DIR"
chmod 700 "$OUT_DIR"

# ---------------------------------------------------------------- secrets ----
# Generated once per org and reused on re-runs so a redeploy never rotates tokens by accident.
if [ -f "$SECRETS_FILE" ]; then
  log "Reusing secrets from $SECRETS_FILE"
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
else
  log "Generating secrets -> $SECRETS_FILE"
  gen() { openssl rand -hex 32; }
  MESH_AUTH_TOKEN="$(gen)"
  ADMIN_API_TOKEN="$(gen)"
  INFERENCE_AUTH_TOKEN="$(gen)"
  PORTAL_SERVICE_TOKEN="$(gen)"
  PAYMENT_WEBHOOK_SECRET="$(gen)"
  WALLET_SECRET_PEPPER="$(gen)"
  COORDINATOR_REGISTRATION_TOKEN="$(gen)"
  ANCHOR_PROXY_TOKEN="$(gen)"
  umask 077
  cat > "$SECRETS_FILE" <<EOF
# Generated by scripts/fly-bootstrap-org.sh for Fly org '${ORG}' (prefix '${APP_PREFIX}') on $(date -u +%FT%TZ).
# Keep private. Re-running the script reuses these values.
MESH_AUTH_TOKEN=${MESH_AUTH_TOKEN}
ADMIN_API_TOKEN=${ADMIN_API_TOKEN}
INFERENCE_AUTH_TOKEN=${INFERENCE_AUTH_TOKEN}
PORTAL_SERVICE_TOKEN=${PORTAL_SERVICE_TOKEN}
PAYMENT_WEBHOOK_SECRET=${PAYMENT_WEBHOOK_SECRET}
WALLET_SECRET_PEPPER=${WALLET_SECRET_PEPPER}
COORDINATOR_REGISTRATION_TOKEN=${COORDINATOR_REGISTRATION_TOKEN}
ANCHOR_PROXY_TOKEN=${ANCHOR_PROXY_TOKEN}
EOF
fi

# ------------------------------------------------------------------- apps ----
app_exists() { fly apps list --org "$ORG" --json 2>/dev/null | python3 -c 'import json,sys; names={a.get("Name") or a.get("name") for a in json.load(sys.stdin)}; sys.exit(0 if sys.argv[1] in names else 1)' "$1"; }
ensure_app() {
  if app_exists "$1"; then echo "app $1: exists"; else log "Creating app $1 in org $ORG"; fly apps create "$1" --org "$ORG"; fi
}
log "Apps"
ensure_app "$SEED"; ensure_app "$SEED_EU"; ensure_app "$PORTAL"
[ "$WITH_ANCHOR" = 1 ] && ensure_app "$ANCHOR"

# --------------------------------------------------------------- postgres ----
if [ "${SKIP_PG:-0}" != "1" ]; then
  log "Postgres"
  pg_has_machines() { fly machines list -a "$PG_APP" --json 2>/dev/null | python3 -c 'import json,sys; sys.exit(0 if len(json.load(sys.stdin))>0 else 1)'; }
  if app_exists "$PG_APP" && pg_has_machines; then
    echo "postgres $PG_APP: exists"
  else
    if app_exists "$PG_APP"; then
      # A previous run created the app but not its machine/volume (e.g. no payment method yet).
      # `fly postgres create` can't adopt an empty app, so remove it and create the cluster fresh.
      echo "postgres $PG_APP: app exists without machines; recreating"
      fly apps destroy "$PG_APP" --yes
    fi
    fly postgres create --name "$PG_APP" --org "$ORG" --region "${PG_REGION:-ord}" \
      --vm-size "${PG_VM_SIZE:-shared-cpu-1x}" --volume-size "${PG_VOLUME_GB:-10}" --initial-cluster-size 1 \
      || die "Postgres cluster creation failed (a new org needs a payment method at https://fly.io/dashboard/$ORG/billing before volumes over 1 GB can be created)"
  fi
  # `fly postgres attach` sets the connection string as a secret on the target app. It
  # fails if that app already has the variable, so re-runs just report "already attached".
  attach() { # app variable database
    if fly secrets list -a "$1" 2>/dev/null | awk '{print $1}' | grep -qx "$2"; then
      echo "$1: $2 already set"
    else
      fly postgres attach "$PG_APP" -a "$1" --variable-name "$2" --database-name "$3" --yes
    fi
  }
  attach "$SEED"    DATABASE_URL        "${APP_PREFIX//-/_}_seed"
  attach "$SEED_EU" DATABASE_URL        "${APP_PREFIX//-/_}_seed"
  attach "$PORTAL"  PORTAL_DATABASE_URL "${APP_PREFIX//-/_}_portal"
fi

# ---------------------------------------------------------------- volumes ----
ensure_volume() { # app name region
  if fly volumes list -a "$1" --json 2>/dev/null | python3 -c 'import json,sys; sys.exit(0 if any(v.get("name")==sys.argv[1] for v in json.load(sys.stdin)) else 1)' "$2"; then
    echo "$1: volume $2 exists"
  else
    log "Creating volume $2 for $1 in $3"
    fly volumes create "$2" -a "$1" --region "$3" --size "${OLLAMA_VOLUME_GB:-20}" --yes
  fi
}
log "Volumes"
ensure_volume "$SEED" ollama_data ord
ensure_volume "$SEED_EU" ollama_data_eu cdg

# ---------------------------------------------------------------- secrets ----
log "Secrets"
SEED_SECRETS=(
  "MESH_AUTH_TOKEN=${MESH_AUTH_TOKEN}"
  "ADMIN_API_TOKEN=${ADMIN_API_TOKEN}"
  "INFERENCE_AUTH_TOKEN=${INFERENCE_AUTH_TOKEN}"
  "PORTAL_SERVICE_URL=${PORTAL_URL}"
  "PORTAL_SERVICE_TOKEN=${PORTAL_SERVICE_TOKEN}"
  "PAYMENT_WEBHOOK_SECRET=${PAYMENT_WEBHOOK_SECRET}"
  "COORDINATOR_REGISTRATION_TOKEN=${COORDINATOR_REGISTRATION_TOKEN}"
)
if [ "$WITH_ANCHOR" = 1 ]; then
  SEED_SECRETS+=("BITCOIN_ANCHOR_PROVIDER=anchor-proxy" "ANCHOR_PROXY_URL=${ANCHOR_URL}" "ANCHOR_PROXY_TOKEN=${ANCHOR_PROXY_TOKEN}")
fi
# Each seed bootstraps its mesh from the other one.
fly secrets set -a "$SEED"    --stage "${SEED_SECRETS[@]}" "COORDINATOR_BOOTSTRAP_URLS=${SEED_EU_URL}"
fly secrets set -a "$SEED_EU" --stage "${SEED_SECRETS[@]}" "COORDINATOR_BOOTSTRAP_URLS=${SEED_URL}"

PORTAL_SECRETS=(
  "PORTAL_SERVICE_TOKEN=${PORTAL_SERVICE_TOKEN}"
  "WALLET_SECRET_PEPPER=${WALLET_SECRET_PEPPER}"
  "RESEND_API_KEY=${RESEND_API_KEY:-placeholder-not-configured}"
  "RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL:-noreply@${PORTAL_DOMAIN}}"
  # Portal -> seed privileged calls (the control plane lives inside the all-in-one seed).
  "CONTROL_PLANE_ADMIN_TOKEN=${ADMIN_API_TOKEN}"
)
for v in OAUTH_GOOGLE_CLIENT_ID OAUTH_GOOGLE_CLIENT_SECRET OAUTH_MICROSOFT_CLIENT_ID OAUTH_MICROSOFT_CLIENT_SECRET; do
  [ -n "${!v:-}" ] && PORTAL_SECRETS+=("$v=${!v}")
done
fly secrets set -a "$PORTAL" --stage "${PORTAL_SECRETS[@]}"

if [ "$WITH_ANCHOR" = 1 ]; then
  fly secrets set -a "$ANCHOR" --stage \
    "ANCHOR_PROXY_TOKEN=${ANCHOR_PROXY_TOKEN}" \
    "BITCOIND_RPC_URL=${BITCOIND_RPC_URL}" "BITCOIND_RPC_USER=${BITCOIND_RPC_USER}" \
    "BITCOIND_RPC_PASSWORD=${BITCOIND_RPC_PASSWORD}" "BITCOIND_WALLET_NAME=${BITCOIND_WALLET_NAME:-}"
fi

# ----------------------------------------------------------------- render ----
# deploy/fly/*.toml hardcode the original app names, edgecoder.io and relative Dockerfile
# paths. Render copies for this org: app names/URLs get the prefix, the portal's public and
# passkey origin become PORTAL_DOMAIN, Dockerfile paths become absolute.
log "Rendering Fly configs -> $RENDER_DIR"
python3 - "$REPO_ROOT" "$RENDER_DIR" "$APP_PREFIX" "$PORTAL_DOMAIN" <<'PY'
import re, sys, pathlib
root, out, prefix, domain = sys.argv[1:5]
src = pathlib.Path(root, "deploy", "fly")
for name in ["fly.seed-node.toml", "fly.seed-eu.toml", "fly.portal.toml", "fly.anchor-proxy.toml"]:
    s = (src / name).read_text()
    s = s.replace('dockerfile = "../docker/', f'dockerfile = "{root}/deploy/docker/')
    s = s.replace('dockerfile = "../../Dockerfile.anchor-proxy"', f'dockerfile = "{root}/Dockerfile.anchor-proxy"')
    s = re.sub(r'\bedgecoder-(seed-eu|seed|portal|anchor-proxy)\b', lambda m: f"{prefix}-{m.group(1)}", s)
    if name == "fly.portal.toml":
        s = s.replace('PORTAL_PUBLIC_URL = "https://edgecoder.io"', f'PORTAL_PUBLIC_URL = "https://{domain}"')
        s = s.replace('PASSKEY_RP_ID = "edgecoder.io"', f'PASSKEY_RP_ID = "{domain}"')
        s = s.replace('PASSKEY_ORIGIN = "https://edgecoder.io"', f'PASSKEY_ORIGIN = "https://{domain}"')
    pathlib.Path(out, name).write_text(s)
    print(f"  {name}")
PY

if [ "${SKIP_DEPLOY:-0}" = "1" ]; then
  log "SKIP_DEPLOY=1: apps, database, volumes and secrets are in place; not deploying."
  exit 0
fi

# ----------------------------------------------------------------- deploy ----
deploy() { # app toml
  log "Deploying $1"
  fly deploy --config "$RENDER_DIR/$2" --app "$1" --remote-only --wait-timeout 600
  fly status --app "$1"
}
post_deploy_seed() { # app
  # #9: Fly volumes are root-owned and hide the image's chown; Ollama (uid 1000) needs the dir writable.
  log "Post-deploy (#9) for $1: chown /data/ollama, restart"
  fly ssh console --app "$1" -C "chown -R 1000:1000 /data/ollama" || echo "  chown failed (machine still starting?) - rerun: fly ssh console -a $1 -C 'chown -R 1000:1000 /data/ollama'"
  fly apps restart "$1"
}
smoke() { # url
  for _ in $(seq 1 30); do curl -fsS -m 10 "$1" -o /dev/null && { echo "  ok  $1"; return 0; }; sleep 6; done
  echo "  FAIL $1"; return 1
}

deploy "$SEED" fly.seed-node.toml;  post_deploy_seed "$SEED"
deploy "$SEED_EU" fly.seed-eu.toml; post_deploy_seed "$SEED_EU"
deploy "$PORTAL" fly.portal.toml
[ "$WITH_ANCHOR" = 1 ] && deploy "$ANCHOR" fly.anchor-proxy.toml

if [ "$PORTAL_DOMAIN" != "${PORTAL}.fly.dev" ]; then
  log "TLS certificate for $PORTAL_DOMAIN"
  fly certs add "$PORTAL_DOMAIN" -a "$PORTAL" || true
  fly certs show "$PORTAL_DOMAIN" -a "$PORTAL" || true
  echo "  Point DNS for $PORTAL_DOMAIN at the $PORTAL app (A/AAAA from 'fly ips list -a $PORTAL', or CNAME ${PORTAL}.fly.dev)."
fi

# ------------------------------------------------------------------ smoke ----
log "Smoke tests"
rc=0
smoke "$SEED_URL/health/runtime" || rc=1
smoke "$SEED_EU_URL/health/runtime" || rc=1
smoke "https://${PORTAL}.fly.dev/health" || rc=1
[ "$WITH_ANCHOR" = 1 ] && { smoke "$ANCHOR_URL/health" || rc=1; }
for u in "$SEED_URL" "$SEED_EU_URL"; do
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "x-mesh-token: ${MESH_AUTH_TOKEN}" "$u/capacity" || true)
  [ "$code" = "200" ] && echo "  ok  $u/capacity (mesh-auth)" || { echo "  FAIL $u/capacity -> $code"; rc=1; }
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$u/status" || true)
  [ "$code" = "401" ] && echo "  ok  $u/status rejects anonymous (401)" || { echo "  WARN $u/status anonymous -> $code (expected 401)"; }
done

cat <<EOF

Done. Org: $ORG   prefix: $APP_PREFIX
  Portal        $PORTAL_URL        (fly.dev: https://${PORTAL}.fly.dev)
  Seed (ord)    $SEED_URL
  Seed (cdg)    $SEED_EU_URL
$( [ "$WITH_ANCHOR" = 1 ] && echo "  Anchor proxy  $ANCHOR_URL" )
  Secrets       $SECRETS_FILE (keep private; MESH_AUTH_TOKEN is what agents need to join)

Next: enrol a node in the portal (Nodes page), start a worker with the registration token and
MESH_AUTH_TOKEN, and watch $SEED_URL/capacity. Ollama pulls OLLAMA_MODEL on first use.
EOF
exit $rc
