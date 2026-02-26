# EdgeCoder Architecture

This document describes the system architecture, component interactions, data flows, and key subsystems of EdgeCoder.

## System Diagram

```
                          +-------------------+
                          |   Portal (4310)   |
                          | auth, chat, UI,   |
                          | reviews, wallet   |
                          +--------+----------+
                                   |
                    session/API    |   internal service calls
                                   v
+------------------+     +---------+-----------+     +-------------------+
| Control Plane    |<--->|  Coordinator (4301) |<--->| Inference (4302)  |
| (4303)           |     |  task queue, mesh,  |     | decompose,        |
| admin, rollouts, |     |  economy, ledger    |     | escalate          |
| credits          |     +---+----------+------+     +-------------------+
+------------------+         |          |
                             |          |  gossip / WebSocket / HTTP
               pull/result   |          +---------------------------+
                             |                                      |
                    +--------+--------+                   +---------+---------+
                    | Worker Runner   |                   | Peer Coordinators |
                    | sandbox exec,   |                   | (other mesh       |
                    | BLE mesh, model |                   |  instances)       |
                    +---------+-------+                   +-------------------+
                              |
                    +---------+---------+
                    |  BLE Local Mesh   |
                    | (iOS/desktop      |
                    |  device-to-device)|
                    +-------------------+
```

## Components

### Unified Boot (`src/index.ts`)

The default entrypoint starts three Fastify servers in parallel (coordinator, inference, control plane) and then forks a worker-runner child process. Every node contributes compute to the mesh.

```
boot()
  |
  +-- inferenceService.listen(:4302)
  +-- coordinatorServer.listen(:4301)
  +-- controlPlaneServer.listen(:4303)
  +-- initCoordinator()          # background tasks, peer bootstrap
  +-- startWorkerProcess()       # fork worker-runner as child process
```

The worker is automatically restarted if it exits.

### Portal (`src/portal/server.ts`)

The portal is the user-facing web application. It serves:

- **Authentication:** email/password, Google/Microsoft OAuth 2.0, passkey (WebAuthn) enrollment and login.
- **Chat interface:** submits tasks to the coordinator and streams results back.
- **Code reviews:** displays pending reviews and collects approve/reject decisions.
- **Human escalations:** surfaces tasks that exceeded swarm capacity for manual resolution.
- **Wallet management:** seed backup, credit balance, BTC/Lightning purchase intents.
- **Node enrollment:** users enroll machines and receive registration tokens for workers.
- **Coordinator operations:** node approval, model rollouts, agent diagnostics.
- **Internal APIs:** node validation and lookup endpoints used by the coordinator during agent registration.

The portal authenticates sessions via cookies and communicates with the coordinator and control plane using service tokens (`PORTAL_SERVICE_TOKEN`, `CONTROL_PLANE_ADMIN_TOKEN`).

### Coordinator (`src/swarm/coordinator.ts`)

The coordinator is the central hub of the swarm. It manages:

1. **Agent lifecycle** -- registration (with portal node approval), heartbeat, diagnostics.
2. **Task queue** -- submit, decompose via inference, assign subtasks, collect results.
3. **Mesh networking** -- peer registration, gossip broadcast, WebSocket tunnels, peer exchange.
4. **Credit economy** -- dynamic pricing, payment intents, Lightning settlement, issuance, treasury.
5. **Ordering ledger** -- tamper-evident hash-chain of all queue events.
6. **Blacklist** -- abuse detection, evidence-based blacklisting, gossip propagation.
7. **Agent mesh** -- direct peer-to-peer work offers, model transfer requests, tunnel relay.
8. **Escalation** -- forward tasks to parent coordinators or cloud inference.
9. **Robot queue** -- long-running automation tasks with separate fee structure.

### Inference Service (`src/inference/service.ts`)

Stateless service that calls Ollama to decompose prompts into subtasks and to escalate failed code into improved solutions.

- **Decompose:** takes a prompt, calls the LLM with a decomposition prompt template, parses the output into an array of subtasks (up to 10). Falls back to a single subtask on parse failure.
- **Escalate:** takes failed code and error history, calls the LLM with a reflection prompt, extracts improved code.
- **Auth:** optional token-based auth (`INFERENCE_AUTH_TOKEN`) and signed coordinator request verification.

### Control Plane (`src/control-plane/server.ts`)

Admin API for operators. Protected by `ADMIN_API_TOKEN` and optional IP allowlists.

- Agent catalog with upsert, mode change, model assignment, and approval.
- Canary/percentage/full rollout orchestration with promote and rollback.
- Credit accounts, faucet top-up, balance and history queries.
- Economy management: pricing, issuance, wallets, payment intents, treasury policies.
- Network summary and coordinator discovery.
- Security blacklist management.
- Coordinator bootstrap trigger.

### Worker Runner (`src/swarm/worker-runner.ts`)

Each worker is a standalone Node.js process that:

1. Discovers a coordinator (bootstrap URL, cached URL, or discovery endpoint).
2. Registers with the coordinator, providing its identity, capabilities, and public keys.
3. Enters a poll loop calling `POST /pull` to receive subtasks.
4. Executes code in a sandbox (Docker, process-level, or none).
5. Posts results via `POST /result`.
6. Sends heartbeats with power telemetry and model status.
7. Optionally participates in BLE mesh and agent-mesh direct work.

## Data Flow: Task Lifecycle

```
1. User submits prompt via Portal chat UI
     |
     v
2. Portal calls POST /portal/chat on the Coordinator
     |
     v
3. Coordinator calls POST /decompose on the Inference Service
     |
     v
4. Inference Service calls Ollama LLM, parses response into subtasks
     |
     v
5. Coordinator enqueues subtasks in the SwarmQueue
     |
     v
6. Workers call POST /pull on the Coordinator
     |
     v
7. Coordinator assigns subtask to a worker (respects power policy, sandbox, priority)
     |  -- optionally wraps subtask in encrypted TaskEnvelope (X25519 + AES-256-GCM)
     v
8. Worker executes code in sandbox
     |  -- Docker: isolated container, no network, read-only filesystem
     |  -- Process: sandbox-exec (macOS) or seccomp/namespaces (Linux)
     v
9. Worker posts result via POST /result
     |
     v
10. Coordinator appends result to ordering chain, credits the worker, notifies origin
      |
      v
11. If task originated from mesh gossip, result is forwarded to origin coordinator
      |
      v
12. Portal polls for results and displays them in the chat UI
```

### Escalation Path

When a worker fails (code errors, timeout), the coordinator escalates:

1. Retry locally with the same or different worker.
2. Call `POST /escalate` on the inference service for LLM-assisted code improvement.
3. Forward to a parent coordinator via the escalation resolver.
4. Fall back to cloud inference endpoint.
5. Surface as a human escalation in the portal for manual resolution.

## Mesh Networking

EdgeCoder uses two complementary networking layers:

### HTTP P2P Gossip Mesh

Coordinators form a peer-to-peer overlay network. Each coordinator has an Ed25519 identity derived from its public URL.

- **Peer discovery:** coordinators bootstrap by contacting seed URLs (`COORDINATOR_BOOTSTRAP_URLS`), exchanging `/identity` and `/mesh/register-peer`.
- **Peer exchange:** coordinators periodically broadcast `peer_exchange` messages containing their known peer tables.
- **Gossip broadcast:** messages are sent via WebSocket (preferred for NAT traversal) or HTTP POST to `/mesh/ingest`.
- **Message types:** `task_forward`, `result_forward`, `peer_exchange`, `capability_announce`, `blacklist_propagate`, `issuance_epoch`, `anchor_broadcast`, and more.
- **Authentication:** all mesh endpoints require the `x-mesh-token` header matching the shared `MESH_AUTH_TOKEN`.
- **Peer scoring:** coordinators track peer reliability; unreliable peers receive lower scores and may be evicted.
- **Rate limiting:** each peer is limited to 50 messages per 10-second window.

### BLE Local Mesh

For offline and local scenarios, workers can communicate via Bluetooth Low Energy:

- **Transport:** `NobleBLETransport` (uses `@abandonware/noble` for scanning and `@abandonware/bleno` for advertising).
- **Router (`BLERouter`):** maintains a peer table sorted by cost. Cost factors include model size preference, current load, battery level, signal strength (RSSI), task reliability, and connection quality score.
- **Peer selection:** `selectBestPeers()` evicts stale entries, filters by mesh token hash, skips blacklisted peers, and returns the lowest-cost candidates.
- **Offline ledger:** BLE credit transactions are recorded locally in SQLite and synced to the coordinator when connectivity is restored via `POST /credits/ble-sync`.
- **Reconnection:** `ReconnectionManager` handles BLE disconnect/reconnect with exponential backoff.

### Worker-to-Worker Agent Mesh

Workers can also form direct connections via HTTP for lightweight collaboration:

- **`MeshPeer`:** each worker runs a `MeshHttpServer` that accepts direct work offers from other workers.
- **Direct work offers:** workers post `POST /agent-mesh/direct-work/offer` through the coordinator, which routes offers to target agents via heartbeat responses.
- **Tunnel relay:** the coordinator provides a relay endpoint (`POST /agent-mesh/relay`) for workers behind NAT.

## Credit Economy

EdgeCoder uses an internal credit system backed by Bitcoin/Lightning:

### Credit Engine (`src/credits/engine.ts`)

In-memory ledger that tracks earn and spend transactions per account.

- **Earn:** workers earn credits for compute contributions. Credits = `computeSeconds * baseRate * qualityMultiplier * loadMultiplier`.
- **Spend:** users spend credits to submit tasks. Cost scales with model parameter count.
- **Base rates:** CPU = 1.0 credits/sec, GPU = 4.0 credits/sec.
- **Load multiplier:** scales from 0.8x (low demand) to 1.6x (high demand) based on queue pressure.

### Dynamic Pricing (`src/economy/pricing.ts`)

Sats-per-compute-unit price adjusts dynamically based on supply and demand:

- Base price: 30 sats (CPU), 120 sats (GPU).
- Scarcity multiplier: `demand / capacity`, clamped between 0.35x and 4.0x.
- Coordinators propose prices; consensus is reached via weighted-median voting across peers.

### Issuance System

Daily token pool distributed to contributors:

- Pool size computed from base (10,000 tokens/day) adjusted by load curve.
- Hourly allocations based on each account's contribution share.
- Coordinator share: 5%, reserve share: 5%.
- Quorum voting on epoch records across peer coordinators.
- Bitcoin anchoring of issuance epochs for auditability.

### Payment Flow

1. User creates a payment intent (`POST /economy/payments/intents`) specifying sats amount.
2. Lightning invoice is generated via the configured provider (`mock`, `lnd`, `cln`).
3. User pays the invoice.
4. Settlement is confirmed (`POST /economy/payments/intents/:intentId/confirm`).
5. Credits are minted to the user's account after coordinator fee deduction.

### Treasury

Multi-signature custody policies govern treasury funds:

- Policies define quorum threshold, total custodians, approved coordinator IDs, and key rotation schedule.
- Key custody events are cryptographically signed and auditable.

## Sandbox Enforcement

Workers execute generated code in isolated sandboxes:

| Mode | Mechanism | Default For |
|------|-----------|-------------|
| `docker` | Docker container: `--network=none`, `--read-only`, `--memory`, `--cpus`, `--pids-limit=50` | Swarm workers |
| `process` | OS-level: `sandbox-exec` on macOS, seccomp + namespaces on Linux | n/a |
| `none` | No sandboxing | IDE mode |

Sandbox policy is enforced at task pull time (`enforceSandboxPolicy`). If `SANDBOX_REQUIRED=true` and the mode is `none`, execution is blocked.

Docker images: `edgecoder/sandbox-python:latest` and `edgecoder/sandbox-node:latest`.

## Power Policy

The power policy system (`src/swarm/power-policy.ts`) controls task assignment based on device state:

### iOS

| Condition | Coordinator Tasks | Peer Direct Work |
|-----------|-------------------|-------------------|
| Low Power Mode | blocked | blocked |
| External power | allowed | allowed |
| Battery <= stop level | blocked | blocked |
| On battery, throttled | blocked | blocked |
| On battery, lite mode | allowed | blocked |

### Desktop / Laptop

| Condition | Coordinator Tasks | Peer Direct Work |
|-----------|-------------------|-------------------|
| Server device type | allowed | allowed |
| High CPU (>85%) | allowed (deferred 5s) | allowed (deferred 5s) |
| Thermal serious/critical | blocked | blocked |
| Desktop or AC power | allowed | allowed |
| Laptop battery < 15% | blocked | blocked |
| Laptop battery 15-40% | allowed (small only) | blocked |
| Laptop battery > 40% | allowed | blocked |

## Tamper-Evident Ledger

The `OrderingChain` (`src/ledger/chain.ts`) maintains a hash-chain of all queue events:

- Each record contains: event type, task/subtask IDs, actor ID, sequence number, timestamp, previous hash, and a cryptographic signature from the coordinator.
- Event types: `task_submitted`, `task_assigned`, `task_completed`, `task_failed`, `node_approval`, `blacklist`, checkpoint, and more.
- Records are persisted to PostgreSQL and synced across coordinator peers.
- The chain can be verified end-to-end via `verifyOrderingChain()`.
- Periodic Bitcoin anchoring stores chain hashes on-chain for independent auditability.

## Escalation Resolver

The `EscalationResolver` (`src/escalation/server.ts`) implements a resolution waterfall:

1. **Parent coordinator** -- forward to a higher-tier coordinator with more capacity.
2. **Cloud inference** -- fall back to a hosted cloud endpoint.
3. **Human escalation** -- surface in the portal for manual resolution.

Each backend supports configurable timeouts, retries with exponential backoff, and an optional result callback.

## Security Model

| Layer | Mechanism |
|-------|-----------|
| User auth | Passkey (WebAuthn), email/password, OAuth 2.0 (Google, Microsoft) |
| Session | Secure HTTP-only cookies with configurable TTL |
| Mesh auth | Shared `MESH_AUTH_TOKEN` on all coordinator-to-coordinator traffic |
| Agent auth | Portal node enrollment, registration token, coordinator approval |
| Request signing | Ed25519 signatures with nonce and timestamp (anti-replay) |
| Task encryption | X25519 ECDH key exchange + AES-256-GCM envelope encryption |
| Sandbox | Docker isolation, OS-level process sandboxing |
| Abuse control | Blacklist with evidence hashing, gossip propagation, rate limiting |
| Audit | Hash-chain ledger with Bitcoin anchoring |
| Admin | API token + IP allowlist on control plane |
