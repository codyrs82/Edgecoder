// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply } from "fastify";

/**
 * Start a Server-Sent Events response on the raw socket, keeping the headers already set on the
 * reply (CORS from @fastify/cors in particular). Writing the head by hand without them made the
 * desktop app's webview refuse every stream ("Load failed"), while curl and the dev proxy worked.
 */
export function writeSseHead(reply: FastifyReply): void {
  const kept: Record<string, string | number | string[]> = {};
  for (const [k, v] of Object.entries(reply.getHeaders())) {
    if (v !== undefined && k.toLowerCase() !== "content-length") kept[k] = v as string | number | string[];
  }
  reply.raw.writeHead(200, {
    ...kept,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}
