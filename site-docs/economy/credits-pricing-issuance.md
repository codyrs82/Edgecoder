# Credits, Pricing, and Issuance

A summary of how compute is priced and paid for. The canonical, current model, with every formula,
its source file and worked examples, is
[docs/economy-math.md](https://github.com/codyrs82/Edgecoder/blob/main/docs/economy-math.md); if
this page and that one disagree, that one is right.

## Units

| Unit | What it is |
|---|---|
| **cSat** | Prepaid compute balance. **1 cSat = 1 sat.** Bought with sats, spent on model calls, jobs and reservations, earned by running them. The code still calls ledger rows "credits". |
| **sat** | Bitcoin: paid in over Lightning for cSats, paid out to hosts. |
| **credit** (order book) | A unit of work: one server-measured second on a compute class's base tier. Its price is quoted in msat per credit. |
| **token** | Issuance accounting unit from the daily pool. Recorded, not credited or paid out. |

## Who pays and who earns

- Buying cSats is free (`COORDINATOR_FEE_BPS` = 0): 1 sat buys 1 cSat.
- On every compute payment (model call, job, reservation) the host gets **95 %** and EdgeCoder keeps
  **5 %** as the network fee (`NETWORK_FEE_BPS`, default 500).
- Work on your own machines is not charged.
- Earning for other people's work needs an approved host: hosting is by request
  (`HOST_APPROVAL_REQUIRED`, on by default; apply at `/host` on the portal).
- Earned sats are paid out over Lightning; on-chain funding and payouts are behind
  `ONCHAIN_ENABLED`. See [Settlement Lifecycle](/economy/settlement-lifecycle).

## Pricing

- **Model calls: per token, by model size.** A USD price per million input and output tokens for
  each model-size band, converted to sats at the live BTC price, with a power floor per compute
  class so a host never earns less than the electricity the seconds cost.
- **Code jobs and reservations: per second, by compute class.** Four classes (`cpu`, `apple`,
  `gpu`, `gpu.dc`), each with one reference price recalibrated daily from public BTC quotes and a
  per-class USD/hour reference. Faster tiers inside a class (for example `gpu.c24`, `gpu.dc80`) earn
  more credits per second, and a tier above the class base is paid only after the agent passes the
  coordinator's hardware verification.
- **Reservations.** A lease is paid up front for its minutes; when it ends the host is paid for
  the time held (minus the network fee) and the rest is refunded. If the machine goes offline, the
  lease is billed up to its last heartbeat (clamped to the lease), not to when the coordinator
  noticed. Without a known last-seen time (a coordinator restart with no shared database) it falls
  back to the time it was noticed. A lease may opt in to **backfill**: while the holder has no job
  on it, the machine takes small network calls, billed to their submitters as usual, and the
  holder is credited a share of the host's pay (50 % by default), never more in total than the
  lease price; past that the host keeps it all (`docs/reservation-backfill.md`).
- **Order book.** Agents post an ask per class, tasks carry a bid; a task is claimed only when the
  ask clears the bid, and it trades at the ask, clamped to a band around the class reference.

## Token issuance

The coordinator computes a daily token pool from network load and allocates it hourly by each
account's weighted contribution over the last 24 hours. Allocations are written to
`issuance_allocations` and shown on the portal dashboard, but **no code converts them into cSats or
any balance yet**. Issuance parameters are in [Issuance Parameters](/reference/issuance-economy-params).

## Ledger and integrity

- Every claim, result and earning is an append-only, hash-chained ledger record; `/ledger/verify`
  checks the chain.
- Bitcoin OP_RETURN anchoring of checkpoints is implemented but off in production; it is planned
  for mainnet. See [Bitcoin Anchoring](/economy/bitcoin-anchoring).

## BLE offline credits

When agents work over the BLE mesh (offline), each transaction is recorded locally with both
parties' signatures and synced to the coordinator via `POST /credits/ble-sync` on reconnection.
A BLE task is worth its CPU seconds (1 credit per second) times a model quality multiplier
(`src/credits/ble-tx-v3.ts`):

- 7B+ parameters: 1.0x
- 3B-7B: 0.7x
- 1.5B-3B: 0.5x
- < 1.5B: 0.3x

This multiplier applies only to BLE offline credits, not to network pricing.

## Related references

- [Economy math](https://github.com/codyrs82/Edgecoder/blob/main/docs/economy-math.md) (canonical)
- [Going to mainnet](https://github.com/codyrs82/Edgecoder/blob/main/docs/going-to-mainnet.md)
- [Public Mesh Operations](/operations/public-mesh-operations)
