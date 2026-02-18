# Request Lifecycle Sequences

This page provides concrete sequence diagrams for critical EdgeCoder flows.
It complements the architecture pages with operator-friendly execution detail.

## 1) User Request Through Portal to Swarm Completion

```mermaid
sequenceDiagram
  participant User
  participant Portal
  participant Coordinator
  participant Inference
  participant Worker
  participant Economy

  User->>Portal: Submit coding request
  Portal->>Portal: Validate auth and session
  Portal->>Coordinator: Create schedulable job
  Coordinator->>Inference: Request decomposition
  Inference-->>Coordinator: Return subtasks
  Coordinator->>Worker: Assign subtask batch
  Worker->>Worker: Execute in constrained runtime
  Worker-->>Coordinator: Return results and telemetry
  Coordinator->>Economy: Record usage and contribution
  Coordinator-->>Portal: Publish aggregated result
  Portal-->>User: Show outcome and status
```

## 2) Node Enrollment and Activation

```mermaid
sequenceDiagram
  participant Operator
  participant Portal
  participant Worker
  participant Coordinator
  participant ControlPlane

  Operator->>Portal: Enroll node and request token
  Portal-->>Operator: Return registration token
  Operator->>Worker: Start runtime with token
  Worker->>Coordinator: Register node identity
  Coordinator->>ControlPlane: Publish pending node state
  Operator->>Portal: Approve node
  Portal->>ControlPlane: Apply approval decision
  ControlPlane-->>Coordinator: Node active
  Coordinator-->>Worker: Node accepted for assignments
```

## 3) Payment Intent to Credit Mint

```mermaid
sequenceDiagram
  participant User
  participant Portal
  participant Coordinator
  participant Economy
  participant Treasury

  User->>Portal: Buy credits request
  Portal->>Coordinator: Create payment intent
  Coordinator->>Economy: Store pending intent
  Economy-->>Portal: Return payment reference
  User->>Treasury: Settle BTC or LN invoice
  Treasury-->>Economy: Settlement callback
  Economy->>Economy: Confirm and mint credits
  Economy-->>Coordinator: Updated account balance
  Coordinator-->>Portal: Balance refreshed
  Portal-->>User: Credits available
```

## Operational Notes

- Sequence boundaries map to service ownership boundaries.
- Retries and partial failures are expected and should be idempotent.
- Auth checks happen at ingress and again at sensitive service boundaries.
