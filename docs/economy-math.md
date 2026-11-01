# Economy math: credits, sats, tokens

This is the arithmetic the coordinator actually runs today, with the source of each formula,
worked examples, and the places where the numbers or the wiring do not hold up. Design
intent is in `docs/economy-compute-trust-model.md`; this document is about what the code does.

Three units appear in the code and they are not interchangeable:

| Unit | What it is | Where it lives |
|---|---|---|
| **credit** | Off-chain unit of compute. Earned by executing subtasks, spent by submitting tasks, bought with sats. | `credit_transactions` (Postgres) or the in-memory `CreditEngine` |
| **sat** | Bitcoin, paid through Lightning for credits, and spent on OP_RETURN anchoring fees. | Lightning node, `payment_intents`, `bitcoin_anchor_records` |
| **token** | Issuance accounting unit from the daily pool. Recorded, not yet credited or paid out. | `issuance_epochs`, `issuance_allocations`, `issuance_payout_events` |

## 1. Earning credits (compute)

`src/credits/pricing.ts` `contributionCredits`, called from the coordinator's `/result` handler
(`accrueResultCredits`).

```
credits = seconds × baseRate(resourceClass) × quality × loadMultiplier(load)
```

- `seconds` is **server-measured**: `creditedDurationMs = min(reported, now − claimedAt, subtask.timeoutMs)`
  (`src/swarm/result-integrity.ts`). An agent cannot report more time than the coordinator observed.
- `baseRate` = 1.0 credit/s (cpu) or 4.0 credit/s (gpu).
- `quality` = 1.0 for an accepted result, clamped to [0.5, 1.5]. Nothing sets it to anything else today.
- `loadMultiplier` from `queued / activeAgents`: 0.8 (≤ 0.5), 1.0 (≤ 1), 1.25 (≤ 2), 1.6 (> 2); 1.6 when no agents.
- **Failed results earn 0** (#38). Rounded to 3 decimals. Idempotent per subtask via the report id.

Example: a 12.4 s CPU subtask with 3 queued tasks and 4 agents (pressure 0.75 → 1.0) earns
`12.4 × 1.0 × 1.0 × 1.0 = 12.400` credits.

Submitting a task costs a flat **1 credit** (`spendCredits(…, 1, "task_submit")`), refunded once if
the task fails permanently (#160). The cost does not depend on the model, prompt size or
duration. `modelCostCredits(paramSizeB)` and `modelSeedCredits(...)` exist in `pricing.ts` but
nothing calls them.

## 2. Buying credits (sats → credits)

`POST /economy/payments/intents` (coordinator):

```
feeSats      = floor(amountSats × COORDINATOR_FEE_BPS / 10000)      # default 150 bps = 1.5 %
netSats      = amountSats − feeSats
satsPerCredit = rate oracle (see below) × load multiplier, locked at intent creation
quotedCredits = round3(netSats / satsPerCredit)
```

Example: 10,000 sats → fee 150, net 9,850, at 0.00667 sats/credit → **1,477,500 credits** (about 410 CPU-hours).

Credits are granted only when the Lightning node reports the invoice settled
(`src/economy/payment-settlement.ts`, #42): LND by `r_hash` with preimage, amount and state checks;
CLN by `payment_hash` with the same checks (hardened in this change). The grant row is
`credit_purchase:<intentId>`, unique per intent.

`satsPerCredit` comes from `computeDynamicPricePerComputeUnitSats` (`src/economy/pricing.ts`):

```
scarcity   = max(1, queued + activeAgents) / max(1, capacity)
multiplier = clamp(0.65 + 0.35 × scarcity, 0.35, 4.0)
price      = max(1, round(base × multiplier))        # base 30 sats (cpu), 120 sats (gpu)
```

This multiplier (0.65 idle floor, 4.0 cap) is applied on top of the oracle's market rate. The 30/120-sat
bases survive only as the legacy fallback when the oracle has never produced an epoch.

### Price level: market-anchored, recalibrated daily

`satsPerCredit` is no longer a 30-sat constant. `src/economy/rate-oracle.ts` recalibrates it
(default daily, `RATE_RECALIBRATION_MS`) from two verifiable inputs:

```
btcUsd          = median of agreeing spot quotes (Coinbase, Kraken, Bitstamp, mempool.space;
                  quotes > RATE_MAX_SOURCE_SPREAD_PCT from the median are dropped; >= RATE_MIN_SOURCES must remain)
usdPerCpuHour   = median of RATE_COMPUTE_SOURCES_JSON (cpu) if configured, else COMPUTE_REFERENCE_USD_PER_VCPU_HOUR (0.02)
satsPerCpuHour  = usdPerCpuHour / btcUsd × 1e8 × (1 + RATE_NETWORK_MARKUP_BPS / 10000)
satsPerCredit   = satsPerCpuHour / 3600 × loadMultiplier        # loadMultiplier 0.65..4.0 from queue depth vs capacity
```

Worked example at 100,000 USD/BTC with the defaults: 0.02 USD/h → 20 sats/h → +20 % → **24 sats
per CPU-hour**, 0.00667 sats (7 msat) per credit at balanced load. A 10,000-sat purchase (net
9,850) buys about 1.48 million credits, i.e. 410 CPU-hours. Compare the previous constant: 30 sats
per CPU-**second**, 108,000 sats per hour, 4,500× higher.

Guards: a fresh epoch may move at most `RATE_MAX_DAILY_MOVE_PCT` (25 %) from the previous one and the
unclamped value is recorded; if sources fail the previous epoch is carried and flagged; quotes
report `stale: true` after 48 h. Epochs persist in `rate_epochs`; `GET /economy/rates/current` and
`/economy/rates/history` expose them; `POST /economy/rates/recalibrate` (admin) forces one.

Why not hashprice: hashprice (sats per TH/s per day) is Bitcoin mining revenue and tracks
difficulty and block fees, not the cost of a CPU-second. The oracle computes it from mempool.space
chain data (144 × (subsidy + 24 h average fees) / network TH) and stores it on each epoch as a
signal for operators, but it never enters the compute price.

Open point: the quote and every intent still use the **CPU** rate even when the buyer intends GPU
work; a per-resource-class purchase is a follow-up.

## 3. Contribute-first policy (who may submit)

`contributionPolicyDecision` in `src/swarm/coordinator-utils.ts`, called from `/submit`:

```
allowed if balance ≥ CONTRIBUTION_BURST_CREDITS (25)
       or spent == 0
       or (earned + purchased) / spent ≥ MIN_CONTRIBUTION_RATIO (1.0)
```

`earned` counts `compute_contribution` rows, `purchased` counts `credit_purchase:%` rows, `spent`
counts `task_submit` rows. **Fixed in this change:** the SQL only counted compute earnings, so a
Lightning buyer with a balance under 25 who had submitted anything was refused with
`contribute_first_required`. The old unit test re-did the arithmetic by hand and never called the
coordinator, which is why it passed.

## 4. Token issuance (daily pool)

`src/economy/issuance.ts`, run hourly by `runIssuanceTick` (ISSUANCE_RECALC_MS = 1 h) over a
trailing 24 h window (ISSUANCE_WINDOW_MS):

```
loadIndex   = clamp(max(1, queued + agents) / max(1, cpuCap + 2 × gpuCap), 0.2, 6)
smoothed    = EMA(previous, loadIndex, alpha 0.35)
dailyPool   = clamp(10,000 × (1 + max(0, smoothed − 1) × 0.35), 2,500, 100,000)   # tokens
hourly      = dailyPool / 24
share_i     = weightedContribution_i / Σ weightedContribution          # over the 24 h window
issued_i    = hourly × share_i
```

`weightedContribution = seconds × resourceWeight(1 cpu, 2 gpu) × quality × reliability(1.0 ok / 0.75 fail)`
per report, summed per account (`compute_contribution_reports`). Each hour re-reads the whole 24 h
window, so one hour's work is paid 1/24 of its share in each of the next 24 ticks. That sums to the
right amount but means a contributor's tokens arrive spread over a day.

Example: dailyPool 10,000 → 416.667 tokens/hour. Two contributors with weighted 300 and 100 get
312.500 and 104.167 tokens that hour.

### Issued tokens go nowhere yet

`issued_i` is written to `issuance_allocations` and shown on the portal dashboard. **No code
converts allocations into credits or any balance.** `/ledger/verify` does not include them. The
quorum (`issuance_proposal` / `issuance_vote` / `issuance_commit`) finalizes with a single
coordinator because `quorumThreshold()` is 1 unless a treasury policy with approved coordinators
exists. Token allocation is bookkeeping until a decision is made on what a token redeems for.

## 5. Payout accounting (sats from purchases)

`allocateIntentPayouts` runs when a purchase settles:

```
coordinatorShare = 0.05, reserveShare = 0.05, contributorShare = 0.90   (of netSats)
contributor_i    = netSats × 0.90 × allocationShare_i    (latest finalized epoch)
coordinator      = netSats × 0.05
reserve          = netSats × 0.05
```

Example: net 9,850 sats → 8,865 to contributors by share, 492.5 coordinator, 492.5 reserve.

These are `issuance_payout_events` rows with `tokens` holding a **sats** amount. Nothing sends
sats: `sendToMany` exists on the bitcoind provider but no caller uses it, there is no payout
address per account, and the events are never marked paid. The 1.5 % intent fee is recorded
separately (`coordinator_fee_events`) and also never moved anywhere; it simply stays in the
node's Lightning balance.

## 6. Anchoring costs

Each ledger checkpoint is an OP_RETURN transaction. Guards (`src/economy/anchoring.ts`):

- fee cap per tx `BITCOIN_ANCHOR_MAX_FEE_SATS` (20,000), daily budget `BITCOIN_ANCHOR_DAILY_BUDGET_SATS`
  (200,000, so at most 10 anchors/day at the cap), mainnet opt-in `BITCOIN_ANCHOR_MAINNET=1`.
- After this change a broadcast is marked failed and retried only on a definite pre-send
  rejection; any ambiguous error leaves the row for reconciliation (#158).

## 7. Status summary

| Path | State |
|---|---|
| Earn credits for compute | Working; server-measured; failed work earns 0 |
| Spend credits to submit | Working; flat 1 credit per task |
| Buy credits with Lightning (LND) | Working against a node; fail-closed settlement; not deployable on Fly until a node exists (`ECONOMY_PAYMENTS_ENABLED=false`) |
| Buy credits with Lightning (CLN) | Hardened in this change; needs a regtest run before trusting it with money |
| Contribute-first gate for buyers | Fixed in this change |
| Price discovery | Market-anchored via the daily rate oracle (§2); live verification needs the exchange hosts reachable |
| Token issuance | Records only; tokens redeem for nothing |
| Sats payouts to contributors | Records only; no on-chain or Lightning sends |
| Ledger anchoring | Working with bitcoind / anchor proxy; mock in dev |
