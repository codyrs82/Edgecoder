import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";

// #16: the HTML pages moved out of server.ts must still be served, unchanged, on the same paths.
const PAGES = ["/", "/privacy", "/terms", "/portal-legacy", "/portal", "/portal/chat", "/portal/dashboard", "/portal/wallet", "/portal/settings", "/portal/download", "/portal/reviews"];

describe("portal pages module (#16)", () => {
  it("serves every page as HTML", async () => {
    const app = Fastify();
    registerPortalPages(app);
    for (const url of PAGES) {
      const res = await app.inject({ method: "GET", url, headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toMatch(/text\/html/);
      expect(res.body, url).toMatch(/<html|<!doctype html/i);
    }
    for (const url of ["/portal/nodes", "/portal/coordinator-ops"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBeLessThan(400);
    }
    await app.close();
  });
});
