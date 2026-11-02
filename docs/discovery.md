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

## Operational notes

- Nothing here blocks startup: DNS, relay and probe calls all carry timeouts and discovery failures
  fall back to the configured/bootstrap URL.
- `/health/runtime` is the only probe that must succeed; without a mesh token the selector still
  ranks on health, latency and the agent count.
- To check what a coordinator publishes: `curl https://coord.example/discovery/announcement`.
- To check what the network sees: `curl https://coord.example/discovery/peers`, or query a relay
  for `{"kinds":[30078],"#d":["edgecoder-coordinator"]}`.
