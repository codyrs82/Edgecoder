# Bitcoin-settled payments (cSats as a unit of measure)

**Status:** design for review. Nothing here is built. It changes how real money moves, so no part
of it runs on mainnet without the owner's sign-off (see [Mainnet gate](#8-mainnet-gate)).

**Principle** (owner, [ROADMAP.md](../ROADMAP.md) "Credits are a unit of measure; value moves in
bitcoin"): cSats measure work (1 cSat = 1 sat of compute). They never change hands. Every payment
and every exchange of value reduces to bitcoin and moves over the bitcoin network (Lightning).

**Recommendation in one paragraph.** Keep one ledger, denominated in msat, where every row points
at a Lightning payment (or a settlement batch that does). By default, requesters pay from a
**self-custodial wallet built into the local app**. The user funds it over Lightning or on chain,
and a **spending contract** signed by the user's key and the coordinator's key lets the network
pull from it at intervals, within agreed limits, over Nostr Wallet Connect. Hold invoices are the
fallback for wallets that can't do this. L402 serves the hosted API and MCP. Charges are batched
into short settlement windows because per-token costs are far below one sat. Providers are paid in
sats on a short window, straight to their Lightning address, BOLT12 offer or node. The network fee
is 5 % all-in, taken in sats at settlement. The custodial prepaid balance is leaning toward
removal. Ecash is a later opt-in.

## Owner decisions (2026-11-02)

| # | Decision | Where |
|---|---|---|
| D1 | **Default payment is a self-custodial wallet built into the user's local app**, funded over Lightning or on chain. A spending contract signed by both the user's key and the coordinator's key lets the network pull automatically at intervals, within agreed limits (max per interval, top-up threshold, expiry), and asks the user to top up when the balance runs low. It is built on Nostr Wallet Connect budgeted pulls. Hold invoices stay as the fallback for wallets that can't do it. | [5.7](#57-the-embedded-wallet-and-spending-contract-default) |
| D2 | **Custodial prepaid balance: no decision yet, leaning toward removal**, because the self-custodial wallet takes its place. | [5.5](#55-prepaid-balance-and-change) |
| D3 | **Network fee: 5 %.** Whether the 1.5 % purchase fee survives is explained in 5.4. The recommendation is 5 % all-in; the owner still has to confirm. | [5.4](#54-fees) |
| D4 | **Legal review: a legal AI agent does a first pass, then a digital-assets attorney reviews. Mainnet is gated on the attorney signing off.** | [8](#8-mainnet-gate), [9](#9-regulatory-and-custody-notes) |

---

## Contents

1. [Today: flows and where value sits](#1-today-flows-and-where-value-sits)
2. [Problems with today's model](#2-problems-with-todays-model)
3. [Constraints that shape the design](#3-constraints-that-shape-the-design)
4. [Design options](#4-design-options)
5. [Recommendation](#5-recommendation)
6. [Data model and API changes](#6-data-model-and-api-changes)
7. [Migration plan](#7-migration-plan)
8. [Mainnet gate](#8-mainnet-gate)
9. [Regulatory and custody notes](#9-regulatory-and-custody-notes)
10. [Open questions for the owner](#10-open-questions-for-the-owner)

---

## 1. Today: flows and where value sits

### 1.1 Money in: buying cSats

`POST /account/buy` (portal; desktop via `/v1/ide/compute/buy`) calls `createPaymentIntent` in
`src/swarm/coordinator.ts`. The coordinator's node issues a BOLT11 invoice
(`LightningProvider.createInvoice`, `src/economy/lightning.ts`: LND, CLN or the mock provider).
When the node reports it settled, `createPaymentSettler` (`src/economy/payment-settlement.ts`)
grants `netSats` as cSats in one transaction (a `credit_purchase:<intentId>` row) after taking
`COORDINATOR_FEE_BPS` (150 bps). The fee goes to `network:fee_pool` as a sats-only row
(`recordIntentSettlementSideEffects`). Settlement is polled (`reconcileIntent`) and can be nudged
by a signed webhook; the node is always the source of truth.

### 1.2 Spending: jobs and leases

- **Per-second and per-token jobs.** `/inference/submit` debits the worst case up front
  (`subtaskReserveMsat` -> `reserveMsat` in `src/economy/job-pricing.ts`: time limit x top of the
  price band x fastest tier) with `spendCredits(..., "inference_reserve")`. When the result
  arrives the real cost is priced (`jobCostMsat` per second, or `inferenceCostMsat` per token with
  a power floor), split by `splitJobCost` (`NETWORK_FEE_BPS`, 500 bps) and accrued to the provider
  and the fee pool (`accruePricedJob`, `src/credits/store.ts`). The unused part comes back as a
  cSat grant (`refundTaskSubmit`, `task_submit_refund:*`).
- **Reservations.** `POST /account/reservations` debits the whole lease in cSats
  (`reservationPriceMsat`, `src/economy/reservations.ts`). When the lease ends, `endReservation`
  accrues the used time to the agent's owner and refunds the rest as a cSat grant
  (`reservation_refund:*`).
- **Offline transfers.** `/credits/ble-sync` (`src/credits/ble-sync.ts`,
  `PostgresStore.applyBleTransfer`) moves cSats from a requester account to a provider account for
  work done over Bluetooth.

### 1.3 Money out: payouts

`PayoutService` (`src/economy/payout-service.ts`, rules in `src/economy/payouts.ts`) is the only
path out. Payable = sum of `msat` on the account's `earn` rows minus paid and pending payouts. A
payout is either a BOLT11 the account posts (`/economy/payouts/withdraw`, portal
`/wallet/payouts/withdraw`) or an LNURL-pay invoice fetched for a registered Lightning address
(`runAutoPayouts`, every `PAYOUT_AUTO_INTERVAL_MS` = 6 h once payable >= `PAYOUT_AUTO_MIN_SATS` =
10k). Guards: per-payout, per-account and global 24 h caps, a kill switch, and node reconciliation
that pauses payouts on a mismatch (`src/economy/payout-safeguards.ts`,
`src/economy/payout-reconcile.ts`). A solvency cap stops the node promising more than it received
from purchases minus a 2 % reserve (`payoutCapacityMsat`).

### 1.4 The fee pool

`network:fee_pool` collects the network fee on every accrual and the coordinator fee on every
purchase. Every `FEE_POOL_DISTRIBUTION_MS` (24 h) it is split across infrastructure hosts by
attested uptime (`distributeFeePool`), as `earn` rows with msat that hosts withdraw like anyone
else.

### 1.5 Receipts

Each accrual gets a two-party `WorkReceipt` (agent claim plus coordinator countersignature over
credits, msat and price) that is Merkle-batched into hourly epochs and optionally anchored on chain
([receipts-and-trust.md](../receipts-and-trust.md)). A receipt proves what was credited. It does
not prove the credit was paid.

### 1.6 Where value sits

| Stage | Who holds the sats | Trust required | Failure modes |
|---|---|---|---|
| Purchase settled, balance unspent | Coordinator's node (hot wallet) | Buyer trusts the coordinator fully, with no time limit | Node loss or theft; operator exit; balance stranded if the account is lost |
| Set aside for a job or lease | Coordinator | Same | Refund failure leaves cSats stuck (retried with a deterministic tx id) |
| Earned, not yet paid out | Coordinator | Provider trusts the coordinator until payout (6 h, or until 10k sats) | Node insolvent against liabilities (`liability_shortfall` is an alert only) |
| Fee pool | Coordinator | Hosts trust the coordinator for up to a day | Same |
| Payout in flight | Lightning HTLC | Nothing beyond Lightning | Stuck HTLC; ambiguous transport error (left pending, reconciled) |

The coordinator is custodian of every sat in the system from purchase to payout.

---

## 2. Problems with today's model

1. **cSats change hands.** Buyer cSats are spent and become provider cSats, BLE sync moves cSats
   between accounts directly, and refunds come back as cSats rather than sats. The principle
   forbids exactly this.
2. **Two balances that do not reconcile.** The cSat balance is `Σ earn credits − Σ spend credits`
   (`BALANCE_CHECK_SQL`, `src/db/postgres.ts`). Payable sats are `Σ earn msat − Σ payouts`
   (`PostgresStore.earnedMsat`). Spend rows carry no msat, and payouts write no spend row. Reading
   the code, a provider who earns 10k cSats can spend them on compute *and* withdraw the same 10k
   sats; after withdrawing, the cSat balance still shows them. The global solvency cap limits what
   the node pays out in total, but other users' deposits absorb the difference. This needs a test
   to confirm it, and a fix in Phase 0 whatever happens to the rest of this design.
3. **Long-lived custody.** Prepaid balances have no expiry and no cap. Earnings wait up to 6 h, or
   until they reach 10k sats.
4. **Refund-as-credit.** Unused reservation time and job budgets return as cSats. Money that came
   in as sats never goes back out as sats.
5. **Naming drift.** The portal calls cSats "centi-sats" (`src/portal/pages/settings.ts`), but the
   pricing code defines 1 cSat = 1 sat (`src/economy/job-pricing.ts`). The display unit should be
   defined in one place.
6. **Issuance tokens.** `issuance_allocations` records a token pool that redeems for nothing
   ([economy-math.md](../economy-math.md) section 4). It does no harm today, but it is one more
   unit that could be mistaken for value.

---

## 3. Constraints that shape the design

### 3.1 Payment sizes are tiny

At BTC = $100k, 1 sat = $0.001. From the current price tables (`TOKEN_PRICE_USD_PER_M`,
`POWER_FLOOR_USD_PER_HOUR`, `src/economy/compute-classes.ts`):

| Work | Cost |
|---|---|
| 8B model chat call, 500 in + 500 out tokens | ~0.07 sat (70 msat) |
| Same call's power floor, 10 s on a GPU | ~0.14 sat |
| CPU, base tier, 1 hour | 20 sats |
| RTX 4090-class GPU (weight 3.5), 1 hour | 350 sats |
| Data-centre GPU base tier, 1 hour | 700 sats |
| 24 h lease, 4090-class | ~8,400 sats |

Lightning carries msat. In practice, though, many wallets will not send less than 1 sat, routing
base fees are often 0 to 1 sat, and every payment adds a round trip and a chance of failure.
**One Lightning payment per request does not work for inference.** Charges have to be
aggregated, either in time (a settlement window) or in amount (a budget paid once and drawn down).

### 3.2 Hold invoices settle all or nothing

A hold (HODL) invoice locks the payer's HTLC until the receiver settles it (reveals the preimage)
or cancels it. **It cannot be partially settled.** So "settle for the time used, cancel the rest"
needs one of two approaches:

- **Tranches:** several smaller hold invoices. Settle the used ones and cancel the rest. The
  granularity is one tranche.
- **Settle in full, refund the remainder** over Lightning to the payer's return address (Lightning
  address, BOLT12 offer, or NWC `make_invoice`). The coordinator holds the remainder for seconds.

Hold time is limited too. Every hop on the route has an HTLC slot and liquidity locked, and the
receiver must settle or cancel well before the CLTV expiry or risk a force close. Some wallets and
LSPs dislike long holds. A practical ceiling is about an hour per hold. Today leases run up to
24 h (`RESERVATION_MAX_MINUTES`), so a long lease cannot be one hold invoice.

### 3.3 Implementation support

| Feature | LND | CLN | Notes |
|---|---|---|---|
| Hold invoices | Native (`invoicesrpc` AddHoldInvoice / SettleInvoice / CancelInvoice) | Plugin (`holdinvoice`) | Both seeds share one node and one database, so preimages must be in Postgres for either seed to settle |
| Keysend (spontaneous payment) | Yes | Yes | No invoice and no proof of request; fine for payouts to a known node |
| BOLT12 offers | Not native (LNDK sidecar) | Native | A reusable offer is the cleanest return address and provider destination |
| LNURL-pay / Lightning address | Client side (already used in `requestLnurlInvoice`) | Same | Already in production code |
| Nostr Wallet Connect (NIP-47) | Client side, against the user's wallet | Same | The coordinator is the NWC client; the user's wallet enforces the budget |
| L402 | Aperture, or macaroons in process | In process | HTTP 402 with an invoice; the client retries with the preimage |

---

## 4. Design options

### 4.1 How requesters pay

| Option | How it works | UX | Latency | Custody | Fit |
|---|---|---|---|---|---|
| **A. Prepaid balance (today)** | Pay an invoice, then spend a balance | Best: one payment, then nothing | None per request | Full, no time limit | Violates the principle unless bounded and opt-in |
| **B. Invoice per request** | One invoice per job | Worst: a payment per call | 1 to 5 s per call | None | Unworkable for sub-sat calls; fine for large jobs |
| **C. Hold-invoice budget** | Payer locks a budget in a hold invoice; settled when the job, lease or session ends; the rest cancelled (tranches) or refunded | One payment per session or lease | One payment up front | None while held; seconds for a refund | Leases, large jobs, short sessions |
| **D. Wallet pull (NWC)** | User grants a budget-limited NWC connection; the coordinator pulls each settlement window | Connect once, then invisible | None per request; one payment per window | None (coordinator exposed to at most one window of unpaid usage) | App users and agents with NWC wallets |
| **E. L402** | Hosted API answers 402 with an invoice; client pays and retries with the preimage. Each invoice buys a block of usage | Native for agents and SDKs; poor for people | One payment per block | One block | Hosted API and MCP |
| **F. Ecash (Cashu/Fedimint)** | Payer attaches ecash tokens to each request | Good once funded | None | The mint is custodian (not the coordinator, unless it runs the mint) | Opt-in, for privacy and true micro-payments |
| **G. Pay the provider directly** | Requester pays the provider's invoice; coordinator fee paid separately | Two payments; provider must be online and reachable | Per job | None at the coordinator | Large jobs between known parties; not a default |

### 4.2 How providers are paid

| Option | How | Trade-off |
|---|---|---|
| **Payout on request (today)** | Provider posts a BOLT11 | Balance sits until they act |
| **Auto payout on a window (today, opt-in)** | LNURL-pay every 6 h once >= 10k sats | Long window, high minimum |
| **Short window, destination required (proposed)** | Every `PROVIDER_SETTLEMENT_WINDOW_MS` (e.g. 1 h) once >= `PROVIDER_PAYOUT_MIN_SATS` (e.g. 100), to a Lightning address, BOLT12 offer, or keysend to a node | More payments and routing fees; much less custody |
| **Atomic pass-through** | Provider issues an invoice; the coordinator holds the requester's HTLC on the same payment hash and settles it only after paying the provider | No custody, but only for payments large enough to route and with the provider online at settlement; a later optimisation for leases |

### 4.3 Coordinator liquidity

Options C, D and E bring sats *in*, which needs inbound capacity. Provider payouts send sats
*out*, which needs outbound capacity. The float is about one settlement window of network
earnings. Today's model needs outbound capacity for all earnings while inbound piles up with no
limit. With short windows the node needs balanced channels and an LSP, or periodic loop-out or
splicing, to rebalance. The hot wallet can be smaller than today because liabilities are shorter.

### 4.4 Failure modes compared

| Failure | Prepaid (today) | Hold invoice | NWC pull | L402 |
|---|---|---|---|---|
| Payer's wallet offline | Not an issue | Can't start a new session | Pull fails; jobs stop after one window | Next block can't be bought |
| Route fails on pay-in | One retry at purchase | Session doesn't start | Retry next window; stop after repeated failures | Client retries |
| Coordinator crashes mid-session | Balance safe in the database | Held HTLCs must be settled or cancelled before expiry, so a durable sweeper is needed | Loses at most one window of unpulled usage | Unused block is owed (small) |
| Provider can't be paid | Accrues | Accrues (owed sats, capped) | Same | Same |
| Overcharge risk | Coordinator error | Bounded by the budget | Bounded by the NWC budget, enforced in the user's wallet | Bounded by the block size |

---

## 5. Recommendation

### 5.1 Principles applied

1. **One ledger, in msat.** cSats become a display unit only: `cSats = msat / 1000`, defined in one
   module and labelled "cSats" everywhere. No balance is held in cSats.
2. **Every economic row reconciles to sats.** Each ledger row carries `msat` (not null) and points
   at a Lightning payment (`payment_hash`) or a settlement batch whose rows sum to one. A nightly
   check proves `Σ ledger = Σ node payments in − Σ node payments out` per window.
3. **No transfers between accounts.** A requester's money goes to a settlement, and the settlement
   pays providers and the fee pool. Nothing moves between user accounts inside the ledger.
4. **Custody is short, bounded and visible.** Anything the coordinator holds for someone has a cap
   and a deadline, and the UI says so.

### 5.2 Requester payments

| Surface | Default method | Fallback |
|---|---|---|
| Desktop app, iOS app, portal chat | **Embedded self-custodial wallet with a signed spending contract** (NWC pulls, 5.7) | An external NWC wallet under the same contract; hold-invoice session budget (scan once per session) |
| Reservations (leases) | **Hold invoice** when the lease is 60 min or less; longer leases are **NWC pulls every 10 min**, and the lease ends when a pull fails | Prepaid |
| Large code jobs | **Hold invoice** for the worst-case reserve (`reserveMsat`), settled, then the remainder refunded | NWC |
| Hosted API (`src/inference-api`) | **L402**: the 402 carries an invoice for a block (e.g. 1,000 sats), and the macaroon is the API credential until the block is used up | NWC bound to the API key; prepaid |
| MCP agents | **L402** or **NWC** (the agent supplies its own connection string) | Hold invoice |

**Settlement window for metered use.** Usage accrues to an open `settlement` for the payer. It is
charged when it reaches `SETTLEMENT_BATCH_MIN_MSAT` (e.g. 21 sats) or when `SETTLEMENT_WINDOW_MS`
passes (e.g. 60 s for NWC). The coordinator never extends more than one window of unpaid usage. A
failed pull stops new jobs for that payer until a pull succeeds.

**Reservations with a hold invoice, step by step.**

1. Lease request: the coordinator generates a preimage, stores it encrypted, creates a hold
   invoice for `reservationPriceMsat` and returns it. The lease is not active yet.
2. The payer's HTLC arrives (state `ACCEPTED`): the lease starts and the agent is held.
3. The lease ends: `reservationUsage` gives the used amount and the remainder.
   - Remainder below `REFUND_MIN_MSAT`: settle in full. The remainder is kept as a capped sat
     "change" row (see 5.5), or goes to the fee pool if the user opted in.
   - Remainder above it, and the payer has a return address: settle in full, pay the remainder back
     at once, and link both payment hashes.
   - No return address: the lease was bought in tranches (e.g. 4 x 15 min). Settle the used
     tranches and cancel the rest. The unused part of the current tranche becomes change.
4. A durable sweeper (state in Postgres) cancels any `ACCEPTED` hold whose lease never started, and
   settles or cancels every hold at least `HOLD_SAFETY_BLOCKS` before its CLTV expiry.

This replaces `spendCredits(..., "compute_reservation")` and `grantCreditsIdempotent(...,
"reservation_refund:*")`. Job budgets (`inference_reserve` / `task_submit_refund`) follow the same
pattern when they use a hold invoice.

### 5.3 Provider payouts

- A payout destination is **required** to earn: a Lightning address, a BOLT12 offer, or a node
  pubkey for keysend. `PayoutService.withdraw`, with its caps, pause switch and reconciliation,
  stays the single path out.
- `runAutoPayouts` becomes the default. It runs every `PROVIDER_SETTLEMENT_WINDOW_MS` (proposed
  1 h) once owed >= `PROVIDER_PAYOUT_MIN_SATS` (proposed 100 sats). The routing fee stays capped by
  `PAYOUT_MAX_FEE_BPS` and `PAYOUT_MIN_FEE_FLOOR_SATS` and is paid by the provider, as today.
- Earnings are **owed sats**, not spendable credits. A provider who also uses compute pays for it
  like any other requester. (Netting earnings against usage is open question 10.4.)
- If payouts keep failing, owed sats accrue up to `PROVIDER_OWED_CAP_SATS`. Above that the agent
  gets no more paid work until it has a working destination.
- Later: atomic pass-through for leases (4.2), so the coordinator never holds provider money.

### 5.4 Fees

- **The network fee is 5 %** (`NETWORK_FEE_BPS` = 500, decision D3). It is taken **in sats at
  settlement**: a settlement's lines split into provider msat and fee msat, as `splitJobCost` does
  now.
- **Why the 1.5 % purchase fee goes away.** Today `COORDINATOR_FEE_BPS` (150) is charged when sats
  are converted into cSats (`createPaymentIntent`). With no cSat purchase step, there is nothing
  for it to apply to. That leaves two choices:
  - **drop it:** the payer pays 5 % in total; or
  - **keep it as a 1.5 % fee on each pull or settlement:** the payer pays 6.5 % in total
    (5 % network + 1.5 %).
- **Recommendation: 5 % all-in.** The payer covers routing fees on their own pulls (their wallet
  pays the route to the coordinator). The network fee covers routing fees on provider payouts, so
  providers receive their full share. Today providers pay payout routing out of their balance;
  under this recommendation the fee pool pays it. **Open for the owner to confirm** (10.3).
- The fee pool stays an msat account. It is distributed to hosts in sats every 24 h through the
  same payout path (hosts already need a Lightning address).

### 5.5 Prepaid balance and change

**Decision D2: no decision yet; leaning toward removal.** The self-custodial embedded wallet (5.7)
gives the convenience of a prepaid balance (fund once, then nothing per request) without the
coordinator holding the funds. If removed, `/account/buy` is retired after the cut-over and the
coordinator holds only change (below). If kept:

- Off by default for new accounts (`PREPAID_BALANCE_ENABLED`). When on, the balance is a **sat
  balance held by the coordinator**, shown that way ("held for you by this coordinator"), capped
  (`PREPAID_MAX_SATS`, e.g. 50,000), and refundable to a return address on request.
- "Change" left over from hold settlements uses the same mechanism with a lower cap (e.g. 1,000
  sats) and is spent first on the next charge.
- Neither can be transferred between accounts.

### 5.6 Ecash (later, opt-in)

Accept Cashu tokens per request (NUT-18 payment requests, or a header) from a mint the user picks
from an allowlist. The coordinator swaps the tokens at the mint at once, then melts them to
Lightning on its settlement window. The coordinator should **not** run a mint itself, because that
would make it a custodian again. Fedimint is similar, with a federation as custodian. Research
first; no code before Phase 5.

### 5.7 The embedded wallet and spending contract (default)

Decision D1. The local app (desktop on Tauri, with a Rust backend in `desktop/src-tauri`; iOS)
ships a self-custodial bitcoin wallet. The user holds the keys and funds it over Lightning or on
chain. A **spending contract**, signed by the user's key and the coordinator's key, authorises the
network to pull from the wallet automatically within fixed limits. The wallet acts as an NWC
(NIP-47) wallet service and the coordinator as the NWC client, so the transport is standard
budgeted NWC. The signed contract is an EdgeCoder layer on top: NIP-47 budgets are wallet-side
settings, not a two-party agreement.

#### How it flows

1. **Set up.** The app creates the wallet: a seed in the OS keychain (macOS Keychain, Windows
   Credential Manager, iOS Keychain), with a backup phrase shown once. It derives two keys from the
   seed: a **contract key** (secp256k1, BIP-340) and an **NWC wallet-service key**.
2. **Fund.** The user receives over Lightning (an invoice from the wallet) or on chain (an address
   from the wallet), see "Funding" below.
3. **Agree.** The user picks limits in the app (presets such as "light", "daily coding", "heavy",
   or custom). The app asks the coordinator for a contract offer. The coordinator fills its fields
   and signs; the user reviews and signs. Both keep the contract. The app creates an NWC connection
   whose client key is the coordinator's and whose NIP-47 budget matches the contract.
4. **Pull.** Each settlement window (5.2) the coordinator issues a BOLT11 invoice from its node
   for the window's usage and sends an NWC `pay_invoice` request that names the contract and the
   settlement. The wallet checks the request against the contract (below) and pays. The preimage
   goes back over NWC and is recorded on the settlement.
5. **Top up.** When the balance falls below the top-up threshold, the wallet notifies the user
   (OS notification and in-app banner, with a suggested amount) and tells the coordinator through
   an NWC notification, so the coordinator can warn before jobs stop.
6. **End.** The contract expires, either side revokes it, or a new contract supersedes it.

#### Contract fields

Canonical JSON with sorted keys and no whitespace, the same canonicalisation as work receipts
(`src/receipts/`).

| Field | Meaning |
|---|---|
| `v` | Contract format version (1) |
| `contractId` | sha256 of the canonical body without signatures |
| `network` | `bitcoin`, `signet`, `regtest`; must match the coordinator's `BITCOIN_NETWORK` |
| `accountId` | The EdgeCoder account the usage belongs to |
| `userPubkey` | User's contract key (x-only, hex) |
| `coordinatorPubkey` | Coordinator's contract key (x-only, hex). Coordinators sign with Ed25519 today (`COORDINATOR_PRIVATE_KEY_PEM`), so they need a secp256k1 key as well; it is published next to the Ed25519 key so peers can pin it |
| `coordinatorNwcClientPubkey` | The only NWC client key allowed to send pull requests |
| `walletServicePubkey`, `relays[]` | Where the wallet listens for NWC requests |
| `payeeNodeIds[]` | Lightning node ids whose invoices the wallet will pay (the coordinator's node or nodes). An invoice to any other node is refused |
| `intervalSeconds` | Length of a budget interval (e.g. 3,600) |
| `maxPerIntervalMsat` | Most the coordinator may pull in one interval (rolling) |
| `maxPerPullMsat` | Most one pull may take |
| `minPullMsat` | Smallest pull (e.g. 21 sats), so routing stays economical |
| `maxTotalMsat` | Most the contract may pull over its lifetime (optional) |
| `topUpThresholdMsat` | Balance at which the wallet asks for a top-up |
| `topUpSuggestedMsat` | Amount the prompt suggests |
| `maxRatePolicy` | Price ceiling the user accepted: network fee bps (500) and max msat per credit per class, so a pull for work priced above it is refused |
| `notBefore`, `expiresAt` | Validity window (e.g. 90 days, renewable) |
| `finalSettlementGraceSeconds` | After revocation or expiry, how long one final pull for usage accrued *before* the cut-off is still honoured (e.g. 600) |
| `supersedes` | `contractId` this contract replaces, if any |
| `nonce`, `createdAt` | Uniqueness and audit |
| `sigUser`, `sigCoordinator` | BIP-340 Schnorr signatures over `contractId` |

#### Signatures

- The coordinator signs first (an offer), then the user signs (acceptance). A contract is valid
  only with both signatures and a correct `contractId`.
- Each pull request carries `contractId`, `settlementId` and the invoice. The invoice's
  description hash commits to `{contractId, settlementId, amountMsat}`. The NWC request itself is
  signed by `coordinatorNwcClientPubkey`, as NIP-47 requires.
- The wallet keeps a local log of every pull (contract, settlement, amount, payment hash,
  preimage). The user can check it against the coordinator's signed settlement records and receipts
  (6.4).

#### Enforcement in the wallet (authoritative)

The wallet holds the money, so its checks are the ones that bind. It pays a pull only if all of
these hold:

- the contract is signed by both sides, inside `notBefore`/`expiresAt`, not revoked, not
  superseded, and its `network` matches the invoice;
- the request comes from `coordinatorNwcClientPubkey` and names this `contractId`;
- the invoice's payee is in `payeeNodeIds`, it is unexpired, and its description hash matches the
  committed fields;
- the amount is between `minPullMsat` and `maxPerPullMsat`, the rolling interval total stays within
  `maxPerIntervalMsat`, and the lifetime total stays within `maxTotalMsat`;
- the `settlementId` has not been paid before (no double pulls);
- the balance covers the amount plus the routing fee cap.

A refused pull returns a NIP-47 error with a reason code (`budget_exceeded`, `expired`, `revoked`,
`payee_not_allowed`, `insufficient_balance`, ...). A pull that would cross `topUpThresholdMsat`
still pays, then triggers the top-up prompt.

#### Enforcement at the coordinator

- It pulls only for accrued settlement lines: never ahead of usage, never more than the contract
  allows.
- Before accepting a job it checks the payer's remaining headroom (interval budget left, and the
  balance hint from the last pull or `get_balance` if the user allowed it). Unpaid exposure stays
  within one settlement window.
- A failed or refused pull stops new jobs for that account until a pull succeeds, the user tops up
  or a new contract is signed. Running jobs finish, and their cost goes into the next pull.
- Every pull is a `settlements` row with `method = nwc_contract`, `contract_id`, payment hash and
  preimage.
- Contracts are stored in a `spending_contracts` table (6.1) and verified on load; a contract
  whose signatures fail is ignored and alerted on.

#### Revocation

- **User:** in the app, "Stop automatic payments". The wallet signs `{contractId, revokedAt}` and
  stops honouring the contract at once (except one final pull within
  `finalSettlementGraceSeconds` for usage before `revokedAt`, capped at `maxPerPullMsat`). It also
  deletes the NWC connection and sends the revocation to the coordinator. Because the wallet
  enforces it locally, revocation works even if the coordinator is unreachable.
- **Coordinator:** signs the same structure to end service (e.g. a price change outside
  `maxRatePolicy`, or abuse). It stops pulling and stops accepting jobs under that contract.
- **Expiry and supersession:** no action needed. A new contract with `supersedes` replaces the old
  one once both signatures are in place.

#### Embedded wallet options

| Option | Model | Lightning receive | On-chain receive | Fit and trade-offs |
|---|---|---|---|---|
| **Breez SDK (Spark)** | Self-custodial over Spark (a statechain-style layer). The user holds keys; operators must not collude (1-of-n honest assumption); unilateral exit to chain | Yes, no channels to manage | Yes (deposit address, claimed into the wallet) | Rust core with Swift, Kotlin and WASM bindings, so it fits `src-tauri` and iOS. Simplest UX and no liquidity management. Depends on the Spark operator set and a younger protocol |
| **LDK Node** | A full Lightning node in the app, with an on-chain wallet (BDK) | Yes, through an LSP (LSPS2 just-in-time channels; first receive pays a channel fee) | Yes (built-in wallet; splice or open a channel to use it on Lightning) | Rust, fits `src-tauri`; Swift bindings for iOS. Most sovereign, no third-party trust beyond the LSP for liquidity. Channel and backup management, a larger app, and the app must be online to pay |
| **Breez SDK (Liquid)** | Swaps through the Liquid sidechain | Yes (swap) | Yes (swap) | Federation trust and swap fees; not preferred now that Spark exists |
| **Bring your own NWC wallet** (e.g. Alby Hub, other NWC wallets) | The user's own wallet | Theirs | Theirs | Same contract, but EdgeCoder can't verify the wallet enforces it beyond its NIP-47 budget. Supported, labelled "your wallet enforces the budget" |

**Recommendation:** ship Breez SDK (Spark) first for its simpler UX and on-chain receive without
channels. Offer LDK Node later as an "advanced, fully sovereign" option behind the same wallet
interface in `src-tauri`, and support bring-your-own NWC from the start. The SDK versions and the
current trust model of each option need checking at build time; this table reflects the design
as understood now.

#### Funding

- **Lightning:** the wallet shows an invoice or a reusable Lightning address/BOLT12 offer.
  Spendable once received (on LDK Node, the first receive may open a JIT channel for a fee).
- **On chain:** the wallet shows a fresh address (BIP-84, or the SDK's deposit address). Funds
  become spendable after `ONCHAIN_MIN_CONFIRMATIONS` (proposed 1 below 100k sats, 3 above),
  then are claimed (Spark) or spliced or opened into a channel (LDK Node). On-chain fees make
  small deposits uneconomic, so the app suggests a minimum (e.g. 20,000 sats) and shows the
  expected fee before the user sends.
- The coordinator never sees funding transactions; it only sees pulls.

#### Limits of this design

- **The wallet must be online to pay.** Desktop and iOS usage happens with the app open, so this
  usually holds. The hosted API used from another machine while the app is closed cannot be
  pulled; those requests fall back to L402 or to a hold invoice.
- **Coordinator exposure** is at most one settlement window per account, the same as any pull
  model.
- **Fallback:** a wallet that can't run the contract (no NWC, or not online) uses hold-invoice
  sessions (5.2).

---

## 6. Data model and API changes

### 6.1 Tables

New:

| Table | Purpose | Key fields |
|---|---|---|
| `settlements` | One charge to one payer: a session, lease, job budget, L402 block or metered window | `settlement_id`, `payer_account_id`, `kind` (`metered`, `lease`, `job`, `l402_block`, `prepaid`), `method` (`nwc_contract`, `nwc`, `hold_invoice`, `l402`, `prepaid`, `ecash`), `contract_id`, `payment_hash`, `bolt11`, `preimage_enc` (hold only), `amount_msat`, `settled_msat`, `cancelled_msat`, `refund_msat`, `refund_payment_hash`, `status` (`open`, `held`, `settled`, `cancelled`, `refunded`, `failed`), `cltv_expiry_height`, `expires_at_ms`, `network`, timestamps |
| `settlement_lines` | What a settlement paid for | `line_id`, `settlement_id`, `task_id`, `subtask_id`, `reservation_id`, `receipt_id`, `provider_account_id`, `cost_msat`, `provider_msat`, `fee_msat`, `pricing_basis` |
| `payment_methods` | How an account pays and is paid | `account_id`, `kind` (`nwc`, `lightning_address`, `bolt12_offer`, `node_pubkey`), `uri_enc` (NWC secret, encrypted at rest), `budget_msat`, `budget_period`, `role` (`pay`, `receive`, `both`), `verified_at_ms` |
| `spending_contracts` | Signed contracts (5.7) | `contract_id`, `account_id`, `user_pubkey`, `coordinator_pubkey`, `body_json` (canonical), `sig_user`, `sig_coordinator`, `status` (`active`, `revoked`, `expired`, `superseded`), `revocation_json`, `pulled_total_msat`, `not_before_ms`, `expires_at_ms` |
| `payout_lines` | Which owed lines a payout covered | `payout_id`, `line_id` |
| `hold_invoice_watch` | Durable sweeper state | `payment_hash`, `deadline_height`, `action` (`settle`, `cancel`), `attempts` |

Changed:

| Table | Change |
|---|---|
| `credit_transactions` | `msat` becomes NOT NULL (backfilled; rows without a sat value are migrated or dropped, see 7.3). Add `settlement_id` and `payment_hash`. Spends must carry `msat`. `reason` stays for history. Longer term, replace the table with a double-entry `ledger_entries (entry_id, debit_account, credit_account, msat, ref_type, ref_id)` so every movement balances |
| `payment_intents` | Kept for opt-in prepaid only; add `purpose` |
| `compute_reservations` | `record_json` gains `settlementId`, `holdState`, `tranches[]` |
| `work_receipts` | Add `settlement_id`, `cost_msat`, `fee_msat`; receipt v2 (6.4) |
| `payouts` | Add `destination_kind`; otherwise unchanged |

Retired: BLE credit transfers (`ble_synced_tx`, `applyBleTransfer`) become offline *receipts*,
settled later in sats through a normal settlement (the requester pays, the provider is paid).
`issuance_allocations` is frozen or removed (open question 10.7).

### 6.2 Lightning provider interface

Additions to `LightningProvider` (`src/economy/lightning.ts`), implemented for LND, CLN (plugin)
and the mock provider:

- `createHoldInvoice({ paymentHash, amountMsat, expirySeconds, cltvExpiryDelta, memo })`
- `settleHoldInvoice(preimage)`, `cancelHoldInvoice(paymentHash)`
- `lookupInvoice(paymentHash)`, returning `OPEN | ACCEPTED | SETTLED | CANCELED` with the expiry
  height of the accepted HTLCs
- `payOffer(offer, amountMsat)` (CLN), `keysend(pubkey, amountMsat)`

New module `src/economy/nwc.ts`: a NIP-47 client (`pay_invoice`, `make_invoice`, `get_budget`),
relay connection, budget checks and error mapping. New module `src/economy/l402.ts`: macaroon
minting with caveats (account, block size, expiry) and preimage verification.

Reconciliation (`payout-reconcile.ts`) extends to inbound payments. Settled invoices on the node
must match `settlements` rows, held HTLCs must match `held` rows, and an unknown inbound settlement
raises an alert.

### 6.3 API changes

| Surface | Today | Proposed |
|---|---|---|
| Coordinator `/account/buy`, `/account/intent` | Buy cSats | Behind `PREPAID_BALANCE_ENABLED`; renamed `/account/prepay` (old path kept as an alias for one release) |
| Coordinator `/account/payment-methods` (new) | – | `POST` connects NWC or sets a Lightning address or offer; `GET` lists; `DELETE` revokes |
| Coordinator `/inference/submit` | Debits the reserve, or 402 `insufficient_credits` | Attaches to the payer's open metered settlement; 402 `payment_required` with `{ method, invoice?, settlementId }` when there is no method and no budget |
| Coordinator `/account/reservations` | Debits cSats | Returns `{ reservation, invoice, settlementId }`; the lease starts when the HTLC is accepted. `/cancel` settles the used part and cancels or refunds the rest |
| Coordinator `/account/settlements` (new) | – | Lists settlements with lines, payment hashes and refund hashes |
| Coordinator `/account/contracts` (new) | – | `POST /offer` returns a coordinator-signed contract for the requested limits; `POST /accept` stores the user-signed contract and the NWC connection details; `POST /revoke` takes a signed revocation; `GET` lists contracts with pulled totals |
| Coordinator `/economy/payouts/*` | Withdraw / address | Same routes; an address is required to earn; auto payout is the default |
| Coordinator `/credits/ble-sync` | Transfers cSats | Accepts offline receipts; no transfers |
| Portal (`src/portal/routes/wallet.ts`, `payouts.ts`, `pages/settings.ts`) | "Buy cSats", cSat balance | "Connect wallet" (NWC), payout destination, settlement history in sats with hashes; a balance only if prepaid is on |
| Desktop (`desktop/src/lib/api.ts`, `desktop/src-tauri`, `/v1/ide/compute/buy`) | Buy flow | Embedded wallet in the Rust backend (create, back up, fund by Lightning or on chain, balance); contract review, signing and revocation screens; top-up prompts; pull log; live session spend; a 402 shows an invoice |
| iOS (`ios/`) | – | Same wallet and contract flow through the SDK's Swift bindings |
| Hosted API (`src/inference-api/routes.ts`) | API key; 402 `billing_error` when out of credits | L402: `402` with `WWW-Authenticate: L402 macaroon="…", invoice="…"`, accepting `Authorization: L402 <macaroon>:<preimage>`. Existing API keys can bind an NWC method instead |
| MCP server (planned, ROADMAP) | – | `quote`, `reserve`, `run` and `usage` use L402 or NWC; `top_up` becomes `connect_wallet` / `pay_invoice` |

### 6.4 Receipts tie payments to work

Receipt v2 adds `settlementId`, `costMsat`, `feeMsat` and `providerMsat` inside the
coordinator-signed body. The coordinator also publishes a **settlement record** for each
settlement:

```
{ settlementId, payerPaymentHash, amountMsat, refundPaymentHash?, lines: [receiptId, ...],
  payoutHashes: [providerPayoutPaymentHash, ...] }
```

The record is signed by the coordinator and goes into the hourly epoch as leaves alongside the
receipts (same Merkle tree and anchoring path, `src/receipts/`). Anyone holding a receipt and the
payer's or provider's preimage can then show four things: the work was done, it cost this much,
this Lightning payment paid for it, and this payout passed it on. That closes the gap
receipts-and-trust.md notes (a receipt does not prove "that the credits were later paid out").

---

## 7. Migration plan

Every phase runs on regtest first (`deploy/lnd-test`), behind flags. Each phase can be reversed
until Phase 4.

### 7.1 Flags

| Flag | Default | Meaning |
|---|---|---|
| `SETTLEMENT_MODE` | `ledger` | `ledger` (today); `shadow` (today's behaviour, plus settlement rows computed and compared, nothing charged); `sats` (new flows) |
| `HOLD_INVOICES_ENABLED` | false | Leases and job budgets via hold invoices |
| `NWC_ENABLED` | false | Wallet pull |
| `SPENDING_CONTRACTS_ENABLED` | false | Signed contracts and embedded-wallet pulls (5.7) |
| `ONCHAIN_MIN_CONFIRMATIONS` (app side) | 1 below 100k sats, 3 above | When on-chain deposits become spendable in the embedded wallet |
| `L402_ENABLED` | false | Hosted API and MCP |
| `PREPAID_BALANCE_ENABLED` | true now; false for new accounts from Phase 4 | Opt-in prepaid |
| `BLE_CREDIT_TRANSFER_ENABLED` | false from Phase 0 | Old BLE transfers |
| `PROVIDER_SETTLEMENT_WINDOW_MS`, `PROVIDER_PAYOUT_MIN_SATS`, `PROVIDER_OWED_CAP_SATS` | 1 h, 100, 50,000 | Provider side |
| `SETTLEMENT_WINDOW_MS`, `SETTLEMENT_BATCH_MIN_MSAT`, `REFUND_MIN_MSAT`, `HOLD_MAX_SECONDS`, `HOLD_SAFETY_BLOCKS` | 60 s, 21,000, 10,000, 3,600, 12 | Payer side |
| `SETTLEMENT_MAINNET_APPROVED` | unset | See section 8 |

### 7.2 Phases

| Phase | What | Exit criteria |
|---|---|---|
| **0. Fix and measure** | Spend rows carry msat; payouts write a matching ledger row; one balance function used everywhere; a test for the double count in section 2; BLE transfers off; one definition of cSats (fix "centi-sats"); `settlements` and `settlement_lines` tables; `SETTLEMENT_MODE=shadow` | Over a week of regtest traffic, shadow settlements match today's charges to the msat, and ledger-vs-node reconciliation is clean |
| **1. Providers paid in sats** | Destination required to earn; hourly auto payout by default; earnings no longer spendable as credits; owed cap | On regtest, every earn row is covered by a payout line within one window; reconciliation clean |
| **2. Hold invoices** | Provider interface additions, durable sweeper, leases and job budgets via hold invoices, refunds to a return address, tranches when there is none | Regtest e2e: a lease paid, used, cancelled early and refunded; the coordinator restarted mid-lease; an HTLC near expiry handled; the second seed settles a hold the first one created |
| **3. Embedded wallet, contracts, L402** | Embedded wallet in desktop and iOS (Breez SDK Spark first); spending contracts (offer, sign, enforce, revoke); NWC client and budgets; metered settlements; on-chain funding; L402 on the hosted API; bring-your-own NWC; MCP uses the same paths | Regtest e2e: wallet funded by Lightning and on chain, contract signed, pulls within limits paid, pulls over limits refused by the wallet, revocation honoured while the coordinator is offline, top-up prompt fires; an L402 client works; failed pulls stop work within one window |
| **4. Cut over** | `SETTLEMENT_MODE=sats` on the seeds; prepaid removed, or opt-in only if the owner keeps it (D2); `/account/buy` aliased; old cSat balances migrated (7.3) | A week of regtest traffic with no cSat-to-cSat movement in the ledger, and every row has `msat` plus a payment or settlement reference |
| **5. Ecash (opt-in)** | Cashu acceptance from allowlisted mints | Separate review |
| **6. Mainnet** | Section 8 | Owner sign-off |

### 7.3 Existing balances

- **Regtest (every balance today).** The seeds run `BITCOIN_NETWORK=regtest`. Every purchase, earn
  row (including `regtest_e2e_test`) and refund is worthless test money. Before Phase 4, export a
  snapshot for the record, then truncate `credit_transactions`, `payment_intents`, `payouts`,
  `compute_reservations`, `usage_records` and the fee-pool rows. Receipts and epochs can stay
  (they prove work, not money), but their `msat` fields are marked as regtest in the export.
- **Mainnet.** The ops notes say no mainnet balances exist; the owner should confirm. If any are
  created before cutover:
  - provider earnings are paid out in sats in the first window after cutover. A destination is
    required; owed sats nobody claims stay claimable for a set period (open question 10.6);
  - buyer prepaid balances stay as an opt-in prepaid sat balance (spent first), or are refunded to
    a return address on request. They are never converted into anything else;
  - the fee pool is distributed once under the old rules, then starts again in sats.

### 7.4 Testing on regtest

- Extend `deploy/lnd-test` with a third LND (the requester's wallet) and a CLN node (BOLT12 and the
  hold-invoice plugin), plus a local Nostr relay and an NWC service for NIP-47.
- Extend `deploy/lnd-test/e2e-payout.sh` into an `e2e-settlement.sh` that runs the flows end to end
  without a purchase: connect NWC, run a chat, the pull settles, the provider is paid within the
  window, the fee pool splits.
- Unit tests with the mock provider for every hold state transition, tranche maths, refund
  thresholds, settlement batching, owed caps, and the receipt v2 and settlement-record signatures.
- Failure injection: route failure on a pull, wallet budget used up, provider destination down,
  coordinator restart with held HTLCs, both seeds racing to settle one hold, clock skew around CLTV
  deadlines, reconciliation with an unknown inbound payment.
- Property test: for any sequence of operations, `Σ ledger msat = Σ node in − Σ node out`, and no
  row moves value between two user accounts.

---

## 8. Mainnet gate

Nothing in this design runs on `BITCOIN_NETWORK=bitcoin` until all of the following hold:

1. **Owner sign-off, recorded.** The owner approves this design (and any changes made in review) in
   writing on the PR, and personally sets `SETTLEMENT_MAINNET_APPROVED` on the seeds. Startup
   refuses `SETTLEMENT_MODE=sats` with `BITCOIN_NETWORK=bitcoin` when it is not set.
2. Phases 0 to 4 have passed their exit criteria on regtest, and then on signet with real routing.
3. [going-to-mainnet.md](../going-to-mainnet.md) has a new "Settlement" section with every item
   checked: inbound and outbound liquidity sized for one window, alerting on the hold sweeper, NWC
   secrets encrypted with a key kept outside the database, the refund path drilled, inbound
   reconciliation clean.
4. Mainnet caps start low (per settlement, per payer per day, total held at any moment), and only
   the owner raises them.
5. **Legal sign-off (decision D4).** A legal AI agent does a first pass over this design and the
   questions in section 9. A digital-assets attorney then reviews it, starting from that first
   pass. **Mainnet is gated on the attorney's written sign-off**; the AI pass alone is not enough.
6. Only the owner funds the node and flips the network; an agent never does.

---

## 9. Regulatory and custody notes

These are high-level notes, not legal advice. Review process (decision D4): a legal AI agent
does a first pass, then a digital-assets attorney reviews, and mainnet waits for the attorney's
sign-off.

- **Embedded self-custodial wallet with a spending contract** (5.7): the user holds the keys, and
  the coordinator can only request payments the user pre-authorised. This is the strongest
  non-custodial position for the default path, but the coordinator still receives and pays on
  within a window. The attorney should also look at whether shipping wallet software, and the
  choice of SDK, carries obligations of its own.

- **Holding balances for users** (today's prepaid cSats and accrued earnings) looks like custody of
  customer funds. In many places that brings money-transmission or custodial-wallet rules: in the
  US, FinCEN MSB registration and state licences; in the EU, MiCA's rules for crypto-asset service
  providers.
- **Receiving from one party and paying another** can count as transmission even when the funds
  are held only briefly. Short windows and hold invoices cut the amount and duration of custody,
  but they may not change the classification on their own.
- **Wallet pull and hold invoices** leave funds in the user's wallet or in an HTLC until the moment
  of payment. Short of direct payments, that is the strongest non-custodial position available.
- **Atomic pass-through and direct payment to providers** are the designs that put the
  coordinator closest to a router, or to a merchant selling its own service. Counsel should say
  which structure is preferable.
- **Ecash mints are custodians.** Accepting tokens from third-party mints keeps the coordinator out
  of that role; running a mint would put it back in.
- **Paying providers** may create tax-reporting duties for the operator, depending on where
  providers are.
- Describing cSats in the terms of service as "a unit of measure, never redeemable or
  transferable" matches this design and avoids presenting them as a token.

---

## 10. Open questions for the owner

1. ~~**Default payer method.**~~ **Decided (D1):** an embedded self-custodial wallet with a
   signed spending contract over NWC; hold invoices as the fallback. Follow-ups: are the Breez SDK
   (Spark) first / LDK Node later choice and the contract presets acceptable? What default limits
   (per interval, threshold, 90-day expiry)?
2. **Prepaid balance.** *Leaning toward removal (D2)*, since the embedded wallet replaces it.
   Confirm removal, or keep it opt-in with a cap?
3. **Fees.** *5 % network fee decided (D3).* Confirm the recommendation: 5 % all-in with no 1.5 %
   settlement fee, the payer covering routing on their own pulls, and the network fee covering
   routing on provider payouts. The alternative is 6.5 % (5 % + 1.5 % on pulls/settlements).
4. **Providers who also buy.** Can a provider's owed sats be netted against their own usage (in
   sats, inside one settlement), or must every purchase be a separate Lightning payment?
5. **Windows and minimums.** Is a 1 h provider window with a 100-sat minimum, and a 60 s or 21-sat
   payer window, acceptable, or should the targets differ?
6. **Unclaimed earnings.** For providers without a working destination: how long do owed sats stay
   claimable, and where do they go after that (fee pool, or kept indefinitely)?
7. **Issuance tokens.** Freeze and remove `issuance_allocations`, or keep them as a non-monetary
   reputation score?
8. **Long leases.** Accept that leases over 60 min are paid by NWC pulls (or prepaid), or lower
   `RESERVATION_MAX_MINUTES` so a lease fits one hold invoice?
9. **Ecash.** Worth pursuing at all? If so, which mints are acceptable?
10. **Offline BLE work.** Keep offline jobs (settled later in sats, as receipts), or drop the
    feature?
11. **Coordinator node.** Stay on LND (native hold invoices, BOLT12 via LNDK), move to CLN (native
    BOLT12, hold invoices via a plugin), or run both?
12. ~~**Legal.**~~ **Decided (D4):** a legal AI agent first pass, then a digital-assets attorney;
    mainnet gated on the attorney's sign-off. Still open: is atomic pass-through worth building
    early if the attorney prefers it?
