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
| Bitcoin: Lightning node funds (channels and the on-chain wallet), payout destinations | `src/economy/lightning.ts`, `src/economy/onchain*.ts`, payouts, portal wallet |
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
   The owner's model commands are coordinator-signed frames down the agent's authenticated mesh
   WebSocket ([Remote model control](#remote-model-control)).
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
- `/orchestration/agents/:id/{status,ack}`, `/agent-control/agents/:id/report` (signer = `:id`);
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
  Ollama-library model names (`isOllamaLibraryModelName`) and never installs binaries from it. An
  admin model rollout now passes the same host policy as the owner's commands (below): refused with
  `AGENT_REMOTE_CONTROL=off`, and only for models on the host's allowlist.
- Owner model commands ([Remote model control](#remote-model-control)) reach only the owning
  account's machines, are signed by the agent's pinned coordinator, and are bounded by the host.
- Agent-mesh tunnels relay only a counter. Direct-work routes are signed agent-self, and direct work
  is same-account only (below).

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
  - Agents gossip to coordinators only down the signed mesh WebSocket. The HTTP gossip routes
    (`/mesh/ingest`, `/mesh/relay-gossip`) stay behind the coordinators' token; an agent without it
    no longer tries them every 30 s (which logged 401 `mesh_unauthorized` and marked the
    coordinator NATed). An agent an operator gave the token keeps the HTTP path.
  - The iOS app no longer treats "has a mesh token" as "registered" (Swift change, not compiled
    here: no iOS SDK on the review machine).
- **Direct-work offers had no size, count or lifetime bound.** They are pushed into the target's
  heartbeat and auto-accepted by the target's worker (power policy permitting). Fixed: input at most
  64 KiB, at most 16 pending offers per target, a 10 min expiry, and offers forgotten after 1 h.
- **Unpaid, cross-user direct work.** Any agent could have another user's agent run code or model
  calls for it, unbilled, outside the market. Fixed (owner decision: same account only,
  `src/swarm/direct-work-policy.ts`):
  - The coordinator relays a direct-work offer or model request only when both agents have a
    verified ownership row (the portal-linked agent → account mapping) naming the same account. The
    sender's claims play no part. An agent with no ownership row does no direct work at all: its id
    would double as an account id, and `/register` does not stop an agent from taking an id equal
    to another user's account id.
  - Refusals are logged (`direct_work_offer_refused`, `direct_work_model_request_refused`) and
    answered `403 direct_work_cross_account` (or `direct_work_account_unverified`) with a message
    and `market: "/submit"` pointing the sender at the market. Accepting re-checks both accounts.
  - The receiving worker runs an offer only when the coordinator's signed heartbeat names the
    sender's account (`fromAccountId`) and it equals the account the coordinator named in its signed
    `/register` response; it refuses and logs everything else, including any offer from a
    coordinator that predates this check. A sending worker backs off an hour from a peer that
    refused it.

**Residual risk**

- **Prompt injection.** Direct work and network jobs run buyer- or peer-supplied prompts on the
  worker's model. For code tasks the model's code runs in the sandbox. A buyer can steer what the
  worker's model writes, but only into the sandbox (no network, no host files). Returned output
  goes back to the buyer's tools: a malicious worker can return output crafted to prompt-inject the
  buyer's IDE agent or tools. Mitigations are on the buyer side: treat swarm output as untrusted
  input, show diffs before applying, and do not auto-execute tool calls from network results.
  Result verification (when enabled) catches divergent outputs only for verifiable kinds.
- **Direct work within one account** is still unbilled and unverified, by design: the account pays
  for its own machines. Workers older than this change still accept whatever a coordinator relays;
  the coordinator check covers them once coordinators run this change. Without a database
  (in-memory dev coordinators) no agent has an ownership row, so direct work is off there.
- **BLE peer work** is not covered by this rule: it is gated by an operator-configured mesh token and
  settled through BLE credit sync.
- **Sandbox kernel sharing.** No gVisor or userns-remap, and seccomp is Docker's default unless
  `SANDBOX_SECCOMP_PROFILE` is set. On Linux installs the agent user is in the `docker` group, so a
  compromise of the agent process is root on that host (not a cross-user path by itself). Task code
  is passed on argv and is visible in `ps` to local users.
- **Model pulls (replaced).** An admin-forced pull could name any Ollama-library model with no size
  cap. Now every remote pull (the owner's or an operator's) must be on the host's allowlist (the
  curated catalog by default, `AGENT_MODEL_ALLOWLIST` to change it) and fit the disk and memory;
  `AGENT_REMOTE_CONTROL=off` refuses all of them. What is left: an allowlisted catalog model is still
  a third-party download from registry.ollama.ai (its weights are not pinned by digest), and an
  operator who extends the allowlist with `namespace/model` tags trusts that namespace.
- **Agent Docker image.** It binds the mesh server on 0.0.0.0. It now accepts only trusted,
  signed gossip, but the port is still reachable from the LAN.
- **Desktop local coordinator (4301).** It binds 127.0.0.1 with no Host-header check. Exposure to
  DNS rebinding from a web page was not traced; it is listed for follow-up.

## Remote model control

The owner manages each machine's models from the portal (Settings > Nodes): pull, select, remove,
context window, parallel slots, keep-alive, reload. Code: `src/model/remote-control/`,
`src/swarm/coordinator/model-control.ts`, `src/swarm/coordinator/routes/model-control.ts`,
`src/portal/routes/machines.ts`.

**Chain of authority**

1. **Owner → portal.** The portal session names the user; the account is always
   `acct-<session user>`, never taken from the request. The portal also checks the machine is one of
   the user's enrolled agent nodes before calling any coordinator.
2. **Portal → coordinator.** `POST /agent-control/agents/:id/commands` with the portal service token
   and `{accountId, action, args}`. The coordinator looks up the agent's verified ownership row
   (`verifiedAccountOf`, the portal-linked `agent_ownership` mapping) and refuses unless it names that
   account: `403 not_your_machine`, the same answer for another account's machine and for a machine
   with no ownership row, logged as `model_control_not_owner` (HIGH). An agent cannot bind its id to
   an account by itself (see `portalBindDecision`).
3. **Coordinator → agent.** The command is a `model_control` frame:

   ```
   { type: "model_control",
     command: { v: 1, id, agentId, coordinatorId, requestedBy, issuedAtMs, expiresAtMs, action, args },
     signature }   // Ed25519 by the coordinator's identity key over
                   // "edgecoder-model-control-v1\n" + canonical JSON (sorted keys) of command
   ```

   It goes only down a mesh WebSocket whose bind proved the agent's registered key (never an unsigned
   bind, never a peer coordinator's socket, never HTTP to the agent). Its lifetime is at most 2 minutes.
4. **Agent.** It accepts the frame only if the signature verifies against the coordinator identity
   its trust gate proved (the pinned key: TOFU, or strict seeds), `coordinatorId` is that identity,
   `agentId` is its own, the command is not expired, at most 60 s in the future, with a lifetime of at
   most 2 minutes, and its `id` is new (a replay cache keeps ids until they expire and refuses new
   commands when full of live ones). The strict schema rejects any field the signature did not
   cover. Only then does the host's policy apply:
   - `AGENT_REMOTE_CONTROL=off`: view only (the state is still reported);
   - models: Ollama library names only, and on `AGENT_MODEL_ALLOWLIST` (default: the catalog);
   - pulls: the size (catalog, else the registry manifest, else refused) must fit the free disk
     (download + 10% + 2 GiB) and the memory (VRAM + half the RAM, or 75% of the RAM); one at a
     time; aborted after 3 h;
   - settings: context 2048 to 131072, slots 1 to 8, keep-alive `-1`, `0` or up to 24 h;
   - remove: never the active model, never a model loaded in Ollama;
   - at most 30 commands per 10 minutes.
5. **Agent → coordinator.** Results, progress and state go back as signed agent requests
   (`/agent-control/agents/:id/report`; the signer must be `:id`). A result is accepted only for a
   command this coordinator sent to that agent, and never after it settled. State is capped at 64 KB
   and the portal shows it only after HTML escaping.

**Rate limits (coordinator):** 30 commands per account and 12 per machine per 10 minutes, one open
pull per machine, one refresh per machine every 5 s.

**Audit:** every command except refresh: account, machine, action, arguments, time, status
(`sent`, `accepted`, `progress`, `done`, `refused`, `failed`, `undelivered`, `expired`) and the
agent's error or message. Kept in memory per agent (50) and in Postgres when configured
(`ollama_rollouts`, `target_type = 'model-control'`); shown to the owning account under the machine.

**Persistence without root:** the agent cannot write `/etc/edgecoder/agent-N.env` or the units.
Remote settings go to `<config dir>/model-overrides.json` in the agent's own state directory (mode
0600, atomic rename), checked against the same bounds when loaded (bad values and unknown keys are
ignored). Each entry records the env value it replaced; when the env no longer has that value (the
operator or the desktop app changed it locally), the local value wins and the entry is dropped.
Ollama's server-side `OLLAMA_NUM_PARALLEL` is in the Ollama unit and is not changed remotely: the
agent sends at most its slot count, and calls past Ollama's limit queue (the installer's `--parallel`
changes both). `num_ctx` and `keep_alive` are sent with each request.

**What a compromised party can do**

- *Portal (service token):* send any allowlisted, bounded command to any owned machine, as any
  account. It cannot install binaries, name a model off the allowlist or exceed the bounds; hosts
  with `AGENT_REMOTE_CONTROL=off` are untouched. (The service token already reaches every account's
  balance; it is a high-value secret either way.)
- *Coordinator (identity key):* the same for the agents that pinned it, without the ownership check.
- *Another user:* nothing; the ownership check runs on the coordinator, from the verified mapping.
- *Network attacker on the WebSocket:* cannot forge or alter a frame (signature), redirect it to
  another agent (`agentId` is signed), or replay it (id cache, 2-minute lifetime).
- *A user's own agent:* can report a false state for itself (its own machine) and nothing about
  any other agent.

**Residual risk**

- The Postgres audit rows share `ollama_rollouts`, which mesh-token holders can list
  (`/orchestration/rollouts`): coordinators see which account changed which machine's models.
- A coordinator without a database keeps the audit in memory only (lost on restart); its agents
  have no ownership rows, so no remote control is possible there at all.
- The desktop app's own machine view does not show remote commands yet (the portal does).

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
- Inference token counts are bounded by request and reply size, and by the call's output cap.
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
- **Inference padding.** An agent serving a network model call could stream filler and bill output
  tokens for it, up to the reply size and the reserve; output is never verified. Fixed in two layers:
  - *Output cap.* A call with no `maxTokens` gets `INFERENCE_DEFAULT_MAX_TOKENS` (4096, the size
    the context sizing already assumed). The output tokens a call is priced on never exceed its cap
    + 64, whatever the agent streams or reports (`boundTokenCounts`). The reserve is unchanged: it
    is time-based and also covers the per-second power floor.
  - *Degenerate-output detector* (`src/swarm/inference-degeneracy.ts`). When a call settles, the
    coordinator judges the text it relayed to the requester. Signals, earliest wins: a unit of 1 to
    64 words (or, inside a whitespace-free run, 1 to 32 characters) repeated 10+ times in a row over
    2,000+ characters; a 4 KB window that deflates 32x or more; one word (with a letter in it) making
    up 60%+ of 200-word windows over 2,000+ characters. Replies under 2,000 characters are never
    judged. From the point the reply turns degenerate (after the first copy of a repeated unit)
    nothing is billed: output tokens and the measured duration are cut to the clean byte share, so
    neither the token price nor the power floor pays for the padding, and the rest of the reserve
    returns to the requester. Each case is a security event (`inference_output_degenerate`). An
    agent with 3+ degenerate replies that make up half or more of its model calls in an hour gets a
    behaviour strike (`INF001`, WARN) for each further one; three strikes in an hour blacklist it
    (expiring). One degenerate reply alone is never a strike: honest small models loop at
    temperature 0 now and then.
  - Calibration: no slice of this repository's source and docs (`src/swarm`, `docs`, tested as
    32 KB replies) is flagged; generated JSON fixtures, hex dumps, markdown tables and separators
    deflate at most ~25x and are not flagged either (`tests/swarm/inference-degeneracy.test.ts`).

  Residual: padding that varies (a counting loop, random words, plausible filler from a cheaper
  model) passes the detector; the output cap bounds it, at worst `maxTokens` of the reply. A reply
  that is legitimately repetitive (a 1,000-element zero table, "say X 500 times") is billed only up
  to where the repetition starts. Sampled spot-checks of temperature-0 calls (below) are designed,
  not built.
- **Colluding hardware witnesses.** Two witnesses on separate accounts that both contradicted an
  honest GPU agent demoted it, and an overruled witness was only counted. Fixed:
  - One witness's cross-check mismatch does not demote. The prompt goes to a second witness. If it
    agrees, the subject is verified and the first witness's disagreement is counted
    (`witnessDisagreements`) and logged as `hardware_witness_disagreement`.
  - Two disagreeing witnesses do not demote either (this change). The subject gets a confirmatory
    re-challenge: a fresh prompt (new nonce and seed) answered by two fresh witnesses that exclude all
    earlier ones. Only if both of them disagree too is the subject demoted (`cross_check_mismatch`).
    If both agree, the subject is verified and each earlier witness gets a witness strike. A split, a
    witness that never answers, or no witness to be had settles unconfirmed at base tier: no demotion,
    no strike.
  - Witnesses are chosen uniformly at random among eligible agents (`pickBenchmarkWitness`,
    `HardwareVerifier.canWitness`): online, not blacklisted, running the model, a passed GPU challenge
    (or one unconfirmed only for want of a witness, so a new fleet can bootstrap), fewer than 3
    disagreements and fewer than `HARDWARE_WITNESS_STRIKE_THRESHOLD` (2) strikes within
    `HARDWARE_WITNESS_STRIKE_WINDOW_MS` (30 days), and a different owner account and IP network (/24
    IPv4, /48 IPv6) from the subject and from each other.
  - At the strike threshold the agent is no longer picked, and the coordinator logs
    `hardware_witness_disagreement` (action `witness_excluded`) and records one behaviour strike
    (`HWW001`). Strikes survive re-registration with new hardware.

  Residual: demoting an honest agent now takes four colluding witnesses, on four accounts and four
  networks, and the coordinator must pick all four from the colluders at random. A colluding pair can
  still keep an honest agent at its base tier for a round (a split confirmatory round, or two lies
  followed by a confirmatory witness that never answers), but cannot demote it, and every lie that a
  confirmatory round overrules is a strike. Witness duty is unpaid, so exclusion costs a colluder
  nothing directly; the behaviour strike and the logged events are the penalty. "Account" is the
  agent's `ownerEmail`; agents with no owner are independent of everyone but themselves. Several
  accounts behind different /24s (cheap VPS ranges) are still a Sybil route.
- **Free compute through "anonymous" `/submit`.** Any signed agent could submit unbilled jobs, and
  the honest workers that ran them were paid nothing. Fixed: a remote agent asking for "anonymous"
  is billed to its owner.

**Residual risk (owner decisions)**

- **Fake work is paid when verification is off.** `RESULT_VERIFICATION_RATE` defaults to 0. An agent
  can claim a code job, wait, and return any output; it is paid up to the reserve. Proposed: enable
  sampling (e.g. 5 to 10% of verifiable kinds) by default in production. The behaviour-rule flags
  below rely on it.
- **Inference spot-checks (designed, not built).** The padding fix above prices only what the
  coordinator can judge from the text. A sampled re-run would also catch varied filler and wrong-model
  answers. Design:
  - *Which calls.* Only `temperature: 0` calls on a billed network target, sampled at
    `INFERENCE_VERIFICATION_RATE` (default 0), raised for agents with recent `inference_output_degenerate`
    events.
  - *The re-run.* After the original result is delivered and settled for the requester (the buyer never
    waits), the coordinator enqueues a replica subtask with the same messages, tools, model and cap,
    excluding the original agent and its account (`excludeAccounts`, as result verification does), with
    no stream and no requester. It runs at the network's expense: unpaid unless
    `RESULT_VERIFICATION_MINT_REPLICA_REWARDS` is on (the open minting decision, #114).
  - *Comparison.* Lenient, because greedy decoding still differs across GPUs, quantisations and Ollama
    builds: a common prefix of at least 25% of the shorter reply, or word 3-gram overlap of at least
    0.3, is a match. A length ratio above 3 with a matching prefix means the original ran on past where
    the honest reply stopped (padding). A gross mismatch (overlap under 0.05) together with a degenerate
    or over-long original is a strike (`INF002`); a mismatch alone only raises the agent's sample rate.
  - *Payment.* The original agent's earn row for a sampled call would be held (the earnings-hold
    pattern used for payouts) until the check settles or times out, then released or reversed. The
    requester's charge is final at delivery; a reversed earning is refunded to them.
  - *Why not built now.* It needs a replica path for inference (agents stream to a requester today; a
    replica has none), a held-earnings state per subtask that the current accrual path does not have,
    the minting decision, and similarity thresholds calibrated on real fleet pairs (same tag, different
    hardware). Built quickly, a too-strict comparator would strike honest agents. A Sybil replica on a
    second account can still agree with a padded original (see "Sybil replicas").
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
| On-chain deposit address flood (`/account/onchain/address`, `ONCHAIN_ENABLED`): each call could ask LND for a new address | an account keeps one address until a deposit to it is seen, so a new address needs a real on-chain payment; the portal route shares the top-up rate limit |
| On-chain deposits: dust spam, a deposit replaced or reorged out after being shown, oversized deposits | below `ONCHAIN_DEPOSIT_MIN_SATS` never credited; credit only after `ONCHAIN_DEPOSIT_CONFIRMATIONS`, once per txid:vout; per-deposit and per-account 24 h caps hold deposits for an operator; a credited deposit that vanishes is a CRITICAL event and trips reconciliation |
| Sybil: any number of agents per account, each auto-approved | `PORTAL_MAX_AGENTS_PER_ACCOUNT`, default 25 (proposed default) |
| Unsigned `/agent/diagnostics` could overwrite any agent's diagnostics | the signer must be the named agent |
| A buyer could get honest workers struck and blacklisted through BHV004 (success collapse): jobs whose programs exit non-zero (`sys.exit(1)`) counted as the worker's failures | results say whether the agent executed the job (`executed`, `exitCode`, `programError`); a program error is a correctly executed, paid job; agent failures count at most `BEHAVIOR_SUBMITTER_FAILURE_CAP` (3) per submitter account per hour; a verified-failing replica excuses the failure. See [Failed programs are not failed agents](../economy-compute-trust-model.md#failed-programs-are-not-failed-agents-bhv004) |

**Residual risk**

- **BHV004 framing, what is left.** Fixed above for program errors; what remains:
  - Agents that predate `executed` are judged as before (a failure is theirs), so a buyer can still
    add up to the cap (3 per hour) of failures per account to them, and needs four or more funded
    accounts to collapse one. Sybil accounts are cheap (see section 2).
  - Agent-side failures a buyer can still provoke on any agent: a program that loops without
    printing (a timeout with no output is judged the agent's, since a stalled container looks the
    same), or one that exits 125 to 127 and prints Docker's own `docker:` message on stderr. These
    are capped per submitter the same way.
  - A broken agent whose work comes from fewer than four submitters in an hour is not caught by
    BHV004 (10 counted results needed, at most 3 per submitter).
  - Program errors are paid on the worker's word plus the coordinator's credibility checks; with
    verification off (`RESULT_VERIFICATION_RATE=0`) nothing re-runs them, as for successes. The seeds
    run 0.05. A weak model's buggy program also counts as a program error: the buyer pays for a run
    whose program failed (a quality question, not an integrity one).
- **BHV009 (duration "robot precision")** strikes on a standard deviation under 50 ms over 10 or
  more tasks. Durations are server-measured and include model and container start-up, so a buyer
  can hardly force this, but it was not tested against real workloads.
- **With verification off**, the content rules only log. An agent returning canned output is not
  caught by them (see section 2).
- **Per-agent limits still scale** with the agent cap times the number of accounts.
- **In-memory growth over time.** `queue.results` and the in-memory ordering chain grow with
  legitimate traffic. They are bounded per request now, but not over time.
- **Unpaid inference requests to a chosen agent** (`/agent-mesh/models/request`) are now limited to
  agents of the sender's own account (section 1). Tunnel close notices are rate-limited and
  inbox-capped, but not charged.
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
  - make agents pull, select or remove allowlisted models, and change their bounded model settings
    (as a forged owner command or an admin rollout); a host that sets `AGENT_REMOTE_CONTROL=off`
    refuses all of it.

  It cannot install binaries or run code outside the sandbox through orchestration. It does not
  learn the agent's keys.
- **Binary attestation is advisory.** An agent can claim a "verified" binary without running it, so
  `REQUIRE_VERIFIED_AGENTS` proves little against this attacker. Agent-side controls are not
  enforceable on a machine the attacker owns. Everything above is enforced on the coordinator.

**Done:** the agent's mesh server binds `AGENT_MESH_HOST` (default 127.0.0.1), not the container's `HOST`.

**Not changed here (protected paths):** `deploy/**`, `Dockerfile*`, `.github/**`. Proposed:

- make https mandatory for non-loopback coordinator URLs in the installer.
