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
  "/portal/chat": "EdgeCoder Portal | Chat",
  "/portal/dashboard": "EdgeCoder Portal | Dashboard",
  "/portal/wallet": "EdgeCoder Portal | Wallet",
  "/portal/settings": "EdgeCoder Portal | Settings",
  "/portal/settings/nodes": "EdgeCoder Portal | Settings",
  "/portal/settings/admin": "EdgeCoder Portal | Settings",
  "/portal/download": "EdgeCoder Portal | Get EdgeCoder",
  "/portal/reviews": "EdgeCoder Portal | Reviews",
  "/portal/market": "EdgeCoder Portal | Market"
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

  it("redirects the old /portal/nodes and /portal/coordinator-ops paths into Settings", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const expected: Record<string, string> = {
      "/portal/nodes": "/portal/settings/nodes",
      "/portal/coordinator-ops": "/portal/settings/admin"
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
    expect(settings).toMatch(/class="btn hidden" href="\/portal\/settings\/admin" id="settingsAdminTab"/);

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
