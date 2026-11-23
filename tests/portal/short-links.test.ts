import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPublicPages } from "../../src/portal/pages/public.js";
import { shortLinkTarget } from "../../src/portal/short-links.js";

describe("X short links (/x/<campaign>)", () => {
  it("maps a campaign to its page with UTM tags", () => {
    expect(shortLinkTarget("web-chat")).toBe("/?utm_source=x&utm_medium=social&utm_campaign=web-chat");
    expect(shortLinkTarget("reserves")).toBe("/reserves?utm_source=x&utm_medium=social&utm_campaign=reserves");
    expect(shortLinkTarget("reserves-sats")).toBe("/reserves?utm_source=x&utm_medium=social&utm_campaign=reserves-sats");
    expect(shortLinkTarget("bluetooth-offline")).toBe("/bluetooth?utm_source=x&utm_medium=social&utm_campaign=bluetooth-offline");
  });
  it("refuses anything but lower-case letters, digits and dashes", () => {
    for (const bad of ["", "Web", "-x", "a/b", "a.b", "x".repeat(49), "%2F%2Fevil.com", "a b"]) expect(shortLinkTarget(bad)).toBeNull();
  });
  it("redirects on the site and never off it", async () => {
    const app = Fastify();
    registerPublicPages(app);
    const ok = await app.inject({ url: "/x/web-chat" });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe("/?utm_source=x&utm_medium=social&utm_campaign=web-chat");
    expect(ok.headers["cache-control"]).toBe("no-store");
    for (const bad of ["/x/Evil", "/x/%2F%2Fevil.com", "/x/a.b"]) expect((await app.inject({ url: bad })).statusCode).toBe(404);
  });
});
