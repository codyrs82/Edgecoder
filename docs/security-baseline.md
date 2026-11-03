# Security Baseline

## Model Supply Chain

- Only allow approved model sources.
- Require checksum and signature validation before model activation.
- Reject unsigned or mismatched manifests.

## Runtime Controls

- Swarm workers must run in sandbox mode.
- Enforce policy constraints (CPU, memory, schedule, idle-only).
- Use frozen snapshots for job inputs.

## Data Handling

- Minimal cloud-review payloads only.
- Redact known secret patterns before any cloud handoff.
- Keep auditable lifecycle logs for job submit/assign/complete/requeue.

## Identity and Trust

- Agent registration includes OS/version/mode.
- Policy is server-authoritative and refreshed on heartbeat.
- Attestation hooks reserved for enterprise deployments.

## Coordinator route authority

Every enrolled agent receives `MESH_AUTH_TOKEN`, so the coordinator treats it as a transport gate
(the global `onRequest` hook) and never as authority for acting on another agent, another account
or the operator's settings. Each route covered by the hook falls into one of these classes:

| Class | Authority | Routes |
|---|---|---|
| Agent-self | Signed agent request (`verifyAgentRequest`; `/heartbeat`, `/pull` and `/result` follow `REQUIRE_SIGNED_AGENT_REQUESTS`, the rest are signed-only); the agent named in the body or path must be the signer | `/heartbeat`, `/pull`, `/result`, `/benchmark/response`, `/inference/chunks`, `/agent-mesh/connect`, `/accept`, `/relay`, `/close`, `/close-ack`, `/agent-mesh/direct-work/offer`, `/accept`, `/result`, `/agent-mesh/models/request`, `/orchestration/agents/:agentId/status`, `/orchestration/agents/:agentId/ack` |
| Account-scoped | Portal service token (the portal binds `acct-<userId>` from the session), or the signer's own account (`callerAccount`) | `/account/*`, `/economy/market/orders` (POST), `/economy/payouts/*` (portal only) |
| Peer coordinator | Signed by an allowlisted peer key (`MESH_PEER_ALLOWLIST`; enforced whenever it is set and always in production) or a payload signed by a known coordinator key | `/mesh/register-peer`, `/mesh/ingest`, `/mesh/relay-gossip`, `/economy/hosts/heartbeat`, `/stats/ledger/ingest`, `/receipts/replicate`, forwarded `/result` |
| Operator | `authorizeAdmin` (`x-admin-token` = `ADMIN_API_TOKEN`) | `/economy/treasury/policies`, `/economy/treasury/policies/:policyId/activate`, `/economy/issuance/recalculate`, `/economy/issuance/quorum/vote`, `/economy/issuance/anchor`, `/economy/price/propose`, `/economy/price/consensus`, `/economy/payments/intents` (POST), `/economy/payments/intents/:intentId/confirm`, `/economy/payments/reconcile`, `/economy/rates/recalibrate`, `/economy/fee-pool/distribute`, `/orchestration/coordinator/ollama-install`, `/orchestration/agents/:agentId/ollama-install`, `/stats/anchors/anchor-latest`, `/security/blacklist` writes, `/admin/*` |
| Transport-gated reads | Mesh token (or portal token where noted in code) | Status, capacity, ledger/stats reads, market data, issuance/treasury reads, rollout list, `/agent-mesh/peers/:agentId`, `/agent-mesh/models/available`, `/agent-mesh/models/request/:offerId` (offer ids are random) |

The control plane forwards operator requests with both the mesh token and its `ADMIN_API_TOKEN`,
which must equal the coordinator's. The portal's `/internal/*` read and validate routes accept
`PORTAL_SERVICE_TOKEN` or `PORTAL_COORDINATOR_TOKEN`; node approval also needs
`CONTROL_PLANE_ADMIN_TOKEN`. The portal sends its service token only to coordinator URLs that
pass `src/portal/coordinator-url-policy.ts`.

Not yet covered by this split: `/agent/diagnostics` (POST), `/escalate*`, `/portal/chat`,
anonymous `/submit` and the feature-flagged `/robot/*` routes still accept the mesh token alone.
