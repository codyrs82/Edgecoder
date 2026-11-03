// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { verifyPayload } from "../mesh/peer.js";
import { proofForReceipt } from "./epochs.js";
import { canonicalJson, isWorkReceiptShape, normalizePem, verifyReceipt, type WorkReceipt } from "./receipt.js";
import { clampLimit, type ReceiptStore } from "./store.js";

/*
 * Architecture step 2 (continued): coordinators replicate receipts to each other, so a
 * receipt survives the coordinator that issued it. Every receipt is verified (both
 * signatures, and the coordinator key must be the one the mesh knows for that
 * coordinatorId) before it is stored; storage is idempotent by receiptId.
 *
 *   GET  /receipts/since?cursor=&limit=   signed page of receipts in storage order
 *   POST /receipts/replicate              push receipts (same validation as the pull path)
 *   GET  /receipts/epochs/latest          this coordinator's latest closed epoch
 *   GET  /receipts/:receiptId             receipt plus its inclusion proof once closed
 */

export interface ReceiptLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ReceiptAcceptOptions {
  /**
   * Known public key for a coordinatorId (self or a mesh peer). When provided a receipt is
   * accepted only if its coordinatorPublicKeyPem matches; an unknown coordinator is rejected.
   */
  coordinatorPublicKeyFor?: (coordinatorId: string) => string | null;
}

export interface ReceiptAcceptResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ receiptId: string | null; reason: string }>;
}

/** Validate and store a batch. Shared by POST /receipts/replicate and the pull loop. */
export async function acceptReceipts(
  store: ReceiptStore,
  receipts: unknown[],
  opts: ReceiptAcceptOptions = {}
): Promise<ReceiptAcceptResult> {
  const result: ReceiptAcceptResult = { accepted: 0, duplicates: 0, rejected: [] };
  for (const candidate of receipts) {
    if (!isWorkReceiptShape(candidate)) {
      const id = candidate && typeof candidate === "object" ? (candidate as { receiptId?: unknown }).receiptId : null;
      result.rejected.push({ receiptId: typeof id === "string" ? id : null, reason: "malformed" });
      continue;
    }
    const verification = verifyReceipt(candidate);
    if (!verification.ok) {
      result.rejected.push({ receiptId: candidate.receiptId, reason: verification.reason });
      continue;
    }
    if (opts.coordinatorPublicKeyFor) {
      const known = opts.coordinatorPublicKeyFor(candidate.coordinatorId);
      if (!known) {
        result.rejected.push({ receiptId: candidate.receiptId, reason: "coordinator_unknown" });
        continue;
      }
      if (normalizePem(known) !== normalizePem(candidate.coordinatorPublicKeyPem)) {
        result.rejected.push({ receiptId: candidate.receiptId, reason: "coordinator_key_mismatch" });
        continue;
      }
    }
    if (await store.append(candidate)) result.accepted += 1;
    else result.duplicates += 1;
  }
  return result;
}

export interface SignedReceiptPage {
  coordinatorId: string;
  cursor: string;
  nextCursor: string;
  issuedAtMs: number;
  receipts: WorkReceipt[];
  /** Coordinator signature over receiptPageSigningPayload(page). */
  signature: string;
}

/** Bytes a coordinator signs for a page: the receipt ids are enough since each receipt is itself signed. */
export function receiptPageSigningPayload(page: Omit<SignedReceiptPage, "signature">): string {
  return canonicalJson({
    coordinatorId: page.coordinatorId,
    cursor: page.cursor,
    nextCursor: page.nextCursor,
    issuedAtMs: page.issuedAtMs,
    receiptIds: page.receipts.map((r) => r.receiptId)
  });
}

export function verifyReceiptPage(page: SignedReceiptPage, coordinatorPublicKeyPem: string): boolean {
  if (!page || typeof page.signature !== "string" || !Array.isArray(page.receipts)) return false;
  return verifyPayload(receiptPageSigningPayload(page), page.signature, coordinatorPublicKeyPem);
}

export interface ReceiptRouteDeps extends ReceiptAcceptOptions {
  store: ReceiptStore;
  coordinatorId: string;
  /** Returns true when the request carries a valid mesh token; otherwise it has already set the status code. */
  requireMeshToken: (req: { headers: Record<string, unknown> }, reply: { code: (n: number) => unknown }) => boolean;
  /** Sign a page payload with the coordinator key. */
  sign: (payload: string) => string;
  now?: () => number;
  log?: ReceiptLogger;
}

const replicateSchema = z.object({ receipts: z.array(z.unknown()).max(1000) });

export function registerReceiptRoutes(app: FastifyInstance, deps: ReceiptRouteDeps): void {
  const now = deps.now ?? Date.now;

  app.get("/receipts/since", async (req, reply) => {
    if (!deps.requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const query = z
      .object({ cursor: z.string().optional(), limit: z.coerce.number().int().optional() })
      .parse((req.query ?? {}) as Record<string, unknown>);
    const cursor = query.cursor ?? "";
    const page = await deps.store.listSince(cursor || null, clampLimit(query.limit));
    const body: Omit<SignedReceiptPage, "signature"> = {
      coordinatorId: deps.coordinatorId,
      cursor,
      nextCursor: page.nextCursor,
      issuedAtMs: now(),
      receipts: page.receipts
    };
    const signed: SignedReceiptPage = { ...body, signature: deps.sign(receiptPageSigningPayload(body)) };
    return reply.send(signed);
  });

  app.post("/receipts/replicate", async (req, reply) => {
    if (!deps.requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const parsed = replicateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const result = await acceptReceipts(deps.store, parsed.data.receipts, deps);
    if (result.rejected.length > 0) {
      deps.log?.warn({ rejected: result.rejected.slice(0, 20), accepted: result.accepted }, "receipt_replicate_rejected_some");
    }
    return reply.send({ ok: true, ...result });
  });

  app.get("/receipts/epochs/latest", async (req, reply) => {
    if (!deps.requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const epoch = await deps.store.latestEpoch(deps.coordinatorId);
    return reply.send({ coordinatorId: deps.coordinatorId, epoch });
  });

  app.get("/receipts/:receiptId", async (req, reply) => {
    if (!deps.requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const { receiptId } = z.object({ receiptId: z.string().min(1).max(128) }).parse(req.params);
    const receipt = await deps.store.get(receiptId);
    if (!receipt) return reply.code(404).send({ error: "receipt_not_found" });
    const proof = await proofForReceipt(deps.store, receipt);
    return reply.send({ receipt, proof });
  });
}

/* ------------------------------------------------------------------ */
/*  Pull loop                                                          */
/* ------------------------------------------------------------------ */

export interface ReplicationPeer {
  peerId: string;
  coordinatorUrl: string;
  publicKeyPem: string;
}

export type ReplicationFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ReceiptReplicationOptions extends ReceiptAcceptOptions {
  peers: () => ReplicationPeer[];
  store: ReceiptStore;
  intervalMs: number;
  fetch: ReplicationFetch;
  /** Our own id: pages claiming to come from it are ignored. */
  selfId?: string;
  meshToken?: string;
  pageLimit?: number;
  /** Pages pulled from one peer per tick before yielding (default 10). */
  maxPagesPerTick?: number;
  requestTimeoutMs?: number;
  log?: ReceiptLogger;
}

export interface ReceiptReplicationHandle {
  stop(): void;
  /** One pass over every peer (also what the timer runs). Returns per-peer outcomes. */
  pullOnce(): Promise<Array<{ peerId: string; accepted: number; duplicates: number; rejected: number; error?: string }>>;
  cursorFor(peerId: string): string;
}

export function startReceiptReplication(opts: ReceiptReplicationOptions): ReceiptReplicationHandle {
  const cursors = new Map<string, string>();
  const maxPages = Math.max(1, opts.maxPagesPerTick ?? 10);
  const pageLimit = clampLimit(opts.pageLimit);
  let running = false;

  async function pullPeer(peer: ReplicationPeer) {
    const outcome = { peerId: peer.peerId, accepted: 0, duplicates: 0, rejected: 0 } as {
      peerId: string; accepted: number; duplicates: number; rejected: number; error?: string;
    };
    const base = peer.coordinatorUrl.replace(/\/+$/, "");
    for (let pages = 0; pages < maxPages; pages += 1) {
      const cursor = cursors.get(peer.peerId) ?? "";
      const url = `${base}/receipts/since?cursor=${encodeURIComponent(cursor)}&limit=${pageLimit}`;
      const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), opts.requestTimeoutMs ?? 10_000) : undefined;
      let page: SignedReceiptPage;
      try {
        const res = await opts.fetch(url, {
          headers: { accept: "application/json", ...(opts.meshToken ? { "x-mesh-token": opts.meshToken } : {}) },
          signal: controller?.signal
        });
        if (!res.ok) {
          outcome.error = `http_${res.status}`;
          break;
        }
        page = (await res.json()) as SignedReceiptPage;
      } catch (error) {
        outcome.error = String(error);
        break;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!page || page.coordinatorId !== peer.peerId || (opts.selfId && page.coordinatorId === opts.selfId)) {
        outcome.error = "page_coordinator_mismatch";
        break;
      }
      if (!verifyReceiptPage(page, peer.publicKeyPem)) {
        outcome.error = "page_signature_invalid";
        opts.log?.warn({ peerId: peer.peerId }, "receipt_replication_page_signature_invalid");
        break;
      }
      const result = await acceptReceipts(opts.store, page.receipts, opts);
      outcome.accepted += result.accepted;
      outcome.duplicates += result.duplicates;
      outcome.rejected += result.rejected.length;
      if (result.rejected.length > 0) {
        opts.log?.warn({ peerId: peer.peerId, rejected: result.rejected.slice(0, 10) }, "receipt_replication_rejected_some");
      }
      if (page.nextCursor && page.nextCursor !== cursor) cursors.set(peer.peerId, page.nextCursor);
      if (page.receipts.length < pageLimit) break;
    }
    return outcome;
  }

  async function pullOnce() {
    if (running) return [];
    running = true;
    try {
      const out: Awaited<ReturnType<ReceiptReplicationHandle["pullOnce"]>> = [];
      for (const peer of opts.peers()) {
        if (!peer.coordinatorUrl || !peer.publicKeyPem) continue;
        if (opts.selfId && peer.peerId === opts.selfId) continue;
        const o = await pullPeer(peer);
        if (o.accepted > 0) opts.log?.info({ peerId: peer.peerId, accepted: o.accepted }, "receipt_replication_pulled");
        out.push(o);
      }
      return out;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void pullOnce().catch((error) => opts.log?.warn({ error: String(error) }, "receipt_replication_tick_failed"));
  }, Math.max(1000, opts.intervalMs));
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    pullOnce,
    cursorFor: (peerId) => cursors.get(peerId) ?? ""
  };
}
