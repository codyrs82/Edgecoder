import { afterEach, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({
  available: false,
  runInDockerSandbox: vi.fn(async (language: string) => ({
    language, ok: true, stdout: "from-docker", stderr: "", exitCode: 0, durationMs: 1, queueForCloud: false
  })),
  ensureSandboxImages: vi.fn(async () => ({ ok: true as const }))
}));

vi.mock("../../src/executor/docker-sandbox.js", () => ({
  isDockerAvailable: async () => docker.available,
  runInDockerSandbox: docker.runInDockerSandbox,
  ensureSandboxImages: docker.ensureSandboxImages
}));

const { runCode, unsafeHostExecutionAllowed } = await import("../../src/executor/run.js");
const { InteractiveAgent } = await import("../../src/agent/interactive.js");
const { EdgeCoderLocalProvider } = await import("../../src/model/providers.js");

afterEach(() => {
  delete process.env.EDGECODER_UNSAFE_HOST_EXECUTION;
  docker.available = false;
  docker.runInDockerSandbox.mockClear();
  docker.ensureSandboxImages.mockClear();
});

describe("local-origin code runs in the Docker sandbox", () => {
  it("runs local code in Docker when Docker is available, building images first", async () => {
    docker.available = true;
    const res = await runCode("javascript", "console.log(1)", 4000, "docker", undefined, "local");
    expect(res.stdout).toBe("from-docker");
    expect(docker.ensureSandboxImages).toHaveBeenCalled();
    expect(docker.runInDockerSandbox).toHaveBeenCalled();
  });

  it("refuses local code without Docker unless the host opt-in is set", async () => {
    const res = await runCode("javascript", "console.log(1)", 4000, "docker", undefined, "local");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("sandbox_unavailable");
    expect(res.stderr).toContain("EDGECODER_UNSAFE_HOST_EXECUTION");
  });

  it("falls back to the host for local code only with EDGECODER_UNSAFE_HOST_EXECUTION=1", async () => {
    process.env.EDGECODER_UNSAFE_HOST_EXECUTION = "1";
    const res = await runCode("javascript", "console.log(1)", 4000, "docker", undefined, "local");
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("1");
  });

  it("never falls back to the host for remote code, even with the opt-in", async () => {
    process.env.EDGECODER_UNSAFE_HOST_EXECUTION = "1";
    const res = await runCode("javascript", "console.log(1)", 4000, "docker", undefined, "remote");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("sandbox_unavailable");
  });

  it("only the exact value 1 opts in", () => {
    expect(unsafeHostExecutionAllowed({ EDGECODER_UNSAFE_HOST_EXECUTION: "true" })).toBe(false);
    expect(unsafeHostExecutionAllowed({})).toBe(false);
    expect(unsafeHostExecutionAllowed({ EDGECODER_UNSAFE_HOST_EXECUTION: "1" })).toBe(true);
  });

  it("InteractiveAgent uses the Docker sandbox by default", async () => {
    docker.available = true;
    const agent = new InteractiveAgent(new EdgeCoderLocalProvider());
    const out = await agent.run("print('hi')", "python");
    expect(docker.runInDockerSandbox).toHaveBeenCalled();
    expect(out.runResult.stdout).toBe("from-docker");
  });
});
