#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder, LLC
# SPDX-License-Identifier: BUSL-1.1
#
# Run the load generator as a temporary Fly app, one machine per region (REGTEST network only).
#
#   scripts/loadgen/fly.sh create                       app + LOADGEN_KEYS secret (from the account files; never printed)
#   scripts/loadgen/fly.sh run <profile> [opts]          deploy and start a run (opts below)
#   scripts/loadgen/fly.sh watch                         sample the coordinators' per-model slots every 15 s until
#                                                        the run ends (run it alongside; report.mjs uses it)
#   scripts/loadgen/fly.sh status | logs                 machines / live JSON lines
#   scripts/loadgen/fly.sh report [--out file.json]      merge every machine's results + coordinator series, and the
#                                                        money report (ledger snapshot taken at `run` vs now)
#   scripts/loadgen/fly.sh stop                          scale to 0 machines (no cost; results are gone)
#   scripts/loadgen/fly.sh destroy                       delete the app and its secrets
#
# run opts: --regions iad,lhr,sin,syd (default; at most 16 machines, cap 16 calls/s is split between them)
#           --duration 30m  --rate N  --max-rate N (lower the 16 calls/s cap)  --stage-minutes N  --loop  --budget CSATS  --min-balance CSATS
#           --buyers st9,st10 (alias --users; default: accounts that host nothing, else every funded account)
#           --buyer-cap CSATS (most one buyer spends in the run)  --min-rate N (per machine floor, default 0.02/s)
#           --start-in SECONDS (default 150, so all regions start together)
# Buyers: budget.mjs buyers picks them and, per buyer, the models its own agents hold (LOADGEN_AVOID),
# which it never asks for, so its calls pay other accounts. A ledger snapshot (balances + who hosts
# what) is saved before the run for the money report.
#           --oversub X (bulk models' in-flight cap = slots x X, default 1.5)  --auto-slots N (default 3)
#           --auto-share F (share of calls sent as model "auto", best-fit routing; default 0.5, 0 = none)
# Capacity: the run takes a snapshot of slots per model (capacity.mjs, with the admin token on this
# host) and passes it to the machines as LOADGEN_CAPACITY; the admin token itself is not sent.
#
# The code ships as a base64 tarball in the machine's environment (no image build): the image is
# plain node:22-slim. The generated fly.toml goes to $LOADGEN_FLY_DIR (default a temp dir), never
# into the repo. Machines stop by themselves LOADGEN_LINGER_SEC (default 1800) after the run ends.
set -euo pipefail
APP=${LOADGEN_APP:-edgecoder-loadgen}
ORG=${LOADGEN_ORG:-edgecoder}
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=${LOADGEN_FLY_DIR:-${TMPDIR:-/tmp}/edgecoder-loadgen}
ACCOUNTS=${LOADGEN_KEYS_DIR:-$HOME/.config/edgecoder/e2e/accounts}
export FLY_API_TOKEN=${FLY_API_TOKEN:-$(cat "$HOME/.config/edgecoder/fly.token" 2>/dev/null || true)}
mkdir -p "$DIR"
cmd=${1:-}; shift || true

machines_json() { fly machines list -a "$APP" --json; }

case "$cmd" in
  create)
    fly apps create "$APP" -o "$ORG" 2>&1 | grep -v '^$' || true
    # LOADGEN_KEYS={"st1":"...",...} straight from the account files into `fly secrets import` (stdin).
    node -e '
      const fs = require("fs"), path = require("path"), dir = process.argv[1], keys = {};
      for (const f of fs.readdirSync(dir)) { const m = /^(st\d+)\.json$/.exec(f); if (!m) continue;
        const k = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).apiKey; if (k) keys[m[1]] = k; }
      process.stderr.write(`LOADGEN_KEYS: ${Object.keys(keys).length} accounts\n`);
      process.stdout.write(`LOADGEN_KEYS=${JSON.stringify(keys)}\n`);' "$ACCOUNTS" | fly secrets import -a "$APP" --stage
    fly secrets list -a "$APP" ;;

  run)
    profile=${1:?profile: smoke|steady|ramp|saturate|soak|sustain}; shift
    regions=iad,lhr,sin,syd; duration=""; rate=""; max_rate=""; stage_minutes=""; loop=""; budget=2000; min_balance=1500; users=""; start_in=150; oversub=""; auto_slots=""; auto_share=""; buyer_cap=""; min_rate=""
    while [ $# -gt 0 ]; do case "$1" in
      --regions) regions=$2; shift 2;; --duration) duration=$2; shift 2;; --rate) rate=$2; shift 2;; --max-rate) max_rate=$2; shift 2;;
      --stage-minutes) stage_minutes=$2; shift 2;; --loop) loop=1; shift;; --budget) budget=$2; shift 2;;
      --min-balance) min_balance=$2; shift 2;; --users|--buyers) users=$2; shift 2;; --start-in) start_in=$2; shift 2;;
      --buyer-cap) buyer_cap=$2; shift 2;; --min-rate) min_rate=$2; shift 2;;
      --oversub) oversub=$2; shift 2;; --auto-slots) auto_slots=$2; shift 2;; --auto-share) auto_share=$2; shift 2;;
      *) echo "unknown option $1" >&2; exit 2;; esac; done
    IFS=, read -r -a R <<<"$regions"
    run_id="lg-$(date -u +%Y%m%d%H%M)-$profile"
    start_at=$(( ($(date +%s) + start_in) * 1000 ))
    # Validate the schedule locally first (same code, same caps); refuses impossible splits.
    duration_sec=$(node "$HERE/loadgen.mjs" --dry-run --profile "$profile" --regions "$regions" --region "${R[0]}" \
      ${duration:+--duration "$duration"} ${rate:+--rate "$rate"} ${max_rate:+--max-rate "$max_rate"} ${stage_minutes:+--stage-minutes "$stage_minutes"} ${loop:+--loop} |
      node -e 'const l=require("fs").readFileSync(0,"utf8");console.log(JSON.parse(l.slice(l.indexOf("{"))).durationSec)')
    capacity=$(node "$HERE/capacity.mjs" 2>/dev/null || true)
    [ -n "$capacity" ] || echo "warning: no capacity snapshot (admin token?); machines use built-in slot defaults" >&2
    printf 'RUN_ID=%s\nSTART_AT=%s\nEND_AT=%s\n' "$run_id" "$start_at" $(( start_at + duration_sec * 1000 )) >"$DIR/last-run.env"
    # Buyers and the models each must avoid (its own agents hold them); then the "before" ledger.
    pick=$(node "$HERE/budget.mjs" buyers ${users:+--buyers "$users"} --min-balance "$min_balance" 2>/dev/null || true)
    avoid="{}"
    if [ -n "$pick" ]; then
      users=$(printf '%s' "$pick" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).buyers.join(","))')
      avoid=$(printf '%s' "$pick" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).avoid))')
      echo "buyers: $users ($(printf '%s' "$pick" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(p.reason+"; avoid "+JSON.stringify(p.avoid))'))"
    else
      echo "warning: could not choose buyers (admin token?); every account buys and self-dealing is not avoided" >&2
    fi
    node "$HERE/budget.mjs" ledger --out "$DIR/ledger-before-$run_id.json" >/dev/null 2>&1 && echo "ledger snapshot: $DIR/ledger-before-$run_id.json" || echo "warning: no ledger snapshot; the report will lack the money section" >&2
    tgz=$(tar czf - -C "$HERE/.." --exclude='*.sh' loadgen | base64 | tr -d '\n')
    toml="$DIR/fly.loadgen.toml"
    cat >"$toml" <<TOML
app = "$APP"
primary_region = "${R[0]}"

[env]
  LOADGEN_PROFILE = "$profile"
  LOADGEN_RUN_ID = "$run_id"
  LOADGEN_START_AT = "$start_at"
  LOADGEN_REGIONS = "$regions"
  LOADGEN_DURATION = "$duration"
  LOADGEN_BUDGET_CSATS = "$budget"
  LOADGEN_MIN_BALANCE = "$min_balance"
  LOADGEN_USERS = "$users"
  LOADGEN_LINGER_SEC = "${LOADGEN_LINGER_SEC:-1800}"
  LOADGEN_RESULTS = "/tmp/loadgen-results.jsonl"
  LOADGEN_TGZ = "$tgz"
  LOADGEN_CAPACITY = '$capacity'
  LOADGEN_AVOID = '$avoid'
$( [ -n "$oversub" ] && echo "  LOADGEN_OVERSUB = \"$oversub\"" )
$( [ -n "$auto_slots" ] && echo "  LOADGEN_AUTO_SLOTS = \"$auto_slots\"" )
$( [ -n "$auto_share" ] && echo "  LOADGEN_AUTO_SHARE = \"$auto_share\"" )
$( [ -n "$buyer_cap" ] && echo "  LOADGEN_BUYER_CAP_CSATS = \"$buyer_cap\"" )
$( [ -n "$min_rate" ] && echo "  LOADGEN_MIN_RATE = \"$min_rate\"" )
$( [ -n "$rate" ] && echo "  LOADGEN_RATE = \"$rate\"" )
$( [ -n "$max_rate" ] && echo "  LOADGEN_MAX_RATE = \"$max_rate\"" )
$( [ -n "$stage_minutes" ] && echo "  LOADGEN_STAGE_MINUTES = \"$stage_minutes\"" )
$( [ -n "$loop" ] && echo "  LOADGEN_LOOP = \"1\"" )

[processes]
  app = "sh -c 'mkdir -p /opt/lg && echo \"\$LOADGEN_TGZ\" | base64 -d | tar xzf - -C /opt/lg && exec node /opt/lg/loadgen/loadgen.mjs'"

[[restart]]
  policy = "never"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
TOML
    echo "run $run_id: profile $profile, regions $regions, starts $(date -r $((start_at / 1000)) 2>/dev/null || date -d @$((start_at / 1000)))"
    fly deploy -a "$APP" -c "$toml" --image node:22-slim --ha=false --yes --detach=false 2>&1 | tail -3
    # Exactly one machine per region: clone the first into missing regions, remove extras.
    first=$(machines_json | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(m[0]?.id??"")')
    for r in "${R[@]}"; do
      have=$(machines_json | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(m.filter(x=>x.region===process.argv[1]).length)' "$r")
      [ "$have" -ge 1 ] || fly machine clone "$first" -a "$APP" --region "$r" 2>&1 | tail -1
    done
    machines_json | node -e '
      const m = JSON.parse(require("fs").readFileSync(0, "utf8")), want = process.argv[1].split(","), seen = new Set();
      for (const x of m) { if (!want.includes(x.region) || seen.has(x.region)) console.log(`extra ${x.id}`); else { seen.add(x.region); if (x.state !== "started") console.log(`start ${x.id}`); } }' "$regions" |
      while read -r what id; do
        if [ "$what" = extra ]; then fly machine destroy "$id" -a "$APP" --force; else fly machine start "$id" -a "$APP"; fi
      done
    fly machines list -a "$APP" ;;

  watch)
    . "$DIR/last-run.env"
    echo "sampling capacity for $RUN_ID until $(date -r $(( (END_AT + 300000) / 1000 )) 2>/dev/null) into $DIR/samples-$RUN_ID.jsonl"
    node "$HERE/capacity.mjs" --sample "$DIR/samples-$RUN_ID.jsonl" --until $(( END_AT + 300000 )) ;;
  status) fly machines list -a "$APP" ;;
  logs) fly logs -a "$APP" "$@" ;;
  report)
    samples=""; ledger=""; [ -f "$DIR/last-run.env" ] && . "$DIR/last-run.env" && [ -f "$DIR/samples-$RUN_ID.jsonl" ] && samples="$DIR/samples-$RUN_ID.jsonl"
    if [ -n "${RUN_ID:-}" ] && [ -f "$DIR/ledger-before-$RUN_ID.json" ]; then
      ledger="$DIR/ledger-before-$RUN_ID.json"
      node "$HERE/budget.mjs" ledger --out "$DIR/ledger-after-$RUN_ID.json" >/dev/null 2>&1 || true
    fi
    node "$HERE/report.mjs" --app "$APP" ${samples:+--samples "$samples"} ${ledger:+--ledger-before "$ledger"} \
      $( [ -n "$ledger" ] && [ -f "$DIR/ledger-after-$RUN_ID.json" ] && echo --ledger-after "$DIR/ledger-after-$RUN_ID.json" ) "$@" ;;
  stop) fly scale count 0 -a "$APP" --yes ;;
  destroy) fly apps destroy "$APP" --yes ;;
  *) sed -n '5,20p' "$0"; exit 2 ;;
esac
