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

## Production hardening priorities

- Keep sensitive config in secret stores.
- Enforce HTTPS for public-facing origins.
- Separate service concerns (portal/control/coordinator/inference).
- Monitor health endpoints and audit events continuously.

## Canonical references

- [Security Baseline](https://github.com/your-org/Edgecoder/blob/main/docs/security-baseline.md)
- [Public Mesh Operations](https://github.com/your-org/Edgecoder/blob/main/docs/public-mesh-operations.md)
- [Developer Guide Security Notes](https://github.com/your-org/Edgecoder/blob/main/README.dev.md)
