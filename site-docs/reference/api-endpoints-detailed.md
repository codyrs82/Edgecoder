# API Endpoints Detailed

This page provides a practical endpoint-level index grouped by service.
Authentication and payload specifics should be validated against runtime code and source docs.

It covers the public and user-facing routes. The services have many more internal routes
(portal-to-coordinator `/internal/*`, admin `/admin/*` and `/portal/api/admin/*`, agent control,
order book and ledger plumbing); those are omitted here.

## Coordinator (mesh-auth required)

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | service status and readiness summary |
| GET | `/health/runtime` | runtime health details |
| GET | `/identity` | coordinator identity metadata |
| GET | `/mesh/peers` | current mesh peers |
| POST | `/mesh/register-peer` | register mesh peer |
| POST | `/mesh/ingest` | ingest mesh gossip payload |
| GET | `/agent-mesh/models/available` | discover model offers in mesh |
| POST | `/agent-mesh/models/request` | submit model request offer |
| GET | `/agent-mesh/models/request/:offerId` | inspect model request status |
| POST | `/agent-mesh/connect` | establish peer-direct tunnel/token |
| POST | `/agent-mesh/accept` | accept peer-direct tunnel offer |
| POST | `/agent-mesh/relay` | relay payload through tunnel |
| POST | `/agent-mesh/close` | close peer-direct tunnel |
| POST | `/agent-mesh/direct-work/offer` | offer direct work to peer |
| POST | `/agent-mesh/direct-work/accept` | accept direct work |
| POST | `/agent-mesh/direct-work/result` | return direct work result |
| GET | `/agent-mesh/direct-work/audit` | audit direct-work history |
| GET | `/ledger/snapshot` | current ledger snapshot |
| POST | `/ledger/verify` | verify ledger integrity |
| GET | `/economy/price/current` | current price epoch |
| POST | `/economy/price/propose` | submit price proposal |
| POST | `/economy/price/consensus` | run consensus over proposals |
| POST | `/economy/payments/intents` | create payment intent |
| POST | `/economy/payments/intents/:intentId/confirm` | **admin only** (`x-admin-token`): re-check settlement with the Lightning node; body `txRef` is ignored; `402 invoice_unpaid` if unpaid |
| POST | `/economy/payments/webhook` | settlement **hint** from the Lightning node/processor; HMAC-signed (see below) |
| POST | `/economy/payments/reconcile` | reconcile pending intents (node is checked before any intent is expired) |
| GET | `/economy/issuance/rolling/:accountId` | rolling issuance/account view |
| GET | `/economy/issuance/quorum/:epochId` | quorum state for issuance epoch |
| POST | `/economy/issuance/anchor` | publish/advance issuance anchor |
| GET | `/economy/issuance/anchors` | list issuance anchors |
| POST | `/economy/issuance/reconcile` | reconcile issuance state |
| GET | `/economy/issuance/current` | current issuance state |
| GET | `/economy/issuance/history` | issuance history |
| GET | `/stats/network/summary` | network-wide user, node, and live agent counts |
| GET | `/stats/projections/summary` | federated stats summary |
| POST | `/stats/anchors/anchor-latest` | update latest stats anchor |
| GET | `/stats/anchors/verify` | verify stats anchor/finality |
| GET | `/mesh/capabilities` | federated capability summaries |
| POST | `/credits/ble-sync` | sync offline BLE credit transactions |

## Coordinator (public or account-authenticated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/economy/reserves` | proof of reserves: aggregate liabilities, node balances and the latest anchor. No auth; rate-limited per client IP; cached (`RESERVES_CACHE_MS`, default 60 s) |
| POST | `/v1/tools/web/status`, `/v1/tools/web/search`, `/v1/tools/web/read` | the web tool for a signed agent or the portal (service token naming the account); billed per call |

## Control Plane

| Method | Path | Purpose |
|---|---|---|
| GET | `/network/summary` | network capacity and health summary |
| GET | `/network/coordinators` | coordinator discovery feed |
| POST | `/network/mode` | set network mode |
| GET | `/agents` | list agents |
| POST | `/agents/:agentId/approval` | approve/reject agent |
| POST | `/coordinators/:coordinatorId/approval` | approve/reject coordinator |
| GET | `/security/blacklist` | view blacklist entries |
| GET | `/security/blacklist/audit` | blacklist audit chain |
| POST | `/orchestration/install-model` | trigger model installation orchestration |

## Portal

| Method | Path | Purpose |
|---|---|---|
| GET | `/portal` | portal UI |
| POST | `/auth/signup` | create account |
| POST | `/auth/login` | authenticate account |
| POST | `/auth/logout` | terminate session |
| GET | `/auth/oauth/:provider/start` | begin OAuth flow |
| GET | `/auth/oauth/:provider/callback` | OAuth callback |
| GET | `/auth/verify-email` | verify email token |
| POST | `/auth/resend-verification` | resend verify email |
| POST | `/auth/passkey/register/options` | passkey registration options |
| POST | `/auth/passkey/register/verify` | passkey registration verify |
| POST | `/auth/passkey/login/options` | passkey login options |
| POST | `/auth/passkey/login/verify` | passkey login verify |
| POST | `/nodes/enroll` | enroll new node |
| GET | `/dashboard/summary` | account dashboard summary |
| GET | `/portal/coordinator-ops` | legacy URL: redirects (302) to `/portal/settings/admin`, keeping the query string |
| GET | `/wallet/payout-destination` | where payouts go (the user's own Lightning address) |
| PUT | `/wallet/payout-destination` | set it; changing it needs an emailed code |
| GET | `/wallet/onboarding` | deprecated status for old clients (no wallet is created) |
| GET | `/wallet/payouts` | the account's payouts and what is withdrawable |
| POST | `/wallet/payouts/withdraw` | withdraw earnings to a BOLT11 invoice; confirmed with an emailed code (and the second factor when 2FA is on) |
| GET | `/me` | the signed-in user |
| GET / PUT | `/me/chat-sharing` | the "Share my chats to help improve EdgeCoder" consent: `{ shareChatForImprovement, updatedAtMs }`; PUT `{ shareChatForImprovement: boolean }`. Off by default |
| GET | `/portal/api/wallet/overview` | balance, prices and the wallet page's data |
| POST | `/portal/api/wallet/topup` | create a Lightning invoice to buy cSats |
| GET | `/portal/api/wallet/topup/:intentId` | an invoice's state |
| GET | `/portal/api/keys` | list API keys (`eck_…`, prefix only) |
| POST | `/portal/api/keys` | create an API key (shown once; needs the second factor when 2FA is on) |
| DELETE | `/portal/api/keys/:keyId` | revoke an API key |
| GET | `/portal/api/machines` | the account's machines: state, model, audit |
| POST | `/portal/api/machines/:agentId/commands` | a model command for one of the account's machines ([Changing models from the portal](/guide/remote-model-control)) |
| POST | `/host/request` | public "Request to host" form (JSON or form post; honeypot and rate limits) |
| GET | `/portal/api/host/status` | `{ required, approved }`: whether the signed-in account is an approved host |
| GET | `/reserves`, `/reserves.json` | public proof of reserves page and its JSON |

Old top-level pages redirect into Settings: `/portal/wallet` → `/portal/settings/plan`,
`/portal/market` → `/portal/settings/compute`, `/portal/download` → `/portal/settings/install`,
`/portal/nodes` → `/portal/settings/nodes`, `/portal/coordinator-ops` → `/portal/settings/admin`
(`LEGACY_SETTINGS_REDIRECTS` in `src/portal/pages/settings-shell.ts`).

### Web chat

Session cookie auth. Source: `src/portal/routes/chat.ts`, `src/portal/routes/conversations.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/portal/chat` | the web chat page |
| GET | `/portal/api/models` | models the chat can use |
| GET | `/portal/api/conversations` | the user's conversations |
| POST | `/portal/api/conversations` | create one (`{ title? }`) → `{ conversationId }` |
| GET | `/portal/api/conversations/:id/messages` | a conversation's messages |
| PATCH | `/portal/api/conversations/:id` | rename (`{ title }`) |
| DELETE | `/portal/api/conversations/:id` | delete a conversation and its messages |
| POST | `/portal/api/chat` | send a message and stream the reply (SSE). Body: `{ conversationId, message, model?, compute?, resend?, web? }`. `compute` is `{target: "auto"}`, `{target: "network", model, computeClass?}`, `{target: "mine", model}` or `{target: "reserved", model, reservationId}`; omitted, EdgeCoder's default chat model answers. Messages up to 32,000 characters |
| GET | `/portal/api/web/status` | whether the web tool is available for this chat's compute, and why not (`not_configured`, `no_tools`, `needs_csats`, `rate_limited`, …) |

Messages and titles are encrypted at rest; see [Web chat privacy](/security/trust-and-security#web-chat-privacy).

### Bots

Session cookie auth. Cloud bots use `agentId: "cloud"`. Source: `src/portal/routes/bots.ts`, `src/portal/routes/cloud-bots.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/portal/bots` | the bots page |
| GET | `/portal/api/bots` | every bot of the account (cloud and desktop, `runtime: "cloud" \| "desktop"`) and where new ones can run (`targets`) |
| POST | `/portal/api/bots/new` | create a bot: `{ requestId, agentId, bot }`; `agentId: "cloud"` creates a cloud bot at once |
| DELETE | `/portal/api/bots/pending/:requestId` | cancel a pending create on a machine |
| GET | `/portal/api/bots/cloud/:botId` | a cloud bot's detail and latest messages |
| POST | `/portal/api/bots/cloud/:botId/commands` | `{ action, args }`: `message`, `pause`, `resume`, `check_now`, `stop`, `update_settings`, `delete`, `messages`, `history`, `memory` |
| GET | `/portal/api/bots/cloud/commands/:commandId` | a cloud command's state |
| GET | `/portal/api/bots/:agentId/:botId` | a desktop bot's detail (relayed from its machine) |
| POST | `/portal/api/bots/:agentId/:botId/commands` | a command for a desktop bot |
| GET | `/portal/api/bots/:agentId/commands/:commandId` | a desktop command's state |

### Code from your phone

Session cookie auth. The portal checks the machine is one of the user's enrolled nodes; each coordinator checks verified ownership again. Source: `src/portal/routes/code.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/portal/api/code/machines` | the account's machines with their trusted projects and sessions |
| POST | `/portal/api/code/:agentId/commands` | `{ action, ...args }` for one machine → `202 { commandId }` |
| GET | `/portal/api/code/commands/:commandId` | `{ status: pending \| done \| failed \| expired, result?, error? }` |

### Compute and reservations

Session cookie auth. Source: `src/portal/routes/compute.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/portal/api/compute/summary` | cSats balance and recent activity |
| GET | `/portal/api/compute/options` | where a web chat can run: network models and classes, your own machines, your reservations |
| GET | `/portal/api/compute/reservations` | the account's reservations |
| POST | `/portal/api/compute/reservations` | reserve a machine (paid up front from cSats) |
| POST | `/portal/api/compute/reservations/cancel` | end a reservation early (unused time is refunded) |

## Hosted API (`https://edgecoder.io`)

`Authorization: Bearer eck_…` (or `x-api-key`), an API key from **Settings → Connect your tools**. Requests are billed to the key's account in cSats. Source: `src/portal/routes/hosted.ts`, `src/inference-api/routes.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/models` | models available (OpenAI format) |
| POST | `/v1/chat/completions` | OpenAI chat, streamed or not |
| POST | `/v1/messages` | Anthropic Messages, streamed or not |
| POST | `/v1/messages/count_tokens` | Anthropic token count |
| GET | `/v1/account` | balance and recent usage |
| GET | `/v1/account/usage` | usage records (`?days=N`) |
| POST | `/v1/account/topup` | a Lightning invoice to buy cSats |
| GET | `/v1/account/topup/:intentId` | an invoice's state |
| GET | `/v1/account/reservations` | list reservations |
| POST | `/v1/account/reservations` | create one |
| POST | `/v1/account/reservations/cancel` | cancel one |
| POST | `/v1/tools/web/status`, `/v1/tools/web/search`, `/v1/tools/web/read` | the web tool, billed per call |

Model names: `auto`, `network/<model>[@cpu|apple|gpu|gpu.dc]` (or a bare model), `mine/<model>`, `reserved/<reservation>/<model>`.

## Inference Service

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | service health |
| POST | `/decompose` | decomposition and inference request |
| POST | `/model/swap` | swap active model |
| GET | `/model/status` | current model and health |
| GET | `/model/list` | installed and available models |
| GET | `/model/pull/progress` | active model download progress |

## Models

Mesh-token authentication required.

| Method | Path | Purpose |
|---|---|---|
| GET | `/models/available` | aggregated model availability from capability gossip |

### `GET /models/available`

Returns an array of models currently available across the mesh, assembled from coordinator capability gossip summaries.

**Auth:** mesh token (`MESH_AUTH_TOKEN` or `COORDINATOR_MESH_TOKEN`)

**Response:**

```json
[
  {
    "model": "qwen2.5:7b",
    "paramSize": 7,
    "agentCount": 12,
    "avgLoad": 0.34
  }
]
```

| Field | Type | Description |
|---|---|---|
| `model` | string | Model tag (e.g. `qwen2.5:7b`) |
| `paramSize` | number | Parameter size in billions |
| `agentCount` | number | Number of agents currently serving this model |
| `avgLoad` | number | Average load across serving agents (0.0 -- 1.0) |

## IDE Provider

Local to the desktop app (`127.0.0.1:4304`), IDE token required, loopback only.

| Method | Path | Purpose |
|---|---|---|
| GET | `/models` | model discovery for IDE integration |
| GET | `/model/pull/progress` | active model download progress |
| GET | `/v1/models` | OpenAI model list |
| POST | `/v1/chat/completions` | OpenAI chat |
| GET / POST | `/v1/ide/sessions` | list or create shared coding sessions (the Code view and `edgecoder code`) |
| GET | `/v1/ide/sessions/:id`, `/v1/ide/sessions/:id/events` | a session's snapshot and its event stream (SSE) |
| POST | `/v1/ide/sessions/:id/{messages,unqueue,approve,settings,publish,trust,cancel,undo,clear,delete}` | writes from any attached client |
| GET / POST | `/v1/ide/bots` | desktop bots |
| GET | `/v1/ide/code/remote/snapshot` | Code from your phone: trusted projects and sessions for the account signed in on this machine |
| POST | `/v1/ide/code/remote/command` | Code from your phone: one command (`create`, `message`, `approve`, `cancel`, `undo`, `plan`, `settings`, `unqueue`, or a read such as `snapshot`) |

## Coordinator (public, no auth)

| Method | Path | Purpose |
|---|---|---|
| POST | `/portal/chat` | streaming chat completion for portal/desktop (system prompt injected server-side) |
| GET | `/model/pull/progress` | active model download progress |

### `GET /model/pull/progress`

Returns the current state of an active Ollama model download, or `{"status":"idle"}` when no download is in progress. Available on the coordinator (`:4301`), inference service (`:4302`), and IDE provider (`:4304`).

**Response (download in progress):**

```json
{
  "model": "qwen2.5:7b",
  "status": "pulling",
  "progressPct": 42,
  "completed": 1887436800,
  "total": 4494627840,
  "startedAtMs": 1708900000000
}
```

**Response (idle):**

```json
{ "status": "idle" }
```

| Field | Type | Description |
|---|---|---|
| `model` | string | Model tag being downloaded |
| `status` | string | `"pulling"`, `"error"`, or `"idle"` |
| `progressPct` | number | Download progress 0--100 |
| `completed` | number | Bytes downloaded so far |
| `total` | number | Total bytes expected |
| `startedAtMs` | number | Unix timestamp (ms) when download started |
| `error` | string? | Error message if status is `"error"` |

## Response Schemas

### `GET /stats/network/summary`

Requires `x-mesh-token` header. Returns aggregate counts from the portal database combined with live coordinator state.

```json
{
  "timestamp": 1708900000000,
  "users": { "total": 5, "verified": 3 },
  "nodes": {
    "enrolled": 8,
    "approved": 6,
    "active": 2,
    "agents": 5,
    "coordinators": 3
  },
  "live": {
    "agentsConnected": 1,
    "queueDepth": 0,
    "activeTunnels": 0,
    "modelsAvailable": 2
  }
}
```

- `users` and `nodes` are `null` when the portal is unreachable.
- `live` is always present and derived from in-memory coordinator state.

## Cross-reference

- [API Surfaces](/reference/api-surfaces)
- [Public Mesh Operations Source](https://github.com/codyrs82/Edgecoder/blob/main/docs/public-mesh-operations.md)

## Payment webhook signature

`POST /economy/payments/webhook` requires:

- `x-mesh-token`: the coordinator mesh token (same as other coordinator routes).
- `x-payment-signature: sha256=<hex>` — lowercase hex HMAC-SHA256 of the **raw request body bytes**, keyed with `PAYMENT_WEBHOOK_SECRET`. Compute it over the exact bytes you send (no re-serialization).

Example (sender side):

```bash
body='{"invoiceRef":"lnbc1..."}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$PAYMENT_WEBHOOK_SECRET" -hex | sed 's/^.* //')"
curl -X POST "$COORDINATOR/economy/payments/webhook" \
  -H 'content-type: application/json' -H "x-mesh-token: $MESH_AUTH_TOKEN" \
  -H "x-payment-signature: $sig" --data "$body"
```

Responses: `503 payment_webhook_not_configured` (no secret set), `401 webhook_signature_required` (missing/bad signature), `404 intent_not_found`. The body is only a hint: fields like `settled`/`txRef` are ignored and credits are granted only if the Lightning node reports the invoice as paid.

