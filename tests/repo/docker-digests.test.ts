import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #84: every base image is pinned by digest (Dependabot bumps them), and the node base image
// uses one digest everywhere, so a partial bump fails here instead of shipping mixed bases.
const DOCKERFILES = [
  "Dockerfile.anchor-proxy",
  "deploy/docker/Dockerfile.agent",
  "deploy/docker/Dockerfile.server",
  "docker/sandbox-node.Dockerfile",
  "docker/sandbox-python.Dockerfile",
  "tests/e2e/Dockerfile.e2e"
];

const froms = DOCKERFILES.flatMap((f) =>
  readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^FROM\s/i.test(l))
    .map((l) => ({ file: f, image: l.split(/\s+/)[1] }))
);

describe("Docker base image pins (#84)", () => {
  it("pins every FROM by sha256 digest", () => {
    expect(froms.filter((f) => !/@sha256:[0-9a-f]{64}$/.test(f.image))).toEqual([]);
  });

  it("uses one node:22-bookworm-slim digest everywhere", () => {
    const node = new Set(froms.filter((f) => f.image.startsWith("node:22-bookworm-slim@")).map((f) => f.image));
    expect(node.size).toBe(1);
  });

  it("dependabot watches every directory with a Dockerfile", () => {
    const yml = readFileSync(".github/dependabot.yml", "utf8").replace(/\r\n/g, "\n");
    const dirs = new Set(DOCKERFILES.map((f) => "/" + f.split("/").slice(0, -1).join("/")).map((d) => (d === "/" ? "/" : d)));
    for (const d of dirs) {
      expect(yml).toMatch(new RegExp(`package-ecosystem: docker\\n    directory: ${d.replace(/\//g, "\\/")}\\n`));
    }
  });
});
