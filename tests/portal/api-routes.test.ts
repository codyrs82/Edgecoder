import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { portalServer } from "../../src/portal/server.js";

// #16: the API routes moved out of server.ts into src/portal/routes/ must all still be registered,
// on the same method and path. This table is every app./internal. route server.ts had before the split.
const API_ROUTES: Array<[string, string]> = [
  ["GET", "/health"],
  ["GET", "/.well-known/apple-app-site-association"],
  ["GET", "/auth/capabilities"],
  ["POST", "/auth/signup"],
  ["POST", "/auth/login"],
  ["POST", "/auth/logout"],
  ["GET", "/auth/verify-email"],
  ["POST", "/auth/resend-verification"],
  ["GET", "/auth/oauth/apple/start"],
  ["GET", "/auth/oauth/apple/callback"],
  ["POST", "/auth/oauth/apple/callback"],
  ["GET", "/auth/oauth/:provider/start"],
  ["GET", "/auth/oauth/:provider/callback"],
  ["POST", "/auth/oauth/:provider/callback"],
  ["GET", "/portal/api/github/status"],
  ["GET", "/portal/api/github/token"],
  ["DELETE", "/portal/api/github/disconnect"],
  ["POST", "/auth/oauth/mobile/complete"],
  ["POST", "/auth/passkey/register/options"],
  ["POST", "/auth/passkey/register/verify"],
  ["POST", "/auth/passkey/login/options"],
  ["POST", "/auth/passkey/login/verify"],
  ["GET", "/wallet/onboarding"],
  ["POST", "/wallet/onboarding/setup-seed"],
  ["POST", "/wallet/onboarding/acknowledge"],
  ["GET", "/wallet/send/requests"],
  ["POST", "/wallet/send/mfa/start"],
  ["POST", "/wallet/send/mfa/confirm"],
  ["GET", "/ios/dashboard"],
  ["GET", "/ios/agents/:agentId/contribution"],
  ["GET", "/me"],
  ["POST", "/me/theme"],
  ["GET", "/portal/api/admin/users"],
  ["POST", "/portal/api/admin/users/:userId/role"],
  ["POST", "/nodes/enroll"],
  ["DELETE", "/nodes/:nodeId"],
  ["GET", "/nodes/discover-coordinator"],
  ["GET", "/nodes/me"],
  ["GET", "/dashboard/summary"],
  ["GET", "/dashboard/network-insights"],
  ["GET", "/coordinator/ops/summary"],
  ["GET", "/coordinator/ops/agent-diagnostics"],
  ["POST", "/coordinator/ops/node-approval"],
  ["POST", "/coordinator/ops/coordinator-ollama"],
  ["POST", "/coordinator/ops/agents-model"],
  ["GET", "/portal/api/conversations"],
  ["POST", "/portal/api/conversations"],
  ["GET", "/portal/api/conversations/:id/messages"],
  ["PATCH", "/portal/api/conversations/:id"],
  ["DELETE", "/portal/api/conversations/:id"],
  ["GET", "/portal/api/models"],
  ["POST", "/portal/api/chat"],
  ["GET", "/portal/api/reviews"],
  ["GET", "/portal/api/reviews/:taskId"],
  ["POST", "/portal/api/reviews/:taskId/decision"],
  ["POST", "/internal/nodes/validate"],
  ["POST", "/internal/nodes/:nodeId/approval"],
  ["POST", "/internal/nodes/lookup"],
  ["GET", "/internal/nodes/pending"],
  ["GET", "/internal/stats/counts"],
  ["GET", "/portal/api/escalations"],
  ["GET", "/portal/api/escalations/pending-count"],
  ["GET", "/portal/api/escalations/:id"],
  ["POST", "/portal/api/escalations/:id/respond"],
];

describe("portal API routes after the #16 split", () => {
  it("registers every route that server.ts used to", async () => {
    await portalServer.ready();
    const missing = API_ROUTES.filter(([method, url]) => !portalServer.hasRoute({ method: method as "GET", url }));
    expect(missing).toEqual([]);
  });

  // Still over the limit, split in a later #16 slice. Remove an entry once its file is split.
  const NOT_YET_SPLIT = new Set(["src/portal/store.ts"]);

  it("keeps every portal source file under 1,000 lines", () => {
    const dirs = ["src/portal", "src/portal/routes", "src/portal/pages"];
    const tooLong: string[] = [];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
        const lines = readFileSync(`${dir}/${name}`, "utf8").split("\n").length;
        if (lines > 1000 && !NOT_YET_SPLIT.has(`${dir}/${name}`)) tooLong.push(`${dir}/${name}: ${lines}`);
      }
    }
    expect(tooLong).toEqual([]);
  });
});
