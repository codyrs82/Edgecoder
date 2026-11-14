import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #9: static guards for the multi-stage images. The CI docker-build job checks the built images.
const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const images = ["deploy/docker/Dockerfile.server", "deploy/docker/Dockerfile.agent", "deploy/gpu-agent/Dockerfile.inference"];

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

  it.each(["deploy/docker/Dockerfile.agent", "deploy/gpu-agent/Dockerfile.inference"])("%s pins and verifies Ollama (no curl | sh)", (p) => {
    const df = read(p);
    expect(df).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(df).toMatch(/ARG OLLAMA_VERSION=\d+\.\d+\.\d+/);
    expect(df).toMatch(/ARG OLLAMA_SHA256=[0-9a-f]{64}/);
    // The archive is checked before it is unpacked.
    expect(df).toMatch(/sha256sum -c -/);
    expect(df.indexOf("sha256sum -c -")).toBeLessThan(df.indexOf("tar --zstd"));
  });

  it("the inference image uses the agent image's Ollama pin", () => {
    const pin = (p: string) => [...read(p).matchAll(/^ARG (OLLAMA_VERSION|OLLAMA_SHA256)=(\S+)$/gm)].map((m) => m[0]);
    expect(pin("deploy/gpu-agent/Dockerfile.inference")).toEqual(pin("deploy/docker/Dockerfile.agent"));
    expect(pin("deploy/docker/Dockerfile.agent")).toHaveLength(2);
  });

  it("the inference image is inference-only: no sandbox, reserved flag set, GPU requested from the runtime", () => {
    const df = read("deploy/gpu-agent/Dockerfile.inference");
    const runtime = df.slice(df.lastIndexOf("\nFROM "));
    expect(runtime).toMatch(/\bSANDBOX_MODE=none\b/);
    expect(runtime).toMatch(/\bAGENT_INFERENCE_ONLY=1\b/);
    expect(runtime).toMatch(/\bLOCAL_MODEL_PROVIDER=ollama-local\b/);
    expect(runtime).toMatch(/\bNVIDIA_DRIVER_CAPABILITIES=compute,utility\b/);
    expect(runtime).not.toMatch(/docker\.io|docker-ce|\/var\/run\/docker\.sock/);
    expect(existsSync(resolve(root, "deploy/gpu-agent/Dockerfile.inference.dockerignore"))).toBe(true);
    for (const m of df.matchAll(/^COPY (?:--\S+ )*(deploy\/\S+) /gm)) expect(existsSync(resolve(root, m[1])), m[1]).toBe(true);
    const entry = read("deploy/gpu-agent/inference-entrypoint.sh");
    // It refuses a sandbox mode it cannot provide and never runs task code itself.
    expect(entry).toMatch(/SANDBOX_MODE:-none\}" != none/);
    expect(entry).not.toMatch(/\|\s*(ba)?sh\b/);
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
