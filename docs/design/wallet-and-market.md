# Wallet and compute market: design

Status: built on branch `feat/wallet-market-redesign` (web portal, desktop app, iOS app).
Money rules are unchanged; this is presentation over the existing APIs. Formulas:
[economy-math.md](../economy-math.md). Trust model: [economy-compute-trust-model.md](../economy-compute-trust-model.md).

## Goal

A first-time user can answer three questions on one screen: **what am I paying**, **what do I
get**, and **what does the network keep**. Test sats can never be mistaken for real ones.

## Facts the screens state (never invented by the UI)

| Fact | Source | Shown as |
|---|---|---|
| 1 cSat = 1 sat | economy-math.md | "1 cSat = 1 sat" next to every balance |
| Purchase fee | `purchaseFeeBps` (COORDINATOR_FEE_BPS, 150) from `/economy/market/book` | "1.5 % purchase fee" with the sat amount. The invoice response (`feeSats`, `cSats`) is authoritative; the preview before it uses the same formula `floor(amount × bps / 10000)` |
| Network fee | `networkFeeBps` (NETWORK_FEE_BPS, 500) | "5 % of every earning funds the infrastructure hosts" |
| Price per model | `models[].cSatsPerMTokens` | cSats per million tokens in / out |
| Price per class | `classes[].cSatsPerSecondBaseTier`; order book `bestAsk/bestBid/mid`, reference, trades | cSats/s, sats/h, ≈ USD/h; matched prices are held to 0.25x to 4x of the class reference |
| BTC/USD | rate-oracle epoch `btcUsd` | "≈ $x" after sats; hidden when there is no epoch, marked when stale |
| Network | coordinator payout policy `network` (fallback: portal `WALLET_DEFAULT_NETWORK`) | Network badge, see below |
| Earnings hold | `balance.heldMsat`, `balance.maturesAtMs` (PAYOUT_EARNINGS_HOLD_MS: 24 h mainnet, 0 regtest) | "x sats held until <time>" |
| Payout limits, pause | `policy.minPayoutSats`, `maxFeeBps`, `limits`, `paused`, `lightningEnabled` | Limits line; pause banner |

## Information architecture

One **Wallet** area with three parts, the same on every surface:

1. **Balance + Add funds** (hero). Big cSats balance, "≈ $" estimate, network badge, primary
   action "Add funds", secondary "Withdraw". Under it, **Where your sats go**: a three-step
   strip (you pay → purchase fee → your cSats; then on spend: 95 % to the machine owner, 5 %
   network fee to infrastructure hosts).
2. **Earnings & withdrawals.** Four figures: Earned, Held (with matures-at), Available to
   withdraw, Paid out. Payout methods (see below). Payout history with an **Asset** column.
   "Where we pay you" (Lightning address for automatic payouts).
3. **Activity.** The credit ledger in plain words ("Bought cSats", "Earned running jobs",
   "Reserved a machine", "Unused set-aside returned") and past top-ups (paid / expired).

**Market** lives under Compute (web: Settings > Compute; desktop: Compute; iOS: a Market section
of the Wallet screen):

- **Price board**: four class cards (CPU, Apple, GPU, Datacenter GPU) with cSats/s, sats/h,
  ≈ $/h and machines online; a model table (cSats per M tokens in / out).
- **Exchange** (web only, existing): candles, depth, order book (asks/bids), trade tape,
  standing orders, hardware tiers.
- **Buy / reserve**: reserve a machine for minutes, paid up front, unused time refunded.

## Deposit flow (Add funds)

```
[Amount]  presets 5,000 · 20,000 · 100,000 · custom (100 to 1,000,000 sats)
          You pay        20,000 sats   ≈ $20.00
          Purchase fee   −   300 sats  (1.5 %)
          You get        19,700 cSats
          [Create Lightning invoice]
   ↓
[Invoice] QR (where available) · invoice text · Copy · Open in wallet (lightning:)
          "Waiting for payment" with a live dot; countdown from expiresInSeconds
          polls /topup/:intentId every 3 s
   ↓                         ↓                          ↓
[Paid]  check mark,       [Expired]  "This invoice    [Error] message + Try again
 "+19,700 cSats added",    expired. Nothing was
 fee line, new balance,    charged." Create a new
 Done                      invoice (same amount)
```

States: loading (skeleton figures), not connected (explains, Retry), payments disabled
(`payments_disabled` → "Buying cSats is turned off on this coordinator"), error, expired, paid.
Amounts always show sats and, when the oracle has a rate, ≈ USD.

## Network badge

| network | Badge | Tone |
|---|---|---|
| `bitcoin` | "Bitcoin mainnet · real sats" | accent (orange) |
| `testnet`, `signet` | "Testnet · test sats, no value" | yellow |
| `regtest` | "Regtest · test sats, no value" | yellow |

Shown in the Wallet hero, on every invoice, and in the withdraw form.

## Payout methods (owner decision, 2026-11-14)

Direction from the owner: **cSats are only a unit of measure; we transact in the underlying
coins** (PR #195, `docs/design/bitcoin-settlement.md` on `docs/bitcoin-settlement-design`). The
Earnings area is therefore designed for several payout methods and assets:

| Method | Asset | State | UI |
|---|---|---|---|
| Lightning (invoice now, or automatic to a Lightning address) | BTC | **Active today** | Enabled |
| Bitcoin on-chain, batched payouts above a minimum | BTC | Coming soon | Shown, disabled, labelled "Coming soon" |
| Litecoin on-chain, batched | LTC | Coming soon | Shown, disabled, labelled "Coming soon" |

No backend logic exists or was added for on-chain or Litecoin payouts; the two rows are UI
placeholders only. Payout history has an **Asset** column; every row today is "BTC · Lightning".

## Withdraw flow (Lightning)

Paste a BOLT11 invoice for an exact amount → "Email me a code" (POST /wallet/payouts/withdraw
returns 202 + challengeId) → enter code → paid / refused with the coordinator's reason. The
limits line states the minimum, the routing-fee cap and the per-payout / per-day caps; a paused
coordinator shows a banner and disables the form.

## Visual language

- Tokens only (`packages/tokens`): accent orange for money actions, green for credited/paid,
  yellow for test networks and holds, red for errors. Light and dark from the same tokens.
- Type: balance 40/44 px tabular numerals; section titles 13 px semibold caps-free; figures in
  the font's tabular numerals, not mono; invoices in mono.
- Motion: the waiting dot pulses and the paid check scales in; both are off under
  `prefers-reduced-motion` (iOS: `accessibilityReduceMotion`).

## Surfaces

| | Web portal | Desktop | iOS |
|---|---|---|---|
| Where | Settings > Wallet (`/portal/settings/plan`), Settings > Compute | Settings > Plan & usage (wallet), Compute | Settings > Wallet & market |
| Data | `/portal/api/wallet/overview`, `/portal/api/wallet/topup*`, `/wallet/payouts*`, market proxies | Local agent `/v1/ide/compute*` for balance and buying; portal overview for fees, rate, network, payouts | Portal endpoints over the session cookie |
| QR | **Not shown: no QR library is a dependency** (gap) | **Not shown** (same gap) | CoreImage `CIQRCodeGenerator` (system framework) |
| Layout | Two-column hero at ≥ 900 px, one column below | One column, 720 px max | Native scroll of cards |

## API gaps (kept as gaps, not built)

- **QR on web and desktop**: no QR encoder in either dependency tree. Adding one needs the
  owner's approval (for example `qrcode-generator`, MIT, no dependencies).
- **Invoice expiry time**: `/account/buy` returns `expiresInSeconds`, but `/account/intent`
  returns only `status`; after a reload the countdown cannot be restored, only the status.
- **Payment-intent history** comes from `/dashboard/summary` (`walletSnapshot.paymentIntents`)
  on the web only; there is no account-scoped list for the desktop or iOS.
- **Order book on desktop and iOS**: they show the price board; the full exchange stays on the
  web.
