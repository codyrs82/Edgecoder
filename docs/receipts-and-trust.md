# Work receipts and pinned-key trust

Architecture steps 2 and 4. Code lives in `src/receipts/` (receipts, epochs, replication) and
`src/trust/pinned-keys.ts` (agent-side trust); the coordinator wires them in a single block in
`src/swarm/coordinator.ts` ("Work receipts") and in `accrueResultCredits`.

## What a receipt proves

A `WorkReceipt` is a two-party, offline-verifiable statement that **agent A executed subtask S
and coordinator C credited A with N credits (worth M msat at the time) for it**:

| Field | Set by | Meaning |
|---|---|---|
| `taskId`, `subtaskId`, `agentId`, `agentPublicKeyPem` | agent | what was executed and by whom |
| `startedAtMs`, `finishedAtMs` | agent | wall-clock window of the execution |
| `resultHash` | agent | sha256 of the result output the agent reported |
| `agentSignature` | agent | Ed25519 over the canonical agent claim (the fields above) |
| `coordinatorId`, `coordinatorPublicKeyPem` | coordinator | who credited the work |
| `computeClass`, `credits`, `msat`, `msatPerCredit` | coordinator | what was credited and the price epoch it was valued at |
| `coordinatorSignature` | coordinator | Ed25519 over every field above (agent signature included) |
| `receiptId` | derived | sha256 of the coordinator-signed body; the same receipt always has the same id |

Flow:

1. The agent posts its result with a `receipt` field: the claim signed with its registered key
   (`signReceiptAsAgent` in `worker-runner.ts`). It cannot know the credits yet.
2. After the accrual succeeds (the `earnings_accrual` ordering record), the coordinator checks the
   claim against what it actually credited (same task/subtask/agent, `resultHash` matches the
   output, key matches the agent's registered key, signature valid), fills in the economic fields
   and countersigns (`issueReceiptForAccrual` -> `countersignAsCoordinator`). Results that carry
   no claim, or a claim that does not match, are still paid but get no receipt (logged as
   `work_receipt_skipped`).
3. The receipt is stored (`work_receipts` in Postgres, memory otherwise) and replicated to peers.

Canonical serialization is JSON with sorted keys and no whitespace; PEM keys are normalized
(CRLF folded, trimmed) before hashing. `verifyReceipt` checks shape, the derived `receiptId`,
then the agent and the coordinator signatures.

What a receipt does **not** prove: that the output was correct (that is the result
verification pipeline, #50), or that the credits were later paid out.

## Epochs and Bitcoin anchoring

Every `RECEIPT_EPOCH_MS` (default 1 h) the coordinator closes an epoch (`closeEpoch`):

- all of its own receipts not yet in an epoch and finished before the close instant (late
  receipts from before the previous close are swept into the next epoch, never lost);
- leaves are `sha256(canonicalReceipt)`, sorted and deduplicated; interior nodes are
  `sha256(0x01 || left || right)`, an odd node is paired with itself;
- the epoch body `{coordinatorId, fromMs, toMs, count, merkleRoot, previousRoot, closedAtMs}` is
  signed by the coordinator; `epochId = sha256(body)`; `previousRoot` chains epochs.

No empty epochs are closed. When a Bitcoin anchor provider is configured
(`BITCOIN_ANCHOR_PROVIDER`), the root is written as an `EC` OP_RETURN through the same path the
stats checkpoints use (`anchorCheckpoint`: one broadcast per root, daily budget, mainnet opt-in,
crash-safe `broadcasting` row). The anchor record's `epoch_id` is `receipts:<epochId>` and its
`checkpoint_hash` is the Merkle root; the txid is stored on the epoch (`receipt_epochs.anchor_tx_ref`).

## Verifying a receipt against an anchored root

Given a receipt R and the coordinator's `GET /receipts/:receiptId` response (needs the mesh token):

```ts
import { verifyReceipt, verifyMerkleProof, receiptLeafHash } from "./src/receipts/receipt.js";
import { verifyEpochSignature } from "./src/receipts/epochs.js";
import { decodeOpReturnCheckpoint } from "./src/economy/bitcoin-rpc.js";

const { receipt, proof } = await (await fetch(`${coordinator}/receipts/${id}`, { headers })).json();
const { epoch } = await (await fetch(`${coordinator}/receipts/epochs/latest`, { headers })).json(); // or the epoch proof.epochId names

verifyReceipt(receipt);                                        // { ok: true }
receiptLeafHash(receipt) === proof.leaf;                       // the leaf is this exact receipt
verifyMerkleProof(proof.leaf, proof.proof, proof.merkleRoot);  // true: it is in the epoch tree
verifyEpochSignature(epoch, receipt.coordinatorPublicKeyPem);  // the coordinator signed that root
// On chain: fetch the tx `proof.anchorTxRef`, find its OP_RETURN output and check
decodeOpReturnCheckpoint(opReturnHex).checkpointHash === proof.merkleRoot;
```

Once the anchoring transaction is confirmed, the receipt (and so the credit) demonstrably existed
before that block, and neither party can change it without breaking a signature, the leaf hash,
the root, or the on-chain commitment.

## Replication between coordinators

Receipts survive the coordinator that issued them:

- `GET /receipts/since?cursor=&limit=`: a page of receipts in storage order, signed by the serving
  coordinator (`receiptPageSigningPayload`); `nextCursor` is passed back to continue.
- `POST /receipts/replicate {receipts}`: push path, same validation.
- `startReceiptReplication` pulls from every approved mesh peer every `RECEIPT_REPLICATION_MS`.

Before a replicated receipt is stored, its page signature is checked against the peer's mesh key,
`verifyReceipt` must pass, and `coordinatorPublicKeyPem` must equal the key the mesh knows for
`coordinatorId` (`coordinator_key_mismatch` / `coordinator_unknown` otherwise). Storage is
idempotent by `receiptId`. All `/receipts/*` routes require the mesh token.

## Agent trust: pinned coordinator keys

An agent only works for coordinators whose Ed25519 key it trusts. Keys are identified by
`peerId:fingerprint`, where the fingerprint is the sha256 of the key's SPKI DER encoding
(`src/security/key-fingerprint.ts`, the one fingerprint used by agent pins, `MESH_PEER_ALLOWLIST`
and discovery pins). `GET /identity` reports it as `fingerprint` and the ready-made `trustEntry`.
Pins written by older builds (sha256 of the PEM text) still match, and are listed as
`legacyFingerprints`; newly pinned keys are written in the DER form.

| `EDGECODER_TRUST_MODE` | Unknown coordinator id | Known id, same key | Known id, different key |
|---|---|---|---|
| `tofu` (default) | trusted and pinned to the trust file | trusted | **refused** |
| `strict` | **refused** | trusted | **refused** |
| `open` | trusted | trusted | trusted (mismatch logged) |

- `TRUSTED_COORDINATOR_KEYS=peerId:fp,peerId2:fp2` are static pins and win over the file.
- `EDGECODER_TRUST_FILE` (default `<config dir>/trusted-coordinators`) holds one entry per line;
  in `tofu` mode first-seen keys are appended with a timestamp comment.

Before registering with a coordinator URL the worker proves the coordinator holds its key: it
sends a fresh nonce and the URL it is using to `POST /identity/challenge`, and the coordinator
signs the nonce, that URL, its own public URL and its peerId with its Ed25519 identity key
(`src/trust/identity-challenge.ts`). The worker checks the signature against the key, then runs
the key through the store (`CoordinatorTrustGate`); nothing is pinned until the signature checks
out. A replayed `/identity` therefore no longer passes. The verification lasts
`EDGECODER_TRUST_REVERIFY_MS` (default 10 min) and is redone on every URL change (steering,
discovery, failover) and on reconnect; register, heartbeat, pull and mesh calls are refused for a
URL that is not verified. A coordinator without the route (older builds answer 404 or 401) is
refused when the challenge is required (`EDGECODER_IDENTITY_CHALLENGE=required`, the default in
strict mode); otherwise the worker warns and falls back to the public `GET /identity`. A
mismatch for a known id (possible impersonation) is logged and the agent exits with status 1. A
coordinator that is merely unlisted in strict mode is refused and the agent backs off and fails
over to another; a transport failure (identity unreachable) goes through the same path. In strict
mode discovery also drops announced coordinators whose key is not listed, and strict mode with no
keys listed at all is a startup error. Switch-over steps: [going-to-mainnet.md](going-to-mainnet.md).

To rotate a coordinator key, publish the new fingerprint to operators and either add it to
`TRUSTED_COORDINATOR_KEYS` or edit the trust file; tofu agents will not accept it silently.
