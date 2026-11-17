#!/usr/bin/env bash
# Copy the node's static channel backup (channel.backup) off Fly, into
# ~/.config/edgecoder/lnd-backups/channel-<UTC time>.backup. Run it after every channel open or
# close, and on a schedule. The file is encrypted with the wallet seed, so it is safe to keep in
# more places (a second disk, a cloud folder); without it, funds in channels can still be
# recovered only by the counterparty force-closing.
set -euo pipefail
A=${APP:-edgecoder-lnd}
dir=~/.config/edgecoder/lnd-backups
mkdir -p "$dir" && chmod 700 "$dir"
machine=$(fly machines list -a "$A" --json | jq -r '.[] | select(.config.metadata.fly_process_group=="lnd") | .id')
[ -n "$machine" ] || { echo "no lnd machine in $A" >&2; exit 1; }
out="$dir/channel-$(date -u +%Y%m%dT%H%M%SZ).backup"
fly ssh console -a "$A" --machine "$machine" -q -C "base64 -w0 /data/data/chain/bitcoin/mainnet/channel.backup" \
  | grep -v '^Connecting' | tr -d '\r\n' | base64 -d > "$out"
chmod 600 "$out"
[ -s "$out" ] || { rm -f "$out"; echo "empty backup; is the wallet created?" >&2; exit 1; }
# Keep the newest 30 here (names sort by time).
ls -1 "$dir" | grep -E '^channel-[0-9TZ]+\.backup$' | sort | awk '{a[NR]=$0} END {for (i = 1; i <= NR - 30; i++) print a[i]}' \
  | while read -r old; do rm -f "$dir/$old"; done
echo "saved $out ($(wc -c < "$out" | tr -d ' ') bytes)"
