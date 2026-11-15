import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { directWorkAccountDecision, workerAcceptsDirectWorkOffer } from "../../src/swarm/direct-work-policy.js";

/*
 * Direct work (agent-to-agent offers the coordinator relays) is unpaid, so it is allowed only between
 * agents of the same verified account. Cross-account work goes through the coordinator market.
 * Accounts come from the coordinator's ownership mapping (mocked here), never from the request.
 */

const accounts = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/swarm/coordinator/agent-accounts.js", () => ({
  verifiedAccountOf: async (agentId: string) => accounts.get(agentId) ?? null
}));

const VALID_TOKEN = "valid-registration-token";
let portal: Server;
let app: any;
const mine1 = createPeerKeys("agent-sa-mine-1");
const mine2 = createPeerKeys("agent-sa-mine-2");
const other = createPeerKeys("agent-sa-other");
// No ownership row; its id is chosen to equal mine's account id.
const squatter = createPeerKeys("acct-sa-mine");

function post(keys: PeerKeys, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  const headers = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: "203.0.113.77", headers: { "content-type": "application/json", ...headers }, payload });
}

beforeAll(async () => {
  accounts.set(mine1.peerId, "acct-sa-mine");
  accounts.set(mine2.peerId, "acct-sa-mine");
  accounts.set(other.peerId, "acct-sa-other");
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.registrationToken === VALID_TOKEN ? { allowed: true, reason: "ok", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = "mesh-secret-sa";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [mine1, mine2, other, squatter]) {
    const res = await post(keys, "/register", { os: "macos", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, localModelEnabled: true });
    expect(res.statusCode).toBe(200);
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

const offer = (from: PeerKeys, to: PeerKeys) => ({ fromAgentId: from.peerId, toAgentId: to.peerId, workType: "code_task", language: "python", input: "print(1)" });

describe("direct work is same-account only (coordinator relay)", () => {
  test("an offer to another account's agent is refused and points at the market", async () => {
    const res = await post(other, "/agent-mesh/direct-work/offer", offer(other, mine1));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "direct_work_cross_account", market: "/submit" });
    expect(res.json().message).toMatch(/market/);
    const hb = await post(mine1, "/heartbeat", { agentId: mine1.peerId });
    expect(hb.json().directWorkOffers).toEqual([]);
  });

  test("a model request to another account's agent is refused too", async () => {
    const res = await post(other, "/agent-mesh/models/request", { fromAgentId: other.peerId, toAgentId: mine1.peerId, prompt: "hi" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("direct_work_cross_account");
  });

  test("an agent without a verified account can't offer work, even under an id equal to an account id", async () => {
    const res = await post(squatter, "/agent-mesh/direct-work/offer", offer(squatter, mine1));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("direct_work_account_unverified");
  });

  test("agents of one account share work; the target's heartbeat names the account", async () => {
    const res = await post(mine1, "/agent-mesh/direct-work/offer", offer(mine1, mine2));
    expect(res.statusCode).toBe(200);
    const hb = await post(mine2, "/heartbeat", { agentId: mine2.peerId });
    const offers = hb.json().directWorkOffers as Array<{ offerId: string; fromAccountId?: string }>;
    expect(offers.map((o) => o.offerId)).toContain(res.json().offerId);
    expect(offers.every((o) => o.fromAccountId === "acct-sa-mine")).toBe(true);
    expect((await post(mine2, "/agent-mesh/direct-work/accept", { offerId: res.json().offerId, byAgentId: mine2.peerId })).statusCode).toBe(200);
  });

  test("accepting re-checks the accounts (the target changed hands after the offer)", async () => {
    const res = await post(mine1, "/agent-mesh/direct-work/offer", offer(mine1, mine2));
    expect(res.statusCode).toBe(200);
    accounts.set(mine2.peerId, "acct-sa-new-owner");
    try {
      const accept = await post(mine2, "/agent-mesh/direct-work/accept", { offerId: res.json().offerId, byAgentId: mine2.peerId });
      expect(accept.statusCode).toBe(403);
      expect(accept.json().error).toBe("direct_work_cross_account");
    } finally {
      accounts.set(mine2.peerId, "acct-sa-mine");
    }
  });
});

describe("direct work policy", () => {
  test("coordinator: both accounts verified and equal", () => {
    expect(directWorkAccountDecision("a", "a")).toEqual({ ok: true, accountId: "a" });
    expect(directWorkAccountDecision("a", "b")).toEqual({ ok: false, error: "direct_work_cross_account" });
    expect(directWorkAccountDecision(null, "a")).toEqual({ ok: false, error: "direct_work_account_unverified" });
  });

  test("worker: runs only offers the coordinator says come from its own account", () => {
    const none = () => false;
    expect(workerAcceptsDirectWorkOffer({ fromAgentId: "x", fromAccountId: "acct-me" }, "acct-me", none)).toEqual({ ok: true });
    expect(workerAcceptsDirectWorkOffer({ fromAgentId: "x", fromAccountId: "acct-them" }, "acct-me", none)).toEqual({ ok: false, reason: "cross_account" });
    // A coordinator that predates the check sends no account: refused.
    expect(workerAcceptsDirectWorkOffer({ fromAgentId: "x" }, "acct-me", none)).toEqual({ ok: false, reason: "no_sender_account" });
    expect(workerAcceptsDirectWorkOffer({ fromAgentId: "x", fromAccountId: "acct-me" }, "acct-me", () => true)).toEqual({ ok: false, reason: "sender_blacklisted" });
  });
});
