# Coordinator Discovery and Selection

Architecture step 3. Agents and portals no longer need a hard-coded `COORDINATOR_URL`: they
gather coordinator candidates from static configuration, DNS and Nostr, probe them in parallel,
and pick the healthiest, lowest-latency, best-priced one. Coordinators publish a signed
announcement of themselves over HTTP and (optionally) Nostr.

Code: `src/discovery/` (`types.ts`, `dns.ts`, `nostr.ts`, `selector.ts`, `announce.ts`, `index.ts`).
Tests: `tests/discovery/`.

## The announcement record

Every coordinator can describe itself with a `CoordinatorAnnouncement`:

```json
{
  "peerId": "coord-1a2b3c4d5e6f",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "url": "https://coord-ord.edgecoder.io",
  "region": "ord",
  "services": ["swarm", "mesh", "economy"],
  "computeClasses": [],
  "version": "1.0.0",
  "announcedAtMs": 1761000000000,
  "signature": "<base64 Ed25519>"
}
```

The signature is the coordinator's existing Ed25519 mesh identity (`src/mesh/peer.ts`) over the
canonical JSON of every field except `signature` (fixed key order, `v: 1` prefix). Consumers
verify with `verifyAnnouncement()`; it also rejects records older than 24 h or more than 5 min in
the future. An announcement therefore binds `url` and `peerId` to a public key, which is what the
`EDGECODER_COORDINATOR_PINS` setting pins against.

Coordinators serve:

| Route | Auth | Body |
|---|---|---|
| `GET /discovery/announcement` | none | `{ announcement, nostr: { enabled, pubkey, relays } }`, freshly signed |
| `GET /discovery/peers` | none | `{ peers: CoordinatorAnnouncement[] }` learned from Nostr (verified, newest per peerId, 24 h max age) |

Both are read-only and public (agents call them before they hold a mesh token), so they are on the
unauthenticated allowlist in `src/swarm/coordinator.ts`.

## Sources

Candidates are merged (`discoverCoordinators`) and de-duplicated by URL and peerId. Later sources
enrich earlier ones (region, key, announcement) but the first source wins.

1. **Current** — the URL the process is already using, so stickiness can apply.
2. **Static** — `COORDINATOR_DISCOVERY_URLS`, `COORDINATOR_BOOTSTRAP_URLS` (and legacy
   `COORDINATOR_DISCOVERY_URL`), comma lists.
3. **DNS** — TXT records at `_edgecoder._tcp.<domain>`, SRV fallback (below).
4. **Nostr** — verified announcements from the configured relays.
5. **Peers** — one hop: every static/DNS/current candidate is asked for `/discovery/peers`
   (disabled with `expandPeers: false`; the portal enables it only when DNS or Nostr is on).

The merged list is capped at 32 candidates.

### DNS records operators publish

TXT records, one per coordinator, at `_edgecoder._tcp.<domain>` (default domain `edgecoder.io`;
override with `EDGECODER_DISCOVERY_DOMAIN`, which accepts a comma list):

```
_edgecoder._tcp.edgecoder.io.  300  IN  TXT  "v=ec1 url=https://coord-ord.edgecoder.io region=ord peer=coord-1a2b3c4d5e6f"
_edgecoder._tcp.edgecoder.io.  300  IN  TXT  "v=ec1 url=https://coord-fra.edgecoder.io region=fra peer=coord-9f8e7d6c5b4a"
```

Fields: `v=ec1` (required), `url=` (required, http/https), `region=`, `peer=` (the coordinator's
peerId, shown in its `/identity` and `/discovery/announcement`), optional `fp=<sha256 hex of the
public key PEM>` for pinning. Unknown keys are ignored; TXT chunks are joined before parsing.

SRV fallback, used only when a domain has no parseable TXT record:

```
_edgecoder._tcp.edgecoder.io.  300  IN  SRV  0 10 443 coord-ord.edgecoder.io.
_edgecoder._tcp.edgecoder.io.  300  IN  SRV  10 5 8443 coord-fra.edgecoder.io.
```

Records are ordered by priority (ascending) then weight (descending); port 443 maps to `https://host`,
port 80 to `http://host`, anything else to `https://host:port`.

With GoDaddy-managed zones (`src/portal/dns-manager.ts` manages the `coord-*` A records) add the
TXT records in the same zone; they are independent of the per-coordinator A records.

### Nostr

Coordinators publish a NIP-01 event of kind `30078` (parameterized replaceable, NIP-33) with the
tags `["d", "edgecoder-coordinator"]`, `["url", ...]`, `["region", ...]`, `["peer", ...]`,
`["t", "edgecoder"]`. `content` is the JSON announcement above (Ed25519-signed), and the event
itself is Schnorr-signed (BIP340, `@noble/curves`) with a secp256k1 key.

Coordinator setup:

```sh
EDGECODER_NOSTR_ANNOUNCE=1                 # turn the announcer on (off by default)
NOSTR_SECRET_KEY_HEX=<64 hex chars>        # optional; otherwise derived from the Ed25519 private key
EDGECODER_NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol   # default
EDGECODER_NOSTR_ANNOUNCE_INTERVAL_MS=300000                 # default 5 min (minimum 15 s)
COORDINATOR_REGION=ord                     # falls back to FLY_REGION, then "unknown"
```

The announcer runs 1 s after startup and then every interval; every relay call has a 5 s timeout
and failures are logged (`discovery_nostr_*`) and never thrown, so a dead relay cannot block or
crash the coordinator. On each run it also reads other coordinators' announcements from the
relays into the `/discovery/peers` store. The Nostr pubkey the coordinator uses is shown on
`/discovery/announcement` under `nostr.pubkey`.

Consumers (agents, portals) read from the same relays. Because the inner announcement is verified
with Ed25519, a hostile relay or Nostr key can only inject announcements that are self-consistent,
not impersonate a pinned coordinator. To restrict which Nostr authors are read at all, set
`EDGECODER_NOSTR_AUTHORS` to a comma list of hex pubkeys.

Transport: the `ws` package when installed, otherwise Node 22's global `WebSocket`.

## Selection

`rankCoordinators()` probes every candidate in parallel with a per-request timeout (3 s default):

- `GET /health/runtime` (public) — health gate and latency measurement; also `coordinator.queued`
  and `coordinator.agents`.
- `GET /capacity` (needs `x-mesh-token`) — `totals.totalCapacity`.
- `GET /economy/market/book?computeClass=<class>` (needs `x-mesh-token` or
  `x-portal-service-token`) — the class's `clearingMsatPerCredit` (falling back to mid, then
  reference).

Score (0..1; 0 when unhealthy) is a weighted mean of:

| Component | Weight | Value |
|---|---|---|
| latency | 0.35 | `1 - latency / 2000 ms`, clamped |
| load | 0.30 | `1 - queued / capacity` (agent count stands in for capacity without a token) |
| price | 0.20 | `cheapest / price` across healthy candidates; 0.5 when unknown |
| pinned | 0.15 | 1 when the candidate's key or peerId matches `EDGECODER_COORDINATOR_PINS`; the component is dropped when no pins are configured |

Rankings are cached for 60 s per candidate set; concurrent callers share one probe round.

**Stickiness**: the current coordinator is kept while it is healthy unless another candidate
scores better by more than the margin (`EDGECODER_DISCOVERY_MARGIN`, default `0.2` = 20%).
An unhealthy current coordinator fails over immediately.

## Who uses it

**Agents** (`src/swarm/worker-runner.ts`): when `COORDINATOR_URL` is unset, or
`EDGECODER_DISCOVERY=1`, the worker runs `selectCoordinatorFromEnv()` once at startup, before the
existing portal-based discovery, and uses the winner as its active coordinator. Portal discovery
(`PORTAL_URL` + `AGENT_REGISTRATION_TOKEN`) still takes precedence when configured.

**Portal** (`src/portal/coordinator-discovery.ts`): the `#35` ordered picker is unchanged by
default. `PORTAL_DISCOVERY=selector` switches it to the scored selector over the same
`COORDINATOR_DISCOVERY_URLS`; `PORTAL_DISCOVERY_SOURCES=static,dns,nostr` adds the other sources.

**Coordinators** (`src/swarm/coordinator.ts`): always serve `/discovery/*`; announce on Nostr only
with `EDGECODER_NOSTR_ANNOUNCE=1`.

## Signed registry and steering

The decision in docs/ROADMAP.md ("Global coordinator entry points") is one URL for the whole
platform, `coordinator.edgecoder.io`. Behind it is a pool of EdgeCoder seeds and admitted community
coordinators. Clients pick from that pool by latency and health. This is steering, not proxying:
the client talks to the chosen coordinator directly, and nothing in the middle sees its traffic.

Code: `src/discovery/registry.ts` (format, signing, verification, pinned keys),
`src/discovery/steering.ts` (client), `src/discovery/registry-mirror.ts` (coordinator mirror),
`src/portal/coordinator-registry.ts` (pool, admission, health checks, routes).
Tests: `tests/discovery/registry.test.ts`, `tests/discovery/steering.test.ts`,
`tests/portal/coordinator-registry.test.ts`.

### The registry document

The portal serves `GET /network/registry`:

```json
{
  "format": "edgecoder-registry/1",
  "keyId": "<sha256 hex of the registry key's SPKI DER>",
  "payload": "{\"v\":1,\"network\":\"edgecoder\",\"issuedAtMs\":...,\"expiresAtMs\":...,\"coordinators\":[...],\"fallbackUrls\":[...]}",
  "signature": "<base64 Ed25519 over the payload bytes>"
}
```

The signature covers the exact `payload` string, so no canonical JSON is needed. Each entry in
`coordinators` carries:

- `peerId` and `publicKeyFingerprint` (the `fingerprint` that `GET /identity` reports)
- `urls` and `region`
- `operator` (`id`, `name`, `kind`: `edgecoder` or `community`)
- `admission` (`verifiedOperator`, `publishedKey`, `stakeSats`)
- `admittedAtMs`
- `health` (`status`: `healthy`, `unhealthy` or `unknown`, plus `checkedAtMs`, `latencyMs`,
  `reason`, `consecutiveFailures`)

A document is valid for 15 minutes (`REGISTRY_TTL_MS`). The portal signs it again after each
health round, or when a third of that lifetime has passed.

Every coordinator also serves `GET /network/registry`. It relays the portal's document, caches it
for 30 s, and keeps serving the last good copy while the portal is down. The upstream is
`REGISTRY_UPSTREAM_URL`, else `PORTAL_SERVICE_URL`, else `PORTAL_PUBLIC_URL`, each with
`/network/registry` appended. The mirror is untrusted by design, because clients check the
signature themselves. This is why the single platform URL hands the registry out too.

### Pool, admission and health (portal)

- **Seeds:** `REGISTRY_SEEDS` lists EdgeCoder's own coordinators as a comma list of
  `peerId:fingerprint@url[=region]`. Use the `trustEntry` from each seed's `/identity`, then its
  URL. Repeat an entry to give a seed a second URL.
- **Community coordinators:** a system admin adds them with
  `POST /admin/network/registry/admissions`. This is a stub workflow, and the records are kept in
  `REGISTRY_POOL_FILE` as JSON. `POST /admin/network/registry/suspend` takes `{ peerId, suspended }`.
  `GET /admin/network/registry` lists every member with its admission problems and health.
- **Admission rules** (`admissionProblems`):
  - Every member needs a published key and valid URLs.
  - A community member also needs `verifiedOperator` and https URLs.
  - `stakeSats` is recorded but not enforced yet. The same goes for uptime history and the
    reliability score.
  - Members that fail a rule, or are suspended, are not published.
- **Health:** every `REGISTRY_HEALTH_INTERVAL_MS` (default 60 s), each URL of each published member
  is checked in two steps:
  1. `GET /identity`: the peerId must match, and the key must match the fingerprint.
  2. `GET /health/runtime`: it must return 2xx and not `ok: false`.
- **Marking:**
  - A wrong identity marks the member `unhealthy` at once.
  - Network or health failures mark it `unhealthy` after 2 consecutive rounds.
  - A healthy member is published with only the URLs that passed.
  - Unhealthy members stay in the document, marked, and clients exclude them.

### Clients (agent and desktop app)

`createCoordinatorSteering` runs in the agent (`src/swarm/worker-runner.ts`). The desktop app's
bundled agent is the same worker, so the app gets the same choice. Each round:

1. **Fetch the registry.** It tries `<configured coordinator URL>/network/registry`, then
   `<PORTAL_URL>/network/registry` (override both with `EDGECODER_REGISTRY_URLS`), then the cached
   copy in the agent's local store.
2. **Verify it.** The signature must check out against a pinned registry key, and the document
   must not have expired (5 min of clock skew is allowed). An unsigned, badly signed, expired or
   replayed document is never used. A replayed document is one older than the newest already
   seen.
3. **Measure latency.** For every `healthy` entry, the client sends 3 sequential `GET /identity`
   round trips and takes the median. Every answer must carry the registry's peerId and a key
   that matches the registry's fingerprint, or the coordinator is skipped.
4. **Pick one.** The lowest median wins. Hysteresis keeps the current coordinator unless the best
   is more than 25% faster and more than 25 ms faster.
5. **Fall back** to the configured URL (`coordinator.edgecoder.io`, the seeds) when there is no
   pinned key, no valid registry, or no verified healthy coordinator.

The keys listed in the verified registry go into the pinned-key store
(`PinnedKeyStore.setRegistryEntries`). The trust gate then accepts a registry-listed coordinator,
even in strict mode, with exactly the listed key. A static `TRUSTED_COORDINATOR_KEYS` entry for
the same peerId still wins.

A signed registry pick also takes precedence over unsigned discovery (DNS, Nostr and the portal's
`/nodes/discover-coordinator`). The agent steers again every `EDGECODER_STEERING_INTERVAL_MS`
(default 10 min) and on every failover. Steering is off when:

- the coordinator is a loopback URL,
- `EDGECODER_STEERING=off` is set, or
- no registry key is pinned.

The agent's local forwarder reports the last decision on `/forward/health`. The IDE provider adds
it to `/v1/ide/compute` as `steering`. The app shows it in Settings, under "Connected
through", as the coordinator, its region and its latency.

### Turning steering on (operator)

1. **Generate the registry key, offline.** Keep the private half in a secret manager, never in
   the repo:

   ```bash
   openssl genpkey -algorithm ed25519 -out registry-signing.pem
   openssl pkey -in registry-signing.pem -pubout -out registry-public.pem
   ```

2. **Configure the portal.**

   ```bash
   fly secrets set -a edgecoder-portal \
     REGISTRY_SIGNING_KEY_PEM="$(cat registry-signing.pem)" \
     REGISTRY_SEEDS="$(curl -s https://edgecoder-seed.fly.dev/identity | jq -r .trustEntry)@https://edgecoder-seed.fly.dev=ord,$(curl -s https://edgecoder-seed-eu.fly.dev/identity | jq -r .trustEntry)@https://edgecoder-seed-eu.fly.dev=ams"
   ```

   Then check that `curl https://edgecoder.io/network/registry/public-key` shows the key, and that
   `curl https://edgecoder.io/network/registry` lists both seeds as `healthy` after a minute.

3. **Publish the public key.** Put the PEM from `registry-public.pem` (or its 64-hex raw key) in
   `DEFAULT_REGISTRY_PUBLIC_KEYS` in `src/discovery/registry.ts`, then release the agent and the
   desktop app. Until that release ships, set `EDGECODER_REGISTRY_PUBLIC_KEYS` on agents to turn
   steering on. Also publish the key where operators can compare it, for example the docs site.
4. **Rotate the key** by pinning the new key next to the old one (the list takes several keys),
   releasing, switching `REGISTRY_SIGNING_KEY_PEM`, and dropping the old key in a later release.

### Latency DNS (later ops step)

`coordinator.edgecoder.io` is a plain DNS record today, so a client's first contact always
lands on the seeds, and steering happens after that. That is enough for correctness. To also make
the first contact the nearest healthy coordinator, the name needs a DNS provider that steers by
latency or geography with health checks:

- **Cloudflare Load Balancing:** pools per region, health monitors on `/health/runtime`, and
  dynamic (latency) or geo steering. Keep the record DNS-only (grey cloud) so TLS is not
  terminated in the middle. Moving the zone to Cloudflare is covered in
  docs/edge-and-redundancy.md.
- **Route 53:** latency-based or geolocation records with health checks.

Either one can be fed from the same registry, with healthy entries becoming pool members. Every
coordinator in that pool needs a certificate for `coordinator.edgecoder.io`. Clients still
verify the key over `/identity`, so DNS stays a hint and never becomes a trust anchor.

## Environment variables

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `EDGECODER_DISCOVERY` | agent | unset | `1` forces discovery even when `COORDINATOR_URL` is set |
| `EDGECODER_DISCOVERY_DOMAIN` | agent, portal | `edgecoder.io` | DNS domain(s) for `_edgecoder._tcp` lookups; `off` disables DNS |
| `EDGECODER_NOSTR_RELAYS` | all | `wss://relay.damus.io,wss://nos.lol` | Relay list; `off` disables Nostr for consumers |
| `EDGECODER_NOSTR_AUTHORS` | agent, portal | unset | Only read events from these hex pubkeys |
| `EDGECODER_NOSTR_ANNOUNCE` | coordinator | unset | `1` publishes announcements |
| `EDGECODER_NOSTR_ANNOUNCE_INTERVAL_MS` | coordinator | `300000` | Publish interval |
| `NOSTR_SECRET_KEY_HEX` | coordinator | derived | secp256k1 secret for the Nostr event signature |
| `COORDINATOR_REGION` | coordinator | `FLY_REGION` or `unknown` | Region in the announcement |
| `EDGECODER_COORDINATOR_PINS` | agent, portal | unset | Comma list of key fingerprints (sha256 hex of the PEM), PEMs or peerIds to prefer |
| `EDGECODER_COMPUTE_CLASS` | agent | `cpu` | Compute class whose market price is scored (`cpu`, `apple`, `gpu`, `gpu.dc`; legacy ids are mapped) |
| `EDGECODER_DISCOVERY_TIMEOUT_MS` | agent | `4000` | Per-source and per-probe timeout |
| `EDGECODER_DISCOVERY_MARGIN` | agent | `0.2` | Stickiness margin |
| `PORTAL_DISCOVERY` | portal | `ordered` | `selector` enables the scored picker |
| `PORTAL_DISCOVERY_SOURCES` | portal | `static` | Comma list of `static`, `dns`, `nostr` |
| `REGISTRY_SIGNING_KEY_PEM` | portal | unset | Ed25519 PKCS#8 PEM that signs `/network/registry`; unset means the registry is not served |
| `REGISTRY_SEEDS` | portal | unset | EdgeCoder seeds, `peerId:fingerprint@url[=region]`, comma list |
| `REGISTRY_POOL_FILE` | portal | unset | JSON file of admitted community coordinators |
| `REGISTRY_TTL_MS` / `REGISTRY_HEALTH_INTERVAL_MS` | portal | `900000` / `60000` | Registry lifetime / health-check interval |
| `REGISTRY_FALLBACK_URLS` | portal | `https://coordinator.edgecoder.io` | `fallbackUrls` in the registry |
| `REGISTRY_UPSTREAM_URL` | coordinator | portal's `/network/registry` | Source of the coordinator's registry mirror |
| `EDGECODER_REGISTRY_PUBLIC_KEYS` | agent | built-in list (empty for now) | Extra pinned registry keys (PEM or 64-hex), `;` or `,` separated |
| `EDGECODER_REGISTRY_URLS` | agent | `<COORDINATOR_URL>/network/registry`, `<PORTAL_URL>/network/registry` | Where the registry is fetched |
| `EDGECODER_STEERING` | agent | on | `off` disables registry steering |
| `EDGECODER_STEERING_INTERVAL_MS` | agent | `600000` | How often the agent steers again (minimum 60 s) |

## Operational notes

- Nothing here blocks startup: DNS, relay and probe calls all carry timeouts and discovery failures
  fall back to the configured/bootstrap URL.
- `/health/runtime` is the only probe that must succeed; without a mesh token the selector still
  ranks on health, latency and the agent count.
- To check what a coordinator publishes: `curl https://coord.example/discovery/announcement`.
- To check what the network sees: `curl https://coord.example/discovery/peers`, or query a relay
  for `{"kinds":[30078],"#d":["edgecoder-coordinator"]}`.
