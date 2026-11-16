// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent diagnostics, subtask dependencies, the robot queue, work receipts and the
 * discovery announcer.
 */
import { RobotQueue } from "../robot-queue.js";
import { startCoordinatorAnnouncer } from "../../discovery/announce.js";
import type { KeyCustodyEvent } from "../../common/types.js";
import { pgStore } from "../../db/store.js";
import type { ComputeClassId } from "../../economy/compute-classes.js";
import { MemoryReceiptStore, type ReceiptStore } from "../../receipts/store.js";
import { issueReceiptForAccrual } from "../../receipts/issue.js";
import type { SignedAgentReceiptClaim } from "../../receipts/receipt.js";
import type { ExecutionResult } from "../verification.js";
import { SubtaskDepTracker } from "../subtask-deps.js";
import { app } from "./app.js";
import {
  ROBOT_QUEUE_ENABLED,
  ROBOT_COORDINATOR_FEE_BPS,
  ROBOT_TASK_DEFAULT_TIMEOUT_MS,
  ROBOT_AUTO_SETTLE_DELAY_MS,
  ROBOT_SWEEP_INTERVAL_MS,
  ROBOT_MIN_SWEEP_SATS,
  BITCOIN_NETWORK,
  type ResultMeta,
  identity,
  coordinatorKeys,
  COORDINATOR_PUBLIC_URL,
  CC
} from "./context.js";
import { agentCapabilities } from "./agent-state.js";
import { latestPriceEpochByResource } from "./economy.js";

export const keyCustodyEvents: KeyCustodyEvent[] = [];

export const diagnosticsByAgentId = new Map<string, Array<{ eventAtMs: number; message: string }>>();
export function appendAgentDiagnostic(agentId: string, message: string, eventAtMs = Date.now()): void {
  const text = String(message ?? "").trim();
  if (!text) return;
  const existing = diagnosticsByAgentId.get(agentId) ?? [];
  const merged = [...existing, { eventAtMs: Number(eventAtMs || Date.now()), message: text }].slice(-250);
  diagnosticsByAgentId.set(agentId, merged);
}

// ── Subtask dependency tracking ─────────────────────────────────────────────
export const depTracker = new SubtaskDepTracker();

export const robotQueue = ROBOT_QUEUE_ENABLED
  ? new RobotQueue({
      coordinatorFeeBps: ROBOT_COORDINATOR_FEE_BPS,
      defaultTimeoutMs: ROBOT_TASK_DEFAULT_TIMEOUT_MS,
      autoSettleDelayMs: ROBOT_AUTO_SETTLE_DELAY_MS,
      sweepIntervalMs: ROBOT_SWEEP_INTERVAL_MS,
      minSweepSats: ROBOT_MIN_SWEEP_SATS,
      bitcoinNetwork: BITCOIN_NETWORK
    })
  : null;

// ── Work receipts (architecture step 2): store, routes, epoch close + anchor, peer replication ──
// Receipts are issued in accrueResultCredits (recordWorkReceipt); everything else lives in src/receipts.
export const receiptStore: ReceiptStore = pgStore ? pgStore.receiptStore() : new MemoryReceiptStore();

/**
 * `computeClass` is the class the credits were valued in (cpu | apple | gpu | gpu.dc) and
 * `msatPerCredit` the price locked on the earn row. Receipts issued before the four-class model
 * carry the resource class ("cpu" / "gpu") and the legacy price-epoch rate; they verify unchanged
 * because the field is a free string inside the signed body.
 */
export async function recordWorkReceipt(r: ExecutionResult<ResultMeta>, credits: number, computeClass: ComputeClassId, msatPerCredit: number | undefined): Promise<void> {
  const resourceClass = r.meta.subtask.projectMeta.resourceClass;
  const legacyMsat = (latestPriceEpochByResource.get(resourceClass)?.pricePerComputeUnitSats ?? 30) * 1000;
  const outcome = issueReceiptForAccrual({
    claim: (r.meta.report as { receipt?: SignedAgentReceiptClaim }).receipt,
    result: { taskId: r.meta.taskId, subtaskId: r.subtaskId, agentId: r.agentId, output: r.output },
    registeredAgentPublicKeyPem: agentCapabilities.get(r.agentId)?.publicKeyPem,
    coordinator: { coordinatorId: identity.peerId, publicKeyPem: identity.publicKeyPem, privateKeyPem: coordinatorKeys.privateKeyPem },
    computeClass,
    credits,
    msatPerCredit: msatPerCredit ?? legacyMsat
  });
  if (!outcome.receipt) {
    app.log.debug({ subtaskId: r.subtaskId, agentId: r.agentId, reason: outcome.skipped }, "work_receipt_skipped");
    return;
  }
  await receiptStore.append(outcome.receipt);
  app.log.info({ receiptId: outcome.receipt.receiptId, subtaskId: r.subtaskId, agentId: r.agentId }, "work_receipt_issued");
}

// ── end work receipts ──
// Architecture step 3: signed self-announcement + Nostr announcer (EDGECODER_NOSTR_ANNOUNCE=1), see docs/discovery.md.
export const discoveryAnnouncer = startCoordinatorAnnouncer({ identity: coordinatorKeys, url: COORDINATOR_PUBLIC_URL, services: ["swarm", "mesh", "economy"], enabled: CC.EDGECODER_NOSTR_ANNOUNCE, log: (msg, meta) => app.log.info(meta ?? {}, msg) });
