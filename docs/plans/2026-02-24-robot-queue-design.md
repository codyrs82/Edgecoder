# Robot Work Marketplace — Design

## Overview

A separate queue system for autonomous physical robots (IoT devices, drones, rovers, industrial arms) to participate in an open marketplace. Anyone can post bitcoin-funded tasks; robots claim, complete, and submit proof; earnings settle via batched onchain payouts. Pure satoshis — no credits.

## Principles

- **Bitcoin-only:** No credit system involvement. Clients fund in BTC, robots earn BTC.
- **Separate from swarm:** Independent queue, types, routes, and ledger. Does not touch `SwarmQueue`.
- **Global participation:** Any robot with a valid onchain payout address can join.
- **Escrow model:** Client funds are held in the coordinator's Lightning wallet until settlement.
- **Batched payouts:** Onchain sweep to robot addresses on a schedule (default 24h).

---

## Data Model

### RobotTask

A funded job posted by a client.

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | `string` | UUID |
| `clientAccountId` | `string` | Portal account that funded the task |
| `title` | `string` | Short description |
| `description` | `string` | Full task details |
| `taskKind` | `"physical" \| "compute" \| "hybrid"` | Determines proof requirements |
| `resourceRequirements` | `string[]` | Capability tags: `"camera"`, `"gps"`, `"arm"`, `"gpu"` |
| `escrowSats` | `number` | Total sats client funded |
| `rewardSats` | `number` | Sats the robot earns (escrow minus fee) |
| `coordinatorFeeSats` | `number` | Coordinator's cut |
| `coordinatorFeeBps` | `number` | Fee rate at time of creation |
| `status` | `RobotTaskStatus` | See lifecycle below |
| `timeoutMs` | `number` | Max time to complete after claim |
| `proofSchema` | `object \| undefined` | Optional JSON schema for proof validation |
| `invoiceRef` | `string` | Lightning invoice for escrow funding |
| `claimedBy` | `string \| undefined` | Robot agent ID |
| `claimedAtMs` | `number \| undefined` | When claimed |
| `proofPayload` | `unknown \| undefined` | Submitted proof data |
| `proofSubmittedAtMs` | `number \| undefined` | When proof submitted |
| `disputeReason` | `string \| undefined` | Client dispute reason |
| `createdAtMs` | `number` | |
| `settledAtMs` | `number \| undefined` | |

**RobotTaskStatus:** `"pending_funding"` → `"funded"` → `"claimed"` → `"proof_submitted"` → `"settled"` | `"disputed"` | `"expired"`

### RobotAgent

Extends agent identity with robot-specific fields.

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `string` | Same as swarm agent ID |
| `payoutAddress` | `string` | Onchain BTC address (validated) |
| `capabilities` | `string[]` | Tags: `["camera", "gps", "arm", "gpu"]` |
| `robotKind` | `string` | Free-form: `"rover"`, `"drone"`, `"industrial-arm"` |
| `lastSeenMs` | `number` | Last heartbeat |
| `successCount` | `number` | Completed tasks |
| `failureCount` | `number` | Expired/failed tasks |

### RobotEarningsEntry

Per-task earning record in the satoshi ledger.

| Field | Type | Description |
|-------|------|-------------|
| `entryId` | `string` | UUID |
| `agentId` | `string` | Robot that earned |
| `taskId` | `string` | Completed task |
| `earnedSats` | `number` | Sats earned |
| `status` | `"accrued" \| "swept"` | Payout status |
| `sweepTxId` | `string \| undefined` | Set when paid out |
| `createdAtMs` | `number` | |

### RobotSweepEvent

A batched onchain payout transaction.

| Field | Type | Description |
|-------|------|-------------|
| `sweepId` | `string` | UUID |
| `txid` | `string` | Bitcoin transaction ID |
| `totalSats` | `number` | Sum of all outputs |
| `feesSats` | `number` | Onchain tx fee |
| `payouts` | `Array<{ agentId, address, amountSats }>` | Per-robot outputs |
| `broadcastAtMs` | `number` | |
| `confirmedAtMs` | `number \| undefined` | |

---

## Task Lifecycle

### 1. Client funds a task (`POST /robot/tasks`)

- Client submits task details + `amountSats`
- Coordinator computes fee via `computeIntentFee(amountSats, ROBOT_COORDINATOR_FEE_BPS)`
- Creates Lightning invoice for escrow via `lightningProvider.createInvoice()`
- Returns invoice + taskId with status `"pending_funding"`
- When payment settles (webhook/reconcile), status → `"funded"`

### 2. Robot claims a task (`POST /robot/tasks/:taskId/claim`)

- Robot must be registered with payout address + matching capabilities
- Coordinator checks capability tags against `resourceRequirements`
- First valid robot wins (bounty model, not fair-share)
- Status → `"claimed"`, timeout clock starts

### 3. Robot submits proof (`POST /robot/tasks/:taskId/proof`)

- Robot uploads proof payload (sensor data, image refs, GPS, compute output)
- Validated against `proofSchema` if provided
- Status → `"proof_submitted"`

### 4. Task settles (`POST /robot/tasks/:taskId/settle`)

- Client accepts proof, OR auto-settle after 24h review window with no dispute
- `rewardSats` added to robot's earnings ledger as `"accrued"`
- Coordinator fee recorded
- Status → `"settled"`

### 5. Batched sweep (scheduled)

- Runs every `ROBOT_SWEEP_INTERVAL_MS` (default 24h)
- Aggregates `"accrued"` entries per robot, groups by payout address
- Skips robots below `ROBOT_MIN_SWEEP_SATS` (default 10,000 sats) — rolls to next sweep
- Builds single onchain tx with multiple outputs via `BitcoindRpcProvider`
- Marks ledger entries `"swept"` with `sweepTxId`

### Timeout & dispute paths

- Robot doesn't submit proof within `timeoutMs` → `"expired"`, escrow refunded to client as credits
- Client disputes proof → `"disputed"`, held for manual admin resolution (v1)

---

## Module Structure

### New files

| File | Purpose |
|------|---------|
| `src/swarm/robot-types.ts` | Type definitions |
| `src/swarm/robot-queue.ts` | `RobotQueue` class: task store, claim/proof/settle, earnings ledger, sweep scheduler |
| `src/swarm/robot-routes.ts` | Route registration: `registerRobotRoutes(app, robotQueue)` |

### API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/robot/agents/register` | mesh token | Register with payout address + capabilities |
| `POST` | `/robot/agents/heartbeat` | mesh token | Heartbeat, capability updates |
| `POST` | `/robot/tasks` | portal service token | Client creates + funds a task |
| `GET` | `/robot/tasks/available` | mesh token | List claimable tasks matching capabilities |
| `POST` | `/robot/tasks/:taskId/claim` | mesh token + agent sig | Claim a task |
| `POST` | `/robot/tasks/:taskId/proof` | mesh token + agent sig | Submit proof |
| `POST` | `/robot/tasks/:taskId/settle` | portal service token | Client accepts proof |
| `POST` | `/robot/tasks/:taskId/dispute` | portal service token | Client disputes proof |
| `GET` | `/robot/tasks/:taskId` | mesh token or portal | Task status |
| `GET` | `/robot/agents/:agentId/earnings` | mesh token | Earnings summary |
| `POST` | `/robot/sweep` | internal/admin | Manual sweep trigger |

### Coordinator.ts changes (minimal)

```typescript
import { RobotQueue } from "./robot-queue.js";
import { registerRobotRoutes } from "./robot-routes.js";

const robotQueue = new RobotQueue({ pgStore, bitcoinProvider, lightningProvider });
registerRobotRoutes(app, robotQueue);
```

---

## Escrow, Fees & Sweep

**Escrow:** Coordinator's Lightning wallet holds funded sats. No new custodial infrastructure.

**Fees:**
- `ROBOT_COORDINATOR_FEE_BPS` env var, default `200` (2%)
- Reuses `computeIntentFee` from `coordinator-utils.ts`

**Sweep scheduler:**
- Interval: `ROBOT_SWEEP_INTERVAL_MS` (default `86400000` — 24h)
- Min payout: `ROBOT_MIN_SWEEP_SATS` (default `10000`)
- One tx, multiple outputs via `BitcoindRpcProvider`
- Rolls over sub-threshold balances

**Refunds:**
- Expired/disputed tasks: escrow returned to client as credits via `adjustCredits`

**Address validation:**
- On registration, validate format (P2PKH, P2SH, P2WPKH, P2WSH, P2TR) against `BITCOIN_NETWORK`
- Reject mismatched network addresses

---

## Testing Strategy

- **`robot-types.ts`**: No tests needed (pure type definitions)
- **`robot-queue.ts`**: Unit tests for claim logic, proof validation, earnings accrual, sweep aggregation, timeout expiry, duplicate claim prevention
- **`robot-routes.ts`**: Tests for route auth guards, request validation, error responses (using extracted helper pattern — no `app.inject()`)
- Reuse `computeIntentFee` tests from `coordinator-utils.test.ts`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROBOT_COORDINATOR_FEE_BPS` | `[env-configured]` | Fee rate for robot tasks (basis points) |
| `ROBOT_SWEEP_INTERVAL_MS` | `[env-configured]` | Sweep payout interval |
| `ROBOT_MIN_SWEEP_SATS` | `[env-configured]` | Minimum accrued sats before sweep |
| `ROBOT_TASK_DEFAULT_TIMEOUT_MS` | `[env-configured]` | Default task timeout |
| `ROBOT_AUTO_SETTLE_DELAY_MS` | `[env-configured]` | Auto-settle window if client doesn't dispute |
| `ROBOT_QUEUE_ENABLED` | `false` | Feature flag to enable robot routes |
