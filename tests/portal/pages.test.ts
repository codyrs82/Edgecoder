import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";

// #16: the HTML pages moved out of server.ts must still be served, unchanged, on the same paths.
// Each page is pinned by its <title> so a later slice can't swap or empty one unnoticed.
const PAGES: Record<string, string> = {
  "/": "EdgeCoder | Private AI Coding on Your Infrastructure",
  "/privacy": "Privacy Policy | EdgeCoder",
  "/terms": "Terms of Service | EdgeCoder",
  "/portal-legacy": "EdgeCoder Portal",
  "/portal": "EdgeCoder Portal | Sign in",
  "/portal/reset-password": "EdgeCoder Portal | Reset password",
  "/portal/chat": "EdgeCoder Portal | Chat",
  "/portal/dashboard": "EdgeCoder Portal | Dashboard",
  "/portal/settings": "EdgeCoder Portal | Settings",
  "/portal/settings/plan": "EdgeCoder Portal | Settings",
  "/portal/settings/compute": "EdgeCoder Portal | Settings",
  "/portal/settings/install": "EdgeCoder Portal | Settings",
  "/portal/settings/nodes": "EdgeCoder Portal | Settings",
  "/portal/settings/admin": "EdgeCoder Portal | Settings",
  "/portal/reviews": "EdgeCoder Portal | Reviews"
};

describe("portal pages module (#16)", () => {
  it("serves every page as HTML with its title", async () => {
    const app = Fastify();
    registerPortalPages(app);
    for (const [url, title] of Object.entries(PAGES)) {
      const res = await app.inject({ method: "GET", url, headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toMatch(/text\/html/);
      expect(res.body.match(/<title>([^<]*)<\/title>/)?.[1], url).toBe(title);
    }
    await app.close();
  });

  it("redirects the old top-level pages into Settings", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const expected: Record<string, string> = {
      "/portal/nodes": "/portal/settings/nodes",
      "/portal/coordinator-ops": "/portal/settings/admin",
      "/portal/wallet": "/portal/settings/plan",
      "/portal/market": "/portal/settings/compute",
      "/portal/download": "/portal/settings/install",
      "/portal/download?token=abc": "/portal/settings/install?token=abc"
    };
    for (const [url, location] of Object.entries(expected)) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe(location);
    }
    await app.close();
  });

  it("keeps the dashboard to an overview and moves management into Settings", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const dashboard = (await app.inject({ url: "/portal/dashboard" })).body;
    for (const gone of ["quick-action", 'id="enrollBtn"', 'id="nodesBody"', 'id="userMgmtBody"', 'id="opsPendingBody"', 'id="opsApprovedBody"']) {
      expect(dashboard, gone).not.toContain(gone);
    }
    expect(dashboard).toContain('id="activityFeed"');
    expect(dashboard).toContain('id="opsAgentsValue"');

    const settings = (await app.inject({ url: "/portal/settings" })).body;
    expect(settings).not.toContain("settings-nav-card");
    expect(settings).toContain('id="passkeyEnrollBtn"');
    expect(settings).toContain('href="/portal/settings/nodes"');
    // Admin tab is rendered hidden and only revealed client-side for system admins.
    expect(settings).toMatch(/class="settings-link hidden" href="\/portal\/settings\/admin" id="settingsAdminTab" data-admin-only/);
    // Cursor-like settings: sub-navigation with search, and every section on the page.
    expect(settings).toContain('id="settingsSearch"');
    for (const sec of ["general", "profile", "usage", "tools"]) expect(settings, sec).toContain(`id="sec-${sec}"`);
    for (const id of ["themeSelect", "displayNameInput", "usageBalance", "createKeyBtn", "keysBody"]) {
      expect(settings, id).toContain(`id="${id}"`);
    }
    expect(settings).toContain('href="/portal/settings/plan"');

    // Compute: the market and machine reservations on one settings page.
    const compute = (await app.inject({ url: "/portal/settings/compute" })).body;
    for (const id of ["pairSelect", "priceChart", "reserveClass", "reserveBtn", "leasesList"]) expect(compute, id).toContain(`id="${id}"`);
    expect(compute).toContain('"/portal/api/compute/reservations"');
    expect(compute).toContain('"/portal/api/market/orders"');

    // Plan & usage: the wallet, including where we pay you.
    const plan = (await app.inject({ url: "/portal/settings/plan" })).body;
    expect(plan).toContain("Where should we pay you?");
    for (const id of ["payoutDestInput", "withdrawBtn", "creditHistoryBody"]) expect(plan, id).toContain(`id="${id}"`);

    // Install agent: no inline handlers, and a malformed token falls back to the placeholder.
    const install = (await app.inject({ url: "/portal/settings/install?token=%3Cb%3E", headers: { "user-agent": "Macintosh" } })).body;
    expect(install).toContain('data-copy="install-sh"');
    expect(install).not.toMatch(/ onclick=/);
    expect(install).toContain("--token YOUR_TOKEN");
    expect(install).not.toContain("<b>");

    const nodes = (await app.inject({ url: "/portal/settings/nodes" })).body;
    expect(nodes).toContain('id="enrollBtn"');
    expect(nodes).toContain('id="nodesBody"');
    expect(nodes).toContain('"/nodes/enroll"');

    const admin = (await app.inject({ url: "/portal/settings/admin" })).body;
    for (const id of ["userMgmtBody", "opsPendingBody", "opsApprovedBody", "filterCoordinatorBtn", "approvedFilterActiveBtn"]) {
      expect(admin, id).toContain(`id="${id}"`);
    }
    expect(admin).toContain('"/coordinator/ops/node-approval"');
    expect(admin).toContain('"/portal/api/admin/users"');
    expect(admin).toContain("isSystemAdmin");
    await app.close();
  });

  it("keeps page-specific markup (portal sign-in, legacy auth view)", async () => {
    const app = Fastify();
    registerPortalPages(app);
    expect((await app.inject({ url: "/portal" })).body).toContain('id="signupEmail"');
    expect((await app.inject({ url: "/portal-legacy" })).body).toContain('id="authView"');
    await app.close();
  });
});
