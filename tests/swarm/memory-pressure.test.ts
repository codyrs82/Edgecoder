import { describe, expect, it } from "vitest";
import { classifyLinux, classifyMac, parseMeminfo, parsePsi, parseVmStat, PressureGuard, readMemoryPressure, type PressureDeps } from "../../src/swarm/memory-pressure.js";

const GB = 1024 ** 3;
const vmStat = (free: number, inactive: number, compressor: number) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               ${free}.
Pages active:                             1200000.
Pages inactive:                           ${inactive}.
Pages speculative:                        1000.
Pages throttled:                                 0.
Pages wired down:                          300000.
Pages purgeable:                             2000.
"Translation faults":                   123456789.
Pages occupied by compressor:              ${compressor}.
`;
const meminfo = (totalKb: number, availKb: number) => `MemTotal:       ${totalKb} kB\nMemFree:          100000 kB\nMemAvailable:   ${availKb} kB\nCached:          500000 kB\n`;
const psi = (some: number, full: number) => `some avg10=${some.toFixed(2)} avg60=1.00 avg300=0.50 total=12345\nfull avg10=${full.toFixed(2)} avg60=0.10 avg300=0.05 total=678\n`;

function mac(level: string | null, vm: string | null): PressureDeps {
  return { platform: "darwin", totalBytes: 48 * GB, freeBytes: () => 0, readFile: () => null, exec: (cmd) => (cmd.endsWith("sysctl") ? level : vm) };
}
function linux(mi: string | null, p: string | null): PressureDeps {
  return { platform: "linux", totalBytes: 64 * GB, freeBytes: () => 32 * GB, exec: () => null, readFile: (f) => (f === "/proc/meminfo" ? mi : f === "/proc/pressure/memory" ? p : null) };
}

describe("memory pressure", () => {
  it("parses vm_stat, /proc/meminfo and PSI", () => {
    expect(parseVmStat(vmStat(5000, 6000, 7000))).toMatchObject({ pageSize: 16384, free: 5000, inactive: 6000, speculative: 1000, purgeable: 2000, compressor: 7000 });
    expect(parseVmStat("nope")).toBeUndefined();
    expect(parseMeminfo(meminfo(65_536_000, 8_192_000))).toEqual({ totalBytes: 65_536_000 * 1024, availableBytes: 8_192_000 * 1024 });
    expect(parsePsi(psi(12.5, 3))).toEqual({ someAvg10: 12.5, fullAvg10: 3 });
  });

  it("macOS thresholds: kernel level, available pages, compressor", () => {
    expect(classifyMac({ kernelLevel: 1, availablePct: 30 })).toBe("normal");
    expect(classifyMac({ kernelLevel: 2 })).toBe("warning");
    expect(classifyMac({ kernelLevel: 4 })).toBe("critical");
    expect(classifyMac({ kernelLevel: 1, availablePct: 7.9 })).toBe("warning");
    expect(classifyMac({ kernelLevel: 1, availablePct: 2.9 })).toBe("critical");
    expect(classifyMac({ kernelLevel: 1, availablePct: 30, compressorPct: 40 })).toBe("warning");
    // 48 GB, 16 KiB pages: 3,145,728 pages. Plenty free / 6% free / the kernel says critical.
    expect(readMemoryPressure(mac("1\n", vmStat(1_000_000, 500_000, 100_000))).level).toBe("normal");
    expect(readMemoryPressure(mac("1\n", vmStat(100_000, 85_000, 100_000))).level).toBe("warning");
    const crit = readMemoryPressure(mac("4\n", vmStat(1_000_000, 500_000, 100_000)));
    expect(crit.level).toBe("critical");
    expect(crit.detail).toContain("kernel level 4");
    // No sysctl or vm_stat: normal, said so.
    expect(readMemoryPressure(mac(null, null))).toMatchObject({ level: "normal", detail: "no reading" });
  });

  it("Linux thresholds: MemAvailable and PSI", () => {
    expect(classifyLinux({ availablePct: 50, psi: { someAvg10: 0, fullAvg10: 0 } })).toBe("normal");
    expect(classifyLinux({ availablePct: 9 })).toBe("warning");
    expect(classifyLinux({ availablePct: 4 })).toBe("critical");
    expect(classifyLinux({ availablePct: 50, psi: { someAvg10: 30 } })).toBe("warning");
    expect(classifyLinux({ availablePct: 50, psi: { someAvg10: 30, fullAvg10: 12 } })).toBe("critical");
    expect(readMemoryPressure(linux(meminfo(65_536_000, 32_000_000), psi(0.5, 0))).level).toBe("normal");
    expect(readMemoryPressure(linux(meminfo(65_536_000, 6_000_000), psi(0.5, 0))).level).toBe("warning");
    expect(readMemoryPressure(linux(meminfo(65_536_000, 2_000_000), null)).level).toBe("critical");
    expect(readMemoryPressure(linux(meminfo(65_536_000, 32_000_000), psi(40, 15))).level).toBe("critical");
  });

  it("other platforms: free memory", () => {
    const d: PressureDeps = { platform: "win32", totalBytes: 16 * GB, freeBytes: () => 1 * GB, exec: () => null, readFile: () => null };
    expect(readMemoryPressure(d).level).toBe("warning");
  });

  it("worse at once, better only after it holds", () => {
    const g = new PressureGuard(30_000);
    expect(g.update("warning", 0)).toMatchObject({ level: "warning", changed: true });
    expect(g.update("critical", 1_000)).toMatchObject({ level: "critical", changed: true });
    expect(g.update("normal", 2_000).level).toBe("critical");
    expect(g.update("warning", 20_000).level).toBe("critical");
    // 30 s after recovery started: the worst reading since then (warning).
    expect(g.update("normal", 32_000)).toMatchObject({ level: "warning", changed: true });
    expect(g.update("normal", 40_000).level).toBe("warning");
    expect(g.update("normal", 70_000)).toMatchObject({ level: "normal", changed: true });
    // A spike during recovery restarts nothing it shouldn't: worse is immediate.
    expect(g.update("critical", 71_000).level).toBe("critical");
  });
});
