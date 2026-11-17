import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createInternalAuth } from "../../src/portal/internal-auth.js";
import { QUIET_ROUTE } from "../../src/portal/quiet-routes.js";
import { registerInternalRoutes } from "../../src/portal/routes/internal.js";

// Coordinators call /internal/nodes/validate and /lookup several times a second; their request lines
// pushed useful lines (portal_web_decision) out of the short `fly logs` buffer. They no longer log at
// info; refused tokens and server errors still log at warn.

const store = {
  getNodeEnrollment: async () => null,
  getNodeEnrollmentByDeviceId: async () => null,
  getNodeEnrollmentByRegistrationTokenHash: async () => null,
  listPendingNodeApprovals: async () => [],
};

async function app() {
  const logs: Array<Record<string, unknown>> = [];
  const auth = createInternalAuth({ serviceToken: "svc", coordinatorToken: "coord", adminToken: "adm", allowOpenWhenUnset: false });
  const a = Fastify({ logger: { level: "info", stream: { write: (line: string) => void logs.push(JSON.parse(line)) } } });
  await a.register(async (internal) => {
    registerInternalRoutes(internal, { ...auth, store, sha256Hex: (s: string) => s, secureCompare: (x: string, y: string) => x === y, deriveIosDeviceIdFromNodeId: () => undefined, resolveIpIntelligence: async () => ({}), hostApprovedFor: async () => true } as never);
  });
  a.get("/health", QUIET_ROUTE, async () => ({ ok: true }));
  a.get("/other", async () => ({ ok: true }));
  return { a, logs };
}

const forUrl = (logs: Array<Record<string, unknown>>, url: string) => logs.filter((l) => JSON.stringify(l).includes(url));

describe("quiet routes", () => {
  it("validate (404), lookup and /health write no info lines", async () => {
    const { a, logs } = await app();
    const headers = { "content-type": "application/json", "x-portal-service-token": "coord" };
    expect((await a.inject({ method: "POST", url: "/internal/nodes/validate", headers, payload: { nodeId: "n-1", nodeKind: "agent", registrationToken: "tok-unknown-1" } })).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: "/internal/nodes/lookup", headers, payload: { nodeIds: ["n-1"] } })).statusCode).toBe(200);
    expect((await a.inject({ url: "/health" })).statusCode).toBe(200);
    expect(forUrl(logs, "/internal/nodes/validate")).toEqual([]);
    expect(forUrl(logs, "/internal/nodes/lookup")).toEqual([]);
    expect(forUrl(logs, "/health")).toEqual([]);
    // Other routes still log their requests.
    await a.inject({ url: "/other" });
    expect(forUrl(logs, "/other").some((l) => l.level === 30)).toBe(true);
  });

  it("a refused token on a quiet route still logs, at warn", async () => {
    const { a, logs } = await app();
    expect((await a.inject({ method: "POST", url: "/internal/nodes/validate", headers: { "x-portal-service-token": "wrong" }, payload: {} })).statusCode).toBe(401);
    const lines = forUrl(logs, "/internal/nodes/validate");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, msg: "quiet_route_refused", statusCode: 401 });
  });
});
