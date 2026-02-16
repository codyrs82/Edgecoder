# ADR 0001: EdgeCoder Locked Decisions

Status: Accepted

## Context

EdgeCoder requires consistent architecture and policy behavior across local, cloud, and swarm modes.

## Decisions

1. Interactive and swarm-worker runtimes are separate paths.
2. Coordinator is logic-only; decomposition runs in separate inference service.
3. Unsupported executor subset routes to cloud queue with reason code.
4. Swarm jobs execute against frozen snapshots.
5. Swarm worker execution requires sandboxing.
6. Hard tasks route coordinator-first, then parent model escalation.
7. Support both `edgecoder-local` and `ollama-local` providers.
8. Agent mode supports `swarm-only` and `ide-enabled`.

## Consequences

- Better safety and deterministic behavior.
- More services to deploy (coordinator + inference + control plane).
- Cleaner separation of concerns and policy enforcement.
