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

## Coordinator peer allowlist (#52) — required before redeploying

In production, coordinators fail closed: a peer is trusted only if its key is on the allowlist. Before redeploying US and EU (or any coordinator that peers), set these on **every** coordinator:

| Variable | Per coordinator | Notes |
|---|---|---|
| `COORDINATOR_PRIVATE_KEY_PEM` | Its own stable Ed25519 key (PKCS#8 PEM), stored as a secret | Without it the key is regenerated on every restart and drops off its peers' allowlists. |
| `COORDINATOR_PEER_ID` | Optional stable id | The default is derived from `COORDINATOR_PUBLIC_URL`. |
| `MESH_PEER_ALLOWLIST` | `peerId:fingerprint@https://peer-url` for each **other** coordinator it peers with (the `@url` is recommended) | Fingerprint = SHA-256 (hex) of the peer's SPKI public key (see the one-liner in [Environment variables](/reference/environment-variables)). |

Without `MESH_PEER_ALLOWLIST`, a production coordinator rejects:
- token-only `/mesh/register-peer`;
- peers learned from bootstrap discovery or `peer_exchange` gossip;
- `/mesh/ingest` and `/mesh/relay-gossip` messages from peers that aren't allowlisted;
- forwarded `/result`s.

Peer endpoints are pinned. A peer's URL comes from its `@url` in the allowlist or, if it has none, from the bootstrap URL we reached it on. Gossip (`peer_exchange`) never sets or changes an endpoint, and a registration whose URL disagrees with the pin is rejected. An unpinned peer must be found by bootstrap before it can register.

Forwarded results must be signed by an allowlisted peer, can't be replayed, and are accepted only for subtasks this coordinator offered to the mesh.

Rollout: generate a key per coordinator, compute the fingerprints, set `MESH_PEER_ALLOWLIST` on all of them, then restart them. Until every coordinator has the others on its list, they won't peer.
