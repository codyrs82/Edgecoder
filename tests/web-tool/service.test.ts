import { describe, expect, it, vi } from "vitest";
import { CreditEngine } from "../../src/credits/engine.js";
import { DailyCounter, HourlyLimiter, NOT_CONFIGURED_MESSAGE, WebToolService, webToolConfigFromEnv, type WebToolConfig, type WebToolDeps } from "../../src/web-tool/service.js";
import { PageFetchError } from "../../src/web-tool/fetch-page.js";

const ACCOUNT = "acct-user-1";
const config: WebToolConfig = { braveApiKey: "test-key", searchCSats: 0.5, readCSats: 0.2, searchesPerHour: 3, readsPerHour: 2, freeSearchesPerDay: 100, freeReadsPerDay: 200, freeGlobalPerDay: 5000 };

/** The ledger as the coordinator uses it, in memory: debits and idempotent refunds on one engine. */
function ledger(start = 10) {
  const engine = new CreditEngine();
  engine.adjust(ACCOUNT, start, "test_grant");
  const refunded = new Set<string>();
  const deps: WebToolDeps = {
    debit: async (acct, cSats, reason, key) => {
      if (engine.balance(acct) < cSats) throw new Error(`insufficient_credits: ${engine.balance(acct)} < ${cSats}`);
      const tx = engine.spend(acct, cSats, reason);
      tx.txId = key;
    },
    refund: async (acct, cSats, reason, key) => {
      if (refunded.has(key)) return;
      refunded.add(key);
      engine.adjust(acct, cSats, reason);
    },
    balance: async (acct) => engine.balance(acct),
  };
  return { engine, deps };
}

const results = [{ title: "R", url: "https://r.example/", snippet: "s" }];

describe("web tool billing", () => {
  it("debits each search and page read with a clear reason; the balance falls by exactly what the calls cost", async () => {
    const { engine, deps } = ledger(10);
    const svc = new WebToolService(config, { ...deps, search: async () => results, read: async (url) => ({ url, title: "T", text: "x", truncated: false, contentType: "text/html" }) });
    const r1 = await svc.search(ACCOUNT, "q", 5, "a");
    const r2 = await svc.search(ACCOUNT, "q2", 5, "b");
    const r3 = await svc.read(ACCOUNT, "https://r.example/", "c");
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, true]);
    const charged = [r1, r2, r3].reduce((s, r) => s + (r.ok ? r.cSats : 0), 0);
    expect(charged).toBeCloseTo(1.2, 9);
    expect(engine.balance(ACCOUNT)).toBeCloseTo(10 - 1.2, 9);
    const spends = engine.history(ACCOUNT).filter((t) => t.type === "spend");
    expect(spends.map((t) => t.reason)).toEqual(["tool:web_search", "tool:web_search", "tool:read_page"]);
    // Conservation: what went out of the account is what the calls report.
    expect(spends.reduce((s, t) => s + Number(t.credits), 0)).toBeCloseTo(charged, 9);
  });

  it("refunds a failed call in full: it costs nothing", async () => {
    const { engine, deps } = ledger(5);
    const svc = new WebToolService(config, {
      ...deps,
      search: async () => {
        throw Object.assign(new Error("The search service answered HTTP 500."), { status: 500 });
      },
      read: async () => {
        throw new PageFetchError("That address can't be read.", "blocked_url");
      },
    });
    const s = await svc.search(ACCOUNT, "q", 5, "a");
    const r = await svc.read(ACCOUNT, "http://10.0.0.1/", "b");
    expect(s).toMatchObject({ ok: false, status: 502 });
    expect(r).toMatchObject({ ok: false, status: 422, error: "blocked_url" });
    expect(engine.balance(ACCOUNT)).toBeCloseTo(5, 9);
    expect(engine.history(ACCOUNT).filter((t) => t.reason.endsWith("_refund")).map((t) => t.reason)).toEqual(["tool:web_search_refund", "tool:read_page_refund"]);
  });

  it("with no balance the call is refused as needs_csats and nothing runs", async () => {
    const { engine, deps } = ledger(0.1);
    const search = vi.fn(async () => results);
    const svc = new WebToolService(config, { ...deps, search });
    expect(await svc.search(ACCOUNT, "q", 5, "a")).toMatchObject({ ok: false, status: 402, error: "needs_csats" });
    expect(search).not.toHaveBeenCalled();
    expect(engine.balance(ACCOUNT)).toBeCloseTo(0.1, 9);
    expect((await svc.status(ACCOUNT)).canAfford).toBe(false);
  });
});

describe("web tool limits", () => {
  it("allows N searches an hour per account, then 429 until the window passes; other accounts unaffected", async () => {
    let now = 1_000_000;
    const { deps } = ledger(100);
    const svc = new WebToolService(config, { ...deps, search: async () => results, now: () => now });
    for (const id of ["1", "2", "3"]) expect((await svc.search(ACCOUNT, "q", 5, id)).ok).toBe(true);
    const over = await svc.search(ACCOUNT, "q", 5, "4");
    expect(over).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
    expect((await svc.status(ACCOUNT)).searchesLeftThisHour).toBe(0);
    now += 3_600_001;
    expect((await svc.search(ACCOUNT, "q", 5, "5")).ok).toBe(true);
  });

  it("a refused (unpaid) call doesn't use up the hour", () => {
    const l = new HourlyLimiter(1);
    expect(l.take("a", 0)).toBe(true);
    l.untake("a");
    expect(l.take("a", 1)).toBe(true);
    expect(l.take("a", 2)).toBe(false);
    expect(l.take("b", 2)).toBe(true);
  });

  it("page reads have their own limit", async () => {
    const { deps } = ledger(100);
    const svc = new WebToolService(config, { ...deps, read: async (url) => ({ url, title: "", text: "", truncated: false, contentType: "text/plain" }) });
    expect((await svc.read(ACCOUNT, "https://a.example/", "1")).ok).toBe(true);
    expect((await svc.read(ACCOUNT, "https://a.example/", "2")).ok).toBe(true);
    expect(await svc.read(ACCOUNT, "https://a.example/", "3")).toMatchObject({ status: 429 });
  });
});

describe("without BRAVE_SEARCH_API_KEY", () => {
  it("the tool is off: status says so and calls are refused before any charge", async () => {
    const { engine, deps } = ledger(10);
    const search = vi.fn(async () => results);
    const svc = new WebToolService(webToolConfigFromEnv({}), { ...deps, search });
    expect(svc.configured).toBe(false);
    expect(await svc.status(ACCOUNT)).toMatchObject({ configured: false, message: NOT_CONFIGURED_MESSAGE, searchCSats: 0.5, readCSats: 0.2 });
    expect(await svc.search(ACCOUNT, "q", 5, "a")).toEqual({ ok: false, status: 503, error: "web_search_not_configured", message: "Web search isn't set up yet" });
    expect(await svc.read(ACCOUNT, "https://a.example/", "b")).toMatchObject({ status: 503 });
    expect(search).not.toHaveBeenCalled();
    expect(engine.balance(ACCOUNT)).toBe(10);
  });

  it("defaults: 0.5 cSats a search, 0.2 a page, 60 searches and 120 reads an hour", () => {
    expect(webToolConfigFromEnv({ BRAVE_SEARCH_API_KEY: " k " })).toEqual({ braveApiKey: "k", searchCSats: 0.5, readCSats: 0.2, searchesPerHour: 60, readsPerHour: 120, freeSearchesPerDay: 100, freeReadsPerDay: 200, freeGlobalPerDay: 5000 });
    expect(webToolConfigFromEnv({ WEB_FREE_OWN_MACHINE_SEARCHES_PER_DAY: 5, WEB_FREE_OWN_MACHINE_READS_PER_DAY: 6, WEB_FREE_GLOBAL_PER_DAY: 7 })).toMatchObject({ freeSearchesPerDay: 5, freeReadsPerDay: 6, freeGlobalPerDay: 7 });
  });
});

describe("free on your own machine", () => {
  const page = async (url: string) => ({ url, title: "T", text: "x", truncated: false, contentType: "text/html" });
  const own = { ownMachine: true };

  it("with 0 cSats: status offers it (free), and searches and reads run without a debit", async () => {
    const { engine, deps } = ledger(0);
    const recordFree = vi.fn();
    const debit = vi.fn(deps.debit);
    const svc = new WebToolService(config, { ...deps, debit, recordFree, search: async () => results, read: page });
    expect(await svc.status(ACCOUNT, own)).toMatchObject({ canAfford: true, free: true, freeSearchesLeftToday: 100, freeReadsLeftToday: 200 });
    expect(await svc.search(ACCOUNT, "q", 5, "a", own)).toMatchObject({ ok: true, cSats: 0, free: true });
    expect(await svc.read(ACCOUNT, "https://r.example/", "b", own)).toMatchObject({ ok: true, cSats: 0, free: true });
    expect(debit).not.toHaveBeenCalled();
    expect(engine.balance(ACCOUNT)).toBe(0);
    expect(engine.history(ACCOUNT).filter((t) => t.type === "spend")).toEqual([]);
    // Counted for ops (no cSats): the day's totals after each free call.
    expect(recordFree).toHaveBeenLastCalledWith(ACCOUNT, expect.objectContaining({ searches: 1, reads: 1 }));
    expect(await svc.status(ACCOUNT, own)).toMatchObject({ freeSearchesLeftToday: 99, freeReadsLeftToday: 199 });
  });

  it("a network chat (no basis) with 0 cSats is still refused and nothing is free", async () => {
    const { deps } = ledger(0);
    const search = vi.fn(async () => results);
    const svc = new WebToolService(config, { ...deps, search });
    const st = await svc.status(ACCOUNT);
    expect(st).toMatchObject({ canAfford: false, free: false });
    expect(st).not.toHaveProperty("freeSearchesLeftToday");
    expect(await svc.search(ACCOUNT, "q", 5, "a")).toMatchObject({ ok: false, status: 402, error: "needs_csats" });
    expect(search).not.toHaveBeenCalled();
  });

  it("a network chat with cSats is charged as before", async () => {
    const { engine, deps } = ledger(1);
    const svc = new WebToolService(config, { ...deps, search: async () => results });
    expect(await svc.search(ACCOUNT, "q", 5, "a")).toMatchObject({ ok: true, cSats: 0.5 });
    expect(engine.balance(ACCOUNT)).toBeCloseTo(0.5, 9);
  });

  it("free calls still count toward the hour's limit", async () => {
    const { deps } = ledger(0);
    const svc = new WebToolService(config, { ...deps, search: async () => results });
    for (const id of ["1", "2", "3"]) expect((await svc.search(ACCOUNT, "q", 5, id, own)).ok).toBe(true);
    expect(await svc.search(ACCOUNT, "q", 5, "4", own)).toMatchObject({ ok: false, status: 429 });
  });

  it("past the account's daily free cap it's paid: cSats when the balance allows, else needs_csats", async () => {
    const { engine, deps } = ledger(0.5);
    const svc = new WebToolService({ ...config, searchesPerHour: 100, freeSearchesPerDay: 2 }, { ...deps, search: async () => results });
    expect(await svc.search(ACCOUNT, "q", 5, "1", own)).toMatchObject({ ok: true, free: true });
    expect(await svc.search(ACCOUNT, "q", 5, "2", own)).toMatchObject({ ok: true, free: true });
    expect(await svc.status(ACCOUNT, own)).toMatchObject({ free: false, freeSearchesLeftToday: 0, canAfford: true });
    const paid = await svc.search(ACCOUNT, "q", 5, "3", own);
    expect(paid).toMatchObject({ ok: true, cSats: 0.5 });
    expect(paid).not.toHaveProperty("free");
    expect(engine.balance(ACCOUNT)).toBeCloseTo(0, 9);
    expect(await svc.status(ACCOUNT, own)).toMatchObject({ free: false, canAfford: false });
    expect(await svc.search(ACCOUNT, "q", 5, "4", own)).toMatchObject({ ok: false, status: 402, error: "needs_csats" });
    // Another account still has its own allowance.
    expect(await svc.search("acct-other", "q", 5, "5", own)).toMatchObject({ ok: true, free: true });
  });

  it("the global daily free cap is a circuit-breaker for every account; it starts over the next UTC day", async () => {
    let now = Date.UTC(2026, 10, 17, 12);
    const { deps } = ledger(0);
    const svc = new WebToolService({ ...config, searchesPerHour: 100, freeGlobalPerDay: 2 }, { ...deps, search: async () => results, read: page, now: () => now });
    expect(await svc.search("acct-a", "q", 5, "1", own)).toMatchObject({ ok: true, free: true });
    expect(await svc.read("acct-b", "https://r.example/", "2", own)).toMatchObject({ ok: true, free: true });
    expect(await svc.status("acct-c", own)).toMatchObject({ free: false, freeSearchesLeftToday: 0, canAfford: false });
    expect(await svc.search("acct-c", "q", 5, "3", own)).toMatchObject({ ok: false, status: 402, error: "needs_csats" });
    now = Date.UTC(2026, 10, 18, 0, 0, 1);
    expect(await svc.search("acct-c", "q", 5, "4", own)).toMatchObject({ ok: true, free: true });
  });

  it("a failed free call gives its free call back", async () => {
    const { deps } = ledger(0);
    const svc = new WebToolService({ ...config, freeSearchesPerDay: 1 }, {
      ...deps,
      search: async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    });
    expect(await svc.search(ACCOUNT, "q", 5, "1", own)).toMatchObject({ ok: false, status: 502 });
    expect(await svc.status(ACCOUNT, own)).toMatchObject({ free: true, freeSearchesLeftToday: 1 });
  });

  it("DailyCounter counts per UTC day", () => {
    const c = new DailyCounter();
    const day1 = Date.UTC(2026, 0, 1, 23, 59);
    expect(c.take("k", 1, day1)).toBe(true);
    expect(c.take("k", 1, day1)).toBe(false);
    expect(c.take("k", 1, Date.UTC(2026, 0, 2, 0, 0))).toBe(true);
  });
});
