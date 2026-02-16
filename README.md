# EdgeCoder

EdgeCoder is a privacy-first coding assistant system that can run on your own machines and optionally collaborate with other machines.

In plain terms: it helps write and test code without always sending your source code to a cloud service.

## Docs map

- Start here (plain-language overview): `README.md`
- Developer setup and architecture details: `README.dev.md`
- Full product and architecture plan: `EDGECODER_PLAN.md`
- Public mesh onboarding and APIs: `docs/public-mesh-operations.md`
- macOS machine deployment: `docs/macos-installer.md`

## What problem this solves

Most AI coding tools send your code to remote servers. That can be slow, expensive, or a non-starter for private or regulated projects.

EdgeCoder is designed so you can:

- run coding help locally on your device
- keep sensitive code inside your environment
- optionally "borrow" compute from trusted machines in a shared mesh
- send only hard tasks to cloud review when you choose

## How it works (simple version)

EdgeCoder has a few core parts:

- **Agent**: plans code changes, writes code, runs tests, and retries.
- **Executor**: safely runs generated Python/JavaScript code and returns results.
- **Coordinator**: manages job queues when multiple machines are helping.
- **Inference service**: helps break large jobs into smaller tasks.
- **Control plane**: admin UI and APIs for policies, rollouts, and visibility.

Think of it like:

1. A local coding assistant does as much as possible on your machine.
2. If the job is too big, it can be queued for review or split across workers.
3. You keep control with clear status, auditability, and security controls.

## Who this is for

- developers who want local/offline coding assistance
- teams that need stronger privacy and control
- organizations building their own internal coding mesh
- operators who want policy controls (who can run what, where, and when)

## Repository at a glance

- `src/agent` - local coding loop logic
- `src/executor` - safe code execution and test feedback
- `src/swarm` - coordinator, queue flows, and mesh operations
- `src/control-plane` - admin APIs and UI endpoints
- `src/apps` - app and IDE-facing services
- `docs/` - operational and deployment documentation

## Quick start

```bash
npm install
npm run dev
# Optional iOS swarm-only worker profile:
AGENT_ID=iphone-1 AGENT_REGISTRATION_TOKEN=<portal-token> npm run dev:worker:ios
# Optional iOS power-aware scheduling telemetry:
# IOS_ON_EXTERNAL_POWER=true IOS_BATTERY_LEVEL_PCT=100 IOS_LOW_POWER_MODE=false
```

For local multi-service validation (including portal UI):

```bash
npm run dev:inference
npm run dev:coordinator
npm run dev:control
npm run dev:portal
```

### Main local endpoints

- Coordinator: `http://localhost:4301`
- Inference service: `http://localhost:4302`
- Control plane: `http://localhost:4303`
- IDE provider endpoint: `http://localhost:4304`
- User portal: `http://localhost:4310`

User portal UI includes:

- signup/login with email/password
- SSO buttons for Apple, Google, and Microsoft 365
- passkey enrollment and passkey login support
- email verification status and resend action
- enrolled node management and token issuance
- credits, wallet details, and payment intent views
- first-run wallet seed backup acknowledgement flow

### Economy and wallet APIs

- Dynamic price epoch view: `GET /economy/price/current` (control plane)
- Credit-to-sats conversion quote: `GET /economy/credits/:accountId/quote`
- Network status summary (capacity/jobs/pricing): `GET /network/summary` (control plane admin API)
- Publish price proposal from approved coordinator: `POST /economy/price/propose`
- Run weighted-median market consensus across peers: `POST /economy/price/consensus`
- Register wallet identity for an account: `POST /economy/wallets/register`
- Create BTC/LN credit purchase intent: `POST /economy/payments/intents`
- Confirm settlement and mint credits: `POST /economy/payments/intents/:intentId/confirm`
- Poll pending intents for settlement and expiry: `POST /economy/payments/reconcile`
- Manage custody policy: `POST /economy/treasury/policies`, `GET /economy/treasury`

Portal auth and iOS additions:

- Passkey registration: `POST /auth/passkey/register/options`, `POST /auth/passkey/register/verify`
- Passkey login: `POST /auth/passkey/login/options`, `POST /auth/passkey/login/verify`
- iOS dashboard aggregate (contribution + network): `GET /ios/dashboard`

Key env vars:

- `BITCOIN_NETWORK` (`bitcoin`, `testnet`, `signet`)
- `COORDINATOR_FEE_BPS` (default `150`)
- `COORDINATOR_FEE_ACCOUNT` (default `coordinator-fee:default`)
- `APPROVED_COORDINATOR_IDS` (comma-separated peer IDs)
- `LIGHTNING_PROVIDER` (`mock`, `lnd`, `cln`)
- `PAYMENT_INTENT_TTL_MS` (default `900000`)
- `PAYMENT_WEBHOOK_SECRET` (optional shared secret for payment webhook ingress)

## Run tests

```bash
npm test
```

## Full local stack with Docker

```bash
docker compose up --build
```

Stop:

```bash
docker compose down
```

## Build macOS installer (.pkg)

```bash
npm run build:macos-installer
```

This creates `build/EdgeCoder-<version>-macos-installer.pkg` that installs EdgeCoder as a `launchd` service.

## Security and trust basics

EdgeCoder includes controls for real-world environments:

- admin and UI access controls
- token-based service protection
- blacklist propagation for abusive nodes
- tamper-evident audit/ledger verification

## Learn more

- Developer guide: `README.dev.md`
- Planning and architecture: `EDGECODER_PLAN.md`
- Public mesh operations: `docs/public-mesh-operations.md`
- macOS machine deployment: `docs/macos-installer.md`
- Fly deployment and split-network setup: `docs/flyio-bootstrap.md`
