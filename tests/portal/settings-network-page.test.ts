import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { GAP_CHARTS_SCRIPT, SERIES_GAPS_SCRIPT, networkPageContent, networkPageScript } from "../../src/portal/pages/settings-network.js";
import { mergeNetworkSnapshots } from "../../src/portal/routes/network-admin.js";
import { FakeEl, fakeDocument } from "./fixtures/fake-dom.js";
import { cannedSnapshots } from "./fixtures/network-snapshots.js";

const GAP_CHARTS = ["chartUnmet", "chartSaturation", "chartStale", "chartRegions"];

/** Run the page script against a fake DOM built from the page's chart boxes; returns the elements by id and the render hook. */
function runPage() {
  const { document, byId } = fakeDocument((ids) => {
    for (const m of networkPageContent().matchAll(/<div class="net-chart" id="(\w+)"><h3>([^<]+)<\/h3><div class="hint">[^<]*<\/div><div class="net-legend"><\/div>(?:<p class="net-sum" id="(\w+)"><\/p>)?<\/div>/g)) {
      const box = new FakeEl("div");
      const h3 = box.appendChild(new FakeEl("h3"));
      h3.textContent = m[2]!;
      box.appendChild(new FakeEl("div")).setAttribute("class", "net-legend");
      if (m[3]) {
        const sum = box.appendChild(new FakeEl("p"));
        sum.setAttribute("class", "net-sum");
        ids.set(m[3], sum);
      }
      ids.set(m[1]!, box);
    }
  });
  const window: Record<string, unknown> = { addEventListener: () => undefined };
  new Function("document", "window", "requireAuth", "revealSettingsAdminTab", networkPageScript())(document, window, () => new Promise(() => undefined), () => undefined);
  return { byId, render: window.__renderNetwork as (json: unknown) => void };
}

const legendOf = (box: FakeEl) => box.querySelector("div.net-legend")!.children.map((c) => c.textContent);
const plotOf = (box: FakeEl) => box.querySelector("svg.plot")!;

/** Settings > Network: an admin-only nav entry and a page shell whose script reads the admin API. */
describe("Settings > Network page", () => {
  it("renders the shell with every panel, links it as admin-only, and its script parses", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const res = await app.inject({ url: "/portal/settings/network" });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    for (const id of ["netDenied", "netKpis", "kpiOnline", "kpiBusy", "kpiFree", "kpiQueued", "kpiPickup", "kpiTtft", "kpiCalls", "netCoords", "chartUtil", "chartLoad", "chartCalls", "chartLatency", "agentsTable", "agentFilter", "modelsBody", "routingBody", "routingWeights", "netGaps", ...GAP_CHARTS, "gapMissing", "gapSaturated", "gapStale", "gapCoverage"]) {
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

  it("draws the Gaps as charts: unmet demand and regions stacked by key, saturation by model, stale agents, each with a summary", () => {
    const NOW = Date.now();
    const snaps = cannedSnapshots(NOW);
    const data = mergeNetworkSnapshots([{ url: "https://coordinator.edgecoder.io", ok: true, snapshot: snaps.us }, { url: "https://coordinator-eu.edgecoder.io", ok: true, snapshot: snaps.eu }], { nodeOwners: new Map(), userEmails: new Map() }, "1h", NOW);
    const { byId, render } = runPage();
    render(data);
    const box = (id: string) => byId.get(id)!;

    // Unmet demand: stacked bands by model, the biggest first, with "Other" only when there is more.
    expect(legendOf(box("chartUnmet"))).toEqual(["deepseek-r1:70b", "llama3.1:8b"]);
    const unmet = plotOf(box("chartUnmet"));
    expect(unmet.querySelectorAll("path.area").map((p) => p.attrs.class)).toEqual(["area a-c1", "area a-c2"]);
    expect(unmet.querySelectorAll("path.line").map((p) => p.attrs.class)).toEqual(["line s-c1", "line s-c2"]);
    expect(unmet.attrs["aria-label"]).toMatch(/^Unmet demand\. Last hour: deepseek-r1:70b 13 refused \(no agent has it\)/);
    expect(box("gapMissing").textContent).toMatch(/^Last hour: deepseek-r1:70b 13 refused/);

    // Saturation: a free-slots line per model, the summary names the saturated ones.
    expect(legendOf(box("chartSaturation"))).toEqual(["llama3.1:8b", "qwen2.5-coder:7b"]);
    expect(plotOf(box("chartSaturation")).querySelectorAll("path.area")).toHaveLength(0);
    expect(box("gapSaturated").textContent).toBe("Every model has a free slot.");

    // Stale agents: one series, so no legend; the summary lists them.
    expect(legendOf(box("chartStale"))).toEqual([]);
    expect(plotOf(box("chartStale")).querySelectorAll("path.line")).toHaveLength(1);
    expect(box("gapStale").textContent).toMatch(/^1 stale now: old-laptop-9 \(26 min ago\)\.$/);

    // Agents by region: stacked by region, regions named, never "Region unknown".
    expect(legendOf(box("chartRegions")).sort()).toEqual(["ams", "iad", "sin"]);
    expect(plotOf(box("chartRegions")).querySelectorAll("path.area")).toHaveLength(3);
    expect(box("gapCoverage").textContent).toMatch(/^Online now: iad 2 · ams 1 · sin 1\. 1 reported their own region; the rest count under their coordinator's\./);
    expect(box("gapCoverage").textContent).not.toContain("unknown");

    // Every chart: one axis, labelled, the summary under the plot.
    for (const id of GAP_CHARTS) {
      const b = box(id);
      expect(plotOf(b).attrs.role).toBe("img");
      expect(b.children.indexOf(plotOf(b))).toBeLessThan(b.children.indexOf(b.querySelector("p.net-sum")!));
      expect(plotOf(b).querySelectorAll("text.axis").length).toBeGreaterThan(4);
    }

    // Colors follow the model, not its rank: when llama3.1:8b becomes the bigger one, it keeps c2.
    for (const p of data.series.points as Array<Record<string, unknown>>) p.unmetByModel = { "llama3.1:8b": 9, "deepseek-r1:70b": 1, "mistral:7b": 4 };
    data.gaps.saturatedModels = [{ model: "qwen2.5-coder:7b", agents: 2, slots: 4, waiting: 1 }];
    render(data);
    expect(box("gapSaturated").textContent).toBe("Saturated now: qwen2.5-coder:7b (2 agents, 1 waiting).");
    const lines = plotOf(box("chartUnmet")).querySelectorAll("path.line").map((p) => p.attrs.class);
    expect(legendOf(box("chartUnmet"))).toEqual(["deepseek-r1:70b", "llama3.1:8b", "mistral:7b"]);
    expect(lines).toEqual(["line s-c1", "line s-c2", "line s-c3"]);
  });

  it("shows the empty state: collecting with no samples, nothing measured from coordinators without gap fields", () => {
    const { byId, render } = runPage();
    const base = mergeNetworkSnapshots([], { nodeOwners: new Map(), userEmails: new Map() }, "1h");
    render({ ...base, series: { range: "1h", bucketMs: 15_000, points: [] } });
    for (const id of GAP_CHARTS) {
      expect(plotOf(byId.get(id)!).querySelector("text.empty")!.textContent).toBe("Collecting samples (one every 15 s)");
    }
    expect(byId.get("gapMissing")!.textContent).toBe("None in the last hour.");
    expect(byId.get("gapSaturated")!.textContent).toBe("Every model has a free slot.");
    expect(byId.get("gapStale")!.textContent).toBe("No stale agents.");
    expect(byId.get("gapCoverage")!.textContent).toBe("No agents online.");

    // Points from a coordinator older than the gap fields: nothing to plot, said so.
    const now = Date.now();
    render({ ...base, series: { range: "1h", bucketMs: 15_000, points: [{ atMs: now - 30_000, connectedAgents: 1, totalSlots: 2, freeSlots: 2 }] } });
    for (const id of GAP_CHARTS) {
      expect(plotOf(byId.get(id)!).querySelector("text.empty")!.textContent).toBe("Nothing measured in this range yet");
    }
    // Gap fields present but nothing unmet and nobody online: flat zero lines, not an empty chart.
    render({ ...base, series: { range: "1h", bucketMs: 15_000, points: [{ atMs: now - 30_000, unmetByModel: {}, agentsByRegion: {}, staleAgents: 0, modelSlots: {} }] } });
    expect(legendOf(byId.get("chartUnmet")!)).toEqual(["All models"]);
    expect(legendOf(byId.get("chartRegions")!)).toEqual(["No agents online"]);
    expect(plotOf(byId.get("chartStale")!).querySelectorAll("path.line")).toHaveLength(1);
  });

  it("gap chart helpers: the largest keys, (other) never one of them, and summaries", () => {
    const h = new Function(`${GAP_CHARTS_SCRIPT}; return { topKeys, gapSummaries };`)() as {
      topKeys: (points: unknown[], field: string, size: (v: number) => number, n: number) => { keys: string[]; rest: boolean };
      gapSummaries: (d: unknown, nowMs: number) => Record<string, string>;
    };
    const pts = [{ m: { a: 1, b: 5, "(other)": 9 } }, { m: { c: 2, a: 3 } }, {}];
    expect(h.topKeys(pts, "m", (v) => v, 2)).toEqual({ keys: ["b", "a"], rest: true });
    expect(h.topKeys([{ m: { a: 1 } }], "m", (v) => v, 4)).toEqual({ keys: ["a"], rest: false });
    const s = h.gapSummaries(
      {
        gaps: {
          missingModels: [{ model: "x", noAgentHasModel: 0, noCapacity: 2 }],
          saturatedModels: [{ model: "llama", agents: 2, waiting: 3 }],
          staleAgents: [],
          regions: [{ region: "ord", agents: 3, reported: 0 }, { region: "cdg", agents: 2, reported: 0 }],
          thinCoordinators: [],
          unreachableCoordinators: ["https://coordinator-eu.edgecoder.io"]
        }
      },
      0
    );
    expect(s).toEqual({
      unmet: "Last hour: x 2 cancelled (no free slot).",
      saturation: "Saturated now: llama (2 agents, 3 waiting).",
      stale: "No stale agents.",
      regions: "Online now: ord 3 · cdg 2. Agents report no region of their own, so they count under their coordinator's. Not answering: coordinator-eu.edgecoder.io."
    });
  });
});
