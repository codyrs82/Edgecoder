# Economy and compute trust model (#56)

Status: **as built, checked against the code on 2026-11-14** at commit `c49abdf` (the head of PR #275). This file started as the design draft for #56. Each section now states the design and then a "Status as of 2026-11-14" block: what is implemented, where, and what is still open. File and line references are to that commit.

Two labels are used for where code lives:

- **on `main`**: already merged to `main` (`a699d3b`).
- **PR #275**: on the integration branch only; reaches `main` when PR #275 merges.

Decided since the draft: the custody model (#49, see §3) and paying sats out (§4). Still pending maintainer sign-off: the default daily anchor budget (§5).

## 1. Principles

1. **Credits are an off-chain ledger in Postgres.** Bitcoin is used to buy credits (Lightning), to pay earnings out (Lightning) and to anchor the ledger (OP_RETURN), not to hold per-task balances.
2. **Nothing a client says is money.** Payment status comes from the Lightning node, work from server-measured and verified results, peer identity from allowlisted keys.
3. **Fail closed in production.** Mock providers, missing allowlists, missing secrets and unverifiable signatures are refused, not ignored.
4. **Money out waits for verification.** A result that is sampled for verification is not paid until the verdict. This holds only for sampled results: verification is off by default, so today most work is paid, and can be withdrawn, unverified (§4, §6).

## 2. Ledger

| Concern | Design | Status as of 2026-11-14 |
|---|---|---|
| Balance | Account balance is the sum of `credit_transactions`; debits are atomic and never go negative. | **Done, on `main`.** `credits NUMERIC(30,6)` (`src/db/postgres.ts:191`). `debitCredits` takes a per-account `pg_advisory_xact_lock` and checks the balance in the same transaction (`postgres.ts:1296-1330`, balance query at `:753`). There is no `CHECK` constraint; the rule is enforced in the debit path only. |
| Earn formula | One function, `contributionCredits()`, for Postgres and the in-memory engine; failed results earn 0; duration is server-measured. | **Done.** `src/credits/pricing.ts:70`, used by `src/credits/store.ts:91` and `src/credits/engine.ts:49`. Duration is clamped by `creditedDurationMs` (`src/swarm/result-integrity.ts:46`, called at `src/swarm/coordinator/routes/tasks.ts:580`). The route tests for #38 are in PR #275 (`tests/swarm/task-billing-route.test.ts`). |
| Idempotency | Unique keys per source. A replay is a no-op. | **Done.** Earnings: `compute_contribution_reports.report_id` primary key (`postgres.ts:464`), written with the credit row in one transaction (`persistContributionWithCredit`, `postgres.ts:1460`). Purchases: unique `payment_hash` and one `credit_purchase:*` row per intent (`postgres.ts:629`, `:637`). BLE sync: `ble_synced_tx.tx_id` primary key (`postgres.ts:586`, `applyBleTransfer` at `:1336`). One credit per subtask across coordinators that share a database is tested in `tests/economy/subtask-credit-shared.test.ts` (#123, PR #275). |
| Durable state | Replay protection must survive a restart. | **Done in PR #275 (#55, #99).** Production refuses to start without `DATABASE_URL` (`src/common/env-guard.ts:30-45`). Request nonces are stored in Postgres (`src/swarm/coordinator/context.ts:245`); if Postgres errors, the store degrades to memory and logs `nonce_store_degraded_to_memory`. Still in memory, per process: the forwarded-result replay cache (`src/swarm/coordinator/context.ts:152`, time-bound) and the BLE id set used only without Postgres (`src/swarm/coordinator/routes/ble-sync.ts:24`). Test: `tests/swarm/durable-replay.test.ts`. |
| Verification mints | Winning replicas are paid from newly minted credits only when minting is switched on. | **Partly.** Minting is off by default (`mintReplicaRewards: false`, `src/swarm/verification.ts:149`). **Not built:** minted credits are not tagged as their own source, and `/ledger/verify` does not count them separately. |
| Reconciliation | `/ledger/verify` plus a periodic run. | **Done in PR #275 (#115).** `GET /ledger/verify` (`src/swarm/coordinator/routes/economy.ts:226`): with the mesh token it checks the ordering chain only; with `x-admin-token` it runs the full Postgres reconciliation (`src/ledger/reconcile.ts`); without Postgres it returns 503. The periodic run is every `LEDGER_VERIFY_INTERVAL_MS` (default 6 h, `src/swarm/coordinator/ledger-verify.ts:15`), once per window across coordinators sharing the database (`postgres.ts:2841`). Read-only; a mismatch logs a HIGH security event. |

### Ledger schema

`credit_transactions` has `tx_id` (PK), `account_id`, `tx_type`, `credits NUMERIC(30,6)`, `reason`, `related_task_id`, `timestamp_ms` and `msat` (`postgres.ts:186-195`, `:619`). Idempotency is carried by the separate tables and partial unique indexes listed above.

The draft's target schema is **not built**: there is no `source_type` column, no `UNIQUE (source_type, idempotency_key)`, no `ledger_record_id` link and no signed-amount convention (the sign still comes from `tx_type`). Nothing currently depends on it. It is listed under open work in §9.

Also open: `coordinator_earnings_projection.total_credits` is still `DOUBLE PRECISION` (`postgres.ts:181`, #153). `payment_intents.quoted_credits` is already `NUMERIC(30,6)` (`postgres.ts:302`).

## 3. Money in: Lightning

- Credits are issued only after the node reports the invoice settled, looked up by `payment_hash`, never by a client-supplied reference (#42, #47).
- The webhook is a hint: its HMAC-SHA256 over the raw body is checked, then the node is queried. Production refuses the webhook when `PAYMENT_WEBHOOK_SECRET` is missing.
- `mock` Lightning is refused in production (#43).

**Status as of 2026-11-14: done, on `main`** (one fix in PR #275).

- Settlement check: `LndRestProvider.checkSettlement` and `interpretLndInvoice` (`src/economy/lightning.ts:415-432`, `:458-475`) require the `SETTLED` state and a preimage that hashes to the payment hash. CLN has the same check (`lightning.ts:707`).
- Production requires `LIGHTNING_PROVIDER=lnd|cln` and refuses `mock` (`lightning.ts:780-805`).
- Crediting: `createPaymentSettler` (`src/economy/payment-settlement.ts`, wired at `src/swarm/coordinator/payments.ts:109`) and `settlePaymentIntentAtomic` (`postgres.ts:2506`). Routes: create intent `src/swarm/coordinator/routes/payments.ts:19`, confirm `:67`, webhook `:92`, reconcile `:118`.
- Tests: `tests/swarm/payment-settlement.test.ts` (no credit while unpaid; a webhook claiming `settled: true` does not credit while the node says unpaid; three concurrent settles credit once; a replay after restart credits nothing) and `tests/economy/lightning-lnd-settlement.test.ts` (#47, against a fake LND HTTP server).
- PR #275 moves LND payments to `POST /v2/router/send` (#261, `lightning.ts:269-280`), because LND v0.21 removed the old endpoint.

**Custody (#49): decided, non-custodial.** The server generates no keys or seed phrases. A user supplies a Lightning address from their own wallet (`src/economy/payout-destination.ts:8-15`); on-chain addresses are validated but refused until an on-chain payout path exists. The old server-side wallet routes are gone: `src/portal/routes/wallet.ts:9-27`, and the control plane answers `server_generated_wallets_retired` (`src/control-plane/server.ts:1106`).

Leftovers from the old wallet model, none of which generate or store keys:

- `WALLET_SECRET_PEPPER` is still an optional key in `src/portal/config.ts` and nothing reads it; the docs list it as unused.
- The legacy `seed_phrase_hash` column (`src/portal/store.ts:173`).
- Unused seed-phrase fields and views in the iOS app (`ios/EdgeCoderIOS/EdgeCoderIOS/Core/Models.swift:30`, `Auth/AuthView.swift`, `Auth/AuthViewModel.swift`).

## 4. Money out

The draft said "postponed". That is no longer true: **payouts are built and enabled by default, on `main`.**

- Policy: `payoutPolicyFromEnv` (`src/economy/payouts.ts:43`); enabled unless `PAYOUTS_ENABLED=false` (`payouts.ts:52`). The withdrawable amount is bounded by earned sats, by the credit balance (`withdrawableMsat`, `payouts.ts:84`) and by what the coordinator has actually received (`payoutCapacityMsat`, `payouts.ts:124`).
- Paths: a user withdraws to a BOLT11 invoice (`PayoutService.withdraw`, `src/economy/payout-service.ts:273`), or automatic payouts go to the saved Lightning address over LNURL-pay (`runAutoPayouts`, `payout-service.ts:352`). There is no keysend, LNURL-withdraw or on-chain path.
- Safeguards: per-payout, per-account-per-day and global-per-day limits (`src/economy/payout-safeguards.ts:30-92`), the `PAYOUTS_PAUSED` kill switch (`payout-safeguards.ts:120`), an admin pause and a reconciliation view (`src/swarm/coordinator/routes/admin.ts:159-177`). Payout routes need the portal service token (`src/swarm/coordinator/routes/economy.ts:95-146`).
- The Fly seeds run `BITCOIN_NETWORK=regtest` with limits of 100,000 / 500,000 / 2,000,000 sats (`deploy/fly/fly.seed-node.toml:21-24`). Mainnet steps: [going-to-mainnet.md](going-to-mainnet.md).

**Still open.** Principle 4 is only half met. A sampled result is held until its verdict (`src/swarm/coordinator/routes/tasks.ts:598-629`), but verification is off by default, there is no separate "pending until verified" state on earnings, and the payout code has no such gate. With the defaults, earnings can be withdrawn as soon as they are credited, within the limits above. Turn verification on (§6) and keep the limits low before any mainnet use.

## 5. Anchoring

- One anchor service with a hot wallet (bitcoind or the authenticated anchor proxy) publishes a 32-byte value via OP_RETURN (#46).
- Spend guards: a daily budget, a per-transaction fee cap, and mainnet opt-in.
- Confirmation depth and reorg tracking; an RPC error means "unknown", never "left the chain".
- Reconciliation at startup and on a timer for rows left `broadcasting` by a crash and for stuck transactions (#103).
- Manual anchor triggers need the admin token (#100).

**Status as of 2026-11-14: code done; not yet proven on a public network.**

- `src/economy/anchoring.ts`: 6 confirmations by default (`:20`), policy from env with 200,000 sats/day and a 20,000 sat fee cap (`:58-67`), mainnet only with `BITCOIN_ANCHOR_MAINNET=1` (`:182`), `anchorCheckpoint` (`:120`), one anchor per epoch (`anchorEpochOnce`, `:150`, #101), pending to anchored and reorg handling (`applyConfirmation`, `:245`; `refreshAnchor`, `:301`), reconciliation (`reconcileAnchor`, `:392`).
- The wallet funds the transaction and the fee is checked against the cap before broadcast (`src/economy/bitcoin-rpc.ts:182`, error `bitcoind_anchor_fee_too_high`).
- **No provider, no anchor (#46).** With `BITCOIN_ANCHOR_PROVIDER` unset, or set to something that cannot broadcast, anchoring is disabled in every environment: nothing is broadcast, no anchor row is written, and the status endpoints report `anchoring.mode: "disabled"` (`resolveAnchoringMode`, `src/economy/anchor-status.ts:36`; `src/swarm/coordinator/stats-ledger.ts:203-226`). The mock provider runs only when named explicitly outside production, and its rows are tagged `anchor_provider = 'mock'`.
- **Row states.** `broadcasting` (intent stored before the send) → `pending` (the provider's txid, 0 confirmations) → `anchored` at `BITCOIN_ANCHOR_CONFIRMATIONS` (default 6). `failed` and `needs_admin` are terminal for that row; a failed checkpoint is broadcast again under a new row.
- **Confirmation tracking** (`AnchorTracker`, `src/economy/anchor-tracker.ts:135`). One poll loop asks the provider for each pending row's confirmation count and block, and re-checks anchored rows until they are `ANCHOR_REORG_WATCH_CONFIRMATIONS` (default 100) deep. If the block hash changed or the transaction is no longer in a block, the row goes back to `pending`. If the transaction is also gone from the mempool it is abandoned and the checkpoint is broadcast again; receipt epochs are repointed at the new txid (`repointEpochAnchor`, `src/receipts/epochs.ts:151`). On an RPC error the row keeps its state and the loop retries with exponential backoff (`ANCHOR_POLL_RETRY_BASE_MS`, capped at `ANCHOR_POLL_MAX_BACKOFF_MS`). After a restart a pending row is polled again, not broadcast again.
- **Simulated rows.** Rows written by the old simulation (`tx_ref` like `anchor:<network>:<hash>`, status `anchored`) stay in the table untouched. Every read path shows them as `status: "simulated"` with no `txRef` and 0 confirmations, and they never count toward hard finality (`describeAnchor`, `anchor-status.ts:137`). Mock-provider rows are shown the same way.
- **Hard finality** (`anchored_confirmed`, `verified: true`) needs a real txid, status `anchored`, and at least `max(BITCOIN_ANCHOR_CONFIRMATIONS, STATS_ANCHOR_MIN_CONFIRMATIONS)` confirmations (`checkpointAnchorFinality`, `anchor-status.ts:169`).
- **Reconciliation.** Rows left `broadcasting` by a crash are looked up in the wallet; stuck transactions are abandoned (`abandontransaction`) before being marked failed; abandoned transactions are watched and marked anchored again if they confirm anyway, with their fee charged to the budget; rows that cannot be resolved go to `needs_admin` and are never broadcast again automatically.
- Manual triggers are admin-only (`src/swarm/coordinator/routes/issuance.ts:162`, `src/swarm/coordinator/routes/stats.ts:89`).
- Tests: `tests/economy/anchoring.test.ts` (reorgs), `tests/economy/anchor-tracker.test.ts`, `tests/economy/anchor-status.test.ts`.

**What is anchored.** Three values go through the same path: the issuance epoch checkpoint hash, the stats checkpoint hash, and the **merkle root of each work-receipt epoch**. Receipt epochs close hourly by default (`RECEIPT_EPOCH_MS`, `src/swarm/coordinator-config.ts:71`; `closeEpoch` and `anchorEpoch` in `src/receipts/epochs.ts:69`, `:122`; wiring at `coordinator.ts:116-121`). `GET /receipts/:receiptId` returns the receipt with its inclusion proof (`src/receipts/replication.ts:154-160`). See [receipts-and-trust.md](receipts-and-trust.md).

This replaces the draft's "daily merkle root of ledger records", which is **not built**: one work receipt can be proven on its own, but a ledger record that is not a receipt (a purchase, a spend, a payout) still has to be checked by replaying the ordering chain.

**Still open.**

- The #46 acceptance run: a real txid on a signet explorer, going from pending to confirmed with real confirmations. It has not been run because it needs a funded signet wallet; the runbook is in [going-to-mainnet.md](going-to-mainnet.md). `BITCOIN_ANCHOR_PROVIDER` is not in the `[env]` of the Fly seed configs, so unless it is set as a secret the deployed seeds report anchoring as disabled.
- The 200,000 sats/day default still needs maintainer sign-off.

## 6. Compute trust

| Layer | Design | Status as of 2026-11-14 |
|---|---|---|
| Agent identity | Signed agent requests are mandatory in production. | **Done, on `main` (#44).** `requireSignedAgentRequests` is always true in production (`src/swarm/result-integrity.ts:11-14`); `/heartbeat`, `/pull` and `/result` verify the signature (`src/swarm/coordinator/routes/agents.ts:270`, `src/swarm/coordinator/routes/tasks.ts:328`, `:463`). |
| Claims | Lease-based claims, heartbeat renewal, retry cap, late results rejected. | **Done, on `main` (#51).** Lease rules and defaults in `src/swarm/queue.ts:15-29` (30 s grace, 45 s liveness, 3 attempts, 30 min cap); expiry at `src/swarm/coordinator/routes/agents.ts:355`; late results rejected at `src/swarm/coordinator/routes/tasks.ts:504`; the claim is checked at `:566`. |
| Isolation | Remote tasks run in a sandbox; no host execution for swarm work. | **Done, with a limit (#45).** The coordinator gives no work to an agent that declares no sandbox (`pullSandboxRejection`, `src/swarm/sandbox-enforcement.ts:60`, called at `src/swarm/coordinator/routes/tasks.ts:366`), and the executor refuses to run remote work on the host (`src/executor/run.ts:46-47`). The limit: the coordinator trusts the mode the agent **declares**; it cannot prove what the agent really runs. `vm` is an accepted declared mode, but the executor here implements only `host` and `docker` (`run.ts:39`). |
| Model honesty | A result must come from the model the task asked for. | **Done in PR #275 (#54).** `resultModelMismatch` at `src/swarm/coordinator/routes/tasks.ts:571`; the agent's model list comes from signed heartbeats. |
| Verification | Sampled k-of-n re-execution with reputation; per-kind comparators; LLM `inference` is never verified. | **Built, off by default (#50, #104).** `src/swarm/verification.ts:138-151` (`rate: 0`, at most 3 executions); sampling at `src/swarm/coordinator/routes/tasks.ts:618`, settlement at `src/swarm/coordinator/results.ts:386`. The Fly configs do not set `RESULT_VERIFICATION_RATE`. Env reference: [DEPLOYMENT.md](DEPLOYMENT.md#result-verification). **Trust gap, unchanged:** nothing checks non-deterministic (LLM) output, which is the main workload; it is paid unverified. |
| Spend caps | IDE swarm requests are capped per request and per session. | **Done (#71).** `src/apps/ide/swarm-budget.ts`, `src/apps/ide/provider-server.ts:117`. |

## 7. Mesh trust

- Each coordinator has a stable Ed25519 key. Peers are trusted through `MESH_PEER_ALLOWLIST` entries of the form `peerId:sha256(SPKI)[@url]`, not by holding `MESH_AUTH_TOKEN` (#52). Production rejects token-only peers and fails closed when there is no allowlist.
- Every path into the peer table (registration, bootstrap, gossip) goes through one admission rule.
- Endpoints are pinned from the allowlist or bootstrap. Gossip never sets or changes a URL.
- Forwarded results are signed by the forwarding coordinator, protected against replay, and accepted only for subtasks the origin offered.

**Status as of 2026-11-14: done.**

- On `main`: allowlist parsing, URL pins and enforcement (`src/mesh/peer-trust.ts:57-154`, loaded at `src/swarm/coordinator/context.ts:137-150`), one admission rule (`admitPeer`, `peer-trust.ts:173`), signed registration (`src/swarm/coordinator/routes/mesh.ts:476-490`), ingest limited to allowlisted keys (`src/swarm/coordinator/routes/mesh.ts:121-122`), signed forwarded results with a replay cache (`peer-trust.ts:208-258`, checked at `src/swarm/coordinator/routes/tasks.ts:524`).
- PR #275 adds: the original agent's signature travels with a forwarded result and is verified (#122, `src/mesh/forwarded-agent-envelope.ts:88`, `src/swarm/coordinator/routes/tasks.ts:547`); one credit per subtask across coordinators (#123, §2); price proposals and the price quorum are bounded and signed only by allowlisted coordinators (#53, `src/economy/price-epoch-guard.ts`, `src/swarm/coordinator/routes/pricing.ts:94-256`).
- Agents also check the coordinator: the identity challenge binds the coordinator's signed URL to the URL the agent called (`src/trust/identity-challenge.ts:129`). The portal publishes a signed coordinator registry for discovery (`src/portal/coordinator-registry.ts`); it is not used for peer admission.

**Still open.**

- The allowlist is a static environment variable on each coordinator, not a signed document. Adding a peer means changing the configuration of every coordinator.
- `MESH_AUTH_TOKEN` is still a shared secret that gates the transport. It no longer confers peer trust.
- `MESH_PEER_ALLOWLIST` is not in the `[env]` of the Fly seed configs; whether it is set as a secret on the deployed seeds was not verified.

## 8. End-to-end acceptance (#56, third criterion): not met

The criterion: on regtest or signet, a host runs a task, it is verified, credits post exactly once, and an invoice purchase settles only after a real payment. No single test does this. What exists:

| Step | Covered by | Real Bitcoin/Lightning? |
|---|---|---|
| A Lightning invoice is unpaid until a real payment arrives; then it settles with a matching preimage | `tests/e2e/lnd-regtest.test.ts`, run by `npm run test:lnd-regtest` (`scripts/e2e/lnd-regtest.sh`: bitcoind and two LND nodes in Docker, PR #275) | **Yes, regtest.** Provider level only: it does not start a coordinator or touch the ledger. |
| A purchase credits exactly once, and only when the node says paid | `tests/swarm/payment-settlement.test.ts` | No. Fake provider. |
| A task result is credited exactly once (replay, two coordinators, restart) | `tests/economy/subtask-credit-shared.test.ts`, `tests/swarm/durable-replay.test.ts` (both need Postgres; CI job `credits-pg`), `tests/swarm/task-billing-route.test.ts` | No Bitcoin needed, but no real agent or sandbox run either. |
| A result is verified by a replica before payment | `tests/swarm/result-verification.test.ts`, `tests/swarm/result-verification-shared.test.ts` | No. Route and unit level. |
| `/ledger/verify` is clean afterwards | `tests/ledger/ledger-verify-pg.test.ts`, `tests/swarm/ledger-verify-route.test.ts` | No. Seeded rows. |
| The checkpoint is anchored and reaches depth | `tests/economy/anchoring.test.ts` | No. Mock provider. |

Gaps:

1. No test chains the steps: sandboxed run, verification, one credit, purchase, payout, anchor.
2. No regtest test drives the coordinator: purchase intent to credit on a real node, or a payout to a real node.
3. No two-coordinator regtest run.
4. `npm run test:lnd-regtest` is not in any CI workflow; it runs only when someone starts it by hand, and it needs the Docker Compose plugin.
5. `deploy/lnd-test/e2e-payout.sh` exercises purchase and withdrawal against the deployed regtest seeds, but it is a manual operator script and it injects the earnings row instead of earning it with a task.

## 9. Open work, in one list

1. The end-to-end regtest test of §8, in CI.
2. A signet anchoring run with a public txid (#46), and sign-off on the daily anchor budget.
3. Turn result verification on in the deployed configuration, and add a "pending until verified" gate before payouts go to mainnet (§4).
4. A check for LLM output (§6).
5. Tag verification mints in the ledger and count them in `/ledger/verify` (§2).
6. Proof for ledger records that are not work receipts, or a decision that receipt proofs are enough (§5).
7. A signed, shared allowlist instead of one environment variable per coordinator (§7).
8. `coordinator_earnings_projection.total_credits` to `NUMERIC` (#153).
9. Remove the wallet leftovers and correct the two `site-docs` pages (§3).
