# Signet Lightning node (`edgecoder-lnd-signet`, Mutinynet)

A Lightning node on a **public test network** for the coordinators, between the private regtest
hub (`deploy/lnd-test`) and mainnet (`deploy/lnd-mainnet`). It runs on
[Mutinynet](https://mutinynet.com), a public signet with 30-second blocks, a few hundred
Lightning nodes and a faucet, so payouts and purchases route over real, third-party channels
without real money.

**Test coins only.** To keep it hands-off, the node creates its own wallet on first boot, and the
wallet password and 24-word seed are stored **on the node's volume** (`/data/secrets/`, mode
600, owned by the `lightning` user). Anyone with `fly ssh console` access to this app can read
them. That is acceptable for worthless signet coins and is never done on mainnet, where the seed
exists only on paper (`deploy/lnd-mainnet`). Nothing in this setup prints the password, the seed
or a macaroon.

| | |
| --- | --- |
| App | `edgecoder-lnd-signet`, org `edgecoder`, `ord` |
| Machine | one `shared-cpu-2x`, 2 GB, running bitcoind and lnd (`entrypoint.sh`) |
| Volume | `lnsignet`, 10 GB, 7-day snapshots |
| Addresses | dedicated IPv4 `137.66.52.175`, IPv6 `2a09:8280:1::208:f20:0` |
| Node | `02e8922fa5b8252f70e983fba2aa34a20347fd9fc9fc151203267478189d2863ce@137.66.52.175:9735` |
| REST for coordinators | `https://edgecoder-lnd-signet.internal:8080`, Fly private network (6PN) only |
| Cost | about $14/month (VM) + $2 (IPv4) + $1.50 (volume), at Fly's Chicago prices |

## What runs

- **bitcoind**: Mutinynet's patched Bitcoin Core (stock Core rejects its 30 s blocks). It is the
  binary the Mutinynet operators run (`MutinyWallet/mutiny-net`'s Dockerfile:
  `benthecarman/bitcoin` release `mutinynet-inq-template-hash`, build `2fda7bfc027e`), with its
  SHA-256 checked against that release's `SHA256SUMS`. Network parameters are in
  `bitcoin.conf`: the signet challenge `512102f756…28ad8f51ae`, `signetblocktime=30` and the
  Mutinynet seed peer `45.79.52.207:38333`. Pruned to 4 GB; RPC (cookie auth, no password) and
  ZMQ on loopback only; P2P outbound only.
- **lnd** v0.21.8-beta (the same pinned image as mainnet) with `--bitcoin.signet` and the
  bitcoind backend, as Mutinynet's own faucet node runs it. REST listens on `[::]:8080`, which
  Fly exposes only on the private network because `fly.toml` defines no public service for it.
  gRPC is loopback only (`lnc`). P2P 9735 is public so peers and the faucet can open channels to
  us.
- **First boot** (`entrypoint.sh`): generates the wallet password into
  `/data/secrets/wallet.pass`, creates the wallet over loopback REST (`/v1/genseed`,
  `/v1/initwallet`) and saves the seed to `/data/secrets/seed.json`; the request bodies pass
  through mode-600 temp files, never a command line. lnd then unlocks itself from the password
  file on every restart. It also bakes `/data/coordinator.macaroon`:
  `info:read invoices:read invoices:write offchain:read offchain:write onchain:read`, which
  covers what `src/economy/lightning.ts` calls (create/look up invoices, `/v2/router/send`,
  `/v1/payments`, `/v1/balance/*`, `getinfo`), not `admin.macaroon`.
- If bitcoind or lnd exits, the machine exits non-zero and Fly restarts it.

Helpers inside the machine (`fly ssh console -a edgecoder-lnd-signet`):

```bash
lnc getinfo            # lncli --network=signet --lnddir=/data/lnd, as the lightning user
lnc walletbalance; lnc channelbalance; lnc listchannels
bcli getblockchaininfo # bitcoin-cli for the Mutinynet bitcoind
```

## 1. Create and deploy (done 2026-11-15)

```bash
fly apps create edgecoder-lnd-signet --org edgecoder
fly ips allocate-v4 -a edgecoder-lnd-signet --yes   # dedicated, $2/month; put it in fly.toml LND_EXTERNAL_IP
fly ips allocate-v6 -a edgecoder-lnd-signet
cd deploy/lnd-signet && fly deploy --remote-only --ha=false && cd -
```

No Fly secrets are needed. Sync: `bcli getblockchaininfo` until `initialblockdownload: false`,
then `lnc getinfo` shows `synced_to_chain: true`. The chain is about 3.6 million tiny blocks;
the first sync takes a few hours on this VM.

## 2. Fund it (needs the owner: GitHub sign-in on the faucet)

The faucet at <https://faucet.mutinynet.com> requires a GitHub sign-in for on-chain coins,
Lightning payouts and channel opens, and allows 1,000,000 sats per user (and per IP) per day.
On the faucet page, sign in with GitHub, then:

1. **Get coins (on-chain)**: address = the output of
   `fly ssh console -a edgecoder-lnd-signet -C "lnc newaddress p2tr"`; amount **500,000**.
2. **Lightning channel**: open a channel *from the faucet to us*:
   - node pubkey `02e8922fa5b8252f70e983fba2aa34a20347fd9fc9fc151203267478189d2863ce`
   - host `137.66.52.175:9735`
   - capacity **500,000**, push amount **100,000**

   That gives the node 400,000 sats of inbound liquidity (to receive buyers' payments) and
   100,000 outbound on the best-connected Mutinynet node.

Then, in the machine, open our own outbound channel to a second well-connected node once the
on-chain coins have one confirmation (30 s blocks):

```bash
lnc walletbalance                       # confirmed_balance > 0
# Olympus by ZEUS, the third-best-connected Mutinynet node and the best one on clearnet (the
# second, MYBONK-SIGNET-1, is Tor-only and this node has no Tor).
lnc connect 032ae843e4d7d177f151d021ac8044b0636ec72b1ce3ffcde5c04748db2517ab03@45.79.201.241:9735
lnc openchannel --node_key 032ae843e4d7d177f151d021ac8044b0636ec72b1ce3ffcde5c04748db2517ab03 --local_amt 300000
lnc pendingchannels; lnc listchannels   # active after 3 confirmations (~2 min)
```

The faucet node is `02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b@45.79.52.207:9735`.

## 3. Prove routing

Both directions, without a GitHub sign-in (the faucet's unauthenticated endpoints, rate-limited
per IP; run them from the machine so the owner's IP keeps its own quota):

```bash
# Pay: the faucet makes an invoice, we pay it over Lightning.
inv=$(curl -sf -X POST https://faucet.mutinynet.com/api/bolt11 -H 'content-type: application/json' -d '{"amount_sats":1000}' | jq -r .bolt11)
lnc payinvoice --force --pay_req "$inv"
# Receive: the faucet's LNURL-withdraw pays an invoice of ours.
k1=$(curl -sf https://faucet.mutinynet.com/api/lnurlw | jq -r .k1)
pr=$(lnc addinvoice --amt 2000 --memo "faucet lnurlw" | jq -r .payment_request)
curl -sf "https://faucet.mutinynet.com/api/lnurlw/callback?k1=$k1&pr=$pr"
lnc listinvoices --max_invoices 1 | jq '.invoices[0].state'   # SETTLED
```

## 4. Switch the coordinators to signet (NOT applied; needs the owner's go-ahead)

Switching the live network from regtest to signet moves both seeds to this node **and** resets
the shared ledger (every cSat balance, earning, purchase and payout made on regtest is wiped;
accounts, agents and keys stay). Do it in one maintenance window. Background:
[docs/going-to-mainnet.md](../../docs/going-to-mainnet.md), "Switching the database to mainnet"
and "Signet stage".

What changes on `edgecoder-seed` and `edgecoder-seed-eu`, as Fly secrets (a secret overrides the
same name in the seeds' `fly.toml` `[env]`, so the protected seed configs need no edit):

| Secret | Value |
| --- | --- |
| `LIGHTNING_PROVIDER` | `lnd` |
| `LND_REST_URL` | `https://edgecoder-lnd-signet.internal:8080` |
| `LND_TLS_CERT_BASE64` | base64 of `/data/lnd/tls.cert` on this node |
| `LND_MACAROON_HEX` | hex of `/data/coordinator.macaroon` on this node |
| `BITCOIN_NETWORK` | `signet` |

`deploy/lnd-signet/connect-seeds.sh --i-have-the-owners-go-ahead` reads the cert and macaroon
over `fly ssh` and stages all five on both seeds with `fly secrets import --stage`, printing
nothing secret. Optionally also stage `INFRA_HOST_LIGHTNING_NODE_ID=02e8922f…2863ce` (the
fee-pool payouts for the seeds' own infrastructure go to the node they pay out from).

Procedure, from the repo root with `FLY_API_TOKEN` set:

```bash
# S0. Preconditions: node synced, channels active both ways, section 3 passed.
fly ssh console -a edgecoder-lnd-signet -C "lnc getinfo" | jq '{synced_to_chain, num_active_channels}'

# S1. Stage the switch (nothing restarts yet).
deploy/lnd-signet/connect-seeds.sh --i-have-the-owners-go-ahead

# S2. Get the ledger database URL into a private file while a seed is still running, and open a
#     tunnel to edgecoder-pg (in a second terminal).
umask 077; mkdir -p ~/.config/edgecoder
fly ssh console -a edgecoder-seed -q -C 'printenv DATABASE_URL' | tr -d '\r' | grep -v '^Connecting' > ~/.config/edgecoder/seed-db-url
fly proxy 15432:5432 -a edgecoder-pg          # leave running
export DATABASE_URL=$(node -e 'const u=new URL(require("fs").readFileSync(process.env.HOME+"/.config/edgecoder/seed-db-url","utf8").trim()); u.hostname="localhost"; u.port="15432"; process.stdout.write(u.href)')

# S3. Stop both coordinators (pause payouts first if anything is in flight:
#     POST /admin/payouts/pause), back up the database, then dry-run and run the reset.
fly machine stop e8261e0b10d148 -a edgecoder-seed        # IDs: fly machines list -a <app>
fly machine stop 8d14e9ae2993d8 -a edgecoder-seed-eu
#   backup: fly ssh console -a edgecoder-pg -C "pg_dumpall ..." or a volume snapshot of edgecoder-pg
npx tsx scripts/ledger-reset-network.ts --confirm-wipe-ledger regtest --to signet --dry-run
npx tsx scripts/ledger-reset-network.ts --confirm-wipe-ledger regtest --to signet

# S4. Apply the staged secrets; this restarts the seeds on signet.
fly secrets deploy -a edgecoder-seed
fly secrets deploy -a edgecoder-seed-eu
fly logs -a edgecoder-seed --no-tail | grep -E 'ledger_network_checked|ledger_network_mismatch|lightning'

# S5. Check: a small purchase (portal top-up) settles; a small withdrawal to a Mutinynet wallet
#     pays; GET /admin/payouts/reconciliation shows status "ok".
rm ~/.config/edgecoder/seed-db-url
```

Note `auto_start_machines = true` on the seeds: a stopped seed starts again on the next
request, so run S3 quickly; a seed that starts on regtest secrets against a signet ledger
refuses to start (`ledger_network_mismatch`), which is safe.

Users' regtest on-chain payout addresses will not validate on signet (Lightning addresses carry
over); tell testers to use a Mutinynet wallet (e.g. faucet.mutinynet.com's wallets list).

### Rollback (back to regtest)

```bash
fly machine stop e8261e0b10d148 -a edgecoder-seed; fly machine stop 8d14e9ae2993d8 -a edgecoder-seed-eu
npx tsx scripts/ledger-reset-network.ts --confirm-wipe-ledger signet --to regtest   # wipes the signet ledger
fly secrets unset -a edgecoder-seed    --stage LND_REST_URL BITCOIN_NETWORK LIGHTNING_PROVIDER INFRA_HOST_LIGHTNING_NODE_ID
fly secrets unset -a edgecoder-seed-eu --stage LND_REST_URL BITCOIN_NETWORK LIGHTNING_PROVIDER INFRA_HOST_LIGHTNING_NODE_ID
deploy/lnd-test/connect-seeds.sh       # re-stages the regtest hub's macaroon and cert
fly secrets deploy -a edgecoder-seed; fly secrets deploy -a edgecoder-seed-eu
```

With those secrets unset, the seeds fall back to their `fly.toml` values (regtest hub URL,
`BITCOIN_NETWORK=regtest`). To keep the regtest ledger instead of wiping it twice, restore the
S3 backup rather than running the reset back.

## Maintenance

- TLS: lnd's `tls.cert` is valid for 14 months and the coordinators pin it. To renew, delete
  `/data/lnd/tls.cert` and `tls.key`, restart, and re-run `connect-seeds.sh`.
- Mutinynet upgrades: when `MutinyWallet/mutiny-net` moves to a new `benthecarman/bitcoin`
  release (its soft-fork set can change), bump `MUTINYNET_RELEASE`, `BITCOIN_VERSION` and
  `BITCOIN_SHA256` in the Dockerfile from that release's `SHA256SUMS`.
- Wipe and start over: `fly volumes destroy` + redeploy creates a new wallet and node key.
