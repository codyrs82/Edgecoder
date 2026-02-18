# Role-based Runbooks

This page gives concrete responsibilities and recurring actions by role.

## Role Matrix

| Role | Primary Surfaces | Owns | Does Not Own |
|---|---|---|---|
| System Admin | Portal ops, control-plane APIs | policy defaults, admin approvals, security posture | day-to-day contributor node operations |
| Coordinator Owner | coordinator ops view, coordinator config | coordinator health, peer topology, queue behavior | user account auth lifecycle |
| Node Contributor | worker runtime, enrollment workflow | node uptime, registration token handling, local runtime health | global policy and treasury controls |
| Application User | portal user dashboard, wallet views | submitting workload, account-level workflow | mesh internals and deployment policy |

## System Admin Runbook

## Daily

- Verify coordinator, inference, and control-plane health endpoints.
- Review pending approvals and blacklist changes.
- Validate pricing and issuance windows have current recalculation data.

## Weekly

- Review rollout controls and model source policy.
- Verify ledger and blacklist audit checks.
- Confirm disaster recovery and backup paths are current.

## Incident

1. Restrict high-risk paths (policy + approval gates).
2. Isolate affected nodes or coordinators.
3. Reconcile ledger/audit state before reopening traffic.

## Coordinator Owner Runbook

## Daily

- Check coordinator runtime health and queue behavior.
- Confirm peer discovery and mesh connectivity.
- Review assignment quality and worker failure rates.

## Weekly

- Validate coordinator bootstrap/discovery configuration.
- Tune capacity and assignment controls.
- Review coordinator fee and treasury policy alignment with admin.

## Incident

1. Pause new assignments if integrity is uncertain.
2. Drain or isolate unhealthy workers.
3. Resume in staged mode with increased observability.

## Node Contributor Runbook

## Initial setup

1. Enroll node in portal.
2. Start worker with registration token.
3. Confirm node appears in pending/active lists.

## Ongoing

- Keep runtime updated.
- Monitor local resource usage and scheduling constraints.
- Rotate credentials or tokens when required by policy.

## Application User Runbook

## Usage flow

1. Authenticate and verify account.
2. Submit workload from portal or integrated surface.
3. Track status and review outputs.
4. Manage wallet/credits for sustained usage.

## Cross-links

- [Public Mesh Operations](/operations/public-mesh-operations)
- [Deployment Topology](/operations/deployment-topology)
- [Trust and Security](/security/trust-and-security)
