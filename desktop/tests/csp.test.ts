import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #11: production CSP has no eval, no inline scripts and no dev origins; devCsp may.
const conf = JSON.parse(readFileSync(resolve(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));
const sec = conf.app.security;

describe("desktop CSP (#11)", () => {
  it("production csp is a directive map", () => {
    expect(typeof sec.csp).toBe("object");
    // Tauri keeps injecting nonces for scripts but leaves style-src alone, so 'unsafe-inline'
    // (Monaco <style> tags, Svelte style="") isn't ignored because of an injected nonce.
    expect(sec.dangerousDisableAssetCspModification).toEqual(["style-src"]);
    expect(String(sec.csp["style-src"])).toContain("'unsafe-inline'");
  });

  it("production script-src has no unsafe-eval, unsafe-inline or localhost", () => {
    const script = String(sec.csp["script-src"]);
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(String(sec.csp["default-src"])).toBe("'self'");
  });

  it("no directive allows unsafe-eval or the Vite dev server in production", () => {
    for (const [k, v] of Object.entries(sec.csp)) {
      expect(String(v), k).not.toContain("'unsafe-eval'");
      expect(String(v), k).not.toContain("localhost:1420");
    }
  });

  it("drops dead hosts and OAuth hosts from connect-src", () => {
    const connect = String(sec.csp["connect-src"]);
    for (const dead of ["edgecoder-seed.fly.dev", "edgecoder-portal.fly.dev", "accounts.google.com", "login.microsoftonline.com"]) {
      expect(connect).not.toContain(dead);
    }
    expect(connect).toContain("ipc:");
    expect(connect).toContain("https://edgecoder.io");
    for (const h of ["127.0.0.1", "localhost"]) for (const p of [4301, 4302, 4304]) expect(connect).toContain(`ws://${h}:${p}`);
  });

  it("devCsp keeps the dev conveniences", () => {
    expect(sec.devCsp).toContain("http://localhost:1420");
  });
});
