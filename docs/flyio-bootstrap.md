# Fly.io Bootstrap

The Fly layout is four apps (#33): two all-in-one seeds (`edgecoder-seed` in `ord`,
`edgecoder-seed-eu` in `cdg`), the portal (`edgecoder-portal`) and, when a bitcoind is available,
the anchor proxy (`edgecoder-anchor-proxy`). The separate coordinator, inference and control-plane
apps described in earlier versions of this document no longer exist: the seed runs
`EDGE_RUNTIME_MODE=all-in-one`.

## Bootstrap a fresh organization

```bash
fly auth login                           # or export FLY_API_TOKEN=...
export RESEND_API_KEY=re_...             # portal signup email; required in production
# optional: PORTAL_DOMAIN=edgecoder.io  OAUTH_GOOGLE_CLIENT_ID=... OAUTH_GOOGLE_CLIENT_SECRET=...
#           OAUTH_MICROSOFT_CLIENT_ID=... OAUTH_MICROSOFT_CLIENT_SECRET=...
#           BITCOIND_RPC_URL=... BITCOIND_RPC_USER=... BITCOIND_RPC_PASSWORD=...   (deploys the anchor proxy)
npm run fly:bootstrap -- <org-slug> [app-prefix]
```

`scripts/fly-bootstrap-org.sh` is idempotent. It:

1. creates the apps in the org (skips existing ones);
2. creates a Fly Postgres cluster `<prefix>-pg` and attaches it (`DATABASE_URL` on the seeds,
   `PORTAL_DATABASE_URL` on the portal);
3. creates the Ollama model volumes (`ollama_data` in `ord`, `ollama_data_eu` in `cdg`);
4. generates the production-required secrets once (kept in `.fly-bootstrap/<org>.env`, git-ignored,
   `chmod 600`) and sets them on each app;
5. renders `deploy/fly/*.toml` for the prefix and portal domain into `.fly-bootstrap/<org>/`;
6. deploys the seeds, runs the #9 post-deploy step (`chown -R 1000:1000 /data/ollama`, restart),
   deploys the portal and the anchor proxy;
7. smoke-tests `/health/runtime` and `/capacity` on both seeds and `/health` on the portal.

Pass a prefix when the default `edgecoder-*` app names are taken (Fly app names are global).
Set `PORTAL_DOMAIN` to use a custom host; the script runs `fly certs add` and prints the DNS
records to create. Passkeys are bound to that host (`PASSKEY_RP_ID`), so pick it before users enrol.

## After the first deploy

- Portal: `https://<prefix>-portal.fly.dev/health`, `/`, `/portal`, `/portal/chat`, `/auth/capabilities`
- Seeds: `https://<prefix>-seed.fly.dev/health/runtime` (public), `/status` and `/capacity` (mesh token)
- Enrol a node on the portal Nodes page, then start a worker with `AGENT_REGISTRATION_TOKEN`,
  `MESH_AUTH_TOKEN` (from the secrets file) and `COORDINATOR_URL=https://<prefix>-seed.fly.dev`.
- Ollama pulls `OLLAMA_MODEL` on first use (`OLLAMA_AUTO_INSTALL=true`); the first chat is slow.

## CI deploys

`.github/workflows/deploy-fly.yml` deploys the four configs after green CI on `main`, gated on the
repository variable `DEPLOY_ENABLED=true` and a `FLY_API_TOKEN` secret in the `production`
environment (#31). Its smoke URLs assume the default `edgecoder-*` app names.

## Access control verification

Coordinator routes are mesh-internal. Public unauthenticated requests must fail:

```bash
curl -i https://<prefix>-seed.fly.dev/status
# expected: HTTP 401 {"error":"mesh_unauthorized"}
curl -s https://<prefix>-seed.fly.dev/health/runtime      # the only public route (Fly health probe)
curl -s -H "x-mesh-token: $MESH_AUTH_TOKEN" https://<prefix>-seed.fly.dev/capacity
```

The Ollama API is never exposed as a public route; chat reaches it through the coordinator's
`/portal/chat` (portal service token) only.

## Node enrollment and activation flow

1. The user signs up in the portal (`/auth/signup`) or via SSO (Google/Microsoft) and verifies
   their email through the Resend link.
2. They enrol an agent or coordinator node on the Nodes page (`/nodes/enroll`) and get a
   `registrationToken`.
3. They set `AGENT_REGISTRATION_TOKEN` (plus `MESH_AUTH_TOKEN` and `COORDINATOR_URL`) on the node.
4. The node stays dormant until an operator approves it (coordinator operations dashboard, or
   `POST /agents/:agentId/approval` / `POST /coordinators/:coordinatorId/approval` on the control plane).
5. Once approved, the coordinator accepts the node's registration. A worker registers once per
   session and then only heartbeats; a node that registers 10 times in 10 minutes is
   auto-blacklisted (behavioural rule BHV008).

## DNS and TLS for a custom domain

The bootstrap script does this for the portal when `PORTAL_DOMAIN` is set. By hand:

```bash
fly ips allocate-v4 -a <prefix>-portal          # dedicated IPv4 (recommended for an apex record)
fly certs add edgecoder.io -a <prefix>-portal
fly certs show edgecoder.io -a <prefix>-portal  # prints the A/AAAA (or CNAME) records to create
```

Then set the portal's public origin to the domain and redeploy (passkeys are bound to
`PASSKEY_RP_ID`, so do this before users enrol passkeys):

```bash
fly secrets set PORTAL_PUBLIC_URL="https://edgecoder.io" PASSKEY_RP_ID="edgecoder.io" PASSKEY_ORIGIN="https://edgecoder.io" -a <prefix>-portal
fly secrets set PORTAL_SERVICE_URL="https://edgecoder.io" -a <prefix>-seed
fly secrets set PORTAL_SERVICE_URL="https://edgecoder.io" -a <prefix>-seed-eu
```

A seed can get its own name the same way (`fly certs add coordinator.edgecoder.io -a <prefix>-seed`);
then update `COORDINATOR_PUBLIC_URL` in its TOML and `COORDINATOR_DISCOVERY_URLS` in the portal's.

## Coordinator discovery

- DNS names are bootstrap/rendezvous only.
- The portal tries `COORDINATOR_DISCOVERY_URLS` in order and uses the first healthy seed (cached 60 s).
- Workers pick a coordinator from the portal's `/nodes/discover-coordinator`, then their local
  cache, then the bootstrap `COORDINATOR_URL`.
- Seeds find each other through `COORDINATOR_BOOTSTRAP_URLS` (the script points each seed at the other).
