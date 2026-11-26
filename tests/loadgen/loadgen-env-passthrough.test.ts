import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { LOCAL_ONLY, passthroughLines } from "../../scripts/loadgen/env-passthrough.mjs";

// Run 12: fly.sh wrote a fixed [env] list, so LOADGEN_MAX_INFLIGHT and LOADGEN_HOLD_CLOUD_CSATS could
// not reach the loadgen machines. Every other LOADGEN_* variable is passed through now.
describe("fly.sh LOADGEN_* passthrough (env-passthrough.mjs)", () => {
  it("passes LOADGEN_* variables through as TOML lines, not the ones fly.sh writes or the local-only ones", () => {
    const env = { LOADGEN_MAX_INFLIGHT: "16", LOADGEN_HOLD_CLOUD_CSATS: "5", LOADGEN_RATE: "1", LOADGEN_KEYS: "{\"st1\":\"secret\"}", LOADGEN_APP: "x", LOADGEN_EMPTY: "", PATH: "/bin", LOADGEN_NOTE: 'say "hi"\\now' };
    expect(passthroughLines(env, ["LOADGEN_RATE"])).toEqual(["  LOADGEN_HOLD_CLOUD_CSATS = \"5\"", "  LOADGEN_MAX_INFLIGHT = \"16\"", "  LOADGEN_NOTE = \"say \\\"hi\\\"\\\\now\""]);
    expect(LOCAL_ONLY).toContain("LOADGEN_KEYS");
  });

  it("fly.sh puts them in the machines' [env] and names what it wrote itself", () => {
    const sh = readFileSync("scripts/loadgen/fly.sh", "utf8");
    expect(sh).toMatch(/passthrough=\$\(node "\$HERE\/env-passthrough\.mjs" LOADGEN_PROFILE/);
    expect(sh).toMatch(/\n\$passthrough\n\n\[processes\]/);
    // Each variable fly.sh writes itself is named, so it is never written twice.
    const written = [...sh.matchAll(/^ {2}(LOADGEN_[A-Z_]+) = /gm)].map((m) => m[1]);
    const call = sh.slice(sh.indexOf("env-passthrough.mjs\" "), sh.indexOf(")", sh.indexOf("env-passthrough.mjs\" ")));
    for (const k of new Set(written)) expect(call, k).toContain(k);
  });
});
