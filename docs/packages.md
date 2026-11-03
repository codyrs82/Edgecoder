# Packages and roles

EdgeCoder is one codebase shipped as three operator-facing packages (plus the separate MCP server below), each a fixed set of roles
of the same `edgecoder` dispatcher (`src/cli/edgecoder.ts`). A role behaves identically whether
it runs from npm, a package, a systemd unit or a container, because every path ends in
`edgecoder <role>` (or `EDGE_RUNTIME_MODE=<role>`).

| Package | Who runs it | Roles | How it ships |
| --- | --- | --- | --- |
| **Agent** | Anyone with idle CPU/GPU time; earns sats | `agent` (+ a per-GPU Ollama server) | `edgecoder-install` via the one-line installer, the `.pkg` / `.deb` / `.msi` packages, or the agent image `deploy/docker/Dockerfile.agent` (docs/install.md) |
| **Infrastructure node** | Operators hosting the network; paid from the fee pool | `all-in-one` (coordinator, inference, control plane, portal) next to Bitcoin Knots, LND and optionally electrs | `deploy/infra/docker-compose.yml` + `scripts/infra-bootstrap.sh` (docs/infra-node.md); on Fly, `scripts/fly-bootstrap-org.sh` |
| **Portal** | The public front door at edgecoder.io | `portal` | The server image with `EDGE_RUNTIME_MODE=portal` (`deploy/fly/fly.portal.toml`), behind Cloudflare (docs/edge-and-redundancy.md) |
| **MCP server** | AI agents (Claude Desktop, Claude Code, other MCP clients) | none: a stdio MCP server that calls the hosted API | `packages/mcp-server` (`@edgecoder/mcp-server`, bin `edgecoder-mcp`), built from the repo ([README](../packages/mcp-server/README.md), docs/mcp.md) |

Internal roles (`coordinator`, `control-plane`, `inference`, `ide-provider`) exist for split
deployments and development; `all-in-one` is what infrastructure nodes run.

## npm bins

```
edgecoder <role> [args]     dispatcher; EDGE_RUNTIME_MODE is the default role
edgecoder-agent             = edgecoder agent
edgecoder-coordinator       = edgecoder coordinator
edgecoder-portal            = edgecoder portal
edgecoder-install           = edgecoder install (the installer, docs/install.md)
```

`packages/mcp-server` is a separate npm package (`@edgecoder/mcp-server`, bin `edgecoder-mcp`):
the MCP server AI agents use to sign up, top up over Lightning and run compute through the hosted
API (docs/mcp.md, [packages/mcp-server/README.md](../packages/mcp-server/README.md)). It is not part of the server image.

## Images

- `deploy/docker/Dockerfile.server`: every non-agent role; pick with `EDGE_RUNTIME_MODE` (build
  arg or env) or `docker run <image> portal`.
- `deploy/docker/Dockerfile.agent`: the agent with Ollama; `docker run --gpus all <image>`.

## Why not a monorepo split

The roles share the economy, ledger, mesh and model code, and the parity tests (installer options,
portal pages, config schemas) depend on seeing all of it in one build. Splitting into npm
workspaces would add publishing and version-skew problems between coordinator and agent without
changing what an operator installs. The split that matters is at the package boundary above:
the agent never needs the portal or the Bitcoin stack, and the infrastructure bundle never needs
GPU drivers.
