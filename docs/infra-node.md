# Infrastructure node

The infrastructure node is the bundle an operator runs to host EdgeCoder's network services and
get paid for it from the network fee pool. It is separate from the compute agent
(`docs/install.md`): an agent sells CPU and GPU time per task; an infrastructure node keeps the
network running and is paid for being up. One host can do both.

The bundle is a Docker Compose project, `deploy/infra/docker-compose.yml`:

| Service | Image | What it does for the network |
| --- | --- | --- |
| `edgecoder` | built from `deploy/docker/Dockerfile.server` (`EDGE_RUNTIME_MODE=all-in-one`) | Coordinator (port 4301), inference (4302) and control plane (4303). Schedules tasks, settles payments, anchors checkpoints, peers with the other coordinators. The embedded compute worker is off (`DISABLE_SELF_AGENT=1`). |
| `bitcoind` | `btcpayserver/bitcoinknots:29.3.knots20260210` | Bitcoin Knots full (or pruned) node. The coordinator anchors its checkpoints through it (`BITCOIN_ANCHOR_PROVIDER=bitcoind`) and lnd uses it as chain backend. |
| `lnd` | `lightninglabs/lnd:v0.21.4-beta` | Lightning node the coordinator creates invoices on and pays from (`LIGHTNING_PROVIDER=lnd`). |
| `electrs` | `getumbrel/electrs:v0.10.10`, compose profile `indexer` | Electrum index over the local chain; optional. |
| `postgres` | `postgres:16` | Coordinator database. |

Every pulled image is pinned by sha256 digest in the compose file (`image: <name>:<tag>@sha256:...`);
`tests/repo/docker-digests.test.ts` fails on an unpinned one.

`scripts/infra-bootstrap.sh` writes the configuration, starts the stack and creates the two
wallets without prompting. The variable table it works from is `src/install/infra-role.ts`
(`renderInfraEnv`, `servicesFromCompose`); `tests/install/infra-role.test.ts` keeps
`deploy/infra/.env.example`, the compose file and the config templates in step with it.

## Requirements

An always-on Linux host (macOS works for signet trials) with Docker Engine and the
`docker compose` plugin v2, `openssl` and `curl`, a public IPv4 address or a forwarded port, and
an SSD. Spinning disks do not finish the initial sync in a useful time.

| Network | bitcoind data (full) | Pruned (`--prune 50000`) | + electrs (`--with-electrs`, full node only) | RAM | Initial sync |
| --- | --- | --- | --- | --- | --- |
| `bitcoin` (mainnet) | ~750 GB, growing ~80 GB a year | ~65 GB | + ~100 GB | 16 GB | 1 to 3 days |
| `testnet` (testnet3) | ~80 GB | ~60 GB | + ~15 GB | 8 GB | hours |
| `signet` | ~5 GB | not worth it | + ~1 GB | 8 GB | minutes |

Sizes are approximate and grow. Postgres, lnd and the coordinator add a few GB. 4 CPU cores are
enough; `BITCOIN_DBCACHE` (default 2000 MiB) trades RAM for sync speed. The fee pool pays the same
for a pruned node as for a full one; only `electrs` needs the full chain.

Start on signet. The chain is small, coins are free, and the only difference from mainnet is
`--mainnet` and a fresh set of volumes.

## Set up

```bash
git clone https://github.com/codyrs82/edgecoder.git && cd edgecoder

# Signet trial: writes deploy/infra/.env, starts everything, creates both wallets.
scripts/infra-bootstrap.sh --signet --coordinator-url https://infra.example:4301

# Mainnet, pruned to ~50 GB of blocks, advertising the lnd address for inbound channels:
scripts/infra-bootstrap.sh --mainnet --prune 50000 \
  --coordinator-url https://infra.example:4301 \
  --portal-token <token from the portal operator> \
  --registration-token <token from the network operator> \
  --account-id <your portal account id> \
  --lightning-address you@infra.example \
  --external-ip 203.0.113.9

# Add the Electrum index later (full node only):
scripts/infra-bootstrap.sh --with-electrs
```

The script is idempotent. It generates every secret it can (`MESH_AUTH_TOKEN`, `ADMIN_API_TOKEN`,
`INFERENCE_AUTH_TOKEN`, `PAYMENT_WEBHOOK_SECRET`, the bitcoind RPC password and rpcauth salt, the
Postgres password, the lnd wallet password) and keeps whatever is already in
`deploy/infra/.env`; flags overwrite single values. Every variable is documented in
`deploy/infra/.env.example`. Edit `.env` by hand and re-run the script: it re-renders
`deploy/infra/generated/bitcoin.conf` and `lnd.conf` from the templates and restarts what changed.

What it leaves behind:

| Path | Contents | Mode |
| --- | --- | --- |
| `deploy/infra/.env` | all settings and secrets | 600 |
| `deploy/infra/generated/bitcoin.conf`, `lnd.conf` | rendered from `*.conf.template` | 600 |
| `deploy/infra/secrets/lnd-wallet-password` | lnd unlocks itself from it on every start (compose secret) | 600 |
| `deploy/infra/secrets/lnd-seed.txt` | the 24-word lnd seed. Back it up offline; it is the only way to recover channel funds. If the lnd volume is lost, the script restores the wallet from this file. | 600 |
| Docker volumes `bitcoin_data`, `lnd_data`, `electrs_db`, `postgres_data`, `edgecoder_data` | chain, channels, index, database, coordinator state | uid 1000 |

Two values cannot be generated: `PORTAL_SERVICE_TOKEN` (the portal operator issues it for your
coordinator) and `COORDINATOR_REGISTRATION_TOKEN` (lets the coordinator join the mesh).
The coordinator refuses to start in production without the portal token.

### After the first run

1. Open the firewall: inbound TCP `BITCOIN_P2P_PORT` (8333 mainnet, 18333 testnet, 38333 signet),
   9735 (lnd) and 4301 (coordinator). Put TLS in front of 4301 (Caddy, nginx, Cloudflare) and set
   `COORDINATOR_PUBLIC_URL` to that `https://` address.
2. Fund lnd and open at least one channel to a well-connected peer, so the coordinator can pay
   agents and receive payments:
   ```bash
   cd deploy/infra
   docker compose exec lnd lncli --lnddir=/data/lnd --network=mainnet newaddress p2tr
   docker compose exec lnd lncli --lnddir=/data/lnd --network=mainnet openchannel \
     --node_key <peer pubkey> --connect <peer host>:9735 --local_amt 1000000
   ```
   (`--network=signet` on signet; the script prints the exact commands for your chain.)
3. Set `INFRA_HOST_ACCOUNT_ID` and `INFRA_HOST_LIGHTNING_ADDRESS`, switch
   `ECONOMY_PAYMENTS_ENABLED=true`, re-run `scripts/infra-bootstrap.sh`.

## How you are paid

Every accrual on the network moves `NETWORK_FEE_BPS` (default 5%) into the network fee pool.
Each distribution window the pool is split across the infrastructure hosts that heartbeated
during it, in proportion to a weight (`hostWeight` in `src/economy/payouts.ts`):

| Declared service | Weight |
| --- | --- |
| `coordinator` (base; every bundle has one) | 1.0 |
| `bitcoind` | + 1.0 |
| `lightning` | + 1.0 |
| `electrs` | + 0.5 |

The sum is scaled by uptime, the fraction of expected heartbeats the coordinator sent in the
window. Under 50% uptime the host earns nothing for that window. So a full bundle at 100% uptime
weighs 3.0 (3.5 with `electrs`), a bare coordinator at 80% weighs 0.8, and a full bundle that was
down more than half the window weighs 0. Your share is your weight divided by the sum of every
host's weight; amounts are floored to whole msat and the remainder stays in the pool.

The coordinator records its own heartbeat every `HOST_HEARTBEAT_MS`: `hostId` (its peer id),
`accountId = INFRA_HOST_ACCOUNT_ID`, `services = INFRA_HOST_SERVICES`,
`coordinatorUrl = COORDINATOR_PUBLIC_URL` and `lightningAddress = INFRA_HOST_LIGHTNING_ADDRESS`.
The bootstrap derives `INFRA_HOST_SERVICES` from what is actually running
(`coordinator,bitcoind,lightning`, plus `electrs` with the `indexer` profile). Declared services
are checked before they count (`src/economy/host-attestation.ts`); a service that does not pass
earns nothing until it does, and `GET /economy/hosts` shows `services` (counted) next to
`declaredServices`:

- On its own pool the coordinator checks the backends it uses: `lightning` if its Lightning node
  answers a balance query, `bitcoind` if `BITCOIN_ANCHOR_PROVIDER=bitcoind` answers
  `getblockchaininfo`, `electrs` if `INFRA_HOST_ELECTRS_ENDPOINT` (default `electrs:50001`)
  answers Electrum `server.version`.
- To be paid from another coordinator's pool, list it in `INFRA_HOST_REPORT_URLS`. The heartbeat
  is then signed with this coordinator's key (`COORDINATOR_PRIVATE_KEY_PEM`), and the receiver
  accepts it only from the key its mesh admitted for that peer id (you must be in its
  `MESH_PEER_ALLOWLIST`), once per signature, and counts at most one per heartbeat interval.
  It then probes the host of the URL it knows for you: `/identity` must answer with your key,
  bitcoind must answer a Bitcoin P2P `version` on `BITCOIN_P2P_PORT`, lnd must complete the
  BOLT 8 handshake on 9735 for the node id in `INFRA_HOST_LIGHTNING_NODE_ID`
  (`lncli getinfo` → `identity_pubkey`), and electrs is counted only if published on 50001.
  Passing probes are cached for 6 h; a failed one is retried after 15 min.

Payouts go to the Lightning address, which can be one your own lnd serves.

## Security

- Nothing but the P2P ports and the coordinator is published. bitcoind RPC (8332) and ZMQ, lnd
  gRPC/REST, Postgres and the coordinator's inference (4302) and control plane (4303) ports are
  reachable only on the compose network `172.30.0.0/24` (`rpcallowip` in `bitcoin.conf` names
  it) or on `127.0.0.1`. `LND_REST_BIND` and `ELECTRS_BIND` are loopback by default; publish
  electrs on `0.0.0.0:50001` only if you mean to serve wallets on the internet.
- bitcoind uses an `rpcauth` line (salted HMAC); the password itself is only in `.env`, the
  generated `lnd.conf` and the coordinator's environment.
- Every container runs as uid 1000. lnd's volume is mounted read-only into the coordinator, whose
  entrypoint (`deploy/infra/edgecoder-entrypoint.sh`) hex-encodes `admin.macaroon` into
  `LND_MACAROON_HEX` at start and trusts lnd's self-signed certificate through
  `NODE_EXTRA_CA_CERTS`. The macaroon never touches `.env` or the host filesystem outside the
  volume. The coordinator can pay from lnd; treat the host like the wallet it is.
- The lnd wallet password and seed live in `deploy/infra/secrets/` (mode 600, git-ignored),
  as does `.env`. Back the seed up offline and keep the directory out of backups that leave the
  host unencrypted.
- Keep the host patched, use key-only SSH, and let `restart: unless-stopped` plus the healthchecks
  handle crashes. Uptime is what you are paid for.

## Operate

```bash
cd deploy/infra
docker compose ps                                   # health of every service
docker compose logs -f edgecoder lnd bitcoind       # follow logs
docker compose exec bitcoind bitcoin-cli -conf=/etc/bitcoin/bitcoin.conf -datadir=/data getblockchaininfo
docker compose exec lnd lncli --lnddir=/data/lnd --network=mainnet getinfo
docker compose exec lnd lncli --lnddir=/data/lnd --network=mainnet listchannels
curl -s http://127.0.0.1:4301/health/runtime        # coordinator health (no auth)
docker compose pull && docker compose up -d --build # update images and the coordinator
docker compose down                                 # stop (volumes are kept; -v deletes them)
```

To change the chain, `docker compose down -v` (this deletes the chain, the database and the lnd
wallet; close channels and sweep funds first), then run the bootstrap with the new flag.
