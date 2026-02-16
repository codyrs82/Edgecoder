# Fly.io Bootstrap

This project is configured to run first production services on Fly.io:

- First coordinator service: `edgecoder-coordinator`
- First coordinator UI service (control-plane): `edgecoder-control-plane`
- User portal service: `edgecoder-portal`
- Coordinator/control-plane SQL backend: Fly Postgres (PostgreSQL 16)
- Portal SQL backend (separate): Fly Postgres (PostgreSQL 16)

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

## 3) Deploy Control Plane (UI home)

```bash
fly deploy -c deploy/fly/fly.control-plane.toml
```

## 4) Deploy User Portal (separate app/network)

```bash
fly deploy -c deploy/fly/fly.portal.toml
```

Restrict UI access to your public IP:

```bash
fly secrets set ALLOWED_UI_IPS="<YOUR_PUBLIC_IP>" -a edgecoder-control-plane
```

You can provide multiple IPs as comma-separated values.

Set admin and mesh security secrets:

```bash
fly secrets set ADMIN_API_TOKEN="<LONG_RANDOM_TOKEN>" ALLOWED_ADMIN_IPS="<YOUR_PUBLIC_IP>" -a edgecoder-control-plane
fly secrets set COORDINATOR_MESH_TOKEN="<LONG_RANDOM_TOKEN>" MESH_AUTH_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-control-plane
fly secrets set MESH_AUTH_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-coordinator
```

Enable coordinator-local Ollama on Fly (disabled by default in `fly.toml`):

```bash
fly secrets set LOCAL_MODEL_PROVIDER="ollama-local" OLLAMA_AUTO_INSTALL="true" OLLAMA_MODEL="qwen2.5-coder:latest" -a edgecoder-coordinator
fly secrets set OLLAMA_HOST="http://127.0.0.1:11434" -a edgecoder-coordinator
fly deploy -c deploy/fly/fly.toml
```

Note: the coordinator machine must have `ollama` binary available in the image/runtime for auto-install to succeed.

Set portal integration secrets so coordinator/control-plane can validate node activation:

```bash
fly secrets set PORTAL_SERVICE_URL="https://edgecoder-portal.fly.dev" PORTAL_SERVICE_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-coordinator
fly secrets set PORTAL_SERVICE_URL="https://edgecoder-portal.fly.dev" PORTAL_SERVICE_TOKEN="<LONG_RANDOM_TOKEN>" -a edgecoder-control-plane
```

Set portal auth and email secrets:

```bash
fly secrets set \
  PORTAL_DATABASE_URL="<POSTGRES_URL_FROM_PORTAL_ATTACH>" \
  PORTAL_SERVICE_TOKEN="<LONG_RANDOM_TOKEN>" \
  RESEND_API_KEY="<RESEND_API_KEY>" \
  RESEND_FROM_EMAIL="EdgeCoder <no-reply@yourdomain.com>" \
  PORTAL_PUBLIC_URL="https://edgecoder-portal.fly.dev" \
  CONTROL_PLANE_URL="https://edgecoder-control-plane.fly.dev" \
  CONTROL_PLANE_ADMIN_TOKEN="<ADMIN_API_TOKEN>" \
  OAUTH_GOOGLE_CLIENT_ID="<GOOGLE_CLIENT_ID>" \
  OAUTH_GOOGLE_CLIENT_SECRET="<GOOGLE_CLIENT_SECRET>" \
  OAUTH_MICROSOFT_CLIENT_ID="<MICROSOFT_CLIENT_ID>" \
  OAUTH_MICROSOFT_CLIENT_SECRET="<MICROSOFT_CLIENT_SECRET>" \
  OAUTH_APPLE_CLIENT_ID="<APPLE_SERVICE_ID>" \
  OAUTH_APPLE_CLIENT_SECRET="<APPLE_CLIENT_SECRET_OR_JWT>" \
  -a edgecoder-portal
```

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

Optional economy/payment secrets:

```bash
fly secrets set LIGHTNING_PROVIDER="mock" PAYMENT_WEBHOOK_SECRET="<RANDOM_SHARED_SECRET>" -a edgecoder-coordinator
```

Use admin token for non-UI control-plane APIs:

```bash
curl -H "Authorization: Bearer <ADMIN_API_TOKEN>" https://edgecoder-control-plane.fly.dev/agents
```

Verify blacklist audit integrity end-to-end:

```bash
CONTROL_PLANE_URL="https://edgecoder-control-plane.fly.dev" \
COORDINATOR_URL="https://edgecoder-coordinator.fly.dev" \
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
curl -X POST https://edgecoder-control-plane.fly.dev/bootstrap/coordinator
```

## 6) Node enrollment and activation flow

1. User signs up in portal (`/auth/signup`) or via SSO (Apple/Google/Microsoft).
2. User verifies email through Resend link.
3. User enrolls agent/coordinator node in portal (`/nodes/enroll`) and gets `registrationToken`.
4. User sets `AGENT_REGISTRATION_TOKEN` on the node runtime.
5. Node remains dormant until coordinator admin approves in UI/API:
   - `POST /agents/:agentId/approval`
   - `POST /coordinators/:coordinatorId/approval`
6. Once email is verified and node is approved, coordinator allows registration.
