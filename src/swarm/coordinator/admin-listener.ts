// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Optional internal-only listener for operator calls (ADMIN_LISTEN_PORT, docs/security/rotation.md).
 *
 * On Fly the coordinator's public port (4301) is bound to IPv4 for the edge proxy, which Fly's
 * private network (6PN, IPv6) cannot reach. With ADMIN_LISTEN_PORT set, the same app is also
 * served on [ADMIN_LISTEN_HOST]:ADMIN_LISTEN_PORT (default host "::"). That port is not in any
 * fly.toml service, so only the private network reaches it; the portal's COORDINATOR_ADMIN_URLS
 * point there (http://<app>.internal:<port>). Admin routes still check the socket address and the
 * token (auth.ts authorizeAdmin), whichever port a request arrives on.
 */
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";

export async function startAdminListener(app: FastifyInstance, port: number, host = "::"): Promise<Server | null> {
  if (!port) return null;
  await app.ready();
  const server = createServer((req, res) => {
    app.server.emit("request", req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The public listener keeps the process alive; this one never holds a shutdown open.
  server.unref();
  app.log.info({ port, host }, "coordinator internal admin listener started");
  return server;
}
