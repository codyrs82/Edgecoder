# Deployment Plan Checklist

What is already configured vs. what else needs to be deployed for the simplified global decentralization plan (US/Canada first, then EU/APAC/LATAM; full-stack; Mac fleet revenue).

## Already in repo / deployable today

| Component | Where | Notes |
|-----------|--------|------|
| **Coordinator (primary)** | `deploy/fly/fly.toml` | `edgecoder-coordinator`, region `ord` |
| **Coordinator (second, same region)** | `deploy/fly/fly.coordinator-2.toml` | `edgecoder-coordinator-2`, region `ord` |
| **Inference service** | `deploy/fly/fly.inference.toml` | `edgecoder-inference`, region `ord` |
| **Control plane** | `deploy/fly/fly.control-plane.toml` | `edgecoder-control-plane`, region `ord` |
| **User portal** | `deploy/fly/fly.portal.toml` | `edgecoder-portal`, region `ord` |
| **Docs site** | `deploy/fly/fly.docs.toml` | `edgecoder-docs`, region `ord` |
| **Coordinator/control-plane DB** | Fly Postgres | `edgecoder-postgres` |
| **Portal DB** | Fly Postgres | `edgecoder-portal-postgres` |
| **Linux agent/coordinator** | `deploy/linux/bootstrap-host.sh`, `scripts/linux/systemd/` | systemd units + env examples |
| **macOS agent** | `scripts/macos/`, `npm run build:macos-installer` | .pkg installer, `edgecoder.env.example` |
| **Bootstrap runbook** | `docs/flyio-bootstrap.md` | Postgres, deploy order, secrets, DNS, coordinator-2 |
| **Agent/coordinator install** | `docs/agent-and-coordinator-install.md` | Enrollment, approval, macOS/Linux options |

## What else needs to be deployed (from the plan)

### 1. Second region: EU (Phase 2)

- **EU coordinator** – New Fly app (e.g. `edgecoder-coordinator-eu`) in a European region (e.g. `ams`). No Fly config in repo yet; can clone `fly.coordinator-2.toml` and parameterize app name, `primary_region`, `COORDINATOR_PUBLIC_URL`, `COORDINATOR_BOOTSTRAP_URLS`.
- **EU inference** – New Fly app (e.g. `edgecoder-inference-eu`) in same region. Clone `fly.inference.toml`, set region and app name; point EU coordinator at it via `INFERENCE_URL` and shared `INFERENCE_AUTH_TOKEN` (or region-specific tokens).
- **DNS** – e.g. `coordinator-eu.edgecoder.io`, `inference-eu.edgecoder.io` (or subdomain strategy of choice).
- **Control-plane / discovery** – Ensure `GET /network/coordinators` (or equivalent) includes EU coordinator so agents can discover it. May require control-plane config or DB-backed coordinator registry.

### 2. Third region: APAC (Phase 3)

- **APAC coordinator** – Same pattern as EU; e.g. `nrt` or `sin`, new Fly app.
- **APAC inference** – Same region as APAC coordinator.
- **DNS and discovery** – Same as EU.

### 3. Fourth region: LATAM (Phase 4)

- **LATAM coordinator + inference** – Same pattern; e.g. `gru` or other Fly LATAM region.
- **DNS and discovery** – Same as EU/APAC.

### 4. Multi-region Fly config strategy

- **Option A:** Add one `fly.coordinator-N.toml` and `fly.inference-N.toml` per region (e.g. `fly.coordinator-eu.toml`, `fly.inference-eu.toml`).
- **Option B:** Single parameterized template (e.g. `fly.coordinator.toml.tpl`) and a small script that generates `fly.<app>.toml` from `REGION=ams APP=edgecoder-coordinator-eu`.
- **Docs:** Extend `docs/flyio-bootstrap.md` with a “Adding a new region” section: create Postgres (if regional DB desired), deploy coordinator + inference, set secrets, register peer with existing coordinators, add DNS, update discovery.

### 5. Mac node profiles and revenue (plan items)

- **Node tiers** – Not yet in config. Plan: `studio-premium`, `mini-standard`, `mini-economy` (or similar). To deploy: define in agent capability registration and/or `scripts/macos/payload/etc/edgecoder/edgecoder.env.example` (e.g. `AGENT_TIER=...`); coordinator uses tier for scheduling/weighting.
- **Scheduling policy** – Already have `idle_only` / power policy in code; ensure macOS installer and env example document `idle_only` vs `always_on` for Mac Studios/minis.
- **Operator dashboard** – Portal already has credits/wallet and coordinator-ops. “Node earnings” / per-agent contribution view may exist in portal or control-plane; if not, add a simple view that reads from existing credit/issuance APIs and document it in the runbook.

### 6. Auxiliary services (plan mentions)

- **Regional queue/cache** – Today the coordinator uses Postgres (Fly Postgres) for durable state. If the plan later adds Redis (or similar) per region for queue/cache, that would be a new deployable (e.g. Upstash Redis per region or Fly Redis when available); no config in repo yet.
- **Metrics / log collector** – No dedicated deployable in repo. Optional: add a small Fly app or use a third-party (e.g. Logtail, Axiom) that pulls from coordinator/control-plane logs; document in runbook.
- **Payout / issuance reconciliation** – Logic may exist in code (e.g. issuance tick, payout); if it runs inside the coordinator process, no extra deploy. If you split it into a separate “reconciliation worker” app, add a Fly (or cron) deploy and document it.

### 7. Already documented, confirm live

- **coordinator-2** – Bootstrap already includes coordinator-2 deploy and DNS for `coordinator-2.edgecoder.io`. Confirm both coordinators are registered as peers and appear in `GET /network/coordinators`.
- **Portal + control-plane** – Single home in US/Canada; no need to duplicate until you have multiple control-plane instances.

## Suggested order

1. **Confirm US/Canada stack** – All Fly apps (coordinator, coordinator-2, inference, control-plane, portal, docs) deployed; DNS and mesh peer registration working.
2. **Add EU** – One coordinator + one inference in EU region; discovery and peer mesh updated; document in `flyio-bootstrap.md`.
3. **Add APAC, then LATAM** – Same pattern; parameterize or duplicate Fly configs and runbook.
4. **Mac node tiers** – Add env/concept for tier; optional operator view for node earnings.
5. **Optional** – Regional Redis, metrics worker, or standalone reconciliation job only if you outgrow in-process behavior.
