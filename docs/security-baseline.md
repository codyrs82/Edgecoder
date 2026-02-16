# Security Baseline

## Model Supply Chain

- Only allow approved model sources.
- Require checksum and signature validation before model activation.
- Reject unsigned or mismatched manifests.

## Runtime Controls

- Swarm workers must run in sandbox mode.
- Enforce policy constraints (CPU, memory, schedule, idle-only).
- Use frozen snapshots for job inputs.

## Data Handling

- Minimal cloud-review payloads only.
- Redact known secret patterns before any cloud handoff.
- Keep auditable lifecycle logs for job submit/assign/complete/requeue.

## Identity and Trust

- Agent registration includes OS/version/mode.
- Policy is server-authoritative and refreshed on heartbeat.
- Attestation hooks reserved for enterprise deployments.
