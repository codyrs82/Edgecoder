# EdgeCoder API Reference

This document lists the HTTP endpoints for each EdgeCoder service. All services use JSON request/response bodies unless noted otherwise.

## Table of Contents

- [Coordinator (port 4301)](#coordinator-port-4301)
- [Inference Service (port 4302)](#inference-service-port-4302)
- [Control Plane (port 4303)](#control-plane-port-4303)
- [Portal (port 4310)](#portal-port-4310)

---

## Coordinator (port 4301)

Most coordinator endpoints require the `x-mesh-token` header matching `MESH_AUTH_TOKEN`.

### Agent Lifecycle

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/register` | Register a worker agent with the coordinator | mesh token, portal node approval |
| `POST` | `/heartbeat` | Agent heartbeat with power telemetry and model status | mesh token, signed request |
| `POST` | `/agent/diagnostics` | Submit agent diagnostic data | mesh token |
| `GET` | `/agent/diagnostics/:agentId` | Retrieve diagnostics for a specific agent | mesh token |

### Task Queue

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/submit` | Submit a new task for decomposition and execution | mesh token |
| `POST` | `/pull` | Pull the next available subtask for execution | mesh token |
| `POST` | `/result` | Submit a subtask execution result | mesh token, signed request |
| `GET` | `/status` | Get current queue status (pending, active, completed counts) | mesh token |
| `POST` | `/portal/chat` | Submit a task from the portal chat interface | portal service token |
| `POST` | `/debug/enqueue` | Debug: directly enqueue a subtask | mesh token |

### Escalation

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/escalate` | Escalate a failed task to parent coordinator or cloud | mesh token |
| `GET` | `/escalate/:taskId` | Get escalation status for a task | mesh token |
| `POST` | `/escalate/:taskId/result` | Submit an escalation result | mesh token |

### Health and Capabilities

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/health/runtime` | Runtime health (uptime, memory, active agents) | mesh token |
| `GET` | `/features` | Feature flags | mesh token |
| `GET` | `/models/available` | List available models across agents | mesh token |
| `GET` | `/capacity` | Swarm capacity summary (agents, GPU/CPU, queue depth) | mesh token |
| `GET` | `/identity` | Coordinator peer identity (peerId, publicKey, URL) | mesh token |

### Economy and Payments

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/economy/price/current` | Current dynamic price epoch | mesh token |
| `GET` | `/economy/price/quote` | Get a sats quote for a given resource class | mesh token |
| `GET` | `/economy/credits/:accountId/quote` | Credit-to-sats conversion quote | mesh token |
| `POST` | `/economy/price/propose` | Propose a price update (approved coordinators only) | mesh token |
| `POST` | `/economy/price/consensus` | Run weighted-median price consensus across peers | mesh token |
| `POST` | `/economy/payments/intents` | Create a BTC/Lightning payment intent | mesh token |
| `GET` | `/economy/payments/intents/:intentId` | Get payment intent status | mesh token |
| `POST` | `/economy/payments/intents/:intentId/confirm` | Confirm payment settlement and mint credits | mesh token |
| `POST` | `/economy/payments/webhook` | Webhook for external payment notifications | webhook secret |
| `POST` | `/economy/payments/reconcile` | Poll pending intents for settlement/expiry | mesh token |

### Treasury and Issuance

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/economy/treasury/policies` | Create a treasury custody policy | mesh token |
| `POST` | `/economy/treasury/policies/:policyId/activate` | Activate a treasury policy | mesh token |
| `GET` | `/economy/treasury` | Get current treasury state | mesh token |
| `POST` | `/economy/issuance/recalculate` | Trigger issuance recalculation | mesh token |
| `GET` | `/economy/issuance/current` | Current issuance epoch | mesh token |
| `GET` | `/economy/issuance/history` | Issuance epoch history | mesh token |
| `GET` | `/economy/issuance/rolling/:accountId` | Rolling issuance totals for an account | mesh token |
| `POST` | `/economy/issuance/quorum/vote` | Submit quorum vote for an issuance epoch | mesh token |
| `GET` | `/economy/issuance/quorum/:epochId` | Get quorum votes for an epoch | mesh token |
| `POST` | `/economy/issuance/anchor` | Anchor current issuance epoch to Bitcoin | mesh token |
| `GET` | `/economy/issuance/anchors` | List Bitcoin anchor records | mesh token |
| `POST` | `/economy/issuance/reconcile` | Reconcile issuance across peers | mesh token |

### Mesh Networking

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/mesh/peers` | List known mesh peers | mesh token |
| `POST` | `/mesh/register-peer` | Register a peer coordinator | mesh token |
| `POST` | `/mesh/ingest` | Ingest a gossip message | mesh token |
| `GET` | `/mesh/ws` | WebSocket endpoint for persistent mesh connections | mesh token |
| `GET` | `/mesh/capabilities` | Aggregated capability summary across agents | mesh token |
| `GET` | `/mesh/reputation` | Peer reputation scores | mesh token |

### Agent Mesh (Peer-to-Peer)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/agent-mesh/peers/:agentId` | Get peer info for an agent | mesh token |
| `GET` | `/agent-mesh/models/available` | List models available in the agent mesh | mesh token |
| `POST` | `/agent-mesh/connect` | Initiate a peer tunnel connection | mesh token |
| `POST` | `/agent-mesh/accept` | Accept a peer tunnel invitation | mesh token |
| `POST` | `/agent-mesh/relay` | Relay a message through a peer tunnel | mesh token |
| `POST` | `/agent-mesh/close` | Close a peer tunnel | mesh token |
| `POST` | `/agent-mesh/close-ack` | Acknowledge tunnel close | mesh token |
| `POST` | `/agent-mesh/direct-work/offer` | Offer direct work to a peer | mesh token |
| `POST` | `/agent-mesh/direct-work/accept` | Accept a direct work offer | mesh token |
| `POST` | `/agent-mesh/direct-work/result` | Submit result for direct work | mesh token |
| `GET` | `/agent-mesh/direct-work/audit` | Audit log of direct work exchanges | mesh token |
| `POST` | `/agent-mesh/models/request` | Request model transfer from a peer | mesh token |
| `GET` | `/agent-mesh/models/request/:offerId` | Get model transfer request status | mesh token |

### Orchestration

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/orchestration/coordinator/ollama-install` | Install/update Ollama model on coordinator | mesh token |
| `GET` | `/orchestration/coordinator/status` | Coordinator orchestration status | mesh token |
| `POST` | `/orchestration/agents/:agentId/ollama-install` | Install Ollama model on a specific agent | mesh token |
| `POST` | `/orchestration/agents/:agentId/status` | Update agent orchestration status | mesh token |
| `POST` | `/orchestration/agents/:agentId/ack` | Acknowledge orchestration command | mesh token |
| `GET` | `/orchestration/rollouts` | List rollout state across agents | mesh token |

### Security and Audit

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/security/blacklist` | List active blacklist entries | mesh token |
| `GET` | `/security/blacklist/audit` | Blacklist audit log | mesh token |
| `POST` | `/security/blacklist` | Report a node for blacklisting (with evidence) | mesh token |

### Ledger and Stats

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/ledger/snapshot` | Full ordering chain snapshot | mesh token |
| `GET` | `/ledger/verify` | Verify ordering chain integrity | mesh token |
| `GET` | `/stats/ledger/head` | Latest stats ledger record | mesh token |
| `GET` | `/stats/ledger/range` | Stats ledger range query | mesh token |
| `POST` | `/stats/ledger/ingest` | Ingest stats ledger records from peers | mesh token |
| `POST` | `/stats/anchors/anchor-latest` | Anchor latest stats to Bitcoin | mesh token |
| `GET` | `/stats/anchors/verify` | Verify stats anchors | mesh token |
| `GET` | `/stats/projections/summary` | Projected network stats summary | mesh token |

### BLE Credits

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/credits/ble-sync` | Sync offline BLE credit transactions | mesh token |

---

## Inference Service (port 4302)

Protected by optional `INFERENCE_AUTH_TOKEN` (via `x-inference-token` header) and optional signed coordinator request verification.

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/decompose` | Decompose a prompt into subtasks | inference token, optional signed request |
| `POST` | `/escalate` | Escalate failed code for LLM-assisted improvement | inference token, optional signed request |
| `GET` | `/health` | Health check | none |
| `GET` | `/metrics` | Service metrics (request counts, latency) | none |
| `GET` | `/dashboard` | Inference service dashboard (HTML) | none |
| `GET/POST` | `/models/*` | Model swap routes (list, swap, status, pull) | inference token |

### POST /decompose

**Request body:**

```json
{
  "taskId": "uuid",
  "prompt": "Write a function that...",
  "snapshotRef": "sha256-of-repo-snapshot",
  "language": "python"
}
```

**Response:**

```json
{
  "subtasks": [
    {
      "taskId": "uuid",
      "kind": "micro_loop",
      "input": "Implement the helper function...",
      "language": "python",
      "timeoutMs": 30000,
      "snapshotRef": "sha256-of-repo-snapshot"
    }
  ]
}
```

### POST /escalate

**Request body:**

```json
{
  "task": "Original task description",
  "failedCode": "def broken():\n  ...",
  "errorHistory": ["TypeError: ...", "AssertionError: ..."],
  "language": "python"
}
```

**Response:**

```json
{
  "improvedCode": "def fixed():\n  ...",
  "explanation": "Escalated to larger model for improved solution."
}
```

---

## Control Plane (port 4303)

Protected by `ADMIN_API_TOKEN` (via `x-admin-token` header or `Authorization: Bearer <token>`). Portal internal requests are authenticated via `x-portal-service-token`. Optional IP allowlist via `ALLOWED_ADMIN_IPS`.

### Agent Management

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/agents` | List all registered agents | admin |
| `GET` | `/agents/catalog` | Agent catalog with capabilities | admin |
| `POST` | `/agents/upsert` | Create or update an agent record | admin |
| `POST` | `/agents/:agentId/mode` | Change agent mode (swarm-only/ide-enabled) | admin |
| `POST` | `/agents/:agentId/local-model` | Set agent local model | admin |
| `POST` | `/agents/:agentId/approval` | Approve or reject an agent | admin |
| `GET` | `/agents/:agentId/manifest` | Get agent model manifest | admin |
| `POST` | `/coordinators/:coordinatorId/approval` | Approve or reject a coordinator | admin |

### Network

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/network/mode` | Current network mode | admin |
| `POST` | `/network/mode` | Set network mode (public_mesh / enterprise_overlay) | admin |
| `GET` | `/network/summary` | Network status (capacity, jobs, pricing) | admin |
| `GET` | `/network/coordinators` | Coordinator discovery (known coordinators) | admin |
| `GET` | `/mesh/peers` | Mesh peer listing (via coordinator) | admin |
| `GET` | `/deployment/plan` | Current deployment plan | admin |

### Health

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/health/runtime` | Runtime health (uptime, memory) | admin |

### Rollouts

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/rollouts` | List all rollouts | admin |
| `GET` | `/rollouts/:rolloutId` | Get rollout details | admin |
| `POST` | `/rollouts` | Create a new rollout (canary, percentage, full) | admin |
| `POST` | `/rollouts/:rolloutId/promote` | Promote rollout to next stage | admin |
| `POST` | `/rollouts/:rolloutId/rollback` | Rollback a rollout | admin |
| `POST` | `/rollouts/:rolloutId/agents/:agentId/status` | Update agent rollout status | admin |

### Credits

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/credits/:accountId/balance` | Get account credit balance | admin |
| `GET` | `/credits/:accountId/history` | Get account transaction history | admin |
| `POST` | `/credits/:accountId/faucet` | Grant faucet credits (development) | admin |
| `POST` | `/credits/accounts` | Create a credit account | admin |
| `POST` | `/credits/accounts/:accountId/members` | Add members to a credit account | admin |
| `POST` | `/credits/accounts/:accountId/agents/link` | Link agents to a credit account | admin |
| `GET` | `/credits/accounts/:accountId/agents` | List agents linked to account | admin |
| `GET` | `/credits/users/:userId/accounts` | List credit accounts for a user | admin |

### Economy

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/economy/price/current` | Current price epoch | admin |
| `GET` | `/economy/issuance/current` | Current issuance epoch | admin |
| `GET` | `/economy/issuance/history` | Issuance epoch history | admin |
| `GET` | `/economy/credits/:accountId/quote` | Credit-to-sats quote | admin |
| `POST` | `/economy/price/propose` | Propose price update | admin |
| `POST` | `/economy/price/consensus` | Trigger price consensus | admin |
| `POST` | `/economy/wallets/register` | Register wallet for account | admin |
| `GET` | `/economy/wallets/:accountId` | Get wallet details | admin |
| `POST` | `/economy/payments/intents` | Create payment intent | admin |
| `GET` | `/economy/payments/intents/:intentId` | Get payment intent | admin |
| `POST` | `/economy/payments/intents/:intentId/confirm` | Confirm payment | admin |
| `POST` | `/economy/payments/reconcile` | Reconcile pending payments | admin |
| `POST` | `/economy/treasury/policies` | Create treasury policy | admin |
| `POST` | `/economy/treasury/policies/:policyId/activate` | Activate policy | admin |
| `GET` | `/economy/treasury` | Get treasury state | admin |

### Security

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/security/blacklist` | List blacklist entries | admin |
| `GET` | `/security/blacklist/audit` | Blacklist audit log | admin |
| `POST` | `/security/blacklist` | Report a node for blacklisting | admin |
| `GET` | `/agent-mesh/direct-work/audit` | Direct work audit log | admin |
| `GET` | `/agent-mesh/models/available` | Available models in agent mesh | admin |

### Orchestration

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/orchestration/install-model` | Install model across agents | admin |
| `GET` | `/orchestration/rollouts` | Orchestration rollout status | admin |

### Wallets

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/wallets/:accountId` | Get wallet details | admin |

### Bootstrap

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/bootstrap/coordinator` | Bootstrap coordinator (initial setup) | admin |

### UI

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/ui` | Admin dashboard HTML | IP allowlist |
| `GET` | `/ui/data` | Dashboard data payload | admin |
| `GET` | `/ops/summary` | Operations summary | admin |
| `POST` | `/ops/coordinator-ollama` | Coordinator Ollama actions | admin |
| `POST` | `/ui/actions/coordinator-ollama` | UI-triggered Ollama actions | admin |
| `POST` | `/ui/actions/node-approval` | UI-triggered node approval | admin |

---

## Portal (port 4310)

Public-facing. Auth routes are unauthenticated; most other routes require a valid session cookie.

### Authentication

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/auth/capabilities` | Auth capabilities (passkey, SSO providers) | none |
| `POST` | `/auth/signup` | Email/password signup | none |
| `POST` | `/auth/login` | Email/password login | none |
| `POST` | `/auth/logout` | End session | session |
| `GET` | `/auth/verify-email` | Verify email via token | none |
| `POST` | `/auth/resend-verification` | Resend verification email | session |
| `GET` | `/auth/oauth/:provider/start` | Start OAuth flow (google, microsoft) | none |
| `GET` | `/auth/oauth/:provider/callback` | OAuth callback (GET) | none |
| `POST` | `/auth/oauth/:provider/callback` | OAuth callback (POST) | none |
| `POST` | `/auth/oauth/mobile/complete` | Complete mobile OAuth with session token | none |

### Passkey (WebAuthn)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/auth/passkey/register/options` | Generate passkey registration options | session |
| `POST` | `/auth/passkey/register/verify` | Verify passkey registration response | session |
| `POST` | `/auth/passkey/login/options` | Generate passkey authentication options | none |
| `POST` | `/auth/passkey/login/verify` | Verify passkey authentication response | none |

### User Profile

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/me` | Get current user profile | session |
| `POST` | `/me/theme` | Set user theme preference | session |

### Nodes

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/nodes/enroll` | Enroll a new node | session |
| `DELETE` | `/nodes/:nodeId` | Remove an enrolled node | session |
| `GET` | `/nodes/me` | List user's enrolled nodes | session |

### Dashboard

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/dashboard/summary` | User dashboard summary | session |
| `GET` | `/dashboard/network-insights` | Network insights for user | session |

### Wallet

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/wallet/onboarding` | Wallet onboarding status | session |
| `POST` | `/wallet/onboarding/setup-seed` | Generate wallet seed | session |
| `POST` | `/wallet/onboarding/acknowledge` | Acknowledge seed backup | session |
| `GET` | `/wallet/send/requests` | List pending send requests | session |
| `POST` | `/wallet/send/mfa/start` | Start MFA for wallet send | session |
| `POST` | `/wallet/send/mfa/confirm` | Confirm MFA for wallet send | session |

### iOS

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/ios/dashboard` | iOS dashboard aggregate data | session |
| `GET` | `/ios/agents/:agentId/contribution` | Agent contribution stats | session |

### Coordinator Operations

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/coordinator/ops/summary` | Coordinator operations summary | session (admin) |
| `GET` | `/coordinator/ops/agent-diagnostics` | Agent diagnostics view | session (admin) |
| `POST` | `/coordinator/ops/node-approval` | Approve/reject a node | session (admin) |
| `POST` | `/coordinator/ops/coordinator-ollama` | Coordinator Ollama management | session (admin) |
| `POST` | `/coordinator/ops/agents-model` | Set model across agents | session (admin) |

### Chat API

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/portal/api/conversations` | List conversations | session |
| `POST` | `/portal/api/conversations` | Create a conversation | session |
| `GET` | `/portal/api/conversations/:id/messages` | Get messages for a conversation | session |
| `PATCH` | `/portal/api/conversations/:id` | Update conversation metadata | session |
| `DELETE` | `/portal/api/conversations/:id` | Delete a conversation | session |
| `POST` | `/portal/api/chat` | Send a chat message (submits task) | session |

### Reviews

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/portal/api/reviews` | List pending reviews | session |
| `GET` | `/portal/api/reviews/:taskId` | Get review details | session |
| `POST` | `/portal/api/reviews/:taskId/decision` | Submit review decision | session |

### Escalations

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/portal/api/escalations` | List human escalations | session |
| `GET` | `/portal/api/escalations/pending-count` | Count pending escalations | session |
| `GET` | `/portal/api/escalations/:id` | Get escalation details | session |
| `POST` | `/portal/api/escalations/:id/respond` | Respond to a human escalation | session |

### Internal APIs

Used by the coordinator for node validation during agent registration.

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/internal/nodes/validate` | Validate a node registration | portal service token |
| `POST` | `/internal/nodes/:nodeId/approval` | Approve/reject a node | portal service token |
| `POST` | `/internal/nodes/lookup` | Lookup node details (batch) | portal service token |
| `GET` | `/internal/nodes/pending` | List pending node approvals | portal service token |

### Portal Pages (HTML)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Marketing home page |
| `GET` | `/portal` | Main portal app |
| `GET` | `/portal/chat` | Chat interface |
| `GET` | `/portal/dashboard` | Dashboard |
| `GET` | `/portal/nodes` | Node management |
| `GET` | `/portal/coordinator-ops` | Coordinator operations |
| `GET` | `/portal/wallet` | Wallet |
| `GET` | `/portal/settings` | User settings |
| `GET` | `/portal/download` | Download page |
| `GET` | `/portal/reviews` | Code reviews |

### Miscellaneous

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/health` | Health check | none |
| `GET` | `/.well-known/apple-app-site-association` | iOS app association | none |
