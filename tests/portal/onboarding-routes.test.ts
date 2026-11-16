import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyOnboardingPatch, registerOnboardingRoutes, type OnboardingStore } from "../../src/portal/routes/onboarding.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

type U = { userId: string; email: string; createdAtMs: number };
const USERS: Record<string, U> = {
  alice: { userId: "u_alice", email: "alice@example.org", createdAtMs: NOW - DAY },
  bob: { userId: "u_bob", email: "bob@example.org", createdAtMs: NOW - 90 * DAY }
};

function memoryStore(over: Partial<OnboardingStore> = {}) {
  const rows = new Map<string, unknown>();
  const store: OnboardingStore = {
    async getOnboardingState(userId) {
      return rows.has(userId) ? JSON.parse(JSON.stringify(rows.get(userId))) : null;
    },
    async saveOnboardingState(userId, state) {
      rows.set(userId, JSON.parse(JSON.stringify(state)));
    },
    async listNodesByOwner(userId) {
      return userId === "u_bob"
        ? [
            { nodeKind: "agent", active: true, lastSeenMs: NOW - 60_000 },
            { nodeKind: "agent", active: true, lastSeenMs: NOW - 3 * DAY },
            { nodeKind: "coordinator", active: true, lastSeenMs: NOW }
          ]
        : [];
    },
    async countApiKeys(userId) {
      return userId === "u_bob" ? 2 : 0;
    },
    async getGitHubToken(userId) {
      return userId === "u_bob" ? { accessToken: "x" } : null;
    },
    async listConversations(userId) {
      return userId === "u_bob" ? [{}] : [];
    },
    async hasHostRequestFrom(email) {
      return email === "bob@example.org";
    },
    ...over
  };
  return { store, rows };
}

async function appWith(store: OnboardingStore | null, balance: (id: string) => Promise<number | null> = async (id) => (id === "u_bob" ? 420 : 0)) {
  const app = Fastify();
  registerOnboardingRoutes(app, {
    store,
    getCurrentUser: async (req) => USERS[String(req.headers["x-user"] ?? "")] ?? null,
    balanceCSats: balance,
    hostApproved: async (email) => email === "bob@example.org",
    now: () => NOW
  });
  await app.ready();
  return app;
}

describe("GET/POST /portal/api/onboarding", () => {
  it("needs a session", async () => {
    const app = await appWith(memoryStore().store);
    expect((await app.inject({ url: "/portal/api/onboarding" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/portal/api/onboarding", payload: { goal: "own" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/portal/api/onboarding", headers: { "x-user": "mallory" } })).statusCode).toBe(401);
  });

  it("answers 503 without a database", async () => {
    const app = await appWith(null);
    expect((await app.inject({ url: "/portal/api/onboarding", headers: { "x-user": "alice" } })).statusCode).toBe(503);
  });

  it("a new account with nothing set up: no state yet, shown", async () => {
    const app = await appWith(memoryStore().store);
    const r = (await app.inject({ url: "/portal/api/onboarding", headers: { "x-user": "alice" } })).json();
    expect(r.state).toBeNull();
    expect(r.show).toBe(true);
    expect(r.signals).toEqual({
      machines: 0, machinesOnline: 0, balanceCSats: 0, apiKeys: 0, github: false, firstTask: false,
      hostApproved: false, hostRequested: false, newAccount: true, localModels: null, cliInstalled: null
    });
  });

  it("reads real state: machines (agents only), online, balance, keys, GitHub, first task, hosting", async () => {
    const app = await appWith(memoryStore().store);
    const r = (await app.inject({ url: "/portal/api/onboarding", headers: { "x-user": "bob" } })).json();
    expect(r.signals).toMatchObject({ machines: 2, machinesOnline: 1, balanceCSats: 420, apiKeys: 2, github: true, firstTask: true, hostApproved: true, hostRequested: true, newAccount: false });
    // An older account with machines and funds and no saved progress is not interrupted.
    expect(r.show).toBe(false);
  });

  it("a failing lookup reads as unknown, never as done", async () => {
    const { store } = memoryStore({
      countApiKeys: async () => {
        throw new Error("db down");
      },
      getGitHubToken: async () => {
        throw new Error("db down");
      }
    });
    const app = await appWith(store, async () => null);
    const r = (await app.inject({ url: "/portal/api/onboarding", headers: { "x-user": "alice" } })).json();
    expect(r.signals).toMatchObject({ apiKeys: null, github: null, balanceCSats: null });
  });

  it("keeps progress per account: saved, resumed, dismissed, reopened", async () => {
    const { store, rows } = memoryStore();
    const app = await appWith(store);
    const post = (user: string, payload: unknown) => app.inject({ method: "POST", url: "/portal/api/onboarding", headers: { "x-user": user }, payload: payload as object });
    let r = (await post("alice", { goal: "both", current: "machines", done: ["welcome", "how"] })).json();
    expect(r.state).toMatchObject({ goal: "both", current: "machines", done: ["welcome", "how"], firstSeenAtMs: NOW, dismissed: false });
    expect(r.show).toBe(true);
    // Bob's row is his own.
    expect((await app.inject({ url: "/portal/api/onboarding", headers: { "x-user": "bob" } })).json().state).toBeNull();
    expect([...rows.keys()]).toEqual(["u_alice"]);
    r = (await post("alice", { dismissed: true })).json();
    expect(r.state.dismissed).toBe(true);
    expect(r.show).toBe(false);
    r = (await app.inject({ url: "/portal/api/onboarding", headers: { "x-user": "alice" } })).json();
    expect(r.state).toMatchObject({ goal: "both", current: "machines", dismissed: true });
    r = (await post("alice", { dismissed: false, firstTask: true })).json();
    expect(r.state.firstTaskAtMs).toBe(NOW);
    r = (await post("alice", { completed: true })).json();
    expect(r.state.completedAtMs).toBe(NOW);
    expect(r.show).toBe(false);
    r = (await post("alice", { reset: true })).json();
    expect(r.state).toMatchObject({ goal: null, done: [], completedAtMs: null, firstTaskAtMs: NOW, firstSeenAtMs: NOW });
  });

  it("refuses unknown fields and values", async () => {
    const app = await appWith(memoryStore().store);
    for (const payload of [{ goal: "rich" }, { current: "nowhere" }, { done: ["fund", "x"] }, { userId: "u_bob" }, { firstTask: false }]) {
      const res = await app.inject({ method: "POST", url: "/portal/api/onboarding", headers: { "x-user": "alice" }, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("applyOnboardingPatch keeps step order and the first-seen time", () => {
    const a = applyOnboardingPatch(null, { done: ["fund", "welcome"] }, NOW);
    expect(a.done).toEqual(["welcome", "fund"]);
    const b = applyOnboardingPatch(a, { completed: true }, NOW + 5);
    expect(b.firstSeenAtMs).toBe(NOW);
    expect(applyOnboardingPatch(b, { completed: true }, NOW + 9).completedAtMs).toBe(NOW + 5);
  });
});
