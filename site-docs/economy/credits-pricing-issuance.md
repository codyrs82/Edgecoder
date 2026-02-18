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

- [Public Mesh Operations Economy Section](https://github.com/your-org/Edgecoder/blob/main/docs/public-mesh-operations.md)
- [Developer Guide Economy Endpoints](https://github.com/your-org/Edgecoder/blob/main/README.dev.md)
