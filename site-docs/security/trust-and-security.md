---
title: Trust and Security
description: Security architecture, cryptographic controls, and audit mechanisms for EdgeCoder.
---

# Trust and Security

This page unifies controls from `docs/security-baseline.md`, `README.dev.md`,
`docs/public-mesh-operations.md`, and relevant architecture decisions.

## Security Model Summary

- Minimize exposed surfaces.
- Keep model execution mediated by authenticated service paths.
- Enforce policy before scheduling and execution.
- Preserve auditable records for critical state transitions.

## Identity and Access

- Portal authentication supports:
  - email/password
  - OAuth providers
  - passkeys
- Elevated operations are role-gated (coordinator owner/system admin contexts).
- Administrative and service APIs rely on explicit auth/token boundaries.

## Mesh and Network Controls

- Coordinator routes are mesh-auth protected.
- Public anonymous access to mesh-only routes is rejected.
- Peer registration and mesh interactions are controlled by coordinator policy.
- Blacklist propagation prevents known-abusive identities from participating.

## Cryptographic Security Stack

The following security primitives are shipped and active in the codebase:

### Request Signing (Ed25519)

Every outbound API request is signed with an Ed25519 keypair. The coordinator
and peer nodes verify signatures before processing any payload. Implementation
lives in `src/security/request-signing.ts`.

### Nonce-Based Replay Prevention

Each signed request includes a unique nonce. The verifier tracks recently seen
nonces within a configurable window and rejects duplicates, preventing replay
attacks even if a valid signed request is intercepted. See
`src/security/nonce-verifier.ts`.

### Per-Agent Sliding Window Rate Limiting

Agent identities are subject to a sliding-window rate limiter that caps
request volume per time interval. Limits are enforced before request
processing to protect coordinator resources from abuse or misconfigured
agents. See `src/security/agent-rate-limiter.ts`.

### Blacklist Audit Chain with Evidence Hashing

Blacklist entries are chained with cryptographic hashes of the evidence that
triggered them. This produces a tamper-evident log of moderation decisions that
can be independently verified. See `src/security/blacklist.ts`.

### Deployment Manifest Verification

Before a deployment artifact is accepted, its manifest is verified against a
known-good signature. This prevents tampered or unauthorized builds from
reaching production nodes. See `src/security/manifest-verifier.ts`.

### Encrypted Key Storage (PBKDF2)

Private keys at rest are encrypted using a passphrase-derived key (PBKDF2 with
high iteration count) and stored in an opaque envelope. Keys are only
decrypted into memory when needed and are never written to disk in plaintext.
See `src/security/key-storage.ts`.

### Key Rotation Scheduling

Keypairs are rotated on a configurable schedule. The rotation manager handles
overlap windows so that both the outgoing and incoming keys are valid during
the transition period, avoiding service interruption. See
`src/security/key-rotation.ts`.

### Security Event Audit Logging

All security-relevant events -- authentication attempts, signature
verification failures, rate-limit hits, blacklist actions, key rotations --
are emitted to a structured audit log. Events include timestamps, actor
identities, and outcome codes for post-incident analysis. See
`src/audit/security-events.ts`.

## Envelope Encryption

Task payloads are protected with envelope encryption using **X25519 ECDH key
agreement** combined with **AES-256-GCM authenticated encryption**.

The flow works as follows:

1. The sender generates an ephemeral X25519 keypair.
2. ECDH key agreement is performed between the ephemeral private key and the
   recipient's static X25519 public key, producing a shared secret.
3. A symmetric AES-256-GCM key is derived from the shared secret.
4. The task payload is encrypted and authenticated with AES-256-GCM.
5. The ciphertext, GCM authentication tag, nonce, and ephemeral public key are
   bundled into the envelope and transmitted.
6. The recipient performs the inverse ECDH agreement with their static private
   key and the ephemeral public key, derives the same symmetric key, and
   decrypts the payload.

Implementation lives in `src/security/envelope.ts`. Envelope encryption is
currently staged for activation in the task pipeline.

## Runtime Safety Controls

- Worker execution uses constrained runtime expectations.
- Sandbox/subset enforcement protects host boundaries during untrusted code execution.
- Frozen snapshot and reproducible execution concepts reduce mutable live-state risk in distributed jobs.

## Model Supply Chain Controls

- Prefer approved model sources and controlled rollout workflows.
- Validate model identity/integrity before broad production rollout.
- Keep model-serving interfaces restricted and observable.

## Audit and Integrity

- Ledger verification supports tamper-evident checks.
- Issuance/economy flows rely on explicit epoch/history semantics.
- Blacklist and policy actions are designed for traceability.
- Security event audit logging provides structured records for post-incident review.

## Production hardening priorities

- Keep sensitive config in secret stores.
- Enforce HTTPS for public-facing origins.
- Separate service concerns (portal/control/coordinator/inference).
- Monitor health endpoints and audit events continuously.

## Canonical references

- [Security Baseline](https://github.com/codyrs82/Edgecoder/blob/main/docs/security-baseline.md)
- [Public Mesh Operations](https://github.com/codyrs82/Edgecoder/blob/main/docs/public-mesh-operations.md)
- [Developer Guide Security Notes](https://github.com/codyrs82/Edgecoder/blob/main/README.dev.md)
