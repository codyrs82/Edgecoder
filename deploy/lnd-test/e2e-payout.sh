#!/usr/bin/env bash
# End-to-end regtest money flow through the US seed and the edgecoder-lnd-test hub/payee:
#   1. purchase: the coordinator issues an invoice, the payee node pays it, the coordinator settles it
#      (this funds the payout pool);
#   2. a test earnings row for ACCOUNT (reason regtest_e2e_test, wiped before mainnet);
#   3. withdrawal: the payee node issues an invoice and the coordinator pays it out over Lightning.
# Prints invoices, statuses and balances only; no tokens or macaroons.
set -euo pipefail
export FLY_API_TOKEN="${FLY_API_TOKEN:-$(cat ~/.config/edgecoder/fly.token)}"
ACCOUNT=${ACCOUNT:-regtest-e2e-test}
BUY_SATS=${BUY_SATS:-50000}
EARN_SATS=${EARN_SATS:-20000}
WITHDRAW_SATS=${WITHDRAW_SATS:-10000}
SEED=edgecoder-seed
LT=edgecoder-lnd-test
here=$(cd "$(dirname "$0")" && pwd)
js=$(base64 < "$here/e2e-seed.mjs" | tr -d '\n')
seed() { fly ssh console -a "$SEED" -q -C "sh -c 'echo $js | base64 -d > /tmp/e2e-seed.mjs && cd /app && node /tmp/e2e-seed.mjs $*'" 2>/dev/null | grep '^{'; }
PAYEE=$(fly machines list -a "$LT" --json | jq -r '.[] | select(.config.metadata.fly_process_group=="payee") | .id')
payee() { fly ssh console -a "$LT" --machine "$PAYEE" -q -C "lncli --lnddir=/data --network=regtest $*" 2>/dev/null | grep -v '^Connecting'; }

echo "== 1. purchase $BUY_SATS sats for $ACCOUNT"
intent=$(seed intent "$ACCOUNT" "$BUY_SATS")
id=$(jq -r '.body.intent.intentId' <<<"$intent"); bolt=$(jq -r '.body.intent.invoiceRef' <<<"$intent")
[ "$id" != null ] || { echo "intent failed: $intent"; exit 1; }
echo "intent $id"
payee payinvoice --force "$bolt" | grep -iE 'status|payment_error|fee' || true
seed reconcile | jq -c '.body'
seed intent-status "$id" | jq -c '.body.intent | {status, amountSats, netSats, quotedCredits}'

echo "== 2. test earnings: $EARN_SATS sats"
seed earn "$ACCOUNT" "$EARN_SATS" | jq -c .

echo "== 3. withdraw $WITHDRAW_SATS sats to the payee node"
inv=$(payee addinvoice --amt "$WITHDRAW_SATS" --memo regtest-e2e | jq -r .payment_request)
seed withdraw "$ACCOUNT" "$inv" | jq -c '.status, .body'
seed payouts "$ACCOUNT" | jq -c '.body | {balance, payouts: [.payouts[] | {status, amountMsat, feeMsat}], limits: .policy.limits, paused: .policy.paused}'
payee lookupinvoice "$(payee decodepayreq "$inv" | jq -r .payment_hash)" | jq -c '{state, amt_paid_sat}'
