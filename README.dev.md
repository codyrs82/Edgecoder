# EdgeCoder Developer Guide

This document is the technical companion to `README.md`.
Use this file if you are developing, operating, or extending EdgeCoder services.

## Current Live URLs

- Portal: `https://portal.edgecoder.io/portal`
- Control plane API: `https://control.edgecoder.io` (UI retired; use portal operations page)
- Coordinator API base: `https://coordinator.edgecoder.io` (requires `x-mesh-token`)

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
- `scripts/macos` - macOS pkg installer assets and launchd runtime wrapper
- `scripts/linux/systemd` - Linux service unit templates and installer script
- `deploy/linux` - one-shot Linux host bootstrap script

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
- `npm run docs:dev` - run docs site locally (`site-docs`, default `:5173`)
- `npm run docs:build` - build static docs output
- `npm run docs:preview` - preview built docs site

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

Production endpoints:

- Portal: `https://portal.edgecoder.io/portal`
- Coordinator operations page: `https://portal.edgecoder.io/portal/coordinator-ops`
- Coordinator: `https://coordinator.edgecoder.io` (mesh token required)

Portal UI pages and actions:

- `GET /portal` - interactive portal frontend
- `POST /auth/signup` - email/password signup
- `POST /auth/login` / `POST /auth/logout`
- `GET /auth/oauth/:provider/start` for `google`, `microsoft`
- `GET /auth/verify-email` and `POST /auth/resend-verification`
- `POST /auth/passkey/register/options` + `POST /auth/passkey/register/verify`
- `POST /auth/passkey/login/options` + `POST /auth/passkey/login/verify`
- `POST /nodes/enroll` and `GET /dashboard/summary`
- `POST /me/theme` - persist user theme preference (`midnight`, `emerald`, `light`)
- `GET /ios/dashboard` - iOS/mobile aggregate view (contribution, wallet snapshot, network summary)
- `GET /wallet/onboarding` + `POST /wallet/onboarding/acknowledge`
- `/portal` ships a high-contrast dark/glass dashboard style tuned for operator readability

Useful checks:

- `GET /status` on coordinator (requires `x-mesh-token`)
- `GET /health/runtime` on coordinator (requires `x-mesh-token`)
- `GET /health` on inference
- `POST /decompose` on inference (requires `x-inference-token` when `INFERENCE_AUTH_TOKEN` is set)
- `GET /portal/coordinator-ops` in portal (authenticated coordinator owner operations page)
- `GET /models` on IDE provider
- `GET /network/summary` on control plane
- `GET /network/coordinators` on control plane (public coordinator discovery feed)

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
- `OLLAMA_AUTO_INSTALL=false` is recommended in production Fly deployments
- `OLLAMA_AUTO_INSTALL=true` attempts model pull on startup and can delay startup/health
- `OLLAMA_MODEL=<model>` selects model to pull/use
- `OLLAMA_HOST=<url>` supports remote Ollama host
- `IOS_OLLAMA_MODEL=<model>` optional default model for `npm run dev:worker:ios` (defaults to `qwen2.5:0.5b`)
- `IOS_ON_EXTERNAL_POWER=<true|false>` reports iOS charging state to coordinator (used for scheduling)
- `IOS_BATTERY_LEVEL_PCT=<0-100>` reports iOS battery percentage to coordinator
- `IOS_LOW_POWER_MODE=<true|false>` reports iOS low power mode and pauses assignment when true
- `IOS_BATTERY_PULL_MIN_INTERVAL_MS=<ms>` coordinator throttle window between assignments while iOS is on battery
- `IOS_BATTERY_TASK_STOP_LEVEL_PCT=<0-100>` coordinator stop threshold for iOS battery
- `CONTROL_PLANE_URL=<url>` allows agents/coordinators to discover live coordinators from control plane
- `COORDINATOR_DISCOVERY_URL=<url>` overrides discovery endpoint (default `${CONTROL_PLANE_URL}/network/coordinators`)
- `COORDINATOR_CACHE_FILE=<path>` local worker cache for last known coordinator URL
- `COORDINATOR_PUBLIC_URL=<url>` externally reachable URL a coordinator advertises to peers
- `COORDINATOR_BOOTSTRAP_URLS=<url1,url2,...>` explicit coordinator peer seed list
- `COORDINATOR_REGISTRATION_TOKEN=<portal-token>` enrollment token used when a coordinator joins mesh peers
- `COORDINATOR_PEER_CACHE_FILE=<path>` local coordinator cache for discovered peer URLs

Security-related environment controls:

- `ALLOWED_UI_IPS`
- `ALLOWED_ADMIN_IPS`
- `ADMIN_API_TOKEN`
- `MESH_AUTH_TOKEN`
- `INFERENCE_AUTH_TOKEN`
- `INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS`
- `INFERENCE_COORDINATOR_PEER_ID`
- `INFERENCE_COORDINATOR_PUBLIC_KEY_PEM`
- `INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON`
- `PORTAL_SERVICE_URL`
- `PORTAL_SERVICE_TOKEN`
- `PORTAL_DATABASE_URL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

Coordinator exposure model:

- Coordinator APIs are mesh-internal and require `x-mesh-token`.
- Public internet cannot call coordinator routes directly without mesh auth.
- Inference decomposition routes can be token-gated with `INFERENCE_AUTH_TOKEN`; coordinator forwards `x-inference-token` automatically.
- Coordinator->inference requests can be signature-gated with timestamp+nonce replay protection using coordinator peer keys.
- Ollama daemon listens on `127.0.0.1:11434` inside coordinator runtime and is not exposed as public API.
- IDE integrations are expected to route through local agent runtime, not directly to coordinator model endpoints.
- Control-plane legacy `/ui*` routes are retired and return redirect/410 responses; use portal coordinator operations pages.

Coordinator discovery and failover model:

- Agents resolve coordinators at runtime in this order: discovery registry -> local cache -> bootstrap URL.
- Coordinators discover mesh peers at runtime in this order: discovery registry -> local cache -> bootstrap URLs.
- Keep DNS/static config only for bootstrap/control-plane endpoints; avoid shipping hardcoded coordinator IPs.

Portal passkey and wallet bootstrap env:

- `PASSKEY_RP_ID` (default `localhost`)
- `PASSKEY_RP_NAME` (default `EdgeCoder Portal`)
- `PASSKEY_ORIGIN` (default `PORTAL_PUBLIC_URL`)
- `PASSKEY_CHALLENGE_TTL_MS` (default `300000`)
- `WALLET_DEFAULT_NETWORK` (`bitcoin`, `testnet`, `signet`; default `signet`)
- `WALLET_SECRET_PEPPER` (required; server-side secret used to derive wallet secret refs)
- `DOCS_SITE_URL` (external docs URL shown in portal/home navigation)
- `GITHUB_REPO_URL` (repository URL shown in portal/home navigation)

Production startup hardening:

- Portal startup fails fast in production when `PORTAL_SERVICE_TOKEN`, `CONTROL_PLANE_URL`,
  `CONTROL_PLANE_ADMIN_TOKEN`, passkey RP/origin values, or `PORTAL_PUBLIC_URL` are missing.
- In production, `PASSKEY_ORIGIN` and `PORTAL_PUBLIC_URL` must be `https://`.

## Operational references

- Product and architecture plan: `EDGECODER_PLAN.md`
- Public mesh onboarding and APIs: `docs/public-mesh-operations.md`
- iOS app release checklist: `docs/ios-app-store-release.md`
- Docs site deployment and hosting: `docs/docs-site-deployment.md`

## Native iOS app project

- Xcode project: `ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj`
- App scheme: `EdgeCoderIOS`
- Build for simulator:

```bash
xcodebuild -project "ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj" \
  -scheme "EdgeCoderIOS" \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2' \
  build
```
- Agent and coordinator install runbook: `docs/agent-and-coordinator-install.md`
- Fly deployment and domain setup: `docs/flyio-bootstrap.md`

## Contributing guidance

- Keep the split between interactive agent path and worker path.
- Preserve coordinator/inference service separation.
- Keep security/audit behaviors explicit and testable.
- Update docs when adding endpoints, env vars, or startup scripts.
