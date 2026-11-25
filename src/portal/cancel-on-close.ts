// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A buyer that goes away cancels its coordinator call at once (network run 6).
 *
 * The reader of a network call (network-inference.ts streamSubmitted) cancels it when it stops
 * reading, but only once its own await returns, and a submit that was cut by the abort left no
 * subtask id to cancel: in run 6 calls whose client closed at 120 s ran on to 153–224 s, on hosts
 * that were already behind. This transport wrapper (portal hosted /v1 and portal chat) watches the
 * request's abort signal and, the moment it fires, sends POST /inference/cancel for every call it
 * submitted that has not ended:
 *
 * - streamed calls and non-streamed calls during the whole-reply keepalive (a stream read is open);
 * - calls still queued (submitted, nobody claimed them: the coordinator takes them off the queue);
 * - a submit still on its way: it is not aborted (the coordinator may already hold the call), and
 *   the call is cancelled as soon as its subtask id comes back. The caller is released at once.
 *
 * One cancel per call: the reader's own cancel, sent later, is answered here without a request.
 * The coordinator's answer is logged (portal_call_cancel): the call's own log line (hosted_call) is
 * written as the connection closes, before that answer comes back.
 * The coordinator then stops the agent and settles under its buyer-cancel rules
 * (src/swarm/coordinator/inference-cancel.ts).
 */

import type { Transport } from "../apps/ide/network-inference.js";
import { moduleLogger } from "../common/logger.js";

const logger = moduleLogger("portal-cancel");

const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });

/** `inner` with calls it submitted cancelled the moment the caller's signal aborts; `where` (a coordinator host) is logged with each cancel. */
export function cancelOnClose(inner: Transport, where?: string): Transport {
  /** subtaskId -> taskId of submitted calls that have not ended. */
  const open = new Map<string, string>();
  /** Calls a cancel was sent for (sent once). */
  const cancelled = new Set<string>();
  const watched = new WeakSet<AbortSignal>();
  let closed = false;

  const sendCancel = (taskId: string, subtaskId: string): Promise<{ status: number; json: Record<string, unknown> }> => {
    open.delete(subtaskId);
    if (cancelled.has(subtaskId)) return Promise.resolve({ status: 200, json: { ok: true, outcome: "already_sent" } });
    cancelled.add(subtaskId);
    const sent = inner("POST", "/inference/cancel", { taskId, subtaskId });
    sent.then(
      (r) => {
        const line = { taskId, subtaskId, coordinator: where, status: r.status, outcome: typeof r.json.outcome === "string" ? r.json.outcome.slice(0, 40) : undefined, error: typeof r.json.error === "string" ? r.json.error.slice(0, 60) : undefined };
        if (r.status === 200) logger.info(line, "portal_call_cancel");
        else logger.warn(line, "portal_call_cancel");
      },
      (err: { code?: unknown; name?: unknown } | null) => logger.warn({ taskId, subtaskId, coordinator: where, error: String(err?.code ?? err?.name ?? "error").slice(0, 60) }, "portal_call_cancel"),
    );
    return sent;
  };
  const cancelOpen = () => {
    closed = true;
    for (const [subtaskId, taskId] of [...open]) void sendCancel(taskId, subtaskId).catch(() => undefined);
  };
  const watch = (signal: AbortSignal | undefined) => {
    if (!signal || watched.has(signal)) return;
    watched.add(signal);
    if (signal.aborted) closed = true;
    else signal.addEventListener("abort", cancelOpen, { once: true });
  };

  return async (method, path, body, signal) => {
    watch(signal);
    if (path === "/inference/cancel") {
      const b = (body ?? {}) as { taskId?: unknown; subtaskId?: unknown };
      if (typeof b.taskId === "string" && typeof b.subtaskId === "string") return sendCancel(b.taskId, b.subtaskId);
      return inner(method, path, body, signal);
    }
    if (path === "/inference/submit") {
      // Nobody is waiting any more: nothing is sent.
      if (closed || signal?.aborted) throw abortError();
      // Not aborted with the caller: once the coordinator answers, the call can be cancelled by id.
      const sent = inner(method, path, body).then((r) => {
        const subtaskId = r.status === 200 && typeof r.json.subtaskId === "string" ? r.json.subtaskId : undefined;
        const taskId = typeof r.json.taskId === "string" ? r.json.taskId : (body as { taskId?: unknown } | undefined)?.taskId;
        if (subtaskId && typeof taskId === "string") {
          open.set(subtaskId, taskId);
          if (closed) cancelOpen();
        }
        return r;
      });
      if (!signal) return sent;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        sent.then(
          (r) => {
            signal.removeEventListener("abort", onAbort);
            resolve(r);
          },
          (err) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    }
    const r = await inner(method, path, body, signal);
    if (path === "/inference/stream") {
      const subtaskId = (body as { subtaskId?: unknown } | undefined)?.subtaskId;
      // The reply ended (done, refused for capacity, or the coordinator no longer knows it): nothing to cancel.
      const ended = r.json.done === true || (r.status === 503 && r.json.error === "no_capacity") || r.json.error === "unknown_stream";
      if (ended && typeof subtaskId === "string") open.delete(subtaskId);
    }
    return r;
  };
}
