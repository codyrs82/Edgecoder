import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, timingSafeEqual } from "node:crypto";
import { registerPayoutCallbackNotifyRoute, registerPayoutCallbackRoutes, type CallbackChange, type PayoutCallbackClient } from "../../src/portal/routes/payout-callback.js";
import { registerPayoutDestinationRoutes, type PayoutDestinationStore } from "../../src/portal/routes/payout-destination.js";
import { rateLimitFor, WALLET_RATE_LIMIT } from "../../src/portal/security.js";
import type { PayoutDestinationChallenge, PayoutDestinationRecord } from "../../src/portal/store.js";

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const secureCompare = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const DEST = "alice@walletofsatoshi.com";

function memoryStore() {
  const destinations = new Map<string, PayoutDestinationRecord>();
  const challenges = new Map<string, PayoutDestinationChallenge & { consumed?: boolean }>();
  const store: PayoutDestinationStore & { getUserById(id: string): Promise<{ email: string } | null> } = {
    async getPayoutDestination(userId) {
      return destinations.get(userId) ?? null;
    },
    async upsertPayoutDestination(i) {
      destinations.set(i.userId, { ...i, createdAtMs: 1, updatedAtMs: 1 });
    },
    async createPayoutDestinationChallenge(i) {
      challenges.set(i.challengeId, { ...i });
    },
    async consumePayoutDestinationChallenge(id) {
      const c = challenges.get(id);
      if (!c || c.consumed || c.expiresAtMs <= Date.now()) return null;
      c.consumed = true;
      return c;
    },
    async getWalletOnboardingByUserId() {
      return null;
    },
    async getUserById(id) {
      return id === "u1" ? { email: "u1@mail.example" } : null;
    }
  };
  return { store, destinations, challenges };
}

/** Coordinator stand-in holding one pending change, as GET /economy/payouts/:accountId reports it. */
function fakeCoordinator() {
  const state: { change: CallbackChange | null; reachable: boolean } = {
    change: { destination: DEST, previousOrigin: "https://livingroomofsatoshi.com", newOrigin: "https://evil.example", changedAtMs: 5 },
    reachable: true
  };
  const confirm = vi.fn(async (_a: string, destination: string, newOrigin: string) => {
    if (!state.change || state.change.destination !== destination || state.change.newOrigin !== newOrigin) return "not_pending" as const;
    state.change = null;
    return "ok" as const;
  });
  const client: PayoutCallbackClient = {
    async pendingChange(_a, destination) {
      if (!state.reachable) return undefined;
      return state.change && state.change.destination === destination ? state.change : null;
    },
    confirm
  };
  return { state, client, confirm };
}

describe("payment server change: Plan & usage state and the emailed-code confirm", () => {
  let app: FastifyInstance;
  let mem: ReturnType<typeof memoryStore>;
  let coord: ReturnType<typeof fakeCoordinator>;
  let user: { userId: string; email: string } | null;
  const codes: Array<{ email: string; code: string; previousHost: string; newHost: string }> = [];

  beforeEach(async () => {
    mem = memoryStore();
    mem.destinations.set("u1", { userId: "u1", accountId: "acct-u1", kind: "lightning_address", destination: DEST, network: "signet", createdAtMs: 1, updatedAtMs: 1 });
    coord = fakeCoordinator();
    user = { userId: "u1", email: "u1@mail.example" };
    codes.length = 0;
    app = Fastify();
    let n = 200000;
    const common = { store: mem.store, getCurrentUser: async () => user, codeTtlMs: 600_000, emailConfigured: true, generateSixDigitCode: () => String(n++), sha256Hex, secureCompare };
    registerPayoutCallbackRoutes(app, { ...common, client: coord.client, sendCode: async (i) => { codes.push(i); } });
    registerPayoutDestinationRoutes(app, {
      ...common, network: "signet", sendCode: async () => undefined,
      register: async () => ({ controlPlane: "ok", coordinator: "ok" }),
      callbackChange: (a, d) => coord.client.pendingChange(a, d)
    });
    await app.ready();
  });

  const confirm = (payload: object) => app.inject({ method: "POST", url: "/wallet/payout-destination/callback/confirm", payload });

  it("GET /wallet/payout-destination shows the change (the portal card and desktop Credits page read this)", async () => {
    const r = await app.inject({ method: "GET", url: "/wallet/payout-destination" });
    expect(r.json().callbackChange).toEqual({ previousOrigin: "https://livingroomofsatoshi.com", newOrigin: "https://evil.example", changedAtMs: 5 });
    coord.state.change = null;
    expect((await app.inject({ method: "GET", url: "/wallet/payout-destination" })).json().callbackChange).toBeNull();
  });

  it("confirming needs the emailed code, then re-pins on the coordinator", async () => {
    const first = await confirm({});
    expect(first.statusCode).toBe(202);
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ email: "u1@mail.example", previousHost: "livingroomofsatoshi.com", newHost: "evil.example" });
    expect(coord.confirm).not.toHaveBeenCalled();

    const wrong = await confirm({ challengeId: first.json().challengeId, emailCode: "000000" });
    expect(wrong.statusCode).toBe(401);
    expect(coord.confirm).not.toHaveBeenCalled();
    // The wrong attempt used up that challenge.
    expect((await confirm({ challengeId: first.json().challengeId, emailCode: codes[0].code })).statusCode).toBe(400);

    const second = await confirm({});
    const ok = await confirm({ challengeId: second.json().challengeId, emailCode: codes[1].code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, origin: "https://evil.example" });
    expect(coord.confirm).toHaveBeenCalledWith("acct-u1", DEST, "https://evil.example");
  });

  it("a code is bound to the change it was sent for", async () => {
    const first = await confirm({});
    coord.state.change = { ...coord.state.change!, newOrigin: "https://evil2.example" };
    const r = await confirm({ challengeId: first.json().challengeId, emailCode: codes[0].code });
    expect(r.statusCode).toBe(400);
    expect(coord.confirm).not.toHaveBeenCalled();
  });

  it("a destination-change challenge cannot confirm a payment server, and another user's code is refused", async () => {
    mem.challenges.set("dest-challenge-1", { challengeId: "dest-challenge-1", userId: "u1", kind: "lightning_address", destination: DEST, emailCodeHash: sha256Hex("dest-challenge-1:123456"), expiresAtMs: Date.now() + 60_000 });
    expect((await confirm({ challengeId: "dest-challenge-1", emailCode: "123456" })).statusCode).toBe(400);
    const first = await confirm({});
    user = { userId: "u2", email: "u2@mail.example" };
    mem.destinations.set("u2", { ...mem.destinations.get("u1")!, userId: "u2", accountId: "acct-u2" });
    expect((await confirm({ challengeId: first.json().challengeId, emailCode: codes[0].code })).statusCode).toBe(400);
    expect(coord.confirm).not.toHaveBeenCalled();
  });

  it("nothing to confirm, no session, or coordinator unreachable", async () => {
    user = null;
    expect((await confirm({})).statusCode).toBe(401);
    user = { userId: "u1", email: "u1@mail.example" };
    coord.state.reachable = false;
    expect((await confirm({})).statusCode).toBe(503);
    coord.state.reachable = true;
    coord.state.change = null;
    expect((await confirm({})).statusCode).toBe(409);
    expect(codes).toHaveLength(0);
  });

  it("is rate limited like the other wallet code routes", () => {
    expect(rateLimitFor("/wallet/payout-destination/callback/confirm", "POST")).toEqual(WALLET_RATE_LIMIT);
  });
});

describe("POST /internal/payouts/callback-changed (coordinator -> portal notice)", () => {
  let app: FastifyInstance;
  let coord: ReturnType<typeof fakeCoordinator>;
  let sent: Array<{ email: string; destination: string; previousHost: string; newHost: string }>;
  let emailResult: "sent" | "not_configured" | "throw";

  beforeEach(async () => {
    const mem = memoryStore();
    mem.destinations.set("u1", { userId: "u1", accountId: "acct-u1", kind: "lightning_address", destination: DEST, network: "signet", createdAtMs: 1, updatedAtMs: 1 });
    coord = fakeCoordinator();
    sent = [];
    emailResult = "sent";
    app = Fastify();
    registerPayoutCallbackNotifyRoute(app, {
      store: mem.store,
      client: coord.client,
      sendNotice: async (i) => {
        if (emailResult === "throw") throw new Error("resend down");
        if (emailResult === "not_configured") return false;
        sent.push(i);
        return true;
      }
    });
    await app.ready();
  });

  const notify = (payload: object) => app.inject({ method: "POST", url: "/internal/payouts/callback-changed", payload });

  it("emails the owner the hosts it re-read from the coordinator, not the ones in the request", async () => {
    const r = await notify({ accountId: "acct-u1", destination: DEST, previousOrigin: "https://x.example", newOrigin: "https://y.example" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ emailed: true });
    expect(sent).toEqual([{ email: "u1@mail.example", destination: DEST, previousHost: "livingroomofsatoshi.com", newHost: "evil.example" }]);
  });

  it("sends nothing without a pending change or a portal destination; a send failure asks the coordinator to retry", async () => {
    coord.state.change = null;
    expect((await notify({ accountId: "acct-u1" })).json()).toMatchObject({ emailed: false, reason: "no_pending_change" });
    expect((await notify({ accountId: "acct-nobody" })).json()).toMatchObject({ emailed: false, reason: "no_portal_destination" });
    expect((await notify({ accountId: "host-1" })).statusCode).toBe(400);
    coord.state.change = { destination: DEST, previousOrigin: "https://a.example", newOrigin: "https://b.example" };
    emailResult = "throw";
    expect((await notify({ accountId: "acct-u1" })).statusCode).toBe(502);
    emailResult = "not_configured";
    expect((await notify({ accountId: "acct-u1" })).json()).toMatchObject({ emailed: false, reason: "email_not_configured" });
    expect(sent).toEqual([]);
  });
});
