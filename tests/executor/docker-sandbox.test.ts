import { describe, expect, it } from "vitest";
import { buildDockerArgs, isDockerAvailable, runInDockerSandbox } from "../../src/executor/docker-sandbox.js";

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

describe("buildDockerArgs hardening (#45)", () => {
  it("includes least-privilege flags", () => {
    const args = buildDockerArgs("img:test", "code");
    for (const flag of [
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=65534:65534",
      "--network=none",
      "--read-only",
      "--pids-limit=50",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
      "--ulimit=nofile=256:256"
    ]) expect(args).toContain(flag);
    // image and code stay last
    expect(args.slice(-2)).toEqual(["img:test", "code"]);
  });

  it("adds a seccomp profile only when SANDBOX_SECCOMP_PROFILE is set", () => {
    const prev = process.env.SANDBOX_SECCOMP_PROFILE;
    try {
      delete process.env.SANDBOX_SECCOMP_PROFILE;
      expect(buildDockerArgs("i", "c").some((a) => a.includes("seccomp"))).toBe(false);
      process.env.SANDBOX_SECCOMP_PROFILE = "/etc/edgecoder/seccomp.json";
      expect(buildDockerArgs("i", "c")).toContain("--security-opt=seccomp=/etc/edgecoder/seccomp.json");
    } finally {
      if (prev === undefined) delete process.env.SANDBOX_SECCOMP_PROFILE;
      else process.env.SANDBOX_SECCOMP_PROFILE = prev;
    }
  });
});
