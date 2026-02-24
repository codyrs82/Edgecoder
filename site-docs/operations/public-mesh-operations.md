# Public Mesh Operations

This page condenses operator-focused workflows from `docs/public-mesh-operations.md`,
`docs/agent-and-coordinator-install.md`, and `docs/flyio-bootstrap.md`.

## Coordinator Placement and Role

- Run at least one coordinator as the policy + scheduling center.
- In production, coordinators are not public-open APIs; mesh auth gates protected routes.
- Coordinators maintain agent registry, capacity state, queue orchestration, and result aggregation.

## Node Join and Enrollment Model

1. User creates/enrolls node from portal.
2. Enrollment token is issued for node registration.
3. Worker runtime starts with registration token and coordinator URL.
4. Node appears in coordinator/control-plane catalogs.
5. Coordinator-owner/admin approval activates node for production contribution.

## Operational Controls

- Network mode toggles (`public_mesh` vs `enterprise_overlay`).
- Agent and coordinator approval gates.
- Blacklist propagation and abuse controls.
- Health and runtime observability endpoints for coordinator and inference.

## Peer and Discovery Model

- Discovery resolution order typically follows:
  1. live discovery feed
  2. local cache
  3. bootstrap URL fallback
- Coordinator peers similarly use registry/cache/bootstrap sources.
- Avoid static hardcoded coordinator IPs as primary production strategy.

## Coordinator API Domains

Major operational groups include:

- **Health + identity**: readiness/runtime checks and service identity.
- **Mesh + peers**: peer registration, gossip, relay, and direct-work collaboration.
- **Economy + treasury**: pricing, quote, payment intent, and treasury policy endpoints.
- **Issuance + stats**: rolling issuance recalculation, quorum, anchors, verification.
- **Ledger + credits**: balance/history views and verification snapshots.

See [API Surfaces](/reference/api-surfaces) for consolidated endpoint map.

## Runbook Links (Canonical)

- [Public Mesh Operations Source](https://github.com/codyrs82/Edgecoder/blob/main/docs/public-mesh-operations.md)
- [Agent + Coordinator Install](https://github.com/codyrs82/Edgecoder/blob/main/docs/agent-and-coordinator-install.md)
- [Fly.io Bootstrap](https://github.com/codyrs82/Edgecoder/blob/main/docs/flyio-bootstrap.md)
- [Cross-OS Validation](https://github.com/codyrs82/Edgecoder/blob/main/docs/cross-os-validation.md)
