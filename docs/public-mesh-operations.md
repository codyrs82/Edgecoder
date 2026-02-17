# Public Mesh Operations

This document explains public-node onboarding and enterprise overlay controls for EdgeCoder mesh deployments.

## Current Live URLs

- Portal: `https://portal.edgecoder.io/portal`
- Coordinator operations dashboard: `https://portal.edgecoder.io/portal/coordinator-ops`
- Coordinator API base: `https://coordinator.edgecoder.io` (mesh token required)

## First Coordinator Placement

- Coordinator operations home: `portal` at `GET /portal/coordinator-ops`
- First coordinator runtime: Fly.io app (`edgecoder-coordinator`)
- Production URLs:
  - Portal: `https://portal.edgecoder.io/portal`
  - Coordinator operations: `https://portal.edgecoder.io/portal/coordinator-ops`
  - Coordinator: `https://coordinator.edgecoder.io`
- SQL backend for coordinator/control-plane state: Fly Postgres (PostgreSQL 16) via `DATABASE_URL`
- Deployment defaults endpoint: `GET /deployment/plan`
- Fly bootstrap guide: `docs/flyio-bootstrap.md`

## Node Join (Public Mesh)

- Clone repo, run `npm install`.
- Start coordinator + inference + control-plane + portal services.
- Create user account in portal, verify email, then enroll node and capture `registrationToken`.
- Start worker process with unique `AGENT_ID`, `AGENT_OS=macos`, and `AGENT_REGISTRATION_TOKEN=<portal token>`.
- For iOS swarm workers, run `AGENT_ID=<iphone-id> AGENT_REGISTRATION_TOKEN=<portal token> npm run dev:worker:ios`.
  - Optional iOS telemetry controls:
    - `IOS_ON_EXTERNAL_POWER=true|false`
    - `IOS_BATTERY_LEVEL_PCT=0..100`
    - `IOS_LOW_POWER_MODE=true|false`
- Node remains dormant until coordinator admin explicitly approves node in control-plane UI/API.
- External runtimes (OpenClaw / local Claude-style agents) can join by calling coordinator APIs directly and setting:
  - `clientType` on `/register` (for example `openclaw`, `claude-local`, `edgecoder-native`)
  - `os` as any descriptive string (for example `macos`, `linux-arm64`, `windows`)
- Register peer identities between coordinators with `POST /mesh/register-peer`.
- Monitor peer reputation with `GET /mesh/reputation`.
- For installer/runtime bootstrap, fetch coordinator candidates from `GET /network/coordinators` on control plane.
- Full install runbook (self-hosted agents + extra coordinators): `docs/agent-and-coordinator-install.md`.
- Linux managed service templates: `scripts/linux/systemd/`.

## Coordinator Mesh APIs

All coordinator APIs are mesh-internal and require `x-mesh-token`.
Public unauthenticated requests are rejected with `401 mesh_unauthorized`.

Control-plane discovery API:

- `GET /network/coordinators` (public) returns coordinator URLs collected from bootstrap + live mesh peers.

- `GET /identity` - local coordinator mesh identity.
- `GET /mesh/peers` - known coordinator peers.
- `POST /mesh/register-peer` - bootstrap peer discovery.
- `POST /mesh/ingest` - signed gossip ingress.
- `GET /features` - mode flags (`public_mesh`, `enterprise_overlay`).
- `GET /capacity` - total capacity, connected agents, mode counts, and tunnel count (includes per-agent `powerPolicy` decision).
- `GET /agent-mesh/peers/:agentId` - peer candidates for reverse-tunnel links.
- `POST /agent-mesh/connect` - create secure reverse-tunnel token.
- `POST /agent-mesh/accept` - accept reverse-tunnel invite.
- `POST /agent-mesh/relay` - relay encrypted payloads through coordinator over TLS.
- `POST /agent-mesh/close` - explicitly close a tunnel and notify peer.
- `POST /agent-mesh/close-ack` - peer acknowledges close notice removal.
- `POST /agent-mesh/direct-work/offer` - offer idle peer-direct work to another agent.
- `POST /agent-mesh/direct-work/accept` - receiving agent accepts peer direct work and notifies coordinator.
- `POST /agent-mesh/direct-work/result` - receiving agent posts completion result to coordinator.
- `GET /agent-mesh/direct-work/audit` - latest peer-direct offer/accept/result timeline.
- `GET /agent-mesh/models/available` - discover model-capable agents currently advertising local providers.
- `POST /agent-mesh/models/request` - route a model inference prompt to a target agent's local model.
- `GET /agent-mesh/models/request/:offerId` - poll model request status/result.
- `GET /orchestration/rollouts` - latest coordinator/agent model rollout audit records.

Peer-direct workflow:

- Agent A checks coordinator queue.
- If no coordinator task is assigned, Agent A offers low-cost direct work to Agent B.
- Agent B accepts offer and immediately notifies coordinator (`/agent-mesh/direct-work/accept`).
- Agent B runs the work and posts completion (`/agent-mesh/direct-work/result`).

## Ledger and Credit Integrity

- `GET /ledger/snapshot` - append-only queue event records.
- `GET /ledger/verify` - hash/signature verification status.
- `POST /credits/:accountId/faucet` - demo credit seeding.
- `GET /credits/:accountId/balance` - current credits.
- `GET /credits/:accountId/history` - credit transaction history.
- `POST /credits/accounts` - create pooled credit account.
- `POST /credits/accounts/:accountId/members` - add owner/admin/member user to account.
- `POST /credits/accounts/:accountId/agents/link` - map an agent machine to pooled account.
- `GET /credits/accounts/:accountId/agents` - list pooled machines in account.
- `GET /credits/users/:userId/accounts` - list pools a user belongs to.
- `GET /agents/catalog` - agent catalog with ownership and reward account balances.

## Bitcoin + Credit Economy

EdgeCoder uses a two-layer economy:

- Settlement: Bitcoin/Lightning (sats).
- Runtime accounting: internal credits for task submission/consumption.

Core APIs:

- `GET /economy/price/current` - current signed price epochs (CPU/GPU sats per compute unit).
- `POST /economy/price/propose` - approved coordinators propose demand/supply metrics to negotiate new epochs.
- `POST /economy/price/consensus` - computes weighted-median price epochs across coordinator peers.
- `POST /economy/wallets/register` - attach a wallet identity to a credit account.
- `POST /economy/payments/intents` - create purchase intent and invoice reference.
- `POST /economy/payments/intents/:intentId/confirm` - settle intent and mint credits to the account.
- `GET /economy/payments/intents/:intentId` - inspect settlement state.
- `POST /economy/payments/reconcile` - anti-fraud/expiry sweep for stale invoices and late settlements.
- `POST /economy/payments/webhook` - provider callback ingestion for settlement.
- `GET /economy/credits/:accountId/quote` - estimate BTC sats value of earned credits using current CPU price epoch.
- `POST /economy/treasury/policies` / `GET /economy/treasury` - federated multisig custody policy and signed key events.
- `POST /economy/issuance/recalculate` - recompute rolling 24h issuance epoch immediately.
- `GET /economy/issuance/current` - current issuance epoch and per-account allocations.
- `GET /economy/issuance/history` - historical issuance epochs.
- `GET /economy/issuance/rolling/:accountId` - rolling 24h contribution share for an account.
- `GET /economy/issuance/quorum/:epochId` - quorum records for issuance proposal/vote/commit/checkpoint.
- `POST /economy/issuance/anchor` / `GET /economy/issuance/anchors` - Bitcoin anchor lifecycle for finalized checkpoints.
- `POST /economy/issuance/reconcile` - payout drift scan between settled intents and issuance payout records.
- `GET /network/summary` - control-plane aggregate of current capacity, jobs, and pricing.

Persisted tables:

- `wallet_accounts`
- `payment_intents`
- `price_epochs`
- `coordinator_fee_events`

Fee and governance env vars:

- `BITCOIN_NETWORK` (`bitcoin`, `testnet`, `signet`)
- `COORDINATOR_FEE_BPS` (coordinator operator fee in basis points)
- `COORDINATOR_FEE_ACCOUNT` (separate fee wallet account id)
- `APPROVED_COORDINATOR_IDS` (comma-separated peer ids allowed to propose price epochs)
- `LIGHTNING_PROVIDER` (`mock`, `lnd`, `cln`)
- `PAYMENT_INTENT_TTL_MS` (created intents auto-expire after this window)
- `PAYMENT_WEBHOOK_SECRET` (optional webhook shared secret)

## Enterprise Overlay

Set or update network mode:

- `NETWORK_MODE=enterprise_overlay npm run dev:coordinator`
- `POST /network/mode` payload:
  - `{"networkMode":"enterprise_overlay"}`

Overlay mode should be paired with stricter identity controls, private peering allowlists, and attestation requirements.

## Ollama Install Flow for Coordinator and Agents

When `LOCAL_MODEL_PROVIDER=ollama-local`:

- Coordinator process starts local `ollama serve` bound to `127.0.0.1:11434`.
- Worker startup runs `ollama pull $OLLAMA_MODEL` before polling tasks.
- Optional remote host support via `OLLAMA_HOST`.
- If `ollama` is not installed, startup exits with an explicit actionable error.
- Fly production recommendation: keep `OLLAMA_AUTO_INSTALL=false` and pre-pull models during maintenance windows.
- Central trigger in control-plane:
  - `POST /orchestration/install-model`
    - target `coordinator` or `agent` (with `agentId`).

Model access boundary:

- Coordinator does not expose Ollama endpoints publicly.
- Model usage is mediated by authenticated agents and coordinator mesh APIs.
- IDE workflows require a local authenticated agent (IDE does not call coordinator model endpoints directly).

## Admin and Mesh Security

- UI access allowlist: `ALLOWED_UI_IPS`
- Control-plane legacy `/ui*` endpoints are retired and return redirect/410 responses.
- Coordinator model election and approval actions are exposed through authenticated portal coordinator operations pages.
- Admin API allowlist: `ALLOWED_ADMIN_IPS`
- Admin API token: `ADMIN_API_TOKEN` (header: `Authorization: Bearer <token>`)
- Mesh auth token: `MESH_AUTH_TOKEN` (header: `x-mesh-token`)
- Inference auth token: `INFERENCE_AUTH_TOKEN` (header: `x-inference-token` for `/decompose`)
- Coordinator -> inference target: `INFERENCE_URL`
- Optional signed coordinator -> inference auth:
  - `INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS`
  - `INFERENCE_COORDINATOR_PEER_ID`
  - `INFERENCE_COORDINATOR_PUBLIC_KEY_PEM`
  - or `INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON`
- Control-plane UI includes pending node approval actions for coordinators and agents.
- Portal internal auth token: `PORTAL_SERVICE_TOKEN` (header: `x-portal-service-token`)
- Portal service URL from coordinator/control-plane: `PORTAL_SERVICE_URL`
- Non-UI admin endpoints require valid admin token when configured.
- Runtime discovery defaults:
  - Worker failover order: `registry -> cache -> bootstrap`
  - Coordinator peer bootstrap order: `registry -> cache -> bootstrap`
- Coordinator signing identity (for durable blacklist signatures across restarts):
  - `COORDINATOR_PEER_ID`
  - `COORDINATOR_PRIVATE_KEY_PEM`
  - `COORDINATOR_PUBLIC_KEY_PEM` (optional when private key is provided)
- Coordinator discovery/join env:
  - `CONTROL_PLANE_URL`
  - `COORDINATOR_DISCOVERY_URL`
  - `COORDINATOR_PUBLIC_URL`
  - `COORDINATOR_BOOTSTRAP_URLS`
  - `COORDINATOR_REGISTRATION_TOKEN`
- Tunnel abuse limits:
  - `RELAY_RATE_LIMIT_PER_10S`
  - `TUNNEL_MAX_RELAYS_PER_MIN`
  - `DIRECT_WORK_OFFERS_PER_10S`

## User Portal and Node Activation

- Portal app runs on its own server and Postgres: `PORTAL_DATABASE_URL`.
- Users can sign up with email/password or SSO (`Google`, `Microsoft 365`).
- Passkeys are supported for portal and iOS login (`/auth/passkey/*` endpoints).
- Email verification is required (Resend integration with `RESEND_API_KEY`, `RESEND_FROM_EMAIL`).
- First-time signup bootstraps a starter wallet onboarding record and returns seed-protection guidance.
- Seed backup acknowledgement endpoints: `GET /wallet/onboarding`, `POST /wallet/onboarding/acknowledge`.
- iOS/mobile summary endpoint: `GET /ios/dashboard`.
- Unverified accounts with enrolled agents/coordinators remain dormant and cannot register.
- Even after email verification, nodes require coordinator approval to become active.
- Coordinator UI surfaces node owner email, source IP, VPN/proxy detection, and country code.
- Portal UI route: `GET /portal` (signup/login, OAuth starts, verification status, node enrollment, credits/wallet panels).
- Portal users can select a persisted theme profile (`midnight`, `emerald`, `light`) from the dashboard.

## Abuse Blacklist Coordination

- `POST /security/blacklist` on control-plane sends an abuse blacklist event to coordinator.
- Coordinator gossips `blacklist_update` across coordinator mesh, so all coordinators converge on the same blacklist.
- Coordinators push blacklist snapshots to agents on heartbeat.
- Agents stop peer meshing/offering/accepting work with blacklisted agents immediately.
- Blacklisted agents are blocked from registering, claiming work, posting results, and mesh relays.
- `GET /security/blacklist/audit` provides tamper-evident audit chain.
- Blacklist events are persisted in Postgres (`blacklist_events`) and restored on coordinator startup.
- Independent verifier CLI:
  - `npm run verify:blacklist-audit`
  - Uses control-plane audit endpoint + coordinator identity to verify hash chain and coordinator signatures.

Required blacklist evidence fields:

- `reasonCode` taxonomy: `abuse_spam`, `abuse_malware`, `policy_violation`, `credential_abuse`, `dos_behavior`, `forged_results`, `manual_review`
- `evidenceHashSha256` (64-char SHA-256)
- `reporterId`
- optional `reporterPublicKeyPem` + `reporterSignature` (required for non-`manual_review` reason codes)
- Coordinator appends hash-chained event metadata (`prevEventHash`, `eventHash`, `coordinatorSignature`) for cross-coordinator tamper evidence.
