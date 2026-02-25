import type { BitcoinNetwork } from "../common/types.js";

export type RobotTaskKind = "physical" | "compute" | "hybrid";

export type RobotTaskStatus =
  | "pending_funding"
  | "funded"
  | "claimed"
  | "proof_submitted"
  | "settled"
  | "disputed"
  | "expired";

export interface RobotTask {
  taskId: string;
  clientAccountId: string;
  title: string;
  description: string;
  taskKind: RobotTaskKind;
  resourceRequirements: string[];
  escrowSats: number;
  rewardSats: number;
  coordinatorFeeSats: number;
  coordinatorFeeBps: number;
  status: RobotTaskStatus;
  timeoutMs: number;
  proofSchema?: Record<string, unknown>;
  invoiceRef: string;
  claimedBy?: string;
  claimedAtMs?: number;
  proofPayload?: unknown;
  proofSubmittedAtMs?: number;
  disputeReason?: string;
  createdAtMs: number;
  settledAtMs?: number;
}

export interface RobotAgent {
  agentId: string;
  payoutAddress: string;
  capabilities: string[];
  robotKind: string;
  lastSeenMs: number;
  successCount: number;
  failureCount: number;
}

export interface RobotEarningsEntry {
  entryId: string;
  agentId: string;
  taskId: string;
  earnedSats: number;
  status: "accrued" | "swept";
  sweepTxId?: string;
  createdAtMs: number;
}

export interface RobotSweepPayout {
  agentId: string;
  address: string;
  amountSats: number;
}

export interface RobotSweepEvent {
  sweepId: string;
  txid: string;
  totalSats: number;
  feesSats: number;
  payouts: RobotSweepPayout[];
  broadcastAtMs: number;
  confirmedAtMs?: number;
}

export interface RobotQueueConfig {
  coordinatorFeeBps: number;
  defaultTimeoutMs: number;
  autoSettleDelayMs: number;
  sweepIntervalMs: number;
  minSweepSats: number;
  bitcoinNetwork: BitcoinNetwork;
}
