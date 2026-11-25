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

`MESH_AUTH_TOKEN` belongs to coordinators and operator tooling only. Agents are never given it
(`/register` no longer returns it; the agent ignores one if an older coordinator sends it). A
registered agent passes the global `onRequest` hook with its own Ed25519 key, over the request's
method and path, and only on the routes agents use (`isAgentGateRoute` in
`src/swarm/coordinator/auth.ts`); every other route behind the hook is coordinator/operator-only.
The token is still never authority for acting on another agent, another account or the operator's
settings. See `docs/security/agent-threat-model.md`. Each route covered by the hook falls into one
of these classes:

| Class | Authority | Routes |
|---|---|---|
| Agent-self | Signed agent request (`verifyAgentRequest`; `/heartbeat`, `/pull` and `/result` follow `REQUIRE_SIGNED_AGENT_REQUESTS`, the rest are signed-only); the agent named in the body or path must be the signer | `/heartbeat`, `/pull`, `/result`, `/benchmark/response`, `/inference/chunks`, `/agent-mesh/connect`, `/accept`, `/relay`, `/close`, `/close-ack`, `/agent-mesh/direct-work/offer`, `/accept`, `/result`, `/agent-mesh/models/request`, `/orchestration/agents/:agentId/status`, `/orchestration/agents/:agentId/ack` |
| Account-scoped | Portal service token (the portal binds `acct-<userId>` from the session), or the signer's own account (`callerAccount`) | `/account/*`, `/economy/market/orders` (POST), `/economy/payouts/*` (portal only) |
| Peer coordinator | Signed by an allowlisted peer key (`MESH_PEER_ALLOWLIST`; enforced whenever it is set and always in production) or a payload signed by a known coordinator key | `/mesh/register-peer`, `/mesh/ingest`, `/mesh/relay-gossip`, `/economy/hosts/heartbeat`, `/stats/ledger/ingest`, `/receipts/replicate`, forwarded `/result` |
| Operator | `authorizeAdmin` (`x-admin-token` = `ADMIN_API_TOKEN`) | `/economy/treasury/policies`, `/economy/treasury/policies/:policyId/activate`, `/economy/issuance/recalculate`, `/economy/issuance/quorum/vote`, `/economy/issuance/anchor`, `/economy/price/propose`, `/economy/price/consensus`, `/economy/payments/intents` (POST), `/economy/payments/intents/:intentId/confirm`, `/economy/payments/reconcile`, `/economy/rates/recalibrate`, `/economy/fee-pool/distribute`, `/orchestration/coordinator/ollama-install`, `/orchestration/agents/:agentId/ollama-install`, `/stats/anchors/anchor-latest`, `/security/blacklist` writes, `/admin/*` |
| Agent reads (signed GET) | The agent's own signature over GET and the path; scoped to the signer | `/agent-mesh/peers/:agentId` (the agent itself), `/inference/models`, `/tasks/:taskId/subtasks/:subtaskId/result` (tasks the signer's account submitted; the mesh token reads any) |
| Coordinator/operator reads | Mesh token (or portal token where noted in code); agents cannot reach these | Status, capacity, ledger/stats reads, market data, issuance/treasury reads, rollout list, `/agent-mesh/models/available`, `/agent-mesh/models/request/:offerId`, hardware verifications, diagnostics reads, receipts |

The control plane forwards operator requests with both the mesh token and its `ADMIN_API_TOKEN`,
which must equal the coordinator's. The portal's `/internal/*` read and validate routes accept
`PORTAL_SERVICE_TOKEN` or `PORTAL_COORDINATOR_TOKEN`; node approval also needs
`CONTROL_PLANE_ADMIN_TOKEN`. The portal sends its service token only to coordinator URLs that
pass `src/portal/coordinator-url-policy.ts`.

Not yet covered by this split: `/escalate*`, `/portal/chat` and the feature-flagged `/robot/*`
routes accept the mesh token alone (coordinators and operators only, since agents no longer hold
it); anonymous `/submit` is open to any signed agent.
Within those limits:

- Anonymous `/submit` work earns nothing: an agent is paid only out of what a requester set aside.
- `/escalate/:taskId/result` takes one report from the resolver; once an escalation is settled only
  the portal service token (a reviewer's decision) can change it. `/escalate/*` also accepts the
  portal service token, which the portal's review pages send.
- `/portal/chat` failover to a peer coordinator sends the mesh token, never the portal service token.
- `/robot/agents/register` cannot change an existing robot agent's payout address.

Mesh-token reads leave out personal data: `/capacity` and `/stats/projections/summary` omit owner
email, source IP, country and VPN flag (the portal token still gets them on the summary), and
`/agent-mesh/direct-work/audit` omits each job's input and result unless `x-admin-token` is sent.

`/mesh/ws` relays task offers (which carry task input) only to connections bound with a signed bind;
an unsigned bind may not take the id of a registered peer coordinator.

Signed agent requests whose signature does not verify are counted against the client address
(`PREAUTH_FAILURE_MAX_PER_IP`), never against the agent id they name; only a request proven to come
from the agent's key (a body mismatch on a valid signature, a nonce replay) counts toward that
agent's behaviour checks. A verified request over the agent's own rate limit
(`AGENT_RATE_LIMIT_MAX` per `AGENT_RATE_LIMIT_WINDOW_MS`) is answered `429 agent_rate_limited` with
`Retry-After`, not 401: it is not a protocol violation and feeds no behaviour rule, and it is logged as
`agent_rate_limited` (INFO), which does not alert. Streamed reply pieces (`/inference/chunks`) count
against their own budget, `AGENT_CHUNK_RATE_LIMIT_MAX`, and so do results and lease-only heartbeats,
`AGENT_LEASE_RATE_LIMIT_MAX`, so pulls cannot starve the requests that keep a claim's lease alive;
a refused result or lease heartbeat is logged as `agent_lease_traffic_rate_limited` (WARN, once a
minute per agent). Every budget grows by its `*_PER_SLOT` setting for each parallel model slot the
agent reports (at most 16). Workers wait the
`Retry-After` and carry on; they do not re-register (re-registering on refusals is what the
registration-storm rule BHV008 punishes).
