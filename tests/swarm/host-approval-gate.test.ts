import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Subtask } from "../../src/common/types.js";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

// Imported in beforeAll, after PORTAL_SERVICE_URL is set (the coordinator reads it at import).
let claimRule: typeof import("../../src/swarm/coordinator/dispatch.js").claimRule;
let agentCapabilities: typeof import("../../src/swarm/coordinator/agent-state.js").agentCapabilities;
let refreshHostApprovals: typeof import("../../src/swarm/coordinator/enrollment.js").refreshHostApprovals;

/*
 * Hosting by request (src/portal/host-requests.ts): the portal says per node whether its owner is an
 * approved host. A coordinator lets an agent whose owner is not approved run only its owner's own work
 * ("My machines"): no other account's job, no reservation. Agents the portal says nothing about
 * (older portal, no portal, loopback) are not restricted. An admin's approval reaches registered agents
 * through refreshHostApprovals without a re-registration.
 */

const MESH = "mesh-secret-host-gate";
const REMOTE = "203.0.113.77";
let portal: Server;
let app: any;
const unapproved = createPeerKeys("agent-host-gate-unapproved");
const approved = createPeerKeys("agent-host-gate-approved");
const legacy = createPeerKeys("agent-host-gate-legacy");
const TOKENS: Record<string, { hostApproved?: boolean }> = {
  "token-unapproved-host": { hostApproved: false },
  "token-approved-host": { hostApproved: true },
  "token-legacy-portal": {}
};

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const t = TOKENS[body.registrationToken as string];
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/internal/nodes/validate" && t) {
        res.end(JSON.stringify({ allowed: true, reason: "ok", node: { nodeId: body.nodeId, ...t } }));
      } else {
        res.end(JSON.stringify({ allowed: false, reason: "invalid_token" }));
      }
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  ({ claimRule } = await import("../../src/swarm/coordinator/dispatch.js"));
  ({ agentCapabilities } = await import("../../src/swarm/coordinator/agent-state.js"));
  ({ refreshHostApprovals } = await import("../../src/swarm/coordinator/enrollment.js"));
  await register(unapproved, "token-unapproved-host");
  await register(approved, "token-approved-host");
  await register(legacy, "token-legacy-portal");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

async function register(keys: PeerKeys, token: string) {
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: token, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker" });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

function job(id: string, meta: { onlyAccountId?: string; reservationId?: string } = {}): Subtask {
  return {
    id,
    taskId: `task-${id}`,
    kind: "inference",
    language: "python",
    input: "hello",
    timeoutMs: 60_000,
    snapshotRef: "inference",
    projectMeta: { projectId: "p", resourceClass: "cpu", priority: 10, ...meta }
  };
}

const can = (agentId: string, owner: string | undefined, st: Subtask) => claimRule(agentId, agentCapabilities.get(agentId), owner)(st);

describe("host approval gate on the coordinator", () => {
  test("registration records the portal's answer; a portal that does not say leaves the agent unrestricted", () => {
    expect(agentCapabilities.get(unapproved.peerId)?.hostApproved).toBe(false);
    expect(agentCapabilities.get(approved.peerId)?.hostApproved).toBe(true);
    expect(agentCapabilities.get(legacy.peerId)?.hostApproved).toBeUndefined();
  });

  test("an agent of an unapproved host runs its owner's own work and nothing else", () => {
    const id = unapproved.peerId;
    expect(can(id, "acct-owner", job("own-1", { onlyAccountId: "acct-owner" }))).toBe(true);
    // Nudge targeting does not know the puller's account yet; the signed /pull checks it.
    expect(can(id, undefined, job("own-2", { onlyAccountId: "acct-owner" }))).toBe(true);
    expect(can(id, "acct-owner", job("other-own", { onlyAccountId: "acct-someone-else" }))).toBe(false);
    expect(can(id, "acct-owner", job("network-1"))).toBe(false);
    expect(can(id, undefined, job("network-2"))).toBe(false);
    expect(can(id, "acct-owner", job("lease-1", { reservationId: "r-1" }))).toBe(false);
  });

  test("approved and unrestricted agents keep their own work as before", () => {
    for (const id of [approved.peerId, legacy.peerId]) {
      expect(can(id, "acct-owner", job(`own-${id}`, { onlyAccountId: "acct-owner" }))).toBe(true);
      expect(can(id, "acct-owner", job(`other-${id}`, { onlyAccountId: "acct-x" }))).toBe(false);
    }
  });

  test("an admin's approval or revocation reaches registered agents without re-registering", async () => {
    const lookups: string[][] = [];
    const changed = await refreshHostApprovals(async (ids) => {
      lookups.push(ids);
      return ids.map((nodeId) => ({ nodeId, hostApproved: nodeId === unapproved.peerId ? true : nodeId === approved.peerId ? false : undefined }));
    });
    // Only agents the portal gave an answer for are looked up again.
    expect(lookups.flat()).toContain(unapproved.peerId);
    expect(lookups.flat()).toContain(approved.peerId);
    expect(lookups.flat()).not.toContain(legacy.peerId);
    expect(changed.sort()).toEqual([approved.peerId, unapproved.peerId].sort());
    expect(agentCapabilities.get(unapproved.peerId)?.hostApproved).toBe(true);
    expect(can(approved.peerId, "acct-owner", job("network-after-revoke"))).toBe(false);
    // A failed lookup changes nothing.
    expect(await refreshHostApprovals(async () => { throw new Error("portal down"); })).toEqual([]);
    expect(agentCapabilities.get(unapproved.peerId)?.hostApproved).toBe(true);
  });
});
