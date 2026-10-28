# Economy and compute trust model (#56)

Status: **design draft, for review**. It records the direction from #56 and how the open P1 PRs implement it. The wallet custody model (#49) is deliberately left open until Cody decides.

"Done in" names the PR that carries each piece; none of them are on `main` yet.

## 1. Principles

1. **Credits are an off-chain ledger in Postgres.** Bitcoin is used to buy credits (Lightning) and to anchor the ledger (OP_RETURN), not to hold per-task balances.
2. **Nothing a client says is money.** Payment status comes from the Lightning node, work from server-measured and verified results, peer identity from allowlisted keys.
3. **Fail closed in production.** Mock providers, missing allowlists, missing secrets and unverifiable signatures are refused, not ignored.
4. **Money out waits for verification.** No sats payouts until results are verified and the ledger reconciles.

## 2. Ledger

| Concern | Design | Done in |
|---|---|---|
| Balance | Account balance is the sum of `credit_transactions`; debits are atomic and never go negative (row lock or conditional update, `CHECK balance >= 0`). | #91 (#48) |
| Earn formula | One function, `contributionCredits()`, used by Postgres, the in-memory engine and the `earnings_accrual` ledger payload; failed results earn 0; duration is server-measured, `min(reported, since claim, timeout)`. | #111 (#38), #44 |
| Idempotency | Unique keys per source: `reportId(subtaskId)` for earnings, `payment_hash` for purchases, BLE `txId` for offline sync. A replay is a no-op. | #44, #92, #41 |
| Verification mints | Replica executions that win verification are paid from newly minted credits, at most `maxExecutions - 1` per sampled subtask. Only when verification is on (off by default). The ledger reconciler must account for them. | #95, #114 |
| Reconciliation | Admin-only `/ledger/verify`: recompute balances from ledger records, re-derive accruals, check ordering-chain gaps and duplicate ids. Read-only. | #115 (open) |

## 3. Money in: Lightning

- Credits are issued only after the node confirms the invoice is settled, looked up by `payment_hash` (LND `lookupinvoice`), never by a client-supplied `txRef` (#42, #47 → #92).
- The webhook is a hint: an HMAC over the raw body is checked, then the node is queried (#42).
- `mock` Lightning is refused in production (#43).
- **Custody (#49): open.** Either (a) non-custodial: keys generated on the client and only xpub or address registered, or (b) custodial Lightning accounts (LNbits, LND accounts) with no seed phrase at all. The server must stop generating mnemonics in both cases. Held for Cody.

## 4. Money out

Postponed. Once verification has run in production and `/ledger/verify` (#115) is clean, payouts are batched over Lightning (keysend or LNURL-withdraw), not on-chain sweeps. Rewards stay **pending** until their result is verified.

## 5. Anchoring

- One anchor service with a hot wallet (bitcoind or the authenticated anchor proxy) publishes the checkpoint hash of the ledger via OP_RETURN (#46 → #94).
- Spend guards: daily budget (`BITCOIN_ANCHOR_DAILY_BUDGET_SATS`, default 200k sats), per-tx fee cap, mainnet opt-in (#94).
- Confirmation depth and reorg tracking; RPC errors are "unknown", never "left the chain" (#94).
- **Reconciliation** at startup and on a timer: rows left `broadcasting` by a crash are looked up in the wallet; stuck txs are abandoned (`abandontransaction`) before being marked failed; abandoned txs are watched and re-marked anchored if they confirm anyway, with their fee charged to the budget; rows that can't be resolved go to `needs_admin` and are never auto-rebroadcast (#103 → #109, #116).
- Open: the signed-vsize × feerate check against the fee cap (#103), signet proof run before mainnet.
- Manual anchor triggers need the admin token (#100 → #110).

## 6. Compute trust

| Layer | Design | Done in |
|---|---|---|
| Agent identity | Signed agent requests are mandatory in production (`/heartbeat`, `/pull`, `/result`). | #44 |
| Claims | Lease-based claims sized to the task timeout, heartbeat renewal, retry cap, late results rejected, refund on terminal failure. | #93 (#51) |
| Isolation | Remote tasks must run in the Docker or VM sandbox; no host execution for swarm work. | #45 |
| Verification | Sampled k-of-n re-execution (first two agreeing results win, at most 3 executions), reputation-weighted sampling (unknown agents start at 0.5), penalties for mismatch and for abandoning a replica, stalled replicas reassigned. Exact-match only, so it's for deterministic workloads; off by default. | #95 (#50), #114 (#106) |
| Spend caps | IDE swarm requests are capped per request and per session; a reservation is released only when the submit itself fails. | #113 (#71) |

## 7. Mesh trust

- Each coordinator has a stable Ed25519 key (`COORDINATOR_PRIVATE_KEY_PEM`). Peers are trusted by `MESH_PEER_ALLOWLIST` (`peerId:sha256(SPKI)`), not by holding `MESH_AUTH_TOKEN` (#52 → #118).
- Every path into the peer table (registration, bootstrap, `peer_exchange`) goes through one admission rule. Registration proves key possession. Gossip from non-allowlisted peers is rejected.
- Forwarded results are signed by the forwarding coordinator over the raw bytes, protected against replay, and accepted only for subtasks the origin offered.
- Open: verifying forwarded results against the original agent signature (#122); a single credit per subtask across coordinators with shared Postgres as the source of truth (#123); a signed price quorum with bounds (#53).

## 8. End-to-end acceptance (still open)

The #56 acceptance test, still to be built (regtest or signet, two coordinators):
1. A host runs a task in the sandbox.
2. The result is verified (replica agrees).
3. Credits post exactly once, visible in the ledger and the balance, and `/ledger/verify` is clean.
4. An invoice purchase settles only after a real Lightning payment.
5. The day's checkpoint is anchored and reaches confirmation depth.
