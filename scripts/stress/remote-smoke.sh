#!/usr/bin/env bash
# End-to-end test of the remote path against the LOCAL cluster: the bundled load generator runs in
# two containers (two "regions") on the cluster's docker network, reaching coordinators, portal and
# the payee LND by URL only, with a credentials file that has no database URL, no portal service
# token and no mesh token, exactly as on a load-generator VM. Their results are merged into one
# report with per-region latency.
#
#   scripts/stress/up.sh && scripts/stress/remote-smoke.sh [scenario] [regions]
#
# Containers: ec-stress-loadgen-<region> (removed afterwards).
set -euo pipefail
cd "$(dirname "$0")/../.."
SCENARIO="${1:-smoke}"
REGIONS="${2:-r1 r2}"
LOCAL="${STRESS_RUN_DIR:-.stress-runs/local}"
RUN_ID="rmt$(date +%H%M%S)"
WORK=".stress-runs/remote-$RUN_ID"
IMAGE="${STRESS_APP_IMAGE:-ec-stress-app:local}"
[ -f "$LOCAL/credentials.json" ] || { echo "run scripts/stress/up.sh first" >&2; exit 1; }
scripts/stress/bundle.sh "$WORK/bundle" >/dev/null
umask 077
mkdir -p "$WORK/stress"
# The remote credentials: accounts (API keys), the payee LND reached by its container name, and the
# admin token (the operator may or may not hand one to the live run; with it /ledger/verify and the
# payout reconciliation are checked). No postgres URL, no portal service / mesh / metrics tokens.
node -e '
const c = require(process.argv[1]);
const out = { accounts: c.accounts, tokens: { admin: c.tokens.admin }, lnd: { payee: { ...c.lnd.payee, restUrl: "https://ec-stress-lnd-payee:8080" } } };
require("fs").writeFileSync(process.argv[2], JSON.stringify(out, null, 2), { mode: 0o644 });
' "$(pwd)/$LOCAL/credentials.json" "$WORK/stress/credentials.json"
cp "$LOCAL/stack-settings.json" "$WORK/stress/stack-settings.json"
chmod 755 "$WORK" "$WORK/stress"
pids=()
for region in $REGIONS; do
  name="ec-stress-loadgen-$region"
  docker rm -f "$name" >/dev/null 2>&1 || true
  # The loadgen container gets the same production-host blackhole as the cluster.
  docker run -d --name "$name" --network ec-stress-net --label ec-stress=1 \
    --add-host edgecoder.io:0.0.0.0 --add-host coordinator.edgecoder.io:0.0.0.0 --add-host portal.edgecoder.io:0.0.0.0 \
    --add-host edgecoder-seed.fly.dev:0.0.0.0 --add-host edgecoder-seed-eu.fly.dev:0.0.0.0 \
    -v "$(pwd)/$WORK/bundle:/opt/stress:ro" -v "$(pwd)/$WORK/stress:/stress" \
    -e STRESS_TARGET=/opt/stress/targets/remote-local.json -e STRESS_SCENARIO="$SCENARIO" -e STRESS_REGION="$region" \
    -e STRESS_RUN_ID="$RUN_ID" -e STRESS_OUT_DIR="/stress/out/$region" \
    $(env | grep -E '^STRESS_(AGENTS|BUYERS|DURATION_SEC|RATE|INFERENCE_SHARE|MALICIOUS_FRACTION|FAILURE_RATE|LATENCY_MS|LATENCY_SIGMA|NO_SANDBOX_SHARE|TOPUP_SATS)=' | sed 's/^/-e /') \
    --entrypoint sh "$IMAGE" -c 'sh /opt/stress/stress-run.sh > /stress/out-'"$region"'.jsonl' >/dev/null
  pids+=("$name")
done
echo "[remote-smoke] $SCENARIO running in: ${pids[*]}"
rc=0
for name in "${pids[@]}"; do
  code=$(docker wait "$name")
  echo "[remote-smoke] $name exited $code; last log lines:"
  docker logs --tail 4 "$name" 2>&1 | sed 's/^/    /'
  [ "$code" = "0" ] || rc=1
  docker rm -f "$name" >/dev/null
done
inputs=()
for region in $REGIONS; do inputs+=("$WORK/stress/out-$region.jsonl"); done
node "$WORK/bundle/edgecoder-stress-report.mjs" --out "$WORK/merged" "${inputs[@]}"
echo "[remote-smoke] merged report: $WORK/merged/report.md"
exit $rc
