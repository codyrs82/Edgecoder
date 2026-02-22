import { describe, expect, it } from "vitest";
import { isDockerAvailable, runInDockerSandbox } from "../../src/executor/docker-sandbox.js";

describe("Docker sandbox", () => {
  it("isDockerAvailable returns a boolean", async () => {
    const result = await isDockerAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("runInDockerSandbox returns a RunResult shape", async () => {
    const available = await isDockerAvailable();
    if (!available) {
      console.log("Docker not available, skipping sandbox execution test");
      return;
    }

    const result = await runInDockerSandbox("python", "print('sandbox-ok')", 10000);
    expect(result.language).toBe("python");
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.exitCode).toBe("number");
  });
});
