# Portal edge security and redundancy

The portal (`edgecoder.io`) is the front door to the network: sign-in, wallet, market and the
agent download. This document covers putting Cloudflare in front of it, and how the UI is
syndicated so one failure does not take the front door down.

## 1. Cloudflare in front of the portal

`scripts/cloudflare-bootstrap.sh` configures the zone from the API (idempotent):

| Layer | What it does |
| --- | --- |
| DNS | `edgecoder.io` and `www` are proxied CNAMEs to `edgecoder-portal.fly.dev`; `_acme-challenge` (unproxied) lets Fly keep issuing the origin certificate over DNS-01. |
| TLS | Full (strict) to the Fly origin, always-HTTPS, TLS 1.2 minimum, TLS 1.3, HSTS preload, HTTPS rewrites. |
| WAF | Cloudflare Managed Ruleset + OWASP core (free plan: the free managed ruleset), a managed challenge for risky clients on `/auth/*`, unexpected-method and scanner-path blocks. |
| Rate limiting | Edge limit on `POST /auth/login`, `/auth/signup`, `/auth/resend-verification`, `/auth/passkey/*` and `/wallet/send/mfa/*` (10 per 10 s per IP by default). The portal keeps its own per-IP limits behind it. |
| Origin lock | A Transform Rule adds `x-edgecoder-origin: <token>` to every forwarded request. With `PORTAL_ORIGIN_LOCK_TOKEN` set, the portal refuses requests without it, so the `*.fly.dev` hostname cannot bypass the WAF. Fly health checks (`/health`) and coordinators (portal service token) are exempt. |
| Cache | `/`, `/privacy`, `/terms` and `/portal/vendor/*` are cached at the edge for 5 minutes; Always Online serves them while the origin is down. `/portal`, `/auth`, `/wallet`, `/nodes`, `/me`, `/internal` are never cached. |

### Run it

```bash
# 1. In the Cloudflare dashboard: add edgecoder.io, move the registrar's nameservers to Cloudflare.
# 2. Create an API token: Zone.Zone:Read, Zone.DNS:Edit, Zone.Zone Settings:Edit,
#    Zone.Zone WAF:Edit, Zone.Transform Rules:Edit, Zone.Cache Rules:Edit (+ Account.Pages:Edit for the mirror).
read -s CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
DOMAIN=edgecoder.io APPLY_FLY=1 bash scripts/cloudflare-bootstrap.sh
```

`APPLY_FLY=1` sets `PORTAL_EDGE=cloudflare` and `PORTAL_ORIGIN_LOCK_TOKEN` on the Fly app
(the portal restarts). Without it the script prints the `fly secrets set` command.

### Why the client-IP handling changes

Fly's proxy appends the address that connected to it to `x-forwarded-for`. Behind Cloudflare that
is a Cloudflare edge address, so with the default `trustProxy: 1` every visitor would share one
rate-limit bucket. With `PORTAL_EDGE=cloudflare` the portal keys on `cf-connecting-ip` instead,
and only when the request carries the origin-lock header (otherwise the header could be spoofed
by connecting to the Fly hostname directly).

### What stays off Cloudflare

Coordinators (`edgecoder-seed*.fly.dev`) are reached directly by agents and by the portal; they
are authenticated with the mesh token and are not behind the proxy. Agents never need the
portal's Fly hostname; the desktop and iOS apps use `PORTAL_PUBLIC_URL`.

## 2. Syndicating the UI

Three layers, cheapest first. All of them are set up by the scripts in this repo.

### 2a. Multi-region portal on Fly (minutes)

```bash
PORTAL_REGIONS=ord,ams,sin bash scripts/fly-bootstrap-org.sh edgecoder
# or directly:
fly scale count 3 --region ord,ams,sin --max-per-region 1 -a edgecoder-portal
```

Fly's anycast address routes each visitor to the nearest healthy machine and fails over when a
region is unhealthy. Sessions and accounts live in the portal's Postgres (primary in `ord`);
machines in other regions pay one round trip per query, which is acceptable for the portal's
request volume. If `ord` is down, Postgres is down with it: see 2c.

### 2b. Static mirror of the public pages (minutes)

The marketing home, privacy and terms pages render without request state, so they are exported
as plain HTML and hosted on Cloudflare Pages:

```bash
PORTAL_PUBLIC_URL=https://edgecoder.io npm run site:export      # -> dist-static/
DOMAIN=edgecoder.io PAGES_PROJECT=edgecoder-site bash scripts/cloudflare-bootstrap.sh
```

The mirror carries a `_redirects` file that forwards `/portal*`, `/auth/*`, `/wallet/*`,
`/nodes/*`, `/me/*` and `/.well-known/*` to the canonical portal, so links keep working. Point
`www.edgecoder.io` (or a `status.`/`mirror.` host) at the Pages project to use it as the
always-up landing page, and keep the apex on the live portal. Cloudflare's Always Online does the
same for cached copies of those pages on the apex.

### 2c. Independent origins with health-based failover (hours; paid add-on)

For a second origin that keeps sign-in working while Fly `ord` is down:

1. Deploy a second portal stack (the same `fly-bootstrap-org.sh` with another prefix in a
   different region, or another provider running `deploy/docker/Dockerfile.server`).
2. Run Postgres with a read replica in that region and promote it on failover (Fly Postgres
   supports replicas; the portal only needs `PORTAL_DATABASE_URL` repointed).
3. Add a Cloudflare Load Balancer (from $5/month) with both origins in one pool, health check
   on `/health`, steering "failover". DNS stays as it is; the LB replaces the apex CNAME.

### 2d. Where this is going: every infrastructure host serves the portal

The all-in-one image already bundles the portal on port 4310 next to the coordinator. Once
account and credit state is replicated between coordinators by signed, Bitcoin-anchored logs
(architecture step 2), any infrastructure host can serve the portal for any user and the
Cloudflare Load Balancer pool becomes "every healthy host". Until then, the portal's state
of record is the primary Postgres, and 2a to 2c are the redundancy that is honest about that.

## Verification

```bash
curl -sI https://edgecoder.io/ | grep -i '^cf-ray'                # served by Cloudflare
curl -s -o /dev/null -w '%{http_code}\n' https://edgecoder-portal.fly.dev/portal   # 403 once locked
curl -s https://edgecoder-portal.fly.dev/health                    # still 200 (exempt)
fly certs check edgecoder.io -a edgecoder-portal                   # origin certificate issued
```
