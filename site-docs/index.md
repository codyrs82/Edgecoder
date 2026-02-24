# EdgeCoder Documentation

This docs site is a consolidated wiki-style view of the full EdgeCoder system.
It is built from the repository's README files, operational runbooks, security baseline, and unified plan.

## High-Level Summary

### What this system does

EdgeCoder provides AI coding workflows that can run locally, on private infrastructure, and across approved distributed worker nodes.
It combines coding assistance, orchestration, security controls, and operational governance in one runtime.

### Why teams choose it over typical alternatives

- cloud-only tools: often simpler to start, but weaker on private control boundaries
- local-only tools: private by default, but limited when workloads exceed local capacity
- EdgeCoder: local-first with optional coordinator-managed scaling and explicit trust/policy controls

### Main benefits

- **Privacy + control**: keep sensitive work in your environment when required.
- **Scalable execution**: use mesh capacity for overflow instead of only vertical hardware scaling.
- **Operational governance**: approvals, blacklist controls, and role-based operations are built in.
- **Architecture clarity**: separated services (portal/control/coordinator/inference) reduce operational ambiguity.
- **Auditability**: ledger/stats and issuance flows support stronger integrity verification.

## Start Here (Deep Docs)

- [System Overview and Benefits](/guide/system-overview-benefits)
- [How EdgeCoder Works](/guide/how-edgecoder-works)
- [Architecture Deep Dive](/guide/architecture-deep-dive)
- [Request Lifecycle Sequences](/guide/request-lifecycle-sequences)
- [Model Provider Abstraction](/guide/model-provider-abstraction)
- [Executor Sandbox and Isolation](/guide/executor-sandbox-isolation)
- [Public Mesh Operations](/operations/public-mesh-operations)
- [Role-based Runbooks](/operations/role-based-runbooks)
- [Agent Mesh Peer-Direct Flow](/operations/agent-mesh-peer-direct)
- [Coordinator Discovery and Failover](/operations/coordinator-discovery-failover)
- [Executor Subset Reference](/operations/executor-subset-reference)
- [Deployment Topology](/operations/deployment-topology)
- [iOS Background Execution & Compute Modes](/operations/ios-power-scheduling)
- [Stats Ledger Rollout](/operations/stats-ledger-rollout)
- [Trust and Security](/security/trust-and-security)
- [Threat Model](/security/threat-model)
- [Credits, Pricing, and Issuance](/economy/credits-pricing-issuance)
- [Settlement Lifecycle](/economy/settlement-lifecycle)
- [API Surfaces](/reference/api-surfaces)
- [API Endpoints Detailed](/reference/api-endpoints-detailed)
- [Runtime Modes](/reference/runtime-modes)
- [Issuance and Economy Parameters](/reference/issuance-economy-params)
- [Coordinator Signing Identity](/reference/coordinator-signing-identity)
- [Environment Variables](/reference/environment-variables)

## How This Site Is Organized

- **Guide**
  - End-to-end system flow and detailed architecture.
- **Operations**
  - Mesh operations model, deployment topology, and production-oriented workflows.
- **Security**
  - Trust boundaries, identity, supply chain controls, runtime restrictions, and audit posture.
- **Economy**
  - Credits, sats conversion model, payment intents, issuance windows, and ledger guarantees.
- **Reference**
  - API surface map, env variable index, and links to source docs.

## Canonical Source Documents

- [macOS env example](https://github.com/edgecoder-io/edgecoder/blob/main/scripts/macos/payload/etc/edgecoder/edgecoder.env.example)
- [Linux env example](https://github.com/edgecoder-io/edgecoder/blob/main/scripts/linux/payload/etc/edgecoder/edgecoder.env.example)
- [GitHub Releases](https://github.com/edgecoder-io/edgecoder/releases)
- [Developer Guide (README.dev.md)](https://github.com/edgecoder-io/edgecoder/blob/main/README.dev.md)
