# Coordinator Federation

Coordinators in the EdgeCoder network form a gossip-based federation. Each coordinator maintains a local view of its agents' capabilities and shares aggregated summaries with peers.

## Capability Gossip

Every 60 seconds, each coordinator broadcasts a `capability_summary` mesh message:

```json
{
  "coordinatorId": "coord-abc",
  "agentCount": 15,
  "modelAvailability": {
    "qwen2.5-coder:7b": { "agentCount": 8, "totalParamCapacity": 56, "avgLoad": 1.2 },
    "qwen2.5-coder:1.5b": { "agentCount": 7, "totalParamCapacity": 10.5, "avgLoad": 0.8 }
  },
  "timestamp": 1740268800000
}
```

Receiving coordinators store these summaries in a `federatedCapabilities` map, enabling cross-coordinator queries.

## Cross-Coordinator Task Routing

When a coordinator has no suitable local agent:

1. Check `federatedCapabilities` for coordinators with matching model capacity
2. Forward task to best-fit coordinator via mesh relay
3. Receiving coordinator assigns to a local agent
4. Result returns through the same path

## Ledger Agreement

The ordering chain provides hash-linked, signed event logs. Cross-coordinator reconciliation uses quorum voting (`floor(approvedCoordinators / 2) + 1`). The issuance flow (Proposal, Vote, Commit, Checkpoint) ensures all coordinators agree on credit distributions.

Model swap events affect credit calculations through the quality multiplier — swapping to a smaller model reduces future earnings proportionally.

## Querying Federation State

| Endpoint | Purpose |
|---|---|
| `GET /mesh/capabilities` | All federated capability summaries |
| `GET /mesh/capabilities?model=X` | Coordinators with agents running model X |
| `GET /mesh/peers` | Connected federation peers |

## Monitoring

- Capability gossip failures logged as `capability_gossip_failed`
- Stale federation data degrades gracefully — local routing still works
- Gossip messages are Ed25519-signed and validated on receipt
