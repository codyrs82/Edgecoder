import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { networkPageScript } from "../../src/portal/pages/settings-network.js";

/** Settings > Network: an admin-only nav entry and a page shell whose script reads the admin API. */
describe("Settings > Network page", () => {
  it("renders the shell with every panel, links it as admin-only, and its script parses", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const res = await app.inject({ url: "/portal/settings/network" });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    for (const id of ["netDenied", "netKpis", "kpiOnline", "kpiBusy", "kpiFree", "kpiQueued", "kpiPickup", "kpiTtft", "kpiCalls", "netCoords", "chartUtil", "chartLoad", "chartCalls", "chartLatency", "agentsTable", "agentFilter", "modelsBody", "gapMissing", "gapSaturated", "gapStale", "gapCoverage"]) {
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
    await app.close();
  });
});
