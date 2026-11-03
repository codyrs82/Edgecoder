# Economy math: cSats, sats, tokens

> **Bitcoin settlement is being redesigned.** Today value sits with the coordinator between a
> purchase and a payout (custodial). The target, pay-per-use settlement in sats over Lightning, is
> proposed in PR #195 (`docs/design/bitcoin-settlement.md` once merged). This page describes what
> the code does now.

This is the arithmetic the coordinator actually runs today, with the source of each formula,
worked examples, and the places where the numbers or the wiring do not hold up. Design
intent is in `docs/economy-compute-trust-model.md`; this document is about what the code does.

Three units appear in the code and they are not interchangeable:

| Unit | What it is | Where it lives |
|---|---|---|
| **cSat** | Prepaid compute balance. **1 cSat = 1 sat**; amounts are carried as msat and stored at 3 decimals (`msatToCSats` in `src/economy/job-pricing.ts`). Bought with sats, spent on model calls, jobs and reservations, earned by running them. The code still calls ledger rows "credits". | `credit_transactions` (Postgres) or the in-memory `CreditEngine` |
| **sat** | Bitcoin, paid through Lightning for cSats, paid out to contributors, and spent on OP_RETURN anchoring fees. | Lightning node, `payment_intents`, `bitcoin_anchor_records` |
| **token** | Issuance accounting unit from the daily pool. Recorded, not yet credited or paid out. | `issuance_epochs`, `issuance_allocations`, `issuance_payout_events` |

A "credit" below, in the order book and the oracle, is a **unit of work**: one second on a
compute class's base tier. Its price is quoted in msat per credit.

## 1. What things cost

All formulas are in `src/economy/job-pricing.ts`; the coordinator applies them when a result is
accepted (`accrueResultCredits` in `src/swarm/coordinator.ts`). What the requester pays is what the
agent earns, minus the network fee (`NETWORK_FEE_BPS`, default 500 = 5 %), which goes to the fee
pool (section 5). Failed work is not charged and earns nothing.

### Model calls: per token, by model size

```
price(paramsB)  = TOKEN_PRICE_USD_PER_M row for the model's size (USD per million tokens, input / output)
tokenUsd        = (promptTokens × input + outputTokens × output) / 1,000,000
floorUsd        = POWER_FLOOR_USD_PER_HOUR[class] × max(1, tierWeight) × seconds / 3600
cost (msat)     = usdToMsat(max(tokenUsd, floorUsd), btcUsd)        # usdToMsat = usd / btcUsd × 1e8 × 1000
```

| Model size | Input USD / M tokens | Output USD / M tokens |
|---|---|---|
| ≤ 2B | 0.01 | 0.03 |
| ≤ 4B | 0.02 | 0.05 |
| ≤ 9B | 0.04 | 0.10 |
| ≤ 16B | 0.07 | 0.20 |
| ≤ 35B | 0.12 | 0.35 |
| ≤ 80B | 0.30 | 0.80 |
| larger | 0.60 | 1.50 |

The prices are set below typical hosted prices for open models of the same size. The power floor
(`cpu` $0.005/h, `apple` $0.01/h, `gpu` $0.05/h, `gpu.dc` $0.15/h of the base tier, scaled by the
tier weight) means a machine's owner never earns less than the electricity the seconds cost.
`btcUsd` is the live rate oracle's BTC price (below), with a 100,000 USD fallback before the first
epoch. Model size comes from the model name (`paramsB` in `src/inference-api/auto-route.ts`). When
an agent reports no token counts the call falls back to the per-second price. The basis used
(`tokens`, `power_floor` or `per_second`) is recorded on the earnings ledger record.
`cSatsPerMTokens` gives the per-million-token price in cSats that the apps show.

Example at 100,000 USD/BTC: a 9B model reads 2,000 tokens and writes 500.
`tokenUsd = (2000 × 0.04 + 500 × 0.10) / 1e6 = 0.00013 USD` = 130 msat = **0.13 cSats**. If it ran
for 10 s on a base-tier `gpu`, the floor is `0.05 × 10 / 3600 = 0.000139 USD` = 0.139 cSats, so the
floor applies and the call costs 0.139 cSats.

### Code jobs: per second

```
perCredit (msat) = clampToBand(matched price, class reference)   # band 0.25x .. 4x the class reference
rate (msat/s)    = perCredit × tierWeight
cost (msat)      = seconds × rate
```

- `seconds` is **server-measured**: `creditedDurationMs = min(reported, now − claimedAt, subtask.timeoutMs)`
  (`src/swarm/result-integrity.ts`). An agent cannot report more time than the coordinator observed.
- The matched price is the trade agreed in the order book at claim time (section 2); the band
  stops a self-dealing ask/bid from moving the sats value (audit econ#2).
- At submit the coordinator sets aside the worst case for one subtask (`reserveMsat`: its time
  limit at the top of the band on the class's fastest tier, lowered to the requester's bid ceiling
  when set) as a `task_reserve` row, tops it up once the task is split, and refunds the unused part
  when the task finishes (`task_submit_refund:<task>`). Not enough balance returns 402
  `insufficient_credits`.
- Work on your own machines is not charged.

### Reservations: per second, paid up front

A reservation holds one agent of a class for 5 minutes to 24 hours (`src/economy/reservations.ts`).
It costs `minutes × 60 × rate`, with `rate` the class reference times the agent's tier weight,
paid in full when it is made. When it ends, early or on time, the unused time is refunded
(`reservation_refund:<id>`) and the agent's owner is paid for the time held, minus the network fee.

## 2. Buying cSats (sats → cSats)

`POST /economy/payments/intents` (coordinator):

```
feeSats  = floor(amountSats × COORDINATOR_FEE_BPS / 10000)      # default 150 bps = 1.5 %
cSats    = amountSats − feeSats
```

Example: 10,000 sats → fee 150 → **9,850 cSats**.

cSats are granted only when the Lightning node reports the invoice settled
(`src/economy/payment-settlement.ts`, #42): LND by `r_hash` with preimage, amount and state checks;
CLN by `payment_hash` with the same checks. The grant row is `credit_purchase:<intentId>`, unique
per intent.

### Price level: market-anchored, recalibrated daily

`src/economy/rate-oracle.ts` sets the class reference prices (msat per credit) and the BTC price
used for per-token pricing. It recalibrates (default daily, `RATE_RECALIBRATION_MS`) from two
verifiable inputs:

```
btcUsd          = median of agreeing spot quotes (Coinbase, Kraken, Bitstamp, mempool.space;
                  quotes > RATE_MAX_SOURCE_SPREAD_PCT from the median are dropped; >= RATE_MIN_SOURCES must remain)
usdPerHour      = per-class reference (table below), or a live source tagged with that class
satsPerHour     = usdPerHour / btcUsd × 1e8 × (1 + RATE_NETWORK_MARKUP_BPS / 10000)
satsPerCredit   = satsPerHour / 3600
```

Worked example at 100,000 USD/BTC with the defaults: cpu at $0.02/h → 20 sats/h → +20 % → 24 sats
per CPU-hour, about 6.7 msat per credit (CPU-second).

Guards: a fresh epoch may move at most `RATE_MAX_DAILY_MOVE_PCT` (25 %) from the previous one and the
unclamped value is recorded; if sources fail the previous epoch is carried and flagged; quotes
report `stale: true` after 48 h. Epochs persist in `rate_epochs`; `GET /economy/rates/current` and
`/economy/rates/history` expose them; `POST /economy/rates/recalibrate` (admin) forces one.

Why not hashprice: hashprice (sats per TH/s per day) is Bitcoin mining revenue and tracks
difficulty and block fees, not the cost of a CPU-second. The oracle computes it from mempool.space
chain data (144 × (subsidy + 24 h average fees) / network TH) and stores it on each epoch as a
signal for operators, but it never enters the compute price.

### Compute classes, model size, and the order book

A credit is a measured second, but seconds are priced by what ran them. Three factors, all
dynamic:

1. **Compute class** (`src/economy/compute-classes.ts`). Agents report a hardware profile at
   registration (cores, RAM, arch, platform, GPU vendor/model/VRAM) and are classified into one
   of four class-markets and a tier inside it. Each class has ONE reference (the base tier's
   USD/hour), one order book and one clearing price; faster tiers mint more credits per second:

   | class | reference | tiers (credits per second) |
   |---|---|---|
   | `cpu` | $0.02/h | `cpu.std` 1, `cpu.hi` (≥ 32 cores or ≥ 128 GB) 4 |
   | `apple` | $0.12/h | `apple.m` (< 32 GB) 1, `apple.m.hi` (≥ 32 GB) 2.5 |
   | `gpu` | $0.10/h | `gpu.c8` (≤ 8 GB) 1, `gpu.c16` 2, `gpu.c24` 3.5, `gpu.c32` (> 24 GB consumer) 4.5 |
   | `gpu.dc` | $0.70/h | `gpu.dc40` (≤ 48 GB) 1, `gpu.dc80` (> 48 GB) 2.9 |

   `satsPerCredit = usdPerHour(class) / btcUsd × 1e8 × (1 + markup) / 3600`, flat within the
   class, and a tier's hour is `satsPerCredit × 3600 × weight` (a 24 GB GPU-hour is 3.5 GPU
   credit-hours). Live sources tagged with a `computeClass` override that class's reference (a
   tier id prices that tier's hour and is divided by its weight); weights are overridable with
   `COMPUTE_TIER_WEIGHTS_JSON`, references with `COMPUTE_REFERENCE_USD_PER_HOUR_JSON`.
   Capability needs are bid constraints, not markets: a task may set `minVramGb` / `minMemoryGb`
   (and `minReliability`, below) and only agents that meet them can claim it. The nine pre-2026-11 class ids (`cpu.std` …
   `gpu.dc80`) are the tier ids now; APIs accept them and map them onto their class, history
   stored under them is mapped at read time, and signed receipts that carry them are never
   rewritten.

   **Verified tiers** (`src/swarm/hardware-verification.ts`, `src/swarm/benchmark.ts`). The
   profile is self-reported, so a tier above the class base is paid only after the agent passes
   a coordinator-issued challenge; until then it earns the class base weight 1 (older agents that
   cannot answer challenges keep working there). CPU tiers: a memory-hard scrypt proof of work
   over a fresh random seed, sample-verified by the coordinator; GPU / Apple tiers: a fixed-seed
   greedy generation of a nonce-tagged prompt on the agent's Ollama model, measured as effective
   bandwidth (tokens/s × weight GB) and, by default, cross-checked against a second agent running
   the same model (`HARDWARE_GPU_REQUIRE_CROSS_CHECK`). The deadline is
   `allowance + work × slack / tierMinimum`; speed is `work / max(server time − allowance, agent
   time)`. Slow or late answers demote to the tier the speed supports (a "GPU" that measures like
   a CPU settles as `cpu`); invalid answers grant the base tier. Passes are re-proven every 6 h;
   real-task speed far below the challenge baseline demotes again. Tier minimums
   (`HARDWARE_TIER_MIN_JSON`) need calibrating on the fleet. The per-agent record, including the
   rolling `evidence.score` that a bid's `minReliability` checks, is on
   `GET /economy/hardware/verifications`.
2. **Model size.** Per-second prices do not depend on the model. Model size enters through the
   per-token price of model calls (section 1).
3. **Market** (`src/economy/order-book.ts`). Every agent posts an ask in msat per credit on its
   class (default: the oracle reference, which it then tracks; `AGENT_ASK_MSAT_PER_CREDIT` fixes
   it). Every task carries a bid (`maxBidMsatPerCredit`, default reference × 1.10). At claim time
   an agent may take a task only if its ask ≤ the bid and the class matches (or the bid is
   `any`); the trade prices at the ask and that price is locked on the earn row. The best ask,
   best bid, spread, mid and the volume-weighted price of the last hour's trades per class are
   on `GET /economy/market/book`; class definitions with current rates on
   `GET /economy/market/classes`.

Repricing on a market swing therefore happens two ways: the daily oracle moves every
tracking ask and every default bid (and the BTC price behind per-token prices); and agents with
fixed asks either become the cheapest or stop matching, which is the signal that
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

### Hot-wallet safeguards

Three guards sit in front of every payment out of the node (`src/economy/payout-safeguards.ts`,
`src/economy/payout-reconcile.ts`; operator steps in [Going to mainnet](going-to-mainnet.md)):

- **Caps.** `PAYOUT_MAX_SINGLE_SATS`, `PAYOUT_MAX_ACCOUNT_DAILY_SATS` and
  `PAYOUT_MAX_GLOBAL_DAILY_SATS` bound one payout and the rolling 24 h total per account and for
  the coordinator, all counted as amount + routing-fee cap (pending rows at their cap). Unset on
  mainnet they default to 100k / 500k / 2M sats; elsewhere to no cap. The 24 h check runs inside
  the reservation transaction under one global advisory lock, so concurrent requests and both
  seeds see each other. A payout over a cap is rejected (`payout_limit_*`, security event
  `payout_limit_exceeded`): the balance stays payable and an auto payout simply waits for the
  window to roll. Nothing is queued for later approval.
- **Kill switch.** While paused, withdrawals (`503 payouts_paused`), auto payouts and fee-pool
  distribution do nothing; invoice purchases keep settling. `POST /admin/payouts/pause
  {paused, reason}` (admin token) sets a flag stored in Postgres (`payout_controls`), so every
  instance and every restart honours it; each change is a security event and a
  `payouts_pause_changed` ledger record. `PAYOUTS_PAUSED=1` forces one instance paused and cannot
  be lifted over the API. If the flag cannot be read, payouts count as paused. The provider used
  for payouts also refuses `payInvoice` while paused, and the service re-checks right before paying.
- **Reconciliation.** Every `PAYOUT_RECONCILE_MS` the node's balances and outgoing payments
  (`LightningProvider.getBalances` / `listPayments`; LND REST and c-lightning-REST) are compared with
  the ledger. Each check allows `PAYOUT_RECONCILE_TOLERANCE_SATS` of slack:

  | Check | Fails when | Effect |
  |---|---|---|
  | `unknown_payments` | the node sent (or has in flight) payments with no payout row | pause |
  | `ledger_freed` | a payout marked failed was sent by the node | pause |
  | `paid_mismatch` | node amount + fee ≠ ledger amount + fee for paid payouts | pause |
  | `balance_drop` | node total fell more than purchases in − payouts out since the last run | pause |
  | `liability_shortfall` | earned-but-unpaid sats exceed what the node holds | alert only |

  A trip pauses payouts through the kill switch (source `reconciliation`, until an admin resumes),
  logs `payout_reconciliation_mismatch`, and POSTs a JSON summary to `PAYOUT_ALERT_WEBHOOK_URL`
  when set (counts, msat amounts and payment hashes; never invoices, preimages or credentials). An
  unreadable node is an alert, not a pause. `GET /admin/payouts/reconciliation` shows the last
  result; `POST /admin/payouts/reconciliation/run` runs one now. Dedicate the node to the
  coordinator: any other spending from it trips `unknown_payments` by design.

### The network fee pool pays infrastructure hosts

Two inflows to `network:fee_pool`:

- `NETWORK_FEE_BPS` of every accrual (credits and msat, split in the same transaction);
- the coordinator fee of every settled purchase (`purchase_fee:<intent>` rows: sats only).

Hosts heartbeat every `HOST_HEARTBEAT_MS` (a coordinator records its own; a remote host sends
`POST /economy/hosts/heartbeat` signed with its mesh key) declaring the services they run. A
heartbeat counts toward `heartbeats_h` at most once per 0.8 × `HOST_HEARTBEAT_MS`, and only
services the receiving coordinator attested count in the weight (probes over each service's own
protocol; see [infra-node.md](infra-node.md) "How you are paid"). Every `FEE_POOL_DISTRIBUTION_MS`:

```
uptime_h  = min(1, heartbeats_h / expectedHeartbeats)          (0 below 50 %)
weight_h  = uptime_h × (coordinator 1.0 + bitcoind 1.0 + lightning 1.0 + electrs 0.5)
share_h   = available_pool_msat × weight_h / Σ weight
```

Each share becomes an `earn` row on the host's account (msat, plus credits pro rata when the
pool holds any), the pool gets a matching `spend`, the ledger records `fee_pool_distribution`,
and the heartbeat window resets. Hosts withdraw like anyone else.

Distribution holds a Postgres session advisory lock (`pg_try_advisory_lock`; in memory, an
in-process flag), so when two seeds share a database a second run returns `skipped: "locked"`
instead of splitting the same pool. The timer also skips a window that another instance
distributed less than 90 % of `FEE_POOL_DISTRIBUTION_MS` ago (`skipped: "recent"`), so two
timers do not split the day into two half-windows in which hosts miss the 50 % uptime bar. The
admin route `POST /economy/fee-pool/distribute` bypasses only that second check.

Routes: `GET /economy/payouts/:accountId`, `POST /economy/payouts/withdraw` and
`POST /economy/payouts/address` take the portal service token only (the portal exposes them to
users as `/wallet/payouts*`); `POST /economy/hosts/heartbeat` takes the mesh token plus the host's
signature; `GET /economy/hosts` and `GET /economy/fee-pool` take the mesh or portal service token;
`POST /economy/fee-pool/distribute` takes the admin token.

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
| Earn for compute | Working; per token for model calls (with power floor), per second for code jobs and reservations; server-measured; failed work earns 0 |
| Pay for compute | Working; worst case set aside at submit, settled to the actual cost, unused part refunded |
| Reservations | Working; prepaid, unused time refunded |
| Buy cSats with Lightning (LND) | Working against a node; fail-closed settlement (`ECONOMY_PAYMENTS_ENABLED=false` disables it) |
| Buy cSats with Lightning (CLN) | Hardened; needs a regtest run before trusting it with money |
| Contribute-first gate for buyers | Working |
| Price discovery | Daily oracle × compute class, a per-class ask/bid order book matched at claim time, per-token prices by model size at the oracle's BTC price |
| Token issuance | Records only; tokens redeem for nothing |
| Sats payouts to contributors | Working: BOLT11 withdrawals and LNURL auto payouts through the node (needs `LIGHTNING_PROVIDER=lnd|cln`); fee pool distributed to infrastructure hosts daily |
| Ledger anchoring | Working with bitcoind / anchor proxy; mock in dev |
| Settlement model | Custodial today; pay-per-use bitcoin settlement under design (PR #195) |
