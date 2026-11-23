---
title: Trust and Security
description: Security architecture, cryptographic controls, and audit mechanisms for EdgeCoder.
---

# Trust and Security

This page unifies controls from `docs/security-baseline.md`, `README.md`, `SECURITY.md`,
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

Agents send five headers: `x-agent-id`, `x-timestamp-ms`, `x-nonce`,
`x-body-sha256` (lowercase hex SHA-256 of the exact body bytes) and
`x-signature` (base64 Ed25519 signature over
`timestampMs\nnonce\nMETHOD\npath\nbodySha256`). The coordinator looks the
agent's public key up from the `publicKeyPem` it sent in `/register`, recomputes
the body hash from the raw request bytes, and rejects a mismatch, a bad
signature or a reused nonce with `401`.

The iOS app implements the same scheme in Swift (CryptoKit) in
`ios/EdgeCoderIOS/EdgeCoderIOS/Security/RequestSigner.swift`, with the signing
key kept in the Keychain (`KeychainEd25519.swift`). Both implementations are
pinned to the shared vectors in
`tests/security/fixtures/request-signing-vectors.json`, checked by vitest and by
the iOS CI job (#64).

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

Implementation lives in `src/security/envelope.ts`.

### What it covers today

Envelope encryption is on by default; there is no flag. It protects the hop
between the coordinator and the agent that runs a subtask:

- At registration the agent sends an X25519 public key
  (`src/swarm/worker-runner.ts`).
- When that agent pulls a subtask, the coordinator encrypts the task input and
  snapshot reference to that key and keeps the shared key for the subtask
  (`src/swarm/coordinator/routes/tasks.ts`, `/pull`).
- The agent decrypts the task, runs it, and encrypts its result with the same
  shared key; the coordinator decrypts the result in `/result`.

What it does **not** cover:

- **It is not end to end.** The coordinator decrypts every result and sees the
  task in plaintext. Queue payloads are stored in Postgres unencrypted.
- **iOS agents do not use it yet.** An agent that registers no X25519 key gets
  the subtask in plaintext (over TLS), and so does any pull where encryption
  fails (the coordinator logs `envelope_encryption_failed_falling_back`).
- It does not hide the routing metadata (task id, resource class, priority,
  language, timeout, model) that travels with the envelope.

## Web chat privacy

Conversations in the web chat on edgecoder.io are kept on EdgeCoder's servers so you can open them again. How they are protected:

- **Encrypted at rest.** Message text and conversation titles are stored encrypted with AES-256-GCM, under a server key (`PORTAL_CHAT_KEY`) that is kept as a deployment secret, not in the database. Each value gets a fresh random IV, and each ciphertext is bound to its own row (conversation and message id) as additional data, so a ciphertext copied onto another row does not open. Implementation: `src/portal/chat-crypto.ts`.
- **This is encryption at rest, not end-to-end encryption.** The portal decrypts your chats to show them to you and to send them on. The coordinator that routes a reply and the host machine that runs the model see the conversation in plaintext while they process it. Don't paste passwords, API keys, private keys or other secrets into a chat.
- **You can delete a conversation** from the chat sidebar at any time; its messages are deleted with it.
- **Sharing is opt-in and off by default.** **Settings → Profile → Privacy → Share my chats to help improve EdgeCoder** controls whether your web chats may be used to improve EdgeCoder, including to train AI models. While it is off, your chat content is not used for that. Turning it off later withdraws chats you shared before from future use (models already trained on them are not retrained). Your chats stay encrypted at rest either way. The setting is `GET /me/chat-sharing` and `PUT /me/chat-sharing { "shareChatForImprovement": true | false }` (`src/portal/routes/chat-sharing.ts`).

Chats kept by the desktop app stay on your computer. See the [Privacy Policy](https://edgecoder.io/privacy) for retention and your rights, and [Web chat](/guide/web-chat) for how the chat works.

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
- [Developer Guide Security Notes](https://github.com/codyrs82/Edgecoder/blob/main/README.md#developer-guide)

## Your account and your payouts

- **Two-factor authentication** (Settings, Profile): an authenticator app with recovery codes, or a passkey. With it on, withdrawals, payout address changes, new API keys and admin changes ask for it. Admins must turn it on.
- **New payout addresses** are confirmed from your email, then wait 24 hours (1 hour for your first address) before payouts go there. You get an email with a link to cancel, and withdrawals pause meanwhile.
- **Every withdrawal emails you a receipt** with a "not you? lock your account" link. Locking pauses payouts and signs out every session; support unlocks it after checking with you.

