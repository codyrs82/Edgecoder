// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";

/** #16: /.well-known/* for the iOS app (passkey webcredentials). Moved unchanged from server.ts. */
export function registerWellKnownRoutes(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  const IOS_APP_TEAM_ID = env.IOS_APP_TEAM_ID ?? "63CL88WY7G";
  const IOS_APP_BUNDLE_ID = env.IOS_APP_BUNDLE_ID ?? "io.edgecoder.ios";
  app.get("/.well-known/apple-app-site-association", async (_req, reply) => {
    const aasa = {
      webcredentials: {
        apps: [`${IOS_APP_TEAM_ID}.${IOS_APP_BUNDLE_ID}`]
      }
    };
    return reply.type("application/json").send(aasa);
  });
}
