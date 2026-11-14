# Mainnet Lightning node (`edgecoder-lnd`)

The coordinators' own Lightning node on Fly: pruned Bitcoin Core plus LND, in the `edgecoder`
org, next to `edgecoder-seed` in Chicago (`ord`). It holds **real funds**. The keys stay with us:
the wallet seed exists only on paper, and the node runs on machines we control.

This sets up and funds the node only. The coordinators keep using the regtest node
(`deploy/lnd-test`) until the mainnet switch in [docs/going-to-mainnet.md](../../docs/going-to-mainnet.md),
which is where they are pointed at this one (step 8).

| Machine | Size | Volume | Reachable on |
| --- | --- | --- | --- |
| `bitcoind` | shared-cpu-4x, 4 GB (performance-4x, 8 GB while syncing) | `btcdata`, 80 GB | private network only |
| `lnd` | shared-cpu-2x, 2 GB | `lnddata`, 10 GB, 30-day snapshots | REST/gRPC: private network only. P2P 9735: public |

Cost at Fly's list prices (Chicago is 1.25× Ashburn): about $85/month steady, about $250/month
for the few days of initial sync on the larger VM, plus $2/month for the dedicated IPv4 and
about $14/month for volumes.

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

## 3. Deploy and sync the chain

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
lnc getinfo        # synced_to_chain: true once bitcoind has caught up
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

- Bitcoin Core 32.1 (official release, SHA-256 checked in the Dockerfile).
- LND v0.21.8-beta (official image, pinned by digest). The coordinator's LND client uses
  `/v2/router/send` and the `/v1` invoice, payment and balance routes, all still present in 0.21.
