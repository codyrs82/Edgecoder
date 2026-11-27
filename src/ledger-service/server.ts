// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// The seeds' side of the ledger service (protocol.ts). Every call is a signed peer request by the
// caller's own coordinator key; the caller must be a community member of the verified signed
// registry, `active` (past probation), with billing approved by the owner (`billingEnabled`), and
// not suspended here. The money moves through the same Postgres functions as a seed's own billing
// (PostgresStore.ledgerServiceReserve / ledgerServiceSettle / ledgerServiceRefund), so the advisory
// locks, the tx-id dedupe, the overflow settle and /ledger/verify all hold as they do for the seeds.
//
// Limits on one outside coordinator:
// - caps on its open reserves (count and msat) and on msat reserved per hour (LEDGER_SERVICE_MAX_*);
// - a reported cost is never more than the task's reserve plus the overflow its cost cap allows;
// - every settle carries the agent's signed work claim for that subtask;
// - an anomaly (a settle without a valid claim, a cost over the cap, a claim or host that does not
//   match what the shared database knows, touching another coordinator's task) suspends billing for
//   that coordinator here at once and raises an alert; other refusals count as disputes and too many
//   in a day suspend it too. The operator lifts a suspension with POST /admin/ledger-service/members/enable.

import { createHash, type KeyObject } from "node:crypto";
import type { CreditTransaction } from "../common/types.js";
import type { PostgresStore, LedgerServiceCaps } from "../db/postgres.js";
import { memberBillable, type RegistryEntry } from "../discovery/registry.js";
import { splitJobCost, type FeeRounding } from "../economy/job-pricing.js";
import { verifyPeerRequest, PEER_SIGNATURE_MAX_SKEW_MS } from "../mesh/peer-trust.js";
import { canonicalAgentClaim, normalizePem, verifyAgentClaim, type SignedAgentReceiptClaim } from "../receipts/receipt.js";
import { fingerprintMatches } from "../security/key-fingerprint.js";
import { audienceOf, verifyPortalRequest, SERVICE_REQUEST_MAX_SKEW_MS } from "../security/service-request-signing.js";
import { debitTxId, NETWORK_FEE_POOL_ACCOUNT, refundTxId, roundCredits } from "../credits/store.js";
import {
  balanceRequestSchema,
  operatorAccountId,
  refundRequestSchema,
  reserveRequestSchema,
  settleRequestSchema,
  splitRoutingFee,
  ROUTING_FEE_REASON_PREFIX,
  type BuyerProof,
  type SettleResponse
} from "./protocol.js";

export type LedgerServiceStore = Pick<
  PostgresStore,
  | "ledgerServiceMember"
  | "ledgerServiceSuspend"
  | "ledgerServiceReinstate"
  | "ledgerServiceNoteDispute"
  | "ledgerServiceClaimNonce"
  | "ledgerServicePruneNonces"
  | "ledgerServiceUsage"
  | "ledgerServiceTask"
  | "ledgerServiceExpiredTasks"
  | "ledgerServiceReserve"
  | "ledgerServiceSettle"
  | "ledgerServiceRefund"
  | "creditBalance"
  | "getAgentOwnership"
  | "listAgentSigningKeys"
>;

export interface LedgerServiceConfig {
  /** LEDGER_SERVICE_ENABLED: off, every call is refused (503). */
  enabled: boolean;
  /** NETWORK_FEE_BPS of the seeds: the fee is computed here, never taken from the caller. */
  feeBps: number;
  feeRounding?: FeeRounding;
  /** LEDGER_SERVICE_ROUTING_SHARE_BPS: the routing coordinator's share of the fee (default 4000). */
  routingShareBps: number;
  caps: LedgerServiceCaps;
  /** LEDGER_SERVICE_OVERFLOW_MAX_PCT: a cost past the reserve is at most this % of the reserve (default 100). */
  overflowMaxPct: number;
  /** LEDGER_SERVICE_MAX_DISPUTES: refused calls in `disputeWindowMs` before billing is suspended (default 5). */
  maxDisputes: number;
  disputeWindowMs?: number;
  /** LEDGER_SERVICE_RESERVE_TTL_MS: an open task older than this is closed and refunded by the sweep. */
  reserveTtlMs: number;
}

export interface AccrualRecordInput {
  taskId: string;
  subtaskId: string;
  hostAccountId: string;
  routedBy: string;
  payload: Record<string, unknown>;
}

export interface LedgerServiceDeps {
  store: LedgerServiceStore;
  config: LedgerServiceConfig;
  /** The verified signed registry's entry for a coordinator (null: not listed or no registry). */
  member: (peerId: string) => RegistryEntry | null;
  /** PORTAL_ACTION_VERIFY_KEYS, for buyer proofs. */
  portalKeys: () => readonly KeyObject[];
  /** The earnings_accrual ledger record of a settle (what /ledger/verify checks the rows against). */
  recordAccrual: (r: AccrualRecordInput) => Promise<void>;
  /** An anomaly: billing for that coordinator was suspended here. */
  alert: (event: string, detail: Record<string, unknown>) => void;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
  now?: () => number;
}

export type LedgerReply = { code: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>): LedgerReply => ({ code: 200, body });
const refuse = (code: number, error: string, extra: Record<string, unknown> = {}): LedgerReply => ({ code, body: { error, ...extra } });

/** sha256 of the agent's signed claim (canonical form plus signature): the receipt id a settle names. */
export function agentClaimId(claim: SignedAgentReceiptClaim): string {
  return createHash("sha256").update(`${canonicalAgentClaim(claim)}\n${claim.agentSignature}`).digest("hex");
}

export class LedgerService {
  private readonly d: LedgerServiceDeps;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(deps: LedgerServiceDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.d.config.enabled;
  }

  /**
   * Who signed this request: a fresh, single-use signature (nonces shared by every seed through the
   * database) by the key the registry lists for a community member, over these exact bytes. Then the
   * member must be billable (active and billing approved) and not suspended here.
   */
  async authenticate(req: { method: string; url: string; headers: Record<string, unknown>; rawBody: string }): Promise<{ ok: true; peerId: string; entry: RegistryEntry } | { ok: false; reply: LedgerReply }> {
    if (!this.d.config.enabled) return { ok: false, reply: refuse(503, "ledger_service_disabled") };
    const decision = await verifyPeerRequest({
      headers: req.headers,
      method: req.method,
      path: req.url,
      rawBody: req.rawBody,
      trusted: (peerId, pem) => {
        const e = this.d.member(peerId);
        return Boolean(e && e.operator.kind === "community" && fingerprintMatches(e.publicKeyFingerprint, pem));
      },
      replay: (peerId, nonce) => this.d.store.ledgerServiceClaimNonce(`peer:${peerId}:${nonce}`, this.now() + 2 * PEER_SIGNATURE_MAX_SKEW_MS),
      nowMs: this.now()
    });
    if (!decision.ok) return { ok: false, reply: refuse(decision.code, decision.error) };
    const entry = this.d.member(decision.peerId)!;
    if (!entry || !memberBillable(entry)) {
      return { ok: false, reply: refuse(403, "member_not_billable", { status: entry?.status ?? "unlisted", billingEnabled: entry?.billingEnabled === true }) };
    }
    const local = await this.d.store.ledgerServiceMember(decision.peerId);
    if (local?.suspendedAtMs != null) return { ok: false, reply: refuse(403, "billing_suspended", { reason: local.suspendedReason }) };
    return { ok: true, peerId: decision.peerId, entry };
  }

  /** Stop billing for a coordinator here and raise an alert. */
  private async anomaly(peerId: string, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.d.store.ledgerServiceSuspend(peerId, `anomaly:${kind}`, this.now());
    this.d.alert("ledger_service_member_suspended", { peerId, kind, ...detail });
  }

  /** A refused call counted toward the dispute limit; past it billing is suspended. */
  private async dispute(peerId: string, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
    const n = await this.d.store.ledgerServiceNoteDispute(peerId, this.now(), this.d.config.disputeWindowMs ?? 86_400_000);
    this.d.log?.("ledger_service_dispute", { peerId, kind, disputes: n, ...detail });
    if (n >= Math.max(1, this.d.config.maxDisputes)) await this.anomaly(peerId, "repeated_disputes", { disputes: n, last: kind });
  }

  /** The buyer's portal-signed request, made for this member's origin, naming this account. */
  private async checkBuyerProof(entry: RegistryEntry, accountId: string, proof: BuyerProof | undefined, consume: boolean): Promise<string | null> {
    if (!proof) return "buyer_proof_required";
    const keys = this.d.portalKeys();
    if (keys.length === 0) return "portal_keys_not_configured";
    const audiences = new Set(entry.urls.map((u) => audienceOf(u)).filter((a): a is string => Boolean(a)));
    const v = await verifyPortalRequest({
      headers: proof.headers,
      method: proof.method,
      path: proof.path,
      keys,
      audiences,
      replay: consume ? (nonce) => this.d.store.ledgerServiceClaimNonce(`portal:${nonce}`, this.now() + 2 * SERVICE_REQUEST_MAX_SKEW_MS) : undefined,
      nowMs: this.now()
    });
    if (!v.ok) return v.error;
    if (v.account !== accountId) return "buyer_account_mismatch";
    return null;
  }

  async reserve(peerId: string, entry: RegistryEntry, body: unknown): Promise<LedgerReply> {
    const parsed = reserveRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return refuse(400, "invalid_request");
    const r = parsed.data;
    if (!r.idempotencyKey.includes(r.taskId)) return refuse(400, "idempotency_key_must_name_task");
    const existing = await this.d.store.ledgerServiceTask(r.taskId);
    if (existing && existing.peerId !== peerId) {
      await this.dispute(peerId, "reserve_task_conflict", { taskId: r.taskId });
      return refuse(409, "duplicate_task");
    }
    // A new task needs the buyer's proof (single-use); a top-up of this coordinator's open task does not.
    if (!existing) {
      const problem = await this.checkBuyerProof(entry, r.accountId, r.buyerProof, true);
      if (problem) {
        await this.dispute(peerId, "buyer_proof", { taskId: r.taskId, problem });
        return refuse(403, "buyer_proof_invalid", { reason: problem });
      }
    }
    const nowMs = this.now();
    // The cost cap: the buyer's ceiling, never more than the reserve plus LEDGER_SERVICE_OVERFLOW_MAX_PCT of it.
    const reserveTotal = (existing?.reservedMsat ?? 0) + r.msat;
    const bound = Math.floor(reserveTotal * (1 + Math.max(0, this.d.config.overflowMaxPct) / 100));
    const overflowCapMsat = r.kind === "inference" ? Math.max(reserveTotal, Math.min(r.overflowCapMsat ?? reserveTotal, bound)) : reserveTotal;
    const tx: CreditTransaction = {
      txId: debitTxId(r.idempotencyKey),
      accountId: r.accountId,
      type: "spend",
      credits: roundCredits(r.msat / 1000),
      reason: r.kind === "job" ? "task_reserve" : "inference_reserve",
      relatedTaskId: r.taskId,
      timestampMs: nowMs
    };
    if (!(tx.credits > 0)) return refuse(400, "invalid_request");
    const out = await this.d.store.ledgerServiceReserve({
      peerId,
      row: { taskId: r.taskId, accountId: r.accountId, kind: r.kind, perSubtaskReserveMsat: r.perSubtaskReserveMsat ?? r.msat, createdAtMs: nowMs },
      tx,
      reserveMsat: r.msat,
      overflowCapMsat,
      caps: this.d.config.caps,
      nowMs
    });
    switch (out.status) {
      case "applied":
        return ok({ status: out.billing === "inserted" ? "inserted" : "same", reservedMsat: r.msat });
      case "duplicate":
        return refuse(409, "duplicate_reserve");
      case "conflict":
        await this.dispute(peerId, "reserve_conflict", { taskId: r.taskId });
        return refuse(409, "duplicate_task");
      case "closed":
        await this.dispute(peerId, "reserve_closed_task", { taskId: r.taskId });
        return refuse(409, "task_closed");
      case "insufficient":
        return refuse(402, "insufficient_credits");
      case "suspended":
        return refuse(403, "billing_suspended", { reason: out.reason });
      case "over_cap":
        await this.dispute(peerId, "reserve_over_cap", { cap: out.cap, limit: out.limit, value: out.value });
        return refuse(429, "over_cap", { cap: out.cap, limit: out.limit });
    }
  }

  async settle(peerId: string, entry: RegistryEntry, body: unknown): Promise<LedgerReply> {
    const parsed = settleRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return refuse(400, "invalid_request");
    const s = parsed.data;
    // Every settle names the agent's signed claim for exactly this execution.
    const claim = s.receipt as SignedAgentReceiptClaim | undefined;
    if (!claim) {
      await this.anomaly(peerId, "settle_without_receipt", { taskId: s.taskId, subtaskId: s.subtaskId });
      return refuse(403, "receipt_required");
    }
    if (claim.taskId !== s.taskId || claim.subtaskId !== s.subtaskId || claim.agentId !== s.agentId || claim.finishedAtMs < claim.startedAtMs || !verifyAgentClaim(claim)) {
      await this.anomaly(peerId, "settle_receipt_invalid", { taskId: s.taskId, subtaskId: s.subtaskId });
      return refuse(403, "receipt_invalid");
    }
    // What the shared database knows about the agent must agree: its keys, and whose machine it is.
    const knownKeys = await this.d.store.listAgentSigningKeys(s.agentId);
    if (knownKeys.length > 0 && !knownKeys.some((k) => normalizePem(k) === normalizePem(claim.agentPublicKeyPem))) {
      await this.anomaly(peerId, "settle_agent_key_mismatch", { taskId: s.taskId, agentId: s.agentId });
      return refuse(403, "receipt_invalid");
    }
    const owner = await this.d.store.getAgentOwnership(s.agentId);
    if (owner && owner.accountId !== s.hostAccountId) {
      await this.anomaly(peerId, "settle_host_mismatch", { taskId: s.taskId, agentId: s.agentId });
      return refuse(403, "host_account_mismatch");
    }
    const task = await this.d.store.ledgerServiceTask(s.taskId);
    if (task && task.accountId === s.hostAccountId) {
      // The buyer's own machine: not a sale (results.ts sameAccountGroup), nothing to charge.
      return refuse(409, "own_account_not_billed");
    }
    const nowMs = this.now();
    const receiptId = agentClaimId(claim);
    const reportId = `result:${s.subtaskId}`;
    const routingAccount = operatorAccountId(entry.operator.id);
    const rounding = this.d.config.feeRounding ?? "nearest";
    type Built = { costMsat: number; agentMsat: number; feeMsat: number; routingMsat: number; poolMsat: number; credits: number };
    const builtRef: { v: Built | null } = { v: null };
    const build = (coveredMsat: number) => {
      const costMsat = s.baseCostMsat + coveredMsat;
      const { agentMsat, feeMsat } = splitJobCost(costMsat, this.d.config.feeBps, rounding);
      const { routingMsat, poolMsat } = splitRoutingFee(feeMsat, this.d.config.routingShareBps);
      const credits = roundCredits(agentMsat / 1000);
      builtRef.v = { costMsat, agentMsat, feeMsat, routingMsat, poolMsat, credits };
      const row = (accountId: string, msat: number, reason: string): CreditTransaction => ({
        txId: `${reason === "compute_contribution" ? "ls-earn" : reason.split(":")[0]}:${createHash("sha256").update(`${reportId}\n${accountId}\n${reason}`).digest("hex").slice(0, 32)}`,
        accountId,
        type: "earn",
        credits: roundCredits(msat / 1000),
        reason,
        relatedTaskId: s.taskId,
        timestampMs: nowMs,
        msat: Math.round(msat)
      });
      const tx = row(s.hostAccountId, agentMsat, "compute_contribution");
      const feeTx = poolMsat > 0 ? row(NETWORK_FEE_POOL_ACCOUNT, poolMsat, `network_fee:${s.taskId}`) : undefined;
      const extraTxs = routingMsat > 0 ? [row(routingAccount, routingMsat, `${ROUTING_FEE_REASON_PREFIX}${s.taskId}`)] : [];
      return { tx, ...(feeTx ? { feeTx } : {}), extraTxs };
    };
    const seconds = s.durationMs / 1000;
    const out = await this.d.store.ledgerServiceSettle({
      peerId,
      taskId: s.taskId,
      report: {
        reportId,
        agentId: s.hostAccountId,
        sourceAgentId: s.agentId,
        taskId: s.taskId,
        resourceClass: s.resourceClass,
        cpuSeconds: s.resourceClass === "cpu" ? seconds : 0,
        gpuSeconds: s.resourceClass === "gpu" ? seconds : 0,
        success: s.success,
        qualityScore: s.success ? 1 : 0.6,
        timestampMs: nowMs
      },
      sourceAgentId: s.agentId,
      baseCostMsat: s.baseCostMsat,
      overflowWantMsat: s.overflowWantMsat,
      overflowTxId: debitTxId(`overflow:${reportId}`),
      refundTxId: refundTxId(s.taskId),
      build
    });
    if (out.status === "duplicate") return ok({ status: "duplicate" });
    if (out.status === "refused") {
      if (out.error === "over_reserve" || out.error === "over_overflow_cap" || out.error === "not_your_task") {
        await this.anomaly(peerId, `settle_${out.error}`, { taskId: s.taskId, subtaskId: s.subtaskId, ...(out.detail ?? {}) });
        return refuse(out.error === "not_your_task" ? 403 : 422, out.error);
      }
      await this.dispute(peerId, `settle_${out.error}`, { taskId: s.taskId, subtaskId: s.subtaskId });
      return refuse(409, out.error);
    }
    const b = builtRef.v;
    if (!b) return refuse(500, "settle_not_built");
    await this.d
      .recordAccrual({
        taskId: s.taskId,
        subtaskId: s.subtaskId,
        hostAccountId: s.hostAccountId,
        routedBy: peerId,
        payload: {
          sourceAgentId: s.agentId,
          accountId: s.hostAccountId,
          credits: b.credits,
          msat: b.agentMsat,
          costMsat: b.costMsat,
          feeMsat: b.feeMsat,
          routingFeeMsat: b.routingMsat,
          routingAccountId: routingAccount,
          routedBy: peerId,
          receiptId,
          ...(out.coveredMsat > 0 ? { overflowMsat: out.coveredMsat } : {}),
          pricingBasis: "ledger_service",
          networkFeeBps: this.d.config.feeBps,
          feeRounding: rounding,
          durationMs: s.durationMs,
          ok: s.success,
          resourceClass: s.resourceClass
        }
      })
      .catch((err) => this.d.log?.("ledger_service_accrual_record_failed", { taskId: s.taskId, subtaskId: s.subtaskId, error: String(err) }));
    const res: SettleResponse = {
      status: "settled",
      costMsat: b.costMsat,
      coveredMsat: out.coveredMsat,
      agentMsat: b.agentMsat,
      feeMsat: b.feeMsat,
      routingFeeMsat: b.routingMsat,
      credits: b.credits,
      receiptId
    };
    return ok(res as unknown as Record<string, unknown>);
  }

  async refund(peerId: string, body: unknown): Promise<LedgerReply> {
    const parsed = refundRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return refuse(400, "invalid_request");
    const out = await this.d.store.ledgerServiceRefund({ peerId, taskId: parsed.data.taskId, refundTxId: refundTxId(parsed.data.taskId), nowMs: this.now() });
    if (out.status === "not_your_task") {
      await this.anomaly(peerId, "refund_not_your_task", { taskId: parsed.data.taskId });
      return refuse(403, out.status);
    }
    if (out.status === "task_not_found") {
      await this.dispute(peerId, "refund_task_not_found", { taskId: parsed.data.taskId });
      return refuse(404, out.status);
    }
    if (out.status !== "refunded" && out.status !== "already_closed") return refuse(500, "refund_failed");
    return ok({ status: out.status, refundMsat: out.refundMsat, reservedMsat: out.reservedMsat, paidMsat: out.paidMsat });
  }

  /** Admission only: whether the buyer holds at least `atLeastMsat` (the buyer's proof, not consumed). */
  async balance(_peerId: string, entry: RegistryEntry, body: unknown): Promise<LedgerReply> {
    const parsed = balanceRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return refuse(400, "invalid_request");
    const problem = await this.checkBuyerProof(entry, parsed.data.accountId, parsed.data.buyerProof, false);
    if (problem) return refuse(403, "buyer_proof_invalid", { reason: problem });
    const credits = await this.d.store.creditBalance(parsed.data.accountId);
    return ok({ enough: Math.floor(credits * 1000 + 1e-6) >= parsed.data.atLeastMsat });
  }

  /** Close every open task older than the reserve TTL (its coordinator went away), refunding what it did not use. */
  async sweepExpired(): Promise<number> {
    if (!this.d.config.enabled) return 0;
    const nowMs = this.now();
    let closed = 0;
    for (const t of await this.d.store.ledgerServiceExpiredTasks(nowMs - this.d.config.reserveTtlMs)) {
      const r = await this.d.store.ledgerServiceRefund({ peerId: t.peerId, taskId: t.taskId, refundTxId: refundTxId(t.taskId), nowMs });
      if (r.status === "refunded") closed++;
    }
    await this.d.store.ledgerServicePruneNonces(nowMs).catch(() => 0);
    if (closed > 0) this.d.log?.("ledger_service_expired_closed", { closed });
    return closed;
  }

  startSweep(intervalMs = 5 * 60_000): void {
    if (this.sweepTimer || !this.d.config.enabled) return;
    this.sweepTimer = setInterval(() => void this.sweepExpired().catch((err) => this.d.log?.("ledger_service_sweep_failed", { error: String(err) })), intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Admin: a member's state here (suspension, disputes, open reserves) and in the registry. */
  async memberStatus(peerId: string): Promise<Record<string, unknown>> {
    const entry = this.d.member(peerId);
    const local = await this.d.store.ledgerServiceMember(peerId);
    const usage = await this.d.store.ledgerServiceUsage(peerId, this.now());
    return {
      peerId,
      registry: entry ? { status: entry.status ?? "active", billingEnabled: entry.billingEnabled === true, billable: memberBillable(entry), operatorAccountId: operatorAccountId(entry.operator.id) } : null,
      suspended: local?.suspendedAtMs != null,
      suspendedReason: local?.suspendedReason ?? null,
      disputes: local?.disputes ?? 0,
      ...usage
    };
  }

  /** Admin: stop billing for a member here, at once (no registry round trip). */
  async disableMember(peerId: string, reason: string): Promise<void> {
    await this.d.store.ledgerServiceSuspend(peerId, `admin:${reason}`, this.now());
    this.d.alert("ledger_service_member_disabled", { peerId, reason });
  }

  /** Admin: lift a suspension here (the registry's active status and billing flag still apply). */
  async enableMember(peerId: string): Promise<void> {
    await this.d.store.ledgerServiceReinstate(peerId, this.now());
  }
}

/** LedgerServiceConfig from the environment (the coordinator validates these in coordinator-config.ts). */
export function ledgerServiceConfigFromEnv(cc: {
  LEDGER_SERVICE_ENABLED: boolean;
  LEDGER_SERVICE_ROUTING_SHARE_BPS: number;
  LEDGER_SERVICE_MAX_OPEN_RESERVES: number;
  LEDGER_SERVICE_MAX_OPEN_RESERVE_MSAT: number;
  LEDGER_SERVICE_MAX_MSAT_PER_HOUR: number;
  LEDGER_SERVICE_OVERFLOW_MAX_PCT: number;
  LEDGER_SERVICE_MAX_DISPUTES: number;
  LEDGER_SERVICE_RESERVE_TTL_MS: number;
  NETWORK_FEE_BPS: number;
}): LedgerServiceConfig {
  return {
    enabled: cc.LEDGER_SERVICE_ENABLED,
    feeBps: cc.NETWORK_FEE_BPS,
    routingShareBps: cc.LEDGER_SERVICE_ROUTING_SHARE_BPS,
    caps: { maxOpenReserves: cc.LEDGER_SERVICE_MAX_OPEN_RESERVES, maxOpenReserveMsat: cc.LEDGER_SERVICE_MAX_OPEN_RESERVE_MSAT, maxReserveMsatPerHour: cc.LEDGER_SERVICE_MAX_MSAT_PER_HOUR },
    overflowMaxPct: cc.LEDGER_SERVICE_OVERFLOW_MAX_PCT,
    maxDisputes: cc.LEDGER_SERVICE_MAX_DISPUTES,
    reserveTtlMs: cc.LEDGER_SERVICE_RESERVE_TTL_MS
  };
}

type RouteApp = {
  post: (path: string, handler: (req: any, reply: any) => Promise<unknown>) => unknown;
};

/** POST /ledger/v1/{reserve,settle,refund,balance}: authenticate, then the call. */
export function registerLedgerServiceRoutes(app: RouteApp, service: LedgerService, rawBodyOf: (req: unknown) => string): void {
  const route = (path: string, fn: (peerId: string, entry: RegistryEntry, body: unknown) => Promise<LedgerReply>) =>
    app.post(path, async (req, reply) => {
      const auth = await service.authenticate({ method: req.method, url: req.url, headers: req.headers ?? {}, rawBody: rawBodyOf(req) });
      const r = auth.ok ? await fn(auth.peerId, auth.entry, req.body) : auth.reply;
      return reply.code(r.code).send(r.body);
    });
  route("/ledger/v1/reserve", (p, e, b) => service.reserve(p, e, b));
  route("/ledger/v1/settle", (p, e, b) => service.settle(p, e, b));
  route("/ledger/v1/refund", (p, _e, b) => service.refund(p, b));
  route("/ledger/v1/balance", (p, e, b) => service.balance(p, e, b));
}
