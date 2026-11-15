# Agent threat model: the user who installs the agent

Status: review of branch `sec/agent-attacker-review` (from `a70c22b`), November 2026.

## Attacker

A user who installs the EdgeCoder agent (desktop app or headless agent) and controls everything on
their machine:

- the agent binary and its source;
- its Ed25519 signing key, its X25519 envelope key, its config and local database;
- every request it sends to the coordinator, including bodies, timings and reported metrics;
- its local Ollama, so any output and any token count;
- anything the coordinator sends it.

They can enrol several agents under one portal account, and can open several accounts at the cost of
a verified email each. They do not hold the coordinators' admin token, the portal service token, any
other user's keys, or (after this change) the coordinators' `MESH_AUTH_TOKEN`.

The owner's three goals: an agent install must not be a path to

1. get into other users' agent computers;
2. steal or redirect bitcoin/cSats;
3. deny service to the network.

## Assets

| Asset | Where |
|---|---|
| Other users' machines (code execution, files, network) | their agents, sandbox (`src/executor/docker-sandbox.ts`) |
| Other users' prompts, code and results | queue, `/tasks/*/result`, inference streams, BLE offload |
| cSats balances, accruals, held earnings | coordinator ledger (`src/credits`, `src/ledger`, Postgres) |
| Bitcoin: Lightning node funds, payout destinations | `src/economy/lightning.ts`, payouts, portal wallet |
| Agent identity: agent id ↔ key ↔ owner account | `agentCapabilities`, `agent_ownership`, portal enrolments |
| Network availability: queue, coordinator memory, honest agents' standing | queue, registries, behaviour rules/blacklist |
| Coordinator identity and the coordinators' shared secret | coordinator keys, `MESH_AUTH_TOKEN`, `MESH_PEER_ALLOWLIST` |
| Update channel | release signing (minisign), Tauri updater, steering registry |

## Trust boundaries

1. **Agent → coordinator.** Every request crosses it. Authentication is the agent's own Ed25519
   signature over timestamp, nonce, method, path and the body hash
   (`src/security/request-signing.ts`), checked against the key the coordinator holds for that
   agent id. Since this change agents hold no shared coordinator secret.
2. **Coordinator → agent.** Responses to agent requests are signed with the coordinator's identity
   key (`src/trust/response-signing.ts`). The agent verifies them against a pinned key: TOFU by
   default, strict with seed keys for `*.edgecoder.io` installs. Work, orchestration commands and
   blacklist updates reach agents only this way, or over the mesh WebSocket as coordinator-signed gossip.
3. **Coordinator ↔ coordinator.** Allowlisted peer keys (`MESH_PEER_ALLOWLIST`, #52/#118), plus the
   mesh token as a transport gate. This change does not alter it.
4. **Portal ↔ coordinator.** Portal service token; the portal binds `acct-<userId>` from the session.
5. **Agent ↔ agent.** BLE (local radio), the agent mesh HTTP server, peer-direct work and tunnels
   relayed through the coordinator. No direct agent-to-agent trust exists apart from
   coordinator-mediated identities.
6. **Buyer → worker.** Buyer-supplied prompts and code run on workers, inside the sandbox for code.

## Entry points the agent touches

Coordinator routes that agents may reach without the coordinators' token are listed in
`isAgentGateRoute` (`src/swarm/coordinator/auth.ts`). They are:

- `/heartbeat`, `/pull`, `/result`, `/benchmark/response`;
- `/agent/diagnostics`, `/credits/ble-sync`;
- `/submit`, `/inference/{submit,stream,chunks}`;
- `/account/*`, `POST /economy/market/orders`;
- `/agent-mesh/*` (signed, agent-self);
- `/orchestration/agents/:id/{status,ack}`;
- signed GETs of `/inference/models`, `/agent-mesh/peers/:self` and `/tasks/:t/subtasks/:s/result`
  (results of the signer's own account only).

Unauthenticated routes: `/register`, `/identity`, the identity challenge, `/health/runtime`, discovery
and registry mirrors.

Listeners on an agent install:

| Listener | Bind | Auth |
|---|---|---|
| Agent mesh HTTP server (random port) | `AGENT_MESH_HOST`: 127.0.0.1 by default, including in the Docker image; set 0.0.0.0 to opt in to LAN gossip | `/identity` open. `/mesh/ingest` accepts only messages from trusted peers (the verified coordinator and the peers it listed), signed by the key on file; an operator-configured token is also checked if set. `/mesh/peers` and `/mesh/register-peer` need an operator-configured token. |
| Local forwarder (`LOCAL_FORWARD_PORT`) | 127.0.0.1 | IDE token; browser (Origin) requests refused |
| IDE provider 4304 | 127.0.0.1 unless `IDE_PROVIDER_HOST` (then a token is required) | token, CORS, Host allowlist |
| All-in-one / desktop 4301, 4302, 4303 | `LISTEN_HOST` (127.0.0.1 in the desktop app) | coordinator global hook, `INFERENCE_AUTH_TOKEN`, `ADMIN_API_TOKEN` |
| BLE (macOS, `EDGECODER_BLE`) | radio | `BleRequestGuard`: requires a proof keyed with an operator-configured mesh token; without one, remote BLE work is refused |
| Mesh WebSocket | outbound to the verified coordinator only | signed bind by the agent key |

## 1. Lateral movement to other agents

**Current controls**

- The sandbox (`buildDockerArgs`) runs with:
  - `--pull=never`, digest-pinned images built locally;
  - `--network=none`, `--read-only`;
  - 256 MB of memory and no extra swap, 0.5 CPU, `--pids-limit=50`;
  - `--cap-drop=ALL`, `no-new-privileges`, uid 65534, a noexec tmpfs, `nofile=256`;
  - a timeout and an output cap.
- Remote-origin code never runs on the host. The machine owner picks the sandbox mode; neither the
  buyer nor the coordinator can.
- Mesh `task_offer` is queued only when sender id and key equal the coordinator identity the worker
  verified (`isFromIdentity`). `task_claim` is accepted only from trusted peers.
- Orchestration (model pull, Ollama install) is admin-only on the coordinator. The agent accepts only
  Ollama-library model names (`isOllamaLibraryModelName`) and never installs binaries from it.
- Agent-mesh tunnels relay only a counter. Direct-work routes are signed agent-self.

**Gaps found and fixes**

- **Every agent was handed the coordinators' `MESH_AUTH_TOKEN` in `/register`.** With it, anyone who
  installed the agent could:
  - read fleet-wide coordinator routes: `/capacity` (all agents' hardware, power and diagnostics),
    `/mesh/peers`, hardware verifications, other accounts' market orders, receipts, stats, rollouts;
  - call `/escalate`, which is unbilled coordinator LLM inference and can overwrite pending
    escalation results;
  - present the token to other agents' mesh HTTP servers to self-register and send signed gossip.

  Fixed (commit "Agents no longer receive the coordinators' mesh token"):
  - The token is not returned, and the worker ignores one if an older coordinator sends it.
  - The global hook admits a registered agent by its own signature, only on agent routes; agent
    GETs are signed and scoped.
  - `/mesh/ws` admits agents by their signed bind. A coordinator peer's id binds only with that
    peer's key, so an agent registered under a coordinator's id cannot take its gossip.
  - The agent mesh server hears trusted senders only.
  - The iOS app no longer treats "has a mesh token" as "registered" (Swift change, not compiled
    here: no iOS SDK on the review machine).
- **Direct-work offers had no size, count or lifetime bound.** They are pushed into the target's
  heartbeat and auto-accepted by the target's worker (power policy permitting). Fixed: input at most
  64 KiB, at most 16 pending offers per target, a 10 min expiry, and offers forgotten after 1 h.

**Residual risk**

- **Prompt injection.** Direct work and network jobs run buyer- or peer-supplied prompts on the
  worker's model. For code tasks the model's code runs in the sandbox. A buyer can steer what the
  worker's model writes, but only into the sandbox (no network, no host files). Returned output
  goes back to the buyer's tools: a malicious worker can return output crafted to prompt-inject the
  buyer's IDE agent or tools. Mitigations are on the buyer side: treat swarm output as untrusted
  input, show diffs before applying, and do not auto-execute tool calls from network results.
  Result verification (when enabled) catches divergent outputs only for verifiable kinds.
- **Unpaid, cross-user direct work.** Any agent can still ask another agent's model to work for
  free, now bounded. Owner decision. Proposed default: allow direct work only between agents of
  the same owner account, or charge it like a network job.
- **Sandbox kernel sharing.** No gVisor or userns-remap, and seccomp is Docker's default unless
  `SANDBOX_SECCOMP_PROFILE` is set. On Linux installs the agent user is in the `docker` group, so a
  compromise of the agent process is root on that host (not a cross-user path by itself). Task code
  is passed on argv and is visible in `ps` to local users.
- **Model pulls.** An admin-forced model pull may name any user's Ollama-library model
  (`user/model`) with no size cap. Only an operator can trigger it.
- **Agent Docker image.** It binds the mesh server on 0.0.0.0. It now accepts only trusted,
  signed gossip, but the port is still reachable from the LAN.
- **Desktop local coordinator (4301).** It binds 127.0.0.1 with no Host-header check. Exposure to
  DNS rebinding from a web page was not traced; it is listed for follow-up.

## 2. Theft of bitcoin/cSats

**Current controls (verified in code and tests)**

- `/result`:
  - the signer must be the claimant;
  - a result after the lease lapsed is rejected;
  - accrual is idempotent per subtask;
  - the task id comes from the claim;
  - peer-forwarded results need an allowlisted coordinator signature and the agent's signed envelope.
- Duration is measured on the coordinator's clock and capped by the timeout. Pay is capped by what
  the requester set aside.
- Inference token counts are bounded by request and reply size.
- Withdrawals, payout address and LNURL confirm need the portal token. Payment intent confirm and
  reconcile are admin-only, and the payment webhook needs an HMAC.
- Market orders are limited to the signer's own account.
- BLE sync:
  - both v3 signatures are checked against registered keys;
  - account ids must match the current reward accounts;
  - deduplication and a balance check are atomic;
  - at most 100 credits per transaction.
- Re-registering a known agent without a token requires proof of the stored key.

**Gaps found and fixes**

- **Agent-id takeover through the portal's device fallback.**
  - `/internal/nodes/validate` returns the device's canonical node when the named node is not
    enrolled.
  - The coordinator linked ownership to, and accepted a new key for, the agent id the caller named.
  - So a user's own valid token could re-key another user's agent id (or the coordinator's embedded
    worker) and redirect its in-flight claims and later earnings.
  - Fixed (`portalBindDecision`): ownership never moves between portal users, and a known agent
    bound through another node's token needs proof of its stored key.
- **BLE credit inflation.** The offline requester signed the CPU time the provider reported. Fixed:
  the requester signs at most the request's elapsed time on its own clock. (The iOS requester is a
  separate Swift implementation; it needs the same cap.)
- **Free compute through "anonymous" `/submit`.** Any signed agent could submit unbilled jobs, and
  the honest workers that ran them were paid nothing. Fixed: a remote agent asking for "anonymous"
  is billed to its owner.

**Residual risk (owner decisions)**

- **Fake work is paid when verification is off.** `RESULT_VERIFICATION_RATE` defaults to 0. An agent
  can claim a code job, wait, and return any output; it is paid up to the reserve. Proposed: enable
  sampling (e.g. 5 to 10% of verifiable kinds) by default in production. The behaviour-rule flags
  below rely on it.
- **Inference padding.** An agent can stream filler and report output tokens up to the reply size.
  The cost to the requester is bounded by the reserve. Inference is not verified.
- **Hardware witness.** Fixed: one witness's cross-check mismatch no longer demotes. The prompt goes
  to a second witness (not the subject or the first witness, nor their owner or IP). Only if it also
  disagrees is the subject demoted to its base tier (`cross_check_mismatch`). If it agrees, the
  subject is verified and the first witness's disagreement is counted on its record
  (`witnessDisagreements`) and logged as `hardware_witness_disagreement`. No second witness, or one
  that times out, settles unconfirmed at base tier, never invalid. Residual: two colluding witnesses
  on separate accounts can still demote an honest agent, and a disagreeing witness is recorded but
  not yet penalised.
- **Sybil replicas.** Replicas exclude the executor's agent and account only. A second account can
  claim the replica and agree with a forged result.
- **Reserved agents** are paid for time held. The work during a reservation is not checked.
- **Agent ids and account ids share a namespace.** An agent with no ownership row is its own
  account. Portal node ids reserve `acct-`; the coordinator's `/register` does not.
- **`MESH_AUTH_TOKEN` rotation.** Every agent registered before this change holds the current
  token. Until it is rotated, any such install can still use it on coordinator-only routes. Rotate
  it once coordinators and agents run this change.

## 3. Denial of service

**Current controls**

- Per-agent signed-request rate limit (429 with Retry-After) and per-IP pre-auth failure counter.
- Production gossip ingest: allowlisted peers only, 50 messages per 10 s per peer.
- Lease liveness and hard deadline.
- Bounded maps: `preAuthFailures`, expired holders, trades, diagnostics, relay windows.
- `agentCapabilities` pruned after 1 h.
- Behaviour-rule violations are recorded only after the signature verifies, so nobody can frame
  another agent with forged signatures.

**Gaps found and fixes**

| Gap | Fix |
|---|---|
| Unauthenticated `/register` with an unbounded agent id: each denied attempt appended a signed audit record (kept in memory forever, written to the ledger) and made a portal call | agentId 1 to 128 chars, no control characters; denied registrations counted per client address, 429 before any work once over the limit |
| Claim hoarding: no per-agent cap on open claims; an expired holder could re-claim and burn every retry, failing any subtask | `max(maxConcurrentTasks, 16)` open claims per agent; a second lease lapse on a subtask bars that agent from it |
| A buyer could get honest workers blacklisted: three `print('OK')` jobs tripped BHV003 (CRITICAL, instant blacklist, gossiped to every coordinator); empty and tiny outputs added strikes | BHV002, BHV003 and BHV010 flag the agent for re-execution verification and never strike |
| Direct-work offers: unbounded size, count and lifetime, all carried in the victim's heartbeat | see section 1 |
| Inference streams: tool calls not counted against the size cap; a stream that never finished was never freed | 8 MB cap on everything in a stream; streams dropped 2 h after opening |
| Lightning invoice flood: every `/account/buy` created a real invoice and an intent never pruned; the reconcile loop reads the 500 oldest | at most 5 open invoices per account |
| Sybil: any number of agents per account, each auto-approved | `PORTAL_MAX_AGENTS_PER_ACCOUNT`, default 25 (proposed default) |
| Unsigned `/agent/diagnostics` could overwrite any agent's diagnostics | the signer must be the named agent |

**Residual risk**

- **BHV004 (success collapse) still strikes.** A buyer can submit programs that exit non-zero, and
  failed results count. Proposed: tell agent-side failures (model down, sandbox down) apart from
  the program's exit status in the result, and count only the former.
- **BHV009 (duration "robot precision")** strikes on a standard deviation under 50 ms over 10 or
  more tasks. Durations are server-measured and include model and container start-up, so a buyer
  can hardly force this, but it was not tested against real workloads.
- **With verification off**, the content rules only log. An agent returning canned output is not
  caught by them (see section 2).
- **Per-agent limits still scale** with the agent cap times the number of accounts.
- **In-memory growth over time.** `queue.results` and the in-memory ordering chain grow with
  legitimate traffic. They are bounded per request now, but not over time.
- **Unpaid inference requests to a chosen agent** (`/agent-mesh/models/request`) and tunnel close
  notices are rate-limited and now inbox-capped, but not charged.
- **The order-book clearing price** can be pushed down by claiming at ask=1. It is used for display
  and coordinator selection only.

## 4. Supply chain and update path

**Current controls**

- `deploy/install.sh`:
  - pinned minisign key and signed `SHA256SUMS`;
  - the trusted comment is bound to the release tag;
  - Node and Ollama are pinned by SHA-256;
  - no curl-into-shell.
- The desktop Tauri updater uses a pinned minisign public key.
- Coordinator identity is pinned (`src/trust/pinned-keys.ts`):
  - `EDGECODER_TRUST_MODE=tofu` by default; installs for `*.edgecoder.io` use strict mode with seed
    keys;
  - an identity challenge proves key possession;
  - responses are signed and nonce-bound, and in optional mode downgrades are refused once a
    signer was seen;
  - a pinned mismatch stops the agent.
- The steering registry is Ed25519-signed with expiry and a rollback floor. It is off by default
  (no keys configured).

**What a malicious coordinator or a network attacker can do**

- **On http deployments**, a network attacker sees the registration token and request bodies.
  Request signatures prevent tampering. Response signing and pinning prevent impersonation once a
  key is pinned.
- **In TOFU mode, the first contact is trusted.** An attacker who controls DNS or the network at
  first install can pin their own coordinator. Strict mode with seed keys (`*.edgecoder.io`) closes
  this.
- **A malicious coordinator, by design**, can:
  - send code and prompts (sandboxed);
  - ask for benchmarks;
  - see the agent's results and telemetry;
  - with its admin token, make agents pull Ollama-library models.

  It cannot install binaries or run code outside the sandbox through orchestration. It does not
  learn the agent's keys.
- **Binary attestation is advisory.** An agent can claim a "verified" binary without running it, so
  `REQUIRE_VERIFIED_AGENTS` proves little against this attacker. Agent-side controls are not
  enforceable on a machine the attacker owns. Everything above is enforced on the coordinator.

**Done:** the agent's mesh server binds `AGENT_MESH_HOST` (default 127.0.0.1), not the container's `HOST`.

**Not changed here (protected paths):** `deploy/**`, `Dockerfile*`, `.github/**`. Proposed:

- make https mandatory for non-loopback coordinator URLs in the installer.
