import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";

/*
 * The apps have no Legal section: the Terms of Service, Privacy Policy, Acceptable Use Policy and
 * Host Agreement are footer links at the bottom of every website and portal page.
 */
const LINKS = [
  ["/terms", "Terms of Service"],
  ["/privacy", "Privacy Policy"],
  ["/acceptable-use", "Acceptable Use Policy"],
  ["/host-agreement", "Host Agreement"]
] as const;

const PAGES = [
  "/", "/bluetooth", "/terms", "/privacy", "/acceptable-use", "/host-agreement", "/host",
  "/portal", "/portal/reset-password", "/portal/dashboard", "/portal/reviews", "/portal/welcome",
  "/portal/settings", "/portal/settings/plan", "/portal/settings/install", "/portal/settings/compute"
];

describe("legal footer links", () => {
  const app = Fastify();
  beforeAll(async () => {
    registerPortalPages(app);
    await app.ready();
  });
  afterAll(() => app.close());

  it.each(PAGES)("%s ends with links to the four legal documents", async (url) => {
    const res = await app.inject({ url });
    expect(res.statusCode, url).toBe(200);
    const tail = res.body.slice(res.body.lastIndexOf("<footer") >= 0 ? res.body.lastIndexOf("<footer") : res.body.lastIndexOf('class="auth-foot"') >= 0 ? res.body.lastIndexOf('class="auth-foot"') : res.body.lastIndexOf('class="foot"'));
    for (const [href, label] of LINKS) expect(tail, `${url} ${label}`).toContain(`<a href="${href}">${label}</a>`);
    expect(res.body).not.toMatch(/pending legal review/i);
    expect(tail, url).toContain("&copy; 2026 EdgeCoder<");
    expect(res.body, url).not.toContain("EdgeCoder, LLC");
  });

  it("the chat, which fills the window, has no footer", async () => {
    const res = await app.inject({ url: "/portal/chat" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('class="legal-footer"');
  });
});
