import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportStaticSite, staticSiteFiles } from "../../src/portal/static-site.js";

describe("static mirror of the public pages", () => {
  it("renders the three public pages and redirects dynamic paths to the portal", () => {
    const files = staticSiteFiles({ portalUrl: "https://edgecoder.io/" });
    expect(files["index.html"]).toContain("<title>EdgeCoder | Private AI Coding on Your Infrastructure</title>");
    expect(files["privacy/index.html"]).toContain("Privacy Policy");
    expect(files["terms/index.html"]).toContain("Terms");
    expect(files._redirects).toContain("/portal https://edgecoder.io/portal 302");
    expect(files._redirects).toContain("/portal/* https://edgecoder.io/portal/:splat 302");
    expect(files._redirects).toContain("/auth/* https://edgecoder.io/auth/:splat 302");
    expect(files._headers).toContain("frame-ancestors 'none'");
    expect(files._headers).toContain("connect-src 'self' https://edgecoder.io");
  });

  it("writes the files to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ec-static-"));
    const written = await exportStaticSite(dir, { portalUrl: "https://example.test" });
    expect(written.length).toBe(8); // + assets/tokens.css and assets/theme.js (#89)
    expect(await readFile(join(dir, "privacy", "index.html"), "utf8")).toContain("<!doctype html>");
  });
});
