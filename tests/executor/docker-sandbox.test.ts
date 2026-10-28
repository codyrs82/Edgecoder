import { describe, expect, it } from "vitest";
import { isDockerAvailable, runInDockerSandbox } from "../../src/executor/docker-sandbox.js";

// #32: probe once (bounded by DOCKER_PROBE_TIMEOUT_MS) and skip cleanly when Docker is absent.
const dockerUp = await isDockerAvailable();

describe("Docker sandbox", () => {
  it("isDockerAvailable returns a boolean", async () => {
    const result = await isDockerAvailable();
    expect(typeof result).toBe("boolean");
  });

  it.skipIf(!dockerUp)(
    "runInDockerSandbox returns a RunResult shape",
    async () => {
      const result = await runInDockerSandbox("python", "print('sandbox-ok')", 10000);
      expect(result.language).toBe("python");
      expect(typeof result.ok).toBe("boolean");
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.exitCode).toBe("number");
    },
    20_000
  );
});
