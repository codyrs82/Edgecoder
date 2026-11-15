# Going to mainnet

Checklist for switching a coordinator from testnet/signet to real sats (`BITCOIN_NETWORK=bitcoin`).
Work through it per seed; both seeds share one database, so the shared items (pause flag,
caps, fee-pool lock) only need checking once. Mechanics are in
[economy-math.md](economy-math.md) section 5 ("Hot-wallet safeguards").

## Switching the database to mainnet

The ledger records the Bitcoin network it belongs to (table `ledger_network`, written by the first
coordinator start). A coordinator whose `BITCOIN_NETWORK` differs refuses to start with
`ledger_network_mismatch`, naming both networks. Any change refuses, not only regtest to mainnet:
one database, one network. A database from before the network was recorded is adopted by the
first start only if nothing contradicts it: its payment intents must all be on the configured
network, and on mainnet it must hold no credit, payout or payment rows at all (their origin cannot
be proven, so a database used on regtest can never quietly become mainnet).

To move a database to a new network, wipe its ledger explicitly:

1. Stop every coordinator on the database and take a backup.
2. Dry run: `DATABASE_URL=... npx tsx scripts/ledger-reset-network.ts --confirm-wipe-ledger regtest --to bitcoin --dry-run`
   (`--confirm-wipe-ledger` must name the recorded network, or `unrecorded`). It prints the rows
   per table it would delete.
3. Run it without `--dry-run`. In one transaction it deletes, and records `bitcoin`:
   - money: `credit_transactions` (every cSat balance, earning and spend), `payment_intents`,
     `coordinator_fee_events`, `payouts`, `usage_records`, `compute_reservations`;
   - what reconciliation checks those against: `coordinator_earnings_projection`,
     `compute_contribution_reports`;
   - work that could still accrue earnings: `queue_tasks`, `queue_results`,
     `queue_expired_holders`, `pending_verifications`;
   - the signed and anchored history of all of it: `ledger_records`, `stats_ledger_records`,
     `quorum_ledger_records`, `bitcoin_anchor_records`, `work_receipts`, `receipt_epochs`,
     `issuance_epochs`, `issuance_allocations`, `issuance_payout_events`, `ledger_verifications`.

   It keeps accounts and machines (`credit_accounts`, `account_memberships`, `agent_registry`,
   `agent_signing_keys`, `agent_ownership`), payout destinations and their LNURL pins
   (`wallet_accounts`, `payout_callback_pins`; a regtest on-chain address will not validate on
   mainnet, Lightning addresses carry over), `infrastructure_hosts`, safety state
   (`payout_controls` incl. the pause flag, `blacklist_events`, `verification_reputation`,
   `hardware_verifications`, `request_nonces`, `ble_synced_tx` so old BLE transfers cannot be
   replayed), and network-independent reference data (price/rate epochs, market history and
   orders, treasury, key custody, rollouts, node status). The lists are `WIPED_TABLES` /
   `KEPT_TABLES` in `src/db/ledger-reset.ts`; a test fails if a new table is in neither.
4. Start the coordinators with `BITCOIN_NETWORK=bitcoin`.

## Signet stage

Before mainnet, the coordinators move from the private regtest hub (`deploy/lnd-test`) to a
Lightning node on a **public** test network, so payouts and purchases route through third-party
channels: `edgecoder-lnd-signet` on Mutinynet (a public signet with 30 s blocks), set up in
[deploy/lnd-signet/README.md](../deploy/lnd-signet/README.md). Its wallet seed sits on the node's
volume (test coins only; never on mainnet).

The switch is prepared but not applied; it needs the owner's go-ahead. Steps are in that README,
section 4. In short:

1. Preconditions: the node is synced, has an inbound channel (the faucet's channel to us) and an
   outbound one, and paid and received a faucet invoice (README sections 2 and 3).
2. Stage on `edgecoder-seed` and `edgecoder-seed-eu`, as Fly secrets (they override the seeds'
   `fly.toml` `[env]`): `LIGHTNING_PROVIDER=lnd`,
   `LND_REST_URL=https://edgecoder-lnd-signet.internal:8080`, `LND_TLS_CERT_BASE64` and
   `LND_MACAROON_HEX` (the node's cert and scoped `coordinator.macaroon`) and
   `BITCOIN_NETWORK=signet`: `deploy/lnd-signet/connect-seeds.sh --i-have-the-owners-go-ahead`.
3. Stop both seeds, back up the database, then reset the ledger:
   `npx tsx scripts/ledger-reset-network.ts --confirm-wipe-ledger regtest --to signet --dry-run`,
   then without `--dry-run` (see "Switching the database to mainnet" above for what it wipes).
4. `fly secrets deploy` on both seeds; check `ledger_network_checked` in the logs, a purchase, a
   withdrawal and `GET /admin/payouts/reconciliation` (`ok`).
5. Rollback: stop the seeds, reset the ledger `signet` to `regtest` (or restore the step-3
   backup), `fly secrets unset --stage` the five names except the cert and macaroon, re-run
   `deploy/lnd-test/connect-seeds.sh`, `fly secrets deploy`.

The signet revenue withdrawal under "Withdrawing EdgeCoder revenue" can then be done on this
network. (The anchoring validation run needs a bitcoind wallet, which this node does not expose.)

## Lightning node

- [ ] `LIGHTNING_PROVIDER=lnd` (or `cln`) with `LND_REST_URL` on a private network or loopback.
- [ ] TLS pinned: `LND_TLS_CERT_BASE64` is the node's own `tls.cert` (or `NODE_EXTRA_CA_CERTS` in
      the infra bundle), so the macaroon is never sent to anything else.
- [ ] Macaroon scoped to what the coordinator needs (invoices, payments, balance and payment
      reads: `lncli bakemacaroon invoices:read invoices:write offchain:read offchain:write onchain:read info:read`),
      not `admin.macaroon`. Reconciliation needs `offchain:read` + `onchain:read`. With
      `ONCHAIN_ENABLED` add `address:write` (deposit addresses) and `onchain:write` (payout batches).
- [ ] The node is dedicated to the coordinator. Any other outgoing payment trips reconciliation
      (`unknown_payments`) and pauses payouts.
- [ ] Hot wallet holds only what a few days of payouts need; the rest sits in cold storage.
- [ ] Seed and `channel.backup` (SCB) backed up offline; restore rehearsed once on regtest
      (`deploy/lnd-test/`).
- [ ] `ECONOMY_PAYMENTS_ENABLED` is not `false`.

## Payout safeguards

- [ ] Caps reviewed. Unset on mainnet they are 100k sats per payout, 500k per account per 24 h,
      2M for the coordinator per 24 h. Set `PAYOUT_MAX_SINGLE_SATS`,
      `PAYOUT_MAX_ACCOUNT_DAILY_SATS`, `PAYOUT_MAX_GLOBAL_DAILY_SATS` explicitly; the global cap
      should not exceed what you can lose from the hot wallet in a day.
- [ ] Earnings hold reviewed. Unset on mainnet, `PAYOUT_EARNINGS_HOLD_MS` is 24 h: an earn row is
      withdrawable only once it is that old, so a bad result caught by spot checks or a
      blacklisting can be handled (pause payouts, correct the ledger) before its sats leave. The
      payout balance shows the held part as `heldMsat` and `maturesAtMs`. A shorter value
      (including `0`) is honoured but reported as `mainnet_earnings_hold_disabled` /
      `mainnet_earnings_hold_below_default` at startup. The hold should cover at least the time
      verification verdicts and blacklist reports take to arrive.
- [ ] `GET /admin/payouts/pause` shows `paused: false` and the limits you expect.
- [ ] Kill-switch drill: `POST /admin/payouts/pause {"paused": true, "reason": "drill"}`, confirm a
      withdrawal returns `503 payouts_paused` while a purchase invoice still settles, then resume
      with `{"paused": false}`. Both changes appear as security events and
      `payouts_pause_changed` ledger records.
- [ ] Know the break-glass path: `PAYOUTS_PAUSED=1` and a restart pauses an instance even if the
      admin token is compromised; it cannot be lifted over the API.
- [ ] Reconciliation runs: `GET /admin/payouts/reconciliation` shows a recent `status: "ok"` (not
      `unsupported` or `error`). `PAYOUT_RECONCILE_TOLERANCE_SATS` fits your routing-fee noise.
      The `solvency` check passes with `PAYOUT_SOLVENCY_ALLOWANCE_SATS` at 0 (a gap left by payouts
      made before withdrawals debited cSats is corrected in the data, not carried into mainnet).
- [ ] `PAYOUT_ALERT_WEBHOOK_URL` points at an alerting channel someone watches; trigger one alert
      on a staging coordinator to see it arrive.
- [ ] Runbook for a trip: payouts stay paused until an admin resumes. Read the failed checks,
      compare `GET /economy/payouts/:accountId` and the node's payments, fix the cause, then resume.

## Soft launch

Open real-Bitcoin purchases to a small group first: set `LAUNCH_MODE=invite` on the portal and on
every coordinator (`src/economy/launch-gate.ts`).

- **Sign-up by invite.** A new account (email sign-up, a first Google or Microsoft sign-in, a new
  AI-agent key) needs an invite code. System admins create codes in Settings > Admin > Early
  access: one use or several, with an optional expiry and a label. A code is shown once, with a
  sign-up link (`/portal?invite=CODE#signup`); the list shows its uses, expiry and status, and
  any code can be revoked. Accounts that already exist are not affected.
- **Low caps per account** on the coordinator, on top of the payout safeguards below:
  `LAUNCH_MAX_BUY_SATS_PER_DAY` (default 50,000 sats per rolling 24 h; open invoices count),
  `LAUNCH_MAX_BALANCE_SATS` (default 200,000 cSats after a purchase) and
  `LAUNCH_MAX_PAYOUT_SATS_PER_DAY` (default 50,000, layered under `PAYOUT_MAX_ACCOUNT_DAILY_SATS`;
  it applies to every account, the fee pool's revenue withdrawals included). `0` lifts a cap.
  Every purchase path (portal, `/v1/account/topup`, the desktop app's signed requests) ends at the
  coordinator's `/account/buy`, which enforces them. The Wallet shows them as "Early access".
  With `ONCHAIN_ENABLED`, a Bitcoin deposit counts like a purchase toward
  `LAUNCH_MAX_BUY_SATS_PER_DAY` and `LAUNCH_MAX_BALANCE_SATS`; a deposit that would break either is
  held (`onchain_deposit_held`) for an operator to credit with
  `POST /admin/onchain/deposits/:txid/:vout/credit`. On-chain payouts already sit under
  `LAUNCH_MAX_PAYOUT_SATS_PER_DAY` (it is layered into the payout caps they use).
- **Going open.** Set `LAUNCH_MODE=open` (or unset it) on the portal and the coordinators and
  restart them. The invite codes stay in the database, unused.

The desktop and iOS apps' sign-up screens do not have an invite field yet: in invite mode, new
users sign up on the web portal.

## On-chain Bitcoin (deposits and batched payouts)

`ONCHAIN_ENABLED` is off by default on every network and must stay off on mainnet until this list
is done. Design: [economy-math.md](economy-math.md) "Funding with Bitcoin on-chain" and "On-chain
payouts, batched". LND only (checked against LND 0.20.7: `NewAddress`, `GetTransactions`,
`EstimateFee` (walletrpc), `SendMany` with `sat_per_vbyte` and `label`).

- [ ] Regtest run first (`edgecoder-lnd-test`, `ONCHAIN_ENABLED=1` on coordinator and portal):
      deposit below the minimum (not credited), a normal deposit (pending with "n of N", then
      credited once), a deposit above `ONCHAIN_DEPOSIT_MAX_SATS` (held, then
      `POST /admin/onchain/deposits/:txid/:vout/credit`), an RBF-replaced unconfirmed deposit
      (dropped), and a batch to two hosts (broadcast, confirmed, fee split, unused cap returned).
- [ ] Crash drill on regtest: kill the coordinator between `send_attempted_at_ms` and the txid
      being recorded (or point `LND_REST_URL` at a black hole for one batch); after restart the
      batch must be found by its label and never sent twice.
- [ ] Macaroon has `address:write`, `onchain:read`, `onchain:write` (see Lightning node above).
- [ ] `ONCHAIN_DEPOSIT_CONFIRMATIONS` is at least 3 (the mainnet default).
- [ ] Deposit caps reviewed: `ONCHAIN_DEPOSIT_MAX_SATS` (1M default on mainnet) and
      `ONCHAIN_DEPOSIT_MAX_ACCOUNT_DAILY_SATS` (2M). Someone watches `onchain_deposit_held`.
- [ ] Payout settings reviewed: `ONCHAIN_PAYOUT_MIN_SATS`, `ONCHAIN_PAYOUT_INTERVAL_MS`,
      `ONCHAIN_PAYOUT_MAX_FEE_RATE` (30 sat/vB default on mainnet), `ONCHAIN_PAYOUT_FEE_PAYER`
      (`host` default: the fee comes out of the payout, at most rate × 165 vB, and the wallets say so).
      The payout caps (`PAYOUT_MAX_*`), earnings hold and kill switch apply to on-chain payouts too.
- [ ] The node's on-chain wallet holds enough confirmed UTXOs for a batch (`min_confs` 1, no
      unconfirmed spends) and the hot-wallet limit above still holds with on-chain funds counted.
- [ ] Reconciliation `status: "ok"` with on-chain on, through one deposit and one batch.
- [ ] Alerts route `onchain_deposit_reversed`, `onchain_batch_resurfaced` (both CRITICAL; the second
      pauses payouts) and `onchain_batch_stuck` (a batch unconfirmed for 24 h: bump it with CPFP from
      `lncli wallet bumpfee`, never by sending again).
- [ ] Runbook: `GET /admin/onchain` lists batches and held deposits; a stuck `pending` batch fails
      itself after `ONCHAIN_BROADCAST_GRACE_MS` only when LND has no transaction with its label.
- [ ] Set `ONCHAIN_ENABLED=1` on the coordinators and the portal together (the portal flag only
      lets users save a Bitcoin payout address; the coordinator's decides everything else).

## Withdrawing EdgeCoder revenue

EdgeCoder keeps `NETWORK_FEE_BPS` (5 %) of every compute payment, booked as `network_fee:<task>`
earn rows on the account `network:fee_pool` (sharing it with infrastructure hosts is off unless
`FEE_POOL_HOST_DISTRIBUTION=1`). Withdrawing it is an ordinary payout from that account:

- Portal: Settings > Revenue (`/portal/settings/revenue`, system admins only) shows fee income,
  what is payable, held and already withdrawn, the last 30 days by day and past withdrawals, and
  takes a BOLT11 invoice. Confirming needs a code emailed to the admin. The portal calls the
  coordinator with `COORDINATOR_ADMIN_TOKEN` (set it to the seeds' `ADMIN_API_TOKEN`); the token
  stays on the server.
- API: `GET /admin/revenue` and `POST /admin/revenue/withdraw {"bolt11": "..."}` on a coordinator,
  with `x-admin-token`.

Both pay through `PayoutService`, so the payout caps (the per-account cap applies to the pool
account too), the pause switch, the earnings hold, reconciliation, the `payout_settled` ledger
record and the security events apply as for any withdrawal; every attempt is also logged as a
`security:revenue_withdrawal` event. Leave room for the routing fee cap in the payable balance.
The solvency check counts the pool's withdrawals like any account's, so a revenue withdrawal does
not open a solvency gap.

- [ ] A small revenue withdrawal on signet: it appears under Settings > Revenue and in
      `GET /admin/payouts/reconciliation` stays `ok`.

## Secrets and access

- [ ] `ADMIN_API_TOKEN`, `PORTAL_SERVICE_TOKEN`, `MESH_AUTH_TOKEN`, `PAYMENT_WEBHOOK_SECRET` are
      long random values, set as platform secrets, distinct per purpose, never in git. The
      portal's `COORDINATOR_ADMIN_TOKEN` (revenue page) is the seeds' `ADMIN_API_TOKEN`: set it
      only on the portal, as a secret.
- [ ] `PAYMENT_WEBHOOK_SECRET` is set (production refuses unsigned payment webhooks).
- [ ] `MESH_PEER_ALLOWLIST` lists every peer with `@url` pins; `COORDINATOR_PRIVATE_KEY_PEM` is
      stable per seed.
- [ ] Account-scoped payout routes accept only the portal service token (not the mesh token).

## Database and operations

- [ ] Postgres backups (point-in-time if possible) cover `payouts`, `credit_transactions`,
      `payment_intents` and `payout_controls`; a restore has been tested.
- [ ] Both seeds point at the same `DATABASE_URL` (the fee-pool advisory lock and the global
      payout lock only coordinate instances that share a database).
- [ ] Logs with `security:payout_*` events are retained and searchable.

## Ledger anchoring

Anchoring is off until a provider with a funded wallet is configured. With `BITCOIN_ANCHOR_PROVIDER`
unset the coordinator records no anchor rows and the status endpoints say
`anchoring.mode: "disabled"`; finality stops at `soft_finalized` (quorum commit). Mechanics are in
[economy-compute-trust-model.md](economy-compute-trust-model.md) section 5.

- [ ] `BITCOIN_ANCHOR_PROVIDER` is `anchor-proxy` (recommended) or `bitcoind`, with its credentials
      (`ANCHOR_PROXY_URL` + `ANCHOR_PROXY_TOKEN`, or `BITCOIND_RPC_URL` / `_USER` / `_PASSWORD` /
      `BITCOIND_WALLET_NAME`). `mock`, `blockstream`, a typo or missing credentials do not fall back
      to anything: the coordinator logs `bitcoin_anchoring_disabled` with the `problem` and
      anchors nothing.
- [ ] The anchor wallet is a separate hot wallet holding only what `BITCOIN_ANCHOR_DAILY_BUDGET_SATS`
      can spend in a few weeks; `BITCOIN_ANCHOR_MAX_FEE_SATS` and `BITCOIN_ANCHOR_MIN_FEE_SAT_VB`
      are reviewed against current fees.
- [ ] `BITCOIN_ANCHOR_CONFIRMATIONS` (default 6) is the depth you want before a checkpoint counts
      as hard-finalized. `STATS_ANCHOR_MIN_CONFIRMATIONS` can raise it for stats, never lower it.
- [ ] `BITCOIN_ANCHOR_MAINNET=1` is set only after the signet run below has passed.
- [ ] `GET /economy/issuance/anchors` shows `anchoring.mode: "enabled"`, and no row you rely on has
      `status: "simulated"` (rows the pre-#46 simulation wrote, kept for audit, never confirmed).

### Signet validation (run once before mainnet)

This has not been run: it needs a funded signet wallet. Do it on a staging coordinator with its own
database, not on a production seed.

1. Fund a signet wallet (a signet faucet; 100k sats is plenty) on a bitcoind with the wallet loaded,
   and wait for the funding tx to confirm (`getwalletinfo` shows a non-zero `balance`).
2. Start the coordinator with:

   ```bash
   BITCOIN_NETWORK=signet
   BITCOIN_ANCHOR_PROVIDER=bitcoind          # or anchor-proxy + ANCHOR_PROXY_URL / ANCHOR_PROXY_TOKEN
   BITCOIND_RPC_URL=http://127.0.0.1:38332
   BITCOIND_RPC_USER=...  BITCOIND_RPC_PASSWORD=...  BITCOIND_WALLET_NAME=anchor
   BITCOIN_ANCHOR_CONFIRMATIONS=6
   ANCHOR_CONFIRM_POLL_MS=60000              # default is 10 min; faster makes the run shorter
   ```

   The log must not contain `bitcoin_anchoring_disabled`, and `GET $COORD/economy/issuance/anchors`
   (mesh token) must show `anchoring.mode: "enabled"`, `anchoring.network: "signet"`.
3. Trigger one anchor: `curl -X POST -H "x-admin-token: $ADMIN_API_TOKEN" $COORD/stats/anchors/anchor-latest`.
   Expect `anchor.status: "pending"`, `anchor.confirmations: 0` and `anchor.txRef` a 64-hex txid.
4. Explorer check: open `https://mempool.space/signet/tx/<txRef>`. The tx must have one `OP_RETURN`
   output whose data is 35 bytes: `4543` (`EC`), `01`, then the checkpoint hash
   (`anchor.checkpointHash` from step 3), plus a change output back to the wallet. The fee must be
   at or above `BITCOIN_ANCHOR_MIN_FEE_SAT_VB` and below `BITCOIN_ANCHOR_MAX_FEE_SATS`.
5. Watch `GET $COORD/stats/anchors/verify?checkpointHash=<hash>` (mesh token). `anchor.confirmations`
   must follow the explorer's count, `anchor.blockHash` must match the explorer's block, and
   `anchor.status` must stay `pending` (with `verified: false`) until 6 confirmations, then become
   `anchored` with `verified: true`. On signet that is about an hour.
6. Restart the coordinator while the anchor is still pending. After restart the row must keep the
   same `anchorId` and `txRef`, the wallet must still show a single anchor tx for that checkpoint
   (`listtransactions`), and the row must still reach `anchored`.
7. Outage: stop bitcoind for a few polls. `anchoring.tracker.consecutiveFailures` climbs,
   `nextPollDelayMs` doubles from `ANCHOR_POLL_RETRY_BASE_MS`, the row keeps its status, and
   polling recovers by itself when the node is back.
8. Optional, needs two wallets or regtest: evict the tx (`abandontransaction` after restarting the
   node with an empty mempool) and check for `bitcoin_anchor_rebroadcast` with a new txid for the
   same checkpoint. A reorg cannot be forced on public signet; that path is covered by
   `tests/economy/anchor-tracker.test.ts` only.

Record the txid and the explorer link in the release notes.

## Request signing and trust

- [ ] `DATABASE_URL` is set on every seed: signed-request nonces then live in `request_nonces`,
      survive restarts and are shared, so a request replayed to the other seed is refused. Watch
      for `nonce_store_degraded_to_memory` in the logs (database unreachable; replays are then
      only caught per instance until it recovers).
- [ ] `NODE_ENV=production` (forces `REQUIRE_SIGNED_AGENT_REQUESTS`). Signed requests are bound
      to the exact body bytes (`x-body-sha256` must hash the raw body), so a captured signature
      cannot carry a different body; `security:replay_attempt` with `body_hash_mismatch` means
      someone tried.
- [ ] Infrastructure hosts paid from this pool heartbeat with a signature from their mesh key
      (`INFRA_HOST_REPORT_URLS` on the host) and are allowlisted in `MESH_PEER_ALLOWLIST` with an
      `@url` pin; `GET /economy/hosts` shows `services` (attested) next to `declaredServices`.
      A declared service that is missing from `services` earns nothing until it answers the probe.
- [ ] `MESH_WS_REQUIRE_SIGNED=true` once every agent build signs its `/mesh/ws` bind (agents built
      after the body-binding change do). Until then unsigned binds still work but can never take
      over an authenticated connection.

### Switching agents to `EDGECODER_TRUST_MODE=strict`

`tofu` stays the default so new agents can onboard. Flip production agents to `strict` once the
coordinator keys are distributed:

1. Collect each seed's trust entry: `curl -s https://<seed>/identity | jq -r .trustEntry`
   (`peerId:fingerprint`, the sha256 of the key's SPKI DER). Check it out of band (the deploy
   pipeline's key, not just the live answer).
2. Publish the list (release notes, installer config) as
   `TRUSTED_COORDINATOR_KEYS=coord-a:<fp>,coord-b:<fp>`. Agent builds from before the fingerprint
   unification compare a PEM-text hash instead: for them use `legacyFingerprints[1]` from
   `/identity` (sha256 of the trimmed PEM plus a newline, what their trust files hold). New
   builds accept either form.
3. Roll `TRUSTED_COORDINATOR_KEYS` out with `EDGECODER_TRUST_MODE` still `tofu`, and confirm agents
   log no `pinned_mismatch` (a mismatch already refuses that coordinator in `tofu`).
4. Set `EDGECODER_TRUST_MODE=strict`. A strict agent with nothing listed refuses to start (it says
   so); one pointed at an unlisted coordinator backs off and fails over instead of exiting, and
   discovery skips announced coordinators whose key is not listed. A key mismatch for a listed
   id still stops the agent.
5. Key rotation from then on: add the new entry next to the old one, roll it out, rotate the
   coordinator, then remove the old entry.
6. Consider withholding the registration token from agents until their trust list is in place.
