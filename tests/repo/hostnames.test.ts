import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedDownloadDomains, DEFAULT_DOWNLOAD_DOMAINS, isDownloadDomain } from "../../src/security/manifest-verifier.js";
import { siteLabel, supportEmail } from "../../src/portal/pages/urls.js";

// #22: EdgeCoder-run hostnames may only appear in src/ as env-var defaults (or comments), so
// every one of them can be overridden by a self-hoster. New hard-coded hosts fail here.
const HOST = /edgecoder\.io|fly\.dev/;
// Lines that are config defaults by construction (named constant overridable via env).
const ALLOWED = [
  /export const DEFAULT_DISCOVERY_URL = /, // COORDINATOR_DISCOVERY_URLS overrides
  /export const DEFAULT_DOWNLOAD_DOMAINS = /, // MODEL_DOWNLOAD_DOMAINS overrides
  /: "support@edgecoder\.io";$/ // SUPPORT_EMAIL overrides (supportEmail fallback)
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("configurable hostnames (#22)", () => {
  it("src/ only uses EdgeCoder hostnames as overridable defaults", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (!HOST.test(line)) return;
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (/(process\.)?env\.[A-Z0-9_]+\s*(\?\?|\|\|)\s*["'`][^"'`]*(edgecoder\.io|fly\.dev)/.test(line)) return;
        if (ALLOWED.some((re) => re.test(t))) return;
        offenders.push(`${file.replace(/\\/g, "/")}:${i + 1}: ${t}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("MODEL_DOWNLOAD_DOMAINS replaces the model download allowlist", () => {
    expect(allowedDownloadDomains({})).toEqual(DEFAULT_DOWNLOAD_DOMAINS);
    expect(allowedDownloadDomains({ MODEL_DOWNLOAD_DOMAINS: " Models.Example.org, huggingface.co,," })).toEqual([
      "models.example.org",
      "huggingface.co"
    ]);
  });

  it.each([
    "https://models.example.org",
    "models.example.org:443",
    "models.example.org/path",
    "*.example.org",
    "10.0.0.5",
    "localhost",
    "a;b.example.org",
    "-bad.example.org",
    "a..example.org"
  ])("MODEL_DOWNLOAD_DOMAINS rejects %j", (entry) => {
    expect(isDownloadDomain(entry)).toBe(false);
    expect(() => allowedDownloadDomains({ MODEL_DOWNLOAD_DOMAINS: `huggingface.co,${entry}` })).toThrow(/invalid entries/);
  });

  it("MODEL_DOWNLOAD_DOMAINS set to only commas is an error", () => {
    expect(() => allowedDownloadDomains({ MODEL_DOWNLOAD_DOMAINS: " , ," })).toThrow(/no hostnames/);
  });

  it("the site label is HTML-escaped", () => {
    const label = siteLabel("https://a'b\"c.example.org");
    expect(label).not.toMatch(/['"<>]/);
    expect(label).toContain("&#39;");
  });

  it("SUPPORT_EMAIL and the site label come from config", () => {
    expect(supportEmail("help@example.org")).toBe("help@example.org");
    expect(supportEmail(undefined)).toBe("support@edgecoder.io");
    expect(supportEmail('x"><script>@example.org')).toBe("support@edgecoder.io");
    expect(siteLabel("https://portal.example.org:8443/x")).toBe("portal.example.org:8443");
    expect(siteLabel(undefined)).toBe("home");
    expect(siteLabel("not a url")).toBe("home");
  });
});
