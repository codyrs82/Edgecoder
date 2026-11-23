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
- Proof of reserves: `GET /economy/reserves`, public and unauthenticated, aggregate numbers only (rate-limited per IP).
- Web tool: `/v1/tools/web/{status,search,read}` for account-authenticated callers (a signed agent or the portal).
- Issuance and stats: recalculation, history, rolling windows, anchor/quorum/reconcile.

## Control Plane

- Network summary and discovery feed for coordinators.
- Agent and coordinator approval workflows.
- Security blacklist and audit inspection.
- Bootstrap and deployment planning helpers.
- Model orchestration/rollout management.

## Portal

- User auth (signup/login/logout), OAuth callbacks, email verification, password reset.
- Passkey registration/login and two-factor authentication (authenticator app, recovery codes, passkey).
- Node enrollment, machines (`/portal/api/machines`) and dashboard summaries.
- Settings pages, theme preferences, API keys (`/portal/api/keys`).
- Wallet: balance and top-up with Lightning (`/portal/api/wallet/*`), payout destination (`/wallet/payout-destination`) and withdrawals (`/wallet/payouts*`). `/wallet/onboarding` remains only as a deprecated status for old clients; no wallet is created.
- Web chat: models, the streaming chat, saved conversations and the web tool's status (`/portal/api/chat`, `/portal/api/conversations*`, `/portal/api/web/status`), plus the chat-sharing consent (`/me/chat-sharing`).
- Bots: desktop and cloud bots in one list, create, message and control (`/portal/api/bots*`).
- Code from your phone: machines, trusted projects and sessions, and commands relayed to a desktop app (`/portal/api/code/*`).
- Compute: overview, options and reservations (`/portal/api/compute/*`).
- Hosting by request: the public form (`POST /host/request`) and the signed-in account's host status (`/portal/api/host/status`).
- Public proof of reserves page (`/reserves`, `/reserves.json`).

## Hosted API (`https://edgecoder.io/v1`)

OpenAI- and Anthropic-compatible model API for tools and machines without the desktop app, authenticated with an `eck_` API key and billed to the key's account in cSats:

- Models and inference: `/v1/models`, `/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`.
- The key's account: balance and usage, Lightning top-up, reservations (`/v1/account*`).
- Web tool relay: `/v1/tools/web/{status,search,read}`.

See [Using network compute](/guide/using-compute).

## Inference Service

- Health endpoint
- Decomposition endpoint (token-gated when configured)

## IDE Provider (desktop app, `127.0.0.1:4304`)

- OpenAI-compatible model list and chat for local tools.
- Shared coding sessions used by the app's Code view and `edgecoder code` (`/v1/ide/sessions*`).
- Desktop bots (`/v1/ide/bots*`), connections, reservations and usage.
- Code from your phone, the desktop half (`/v1/ide/code/remote/snapshot`, `/v1/ide/code/remote/command`). Requests from the phone reach it through the portal and the coordinator, never directly.

All routes need the local IDE token and are bound to loopback.

## Source references

- [Public Mesh Operations APIs](https://github.com/codyrs82/Edgecoder/blob/main/docs/public-mesh-operations.md)
- [Developer Guide endpoint sections](https://github.com/codyrs82/Edgecoder/blob/main/README.md#developer-guide)
