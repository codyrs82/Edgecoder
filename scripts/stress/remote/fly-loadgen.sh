#!/usr/bin/env bash
# Operator helper for the LIVE phase: load-generator machines on Fly, one per region, running the
# bundled harness (scripts/stress/bundle.sh) on the existing agent image (node 22).
#
# DRY RUN BY DEFAULT: it prints the flyctl commands. Review them, then run with DRY_RUN=0.
# The harness author never ran these against Fly.
#
#   export LG_APP=ec-stress-loadgen LG_ORG=<org> IMAGE=registry.fly.io/<agent-app>:<tag>
#   export REGIONS="fra iad sin" CREDS=/secure/path/credentials.json
#   scripts/stress/remote/fly-loadgen.sh setup            # app + credentials secret
#   scripts/stress/remote/fly-loadgen.sh run smoke        # one machine per region, same STRESS_RUN_ID
#   scripts/stress/remote/fly-loadgen.sh collect <run-id> # results-<region>.jsonl + merged report
#   scripts/stress/remote/fly-loadgen.sh teardown         # destroy machines and the app
#
# Scale for `run`: STRESS_AGENTS, STRESS_BUYERS, STRESS_DURATION_SEC, STRESS_RATE, ... are passed on
# (per region: the totals are REGIONS x these). VM size: LG_VM (default performance-2x).
# Payee LND: set STRESS_PAYEE_LND_URL if the URL in the credentials is not reachable from Fly
# (e.g. https://payee.process.<lnd-app>.internal:8080 over the org's private network).
set -euo pipefail
cd "$(dirname "$0")/../../.."
DRY_RUN="${DRY_RUN:-1}"
LG_APP="${LG_APP:-ec-stress-loadgen}"
LG_VM="${LG_VM:-performance-2x}"
REGIONS="${REGIONS:-fra iad}"
BUNDLE="${BUNDLE:-.stress-runs/bundle}"
OUT="${OUT:-.stress-runs/live}"

run() {
  if [ "$DRY_RUN" = "1" ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  setup)
    : "${LG_ORG:?LG_ORG}" "${CREDS:?CREDS=path to credentials.json}"
    scripts/stress/bundle.sh "$BUNDLE" >/dev/null
    run fly apps create "$LG_APP" --org "$LG_ORG"
    # The credentials reach the machines as a file from an app secret (never in machine config or logs).
    if [ "$DRY_RUN" = "1" ]; then
      echo "+ fly secrets set --app $LG_APP --stage STRESS_CREDENTIALS_B64=\"\$(base64 < $CREDS | tr -d '\\n')\""
    else
      fly secrets set --app "$LG_APP" --stage STRESS_CREDENTIALS_B64="$(base64 < "$CREDS" | tr -d '\n')"
    fi
    ;;
  run)
    : "${IMAGE:?IMAGE=the agent image, e.g. from: fly image show -a <agent-or-seed-app>}"
    scenario="${1:?scenario}"
    run_id="${STRESS_RUN_ID:-$(date -u +%y%m%d%H%M)}"
    envs=(--env "STRESS_SCENARIO=$scenario" --env "STRESS_RUN_ID=$run_id" --env STRESS_TARGET=/opt/stress/targets/live-regtest.json --env STRESS_CREDENTIALS=/stress/credentials.json --env STRESS_OUT_DIR=/tmp/stress-out)
    for v in $(env | grep -E '^STRESS_(AGENTS|BUYERS|DURATION_SEC|RATE|INFERENCE_SHARE|MALICIOUS_FRACTION|FAILURE_RATE|LATENCY_MS|LATENCY_SIGMA|NO_SANDBOX_SHARE|TOPUP_SATS|RAMP_MAX_RATE|CHURN_FRACTION|PAYEE_LND_URL)=' | cut -d= -f1); do
      envs+=(--env "$v=${!v}")
    done
    files=(--file-local "/opt/stress/edgecoder-stress.mjs=$BUNDLE/edgecoder-stress.mjs" --file-local "/opt/stress/stress-run.sh=$BUNDLE/stress-run.sh"
      --file-local "/opt/stress/targets/live-regtest.json=$BUNDLE/targets/live-regtest.json" --file-secret "/stress/credentials.json=STRESS_CREDENTIALS_B64")
    for r in $REGIONS; do
      # Outputs go to /tmp (the image runs as uid 1000). The machine keeps running after the scenario
      # (sleep) so the results file can be fetched with `collect`; `teardown` destroys it.
      run fly machine run "$IMAGE" --app "$LG_APP" --region "$r" --name "lg-$run_id-$r" --vm-size "$LG_VM" --restart no \
        "${envs[@]}" --env "STRESS_REGION=$r" "${files[@]}" \
        --entrypoint sh -- -c "sh /opt/stress/stress-run.sh > /tmp/result.jsonl 2> /tmp/progress.log; echo done > /tmp/finished; sleep 86400"
    done
    echo "# run id $run_id; follow progress with: fly logs -a $LG_APP   or   fly ssh console -a $LG_APP --machine <id> -C 'tail -f /tmp/progress.log'"
    ;;
  collect)
    run_id="${1:?run id}"
    mkdir -p "$OUT/$run_id"
    for r in $REGIONS; do
      if [ "$DRY_RUN" = "1" ]; then
        echo "+ id=\$(fly machine list -a $LG_APP --json | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const m=JSON.parse(d).find(x=>x.name===\"lg-$run_id-$r\");console.log(m?m.id:\"\")})')"
        echo "+ fly ssh console -a $LG_APP --machine \$id -C 'cat /tmp/result.jsonl' > $OUT/$run_id/results-$r.jsonl"
      else
        id=$(fly machine list -a "$LG_APP" --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=JSON.parse(d).find(x=>x.name===process.argv[1]);console.log(m?m.id:"")})' "lg-$run_id-$r")
        [ -n "$id" ] || { echo "no machine lg-$run_id-$r" >&2; continue; }
        fly ssh console -a "$LG_APP" --machine "$id" -C 'cat /tmp/result.jsonl' > "$OUT/$run_id/results-$r.jsonl"
      fi
    done
    run node "$BUNDLE/edgecoder-stress-report.mjs" --out "$OUT/$run_id/merged" $(for r in $REGIONS; do echo "$OUT/$run_id/results-$r.jsonl"; done)
    ;;
  teardown)
    if [ "$DRY_RUN" = "1" ]; then
      echo "+ for id in \$(fly machine list -a $LG_APP --json | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>JSON.parse(d).forEach(m=>console.log(m.id)))'); do fly machine destroy --force -a $LG_APP \$id; done"
    else
      for id in $(fly machine list -a "$LG_APP" --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>JSON.parse(d).forEach(m=>console.log(m.id)))'); do fly machine destroy --force -a "$LG_APP" "$id"; done
    fi
    run fly apps destroy "$LG_APP" --yes
    ;;
  *)
    sed -n '2,22p' "$0"; exit 2 ;;
esac
