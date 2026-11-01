#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder, LLC
# SPDX-License-Identifier: BUSL-1.1
#
# Put the portal behind Cloudflare (docs/edge-and-redundancy.md). Idempotent: re-running
# re-applies the same configuration.
#
#   1. DNS: apex and www proxied CNAMEs to the Fly portal; the _acme-challenge CNAME Fly needs to
#      issue the origin certificate (DNS-01, so it works with the proxy on).
#   2. TLS: Full (strict), always-HTTPS, TLS 1.2+, TLS 1.3, HSTS with preload, HTTPS rewrites.
#   3. WAF: Cloudflare managed rulesets (falls back to the free managed ruleset), a custom rule
#      that challenges high-threat clients on /auth/*, and a block on unexpected HTTP methods.
#   4. Rate limiting at the edge on the sign-in, sign-up and passkey endpoints (defence in depth
#      on top of the portal's own per-IP limits).
#   5. Origin lock: a Transform Rule adds `x-edgecoder-origin: <token>` to every forwarded
#      request; the portal (PORTAL_ORIGIN_LOCK_TOKEN) refuses requests without it, so the
#      *.fly.dev hostname cannot bypass the WAF.
#   6. Cache: the public pages and the chart library are cached at the edge (Always Online serves
#      them while the origin is down); everything under /portal, /auth, /wallet is bypassed.
#   7. Optionally sets PORTAL_EDGE/PORTAL_ORIGIN_LOCK_TOKEN on the Fly app (APPLY_FLY=1) and
#      deploys the static mirror of the public pages to Cloudflare Pages (PAGES_PROJECT=name).
#
# Required env:
#   CLOUDFLARE_API_TOKEN   token with Zone:Edit (to create the zone), Zone:Read, DNS:Edit,
#                          Zone Settings:Edit, Zone WAF:Edit, Transform Rules:Edit, Cache Rules:Edit
#                          (and Account Settings:Read for zone creation, Pages:Edit for the mirror).
#                          Or put the token in CLOUDFLARE_API_TOKEN_FILE (default
#                          ~/.config/edgecoder/cloudflare.token, mode 600) and leave the env unset.
#   DOMAIN                 the zone, e.g. edgecoder.io. Created on the account if missing (the
#                          script then prints the two nameservers to set at the registrar); the
#                          configuration is applied even while the zone is still pending.
# Optional:
#   FLY_PORTAL_HOST        origin host (default: edgecoder-portal.fly.dev)
#   FLY_PORTAL_APP         Fly app name, for `fly certs` and APPLY_FLY (default: edgecoder-portal)
#   ORIGIN_LOCK_TOKEN      shared secret for the origin lock (default: generated, printed once)
#   RATE_LIMIT_REQUESTS    auth requests per period per IP (default 10; free plan: 10 s period)
#   RATE_LIMIT_PERIOD      seconds (default 10; free plan only allows 10)
#   RATE_LIMIT_TIMEOUT     block seconds after the limit is hit (default 10; free plan: 10)
#   APPLY_FLY=1            run `fly secrets set` on FLY_PORTAL_APP with the edge settings
#   PAGES_PROJECT          Cloudflare Pages project name to deploy the static mirror to
#   ACME_CNAME_TARGET      value for _acme-challenge (default: read from `fly certs show --json`)
set -euo pipefail

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need curl; need jq; need openssl
TOKEN_FILE="${CLOUDFLARE_API_TOKEN_FILE:-$HOME/.config/edgecoder/cloudflare.token}"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -r "$TOKEN_FILE" ]; then
  CLOUDFLARE_API_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
fi
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN or write it to $TOKEN_FILE}"
: "${DOMAIN:?set DOMAIN (e.g. edgecoder.io)}"
FLY_PORTAL_HOST="${FLY_PORTAL_HOST:-edgecoder-portal.fly.dev}"
FLY_PORTAL_APP="${FLY_PORTAL_APP:-edgecoder-portal}"
RATE_LIMIT_REQUESTS="${RATE_LIMIT_REQUESTS:-10}"
RATE_LIMIT_PERIOD="${RATE_LIMIT_PERIOD:-10}"
RATE_LIMIT_TIMEOUT="${RATE_LIMIT_TIMEOUT:-10}"
API="https://api.cloudflare.com/client/v4"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
cf() { # method path [json]
  local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data "$body"
  else
    curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  fi
}
ok() { jq -e '.success == true' >/dev/null 2>&1; }
check() { # label json
  if printf '%s' "$2" | ok; then echo "  $1: ok"; else echo "  $1: FAILED $(printf '%s' "$2" | jq -c '.errors')" >&2; return 1; fi
}

# ------------------------------------------------------------------ zone ----
log "Zone $DOMAIN"
VERIFY="$(cf GET "/user/tokens/verify")"
printf '%s' "$VERIFY" | ok || { echo "API token rejected: $(printf '%s' "$VERIFY" | jq -c '.errors')" >&2; exit 1; }
ZONE_JSON="$(cf GET "/zones?name=$DOMAIN")"
ZONE_ID="$(printf '%s' "$ZONE_JSON" | jq -r '.result[0].id // empty')"
if [ -z "$ZONE_ID" ]; then
  ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(cf GET "/accounts?per_page=1" | jq -r '.result[0].id // empty')}"
  [ -n "$ACCOUNT_ID" ] || { echo "zone $DOMAIN not found and no account visible to this token (give it Account Settings:Read, or set CLOUDFLARE_ACCOUNT_ID)" >&2; exit 1; }
  echo "  creating zone $DOMAIN on account $ACCOUNT_ID"
  ZONE_JSON="$(cf POST "/zones" "$(jq -nc --arg n "$DOMAIN" --arg a "$ACCOUNT_ID" '{name:$n,account:{id:$a},type:"full"}')")"
  check "create zone" "$ZONE_JSON"
  ZONE_ID="$(printf '%s' "$ZONE_JSON" | jq -r '.result.id')"
  ZONE_JSON="$(cf GET "/zones?name=$DOMAIN")"
fi
PLAN="$(printf '%s' "$ZONE_JSON" | jq -r '.result[0].plan.legacy_id // "unknown"')"
ZONE_STATUS="$(printf '%s' "$ZONE_JSON" | jq -r '.result[0].status // "unknown"')"
NAMESERVERS="$(printf '%s' "$ZONE_JSON" | jq -r '.result[0].name_servers // [] | join(" ")')"
echo "  zone id: $ZONE_ID  plan: $PLAN  status: $ZONE_STATUS  nameservers: $NAMESERVERS"

# ------------------------------------------------------------------- dns ----
log "DNS"
upsert_dns() { # type name content proxied
  local type="$1" name="$2" content="$3" proxied="$4"
  local existing id
  existing="$(cf GET "/zones/$ZONE_ID/dns_records?type=$type&name=$name")"
  id="$(printf '%s' "$existing" | jq -r '.result[0].id // empty')"
  local payload
  payload="$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" --argjson p "$proxied" '{type:$t,name:$n,content:$c,proxied:$p,ttl:1}')"
  if [ -n "$id" ]; then check "$type $name -> $content (update)" "$(cf PUT "/zones/$ZONE_ID/dns_records/$id" "$payload")"
  else check "$type $name -> $content (create)" "$(cf POST "/zones/$ZONE_ID/dns_records" "$payload")"; fi
}
# Cloudflare imports the registrar's old A/AAAA records when the zone is added; a CNAME cannot
# coexist with them at the same name, so clear them first.
clear_dns() { # name
  for type in A AAAA; do
    for id in $(cf GET "/zones/$ZONE_ID/dns_records?type=$type&name=$1" | jq -r '.result[].id'); do
      check "delete stale $type $1" "$(cf DELETE "/zones/$ZONE_ID/dns_records/$id")" || true
    done
  done
}
clear_dns "$DOMAIN"; clear_dns "www.$DOMAIN"
upsert_dns CNAME "$DOMAIN" "$FLY_PORTAL_HOST" true
upsert_dns CNAME "www.$DOMAIN" "$DOMAIN" true
# Fly issues the origin certificate over DNS-01; the challenge record must NOT be proxied.
if [ -z "${ACME_CNAME_TARGET:-}" ] && command -v fly >/dev/null 2>&1; then
  fly certs add "$DOMAIN" -a "$FLY_PORTAL_APP" >/dev/null 2>&1 || true
  ACME_CNAME_TARGET="$(fly certs show "$DOMAIN" -a "$FLY_PORTAL_APP" --json 2>/dev/null | jq -r '.DNSValidationTarget // empty')"
fi
if [ -n "${ACME_CNAME_TARGET:-}" ]; then
  upsert_dns CNAME "_acme-challenge.$DOMAIN" "$ACME_CNAME_TARGET" false
else
  echo "  _acme-challenge: skipped (set ACME_CNAME_TARGET from 'fly certs show $DOMAIN -a $FLY_PORTAL_APP')"
fi

# ------------------------------------------------------------------- tls ----
log "TLS and security settings"
setting() { # name json-value
  check "$1=$2" "$(cf PATCH "/zones/$ZONE_ID/settings/$1" "{\"value\":$2}")" || true
}
setting ssl '"strict"'
setting always_use_https '"on"'
setting automatic_https_rewrites '"on"'
setting min_tls_version '"1.2"'
setting tls_1_3 '"on"'
setting opportunistic_encryption '"on"'
setting security_header '{"strict_transport_security":{"enabled":true,"max_age":31536000,"include_subdomains":true,"preload":true,"nosniff":true}}'
setting browser_check '"on"'
setting security_level '"medium"'
setting always_online '"on"'
setting brotli '"on"'
setting websockets '"on"'

# -------------------------------------------------------------- rulesets ----
# One entrypoint ruleset per phase; PUT replaces its rules, which keeps re-runs idempotent.
put_phase() { # phase rules-json
  local phase="$1" rules="$2"
  cf PUT "/zones/$ZONE_ID/rulesets/phases/$phase/entrypoint" "$(jq -nc --argjson r "$rules" '{rules:$r}')"
}

log "WAF managed rulesets"
MANAGED_PAID='[
  {"action":"execute","action_parameters":{"id":"efb7b8c949ac4650a09736fc376e9aee"},"expression":"true","description":"Cloudflare Managed Ruleset","enabled":true},
  {"action":"execute","action_parameters":{"id":"4814384a9e5d4991b9815dcfc25d2f1f"},"expression":"true","description":"Cloudflare OWASP Core Ruleset","enabled":true}
]'
MANAGED_FREE='[
  {"action":"execute","action_parameters":{"id":"77454fe2d30c4220b5701f6fdfb893ba"},"expression":"true","description":"Cloudflare Free Managed Ruleset","enabled":true}
]'
R="$(put_phase http_request_firewall_managed "$MANAGED_PAID")"
if printf '%s' "$R" | ok; then echo "  managed + OWASP: ok"; else
  echo "  managed + OWASP not available on plan '$PLAN' ($(printf '%s' "$R" | jq -r '.errors[0].message // "?"')); applying the free managed ruleset"
  check "free managed ruleset" "$(put_phase http_request_firewall_managed "$MANAGED_FREE")" || true
fi

log "WAF custom rules"
CUSTOM='[
  {"action":"managed_challenge","expression":"(starts_with(http.request.uri.path, \"/auth/\") and cf.threat_score gt 20)","description":"Challenge risky clients on auth endpoints","enabled":true},
  {"action":"block","expression":"(not http.request.method in {\"GET\" \"HEAD\" \"POST\" \"PUT\" \"PATCH\" \"DELETE\" \"OPTIONS\"})","description":"Block unexpected HTTP methods","enabled":true},
  {"action":"block","expression":"(http.request.uri.path contains \"/.git\" or http.request.uri.path contains \"/.env\" or http.request.uri.path contains \"/wp-\")","description":"Block common scanner paths","enabled":true}
]'
check "custom rules" "$(put_phase http_request_firewall_custom "$CUSTOM")" || true

log "Edge rate limiting (auth endpoints)"
RL="$(jq -nc --argjson req "$RATE_LIMIT_REQUESTS" --argjson per "$RATE_LIMIT_PERIOD" --argjson to "$RATE_LIMIT_TIMEOUT" '[{
  action:"block",
  ratelimit:{characteristics:["ip.src","cf.colo.id"],period:$per,requests_per_period:$req,mitigation_timeout:$to},
  expression:"(http.request.method eq \"POST\" and (http.request.uri.path in {\"/auth/login\" \"/auth/signup\" \"/auth/resend-verification\"} or starts_with(http.request.uri.path, \"/auth/passkey/\") or starts_with(http.request.uri.path, \"/wallet/send/mfa/\")))",
  description:"Auth and wallet MFA brute-force limit", enabled:true}]')"
check "rate limit $RATE_LIMIT_REQUESTS/$RATE_LIMIT_PERIOD s" "$(put_phase http_ratelimit "$RL")" || true

log "Origin lock (transform rule)"
if [ -z "${ORIGIN_LOCK_TOKEN:-}" ]; then
  ORIGIN_LOCK_TOKEN="$(openssl rand -hex 24)"
  GENERATED_LOCK=1
fi
TRANSFORM="$(jq -nc --arg t "$ORIGIN_LOCK_TOKEN" '[{action:"rewrite",action_parameters:{headers:{"x-edgecoder-origin":{operation:"set",value:$t}}},expression:"true",description:"Origin lock header for the EdgeCoder portal",enabled:true}]')"
check "x-edgecoder-origin header" "$(put_phase http_request_late_transform "$TRANSFORM")"

log "Cache rules"
CACHE='[
  {"action":"set_cache_settings","action_parameters":{"cache":false},
   "expression":"(starts_with(http.request.uri.path, \"/portal\") and not starts_with(http.request.uri.path, \"/portal/vendor/\")) or starts_with(http.request.uri.path, \"/auth\") or starts_with(http.request.uri.path, \"/wallet\") or starts_with(http.request.uri.path, \"/nodes\") or starts_with(http.request.uri.path, \"/me\") or starts_with(http.request.uri.path, \"/internal\")",
   "description":"Never cache authenticated or API paths","enabled":true},
  {"action":"set_cache_settings","action_parameters":{"cache":true,"edge_ttl":{"mode":"override_origin","default":300},"browser_ttl":{"mode":"override_origin","default":60}},
   "expression":"(http.request.uri.path in {\"/\" \"/privacy\" \"/terms\"} or starts_with(http.request.uri.path, \"/portal/vendor/\"))",
   "description":"Cache the public pages and vendor assets (Always Online)","enabled":true}
]'
check "cache rules" "$(put_phase http_request_cache_settings "$CACHE")" || true

# ------------------------------------------------------------------- fly ----
if [ "${APPLY_FLY:-0}" = "1" ]; then
  log "Fly secrets on $FLY_PORTAL_APP"
  need fly
  fly secrets set -a "$FLY_PORTAL_APP" "PORTAL_EDGE=cloudflare" "PORTAL_ORIGIN_LOCK_TOKEN=$ORIGIN_LOCK_TOKEN"
fi

# ----------------------------------------------------------------- pages ----
if [ -n "${PAGES_PROJECT:-}" ]; then
  log "Static mirror -> Cloudflare Pages project $PAGES_PROJECT"
  PORTAL_PUBLIC_URL="https://$DOMAIN" npx tsx scripts/export-static-site.ts dist-static >/dev/null
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npx --yes wrangler@3 pages deploy dist-static --project-name "$PAGES_PROJECT" --commit-dirty=true
fi

log "Done"
if [ "$ZONE_STATUS" != "active" ]; then
  cat <<EOF
  ZONE IS $ZONE_STATUS: at the registrar (GoDaddy: Domain > DNS > Nameservers > Change > custom)
  set the nameservers to:  $NAMESERVERS
  Cloudflare activates the zone once it sees them (minutes to a few hours). Re-run this script
  afterwards only if something failed above; the configuration is already stored.
EOF
fi
cat <<EOF
  $DOMAIN and www.$DOMAIN are proxied to $FLY_PORTAL_HOST (TLS Full strict, HSTS, WAF, rate limits, cache).
  Origin lock token: ${GENERATED_LOCK:+(generated) }$ORIGIN_LOCK_TOKEN
EOF
if [ "${APPLY_FLY:-0}" != "1" ]; then
  cat <<EOF
  Set it on the portal (requests without it are refused once set):
    fly secrets set -a $FLY_PORTAL_APP PORTAL_EDGE=cloudflare PORTAL_ORIGIN_LOCK_TOKEN=$ORIGIN_LOCK_TOKEN
EOF
fi
cat <<EOF
  Check the Fly certificate: fly certs check $DOMAIN -a $FLY_PORTAL_APP
  Verify: curl -sI https://$DOMAIN/ | grep -i '^cf-ray'   (served by Cloudflare)
          curl -s https://$FLY_PORTAL_HOST/portal          (403 origin_locked once the secret is set)
EOF
