import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { CLIENT_ESCAPE_JS } from "../../src/portal/pages/escape.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { WORLD_RENDER_SCRIPT, WORLD_VIEW_BROWSER_LIB, worldPageScript } from "../../src/portal/pages/settings-world.js";
import type { WorldView } from "../../src/common/world-view.js";
import { MY_MACHINE, WORLD } from "./fixtures/world-view.js";

/*
 * Settings > Network for everyone (/portal/settings/world): the shell, its nav entry, and the page's
 * HTML builders run against a world view (they are plain JS, so they run here without a DOM).
 */
type State = { mode: string; scope: "all" | "mine"; model: string; sortKey: string; sortDir: string; selectedId: string | null; hoverId: string | null; focusIndex: number };
type R = {
  wvDerive(v: WorldView, s: State): any;
  wvStatsHtml(v: WorldView, d: any): string;
  wvGraphHtml(v: WorldView, d: any, s: State): string;
  wvDetailsHtml(v: WorldView, row: any): string;
  wvCardsHtml(v: WorldView, d: any, s: State): string;
  wvCoordsHtml(v: WorldView): string;
  wvNoticeHtml(reason?: string): string;
};
const R = new Function(
  `${CLIENT_ESCAPE_JS}${WORLD_VIEW_BROWSER_LIB}${WORLD_RENDER_SCRIPT}; return { wvDerive, wvStatsHtml, wvGraphHtml, wvDetailsHtml, wvCardsHtml, wvCoordsHtml, wvNoticeHtml };`
)() as R;
const S = (over: Partial<State> = {}): State => ({ mode: "graph", scope: "all", model: "", sortKey: "latency", sortDir: "asc", selectedId: null, hoverId: null, focusIndex: 0, ...over });

const EMPTY: WorldView = {
  connected: true,
  generatedAtMs: 0,
  servedBy: "",
  coordinators: [],
  links: [],
  agents: [],
  models: [],
  totals: { coordinators: 0, agents: 0, online: 0, busy: 0, mine: 0, models: 0, slots: 0, slotsUsed: 0 },
  truncated: false
};

describe("Settings > Network page (everyone)", () => {
  it("serves a shell with no data, linked for every signed-in user, next to the admin dashboard", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const res = await app.inject({ url: "/portal/settings/world" });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    for (const id of ["wvStats", "wvGraph", "wvDetails", "wvCards", "wvCoords", "wvModel", "wvMineBtn"]) expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain("/portal/api/network/world");
    // Not admin-only: no data-admin-only, not hidden, current page.
    expect(html).toMatch(/class="settings-link" href="\/portal\/settings\/world" data-section="world" aria-current="page"/);
    const settings = (await app.inject({ url: "/portal/settings" })).body;
    expect(settings).toMatch(/class="settings-link" href="\/portal\/settings\/world" data-section="world">/);
    // The admin dashboard is still its own, admin-only page.
    expect(settings).toMatch(/class="settings-link hidden" href="\/portal\/settings\/network" data-admin-only/);
    expect(html).not.toMatch(/acct-|lin-•••|mac-•••/);
    // a11y: the toolbar groups are labelled and their buttons are toggles; the model filter has a label.
    for (const g of ["View", "Whose machines", "Sort machines"]) expect(html).toContain(`role="group" aria-label="${g}"`);
    expect(html).toMatch(/<label class="wv-model"><span>Model<\/span><select id="wvModel">/);
    expect(html).toContain('aria-label="Machine details" aria-live="polite"');
    expect(() => new Function(worldPageScript())).not.toThrow();
    await app.close();
  });

  it("renders the stat tiles, the graph, the side panel and the coordinators from a world view", () => {
    const d = R.wvDerive(WORLD, S());
    const stats = R.wvStatsHtml(WORLD, d);
    expect(stats).toContain("Machines online");
    expect(stats).toContain("1 busy · 1 of 12 slots in use");
    expect(stats).toContain("cdg · ord");
    expect(stats).toContain("qwen2.5-coder:1.5b, deepseek-r1:7b");
    expect(stats).toContain("~76 ms"); // 73 ms to ord + 3 ms from ord to the nearest machine

    const graph = R.wvGraphHtml(WORLD, d, S());
    expect(graph).toContain(">ORD</text>");
    expect(graph).toContain(">CDG</text>");
    expect(graph).toContain(">20 ms</text>");
    expect(graph).toContain(">100 ms</text>");
    expect(graph).toContain(">99 ms</text>"); // ord <-> cdg
    expect(graph).toContain(">73 ms</text>"); // You -> ord
    expect(graph).toContain(">258 ms</text>"); // You -> cdg
    expect(graph).toContain(">You</text>");
    expect(graph).toContain(`>${MY_MACHINE}</text>`);
    expect(graph).toContain(">lin-•••beee</text>");
    expect(graph).toContain(">mac-•••e782</text>");
    for (const l of ["Idle", "Busy", "Not seen lately", "Yours", "Size: model slots."]) expect(graph).toContain(l);

    expect(R.wvDetailsHtml(WORLD, null)).toContain("Select a machine");
    const mine = d.rows.find((r: any) => r.agent.mine);
    const details = R.wvDetailsHtml(WORLD, mine);
    expect(details).toContain(MY_MACHINE);
    expect(details).toContain("Yours");
    expect(details).toContain("coordinator.edgecoder.io (ord) · 30 ms");

    const coords = R.wvCoordsHtml(WORLD);
    expect(coords).toContain("coordinator.edgecoder.io · answering");
    expect(coords).toContain("ord · North America · 4 machines online");
    expect(coords).toContain("Your round trip 73 ms");
    expect(coords).toContain("coordinator.edgecoder.io (ord) ↔ coordinator-cdg.edgecoder.io (cdg) · meshed, 99 ms apart");
  });

  it("graph a11y: one tab stop, every machine a labelled toggle, the svg described", () => {
    const d = R.wvDerive(WORLD, S({ selectedId: WORLD.agents[2].id, focusIndex: 1 }));
    const graph = R.wvGraphHtml(WORLD, d, S({ selectedId: WORLD.agents[2].id, focusIndex: 1 }));
    expect(graph).toMatch(/^<svg class='wv-graph' viewBox='0 0 \d+ \d+' role='group' aria-label='Network graph: 2 coordinators and 6 machines\. Arrow keys/);
    const nodes = graph.match(/<g data-node=[^>]*>/g) ?? [];
    expect(nodes).toHaveLength(WORLD.agents.length);
    for (const n of nodes) {
      expect(n).toContain("role='button'");
      expect(n).toMatch(/aria-label='(Your machine|Machine) [^']+'/);
      expect(n).toMatch(/aria-pressed='(true|false)'/);
    }
    expect(nodes.filter((n) => n.includes("tabindex='0'"))).toHaveLength(1);
    expect(nodes[1]).toContain("tabindex='0'");
    expect(nodes.filter((n) => n.includes("aria-pressed='true'"))).toHaveLength(1);
    expect(graph).toContain(`aria-label='Your machine ${MY_MACHINE}, idle, iad · US, 1 model, about 103 ms from you'`);
  });

  it("the cards view is the text alternative: every machine, masked unless yours, sortable and filterable", () => {
    const all = R.wvCardsHtml(WORLD, R.wvDerive(WORLD, S({ mode: "cards" })), S({ mode: "cards" }));
    expect(all).toContain("aria-label='Machines, sorted by nearest'");
    expect(all.match(/<li /g)).toHaveLength(WORLD.agents.length);
    expect(all).toContain(`<span class='wv-wname'>${MY_MACHINE}</span>`);
    expect(all).toContain("<span class='wv-wname masked'>lin-•••4e08</span>");
    const mine = R.wvCardsHtml(WORLD, R.wvDerive(WORLD, S({ scope: "mine" })), S({ scope: "mine" }));
    expect(mine.match(/<li /g)).toHaveLength(1);
    const deepseek = R.wvDerive(WORLD, S({ model: "deepseek-r1:7b" }));
    expect(deepseek.visible.map((r: any) => r.agent.label)).toEqual(["mac-•••e782"]);
  });

  it("empty states: no machines, none of yours, and no coordinator answering", () => {
    const d = R.wvDerive(EMPTY, S());
    expect(R.wvStatsHtml(EMPTY, d)).toContain("No latency measured yet");
    expect(R.wvStatsHtml(EMPTY, d)).toContain("None online");
    expect(R.wvGraphHtml(EMPTY, d, S())).toContain("0 coordinators and 0 machines");
    expect(R.wvCardsHtml(EMPTY, d, S())).toContain("No machines match these filters.");
    expect(R.wvCardsHtml(EMPTY, d, S({ scope: "mine" }))).toContain("None of your machines match.");
    expect(R.wvCoordsHtml(EMPTY)).toContain("No coordinators answered.");
    expect(R.wvNoticeHtml("coordinator_unreachable")).toContain("Couldn&#39;t reach a coordinator");
    expect(R.wvNoticeHtml("rate_limited")).toContain("slow down");
  });

  it("escapes everything that comes from the network", () => {
    const evil: WorldView = {
      ...WORLD,
      coordinators: WORLD.coordinators.map((c) => ({ ...c, region: "<img src=x onerror=1>" })),
      agents: WORLD.agents.map((a) => ({ ...a, models: ["<script>x</script>"], activeModel: null, region: "'><b>" }))
    };
    const d = R.wvDerive(evil, S());
    const html = R.wvStatsHtml(evil, d) + R.wvGraphHtml(evil, d, S()) + R.wvCardsHtml(evil, d, S()) + R.wvCoordsHtml(evil) + R.wvDetailsHtml(evil, d.rows[0]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("'><b>");
  });
});
