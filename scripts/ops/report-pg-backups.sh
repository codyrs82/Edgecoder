#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder
# SPDX-License-Identifier: BUSL-1.1
#
# Production alerting, rule 6 (Postgres backups). The coordinators and the portal cannot run
# `fly postgres backup list`, so this scheduled check does it and tells the portal the time of the
# newest successful backup of each database:
#
#   POST $PORTAL_URL/internal/alerts/backup-report   (x-portal-service-token)
#   { "app": "<fly postgres app>", "lastSuccessAt": "<ISO time>" | null, "detail": "..." }
#
# The portal alerts when a database's newest successful backup is older than
# ALERT_BACKUP_MAX_AGE_HOURS (26), and, with ALERT_BACKUP_EXPECTED=1, when this check itself
# stops reporting for that long (a dead man's switch). Run it every few hours from anything with
# flyctl and a Fly token: a GitHub Actions schedule, cron on an ops machine, or a Fly scheduled
# machine. See site-docs/reference/environment-variables.md ("Production alerting").
#
# Environment:
#   PORTAL_URL             e.g. https://edgecoder.io
#   PORTAL_SERVICE_TOKEN   the portal's service token (never printed)
#   PG_APPS                comma-separated Fly Postgres app names, e.g. edgecoder-portal-db,edgecoder-coord-db
#   FLY_API_TOKEN          for flyctl (read by flyctl itself)
#   DRY_RUN=1              print the reports instead of sending them
set -euo pipefail

: "${PORTAL_URL:?set PORTAL_URL}"
: "${PG_APPS:?set PG_APPS}"
if [[ "${DRY_RUN:-}" != "1" ]]; then : "${PORTAL_SERVICE_TOKEN:?set PORTAL_SERVICE_TOKEN}"; fi
FLY="${FLY_BIN:-fly}"

status=0
IFS=',' read -r -a apps <<<"$PG_APPS"
for app in "${apps[@]}"; do
  app="$(echo "$app" | tr -d '[:space:]')"
  [[ -z "$app" ]] && continue
  if ! listing="$("$FLY" postgres backup list -a "$app" --json 2>&1)"; then
    # Report the failure as "no successful backup known" with the reason, so the portal alerts.
    detail="fly postgres backup list failed: $(echo "$listing" | head -c 300)"
    body="$(APP="$app" DETAIL="$detail" node -e 'process.stdout.write(JSON.stringify({ app: process.env.APP, lastSuccessAt: null, detail: process.env.DETAIL }))')"
    status=1
  else
    # Newest timestamp among backups whose status reads as finished successfully. Field names differ
    # between flyctl versions, so every date-looking value of a successful entry is considered.
    body="$(APP="$app" LISTING="$listing" node -e '
      const app = process.env.APP;
      let rows = [];
      try { const j = JSON.parse(process.env.LISTING); rows = Array.isArray(j) ? j : (j.backups || j.Backups || j.data || []); } catch { rows = []; }
      const ok = (r) => /^(complete|completed|success|succeeded|done)$/i.test(String(r.status ?? r.Status ?? r.state ?? r.State ?? ""));
      let newest = null;
      for (const r of rows.filter(ok)) for (const v of Object.values(r)) {
        if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) continue;
        const t = Date.parse(v); if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
      }
      process.stdout.write(JSON.stringify({ app, lastSuccessAt: newest === null ? null : new Date(newest).toISOString(), detail: rows.length + " backups listed, " + rows.filter(ok).length + " successful" }));
    ')"
  fi
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "$body"
    continue
  fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${PORTAL_URL%/}/internal/alerts/backup-report" \
    -H "content-type: application/json" -H "x-portal-service-token: ${PORTAL_SERVICE_TOKEN}" --data "$body" || echo 000)"
  echo "$app: reported ($code)"
  [[ "$code" == "200" ]] || status=1
done
exit $status
