import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { isDockerAvailable, __resetDockerProbeCache, dockerProbeTimeoutMs } = await import("../../src/executor/docker-sandbox.js");

function hangingProc() {
  const proc = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  proc.kill = vi.fn();
  return proc; // never emits "close"
}

describe("isDockerAvailable probe (#32)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    __resetDockerProbeCache();
  });

  it("resolves false within the timeout and kills a hung docker process", async () => {
    const proc = hangingProc();
    spawnMock.mockReturnValue(proc);
    const start = Date.now();
    const result = await isDockerAvailable(100);
    expect(result).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("reuses the cached result within the TTL (spawn called once)", async () => {
    spawnMock.mockImplementation(() => {
      const proc = hangingProc();
      setTimeout(() => proc.emit("close", 0), 5);
      return proc;
    });
    expect(await isDockerAvailable(1000)).toBe(true);
    expect(await isDockerAvailable(1000)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("resolves false on spawn error (docker not installed)", async () => {
    spawnMock.mockImplementation(() => {
      const proc = hangingProc();
      setTimeout(() => proc.emit("error", new Error("ENOENT")), 5);
      return proc;
    });
    expect(await isDockerAvailable(1000)).toBe(false);
  });

  it("collapses concurrent probes into one docker process", async () => {
    spawnMock.mockImplementation(() => {
      const proc = hangingProc();
      setTimeout(() => proc.emit("close", 0), 20);
      return proc;
    });
    const results = await Promise.all([isDockerAvailable(1000), isDockerAvailable(1000), isDockerAvailable(1000)]);
    expect(results).toEqual([true, true, true]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("dockerProbeTimeoutMs", () => {
  it("falls back to 3000 for unset, empty, garbage, zero or negative values", () => {
    for (const raw of [undefined, "", "  ", "abc", "0", "-5", "NaN"]) expect(dockerProbeTimeoutMs(raw)).toBe(3000);
  });
  it("uses a valid positive value", () => {
    expect(dockerProbeTimeoutMs("1500")).toBe(1500);
  });
});
