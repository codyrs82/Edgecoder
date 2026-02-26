# Fly.io Bootstrap

This project is configured to run first production services on Fly.io:

- First coordinator service: `edgecoder-coordinator`
- First inference service: `edgecoder-inference`
- First coordinator UI service (control-plane): `edgecoder-control-plane`
- User portal service: `edgecoder-portal`
- Coordinator/control-plane SQL backend: Fly Postgres (PostgreSQL 16)
- Portal SQL backend (separate): Fly Postgres (PostgreSQL 16)

Custom production domains:

- Portal: `https://portal.edgecoder.io`
- Control plane: `https://control.edgecoder.io`
- Coordinator: `https://coordinator.edgecoder.io`

Related install runbook:

- `docs/agent-and-coordinator-install.md`

## 1) Create Fly Postgres clusters (separate DBs)

```bash
fly auth login
fly postgres create --name edgecoder-postgres --region ord --initial-cluster-size 1
fly postgres create --name edgecoder-portal-postgres --region ord --initial-cluster-size 1
```

Attach coordinator DB credentials:

```bash
fly postgres attach --app edgecoder-coordinator edgecoder-postgres
fly postgres attach --app edgecoder-control-plane edgecoder-postgres
```

Attach portal DB credentials:

```bash
fly postgres attach --app edgecoder-portal edgecoder-portal-postgres
```

## 2) Deploy Coordinator

```bash
fly deploy -c deploy/fly/fly.toml
```

## 3) Deploy Inference Service

```bash
fly deploy -c deploy/fly/fly.inference.toml
fly secrets set INFERENCE_URL="https://edgecoder-inference.fly.dev" -a edgecoder-coordinator
fly secrets set INFERENCE_AUTH_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-inference
fly secrets set INFERENCE_AUTH_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-coordinator
fly secrets set INFERENCE_COORDINATOR_PEER_ID="<COORDINATOR_PEER_ID>" INFERENCE_COORDINATOR_PUBLIC_KEY_PEM="<COORDINATOR_PUBLIC_KEY_PEM>" INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS="true" -a edgecoder-inference
fly deploy -c deploy/fly/fly.toml
```

## 4) Deploy Control Plane (UI home)

```bash
fly deploy -c deploy/fly/fly.control-plane.toml
```

## 5) Deploy User Portal (separate app/network)

```bash
fly deploy -c deploy/fly/fly.portal.toml
```

Restrict UI access to your public IP:

```bash
fly secrets set ALLOWED_UI_IPS="<YOUR_PUBLIC_IP>" -a edgecoder-control-plane
```

You can provide multiple IPs as comma-separated values.

Node/operator onboarding note:

- Coordinators and agents cannot fully join until node enrollment is approved.
- Enrollment is tied to a registered portal user email.
- Use portal coordinator operations page (`/portal/coordinator-ops`) to approve/reject coordinator and agent nodes.

Set admin and mesh security secrets:

```bash
fly secrets set ADMIN_API_TOKEN="<LONG_RANDOM_TOKEN>" ALLOWED_ADMIN_IPS="<YOUR_PUBLIC_IP>" -a edgecoder-control-plane
fly secrets set COORDINATOR_MESH_TOKEN="<LONG_RANDOM_TOKEN>" MESH_AUTH_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-control-plane
fly secrets set MESH_AUTH_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-coordinator
```

Enable coordinator-local Ollama on Fly:

```bash
fly secrets set LOCAL_MODEL_PROVIDER="ollama-local" OLLAMA_AUTO_INSTALL="false" OLLAMA_MODEL="qwen2.5:7b" -a edgecoder-coordinator
fly secrets set OLLAMA_HOST="http://127.0.0.1:11434" -a edgecoder-coordinator
fly deploy -c deploy/fly/fly.toml
```

Notes:

- Fly coordinator image includes Ollama CLI/runtime and starts `ollama serve` during app boot.
- Production recommendation is `OLLAMA_AUTO_INSTALL=false`; pre-pull models explicitly:

```bash
fly ssh console -a edgecoder-coordinator -C "sh -lc 'OLLAMA_NOPROGRESS=1 ollama pull qwen2.5:7b && ollama list'"
```

- Keep coordinator VM at or above performance 2x / 8GB for stable local Ollama operation.

Set portal integration secrets so coordinator/control-plane can validate node activation:

```bash
fly secrets set PORTAL_SERVICE_URL="https://portal.edgecoder.io" PORTAL_SERVICE_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-control-plane
fly secrets set PORTAL_SERVICE_URL="https://portal.edgecoder.io" PORTAL_SERVICE_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-coordinator
```

Set portal auth and email secrets:

```bash
fly secrets set \
  PORTAL_DATABASE_URL="<POSTGRES_URL_FROM_PORTAL_ATTACH>" \
  PORTAL_SERVICE_TOKEN="<LONG_RANDOM_TOKEN>" \
  COORDINATOR_OPERATIONS_OWNER_EMAILS="admin@example.com" \
  RESEND_API_KEY="<RESEND_API_KEY>" \
  RESEND_FROM_EMAIL="EdgeCoder <no-reply@yourdomain.com>" \
  PORTAL_PUBLIC_URL="https://portal.edgecoder.io" \
  PASSKEY_RP_ID="portal.edgecoder.io" \
  PASSKEY_RP_NAME="EdgeCoder Portal" \
  PASSKEY_ORIGIN="https://portal.edgecoder.io" \
  PASSKEY_CHALLENGE_TTL_MS="300000" \
  WALLET_SECRET_PEPPER="<HIGH_ENTROPY_RANDOM_SECRET>" \
  WALLET_DEFAULT_NETWORK="signet" \
  CONTROL_PLANE_URL="https://control.edgecoder.io" \
  CONTROL_PLANE_ADMIN_TOKEN="<ADMIN_API_TOKEN>" \
  OAUTH_GOOGLE_CLIENT_ID="<GOOGLE_CLIENT_ID>" \
  OAUTH_GOOGLE_CLIENT_SECRET="<GOOGLE_CLIENT_SECRET>" \
  OAUTH_MICROSOFT_CLIENT_ID="<MICROSOFT_CLIENT_ID>" \
  OAUTH_MICROSOFT_CLIENT_SECRET="<MICROSOFT_CLIENT_SECRET>" \
  -a edgecoder-portal
```

The portal now fails startup if `WALLET_SECRET_PEPPER` is missing, and in production it also
fails fast when portal service token/admin integration/passkey origin config is incomplete.

SSO provider callback URLs to register:

- Google redirect URI: `https://portal.edgecoder.io/auth/oauth/google/callback`
- Microsoft redirect URI: `https://portal.edgecoder.io/auth/oauth/microsoft/callback`

Recommended network split:

- put `edgecoder-portal` and `edgecoder-portal-postgres` in a dedicated Fly organization/network segment.
- keep `edgecoder-coordinator`, `edgecoder-control-plane`, and `edgecoder-postgres` in the coordinator network segment.
- allow only service-to-service HTTPS from coordinator/control-plane to portal internal APIs via `PORTAL_SERVICE_TOKEN`.

Set durable coordinator signing keys so blacklist signatures remain valid after restarts:

```bash
fly secrets set COORDINATOR_PEER_ID="coordinator-local" \
  COORDINATOR_PRIVATE_KEY_PEM="$(cat coordinator-private.pem)" \
  COORDINATOR_PUBLIC_KEY_PEM="$(cat coordinator-public.pem)" \
  -a edgecoder-coordinator
```

Set coordinator discovery/join env (dynamic mesh bootstrap):

```bash
fly secrets set \
  COORDINATOR_PUBLIC_URL="https://coordinator.edgecoder.io" \
  CONTROL_PLANE_URL="https://control.edgecoder.io" \
  COORDINATOR_BOOTSTRAP_URLS="https://coordinator.edgecoder.io" \
  COORDINATOR_REGISTRATION_TOKEN="<portal-enrollment-token-for-this-coordinator-node>" \
  -a edgecoder-coordinator
```

Optional economy/payment secrets:

```bash
fly secrets set LIGHTNING_PROVIDER="mock" PAYMENT_WEBHOOK_SECRET="<RANDOM_SHARED_SECRET>" -a edgecoder-coordinator
```

Recommended coordinator sizing (persisted in `deploy/fly/fly.toml`):

```bash
fly scale vm performance-2x --memory 8192 -a edgecoder-coordinator
```

Use admin token for non-UI control-plane APIs:

```bash
curl -H "Authorization: Bearer <ADMIN_API_TOKEN>" https://control.edgecoder.io/agents
```

Verify blacklist audit integrity end-to-end:

```bash
CONTROL_PLANE_URL="https://control.edgecoder.io" \
COORDINATOR_URL="https://coordinator.edgecoder.io" \
ADMIN_API_TOKEN="<ADMIN_API_TOKEN>" \
MESH_AUTH_TOKEN="<MESH_AUTH_TOKEN>" \
npm run verify:blacklist-audit
```

## 5) Coordinator Bootstrap

Run DB migration and optional Ollama bootstrap:

```bash
fly ssh console -a edgecoder-coordinator -C "cd /app && node dist/bootstrap/coordinator.js"
```

Or trigger through API:

```bash
curl -X POST https://control.edgecoder.io/bootstrap/coordinator
```

## 5b) Access control verification

Coordinator is mesh-internal only. Public unauthenticated requests should fail:

```bash
curl -i https://coordinator.edgecoder.io/status
# expected: HTTP 401 {"error":"mesh_unauthorized"}
```

Authenticated internal check (from coordinator machine):

```bash
fly ssh console -a edgecoder-coordinator -C "sh -lc 'curl -s -H \"x-mesh-token: $MESH_AUTH_TOKEN\" http://127.0.0.1:4301/health/runtime'"
```

Expected behavior:

- Coordinator routes require `x-mesh-token`.
- Ollama API is not exposed as public route.
- IDE workloads route through local agents (not direct coordinator model endpoint access).

## 6) Node enrollment and activation flow

1. User signs up in portal (`/auth/signup`) or via SSO (Google/Microsoft).
2. User verifies email through Resend link.
3. User enrolls agent/coordinator node in portal (`/nodes/enroll`) and gets `registrationToken`.
4. User sets `AGENT_REGISTRATION_TOKEN` on the node runtime.
5. Node remains dormant until coordinator admin approves in UI/API:
   - `POST /agents/:agentId/approval`
   - `POST /coordinators/:coordinatorId/approval`
6. Once email is verified and node is approved, coordinator allows registration.

## 7) DNS and TLS setup for edgecoder.io

1. Allocate dedicated IPv4 addresses (recommended for apex + stability):

```bash
fly ips allocate-v4 -a edgecoder-portal
fly ips allocate-v4 -a edgecoder-control-plane
fly ips allocate-v4 -a edgecoder-coordinator
```

2. Register certificates on each app:

```bash
fly certs add portal.edgecoder.io -a edgecoder-portal
fly certs add control.edgecoder.io -a edgecoder-control-plane
fly certs add coordinator.edgecoder.io -a edgecoder-coordinator
```

3. DNS records to create at your registrar/DNS provider:

- `A` record: `portal` -> `<edgecoder-portal IPv4 from fly ips list -a edgecoder-portal>`
- `AAAA` record: `portal` -> `<edgecoder-portal IPv6 from fly ips list -a edgecoder-portal>`
- `A` record: `control` -> `<edgecoder-control-plane IPv4>`
- `AAAA` record: `control` -> `<edgecoder-control-plane IPv6>`
- `A` record: `coordinator` -> `<edgecoder-coordinator IPv4>`
- `AAAA` record: `coordinator` -> `<edgecoder-coordinator IPv6>`

Optional apex routing:

- If you also want `https://edgecoder.io` (apex) on the portal app, add:
  - `fly certs add edgecoder.io -a edgecoder-portal`
  - `A/AAAA` records for apex `@` -> portal app IPs

4. Verify cert issuance:

```bash
fly certs show portal.edgecoder.io -a edgecoder-portal
fly certs show control.edgecoder.io -a edgecoder-control-plane
fly certs show coordinator.edgecoder.io -a edgecoder-coordinator
```

5. After DNS propagates, update secrets if needed and redeploy:

```bash
fly secrets set PORTAL_SERVICE_URL="https://portal.edgecoder.io" -a edgecoder-coordinator
fly secrets set PORTAL_SERVICE_URL="https://portal.edgecoder.io" -a edgecoder-control-plane
fly secrets set PORTAL_PUBLIC_URL="https://portal.edgecoder.io" PASSKEY_RP_ID="portal.edgecoder.io" PASSKEY_ORIGIN="https://portal.edgecoder.io" CONTROL_PLANE_URL="https://control.edgecoder.io" -a edgecoder-portal
fly deploy -c deploy/fly/fly.toml
fly deploy -c deploy/fly/fly.control-plane.toml
fly deploy -c deploy/fly/fly.portal.toml
```

## 8) Dynamic coordinator discovery model

- DNS names are bootstrap/rendezvous only (`portal`, `control`, optional seed coordinator).
- Control plane exposes `GET /network/coordinators` for runtime discovery.
- Workers select coordinator using:
  - discovery registry -> local cache -> bootstrap `COORDINATOR_URL`
- Coordinators discover peers using:
  - discovery registry -> local cache -> `COORDINATOR_BOOTSTRAP_URLS`
