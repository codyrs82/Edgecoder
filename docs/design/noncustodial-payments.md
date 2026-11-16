# Payments: prepaid spot credit + direct payments for commitments

Status: prototype on test networks (signet / Mutinynet; Zcash testnet by fixtures). Owner decisions
2026-11-16 (hybrid model). cSats stay the unit of account: **1 cSat = 1 sat** for prices, tallies
and dashboards. Value moves on **Bitcoin** (Lightning, on-chain) and **Zcash**. No other coins.

## Who holds what

| Scenario | How it is paid | Who holds the money | Default |
| --- | --- | --- | --- |
| **Spot** (on-demand calls, no reservation) | Prepaid cSats wallet: Buy cSats (Lightning; on-chain BTC behind `ONCHAIN_ENABLED`), drawn down per call | EdgeCoder holds the sats behind purchased cSats as **closed-loop prepaid credit** (below) until they are spent on compute and paid to hosts | On |
| Spot, optional | "Pay from your own wallet" (NWC tally) | The buyer, until each settlement goes straight to the host | Off (`PAYMENTS_NWC`) |
| **Reservation / block of time** | Direct: buyer → host Lightning invoice (small to medium), or on-chain BTC / Zcash | The host, from the moment it is paid. EdgeCoder holds nothing | Off (`PAYMENTS_DIRECT_RESERVATIONS`; on in tests) |
| **Server commitment** (days to months, a whole machine) | Direct, larger: on-chain BTC or Zcash | The host. EdgeCoder holds nothing | Same flag |
| EdgeCoder's 5 % network fee on direct payments | A **separate** direct payment from the buyer to EdgeCoder's own address, same rail | EdgeCoder (its own revenue) | — |

Flags (`src/economy/direct/flags.ts`): `PAYMENTS_PREPAID` (on), `PAYMENTS_DIRECT_RESERVATIONS`
(off; on under `NODE_ENV=test`), `PAYMENTS_NWC` (off). No live coordinator sets them; nothing changes
on deploy.

## 1. Spot: prepaid cSats (default)

Unchanged code path (ledger, reserve at submit, settle to the actual cost, refund the rest).

1. The buyer buys cSats with Lightning (an invoice from EdgeCoder's node) or on-chain BTC.
2. Each call reserves its worst case, settles to its priced cost (`job-pricing.ts`) and returns the
   rest. The host's 95 % accrues as earnings; 5 % is the network fee.
3. Hosts withdraw earnings (Lightning address / invoice; on-chain batches when enabled).

Failures: a failed or unverified call is not charged; its reserve returns as cSats. A host paid for
work later found bad loses it (verification, docs/economy-compute-trust-model.md).

## 2. Spot, optional: pay from your own wallet (NWC)

For buyers who prefer not to prepay. The buyer connects a wallet with **Nostr Wallet Connect**
(NIP-47) and sets a daily budget **in the wallet**. The connection string is sealed at rest
(AES-256-GCM, `NONCUSTODIAL_SECRET_KEY`) and never logged or returned.

1. Per call, the coordinator prices and splits as in 1, but debits nothing: it adds the host's share
   to the (buyer, host) tally and the fee to the (buyer, EdgeCoder) tally, in msat. A tally is a
   record of what is owed for work already served, **not a balance**.
2. A pair settles at `SETTLE_MIN_SATS` (200) or after `SETTLE_INTERVAL_MS` (1 h): the coordinator
   resolves the payee's Lightning address (LNURL-pay; amount, network, expiry and
   description-hash checked) and asks the buyer's wallet to `pay_invoice`. Whole sats move; the
   msat remainder carries over.
3. **Exposure cap**: unsettled total per buyer ≤ `MAX_UNSETTLED_SATS` (500). A call whose reserve
   would cross it is refused (`settle_first`) and settlement starts.
4. **Failure**: retry with backoff (30 s, 2 min, 8 min); a timed-out payment is looked up
   (`lookup_invoice`) before paying again, so nothing is paid twice. After `SETTLE_MAX_FAILURES`
   (3) the buyer is **paused** (no new network work; reason shown, e.g. `QUOTA_EXCEEDED`) until a
   wallet is reconnected. The host's risk is bounded by the cap.

## 3. Reservation or block of time: direct Lightning, on-chain BTC or Zcash

1. **Quote**: the buyer picks class, length and rail; the coordinator picks a host whose payout
   profile supports the rail and quotes the price in cSats: host share (95 %) + fee (5 %), whole
   sats, with an expiry (Lightning 10 min, Zcash 30 min, on-chain 60 min). The agent is held for
   the quote.
2. **Pay** (two payments, buyer → host and buyer → EdgeCoder):
   - *Lightning*: invoices resolved from the host's and EdgeCoder's Lightning addresses; the buyer
     pays them (scan, or the connected NWC wallet). Proof: both **preimages**.
   - *On-chain BTC*: to an address derived from the host's **xpub/zpub** (one per quote), or the
     host's fixed address plus the **txid**. Proof: txid + an output paying the quoted address at
     least the quoted amount with `DIRECT_PAY_ONCHAIN_MIN_CONF` confirmations (Esplora); each
     (txid, vout) pays for one thing only.
   - *Zcash*: to the host's shielded address with memo `edgecoder:r:<id>`, and the fee with
     `edgecoder:f:<id>`. Proof: notes seen through the host's **incoming viewing key**
     (read-only) on a zcashd-compatible testnet wallet (`z_importviewingkey`,
     `z_listreceivedbyaddress`), ≥ `ZCASH_MIN_CONFIRMATIONS` (3), mined before expiry.
3. **Activate**: the lease starts in the existing reservation book (`reservations.ts`) marked
   `direct`, so ending it moves no cSats. Both sides get **signed receipts** (Ed25519 over the
   rail's proof).

## 4. Server commitment

Same as 3 with on-chain BTC or Zcash only (amounts above Lightning's comfort), longer quotes, and
more confirmations as the amount grows (operator setting).

## Failure handling for direct payments (refund policy)

EdgeCoder holds nothing, so it refunds nothing; the coordinator records what it saw and shows both
sides the computed amounts.
- Paid late (after the quote expired), underpaid, or paid but the host was taken meanwhile: not
  activated. The **host refunds** the payment (less network fees) within 7 days of the buyer's
  request.
- Host goes offline during a lease: the lease ends; the **host refunds** the unused share
  (`refundMsat`, shown). Unused time otherwise is not refunded.
- A host that doesn't refund loses reputation and can be removed from direct reservations.
  EdgeCoder does not arbitrate or escrow funds.

## Counsel review: custody and regulatory notes

> **For counsel.** These notes describe intent and mechanics, not legal conclusions.

1. **Prepaid cSats are closed-loop prepaid credit.** Purchased cSats are spendable **only** on
   EdgeCoder compute. There is **no buyer cash-out**: the code allows withdrawing only *earned*
   sats, never purchased ones (`withdrawableMsat`, src/economy/payouts.ts). Service failures are
   **credited back as cSats**, not refunded in BTC. Hosts are **paid for services rendered**
   (their earnings), not for holding value. EdgeCoder does hold the purchase sats until spent;
   questions for counsel: prepaid-access / stored-value treatment, breakage, unclaimed property,
   expiry policy, and payouts to hosts (payment to service providers vs. money transmission).
2. **Direct payments are non-custodial.** For reservations, blocks and commitments the buyer pays
   the host's own address or invoice; EdgeCoder never receives, holds or forwards those funds. Its
   5 % is a separate payment to its own address for its own service. EdgeCoder's role is quoting
   prices, verifying payments read-only (preimages, public chain data, Zcash **viewing keys**,
   which cannot spend) and activating the service.
3. **NWC spot payments**: the buyer delegates **payment initiation** to the coordinator, bounded by
   a budget the buyer sets in their own wallet; funds go wallet → host directly. EdgeCoder never
   has custody, but it does *instruct* payments: counsel should confirm this is outside money
   transmission, and review the hosts' credit risk (they serve before being paid, up to the cap).
4. **Data held**: NWC connection strings (spending authority, encrypted), Zcash viewing keys
   (reveal a host's incoming shielded payments and memos to EdgeCoder: privacy disclosure needed),
   xpubs (reveal the host's address history), payment receipts.
5. **Refunds** for direct payments are between buyer and host (policy above); terms of service
   should say so plainly.

## Code

`src/economy/direct/`: `flags.ts`; `nip44.ts`, `nip04.ts` (Nostr encryption); `nwc.ts` (NIP-47
client); `lnurl-pay.ts`; `tally.ts` (NWC tally engine); `reservations-direct.ts` (quotes,
verification, activation); `onchain-direct.ts` (xpub addresses, txid + output checks);
`zcash.ts` (quotes, memos, viewing-key verifier); `receipts.ts`; `secret-box.ts`. Coordinator:
`src/swarm/coordinator/direct-payments.ts` (routes, flag-gated). Portal: `/portal/api/payments/*`
and the Wallet page sections (`src/portal/pages/wallet-direct.ts`). Signet harness:
`scripts/direct-pay/`.

Prototype limits: payout profiles, quotes, NWC connections and tallies are in memory (persisting
them needs a migration); a Zcash testnet node is needed for a live Zcash run; there is no ZEC price
oracle yet (`ZEC_USD`).
