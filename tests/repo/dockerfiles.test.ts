import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #9: static guards for the multi-stage images. The CI docker-build job checks the built images.
const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const images = ["deploy/docker/Dockerfile.server", "deploy/docker/Dockerfile.agent"];

describe("Docker images (#9)", () => {
  it.each(images)("%s is multi-stage, non-root, prod deps only, no tests/", (p) => {
    const df = read(p);
    expect(df.match(/^FROM /gm)?.length).toBeGreaterThanOrEqual(2);
    const runtime = df.slice(df.lastIndexOf("\nFROM "));
    expect(runtime).toMatch(/^USER node$/m);
    expect(df).toMatch(/npm prune --omit=dev/);
    expect(df).not.toMatch(/COPY\s+tests/);
    expect(runtime).not.toMatch(/\b(g\+\+|make|python3)\b/);
    expect(df).toMatch(/FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}/);
  });

  it("server image has no Ollama or BLE", () => {
    expect(read("deploy/docker/Dockerfile.server").replace(/^\s*#.*$/gm, "")).not.toMatch(/ollama|bluez|bluetooth/i);
  });

  it("agent image pins and verifies Ollama (no curl | sh)", () => {
    const df = read("deploy/docker/Dockerfile.agent");
    expect(df).not.toMatch(/\|\s*sh\b/);
    expect(df).toMatch(/ARG OLLAMA_VERSION=\d+\.\d+\.\d+/);
    expect(df).toMatch(/ARG OLLAMA_SHA256=[0-9a-f]{64}/);
    expect(df).toMatch(/sha256sum -c -/);
  });

  it("fly configs point at existing Dockerfiles", () => {
    for (const toml of ["fly.portal.toml", "fly.seed-node.toml", "fly.seed-eu.toml", "fly.anchor-proxy.toml"]) {
      const p = `deploy/fly/${toml}`;
      const m = read(p).match(/dockerfile\s*=\s*"([^"]+)"/);
      expect(m, p).toBeTruthy();
      expect(existsSync(resolve(root, dirname(p), m![1])), `${p} -> ${m![1]}`).toBe(true);
    }
    expect(read("deploy/fly/fly.portal.toml")).toContain("../docker/Dockerfile.server");
  });
});
