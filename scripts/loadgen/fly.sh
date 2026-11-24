#!/usr/bin/env bash
# Copyright (c) 2025 EdgeCoder
# SPDX-License-Identifier: BUSL-1.1
#
# Run the load generator as a temporary Fly app, one machine per region (REGTEST network only).
#
#   scripts/loadgen/fly.sh create                       app + LOADGEN_KEYS secret (from the account files; never printed)
#   scripts/loadgen/fly.sh run <profile> [opts]          deploy and start a run (opts below)
#   scripts/loadgen/fly.sh watch                         sample the coordinators' per-model slots every 15 s until
#                                                        the run ends (run it alongside; report.mjs uses it), and
#                                                        keep the run's loadgen/portal/seed log lines that matter
#                                                        (logs-<run>-<app>.txt: errors, model-call events, restarts)
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
#           --model M (pin named-model calls to one model, e.g. qwen2.5-coder:1.5b; with --auto-share 0
#           every call asks for it)
# Capacity: the run takes a snapshot of slots per model (capacity.mjs; /admin/network is internal-only,
# so it runs inside edgecoder-seed / edgecoder-seed-eu over fly ssh with the token from the machine's
# env) and passes it to the machines as LOADGEN_CAPACITY; no admin token is sent or printed. If the
# snapshot or the buyer choice fails, `run` stops with the reason; LOADGEN_ALLOW_BLIND=1 runs anyway.
# Fly auth: FLY_API_TOKEN if set, else the `fly auth login` session, else ~/.config/edgecoder/fly.token
# (that file may hold a revoked token, so it is the last resort); fails with instructions otherwise.
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
# Fly auth: FLY_API_TOKEN, else `fly auth login`, else the token file (may be revoked: last resort).
if [ -z "${FLY_API_TOKEN:-}" ] && ! fly auth whoami >/dev/null 2>&1; then
  if [ -s "$HOME/.config/edgecoder/fly.token" ]; then
    FLY_API_TOKEN=$(cat "$HOME/.config/edgecoder/fly.token"); export FLY_API_TOKEN
  fi
fi
case "${1:-}" in create|run|watch|status|logs|stop|destroy)
  if ! fly auth whoami >/dev/null 2>&1; then
    echo "fly is not authenticated: set FLY_API_TOKEN, or run \`fly auth login\` (a revoked token in ~/.config/edgecoder/fly.token fails with 'verify: root banned'; remove or refresh it)" >&2
    exit 2
  fi ;;
esac
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
    regions=iad,lhr,sin,syd; duration=""; rate=""; max_rate=""; stage_minutes=""; loop=""; budget=2000; min_balance=1500; users=""; start_in=150; oversub=""; auto_slots=""; auto_share=""; buyer_cap=""; min_rate=""; model=""
    while [ $# -gt 0 ]; do case "$1" in
      --regions) regions=$2; shift 2;; --duration) duration=$2; shift 2;; --rate) rate=$2; shift 2;; --max-rate) max_rate=$2; shift 2;;
      --stage-minutes) stage_minutes=$2; shift 2;; --loop) loop=1; shift;; --budget) budget=$2; shift 2;;
      --min-balance) min_balance=$2; shift 2;; --users|--buyers) users=$2; shift 2;; --start-in) start_in=$2; shift 2;;
      --buyer-cap) buyer_cap=$2; shift 2;; --min-rate) min_rate=$2; shift 2;;
      --oversub) oversub=$2; shift 2;; --auto-slots) auto_slots=$2; shift 2;; --auto-share) auto_share=$2; shift 2;; --model) model=$2; shift 2;;
      *) echo "unknown option $1" >&2; exit 2;; esac; done
    IFS=, read -r -a R <<<"$regions"
    run_id="lg-$(date -u +%Y%m%d%H%M)-$profile"
    start_at=$(( ($(date +%s) + start_in) * 1000 ))
    # Validate the schedule locally first (same code, same caps); refuses impossible splits.
    duration_sec=$(node "$HERE/loadgen.mjs" --dry-run --profile "$profile" --regions "$regions" --region "${R[0]}" \
      ${duration:+--duration "$duration"} ${rate:+--rate "$rate"} ${max_rate:+--max-rate "$max_rate"} ${stage_minutes:+--stage-minutes "$stage_minutes"} ${loop:+--loop} |
      node -e 'const l=require("fs").readFileSync(0,"utf8");console.log(JSON.parse(l.slice(l.indexOf("{"))).durationSec)')
    blind() { if [ "${LOADGEN_ALLOW_BLIND:-}" = 1 ]; then echo "warning: $1 (LOADGEN_ALLOW_BLIND=1: continuing)" >&2; else echo "error: $1; fix it (see above) or set LOADGEN_ALLOW_BLIND=1 to run without it" >&2; exit 1; fi; }
    capacity=$(node "$HERE/capacity.mjs" || true)
    [ -n "$capacity" ] || blind "no capacity snapshot, so the machines would use built-in slot defaults and the profiles.mjs model mix"
    printf 'RUN_ID=%s\nSTART_AT=%s\nEND_AT=%s\n' "$run_id" "$start_at" $(( start_at + duration_sec * 1000 )) >"$DIR/last-run.env"
    # Buyers and the models each must avoid (its own agents hold them); then the "before" ledger.
    pick=$(node "$HERE/budget.mjs" buyers ${users:+--buyers "$users"} --min-balance "$min_balance" || true)
    avoid="{}"
    if [ -n "$pick" ]; then
      users=$(printf '%s' "$pick" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).buyers.join(","))')
      avoid=$(printf '%s' "$pick" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).avoid))')
      echo "buyers: $users ($(printf '%s' "$pick" | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(p.reason+"; avoid "+JSON.stringify(p.avoid))'))"
    else
      blind "could not choose buyers, so every account would buy and self-dealing would not be avoided"
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
$( [ -n "$model" ] && echo "  LOADGEN_MODEL = \"$model\"" )
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
    # `fly logs --no-tail` keeps only the last ~100 lines, so a run's server side is gone by the time
    # it is read: keep the load generator's lines and the servers' warnings, errors, model-call events
    # and machine restarts (OOM, exits, deploys) for the run, to match LOADGEN_ERR ids and times.
    tails=()
    for a in "$APP" edgecoder-portal edgecoder-seed edgecoder-seed-eu; do
      fly logs -a "$a" 2>/dev/null \
        | grep --line-buffered -E 'LOADGEN_|"level":(40|50|60)|inference_|portal_st|Out of memory|oom|exited|Main child|Starting init|Configuring|reboot|restart' \
        > "$DIR/logs-$RUN_ID-$a.txt" &
      tails+=($!)
    done
    trap 'kill "${tails[@]}" 2>/dev/null' EXIT
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
  *) sed -n '5,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
