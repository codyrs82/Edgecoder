import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Dev and e2e compose stacks carry test passwords and placeholder tokens: publish on loopback only. */
describe("compose files publish ports on 127.0.0.1 only", () => {
  for (const file of ["docker-compose.yml", "tests/e2e/docker-compose.e2e.yml", "tests/e2e/docker-compose.scale.yml"]) {
    it(file, () => {
      const lines = readFileSync(file, "utf8").split("\n");
      const published: string[] = [];
      lines.forEach((line, i) => {
        if (!/^\s*ports:\s*$/.test(line)) return;
        for (let j = i + 1; j < lines.length && /^\s*-\s/.test(lines[j]); j++) published.push(lines[j].trim());
      });
      expect(published.length).toBeGreaterThan(0);
      for (const p of published) expect(p, `${file}: ${p}`).toMatch(/^- "127\.0\.0\.1:\d+:\d+"$/);
    });
  }
});
