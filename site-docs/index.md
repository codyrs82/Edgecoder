# EdgeCoder Documentation

This docs site covers the full EdgeCoder system: a decentralized mesh network for running AI models at the edge.

## What EdgeCoder Is

EdgeCoder is an AI coding network built on local models. Your own machines run models locally; work you choose to share goes through a coordinator to agents on approved hosts. A coordinator, worker and inference service can run in one process (`all-in-one`), and coordinators gossip with each other to share tasks. On the public network the coordinators are EdgeCoder's seeds on Fly.io (see [Deployment Topology](/operations/deployment-topology)).

Users interact through a chat-first desktop app (Tauri + Svelte with Monaco editor), the `edgecoder code` terminal, external IDEs via an OpenAI-compatible endpoint, or the iOS app with on-device llama.cpp inference and BLE local mesh.

### Why EdgeCoder

- **Runs on your hardware first** -- models run locally with Ollama or llama.cpp; work you share goes to approved hosts through EdgeCoder's coordinators. Frontier models are used only with your own API key.
- **Open mesh, invited hosts** -- any signed-in device can run its owner's own work for free. Approved hosts contribute compute for other people and earn sats over Lightning: 1 cSat = 1 sat, the host gets 95 % of each compute payment and 5 % is the network fee. Hosting is by request (`HOST_APPROVAL_REQUIRED`, on by default, see [environment variables](/reference/environment-variables)): apply at `/host` on the portal and an admin approves you. Sign-up is invite-only during early access (`LAUNCH_MODE=invite`).
- **Hash-chained ledger** -- every claim, result and earning is recorded in an append-only hash chain that `/ledger/verify` checks. Bitcoin OP_RETURN anchoring of checkpoints is implemented but off in production; it will be enabled at mainnet.
- **Encrypted task delivery** -- task payloads are encrypted from the coordinator to the agent that runs them (X25519 + AES-256-GCM), and results are encrypted on the way back. This is not end to end: the coordinator decrypts and sees the task, and iOS agents do not use it yet. See [Trust and Security](/security/trust-and-security#envelope-encryption).

## Start Here

- [System Overview and Benefits](/guide/system-overview-benefits)
- [How EdgeCoder Works](/guide/how-edgecoder-works)
- [Architecture Deep Dive](/guide/architecture-deep-dive)
- [IDE Integration](/guide/ide-integration)
- [Request Lifecycle Sequences](/guide/request-lifecycle-sequences)
- [Model Provider Abstraction](/guide/model-provider-abstraction)
- [Executor Sandbox and Isolation](/guide/executor-sandbox-isolation)
- [BLE Local Mesh](/guide/ble-local-mesh)
- [Model Management](/guide/model-management)
- [Deployment Topology](/operations/deployment-topology)
- [Public Mesh Operations](/operations/public-mesh-operations)
- [iOS Background Execution & Compute Modes](/operations/ios-power-scheduling)
- [Coordinator Discovery and Failover](/operations/coordinator-discovery-failover)
- [Coordinator Federation](/operations/coordinator-federation)
- [Trust and Security](/security/trust-and-security)
- [Threat Model](/security/threat-model)
- [Credits, Pricing, and Issuance](/economy/credits-pricing-issuance)
- [Settlement Lifecycle](/economy/settlement-lifecycle)
- [Bitcoin Anchoring](/economy/bitcoin-anchoring)
- [API Surfaces](/reference/api-surfaces)
- [API Endpoints Detailed](/reference/api-endpoints-detailed)
- [Runtime Modes](/reference/runtime-modes)
- [Environment Variables](/reference/environment-variables)

## How This Site Is Organized

- **Guide** -- System architecture, unified agent model, desktop app, IDE integration, BLE mesh, and model management.
- **Operations** -- Deployment topology, mesh operations, iOS scheduling, coordinator federation, and failover.
- **Security** -- Trust boundaries, threat model, cryptographic stack, envelope encryption, and audit posture.
- **Economy** -- Credits, dynamic pricing, Bitcoin anchoring, Lightning settlement, and issuance parameters.
- **Reference** -- API endpoints, environment variables, runtime modes, and source document index.

## Canonical Source Documents

- [GitHub Repository](https://github.com/codyrs82/Edgecoder)
- [Developer Guide (README)](https://github.com/codyrs82/Edgecoder/blob/main/README.md#developer-guide)
