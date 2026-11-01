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
  "/portal/download": "EdgeCoder Portal | Get EdgeCoder",
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

  it("keeps the old /portal/nodes and /portal/coordinator-ops redirects", async () => {
    const app = Fastify();
    registerPortalPages(app);
    for (const url of ["/portal/nodes", "/portal/coordinator-ops"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe("/portal/dashboard");
    }
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
