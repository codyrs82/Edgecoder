// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// An outside coordinator's side of the ledger service (protocol.ts): its money calls go to
// LEDGER_SERVICE_URL (EdgeCoder's seeds) instead of its own database, each signed with its own
// coordinator key. credits/store.ts routes reserveTaskCredits, accruePricedJobWithOverflow and the
// task refund here once setRemoteLedger() installed a client; everything else the coordinator keeps
// (queue, receipts, usage) stays in its own store.

import { signPeerRequest } from "../mesh/peer-trust.js";
import { LEDGER_SERVICE_PATHS, type BuyerProof, type SettleResponse } from "./protocol.js";
import type { SignedAgentReceiptClaim } from "../receipts/receipt.js";

export interface LedgerClientOptions {
  baseUrl: string;
  peerId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** A refusal from the ledger service, with its HTTP status and error code. */
export class LedgerServiceError extends Error {
  constructor(readonly status: number, readonly error: string, readonly body: Record<string, unknown> = {}) {
    super(`ledger_service_${status}: ${error}`);
    this.name = "LedgerServiceError";
  }
}

export class LedgerServiceClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: LedgerClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.base;
  }

  private async call(path: string, body: unknown): Promise<Record<string, unknown>> {
    const url = `${this.base}${path}`;
    const text = JSON.stringify(body);
    const headers = {
      "content-type": "application/json",
      ...signPeerRequest({ peerId: this.opts.peerId, privateKeyPem: this.opts.privateKeyPem, publicKeyPem: this.opts.publicKeyPem, method: "POST", url, body: text })
    };
    const res = await this.fetchImpl(url, { method: "POST", headers, body: text, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000) });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new LedgerServiceError(res.status, typeof parsed.error === "string" ? parsed.error : `http_${res.status}`, parsed);
    return parsed;
  }

  /** Set aside msat for a task. Throws LedgerServiceError (402 insufficient_credits, 409 duplicate_task / duplicate_reserve, ...). */
  async reserve(input: {
    taskId: string;
    accountId: string;
    kind: "inference" | "job";
    msat: number;
    idempotencyKey: string;
    perSubtaskReserveMsat?: number;
    overflowCapMsat?: number;
    buyerProof?: BuyerProof | null;
  }): Promise<{ status: "inserted" | "same" }> {
    const { buyerProof, ...rest } = input;
    const overflowCapMsat = rest.overflowCapMsat !== undefined && Number.isFinite(rest.overflowCapMsat) ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(rest.overflowCapMsat)) : undefined;
    const r = await this.call(LEDGER_SERVICE_PATHS.reserve, { ...rest, msat: Math.round(rest.msat), ...(overflowCapMsat !== undefined ? { overflowCapMsat } : {}), ...(buyerProof ? { buyerProof } : {}) });
    return { status: r.status === "inserted" ? "inserted" : "same" };
  }

  async settle(input: {
    taskId: string;
    subtaskId: string;
    agentId: string;
    hostAccountId: string;
    baseCostMsat: number;
    overflowWantMsat: number;
    resourceClass: "cpu" | "gpu";
    durationMs: number;
    success: boolean;
    receipt?: SignedAgentReceiptClaim;
  }): Promise<SettleResponse> {
    return (await this.call(LEDGER_SERVICE_PATHS.settle, { ...input, baseCostMsat: Math.max(0, Math.round(input.baseCostMsat)), overflowWantMsat: Math.max(0, Math.floor(input.overflowWantMsat)) })) as unknown as SettleResponse;
  }

  async refund(taskId: string): Promise<{ status: string; refundMsat: number }> {
    const r = await this.call(LEDGER_SERVICE_PATHS.refund, { taskId });
    return { status: String(r.status), refundMsat: Number(r.refundMsat ?? 0) };
  }

  async hasBalance(accountId: string, atLeastMsat: number, buyerProof?: BuyerProof | null): Promise<boolean> {
    const r = await this.call(LEDGER_SERVICE_PATHS.balance, { accountId, atLeastMsat: Math.max(0, Math.ceil(atLeastMsat)), ...(buyerProof ? { buyerProof } : {}) });
    return r.enough === true;
  }
}

/**
 * Where an outside coordinator bills (null: its own database, as the seeds do). LEDGER_SERVICE_URL
 * when set; in production a coordinator with no DATABASE_URL has no billing of its own and bills
 * through the platform URL.
 */
export function ledgerServiceUrlFromEnv(env: { LEDGER_SERVICE_URL?: string; DATABASE_URL?: string; NODE_ENV?: string }): string | null {
  const url = env.LEDGER_SERVICE_URL?.trim();
  if (url) return url;
  if (!env.DATABASE_URL?.trim() && env.NODE_ENV === "production") return "https://coordinator.edgecoder.io";
  return null;
}
