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

// Compose `image:` lines pull from a registry at `docker compose up`, so they are pinned the same way.
// The tag stays in front of the digest for readability; locally built images are exempt.
const COMPOSE_FILES = [
  "deploy/infra/docker-compose.yml",
  "docker-compose.yml",
  "tests/e2e/docker-compose.e2e.yml",
  "tests/e2e/docker-compose.scale.yml",
  "tests/e2e/docker-compose.lnd-regtest.yml"
];

const composeImages = COMPOSE_FILES.flatMap((f) =>
  [...readFileSync(f, "utf8").matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((m) => ({ file: f, image: m[1] }))
);

describe("Docker base image pins (#84)", () => {
  it("pins every FROM by sha256 digest", () => {
    expect(froms.filter((f) => !/@sha256:[0-9a-f]{64}$/.test(f.image))).toEqual([]);
  });

  it("pins every compose image by sha256 digest (except locally built :local images)", () => {
    const pulled = composeImages.filter((c) => !/^edgecoder-infra\/[^:]+:local$/.test(c.image));
    expect(pulled.length).toBeGreaterThanOrEqual(9);
    expect(pulled.filter((c) => !/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/.test(c.image))).toEqual([]);
  });

  it("uses one postgres digest across every compose file", () => {
    const pg = new Set(composeImages.filter((c) => c.image.startsWith("postgres:")).map((c) => c.image));
    expect(pg.size).toBe(1);
  });

  it("uses one node:22-bookworm-slim digest everywhere", () => {
    const node = new Set(froms.filter((f) => f.image.startsWith("node:22-bookworm-slim@")).map((f) => f.image));
    expect(node.size).toBe(1);
  });

  it("one dependabot docker entry covers every directory with a Dockerfile (single PR)", () => {
    const yml = readFileSync(".github/dependabot.yml", "utf8").replace(/\r\n/g, "\n");
    const entries = yml.split(/\n(?=  - package-ecosystem: )/).filter((e) => e.startsWith("  - package-ecosystem: docker"));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).not.toMatch(/\n    directory: /);
    const listed = [...entry.matchAll(/^      - (\/\S*)$/gm)].map((m) => m[1]).sort();
    const dirs = [...new Set(DOCKERFILES.map((f) => "/" + f.split("/").slice(0, -1).join("/")))].sort();
    expect(listed).toEqual(dirs);
    expect(entry).toMatch(/groups:\n      base-images: \{ patterns: \["\*"\] \}/);
  });
});
