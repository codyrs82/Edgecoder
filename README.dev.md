# EdgeCoder Developer Guide

This document is the technical companion to `README.md`.
Use this file if you are developing, operating, or extending EdgeCoder services.

## What this repo implements

EdgeCoder is a local-first coding runtime with optional swarm orchestration.

Current scaffold includes:

- on-device agent loops (`interactive` and `worker`)
- safe Python/JavaScript executor subset checks and execution
- provider abstraction for local models (`edgecoder-local`, `ollama-local`)
- coordinator + inference split for swarm decomposition
- control-plane APIs for mode, rollout, and operational controls
- mesh protocol helpers, blacklist propagation, and audit verification
- credits, pricing, and queue ordering ledger verification

## Source layout

- `src/agent` - interactive and worker agent loops
- `src/executor` - subset validation and code execution helpers
- `src/swarm` - coordinator, queue, and worker runtime
- `src/inference` - decomposition/inference service
- `src/control-plane` - admin + deployment APIs/UI backend
- `src/apps/ide` - local model provider endpoint for IDE integration
- `src/mesh` - peer registration, gossip, and protocol handling
- `src/security` - blacklist and abuse-control flows
- `src/credits` and `src/economy` - account credits and pricing logic
- `src/ledger` - hash-chain and verification logic
- `src/bootstrap` - bootstrap and audit verification commands

## Requirements

- Node.js 20+
- npm
- Optional: Docker (for full local stack demo)
- Optional: Ollama CLI (when using `ollama-local`)

## Install

```bash
npm install
```

## Local development commands

- `npm run dev` - start the default entrypoint (`src/index.ts`)
- `npm run dev:coordinator` - coordinator service (`:4301`)
- `npm run dev:inference` - inference service (`:4302`)
- `npm run dev:control` - control-plane service (`:4303`)
- `npm run dev:portal` - user portal/auth service (`:4310`)
- `npm run dev:ide` - IDE provider endpoint (`:4304`)
- `npm run dev:worker` - start one worker node
- `npm run dev:worker:ios` - start iOS swarm-only worker profile (defaults to local Ollama)
- `npm run dev:cloudreview` - mock cloud review handshake server

### Typical multi-service local run

Use separate terminals:

```bash
npm run dev:inference
npm run dev:coordinator
npm run dev:control
npm run dev:portal
npm run dev:ide
```

Start one or more workers:

```bash
AGENT_ID=node-1 AGENT_OS=macos AGENT_REGISTRATION_TOKEN=<portal-token> npm run dev:worker
AGENT_ID=node-2 AGENT_OS=macos AGENT_REGISTRATION_TOKEN=<portal-token> npm run dev:worker
AGENT_ID=iphone-1 AGENT_REGISTRATION_TOKEN=<portal-token> npm run dev:worker:ios
```

## Testing and build

```bash
npm test
npm run build
```

Other useful scripts:

- `npm run test:watch` - watch mode tests
- `npm run bootstrap:coordinator` - DB/schema and readiness bootstrap
- `npm run verify:blacklist-audit` - verify tamper-evident blacklist chain

## Local endpoints

- Coordinator: `http://localhost:4301`
- Inference: `http://localhost:4302`
- Control plane: `http://localhost:4303`
- IDE provider: `http://localhost:4304`
- User portal: `http://localhost:4310`

Portal UI pages and actions:

- `GET /portal` - interactive portal frontend
- `POST /auth/signup` - email/password signup
- `POST /auth/login` / `POST /auth/logout`
- `GET /auth/oauth/:provider/start` for `google`, `apple`, `microsoft`
- `GET /auth/verify-email` and `POST /auth/resend-verification`
- `POST /nodes/enroll` and `GET /dashboard/summary`

Useful checks:

- `GET /status` on coordinator
- `GET /health` on inference
- `GET /ui` on control plane
- `GET /models` on IDE provider

## Docker stack

Start full demo stack:

```bash
docker compose up --build
```

Stop:

```bash
docker compose down
```

## Configuration notes

- `NETWORK_MODE=enterprise_overlay` enables enterprise overlay behavior
- `LOCAL_MODEL_PROVIDER=ollama-local` switches provider to Ollama-backed mode
- `OLLAMA_AUTO_INSTALL=true` attempts model pull on startup
- `OLLAMA_MODEL=<model>` selects model to pull/use
- `OLLAMA_HOST=<url>` supports remote Ollama host
- `IOS_OLLAMA_MODEL=<model>` optional default model for `npm run dev:worker:ios` (defaults to `qwen2.5:0.5b`)
- `IOS_ON_EXTERNAL_POWER=<true|false>` reports iOS charging state to coordinator (used for scheduling)
- `IOS_BATTERY_LEVEL_PCT=<0-100>` reports iOS battery percentage to coordinator
- `IOS_LOW_POWER_MODE=<true|false>` reports iOS low power mode and pauses assignment when true
- `IOS_BATTERY_PULL_MIN_INTERVAL_MS=<ms>` coordinator throttle window between assignments while iOS is on battery
- `IOS_BATTERY_TASK_STOP_LEVEL_PCT=<0-100>` coordinator stop threshold for iOS battery

Security-related environment controls:

- `ALLOWED_UI_IPS`
- `ALLOWED_ADMIN_IPS`
- `ADMIN_API_TOKEN`
- `MESH_AUTH_TOKEN`
- `PORTAL_SERVICE_URL`
- `PORTAL_SERVICE_TOKEN`
- `PORTAL_DATABASE_URL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

## Operational references

- Product and architecture plan: `EDGECODER_PLAN.md`
- Public mesh onboarding and APIs: `docs/public-mesh-operations.md`

## Contributing guidance

- Keep the split between interactive agent path and worker path.
- Preserve coordinator/inference service separation.
- Keep security/audit behaviors explicit and testable.
- Update docs when adding endpoints, env vars, or startup scripts.
