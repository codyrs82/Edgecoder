import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { SERIES_GAPS_SCRIPT, networkPageScript } from "../../src/portal/pages/settings-network.js";

/** Settings > Network: an admin-only nav entry and a page shell whose script reads the admin API. */
describe("Settings > Network page", () => {
  it("renders the shell with every panel, links it as admin-only, and its script parses", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const res = await app.inject({ url: "/portal/settings/network" });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    for (const id of ["netDenied", "netKpis", "kpiOnline", "kpiBusy", "kpiFree", "kpiQueued", "kpiPickup", "kpiTtft", "kpiCalls", "netCoords", "chartUtil", "chartLoad", "chartCalls", "chartLatency", "agentsTable", "agentFilter", "modelsBody", "routingBody", "routingWeights", "gapMissing", "gapSaturated", "gapStale", "gapCoverage"]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain("/portal/api/admin/network");
    expect(html).toMatch(/class="settings-link" href="\/portal\/settings\/network" data-admin-only data-section="network" aria-current="page"/);
    // Other settings pages carry the link hidden until the session is a system admin.
    const settings = (await app.inject({ url: "/portal/settings" })).body;
    expect(settings).toMatch(/class="settings-link hidden" href="\/portal\/settings\/network" data-admin-only/);
    // No data is in the page itself.
    expect(html).not.toMatch(/acct-|@example/);
    expect(() => new Function(networkPageScript())).not.toThrow();
    for (const r of ["1h", "6h", "24h", "7d"]) expect(html).toContain(`data-range="${r}"`);
    await app.close();
  });

  it("finds the spans with no samples (coordinator down) so the chart shades them instead of drawing zeros", () => {
    const seriesGaps = new Function(`${SERIES_GAPS_SCRIPT}; return seriesGaps;`)() as (points: Array<{ atMs: number }>, bucketMs: number, t0: number, t1: number) => Array<{ fromMs: number; toMs: number }>;
    const H = 3_600_000;
    const bucket = 30 * 60_000;
    const t1 = 7 * 24 * H + 10 * 60_000;
    const t0 = t1 - 7 * 24 * H;
    // Up from day 2, down for 3 h on day 4, up to now.
    const points: Array<{ atMs: number }> = [];
    for (let t = 2 * 24 * H; t < 4 * 24 * H; t += bucket) points.push({ atMs: t });
    for (let t = 4 * 24 * H + 3 * H; t <= t1 - 10 * 60_000; t += bucket) points.push({ atMs: t });
    expect(seriesGaps(points, bucket, t0, t1)).toEqual([
      { fromMs: t0, toMs: 2 * 24 * H },
      { fromMs: 4 * 24 * H, toMs: 4 * 24 * H + 3 * H }
    ]);
    // Contiguous buckets, a single missing bucket and an empty range.
    expect(seriesGaps([{ atMs: 0 }, { atMs: 15_000 }, { atMs: 30_000 }], 15_000, 0, 45_000)).toEqual([]);
    expect(seriesGaps([{ atMs: 0 }, { atMs: 30_000 }], 15_000, 0, 45_000)).toEqual([]);
    expect(seriesGaps([], 15_000, 0, 60_000)).toEqual([{ fromMs: 0, toMs: 60_000 }]);
    // Down now: the time since the last point is a gap too.
    expect(seriesGaps([{ atMs: 0 }], 15_000, 0, 120_000)).toEqual([{ fromMs: 15_000, toMs: 120_000 }]);
  });
});
