# Decentralizing funds, records and routing

Status: roadmap. Approved by the owner on 2026-11-17. Everything is marked as one of:

- **Built**: in the code on `main`, and whether it is on in production.
- **This PR**: added with this document (proof of reserves).
- **Proposed**: not built. Design only.

Nothing here changes a live coordinator until its configuration does.

## Where things stand

| Piece | Today | Single point of trust |
| --- | --- | --- |
| Funds | One custodial Lightning node, `edgecoder-lnd` (LND, mainnet), using the owner's full node `ocean-node` as its chain backend over WireGuard. It holds customers' prepaid sats, hosts' unpaid earnings and the fee pool, in channels and in its on-chain wallet. | Whoever controls `edgecoder-lnd`: its seed, its macaroons, its machine. |
| Records | One Postgres ledger (`credit_transactions`, `payouts`, `ledger_records`, ...) shared by both coordinators. Hash-chained ordering records (`src/ledger/chain.ts`), signed work receipts (`src/receipts/`). | The database operator could rewrite history. Bitcoin anchoring would make that detectable, but it is **off** in production. |
| Routing | Two coordinators run by EdgeCoder: `seed` (Chicago, ord) and `seed-eu` (Paris, cdg). They gossip capabilities and forward work (site-docs/operations/coordinator-federation.md). | EdgeCoder runs both. |

Controls that already exist (**built**, on unless noted):

- Payout caps per payout, per account per day and per coordinator per day, a kill switch, and periodic
  reconciliation of the ledger against the node that pauses payouts on a mismatch
  (`src/economy/payout-safeguards.ts`, `src/economy/payout-reconcile.ts`, docs/going-to-mainnet.md).
- A 24 h earnings hold on mainnet before earnings become withdrawable.
- Read-only ledger reconciliation (`src/ledger/reconcile.ts`, `/admin/payouts/reconciliation`,
  `/ledger/verify`).
- A treasury *policy record*: `POST /economy/treasury/policies` stores a multisig descriptor string, a
  quorum and the approved coordinator ids, with signed key-custody events (`src/economy/treasury.ts`).
  It is metadata only. It holds no funds, builds no transactions and signs nothing. The vault below
  would be the first thing to give it meaning.

## Phases

### Phase 1: at launch

1. **Proof of reserves** (**this PR**, details below): a public page and endpoint with what EdgeCoder
   owes against what its node holds.
2. **Bitcoin anchoring on** (**built, off**): turn it on at mainnet. Plan and exact asks in
   [Turning anchoring on](#turning-anchoring-on-at-mainnet).
3. **A small hot float plus a 2-of-3 on-chain vault** (**proposed**, see
   [Multisig custody](#multisig-custody)). Can follow launch by a few weeks. Until it exists, the cap on
   what can be lost is the node's total balance, so keep that small (payout caps, earnings hold).

### Phase 2: paths that don't hold customer funds

1. **Nostr Wallet Connect** (**built, off**, `PAYMENTS_NWC=1`): the buyer pays from their own wallet in
   short settlement batches, straight to the host. EdgeCoder holds nothing between batches
   (docs/design/noncustodial-payments.md, `src/economy/direct/nwc.ts`, `tally.ts`).
2. **Direct reservations** (**built, off**, `PAYMENTS_DIRECT_RESERVATIONS=1`): reservations, blocks of time
   and server commitments are paid buyer to host directly (Lightning, on-chain BTC, Zcash), with the 5 %
   fee paid separately to EdgeCoder (`src/economy/direct/reservations-direct.ts`).
3. **Signed receipts per job** (**built**): work receipts signed by agent and coordinator
   (`src/receipts/`, docs/receipts-and-trust.md) and settlement receipts for direct payments carrying the
   preimage or txid (`src/economy/direct/receipts.ts`). Next: hand every buyer their receipts too, so a
   buyer can prove what they paid for without trusting the ledger.

Every sat that moves this way is a sat that never sits in the custodial node.

### Phase 3: shared custody

The vault below, extended from 2-of-3 (EdgeCoder and the owner) to independent coordinator operators
as they join, plus federated ecash (Fedimint) for prepaid balances if the regulatory review allows it.

### Phase 4: pay on result, federated coordinators

1. **Pay-on-result with hold invoices** (**proposed**): a buyer's payment is locked in a Lightning hold
   invoice (LND `AddHoldInvoice` / `invoicesrpc`) and is only settled when the work is delivered and
   checked, or cancelled if it isn't. No refund-as-credit, nothing to hold. This is the "reservation is
   a hold invoice" target in docs/ROADMAP.md. Limits: a hold invoice locks liquidity along the whole
   route while held, so it fits jobs measured in minutes, not days. Nothing in the code issues hold
   invoices today.
2. **Federated coordinators** (**partly built**): capability gossip, cross-coordinator routing and
   quorum issuance exist (site-docs/operations/coordinator-federation.md). What is missing for
   independent operators: per-operator ledgers that reconcile with each other instead of one shared
   Postgres, anchoring by each operator, and admission of operators run by people other than EdgeCoder.
3. **Ecash** (docs/ROADMAP.md): Cashu or Fedimint for small, frequent, private payments, opt-in, since it
   trusts a mint.

## Proof of reserves

**This PR.** Ships with mainnet.

| Where | What |
| --- | --- |
| Coordinator `GET /economy/reserves` | Public, no token. JSON. Cached (`RESERVES_CACHE_MS`, default 60 s) and limited per client IP (`RESERVES_RATE_LIMIT_PER_MIN`, default 30). `src/swarm/coordinator/routes/reserves.ts` |
| Portal `/reserves`, `/reserves.json` | The page and a JSON copy, from the first coordinator's report, cached 60 s and limited to 30 requests per minute per IP. Linked from the website footer next to the legal documents. `src/portal/reserves.ts`, `src/portal/pages/public.ts` |
| Logic | `src/economy/proof-of-reserves.ts` (pure), `PostgresStore.reserveLiabilitiesMsat` (one aggregate query over existing tables, no new table) |

The report:

- **Liabilities** (from the ledger, rounded up to whole sats): Σ of every account's positive cSat balance
  (customers' prepaid cSats and hosts' unpaid earnings are both balances; 1 cSat = 1 sat; a negative
  balance never offsets another), the fee pool's undistributed sats, and cSats reserved for jobs that
  haven't settled (open `task_billing` rows, less what they already paid out).
- **Reserves** (from `edgecoder-lnd`, read-only `GET /v1/balance/channels` and `/v1/balance/blockchain`):
  spendable local channel balance plus confirmed on-chain balance. Unconfirmed amounts, channels still
  opening and HTLCs in flight are shown but not counted.
- The ratio, the time, the network (`mainnet`, `signet`, ...), and the latest real Bitcoin anchor of a
  ledger checkpoint once anchoring is on (simulated rows are never shown).
- Totals only. Nothing per account is read into the report; the portal rebuilds the coordinator's report
  from the known aggregate fields, so even a coordinator that sent more would not leak it.
- If the node or the ledger can't be read, that side says `unavailable` with a reason code, and there is
  no ratio. No guessed numbers, no stale numbers under a new timestamp. Error details go to the log only.

What it proves, and what it doesn't (the page says the same):

- It is **not** a cryptographic proof. The node reports its own balance and the ledger its own totals.
  A dishonest operator could misreport either one.
- It does show, continuously and publicly, whether the operator's own numbers say it is solvent, which
  is what most failures hide first.
- Once anchoring is on, anyone can check that the ledger's history was not rewritten after the fact.
- Not counted as liabilities: on-chain deposits the node holds but hasn't credited yet (pending
  confirmations, held, below the minimum). They make the ratio slightly higher than the true one.
- Admin grants (faucet cSats, test networks only) count as liabilities even though no sats came in.

Next steps (**proposed**):

1. **Liabilities Merkle sum tree.** Each snapshot, build a tree whose leaves commit to (account id,
   balance) with a per-account random nonce and whose nodes carry sums; publish the root and its sum with
   the report; give each signed-in account its leaf nonce and sibling path. An account that checks can
   see its balance is in the published total, and a total that left anyone out is caught by the first
   person left out who checks. The tree and its verifier are in this PR as a library
   (`src/ledger/liabilities-tree.ts`, tested) but **not wired** to any route; publishing it needs a
   signed-in "verify my balance" view and a decision on how often to snapshot.
2. **Publish the vault descriptor** (once the vault exists). Anyone with the descriptor can see the
   vault's balance on chain. That part of the reserves then needs no trust at all. The cost: it also shows
   every vault transaction.
3. **Prove channel balances.** There is no standard way to prove a Lightning balance to a third party
   today. Signing a message with the node key proves control of the node, not its balance.

## Multisig custody

The owner asked for custody "like Unchained": several keys, held by different people, a quorum of them
needed to move funds, no single holder able to move them alone. This section works out where that
applies, and where it can't.

### What multisig can and can't cover

- **On-chain funds: yes.** A k-of-n multisig output (P2WSH or Taproot) can only be spent with k
  signatures. This is mature: Bitcoin Core descriptor wallets, PSBTs (BIP 174), Sparrow, Nunchuk, Liana,
  hardware signers (Coldcard, Jade, Trezor, Ledger) all support it.
- **Lightning payments: no, not per payment, not today.** A Lightning channel is a 2-of-2 output between
  the two channel peers. EdgeCoder's side of every channel is one key held by `edgecoder-lnd`, which
  signs every commitment update alone, many times a second. There is no "3 coordinators approve this
  payment" in any Lightning implementation. Whoever controls the node can spend everything in its
  channels. Multisig therefore protects **the funds that aren't in the hot node**, and that is the design:
  keep the hot node small.

### On-chain treasury vault (proposed)

**Policy.** Start with **2-of-3**:

| Key | Held by | Where |
| --- | --- | --- |
| A | The owner | A hardware signer, offline, with its seed backup in a separate place |
| B | EdgeCoder operations | A signer service on a coordinator machine (online key, policy-checked; see below) |
| C | A third party: a second operator, or a key-holding service | Their own device or service |

Grow it to 3-of-5 as independent coordinator operators join (each new operator holds one key). A
quorum change is a new vault (new descriptor) and one quorum-signed transfer from the old vault to it.

**Descriptor.** Each key holder generates their own key on their own device and shares only an extended
public key (xpub) with its key origin (master fingerprint and derivation path, e.g. `m/48'/0'/0'/2'` for
P2WSH multisig). No private key is ever transmitted or assembled in one place. From the xpubs:

```text
# P2WSH 2-of-3 (widest signer support)
wsh(sortedmulti(2,[fpA/48'/0'/0'/2']xpubA/<0;1>/*,[fpB/48'/0'/0'/2']xpubB/<0;1>/*,[fpC/48'/0'/0'/2']xpubC/<0;1>/*))

# With a recovery path (miniscript): 2-of-3 now, or the owner's recovery key R alone after
# ~1 year without the coins moving (older(52560) blocks; older() is capped at 65535 blocks, ~15 months).
wsh(or_d(multi(2,A,B,C),and_v(v:pkh(R),older(52560))))
```

A Taproot form (`tr(<unspendable internal key>,multi_a(2,A,B,C))`) works too and is cheaper per spend,
but fewer hardware signers handle `multi_a` today. Start with P2WSH; move later.

The timelocked recovery key covers the case where two of three keys are lost: if nothing moves for a
year, the owner's recovery key alone can spend. Coins have to be moved (re-locked) at least once a year
to keep the timelock from maturing, which the regular sweeps below do anyway.

**Backups.** Every key holder keeps: their seed (metal, offline), and **the full descriptor** (all
xpubs, fingerprints, paths, the policy). Without the descriptor, two seeds are not enough to find or
spend the coins. The descriptor is not secret in the sense of moving funds, only in the sense of
privacy; store a copy with each seed and one with counsel. Test a recovery on signet before mainnet.

**Watch-only wallets.** Every coordinator imports the descriptor into a watch-only wallet (no private
keys) to see the balance, derive receive addresses and build unsigned PSBTs. The proof-of-reserves report
adds the vault balance as its own line.

**Signer service (key B, and each future coordinator's key).** A small process next to the coordinator,
holding one key, that signs a PSBT only if every check passes. It never builds transactions and never
broadcasts. Its checks:

1. **Destinations.** Every output is either change back to the vault (verified by deriving it from the
   descriptor, not trusted from the PSBT) or on an allowlist. The allowlist starts with: `edgecoder-lnd`'s
   on-chain deposit addresses for top-ups, and the next vault (for a quorum change). Adding a destination
   is itself a quorum action with a 72 h delay before it takes effect.
2. **Amounts.** Per-transaction cap (e.g. 2× the hot float target) and a rolling 24 h cap.
3. **Rate.** At most N spends per day; a minimum time between spends.
4. **Fee.** Fee rate and absolute fee under caps (no fee-sniping the vault).
5. **Solvency.** After the transfer, the hot node plus the vault still cover liabilities (the proof of
   reserves numbers), so a top-up can't be a cover for draining.
6. **Request authenticity.** The spend request is signed by an approved coordinator's identity key
   (Ed25519, `src/mesh/peer.ts`) and recorded as a signed key-custody event (`src/economy/treasury.ts`).

The owner's key (A) is signed by hand on a hardware device, which shows the outputs and amounts on its
own screen, so the owner checks what the software can't vouch for.

**A spend.**

```text
1. Proposer (a coordinator's treasury job, or the owner) builds an unsigned PSBT from the
   watch-only wallet: inputs from the vault, outputs to the destination + change to the vault.
2. It records a signed spend request {psbt, reason, destination, amount} in the ordering chain
   and sends it to the other key holders over the mesh (or, for the owner, by file / QR).
3. Each signer verifies the PSBT under its own policy (above), independently. It signs its
   inputs and returns the partially signed PSBT, or a signed refusal with the reason.
4. Once k signatures are present, any party combines and finalizes (BIP 174 combiner and
   finalizer) and broadcasts. The txid is recorded with the request.
5. Reconciliation and the proof-of-reserves report pick up the new balances.
```

No party ever sees another's private key. A compromised coordinator can propose, but can't move funds
alone, and its proposals still face every other signer's policy.

### Hot/cold split

- **Hot (`edgecoder-lnd`)** stays a single-signer node, as Lightning requires. It holds only a working
  float: enough channel balance for a few days of payouts and enough on-chain balance for channel
  fees and the anchor-channel reserve. A starting target: the larger of 3 days of peak payouts and
  what the payout caps allow in 3 days (`PAYOUT_MAX_GLOBAL_DAILY_SATS` × 3).
- **Cold (the vault)** holds everything above that: reserves behind prepaid balances and the fee pool.
- **Refill** (vault to hot) is a quorum spend to an allowlisted LND address, then a channel open or
  top-up from LND's on-chain wallet. (LND doesn't splice; an extra channel or a swap-in does the job.)
- **Sweep** (hot to vault) needs no quorum: anyone can pay *into* the vault. Two cases:
  - Excess on-chain balance in LND: one `SendCoins` to a fresh vault address. Can be automated with a
    destination check against the watch-only descriptor.
  - Excess *channel* balance: Lightning balance can't be sent on chain directly. It takes a swap out
    (e.g. Lightning Loop Out, a submarine swap with a fee) or closing a channel. In practice inbound
    payments refill channels, so sweeps are mostly on-chain, from purchases paid on chain and from
    channel closes.
- The payout reconciler (`payout-reconcile.ts`) must learn about vault transfers before the first one,
  or it will read a sweep as an unexplained balance drop and pause payouts. Small change: record vault
  transfers in the ledger and treat them like on-chain payout batches.

### Lightning: reducing single-node trust

None of these makes Lightning k-of-n per payment. They narrow what a node compromise can do.

- **Validating Lightning Signer (VLS).** The node's keys move to a separate signer that refuses to
  sign anything outside its policy: no channel close to an unknown address, velocity limits on outgoing
  payments, allowlists. A compromised node machine can't drain channels past the limits. Best supported
  with Core Lightning today; LND's own "remote signer" mode separates the keys but doesn't validate
  policy. For EdgeCoder this likely means moving the hot node to CLN (the coordinator already speaks CLN
  REST: `ClnRestProvider` in `src/economy/lightning.ts`).
- **Threshold signing (FROST, MuSig2).** In principle EdgeCoder's channel key could itself be a
  threshold key held by several coordinators, so a channel update needs t of n of them. Taproot channels
  (MuSig2 between the two peers) exist experimentally in LND, but nested threshold keys inside one side of
  a channel are research, not a product. Watch, don't plan on it.
- **Fedimint.** A federation of guardians (e.g. 4 coordinators, tolerating 1 faulty) holds on-chain bitcoin
  in threshold custody and issues ecash notes against it; Lightning gateways (operated separately)
  swap ecash for Lightning payments. This is the closest thing to "multisig custody among coordinators"
  for prepaid balances: no single guardian can move the reserves, and the mint can't see who holds what.
  Costs: a different model (balances become bearer ecash held by the user's client, not ledger rows), a
  gateway that is itself a hot Lightning node, guardian operations, and it is still custody under most
  readings.

| | On-chain multisig vault | Fedimint | VLS |
| --- | --- | --- | --- |
| Protects | Reserves at rest (most of the money, if the float is kept small) | Prepaid balances and their reserves, against any single guardian | The hot node's channels, against a compromised node machine |
| Doesn't protect | Funds in the hot node | Funds in transit through the gateway; users who lose their ecash | Against whoever controls the signer and its policy |
| Removes single-operator custody | Of reserves, yes, once a key is held outside EdgeCoder | Yes, once guardians are independent | No (one signer) |
| Maturity | Mature (years in production, many wallets and signers) | In production, young; protocol still changing | In production with CLN; LND not first-class |
| Effort for EdgeCoder | Medium: signer service, PSBT relay, policies, runbooks, reconciler change | High: new payment model, guardians, gateway, client changes | Medium-high: likely a move from LND to CLN, signer deployment, policy tuning |
| Fits | Phase 1-3 | Phase 3+ | Phase 3, if the hot node stays large |

### Recommended path

1. **At launch:** a single hot node with a small float (launch caps keep liabilities small), and a
   **2-of-3 P2WSH vault**: the owner's key (hardware, offline), an EdgeCoder operations key (signer
   service with the policy checks), and a third key held separately: by a second operator if one is
   ready, otherwise by the owner in a second location or a collaborative-custody service. Use the
   timelocked recovery path. Test the whole cycle (fund, refill, sweep, recover) on signet first.
2. **As independent operators join:** each one generates a key and runs a signer; the vault moves to a
   new descriptor (3-of-5 or more) where no single organisation holds a quorum.
3. **Later:** Fedimint for prepaid balances, if the regulatory review allows it and the demand is there;
   VLS (with CLN) if the hot node has to stay large.
4. **Throughout:** push volume onto the paths that hold nothing (NWC, direct reservations, hold invoices),
   so there is less to custody in the first place.

### Regulatory note

Shared custody reduces the risk that one operator loses or takes customer funds. It does not, by
itself, make EdgeCoder non-custodial towards its customers: customers hold none of the keys, and a
quorum of operators can still move their money. Whether that changes anything under money-transmission
rules (FinCEN in the US, state MTL regimes, MiCA in the EU) depends on who the key holders are and what
each can do, and federated ecash raises its own questions. **Counsel to review before any of this ships**,
including whether co-signing operators take on obligations of their own. The non-custodial paths
(Phase 2, pay-on-result) are the ones most likely to reduce the regulatory surface.

## Turning anchoring on at mainnet

**Built, off.** Anchoring writes a checkpoint hash (`EC` + version + 32-byte hash, 35 bytes) in an
OP_RETURN output (`src/economy/anchoring.ts`, site-docs/economy/bitcoin-anchoring.md). It needs
`BITCOIN_ANCHOR_PROVIDER` (`bitcoind` or `anchor-proxy`) and a funded wallet. Today `edgecoder-lnd`
reaches `ocean-node` over WireGuard at `[fdaa:ec:ae3e:a7b:9016:7eba:d6ac:1b02]:8332` with an RPC user
whose whitelist is for LND only, and no wallet is set up for anchoring.

### Options

1. **`bitcoind` provider against `ocean-node`, with its own RPC user and wallet.** No code change, no
   new app. The coordinators talk to `ocean-node` directly. The provider (`BitcoindRpcProvider` in
   `src/economy/bitcoin-rpc.ts`) calls exactly these methods, which is the whitelist to grant:

   | Method | Used for |
   | --- | --- |
   | `getblockchaininfo` | health check |
   | `getwalletinfo` | health check (wallet loaded, balance) |
   | `estimatesmartfee` | fee rate (floored at `BITCOIN_ANCHOR_MIN_FEE_SAT_VB`) |
   | `createrawtransaction` | the OP_RETURN transaction |
   | `fundrawtransaction` | coin selection and change, with the fee cap |
   | `signrawtransactionwithwallet` | signing with the anchoring wallet |
   | `sendrawtransaction` | broadcast |
   | `gettransaction` | confirmations, block, reorg checks; finding a crashed broadcast |
   | `listtransactions` | finding a crashed broadcast (#103 reconciliation) |
   | `getmempoolentry` | whether a stuck transaction is still in the mempool |
   | `abandontransaction` | releasing a dropped transaction's inputs before re-anchoring |

   Not needed and not to be granted: `sendtoaddress`, `sendmany`, `listunspent`, `getrawchangeaddress`
   (`sendToMany` isn't used for anchoring), `loadwallet`/`createwallet`, `dumpprivkey`, any wallet
   backup or import method.

2. **LND's on-chain wallet.** Not supported by the code. It would need a new `lnd` anchor provider:
   fund a PSBT template holding one zero-value OP_RETURN output (`/v2/wallet/psbt/fund`), finalize
   (`/v2/wallet/psbt/finalize`), publish (`/v2/wallet/tx`), and read confirmations from
   `/v1/transactions`. Effort: about 2-3 days with tests and a regtest run (`scripts/e2e/lnd-regtest.sh`),
   after a spike to confirm LND accepts an OP_RETURN-only template. Drawbacks: it spends from the same hot
   wallet as customer funds, it needs an on-chain-write macaroon on every coordinator, LND has no mempool
   query (the stuck-transaction path would need a public API or stay manual), and the payout reconciler
   would read every anchor fee as an unexplained balance drop until it learns about them. Not worth it
   while option 1 exists.
3. **The `edgecoder-anchor-proxy` app** (`Dockerfile.anchor-proxy`, `src/economy/anchor-proxy-*.ts`):
   coordinators hold only a bearer token, the RPC credentials live in one app, broadcasts are rate
   limited. It still needs the same `ocean-node` RPC user and wallet as option 1, plus a new Fly app
   (one small machine, a few dollars a month) and its `deploy/` files, which are protected and need the
   owner's approval. Worth it when coordinators are run by people who shouldn't hold RPC credentials to
   the owner's node.

### Recommendation: option 1, every 6 hours

- **Frequency.** Anchor the latest stats checkpoint every 6 hours (`STATS_ANCHOR_INTERVAL_MS=21600000`,
  default is 10 minutes) and finalized issuance epochs at most daily (`ANCHOR_INTERVAL_MS=86400000`).
  Each checkpoint commits to the whole hash chain before it, so 4-5 anchors a day cover everything; more
  only shortens the window in which history could be rewritten undetected.
- **Cost per anchor.** One input, the OP_RETURN output and change: about 155 vB. At 2 sat/vB (the floor)
  about 310 sats, at 5 sat/vB about 780, at 20 sat/vB about 3 100. At 5 a day and typical fees, roughly
  1 500-4 000 sats a day, 45 000-120 000 sats a month.
- **Caps.** `BITCOIN_ANCHOR_MAX_FEE_SATS=5000` (default 20 000 is generous for a 155 vB transaction) and
  `BITCOIN_ANCHOR_DAILY_BUDGET_SATS=30000`. The budget check reserves the fee cap per broadcast, so this
  allows 6 broadcasts a day; during a fee spike, anchors above the cap wait rather than overpay.
- **Wallet.** A dedicated descriptor wallet on `ocean-node`, funded with about 200 000 sats (a few months
  at the rates above). It holds nothing else.
- Move to option 3 when the first coordinator not run by EdgeCoder joins.

### What's needed, exactly

From the `ocean-node` operator (owner approval; no EdgeCoder code involved):

1. Create the wallet: `bitcoin-cli createwallet edgecoder-anchor` (descriptor wallet), and load it at
   start (`wallet=edgecoder-anchor` in `bitcoin.conf`), since the anchoring user may not call `loadwallet`.
2. Add the user: `rpcauth=edgecoder-anchor:<salt>$<hash>` (generated with Bitcoin Core's
   `share/rpcauth/rpcauth.py`; the password goes to the owner for the coordinators' secrets, never in
   the repo).
3. Whitelist exactly the 11 methods above:
   `rpcwhitelist=edgecoder-anchor:getblockchaininfo,getwalletinfo,estimatesmartfee,createrawtransaction,fundrawtransaction,signrawtransactionwithwallet,sendrawtransaction,gettransaction,listtransactions,getmempoolentry,abandontransaction`.
   Keep `rpcwhitelistdefault` at its default (on once any whitelist exists), so users without a whitelist
   get nothing. Bitcoin Core can't restrict a user to one wallet: the node should load no other wallet
   holding funds, or that wallet would also be signable by this user.
4. Let the coordinators in: allow their private (6PN) addresses in `rpcallowip` and the node's firewall.
   Their addresses change per machine, so allow the Fly organisation's 6PN prefix (check it with
   `fly ips private` on the coordinator apps) rather than single addresses.
5. Restart `bitcoind` at a quiet time. `edgecoder-lnd` loses its chain backend for the restart; schedule
   it and watch LND reconnect.
6. Give the owner a receive address from the new wallet (`getnewaddress`, run by the operator).

From the owner:

1. Fund the anchoring wallet (about 200 000 sats) from a source of the owner's choosing, not from
   `edgecoder-lnd` (its balance is reported as customer reserves).
2. Approve setting these as Fly secrets on both coordinator apps (`seed`, `seed-eu`); secrets need no
   change to `fly.toml`, but setting them restarts the machines:

   | Secret | Value |
   | --- | --- |
   | `BITCOIN_ANCHOR_PROVIDER` | `bitcoind` |
   | `BITCOIND_RPC_URL` | `http://[fdaa:ec:ae3e:a7b:9016:7eba:d6ac:1b02]:8332` |
   | `BITCOIND_RPC_USER` | `edgecoder-anchor` |
   | `BITCOIND_RPC_PASSWORD` | from step 2 above |
   | `BITCOIND_WALLET_NAME` | `edgecoder-anchor` |
   | `BITCOIN_ANCHOR_MAINNET` | `1` (mainnet broadcasts are refused without it) |
   | `BITCOIN_ANCHOR_MAX_FEE_SATS` | `5000` |
   | `BITCOIN_ANCHOR_DAILY_BUDGET_SATS` | `30000` |
   | `STATS_ANCHOR_INTERVAL_MS` | `21600000` |
   | `ANCHOR_INTERVAL_MS` | `86400000` |

3. After the restart, check: `GET /stats/anchors/verify?checkpointHash=...` (mesh token) reports
   `anchoring.mode: "enabled"`; within 6 hours a `pending` row with a real txid appears, `anchored` at 6
   confirmations; `/reserves` shows the anchor transaction.

Rollback: unset `BITCOIN_ANCHOR_PROVIDER`. Nothing else depends on anchoring being on.
