# API Endpoints Detailed

This page provides a practical endpoint-level index grouped by service.
Authentication and payload specifics should be validated against runtime code and source docs.

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
| POST | `/economy/payments/intents/:intentId/confirm` | confirm settlement |
| POST | `/economy/payments/reconcile` | reconcile pending intents |
| GET | `/economy/issuance/rolling/:accountId` | rolling issuance/account view |
| GET | `/economy/issuance/quorum/:epochId` | quorum state for issuance epoch |
| POST | `/economy/issuance/anchor` | publish/advance issuance anchor |
| GET | `/economy/issuance/anchors` | list issuance anchors |
| POST | `/economy/issuance/reconcile` | reconcile issuance state |
| GET | `/economy/issuance/current` | current issuance state |
| GET | `/economy/issuance/history` | issuance history |
| GET | `/stats/projections/summary` | federated stats summary |
| POST | `/stats/anchors/anchor-latest` | update latest stats anchor |
| GET | `/stats/anchors/verify` | verify stats anchor/finality |
| GET | `/mesh/capabilities` | federated capability summaries |
| POST | `/credits/ble-sync` | sync offline BLE credit transactions |

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
| GET | `/portal/coordinator-ops` | coordinator operations dashboard |
| GET | `/wallet/onboarding` | wallet bootstrap flow |
| POST | `/wallet/onboarding/acknowledge` | wallet backup acknowledgement |

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

| Method | Path | Purpose |
|---|---|---|
| GET | `/models` | model discovery for IDE integration |
| GET | `/model/pull/progress` | active model download progress |

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

## Cross-reference

- [API Surfaces](/reference/api-surfaces)
- [Public Mesh Operations Source](https://github.com/codyrs82/Edgecoder/blob/main/docs/public-mesh-operations.md)
