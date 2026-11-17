#!/usr/bin/env bash
# scb-watch: ship LND's static channel backup (channel.backup) off the node on every change.
# Started in the background by `entrypoint.sh lnd` (README: "Automatic channel backups").
#
# Every SCB_POLL_SECONDS (60) it hashes channel.backup. When the hash changes it:
#   1. keeps a timestamped copy in SCB_HISTORY_DIR (/data/scb-history, the last SCB_HISTORY_KEEP = 30),
#   2. if an S3 bucket is configured (Fly Tigris), PUTs it as <prefix>channel.backup (the latest)
#      and <prefix>history/channel-<UTC time>.backup, and deletes the remote history copies that
#      have fallen out of the local last-30. A failed upload is retried on the next poll.
# The file is encrypted with the wallet seed: useless without the 24 words.
#
# S3 settings (fly secrets, staged; all four or none):
#   SCB_S3_ENDPOINT          e.g. https://fly.storage.tigris.dev
#   SCB_S3_BUCKET            e.g. edgecoder-lnd-scb
#   SCB_S3_ACCESS_KEY_ID, SCB_S3_SECRET_ACCESS_KEY
# Optional env: SCB_S3_REGION (auto), SCB_S3_PREFIX (edgecoder-lnd/).
# The credentials go to curl in a config file under SCB_RUN_DIR (the machine's rootfs), never onto
# a command line or into the logs. SCB_WATCH_ONCE=1 runs one pass and exits (tests, manual runs).
set -euo pipefail
SCB=${SCB_PATH:-/data/data/chain/bitcoin/mainnet/channel.backup}
HIST=${SCB_HISTORY_DIR:-/data/scb-history}
KEEP=${SCB_HISTORY_KEEP:-30}
EVERY=${SCB_POLL_SECONDS:-60}
RUN=${SCB_RUN_DIR:-/tmp}
PREFIX=${SCB_S3_PREFIX:-edgecoder-lnd/}
REGION=${SCB_S3_REGION:-auto}
umask 077

log() { echo "scb-watch: $*" >&2; }

s3=0
if [ -n "${SCB_S3_ENDPOINT:-}${SCB_S3_BUCKET:-}${SCB_S3_ACCESS_KEY_ID:-}${SCB_S3_SECRET_ACCESS_KEY:-}" ]; then
  for v in SCB_S3_ENDPOINT SCB_S3_BUCKET SCB_S3_ACCESS_KEY_ID SCB_S3_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || { log "$v is not set; S3 upload needs all four SCB_S3_* settings (README: Automatic channel backups)"; exit 2; }
    case "${!v}" in *$'\n'* | *$'\r'* | *'"'* | *\\*) log "$v must be a single line without quotes or backslashes"; exit 2 ;; esac
  done
  printf 'user = "%s:%s"\n' "$SCB_S3_ACCESS_KEY_ID" "$SCB_S3_SECRET_ACCESS_KEY" > "$RUN/scb-s3.conf"
  s3=1
  BASE="${SCB_S3_ENDPOINT%/}/$SCB_S3_BUCKET/$PREFIX"
  log "uploading to s3 bucket $SCB_S3_BUCKET at ${SCB_S3_ENDPOINT%/} (prefix $PREFIX)"
else
  log "no SCB_S3_* settings: keeping local history in $HIST only, NOT shipping off the node"
fi

mkdir -p "$HIST"
if command -v sha256sum > /dev/null; then sha256() { sha256sum "$@"; }; else sha256() { shasum -a 256 "$@"; }; fi
sha() { sha256 "$1" | cut -d' ' -f1; }

# s3_req METHOD key [file]: one signed request. Prints the HTTP status.
s3_req() {
  local m=$1 key=$2 f=${3:-} hash data=()
  if [ -n "$f" ]; then hash=$(sha "$f"); data=(--data-binary "@$f")
  else hash=$(printf '' | sha256 | cut -d' ' -f1); fi
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -K "$RUN/scb-s3.conf" \
    --aws-sigv4 "aws:amz:$REGION:s3" -X "$m" -H "x-amz-content-sha256: $hash" \
    -H 'content-type: application/octet-stream' ${data[@]+"${data[@]}"} "$BASE$key" 2> /dev/null || true
}

# Remote history names, oldest first: what was uploaded and not yet deleted.
REMOTE="$HIST/.remote"
touch "$HIST/.last" "$HIST/.uploaded" "$REMOTE"

pass() {
  [ -s "$SCB" ] || return 0
  cp "$SCB" "$HIST/.tmp"
  local sum name code
  sum=$(sha "$HIST/.tmp")
  if [ "$sum" != "$(cat "$HIST/.last")" ]; then
    name="channel-$(date -u +%Y%m%dT%H%M%SZ).backup"
    mv "$HIST/.tmp" "$HIST/$name"
    printf '%s' "$sum" > "$HIST/.last"
    log "channel.backup changed: saved $HIST/$name ($(wc -c < "$HIST/$name" | tr -d ' ') bytes, sha256 ${sum:0:12})"
    # Keep the newest $KEEP copies (names sort by time).
    ls -1 "$HIST" | grep -E '^channel-[0-9TZ]+\.backup$' | sort | awk -v k="$KEEP" '{a[NR]=$0} END {for (i = 1; i <= NR - k; i++) print a[i]}' | while read -r old; do rm -f "$HIST/$old"; done
  else
    rm -f "$HIST/.tmp"
  fi
  [ "$s3" = 1 ] || return 0
  [ "$(cat "$HIST/.uploaded")" != "$(cat "$HIST/.last")" ] || return 0
  name=$(ls -1 "$HIST" | grep -E '^channel-[0-9TZ]+\.backup$' | sort | tail -n 1)
  [ -n "$name" ] || return 0
  code=$(s3_req PUT "history/$name" "$HIST/$name")
  [ "$code" = 200 ] || { log "upload of history/$name failed (HTTP ${code:-none}); retrying next poll"; return 0; }
  code=$(s3_req PUT channel.backup "$HIST/$name")
  [ "$code" = 200 ] || { log "upload of channel.backup failed (HTTP ${code:-none}); retrying next poll"; return 0; }
  grep -qx "$name" "$REMOTE" || echo "$name" >> "$REMOTE"
  cat "$HIST/.last" > "$HIST/.uploaded"
  log "uploaded $name to s3 bucket $SCB_S3_BUCKET (${PREFIX}channel.backup and ${PREFIX}history/$name)"
  # Remote history follows the local last-$KEEP.
  local keep=() old
  while read -r old; do
    [ -n "$old" ] || continue
    if [ -e "$HIST/$old" ]; then keep+=("$old"); continue; fi
    code=$(s3_req DELETE "history/$old")
    case "$code" in 200 | 204 | 404) ;; *) keep+=("$old"); log "delete of history/$old failed (HTTP ${code:-none})" ;; esac
  done < "$REMOTE"
  printf '%s\n' ${keep[@]+"${keep[@]}"} > "$REMOTE"
}

while :; do
  pass || log "pass failed; retrying in ${EVERY}s"
  [ -z "${SCB_WATCH_ONCE:-}" ] || exit 0
  sleep "$EVERY"
done
