# Economy and compute trust model (#56)

Status: **design draft, for review**. It records the direction from #56 and how the open P1 PRs implement it. The wallet custody model (#49) is deliberately left open until Cody decides.

"Done in" names the PR that carries each piece; none of them are on `main` yet. `open (#N)` means the issue has no PR yet, so that piece is **not built**.

Pending owner sign-off (Cody): the custody model (#49) and the default daily anchor budget (§5).

## 1. Principles

1. **Credits are an off-chain ledger in Postgres.** Bitcoin is used to buy credits (Lightning) and to anchor the ledger (OP_RETURN), not to hold per-task balances.
2. **Nothing a client says is money.** Payment status comes from the Lightning node, work from server-measured and verified results, peer identity from allowlisted keys.
3. **Fail closed in production.** Mock providers, missing allowlists, missing secrets and unverifiable signatures are refused, not ignored.
4. **Money out waits for verification.** No sats payouts until results are verified and the ledger reconciles.

## 2. Ledger

| Concern | Design | Done in |
|---|---|---|
| Balance | Account balance is the sum of `credit_transactions`; debits are atomic and never go negative (row lock or conditional update, `CHECK balance >= 0`). | #91 (#48) |
| Earn formula | One function, `contributionCredits()`, used by Postgres, the in-memory engine and the `earnings_accrual` ledger payload; failed results earn 0; duration is server-measured, `min(reported, since claim, timeout)`. | #111 (#38); server-measured duration and signed reports open (#44) |
| Idempotency | Unique keys per source: `reportId(subtaskId)` for earnings, `payment_hash` for purchases, BLE `txId` for offline sync. A replay is a no-op. | purchases: #92; earnings open (#44); BLE open (#41) |
| Verification mints | Replica executions that win verification are paid from newly minted credits, at most `maxExecutions - 1` per sampled subtask. Only when verification is on (off by default). Minted credits are tagged as their own source (`source_type = 'verification_mint'`), counted separately by `/ledger/verify`, and stay **pending** (not payable) until payouts open. Whether to mint at all before verification is enabled is an open question for Cody. | #95, #114; tagging and pending state open (#115) |
| Reconciliation | Admin-only `/ledger/verify`: recompute balances from ledger records, re-derive accruals, check ordering-chain gaps and duplicate ids. Read-only. | #115 (open) |

### Ledger schema (minimum)

`credit_transactions` today has `tx_id` (PK), `account_id`, `tx_type`, `credits`, `reason`, `related_task_id`, `timestamp_ms`, and a partial unique index on `reason` for `credit_purchase:*` (#91, #92). The target, which #115 builds toward:

| Column | Type | Rule |
|---|---|---|
| `tx_id` | `TEXT PRIMARY KEY` | |
| `account_id` | `TEXT NOT NULL` | Index on `(account_id, timestamp_ms DESC)`. |
| `credits` | `NUMERIC NOT NULL` | Signed: `> 0` credit, `< 0` debit, `CHECK (credits <> 0)`. |
| `source_type` | `TEXT NOT NULL` | `CHECK (source_type IN ('purchase','earning','verification_mint','spend','refund','ble_sync','admin_adjust'))`. |
| `idempotency_key` | `TEXT NOT NULL` | `UNIQUE (source_type, idempotency_key)`: `payment_hash`, `reportId(subtaskId)`, BLE `txId`, and so on. |
| `ledger_record_id` | `TEXT` | Links to the ordering-chain record that carries this entry (what gets anchored). |
| `created_at_ms` | `BIGINT NOT NULL` | |

The balance is `SUM(credits)` per account. Debits take a row lock on the account (or use a conditional insert), so the balance never goes below 0. This is enforced in the debit path, because a `CHECK` can't span rows; #91 does this.

## 3. Money in: Lightning

- Credits are issued only after the node confirms the invoice is settled, looked up by `payment_hash` (LND `lookupinvoice`), never by a client-supplied `txRef` (#42, #47 → #92).
- The webhook is a hint: an HMAC-SHA256 over the raw body, keyed by `PAYMENT_WEBHOOK_SECRET`, is checked, then the node is queried (#42 → #92). If the secret is missing, production refuses the webhook (fails closed).
- `mock` Lightning is refused in production (#43).
- **Custody (#49): open, waiting on Cody.** The options are (a) non-custodial: keys are generated on the client and only the xpub or address is registered; or (b) custodial Lightning accounts (LNbits, LND accounts) with no seed phrase at all. The reviewer recommends (a). Either way, the server must stop generating mnemonics.

## 4. Money out

Postponed. Once verification has run in production and `/ledger/verify` (#115) is clean, payouts are batched over Lightning (keysend or LNURL-withdraw), not on-chain sweeps. Rewards stay **pending** until their result is verified.

## 5. Anchoring

- One anchor service with a hot wallet (bitcoind or the authenticated anchor proxy) publishes a 32-byte value via OP_RETURN (#46 → #94).
- **What is anchored.** Today (#94) the anchored value is the head hash of the ordering chain, so proving one record means replaying the chain. The target (#56) is a **daily merkle root**:
  - Leaves are the SHA-256 hashes of that UTC day's ledger records (the ordering-chain records that `ledger_record_id` points to), ordered by chain sequence number.
  - Internal nodes are `SHA-256(left || right)`. An odd node is paired with itself.
  - The root, the day, and the first and last sequence numbers are stored with the anchor row.
  - A read endpoint returns any record's proof path (its sibling hashes and positions) plus the anchoring txid, so one record can be checked against the chain on its own.
  - Not built yet; open (#56).
- Spend guards: a daily budget (`BITCOIN_ANCHOR_DAILY_BUDGET_SATS`), a per-tx fee cap, and mainnet opt-in (#94). The default of **200k sats/day is proposed, pending owner sign-off (Cody).**
- Confirmation depth and reorg tracking; RPC errors are "unknown", never "left the chain" (#94).
- **Reconciliation** at startup and on a timer: rows left `broadcasting` by a crash are looked up in the wallet; stuck txs are abandoned (`abandontransaction`) before being marked failed; abandoned txs are watched and re-marked anchored if they confirm anyway, with their fee charged to the budget; rows that can't be resolved go to `needs_admin` and are never auto-rebroadcast (#103 → #109, #116).
- Open: the signed-vsize × feerate check against the fee cap (#103), signet proof run before mainnet.
- Manual anchor triggers need the admin token (#100 → #110).

## 6. Compute trust

| Layer | Design | Done in |
|---|---|---|
| Agent identity | Signed agent requests are mandatory in production (`/heartbeat`, `/pull`, `/result`). | **open (#44), not built** |
| Claims | Lease-based claims sized to the task timeout, heartbeat renewal, retry cap, late results rejected, refund on terminal failure. | #93 (#51) |
| Isolation | Remote tasks must run in the Docker or VM sandbox; no host execution for swarm work. | **open (#45), not built** |
| Verification | Sampled k-of-n re-execution (first two agreeing results win, at most 3 executions), reputation-weighted sampling (unknown agents start at 0.5), penalties for mismatch and for abandoning a replica, stalled replicas reassigned. Exact-match only, so it's for deterministic workloads; off by default. **Trust gap:** exact match gives no protection for non-deterministic (LLM) output, which is the main workload. Those results earn only after a different check is built, or stay unpaid. | #95 (#50), #114 (#106) |
| Spend caps | IDE swarm requests are capped per request and per session; a reservation is released only when the submit itself fails. | #113 (#71) |

## 7. Mesh trust

These bullets are the requirement. #118 implements them, but it is still in review.

- Each coordinator has a stable Ed25519 key (`COORDINATOR_PRIVATE_KEY_PEM`). Peers are trusted through `MESH_PEER_ALLOWLIST` entries of the form `peerId:sha256(SPKI)[@url]`, not by holding `MESH_AUTH_TOKEN` (#52 → #118). **Production rejects token-only peers** and fails closed when there is no allowlist.
- Every path into the peer table goes through one admission rule: registration, bootstrap and `peer_exchange`. Only an allowlisted (id, key) pair is admitted, and an allowlisted entry can't be squatted.
- Endpoints are pinned: they come from the allowlist `@url` or from bootstrap. Gossip never sets or changes a URL.
- Registration proves key possession. `/mesh/ingest` accepts only allowlisted peers.
- Forwarded results are signed by the forwarding coordinator over the raw bytes, protected against replay, and accepted only for subtasks the origin offered.
- Open:
  - Verifying forwarded results against the original agent's signature (#122).
  - A single credit per subtask across coordinators, with shared Postgres as the source of truth (#123).
  - A signed price quorum with bounds (#53).

## 8. End-to-end acceptance (still open)

The #56 acceptance test, still to be built (regtest or signet, two coordinators):
1. A host runs a task in the sandbox.
2. The result is verified (replica agrees).
3. Credits post exactly once, visible in the ledger and the balance, and `/ledger/verify` is clean.
4. An invoice purchase settles only after a real Lightning payment.
5. The day's checkpoint is anchored and reaches confirmation depth.
