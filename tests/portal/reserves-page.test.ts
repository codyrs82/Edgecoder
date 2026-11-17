import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { footerLegalLinks, reservesPageHtml } from "../../src/portal/pages/public.js";
import { parseReservesReport, unavailableReservesReport } from "../../src/portal/reserves.js";
import { buildReservesReport, type ProofOfReservesReport } from "../../src/economy/proof-of-reserves.js";
import { rateLimitFor, RESERVES_RATE_LIMIT } from "../../src/portal/security.js";
import { MIRROR_REDIRECT_PREFIXES } from "../../src/portal/static-site.js";

const live: ProofOfReservesReport = buildReservesReport({
  network: "bitcoin",
  liabilities: { accountBalancesMsat: 150_000_000, feePoolMsat: 7_000_000, heldForJobsMsat: 3_000_000 },
  balances: { supported: true, channelLocalSats: 120_000, onchainConfirmedSats: 80_000, onchainUnconfirmedSats: 1_000, channelPendingSats: 0, totalSats: 201_000 },
  anchor: { anchorId: "a", epochId: "e", checkpointHash: "ab".repeat(32), network: "bitcoin", status: "anchored", simulated: false, txRef: "cd".repeat(32), confirmations: 9, requiredConfirmations: 6, createdAtMs: 1 },
  anchoring: "enabled",
  nowMs: Date.UTC(2026, 10, 17, 9, 30),
  cacheMs: 60_000
});

describe("portal proof-of-reserves source", () => {
  it("rebuilds the coordinator report from its aggregate fields only", () => {
    const leaky = { ...JSON.parse(JSON.stringify(live)), accounts: [{ accountId: "acct-x", balance: 5 }], debug: "secret" };
    leaky.liabilities.perAccount = { "acct-x": 5 };
    const parsed = parseReservesReport(leaky)!;
    expect(parsed).toEqual(live);
    expect(JSON.stringify(parsed)).not.toMatch(/acct-x|secret|perAccount/);
  });

  it("refuses totals that don't add up or aren't whole sats", () => {
    const bad = JSON.parse(JSON.stringify(live));
    bad.liabilities.totalSats += 1;
    expect(parseReservesReport(bad)).toBeNull();
    const frac = JSON.parse(JSON.stringify(live));
    frac.reserves.channelLocalSats = 1.5;
    expect(parseReservesReport(frac)).toBeNull();
    expect(parseReservesReport({})).toBeNull();
    expect(parseReservesReport(null)).toBeNull();
  });

  it("recomputes the ratio itself and keeps an unavailable side unavailable", () => {
    const r = JSON.parse(JSON.stringify(live));
    r.ratio = 99;
    expect(parseReservesReport(r)!.ratio).toBe(live.ratio);
    r.reserves = { available: false, reason: "node_unreachable", channelLocalSats: 1 };
    expect(parseReservesReport(r)).toMatchObject({ reserves: { available: false, reason: "node_unreachable" }, ratio: null });
  });
});

describe("/reserves page", () => {
  it("shows liabilities, reserves, ratio, network, time and the anchor", () => {
    const html = reservesPageHtml(live);
    expect(html).toContain("<title>Proof of reserves | EdgeCoder</title>");
    expect(html).toContain("150,000 sats");
    expect(html).toContain("160,000 sats");
    expect(html).toContain("200,000 sats");
    expect(html).toContain("125.00%");
    expect(html).toContain(">mainnet<");
    expect(html).toContain("2026-11-17 09:30:00 UTC");
    expect(html).toContain(`https://mempool.space/tx/${"cd".repeat(32)}`);
    expect(html).toContain("not a cryptographic proof");
    expect(html).toContain("Merkle sum tree");
  });

  it("an unreachable node or coordinator shows unavailable, never a number", () => {
    const html = reservesPageHtml(unavailableReservesReport("coordinator_unreachable", "signet", 0));
    expect(html).toContain("unavailable");
    expect(html).toContain("no coordinator answered");
    expect(html).not.toMatch(/\d sats/);
    expect(html).not.toMatch(/\d+\.\d\d%/);
  });

  it("is served at /reserves and /reserves.json, and linked from the website footer", async () => {
    const app = Fastify();
    registerPortalPages(app, { getReserves: async () => live });
    await app.ready();
    const page = await app.inject({ url: "/reserves" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Proof of reserves");
    const json = await app.inject({ url: "/reserves.json" });
    expect(json.json()).toEqual(live);
    const home = await app.inject({ url: "/" });
    expect(home.body).toContain('<a href="/reserves">Proof of reserves</a>');
    await app.close();
    expect(footerLegalLinks()).toContain('<a href="/reserves">Proof of reserves</a>');
  });

  it("without a source, or when it throws, the page says unavailable", async () => {
    const app = Fastify();
    registerPortalPages(app, { getReserves: async () => { throw new Error("boom"); } });
    await app.ready();
    expect((await app.inject({ url: "/reserves.json" })).json()).toMatchObject({ liabilities: { available: false }, reserves: { available: false }, ratio: null });
    await app.close();
  });

  it("is rate limited and forwarded by the static mirror", () => {
    expect(rateLimitFor("/reserves", "GET")).toBe(RESERVES_RATE_LIMIT);
    expect(rateLimitFor("/reserves.json", ["GET", "HEAD"])).toBe(RESERVES_RATE_LIMIT);
    expect(MIRROR_REDIRECT_PREFIXES).toContain("/reserves");
  });
});
