# Mainnet Lightning node (`edgecoder-lnd`)

The coordinators' own Lightning node on Fly: LND in the `edgecoder` org, next to `edgecoder-seed`
in Chicago (`ord`). It holds **real funds**. The keys stay with us: the wallet seed exists only on
paper, and the node runs on machines we control.

Its chain backend is chosen by `BITCOIND_MODE`:

- **external** (the default): the owner's existing, fully synced Bitcoin Knots node `ocean-node`
  in Azure, reached over the org's private network as a WireGuard peer. The app's `bitcoind`
  machine is **stopped, not destroyed**, and kept with its `btcdata` volume for 30 days as the
  rollback. See [External Bitcoin node](#external-bitcoin-node-ocean-node-over-wireguard).
- **bundled** (the rollback): this app's own pruned Bitcoin Core in the `bitcoind` machine, the
  original layout (steps 3 and [Rollback](#rollback-to-bundled-mode)).

`fly.toml` keeps the `bitcoind` process group, its volume and its VM size in both modes. If the
group were removed, `fly deploy` would destroy that machine. External-mode deploys therefore run
`fly deploy --process-groups lnd`, which leaves the stopped bitcoind machine alone.

This sets up and funds the node only. The coordinators keep using the regtest node
(`deploy/lnd-test`) until the mainnet switch in [docs/going-to-mainnet.md](../../docs/going-to-mainnet.md),
which is where they are pointed at this one (step 8).

| Machine | Mode | Size | Volume | Reachable on |
| --- | --- | --- | --- | --- |
| `lnd` | both | shared-cpu-2x, 2 GB (shared-cpu-1x, 1 GB proposed for external mode) | `lnddata`, 10 GB, 30-day snapshots | REST/gRPC: private network only. P2P 9735: public |
| `bitcoind` | bundled (stopped, kept, in external) | shared-cpu-4x, 4 GB (performance-4x, 8 GB while syncing) | `btcdata`, 80 GB | private network only |

Cost at Fly's list prices (Chicago is 1.25× Ashburn), external mode: about $14/month for the lnd
machine (about $7 at the proposed smaller size), $2/month for the dedicated IPv4 and $1.50/month
for `lnddata`, plus about $12/month while the stopped machine's `btcdata` volume is kept (a stopped
machine's CPU and memory are not billed). Bundled mode adds
the bitcoind machine: about $28/month at shared-cpu-4x, about $155/month at performance-4x.

All commands run from the repo root with `flyctl` signed in to the `edgecoder` org.

## 1. Create the app and its addresses

```bash
fly apps create edgecoder-lnd --org edgecoder
fly ips allocate-v4 -a edgecoder-lnd     # dedicated IPv4, $2/month: lets peers open channels to us
fly ips allocate-v6 -a edgecoder-lnd
fly ips list -a edgecoder-lnd            # put the v4 address in fly.toml as LND_EXTERNAL_IP
```

## 2. Secrets

Two random values. The wallet password is also written to `~/.config/edgecoder/lnd-wallet-pass`
(mode 600): it is needed in step 4 and for any restore, and Fly will not show it again. Move it
into the password manager, then delete the file.

```bash
umask 077; mkdir -p ~/.config/edgecoder
openssl rand -base64 32 | tr -d '\n' > ~/.config/edgecoder/lnd-wallet-pass   # move into the password manager, then delete
fly secrets set -a edgecoder-lnd --stage BTC_RPC_PASS="$(openssl rand -hex 32)" \
  LND_WALLET_PASS="$(cat ~/.config/edgecoder/lnd-wallet-pass)"
```

## 3. Deploy and sync the chain (bundled mode only)

External mode skips this step: follow [External Bitcoin node](#external-bitcoin-node-ocean-node-over-wireguard)
instead. In bundled mode, set `BITCOIND_MODE = "bundled"` in `fly.toml`, then:

```bash
cd deploy/lnd-mainnet && fly deploy && cd -
# Initial sync on a bigger VM with a bigger cache (hours to a day or two). This changes the
# running machine only; the next deploy puts fly.toml's size and cache back.
B=$(fly machines list -a edgecoder-lnd --json | jq -r '.[] | select(.config.metadata.fly_process_group=="bitcoind") | .id')
fly machine update "$B" -a edgecoder-lnd --vm-size performance-4x --vm-memory 8192 --env BITCOIN_DBCACHE_MB=6000 --yes
fly ssh console -a edgecoder-lnd --machine "$B" -C "bitcoin-cli -conf=/tmp/bitcoin.conf -datadir=/data getblockchaininfo"
#   wait for "initialblockdownload": false, then back to the steady size:
fly machine update "$B" -a edgecoder-lnd --vm-size shared-cpu-4x --vm-memory 4096 --env BITCOIN_DBCACHE_MB=2000 --yes
```

## External Bitcoin node (ocean-node over WireGuard)

LND uses `ocean-node` (Bitcoin Core in Azure, fully synced, unpruned) as its backend. `ocean-node`
is a WireGuard peer of the `edgecoder` org (peer `ocean-node-lnd`), so it has an `fdaa:` address on
Fly's private network (6PN) that the lnd machine can reach; nothing about it is public:

| | |
| --- | --- |
| RPC | `[fdaa:ec:ae3e:a7b:9016:7eba:d6ac:1b02]:8332` |
| ZMQ rawblock | `tcp://[fdaa:ec:ae3e:a7b:9016:7eba:d6ac:1b02]:28332` |
| ZMQ rawtx | `tcp://[fdaa:ec:ae3e:a7b:9016:7eba:d6ac:1b02]:28333` |

If it is unpruned, LND needs none of the pruned-node settings (`routing.assumechanvalid` and the
like) and does not fetch old blocks from peers; the entrypoint warns if it is pruned.

What the entrypoint does in external mode (`entrypoint.sh lnd`): it starts no bitcoind; it waits
until `ocean-node` answers `getblockchaininfo` with the RPC user **and** the user's whitelist
allows every method LND calls (logging `waiting for ocean-node RPC at [fdaa:...]:8332 (...)` and
why: unreachable, 401, 403, or the list of blocked methods), refuses
to start if the node is not on mainnet, warns if ZMQ is unreachable or the node is pruned; then
it writes all `bitcoind.*` settings (rpchost, rpcuser, rpcpass, zmqpubrawblock, zmqpubrawtx,
estimatemode) to `/tmp/lnd.conf` (rootfs, not the volume; the credentials never go on a command
line or into the logs) and starts LND. The wallet unlocks from `LND_WALLET_PASS` as before.

### Prerequisites

- The WireGuard peer for `ocean-node` is up in the `edgecoder` org, and you have its 6PN
  address (`fdaa:...`) or name (`<peer name>._peer.internal`).
- On `ocean-node`, Bitcoin Core binds RPC `8332` and ZMQ `28332` (rawblock) and `28333` (rawtx)
  on that address, with `rpcallowip` covering the lnd machine's 6PN address (`fdaa::/16` or
  narrower), and `zmqpubrawblock=tcp://[fdaa:...]:28332`, `zmqpubrawtx=tcp://[fdaa:...]:28333`.
- The limited RPC user `lnd-edgecoder` exists (`rpcauth`) with an `rpcwhitelist` that covers what
  LND v0.21.8 calls (read from its source and its btcwallet/btcd dependencies):
  `getblockchaininfo,getbestblockhash,getblockcount,getblockhash,getblockheader,getblock,getnetworkinfo,estimatesmartfee,getrawtransaction,gettxout,getmempoolentry,getrawmempool,sendrawtransaction,testmempoolaccept,getzmqnotifications`
  **plus** `getinfo,getdeploymentinfo,getmempoolinfo,uptime,getpeerinfo,gettxspendingprevout`:

  | Method | Why LND needs it | If blocked |
  | --- | --- | --- |
  | `getinfo` | rpcclient detects the backend version by asking `getinfo` first; Core removed it in 0.16, so an allowed `getinfo` answers "method not found" and the client falls back to `getnetworkinfo` | a 403 is not "method not found": `getblockchaininfo`, `sendrawtransaction`, `testmempoolaccept` and `gettxspendingprevout` all fail inside LND |
  | `getdeploymentinfo` | startup taproot check (Core 23+ dropped `softforks` from `getblockchaininfo`) | LND exits: "node backend does not support taproot" |
  | `getmempoolinfo` | fee estimator's minimum mempool fee, at startup and then periodically | LND exits at startup |
  | `uptime`, `getpeerinfo` | chain-backend health check, every minute (and the fee filter) | LND shuts itself down after 3 failed checks |
  | `gettxspendingprevout` | mempool spend lookups (sweeper, contract resolution) on Core 24+ | silently "not found"; no local fallback |

  `getinfo` and `uptime` reveal nothing; `getpeerinfo` shows the node's peer addresses to this
  user. `submitpackage` is only needed for the optional `lncli wallet` package-submit command.
  Changing the whitelist needs a bitcoind restart on `ocean-node`. Until it allows all of these,
  the entrypoint waits (it does not start LND) and logs the blocked methods; `check-backend.sh`
  probes each one (harmlessly) too.
- Its credentials are staged on this app (names only shown by `fly secrets list`):
  `fly secrets set -a edgecoder-lnd --stage BITCOIND_RPC_USER=lnd-edgecoder BITCOIND_RPC_PASS=...`
  (typed by whoever holds the password, not pasted into a chat). `LND_WALLET_PASS` stays as is;
  keep `BTC_RPC_PASS` too while the bundled fallback is wanted.
- `BITCOIND_HOST` in `fly.toml` is ocean-node's 6PN address (the entrypoint refuses a
  `REPLACE...` placeholder and adds the IPv6 brackets). `BITCOIND_RPC_PORT` is `8332`;
  `BITCOIND_ZMQ_BLOCK` / `BITCOIND_ZMQ_TX` are set to the `28332` / `28333` URLs (without them they
  default to `tcp://[BITCOIND_HOST]:28332` and `:28333`).

### Pre-flight

`check-backend.sh` runs itself inside the lnd machine over `fly ssh console` and checks DNS, the
RPC port, both ZMQ ports, and (once the secrets are deployed) `getblockchaininfo` and the
whitelist with the limited user. It never prints the credentials.

```bash
fly secrets list -a edgecoder-lnd                             # BITCOIND_RPC_USER, BITCOIND_RPC_PASS: Staged
deploy/lnd-mainnet/check-backend.sh --host fdaa:...           # before the deploy: ports only
```

### Deploy (the lnd machine only)

```bash
cd deploy/lnd-mainnet && fly deploy --process-groups lnd && cd -
```

Only the lnd machine gets the new image, the new env and the staged secrets. The `bitcoind`
machine is not updated. Once LND is verified on `ocean-node` (below), stop it, and do not destroy
it or its volume:

```bash
fly machine stop <bitcoind machine id> -a edgecoder-lnd
```

### Verify

```bash
fly logs -a edgecoder-lnd --no-tail | grep entrypoint
#   entrypoint: ocean-node RPC at [fdaa:...]:8332 is up: chain=main blocks=... initialblockdownload=false pruned=false
#   entrypoint: starting lnd with the external backend at [fdaa:...]:8332
deploy/lnd-mainnet/check-backend.sh                           # now also checks the RPC user: PASS
fly ssh console -a edgecoder-lnd --select                     # the lnd machine
lnc state          # NON_EXISTING until the wallet is created (step 4), then RPC_ACTIVE/SERVER_ACTIVE
lnc getinfo        # once the wallet exists: synced_to_chain: true, block_height = ocean-node's
```

Compare `block_height` with `bitcoin-cli getblockcount` on `ocean-node` (equal, or one behind
for a few seconds after a new block). `lnc getinfo` needs the wallet, so on a fresh node this
check comes right after step 4; before that, the entrypoint log and `check-backend.sh` show the
backend's height.

Then create the wallet (step 4) as before, by the owner, by hand.

### Rollback to bundled mode

```bash
fly machine start <bitcoind machine id> -a edgecoder-lnd        # its sync resumes where it stopped
fly machine update <lnd machine id> -a edgecoder-lnd --env BITCOIND_MODE=bundled --yes
```

LND then uses the app's own pruned node and waits for it to catch up. It needs `BTC_RPC_PASS` to
still be set. Revert this PR (or set `BITCOIND_MODE = "bundled"` in `fly.toml`) so the next
deploy does not switch back.

### The old `btcdata` volume

The stopped bitcoind machine keeps it attached; it costs about $12/month (80 GB at $0.15/GB, plus its
snapshots). Keeping it makes the rollback quick; deleting it is the owner's call and cannot be
undone (a later rollback would then sync the chain from scratch on a new volume: days, and the
performance-4x VM while it runs):

Keep both for at least 30 days after the switch. Removing them later needs the owner's yes.

## 4. Create the wallet (the operator, by hand)

Do this yourself in a terminal; do not paste any of it into a chat, a ticket or a file.

```bash
fly ssh console -a edgecoder-lnd --select     # pick the lnd machine
lnc create
#   password: the wallet password from step 2 (must match LND_WALLET_PASS exactly)
#   "Do you have an existing cipher seed?" n
#   passphrase: optional; if you set one, it is needed for every restore, store it apart from the seed
```

Write the 24 words on paper, twice, and keep the copies in two different places. Never photograph
them or type them into a computer. Anyone with the words (and passphrase) has the funds.

From then on the node unlocks itself on every restart from `LND_WALLET_PASS`. Check:

```bash
lnc getinfo        # synced_to_chain: true once the backend (ocean-node, or the bundled bitcoind) is caught up
lnc walletbalance
```

## 5. Fund it

Keep only what a few days of payouts need here (going-to-mainnet: "Hot wallet holds only what a
few days of payouts need"). Start small and grow it.

```bash
lnc newaddress p2tr        # send on-chain BTC here; wait for confirmations (lnc walletbalance)
```

## 6. Channels and liquidity

The coordinator needs both directions:

- **Outbound** (to pay agents): open channels from this node to two or three large, reliable
  nodes. `lnc openchannel --node_key <pubkey> --connect <host:9735> --local_amt <sats>`.
- **Inbound** (to receive buyers' payments): other nodes must open channels to us, or we buy
  inbound from a liquidity service (an LSP or a liquidity marketplace). The dedicated IPv4 and
  `LND_EXTERNAL_IP` let them connect.

Do this before step 8 if possible. Once the coordinators use this node, any payment it makes that
is not a coordinator payout (a loop-out, a liquidity purchase paid over Lightning) shows up in
reconciliation as `unknown_payments` and pauses payouts. If it has to happen later, pause payouts
first (`POST /admin/payouts/pause`), then resume after reviewing the reconciliation.

## 7. Back up channel state

After every channel open or close, and on a schedule:

```bash
deploy/lnd-mainnet/backup-scb.sh     # saves ~/.config/edgecoder/lnd-backups/channel-<time>.backup
```

The seed recovers on-chain funds. The channel backup (encrypted with the seed) lets a restored
node ask its peers to close channels and return our balance. Keep the latest copy somewhere other
than this laptop too. Rehearse a restore once on regtest (`deploy/lnd-test`), as the mainnet
checklist asks.

## 8. Point the coordinators at it (the mainnet switch)

Only as part of [docs/going-to-mainnet.md](../../docs/going-to-mainnet.md), together with
`BITCOIN_NETWORK=bitcoin` on both seeds. Not before: the seeds would otherwise talk to a mainnet
node while running on regtest.

1. Bake a scoped macaroon (not `admin.macaroon`) on the lnd machine:
   `lnc bakemacaroon --save_to /data/payout.macaroon info:read invoices:read invoices:write offchain:read offchain:write onchain:read`
2. Stage it and the node's TLS cert on both seeds as `LND_MACAROON_HEX` and `LND_TLS_CERT_BASE64`
   (the same method as `deploy/lnd-test/connect-seeds.sh`, with `--network=mainnet` and app
   `edgecoder-lnd`), and set `LND_REST_URL = "https://lnd.process.edgecoder-lnd.internal:8080"`
   in both seed configs.
3. The TLS cert LND generates is valid for 14 months, and the coordinators pin it. Before it
   expires, renew it (delete `tls.cert`/`tls.key` and restart lnd) and re-stage it on the seeds.

## Versions

- Bitcoin Core 32.1 for bundled mode (official release, SHA-256 checked in the Dockerfile).
  External mode uses whatever Bitcoin Core `ocean-node` runs.
- LND v0.21.8-beta (official image, pinned by digest). The coordinator's LND client uses
  `/v2/router/send` and the `/v1` invoice, payment and balance routes, all still present in 0.21.
