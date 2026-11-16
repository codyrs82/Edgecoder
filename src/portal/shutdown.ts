// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Stopping the portal (a deploy or restart: Fly sends kill_signal, then kills after kill_timeout in
 * fly.portal.toml) used to cut every model call it was streaming: the client saw the connection
 * close with no error and no [DONE] (undici "terminated"; the load generator's "stream_error"). Now
 * the portal stops taking requests, lets the calls being answered finish for up to `graceMs`, ends
 * the rest with a retryable error (inference-api/routes.ts drainOpenRequests), then exits.
 */

import type { FastifyInstance } from "fastify";
import { drainOpenRequests, openRequestCount } from "../inference-api/routes.js";

/** How long model calls being answered may run on after SIGTERM/SIGINT (below fly.portal.toml's kill_timeout). */
export const PORTAL_SHUTDOWN_GRACE_MS = 90_000;

export function installGracefulShutdown(
  app: Pick<FastifyInstance, "close" | "log">,
  opts: { graceMs?: number; signals?: Pick<NodeJS.Process, "once">; exit?: (code: number) => void; closeWaitMs?: number } = {},
): { stop: (signal: string) => Promise<void> } {
  const graceMs = opts.graceMs ?? PORTAL_SHUTDOWN_GRACE_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let stopping: Promise<void> | null = null;
  const stop = (signal: string): Promise<void> => {
    if (stopping) return stopping;
    app.log.warn({ signal, openRequests: openRequestCount(), graceMs }, "portal_stopping");
    // Stop accepting first (Fastify answers new requests 503 while closing), then drain.
    const closed = Promise.resolve(app.close()).catch(() => undefined);
    stopping = drainOpenRequests(graceMs)
      .then(async (endedEarly) => {
        app.log.warn({ endedEarly }, "portal_drained");
        await Promise.race([closed, new Promise((r) => setTimeout(r, opts.closeWaitMs ?? 2_000))]);
      })
      .finally(() => exit(0));
    return stopping;
  };
  const signals = opts.signals ?? process;
  signals.once("SIGTERM", () => void stop("SIGTERM"));
  signals.once("SIGINT", () => void stop("SIGINT"));
  return { stop };
}
