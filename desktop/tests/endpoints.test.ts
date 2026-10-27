import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COORDINATOR_KEY,
  FALLBACK_COORDINATOR_URL,
  FALLBACK_PORTAL_URL,
  LEGACY_SEED_KEY,
  PORTAL_KEY,
  coordinatorUrl,
  defaultEndpoints,
  portalUrl,
  resetEndpoints,
  setEndpoint,
  validateEndpointUrl,
} from "../src/lib/endpoints";

// #35
function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

describe("desktop endpoints (#35)", () => {
  it("uses the build-time env default, then the fallback", () => {
    const env = { VITE_COORDINATOR_URL: "https://coord.example/", VITE_PORTAL_URL: "https://portal.example" };
    expect(coordinatorUrl(mem(), env)).toBe("https://coord.example");
    expect(portalUrl(mem(), env)).toBe("https://portal.example");
    expect(defaultEndpoints({})).toEqual({ coordinator: FALLBACK_COORDINATOR_URL, portal: FALLBACK_PORTAL_URL });
  });

  it("a saved override wins over env; the legacy seedNodeUrl is honoured", () => {
    const env = { VITE_COORDINATOR_URL: "https://coord.example" };
    expect(coordinatorUrl(mem({ [COORDINATOR_KEY]: "https://mine.example" }), env)).toBe("https://mine.example");
    expect(coordinatorUrl(mem({ [LEGACY_SEED_KEY]: "https://legacy.example" }), env)).toBe("https://legacy.example");
    expect(portalUrl(mem({ [PORTAL_KEY]: "http://127.0.0.1:4310" }), {})).toBe("http://127.0.0.1:4310");
  });

  it("rejects invalid schemes and ignores invalid stored values", () => {
    for (const bad of ["http://evil.example", "ftp://x", "javascript:alert(1)", "not a url", "https://u:p@x.example"]) {
      expect(validateEndpointUrl(bad), bad).toBeNull();
    }
    expect(validateEndpointUrl("http://localhost:4301")).toBe("http://localhost:4301");
    const s = mem();
    expect(() => setEndpoint("coordinator", "http://evil.example", s)).toThrow();
    expect(coordinatorUrl(mem({ [COORDINATOR_KEY]: "http://evil.example" }), {})).toBe(FALLBACK_COORDINATOR_URL);
  });

  it("reset clears overrides", () => {
    const s = mem();
    setEndpoint("coordinator", "https://a.example", s);
    setEndpoint("portal", "https://b.example", s);
    resetEndpoints(s);
    expect(s.m.size).toBe(0);
  });

  it("desktop/src has no hard-coded edgecoder-seed.fly.dev", () => {
    const root = resolve(__dirname, "../src");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|svelte|js)$/.test(n) && readFileSync(p, "utf8").includes("edgecoder-seed.fly.dev")) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
