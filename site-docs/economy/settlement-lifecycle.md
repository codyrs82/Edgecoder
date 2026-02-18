# Settlement Lifecycle

This page details the lifecycle from demand to settlement to issuance visibility.

## Lifecycle Diagram

```mermaid
flowchart LR
  demand[WorkloadDemand]
  pricing[PriceEpoch]
  intent[PaymentIntent]
  settle[SettlementEvent]
  mint[CreditMint]
  usage[UsageTracking]
  issuance[IssuanceWindow]
  history[LedgerHistory]

  demand --> pricing
  pricing --> intent
  intent --> settle
  settle --> mint
  mint --> usage
  usage --> issuance
  issuance --> history
```

## Step-by-step

1. **Demand arrives**
   - Workload requires account credit capacity.
2. **Price epoch is applied**
   - Current pricing and quote logic determine sats-credit relation.
3. **Payment intent is created**
   - Intent records pending settlement state and expiry window.
4. **Settlement confirmation**
   - BTC/LN settlement triggers confirmation path.
5. **Credit mint**
   - Settled intents mint credits for account usage.
6. **Usage tracking**
   - Runtime consumption contributes to account and contribution records.
7. **Issuance windows**
   - Rolling windows recalculate issuance allocations.
8. **Ledger visibility**
   - History and verification endpoints expose integrity checks.

## Failure and reconciliation

- Expired intents are reconciled and not minted.
- Duplicate settlement updates must be idempotent.
- Reconciliation routines normalize pending and terminal intent states.

## Related

- [Credits, Pricing, and Issuance](/economy/credits-pricing-issuance)
- [API Surfaces](/reference/api-surfaces)
