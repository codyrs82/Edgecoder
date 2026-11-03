import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SANDBOX_DOCKERFILES } from "../../src/executor/docker-sandbox.js";

describe("SANDBOX_DOCKERFILES", () => {
  it("match docker/sandbox-*.Dockerfile, which the worker builds from on first use", () => {
    expect(SANDBOX_DOCKERFILES.python).toBe(readFileSync("docker/sandbox-python.Dockerfile", "utf8"));
    expect(SANDBOX_DOCKERFILES.javascript).toBe(readFileSync("docker/sandbox-node.Dockerfile", "utf8"));
  });
});
