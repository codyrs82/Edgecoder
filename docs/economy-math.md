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

### Compute classes, model size, and the order book

A credit is a measured second, but seconds are priced by what ran them. Three factors, all
dynamic:

1. **Compute class** (`src/economy/compute-classes.ts`). Agents report a hardware profile at
   registration (cores, RAM, arch, platform, GPU vendor/model/VRAM) and are classified into
   `cpu.std`, `cpu.hi`, `apple.m`, `apple.m.hi`, `gpu.c8`, `gpu.c16`, `gpu.c24`, `gpu.dc40` or
   `gpu.dc80`. Each class has a reference USD/hour (0.02 for a commodity CPU up to 1.80 for an
   H100-class GPU) and a credits-per-second rate (1 to 10). The oracle converts every class to
   sats per credit daily so that one unit-hour of the class is worth its market price:
   `satsPerCredit = usdPerHour / btcUsd × 1e8 × (1 + markup) / (creditsPerSecond × 3600)`.
   Live sources tagged with a `computeClass` override that class's reference.
2. **Model profile** (`src/credits/pricing.ts`). The per-second rate is multiplied by the size of
   the model that served the task (≤3B 1.0, ≤10B 1.5, ≤35B 2.5, >35B 4.0) and the sats value by
   its modality (vision +25 %, thinking +10 %), from the catalog's capability labels.
3. **Market** (`src/economy/order-book.ts`). Every agent posts an ask in msat per credit on its
   class (default: the oracle reference, which it then tracks; `AGENT_ASK_MSAT_PER_CREDIT` fixes
   it). Every task carries a bid (`maxBidMsatPerCredit`, default reference × 1.10). At claim time
   an agent may take a task only if its ask ≤ the bid and the class matches (or the bid is
   `any`); the trade prices at the ask and that price is locked on the earn row. The best ask,
   best bid, spread, mid and the volume-weighted price of the last hour's trades per class are
   on `GET /economy/market/book`; class definitions with current rates on
   `GET /economy/market/classes`.

Repricing on a market swing therefore happens three ways: the daily oracle moves every
tracking ask and every default bid; the scarcity multiplier moves quotes with queue depth; and
agents with fixed asks either become the cheapest or stop matching, which is the signal that
makes them reprice.

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

## 5. Payouts (sats leave the ledger)

Every `earn` row carries the sats it was worth when earned (`msat`, locked at the trade price).
`PayoutService` (`src/economy/payout-service.ts`) is the only path out:

```
earned(account)   = Σ msat of the account's earn rows
payable(account)  = earned − Σ (amount + fee) of its paid and pending payouts
capacity(node)    = receivedPurchaseSats × (1 − PAYOUT_RESERVE_BPS/10000) − Σ all paid/pending
withdraw(bolt11)  : amount ≤ payable, amount + maxFee ≤ capacity, invoice network = BITCOIN_NETWORK,
                    amount ≥ PAYOUT_MIN_SATS, maxFee = max(PAYOUT_MAX_FEE_BPS × amount, PAYOUT_MIN_FEE_FLOOR_SATS)
```

A withdrawal reserves a pending row under a per-account lock (Postgres advisory lock; the
payment hash is unique so an invoice is never paid twice), pays it through the coordinator's
Lightning node (`LightningProvider.payInvoice`, LND or CLN), and settles the row only when the
returned preimage hashes to the invoice's payment hash. A definite node failure frees the
balance; an ambiguous transport failure leaves the row pending for reconciliation.

Automatic payouts: an account with a Lightning address (`POST /economy/payouts/address`, or an
infrastructure host's `INFRA_HOST_LIGHTNING_ADDRESS`) is paid every `PAYOUT_AUTO_INTERVAL_MS`
once payable ≥ `PAYOUT_AUTO_MIN_SATS`, by requesting an invoice over LNURL-pay.

### The network fee pool pays infrastructure hosts

Two inflows to `network:fee_pool`:

- `NETWORK_FEE_BPS` of every accrual (credits and msat, split in the same transaction);
- the coordinator fee of every settled purchase (`purchase_fee:<intent>` rows: sats only).

Hosts heartbeat every `HOST_HEARTBEAT_MS` (`POST /economy/hosts/heartbeat`; a coordinator
heartbeats for itself) declaring the services they run. Every `FEE_POOL_DISTRIBUTION_MS`:

```
uptime_h  = min(1, heartbeats_h / expectedHeartbeats)          (0 below 50 %)
weight_h  = uptime_h × (coordinator 1.0 + bitcoind 1.0 + lightning 1.0 + electrs 0.5)
share_h   = available_pool_msat × weight_h / Σ weight
```

Each share becomes an `earn` row on the host's account (msat, plus credits pro rata when the
pool holds any), the pool gets a matching `spend`, the ledger records `fee_pool_distribution`,
and the heartbeat window resets. Hosts withdraw like anyone else.

Routes: `GET /economy/payouts/:accountId`, `POST /economy/payouts/withdraw`,
`POST /economy/payouts/address`, `POST /economy/hosts/heartbeat`, `GET /economy/hosts`,
`GET /economy/fee-pool`, `POST /economy/fee-pool/distribute` (mesh token or portal service
token; the portal exposes them to users as `/wallet/payouts*`).

The older issuance records (`issuance_payout_events`, `coordinator_fee_events`) are still
written for bookkeeping but pay nothing; the pool and payouts above are the live path.

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
| Price discovery | Daily oracle (verified live: 4 exchanges agree) × compute class × model size, with a per-class ask/bid order book matched at claim time |
| Token issuance | Records only; tokens redeem for nothing |
| Sats payouts to contributors | Working: BOLT11 withdrawals and LNURL auto payouts through the node (needs `LIGHTNING_PROVIDER=lnd|cln`); fee pool distributed to infrastructure hosts daily |
| Ledger anchoring | Working with bitcoind / anchor proxy; mock in dev |
