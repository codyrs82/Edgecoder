# EdgeCoder Documentation

This docs site covers the full EdgeCoder system: a decentralized mesh network for running AI models at the edge.

## What EdgeCoder Is

EdgeCoder turns every device into a unified agent that contributes compute to a peer-to-peer mesh. Each node runs a coordinator, worker, and inference service in a single process. Nodes discover each other via gossip mesh and distribute tasks based on capability and availability.

Users interact through a chat-first desktop app (Tauri + Svelte with Monaco editor), external IDEs via an OpenAI-compatible endpoint, or the iOS app with on-device llama.cpp inference and BLE local mesh.

### Why EdgeCoder

- **No cloud dependency** -- all inference runs locally on commodity hardware using Ollama or llama.cpp.
- **Permissionless mesh** -- any device can join and contribute compute to earn credits.
- **Cryptographically auditable** -- every transaction is recorded in an append-only ordering chain anchored to Bitcoin via OP_RETURN.
- **Privacy-preserving** -- task data stays on the executing node; envelope encryption is staged for activation.

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
- [Developer Guide (README.dev.md)](https://github.com/codyrs82/Edgecoder/blob/main/README.dev.md)
