// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * A Mac answering sealed BLE requests (ble-seal.ts). A sealed request is admitted without a mesh
 * token when the requester proves it holds the seal key this Mac's user pinned for that agent id
 * (ble-offline-consent.ts: the same list of allowed devices): the static-static term of the seal
 * only opens for that key. It must also be fresh (issued within 2 minutes, never seen before),
 * within the size limit and the per-requester rate. Refusals before the request is opened are
 * plain (they carry nothing of the prompt); the answer and any failure after opening are sealed.
 * Nothing is paid or charged: there is no co-sign for sealed requests.
 */

import { BleSealError, openBleTask, sealBleResult, type SealKeyPair, type SealedResultMessage } from "./ble-seal.js";

export interface BlePlainRefusal {
  requestId: string;
  providerId: string;
  status: "failed";
  output: string;
  cpuSeconds: 0;
  providerSignature: "";
}

export interface BleSealedResponderDeps {
  agentId: string;
  ownKey: SealKeyPair;
  /** Whether `requesterId` is allowed here with this pinned seal key. */
  senderAllowed: (requesterId: string, senderKey: Buffer) => boolean;
  run: (task: string) => Promise<{ ok: boolean; output: string; durationMs: number }>;
  maxTaskBytes?: number;
  perRequester?: number;
  windowMs?: number;
  maxSkewMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export function bleSealedResponder(deps: BleSealedResponderDeps): (msg: unknown) => Promise<SealedResultMessage | BlePlainRefusal> {
  const now = deps.now ?? Date.now;
  const maxTaskBytes = deps.maxTaskBytes ?? 64 * 1024;
  const perRequester = deps.perRequester ?? 6;
  const windowMs = deps.windowMs ?? 60_000;
  const maxSkewMs = deps.maxSkewMs ?? 2 * 60_000;
  const seen = new Map<string, number>();
  const hits = new Map<string, number[]>();
  return async (msg) => {
    const requestId = String((msg as { requestId?: unknown })?.requestId ?? "");
    const refuse = (reason: string): BlePlainRefusal => {
      deps.log?.(`[BLE] refusing sealed request ${requestId.slice(0, 64)}: ${reason}`);
      return { requestId, providerId: deps.agentId, status: "failed", output: reason, cpuSeconds: 0, providerSignature: "" };
    };
    let opened: ReturnType<typeof openBleTask>;
    try {
      opened = openBleTask(msg, deps.ownKey);
    } catch (err) {
      return refuse(err instanceof BleSealError ? err.reason : "seal_invalid");
    }
    if (!deps.senderAllowed(opened.requesterId, opened.senderKey)) return refuse("not_allowed");
    const t = now();
    if (Math.abs(t - opened.issuedAtMs) > maxSkewMs) return refuse("proof_expired");
    for (const [k, until] of seen) if (until < t) seen.delete(k);
    const key = `${opened.requestId}|${(msg as { epk?: string }).epk}`;
    if (seen.has(key)) return refuse("request_replayed");
    const mine = (hits.get(opened.requesterId) ?? []).filter((x) => x > t - windowMs);
    if (mine.length >= perRequester) {
      hits.set(opened.requesterId, mine);
      return refuse("rate_limited");
    }
    seen.set(key, opened.issuedAtMs + maxSkewMs);
    mine.push(t);
    hits.set(opened.requesterId, mine);
    if (Buffer.byteLength(opened.task, "utf8") > maxTaskBytes) {
      return sealBleResult(opened.replyKey, opened.requestId, deps.agentId, { status: "failed", output: "task_too_large", cpuSeconds: 0 });
    }
    try {
      const r = await deps.run(opened.task);
      return sealBleResult(opened.replyKey, opened.requestId, deps.agentId, { status: r.ok ? "completed" : "failed", output: r.output, cpuSeconds: Math.max(0, r.durationMs) / 1000 });
    } catch (err) {
      return sealBleResult(opened.replyKey, opened.requestId, deps.agentId, { status: "failed", output: String((err as Error)?.message ?? err).slice(0, 200), cpuSeconds: 0 });
    }
  };
}
