# Deployment Topology

This page documents production deployment shape and service boundaries.

## Standard Service Split

- **Portal**: user identity, account lifecycle, node enrollment, wallet/credits views.
- **Control Plane**: operator APIs for network/security/rollout governance.
- **Coordinator**: mesh scheduler and policy enforcer.
- **Inference**: decomposition/model inference service.
- **Databases**: coordinator/control-plane and portal can be segmented by service/network.

## Typical Production Domains

- Portal: `https://portal.edgecoder.io` or `https://edgecoder.io/portal`
- Control plane: `https://control.edgecoder.io`
- Coordinator: `https://coordinator.edgecoder.io`

## Local Development Ports

- Coordinator: `4301`
- Inference: `4302`
- Control plane: `4303`
- IDE provider: `4304`
- Portal: `4310`

## Fly-Oriented Topology Pattern

- Deploy each service as an independent Fly app.
- Keep process-level boundaries explicit.
- Use environment controls for service URLs and auth tokens.
- Apply rolling updates with health checks per app.

## Networking and Security Considerations

- Coordinator routes must remain mesh-authenticated.
- Inference routes can be token-gated.
- Keep model daemons bound to local/private interfaces when applicable.
- Keep secrets out of static config when possible; move sensitive values to secret stores.

## Installation and rollout references

- [Fly.io Bootstrap Guide](https://github.com/your-org/Edgecoder/blob/main/docs/flyio-bootstrap.md)
- [Agent + Coordinator Installation](https://github.com/your-org/Edgecoder/blob/main/docs/agent-and-coordinator-install.md)
- [Security Baseline](https://github.com/your-org/Edgecoder/blob/main/docs/security-baseline.md)
