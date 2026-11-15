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
accepted (`accrueResultCredits` in `src/swarm/coordinator/results.ts`). What the requester pays is what the
agent earns, minus the network fee (`NETWORK_FEE_BPS`, default 500 = 5 %), which is EdgeCoder's
revenue and is booked to `network:fee_pool` (section 5). Failed work is not charged and earns nothing.
The fee is rounded to the nearest whole msat (`splitJobCost` in `src/economy/job-pricing.ts`); model
calls cost a few msat, and the earlier floor kept EdgeCoder far below 5 % (a 16 msat call paid no
fee). Accruals recorded before the change carry no `feeRounding` and are verified with the floor.

**Fees, as decided by the owner on 2026-11-15:** buying cSats is free (`COORDINATOR_FEE_BPS` = 0,
1 sat buys 1 cSat); on every compute payment (model call, job, reservation) the compute host gets
95 % and EdgeCoder keeps 5 % (`NETWORK_FEE_BPS` = 500). The fee pool is no longer shared with
infrastructure hosts unless `FEE_POOL_HOST_DISTRIBUTION` is set.

### Model calls: per token, by model size

```
price(paramsB)  = TOKEN_PRICE_USD_PER_M row for the model's size (USD per million tokens, input / output)
tokenUsd        = (promptTokens × input + outputTokens × output) / 1,000,000
floorUsd        = POWER_FLOOR_USD_PER_HOUR[class] × max(1, tierWeight) × (seconds − loadSeconds) / 3600
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
The floor's seconds are the call's measured seconds less `loadSeconds`, the model-load time the
agent reports with the final piece (Ollama's `load_duration`; `floorExcludeMs` in
`inferenceCostMsat`). A host that unloaded its model does not bill the buyer for loading it
again, so a cold call costs what the same call costs warm. Only the agent is paid by the floor, so
over-reporting load time only lowers its own pay; older agents report none and the whole duration
counts. Queue time before an agent claims the call was never billed (seconds run from the claim).
`btcUsd` is the live rate oracle's BTC price (below), with a 100,000 USD fallback before the first
epoch. Model size comes from the model name (`paramsB` in `src/inference-api/auto-route.ts`). When
an agent reports no token counts the call falls back to the per-second price. Token counts are
taken once, from the final streamed piece the coordinator accepts, and are capped at what the
request and the accepted reply could hold (one token per byte, plus a small allowance for the chat
template and end-of-turn tokens; `boundTokenCounts` in `src/swarm/inference-streams.ts`). The basis used
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
- An agent never earns more than the requester is charged: each result's cost is taken from what
  the task set aside and not yet used, and pays only that much. Work with nothing set aside (an
  anonymous `/submit`) earns nothing.
- A subtask offered to peer coordinators runs on one coordinator only (`src/swarm/remote-grants.ts`):
  a peer asks the origin for it (`task_claim`) and queues it only once granted; the origin takes its
  own copy off its queue when it grants it. The peer prices the work as above (within the
  requester's bid, which travels with the offer, and the worst case for one subtask) and sends that
  cost with the forwarded result; the origin charges its requester that much out of the task's
  reserve and answers with the charge, and the peer pays its agent (and the network fee) exactly
  that. The rest of the reserve is refunded when the task settles. A grant whose result never
  comes back expires and the subtask runs again at the origin; the late result is refused.
- Billing survives a restart: a `task_billing` row is kept until the task settles. On startup a
  task whose subtasks are all accounted for is resumed (queued ones requeued, running ones keep
  their claimant with a fresh lease); any other (a model call, a subtask held behind dependencies,
  a task cut off before it was split) is refunded what it did not use. Amounts come from the ledger.
- `/ledger/verify` flags `task_overpaid`: a task whose work, fees and refund exceed its reserve.
- A task id belongs to one requester until its task settles: `/submit` and `/inference/submit`
  answer 409 `duplicate_task` for an id that is still billed, queued or held.

### Reservations: per second, paid up front

A reservation holds one agent of a class for 5 minutes to 24 hours (`src/economy/reservations.ts`).
It costs `minutes × 60 × rate`, with `rate` the class reference times the agent's tier weight,
paid in full when it is made. When it ends, early or on time, the unused time is refunded
(`reservation_refund:<id>`) and the agent's owner is paid for the time held, minus the network fee.

## 2. Buying cSats (sats → cSats)

`POST /economy/payments/intents` (coordinator):

```
feeSats  = floor(amountSats × COORDINATOR_FEE_BPS / 10000)      # default 0: purchases are free
cSats    = amountSats − feeSats
```

Example (default): 10,000 sats → **10,000 cSats**. With `COORDINATOR_FEE_BPS=150` it would be 9,850.

cSats are granted only when the Lightning node reports the invoice settled
(`src/economy/payment-settlement.ts`, #42): LND by `r_hash` with preimage, amount and state checks;
CLN by `payment_hash` with the same checks. The grant row is `credit_purchase:<intentId>`, unique
per intent.

### Funding with Bitcoin on-chain (`ONCHAIN_ENABLED`)

Same price, a different way to pay: 1 sat = 1 cSat, after the same `COORDINATOR_FEE_BPS` (0 by default).

```
deposit (txid:vout, amountSats, confirmations)
  amountSats < ONCHAIN_DEPOSIT_MIN_SATS (10,000)               -> below_minimum, not credited
  confirmations < ONCHAIN_DEPOSIT_CONFIRMATIONS (3 main, 1 else) -> pending, shown with "n of N"
  over ONCHAIN_DEPOSIT_MAX_SATS or the account's 24 h cap        -> held for an operator
  LAUNCH_MODE=invite: over LAUNCH_MAX_BUY_SATS_PER_DAY or
    LAUNCH_MAX_BALANCE_SATS, counted like a purchase            -> held for an operator
  otherwise                                                    -> credited: cSats = amountSats − feeSats
```

- Each account has a deposit address from the coordinator's LND wallet (`NewAddress`, Taproot by
  default). It is shown until a deposit to it is seen, then the account gets a fresh one; older
  addresses stay watched.
- The watcher (`src/economy/onchain-deposits.ts`) reads LND `GetTransactions` every
  `ONCHAIN_POLL_MS` (and before every payout reconciliation run). One coordinator watches at a time
  (Postgres advisory lock); every step is also a compare-and-set on the deposit row.
- Crediting is one transaction: the deposit row `pending -> credited`, a settled payment intent
  `onchain:<txid>:<vout>` (wallet type `onchain`, so it counts in `receivedPurchaseMsat`, payout
  capacity and solvency exactly like a Lightning purchase) and the grant row
  `credit_purchase:onchain:<txid>:<vout>`. A txid:vout is credited at most once.
- A pending deposit that leaves the wallet (replaced, double-spent, reorged out) becomes `dropped`;
  if it comes back it is pending again. A credited deposit that vanishes (a reorg deeper than the
  confirmations) becomes `reversed`, is a CRITICAL security event, and trips `balance_drop`.

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
   a CPU settles as `cpu`), but never on one sample: a first slow sample is held (the grant stays,
   flag `challenge_slow_unconfirmed`) and re-measured a minute later (`slowConfirmMs`), when a cold
   model or a busy start-up no longer weighs on it; a second slow sample within 30 min demotes to
   the better of the two, and so does declining or not answering the re-measurement. Invalid
   answers grant the base tier at once. Passes are re-proven every 6 h; real-task speed far below
   the challenge baseline demotes again. Tier minimums (`HARDWARE_TIER_MIN_JSON`) need calibrating
   on the fleet. The base tier of a class is its floor, not a performance bar: `gpu.dc40` needs
   80 GB/s effective (64 after the 1.25 slack), which every card the agent labels datacenter
   reaches, including the weak ones (A16 / A2 ~200 GB/s peak, L4 / T4 ~300, ~90-160 effective);
   until 2026-11-15 it was 300, which those cards never reach, so they fell to the consumer tiers
   or to `cpu`. CPUs decode at ~30-70. An agent whose Ollama pools several cards
   (`CUDA_VISIBLE_DEVICES=0,1`) reports their summed VRAM and `count`; a layer split reads the cards
   one after the other, so it measures about one card's bandwidth, and its "faster than the
   hardware" bound is the cards' sum. Matching is by granted class: an agent granted `cpu` takes
   no `@gpu.dc` call. A call for a class in which no online agent holds the model is refused at
   submit with `409 no_agent_in_class` (and `availableClasses`); a call that times out unclaimed
   says `reason: "busy"` or `"none_in_class"` in its `503 no_capacity`. The per-agent record, including the
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
payable(account)  = min( earned − Σ (amount + fee) of its paid payouts − Σ (amount + fee cap) of pending ones,
                         credit balance(account) in msat )
capacity(node)    = receivedPurchaseSats × (1 − PAYOUT_RESERVE_BPS/10000) − Σ all paid/pending
withdraw(bolt11)  : amount + maxFee ≤ payable, amount + maxFee ≤ capacity, invoice network = BITCOIN_NETWORK,
                    amount ≥ PAYOUT_MIN_SATS, maxFee = max(PAYOUT_MAX_FEE_BPS × amount, PAYOUT_MIN_FEE_FLOOR_SATS)
```

Earned sats are also spendable cSats, so one earning can leave the ledger only once: either
withdrawn or spent. A withdrawal therefore consumes the credit balance, and payable is capped at
that balance, so cSats spent (on a reservation, a job, a model call) stop being withdrawable.
Purchased cSats raise the balance but not `earned`, so they are spendable but never withdrawable.

A withdrawal reserves a pending row under the payout locks and the account's credit lock
(Postgres advisory locks; the payment hash is unique so an invoice is never paid twice) and, in
the same transaction, writes a `spend` row `payout:<payoutId>` for amount + fee cap (no msat: the
payouts row is what lowers `earned − paid`). It then pays through the coordinator's Lightning node
(`LightningProvider.payInvoice`, LND or CLN) and settles the row only when the returned preimage
hashes to the invoice's payment hash. Settlement gives back what the debit did not use in the
same transaction: an `earn` row `payout_refund:<payoutId>` (no msat) for the whole debit when the
payout failed, or for the unused fee cap when it was paid (a fee above the cap, which the node
should never charge, is a further `spend` row `payout_fee_excess:<payoutId>`). Only a row still
pending changes and the row ids are fixed, so a repeated settlement changes nothing. A definite
node failure frees the balance; an ambiguous transport failure leaves the row pending (and the
debit in place) for reconciliation.

Payouts reserved before this rule existed have no debit row and get no adjustment. Their sats
are still counted in `earned − paid`, but the cSats they paid out are still in the balance; see
`solvency` below.

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
  | `solvency` | cSats outstanding exceed sats received − paid/pending out + faucet grants, by more than tolerance + `PAYOUT_SOLVENCY_ALLOWANCE_SATS` (default 0) | pause |

  `solvency` is a ledger-only invariant (Postgres only). Outstanding = Σ credit balance of every
  account except the fee pool, plus the pool's undistributed sats (purchase fees reach it as sats
  without cSats); payable never exceeds a balance, so it is not added again. Every ledger move
  keeps the two sides equal: a purchase adds the same sats to both, a spend moves cSats to the
  provider and the pool (or holds them while a lease or task runs, which only lowers the
  outstanding side), a withdrawal moves its debit from cSats to payouts. Admin faucet grants are
  counted as backing because they are minted on purpose. A gap therefore means more is owed than
  ever came in, and payouts pause. The allowance exists for a known historical gap (cSats still
  held for payouts made before withdrawals debited them) until that is corrected in the data.

  A trip pauses payouts through the kill switch (source `reconciliation`, until an admin resumes),
  logs `payout_reconciliation_mismatch`, and POSTs a JSON summary to `PAYOUT_ALERT_WEBHOOK_URL`
  when set (counts, msat amounts and payment hashes; never invoices, preimages or credentials). An
  unreadable node is an alert, not a pause. `GET /admin/payouts/reconciliation` shows the last
  result; `POST /admin/payouts/reconciliation/run` runs one now. Dedicate the node to the
  coordinator: any other spending from it trips `unknown_payments` by design.

### On-chain payouts, batched (`ONCHAIN_ENABLED`)

A host whose payout destination is a Bitcoin address (bech32 or bech32m with the network's HRP:
`bc1`, `tb1`, `bcrt1`; legacy base58 is refused) is paid in batches
(`src/economy/onchain-payouts.ts`). Every `ONCHAIN_PAYOUT_INTERVAL_MS` (6 h) at most, across all
coordinators on the database:

```
rate      = LND fee estimate for ONCHAIN_PAYOUT_TARGET_CONF (6) blocks, sat/vB
            no batch while rate > ONCHAIN_PAYOUT_MAX_FEE_RATE (30 main, 100 else)
feeCap    = rate × 165 vB         (host pays; 0 when ONCHAIN_PAYOUT_FEE_PAYER=edgecoder)
output    = floor(payable / 1000) − feeCap, clamped to PAYOUT_MAX_SINGLE_SATS − feeCap
            paid only when output >= ONCHAIN_PAYOUT_MIN_SATS (50,000)
```

Each output is a `payouts` row (kind `onchain`) reserved through the same `reservePayout` as a
Lightning withdrawal, so the earnings hold, the credit cap, node capacity and the 24 h caps all
apply, and the account is debited `output + feeCap`. All outputs go in one LND `SendMany` at `rate`.
At confirmation the transaction's actual fee is split equally across the outputs, each share
capped at its `feeCap` (`allocateBatchFee`); the unused cap goes back to the account and any
remainder is EdgeCoder's. EdgeCoder's part (all of the fee with `ONCHAIN_PAYOUT_FEE_PAYER=edgecoder`)
is a `spend` row `onchain_batch_fee:<batch>` (msat) on `network:fee_pool`, written when the fee is
known, and counted as payout outflow by reconciliation.

Batch state machine (one `onchain_payout_batches` row, written before anything is sent):

```
building -> pending -> broadcast -> confirmed
   |           |
   +-----------+----> failed  (payouts released; the earnings go in a later batch)
```

- `building`: payouts being reserved. Interrupted -> failed (nothing was sent).
- `pending`: outputs frozen; `send_attempted_at_ms` is stamped right before `SendMany`, which
  carries the label `edgecoder:onchain-batch:<id>`. After a crash or a timeout the node is asked for
  a transaction with that label: found -> broadcast; none after `ONCHAIN_BROADCAST_GRACE_MS` ->
  failed. A clear refusal from LND (insufficient funds, bad address) fails at once.
- `broadcast`: txid on the batch and each payout; payouts stay pending (counted at their fee cap).
- `confirmed`: after `ONCHAIN_PAYOUT_CONFIRMATIONS`, payouts settle as paid with their fee share.
- A failed batch whose label later appears in the node pauses all payouts (kill switch,
  `onchain_batch_resurfaced`). Transactions are never matched by outputs: an earlier batch can pay
  the same address the same amount.

The kill switch stops new batches and a send that has not started; confirmations of a batch already
broadcast still settle. One runner at a time (advisory lock).

Reconciliation with on-chain: deposits the node holds but the ledger has not credited (pending,
held, below the minimum) count as received for `balance_drop`; credited ones are payment intents;
on-chain payouts are payout rows; EdgeCoder's batch fees are extra outflow. While a batch's send is
unrecorded, `balance_drop` waits a run and keeps its baseline.

Routes: `POST /account/onchain/address`, `POST /account/onchain/deposits` (signed agent or portal
token), `POST /economy/payouts/onchain-address` (portal token), `GET /admin/onchain`,
`POST /admin/onchain/deposits/:txid/:vout/credit`, `POST /admin/onchain/batches/run` (admin token).
The portal exposes them as `/portal/api/wallet/onchain*` and `PUT /wallet/payout-destination`.

### The network fee pool: EdgeCoder's revenue (optionally shared with hosts)

By default the pool is EdgeCoder's: nothing below runs unless `FEE_POOL_HOST_DISTRIBUTION` is set
(`runFeePoolDistribution` answers `skipped: "disabled"`). The rest of this section describes the
opt-in sharing with infrastructure hosts, for networks with third-party coordinator operators.

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

Each share becomes an `earn` row on the host's account (msat, plus the same amount in cSats so the
host can withdraw it; purchase fees arrive without cSats, so the pool's own cSat balance can go
below zero while its sats stay the measure of what it holds), the pool gets a matching `spend`, the ledger records `fee_pool_distribution`,
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
| Fund with Bitcoin on-chain (LND) | Built, behind `ONCHAIN_ENABLED` (off by default); unit and route tests with a fake LND; needs a regtest run with real deposits before enabling |
| Contribute-first gate for buyers | Working |
| Price discovery | Daily oracle × compute class, a per-class ask/bid order book matched at claim time, per-token prices by model size at the oracle's BTC price |
| Token issuance | Records only; tokens redeem for nothing |
| Sats payouts to contributors | Working: BOLT11 withdrawals and LNURL auto payouts through the node (needs `LIGHTNING_PROVIDER=lnd|cln`); fee pool distributed to infrastructure hosts daily |
| On-chain payouts, batched (LND) | Built, behind `ONCHAIN_ENABLED`; same caps, hold and kill switch; needs a regtest run before enabling |
| Ledger anchoring | Working with bitcoind / anchor proxy; mock in dev |
| Settlement model | Custodial today; pay-per-use bitcoin settlement under design (PR #195) |
