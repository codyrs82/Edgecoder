import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Tokens for the local agent (:4301), inference (:4302) and IDE provider (:4304) go to the
// address those services bind (127.0.0.1), never to `localhost`, which can resolve to ::1 where
// another process may listen.
describe("local service URLs", () => {
  for (const file of ["src/lib/api.ts", "src/pages/ModelManager.svelte"]) {
    it(`${file} uses 127.0.0.1 for :4301, :4302 and :4304`, () => {
      const src = readFileSync(resolve(__dirname, "..", file), "utf8");
      expect(src).not.toMatch(/localhost:430[124]/);
    });
  }
});
