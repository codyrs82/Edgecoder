# API Surfaces

This is a grouped API map for operators and developers.
For exact request/response formats, use source implementation and runbooks.

## Coordinator (mesh-authenticated)

Representative endpoint groups:

- Health/identity/capacity: status, runtime health, identity, capacity features.
- Mesh lifecycle: peer registration, gossip ingest, peer relationships.
- Direct-work and relay: offer/accept/result/audit flows for peer-direct execution.
- Agent-mesh model paths: available models, model request offer lifecycle.
- Ledger and credits: snapshots, verification, balances, history.
- Economy: pricing, wallet registration, payment intents, quotes, treasury.
- Issuance and stats: recalculation, history, rolling windows, anchor/quorum/reconcile.

## Control Plane

- Network summary and discovery feed for coordinators.
- Agent and coordinator approval workflows.
- Security blacklist and audit inspection.
- Bootstrap and deployment planning helpers.
- Model orchestration/rollout management.

## Portal

- User auth (signup/login/logout), OAuth callbacks, email verification.
- Passkey registration/login option + verification flows.
- Node enrollment and dashboard summaries.
- Theme preferences and coordinator operations dashboard routes.
- Wallet onboarding and acknowledgement flows.

## Inference Service

- Health endpoint
- Decomposition endpoint (token-gated when configured)

## IDE Provider

- Model list discovery endpoint for local IDE integration.

## Source references

- [Public Mesh Operations APIs](https://github.com/codyrs82/Edgecoder/blob/main/docs/public-mesh-operations.md)
- [Developer Guide endpoint sections](https://github.com/codyrs82/Edgecoder/blob/main/README.dev.md)
