# Credits, Pricing, and Issuance

This page summarizes the economic model from `docs/public-mesh-operations.md`,
`README.md`, and architecture planning material.

## Two-Layer Model

- **Settlement layer**: bitcoin/lightning denomination and payment settlement.
- **Runtime layer**: internal credits used for workload accounting and allocation.

## Pricing and Quotes

- Dynamic epoch pricing tracks network conditions.
- Credit-to-sats quote endpoints expose conversion for account workflows.
- Coordinator peers can propose and converge pricing via consensus mechanics.

## Payment Intents and Credit Minting

- Payment intents represent pending settlement operations.
- Confirmation and reconciliation paths move intents into settled state.
- Settled intents mint credits into account context.

## Contribution and Issuance

- Issuance is recomputed on rolling windows (non-cumulative lifetime allocation).
- Contribution quality and recent availability drive relative share.
- Capacity that drops out naturally rolls off from future windows.

## Ledger and Integrity

- Hash-chain and verification flows provide tamper-evident history checks.
- Stats/anchor workflows support stronger finality checkpoints over time.
- Economy state and issuance history remain inspectable through dedicated endpoints.

## Coordinator fee and treasury policy

- Coordinator fee basis points can be configured for operational economics.
- Treasury/custody policy endpoints support operator-level governance.

## Related references

- [Public Mesh Operations Economy Section](https://github.com/codyrs82/Edgecoder/blob/main/docs/public-mesh-operations.md)
- [Developer Guide Economy Endpoints](https://github.com/codyrs82/Edgecoder/blob/main/README.dev.md)

## Model Quality Multiplier

Credit earnings from compute contributions are scaled by the model being used:

- 7B+ parameters: 1.0x (full rate)
- 3B-7B: 0.7x
- 1.5B-3B: 0.5x
- < 1.5B: 0.3x

This incentivizes running capable models while still allowing participation with smaller hardware.

## BLE Offline Credits

When agents operate in BLE mesh mode (offline), credit transactions are recorded locally with dual signatures. On reconnection, transactions sync to the coordinator via `POST /credits/ble-sync` and enter the ordering chain.

## Model Seed Credits

Agents that distribute models to peers earn seed credits:

- Base: 0.5 credits per GB transferred
- Rarity bonus: `1 / seederCount` multiplier (fewer seeders = more reward)
- Incentivizes keeping popular models available for the network
