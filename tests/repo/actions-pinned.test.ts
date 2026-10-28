import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #97: every third-party action is pinned by full commit SHA, with the tag in a comment.
const dir = ".github/workflows";
const uses = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) =>
    readFileSync(`${dir}/${f}`, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^\s*-?\s*uses:/.test(l))
      .map((l) => ({ file: f, line: l.trim() }))
  );

describe("GitHub Actions pinned by SHA (#97)", () => {
  it("finds the workflow steps", () => {
    expect(uses.length).toBeGreaterThan(10);
  });

  it("pins every remote action by a 40-char SHA with a tag comment", () => {
    const bad = uses.filter(({ line }) => !line.includes("uses: ./") && !/@[0-9a-f]{40} # \S+/.test(line));
    expect(bad).toEqual([]);
  });
});
