// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// EdgeCoder's ledger service (docs/discovery.md, "Billing for outside coordinators"; phase 4 of the
// outside-coordinator plan, option B1). The seeds hold the shared Postgres ledger and serve these
// routes; an outside coordinator that has no billing database of its own reserves, settles and
// refunds its network calls here, signed with its own coordinator key (src/mesh/peer-trust.ts
// signPeerRequest), and never holds a balance or a database credential. EdgeCoder keeps the buyers'
// balances, credits hosts and pays them from its own Lightning node as before, and splits each
// call's network fee: the routing coordinator's operator gets LEDGER_SERVICE_ROUTING_SHARE_BPS of it
// (default 4000 = 40 %, 2 % of a call at a 5 % fee) as its own earn row, payable like host earnings.
//
//   POST /ledger/v1/reserve   set aside msat from a buyer for one task (or top it up)
//   POST /ledger/v1/settle    charge one execution's cost: host earning, fee pool, routing share
//   POST /ledger/v1/refund    close the task: what it set aside and did not use goes back
//   POST /ledger/v1/balance   admission only: does the buyer hold at least this much

import { z } from "zod";
import { agentReceiptClaimSchema } from "../receipts/issue.js";
import { PORTAL_ACCOUNT_HEADER, PORTAL_REQUEST_HEADERS } from "../security/service-request-signing.js";

export const LEDGER_SERVICE_PATHS = {
  reserve: "/ledger/v1/reserve",
  settle: "/ledger/v1/settle",
  refund: "/ledger/v1/refund",
  balance: "/ledger/v1/balance"
} as const;

export const LEDGER_SERVICE_PREFIX = "/ledger/v1/";

/** Reason of the routing coordinator operator's earn row (related_task_id = the task). */
export const ROUTING_FEE_REASON_PREFIX = "routing_fee:";

/** Credit account of a registry member's operator (portal user id), as the portal names accounts. */
export function operatorAccountId(operatorUserId: string): string {
  return `acct-${operatorUserId}`;
}

/**
 * The routing coordinator's share of one call's network fee: `shareBps` of it, rounded down to a
 * whole msat; EdgeCoder's fee pool keeps the rest.
 */
export function splitRoutingFee(feeMsat: number, shareBps: number): { routingMsat: number; poolMsat: number } {
  const fee = Math.max(0, Math.round(feeMsat));
  const bps = Math.max(0, Math.min(10_000, Math.round(shareBps)));
  const routingMsat = Math.floor((fee * bps) / 10_000);
  return { routingMsat, poolMsat: fee - routingMsat };
}

/**
 * Proof that the buyer asked for this call: the portal's signature on the request the outside
 * coordinator received (src/security/service-request-signing.ts), forwarded as it came. It names
 * the account, is made for that coordinator's origin and is single-use.
 */
export const buyerProofSchema = z.object({
  method: z.string().min(1).max(16),
  /** Path plus query string as the coordinator received it. */
  path: z.string().min(1).max(2048),
  headers: z.object({
    [PORTAL_REQUEST_HEADERS.aud]: z.string().max(512),
    [PORTAL_REQUEST_HEADERS.ts]: z.string().max(32),
    [PORTAL_REQUEST_HEADERS.nonce]: z.string().max(128),
    [PORTAL_REQUEST_HEADERS.body]: z.string().max(128),
    [PORTAL_REQUEST_HEADERS.sig]: z.string().max(512),
    [PORTAL_ACCOUNT_HEADER]: z.string().max(256).optional()
  })
});
export type BuyerProof = z.infer<typeof buyerProofSchema>;

/** The portal-signature headers of an inbound request, as a buyer proof (null when it has none). */
export function buyerProofFrom(req: { method: string; url: string; headers: Record<string, unknown> }): BuyerProof | null {
  const h = (k: string): string | undefined => {
    const v = req.headers[k];
    return typeof v === "string" ? v : Array.isArray(v) && v.length > 0 ? String(v[0]) : undefined;
  };
  const sig = h(PORTAL_REQUEST_HEADERS.sig);
  const aud = h(PORTAL_REQUEST_HEADERS.aud);
  const ts = h(PORTAL_REQUEST_HEADERS.ts);
  const nonce = h(PORTAL_REQUEST_HEADERS.nonce);
  const body = h(PORTAL_REQUEST_HEADERS.body);
  if (!sig || !aud || !ts || !nonce || !body) return null;
  const account = h(PORTAL_ACCOUNT_HEADER);
  return {
    method: req.method.toUpperCase(),
    path: req.url,
    headers: {
      [PORTAL_REQUEST_HEADERS.aud]: aud,
      [PORTAL_REQUEST_HEADERS.ts]: ts,
      [PORTAL_REQUEST_HEADERS.nonce]: nonce,
      [PORTAL_REQUEST_HEADERS.body]: body,
      [PORTAL_REQUEST_HEADERS.sig]: sig,
      ...(account !== undefined ? { [PORTAL_ACCOUNT_HEADER]: account } : {})
    }
  };
}

const id = z.string().min(1).max(256);
const msat = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const reserveRequestSchema = z.object({
  taskId: id,
  accountId: id,
  kind: z.enum(["inference", "job"]),
  /** What to set aside now (the reserve, or a top-up of this coordinator's own open task). */
  msat: msat.refine((n) => n > 0, "msat must be positive"),
  /** One key per charge (the reserve, each top-up); it must name the task. A key already charged takes nothing. */
  idempotencyKey: z.string().min(1).max(512),
  perSubtaskReserveMsat: msat.optional(),
  /** The most the task's cost may reach with the overflow past its reserve (the buyer's ceiling). */
  overflowCapMsat: msat.optional(),
  /** Required for a new task; a top-up of an open task of this coordinator needs none. */
  buyerProof: buyerProofSchema.optional()
});
export type ReserveRequest = z.infer<typeof reserveRequestSchema>;

export const settleRequestSchema = z.object({
  taskId: id,
  /** The executed subtask: the one report (result:<subtaskId>) and the one charge for it. */
  subtaskId: id,
  agentId: id,
  /** The host's EdgeCoder account, credited with its earning. */
  hostAccountId: id,
  /** Cost taken from the task's reserve. */
  baseCostMsat: msat,
  /** Cost past the reserve, taken from the buyer's balance up to the task's cost cap. */
  overflowWantMsat: msat.default(0),
  resourceClass: z.enum(["cpu", "gpu"]),
  durationMs: z.number().nonnegative().max(86_400_000),
  success: z.boolean(),
  /** The agent's signed work claim for this subtask (src/receipts/receipt.ts). Required. */
  receipt: agentReceiptClaimSchema.optional()
});
export type SettleRequest = z.infer<typeof settleRequestSchema>;

export const refundRequestSchema = z.object({ taskId: id });

export const balanceRequestSchema = z.object({
  accountId: id,
  atLeastMsat: msat,
  buyerProof: buyerProofSchema.optional()
});

export interface SettleResponse {
  status: "settled" | "duplicate";
  costMsat?: number;
  coveredMsat?: number;
  agentMsat?: number;
  /** The whole network fee (EdgeCoder's pool plus the routing share). */
  feeMsat?: number;
  routingFeeMsat?: number;
  credits?: number;
  receiptId?: string;
}
