#!/usr/bin/env bash
# Restart both coordinators of the running local stress cluster with new STRESS_* settings
# (payout caps, earnings hold, verification rate), keeping the database, LND and accounts:
#
#   STRESS_PAYOUT_MAX_SINGLE_SATS=30 STRESS_PAYOUT_MAX_ACCOUNT_DAILY_SATS=60 scripts/stress/reconfigure.sh
#
# Settings not given keep their up.sh defaults (cluster.sh), not the previous values.
# Note: a restart drops the coordinators' in-memory state (queued subtasks, task billing, agents).
set -euo pipefail
cd "$(dirname "$0")/../.."
RUN_DIR="${STRESS_RUN_DIR:-$(pwd)/.stress-runs/local}"
# shellcheck source=scripts/stress/cluster.sh
. scripts/stress/cluster.sh
[ -f "$RUN_DIR/stack.env" ] || { echo "no running stack (run scripts/stress/up.sh)" >&2; exit 1; }
set -a; . "$RUN_DIR/stack.env"; set +a
export STRESS_SECRETS_DIR="$RUN_DIR/secrets"
stress_settings_defaults
for c in a b; do docker rm -f "ec-stress-coord-$c" >/dev/null; done
stress_start_coordinator a "$STRESS_COORD_A_PORT"
stress_start_coordinator b "$STRESS_COORD_B_PORT"
for p in "$STRESS_COORD_A_PORT" "$STRESS_COORD_B_PORT"; do
  stress_wait_healthy "http://127.0.0.1:$p/health/runtime" 120 || { echo "coordinator on $p not healthy" >&2; exit 1; }
done
cat > "$RUN_DIR/stack-settings.json" <<JSON
{
  "earningsHoldMs": $STRESS_EARNINGS_HOLD_MS,
  "payoutMinSats": $STRESS_PAYOUT_MIN_SATS,
  "payoutMaxSingleSats": $STRESS_PAYOUT_MAX_SINGLE_SATS,
  "payoutMaxAccountDailySats": $STRESS_PAYOUT_MAX_ACCOUNT_DAILY_SATS,
  "payoutMaxGlobalDailySats": $STRESS_PAYOUT_MAX_GLOBAL_DAILY_SATS,
  "verificationRate": $STRESS_VERIFICATION_RATE
}
JSON
echo "[reconfigure] coordinators restarted; settings: $(tr -d '\n ' < "$RUN_DIR/stack-settings.json")"
