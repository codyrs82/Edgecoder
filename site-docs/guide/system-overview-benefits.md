# System Overview and Benefits

This page covers what EdgeCoder is, what it ships today, and why it matters.

## What EdgeCoder Is

EdgeCoder is a decentralized mesh network where every device contributes compute to run AI models at the edge. There is no central server. Every node is a **unified agent** -- running coordinator, worker, and inference in a single process. Nodes discover each other via a gossip mesh and distribute tasks based on capability and availability.

No cloud accounts. No API keys to a hosted service. Every participating device is both a provider and a consumer of AI compute.

## Shipped Features

### Unified Agent

Every node runs coordinator + worker + inference in one process. There is no separate service deployment, no multi-container orchestration, and no control plane to stand up. A single binary joins the mesh and is immediately productive.

### Chat-First Desktop App

A Tauri-based IDE ships with a Monaco code editor, streaming chat interface, conversation history, model management, and a live mesh visualization panel. This is the primary user surface for interacting with the network.

### Gossip Mesh

HTTP-based peer discovery and task broadcasting. Nodes announce themselves and relay peer lists to build a full mesh view. Task distribution uses a claim-delay protocol to prevent duplicate execution across nodes.

### Local AI Inference

Every node runs model inference locally via Ollama. iOS nodes use llama.cpp for on-device inference. No inference request ever leaves the executing node's hardware.

### BLE Local Mesh

Bluetooth Low Energy enables offline peer-to-peer task routing between nearby devices. This provides a connectivity layer that works without any network infrastructure -- useful for field deployments, air-gapped environments, and mobile-to-mobile coordination.

### Credit Economy

Nodes earn credits by contributing compute and spend credits to submit tasks. The ledger is an append-only ordering chain anchored to Bitcoin, with Lightning Network settlement for real-time payouts.

### External IDE Support

VS Code, Cursor, and Windsurf connect to any EdgeCoder node through an OpenAI-compatible HTTP endpoint. Developers keep their existing editor workflow and route completions through the local mesh instead of a cloud API.

### Security

Ed25519 request signing authenticates every inter-node message. Nonce-based replay prevention, per-node rate limiting, and a blacklist audit chain provide defense in depth. Envelope encryption for task payloads is staged for a future release.

## Benefits

### No cloud dependency

All inference runs locally on commodity hardware. There is no hosted backend, no metered API, and no third-party data processor in the loop.

### Permissionless mesh

Any device can join the network and begin contributing compute or submitting tasks. There is no enrollment approval gate and no vendor lock-in.

### Cryptographically auditable

Every credit transaction is recorded in an append-only ordering chain anchored to Bitcoin. The full history is independently verifiable by any participant.

### Privacy-preserving

Task data stays on the executing node. Prompts, code context, and model outputs are never transmitted to a central service or stored outside the device that ran the inference.

## When EdgeCoder Is a Strong Fit

- Teams with private code or compliance constraints that prohibit sending source to cloud APIs
- Organizations that want AI-assisted development without a recurring cloud spend line item
- Operators building internal or hybrid compute networks from existing hardware
- Mobile and field teams that need AI inference without reliable internet connectivity

## Related Pages

- [How EdgeCoder Works](/guide/how-edgecoder-works)
- [Architecture Deep Dive](/guide/architecture-deep-dive)
- [Trust and Security](/security/trust-and-security)
