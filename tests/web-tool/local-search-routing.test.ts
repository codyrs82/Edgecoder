import { describe, expect, it, vi } from "vitest";
import { CreditEngine } from "../../src/credits/engine.js";
import { WebToolService, type LocalWebBackend, type WebToolConfig, type WebToolDeps } from "../../src/web-tool/service.js";
import { availabilityOf } from "../../src/web-tool/tools.js";
import { ownMachineBasis } from "../../src/web-tool/basis.js";

/*
 * Which path a web call takes (docs/web-tool.md, "Searches on your own machine"):
 *   own machine + its SearXNG answers  -> its results, 0 cSats, no daily cap counted, no Brave call
 *   own machine, SearXNG down / empty  -> the #434 path (free within the daily caps, then paid)
 *   a network chat                     -> Brave, paid; the machine is never asked
 *   a forged claim                     -> no own-machine basis, so neither local nor free
 */

const ACCOUNT = "acct-user-1";
const config: WebToolConfig = { braveApiKey: "test-key", searchCSats: 0.5, readCSats: 0.2, searchesPerHour: 60, readsPerHour: 120, freeSearchesPerDay: 2, freeReadsPerDay: 2, freeGlobalPerDay: 5000 };
const brave = [{ title: "Brave", url: "https://brave.example/", snippet: "b" }];
const local = [{ title: "Local", url: "https://local.example/", snippet: "l" }];

function setup(opts: { local?: Partial<LocalWebBackend>; balance?: number; braveKey?: string } = {}) {
  const engine = new CreditEngine();
  engine.adjust(ACCOUNT, opts.balance ?? 10, "test_grant");
  const search = vi.fn(async () => brave);
  const read = vi.fn(async (url: string) => ({ url, title: "Server", text: "server text", truncated: false, contentType: "text/html" }));
  const backend: LocalWebBackend = {
    available: vi.fn(async () => ({ search: true, read: true })),
    search: vi.fn(async () => local),
    read: vi.fn(async (_a: string, url: string) => ({ url, title: "Local page", text: "local text", truncated: false, contentType: "text/html" })),
    ...opts.local,
  };
  const deps: WebToolDeps = {
    debit: async (acct, cSats, reason) => {
      if (engine.balance(acct) < cSats) throw new Error("insufficient_credits");
      engine.spend(acct, cSats, reason);
    },
    refund: async (acct, cSats, reason) => {
      engine.adjust(acct, cSats, reason);
    },
    balance: async (acct) => engine.balance(acct),
    search,
    read,
    local: backend,
  };
  const svc = new WebToolService({ ...config, braveApiKey: "braveKey" in opts ? opts.braveKey : config.braveApiKey }, deps);
  return { svc, engine, search, read, backend };
}

describe("own machine with SearXNG", () => {
  it("searches there: its results, no cSats, no Brave call, no daily cap counted", async () => {
    const { svc, engine, search, backend } = setup();
    for (let i = 0; i < 5; i++) {
      const r = await svc.search(ACCOUNT, "news today", 5, `r${i}`, { ownMachine: true });
      expect(r).toMatchObject({ ok: true, cSats: 0, free: true, local: true, value: { results: local } });
    }
    expect(search).not.toHaveBeenCalled();
    expect(backend.search).toHaveBeenCalledTimes(5);
    expect(engine.balance(ACCOUNT)).toBe(10);
    // Five searches against a daily cap of two, and the cap is untouched.
    expect(svc.freeLeft(ACCOUNT)).toEqual({ searches: 2, reads: 2 });
  });

  it("reads pages there too, free and uncapped", async () => {
    const { svc, read } = setup();
    const r = await svc.read(ACCOUNT, "https://example.com/a", "p1", { ownMachine: true });
    expect(r).toMatchObject({ ok: true, cSats: 0, free: true, local: true, value: { title: "Local page" } });
    expect(read).not.toHaveBeenCalled();
    expect(svc.freeLeft(ACCOUNT).reads).toBe(2);
  });

  it("asks the calling agent's machine first", async () => {
    const { svc, backend } = setup();
    await svc.search(ACCOUNT, "q", 3, "r", ownMachineBasis({ accountId: ACCOUNT, via: "agent", agentId: "agent-a", ownerAccountId: ACCOUNT }, true));
    expect(backend.search).toHaveBeenCalledWith(ACCOUNT, "q", 3, "agent-a");
  });

  it("works without BRAVE_SEARCH_API_KEY; status says free, local, configured", async () => {
    const { svc } = setup({ braveKey: undefined });
    const st = await svc.status(ACCOUNT, { ownMachine: true });
    expect(st).toMatchObject({ configured: true, free: true, canAfford: true, localSearch: true, localRead: true });
    expect(availabilityOf(st as unknown as Record<string, unknown>)).toEqual({ offer: true, reason: null, free: true, local: true });
    const r = await svc.search(ACCOUNT, "q", 3, "r", { ownMachine: true });
    expect(r).toMatchObject({ ok: true, local: true });
  });

  it("status offers the web even with the daily free searches used and no cSats", async () => {
    const { svc } = setup({ balance: 0, local: { search: async () => null } });
    await svc.search(ACCOUNT, "a", 1, "1", { ownMachine: true });
    await svc.search(ACCOUNT, "b", 1, "2", { ownMachine: true });
    expect(svc.freeLeft(ACCOUNT).searches).toBe(0);
    const st = await svc.status(ACCOUNT, { ownMachine: true });
    expect(st).toMatchObject({ localSearch: true, free: true, canAfford: true, freeSearchesLeftToday: 0 });
    expect(availabilityOf(st as unknown as Record<string, unknown>).offer).toBe(true);
  });
});

describe("own machine, SearXNG down or empty: the #434 fallback", () => {
  for (const [name, impl] of [
    ["no answer", async () => null],
    ["threw", async () => { throw new Error("socket closed"); }],
  ] as const) {
    it(`${name}: free from the daily allowance, then paid`, async () => {
      const { svc, engine, search } = setup({ local: { search: impl as LocalWebBackend["search"] } });
      const r1 = await svc.search(ACCOUNT, "q", 5, "a", { ownMachine: true });
      expect(r1).toMatchObject({ ok: true, cSats: 0, free: true, value: { results: brave } });
      expect((r1 as { local?: true }).local).toBeUndefined();
      expect(svc.freeLeft(ACCOUNT).searches).toBe(1);
      await svc.search(ACCOUNT, "q", 5, "b", { ownMachine: true });
      const r3 = await svc.search(ACCOUNT, "q", 5, "c", { ownMachine: true });
      expect(r3).toMatchObject({ ok: true, cSats: 0.5 });
      expect(search).toHaveBeenCalledTimes(3);
      expect(engine.balance(ACCOUNT)).toBeCloseTo(9.5, 9);
    });
  }

  it("no machine with local search: status is the #434 one (daily counts, no localSearch)", async () => {
    const { svc } = setup({ local: { available: async () => ({ search: false, read: false }) } });
    const st = await svc.status(ACCOUNT, { ownMachine: true });
    expect(st).toMatchObject({ free: true, freeSearchesLeftToday: 2 });
    expect(st).not.toHaveProperty("localSearch");
  });

  it("a local read that fails falls back to the server reader (within the daily caps)", async () => {
    const { svc, read } = setup({ local: { read: async () => null } });
    const r = await svc.read(ACCOUNT, "https://example.com/", "p", { ownMachine: true });
    expect(r).toMatchObject({ ok: true, cSats: 0, free: true, value: { title: "Server" } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(svc.freeLeft(ACCOUNT).reads).toBe(1);
  });
});

describe("network chats and forged claims", () => {
  it("a network chat goes to Brave, paid; the machine is never asked", async () => {
    const { svc, engine, backend } = setup();
    const r = await svc.search(ACCOUNT, "q", 5, "a");
    expect(r).toMatchObject({ ok: true, cSats: 0.5, value: { results: brave } });
    expect(backend.search).not.toHaveBeenCalled();
    expect(backend.available).not.toHaveBeenCalled();
    expect(engine.balance(ACCOUNT)).toBeCloseTo(9.5, 9);
    const st = await svc.status(ACCOUNT);
    expect(st).not.toHaveProperty("localSearch");
  });

  it("a claim from a caller that can't vouch for it gives no own-machine basis: paid Brave", async () => {
    const { svc, backend } = setup();
    // An agent of another account (or an unlinked one) claiming ownMachine.
    for (const caller of [
      { accountId: ACCOUNT, via: "agent" as const, agentId: "stranger", ownerAccountId: "acct-other" },
      { accountId: "stranger", via: "agent" as const, agentId: "stranger", ownerAccountId: null },
    ]) {
      const basis = ownMachineBasis(caller, true);
      expect(basis).toEqual({});
      const r = await svc.search(caller.accountId, "q", 5, `x-${caller.agentId}-${caller.ownerAccountId}`, basis);
      if (r.ok) expect(r.cSats).toBe(0.5);
    }
    expect(backend.search).not.toHaveBeenCalled();
  });

  it("a machine that claims SearXNG but returns nothing gets no free Brave beyond the daily caps", async () => {
    const { svc } = setup({ balance: 0, local: { search: async () => [] as never } });
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await svc.search(ACCOUNT, "q", 5, `k${i}`, { ownMachine: true }));
    expect(outcomes.filter((r) => r.ok).length).toBe(2);
    expect(outcomes.slice(2).every((r) => !r.ok && r.error === "needs_csats")).toBe(true);
  });
});
