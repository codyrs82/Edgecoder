import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdQuote, redactPlan, runInstaller, writeFileFresh } from "../../src/install/cli.js";
import { detectHardware, type Probe } from "../../src/install/hardware.js";
import { parseInstallArgs } from "../../src/install/options.js";
import { planInstall } from "../../src/install/plan.js";
import type { Host } from "../../src/install/services.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("installer host: secret files and command lines", () => {
  it.runIf(posix)("creates a secret file with its final mode and replaces a planted symlink instead of following it", () => {
    const d = mkdtempSync(join(tmpdir(), "ec-write-"));
    dirs.push(d);
    const victim = join(d, "victim");
    writeFileSync(victim, "original");
    const env = join(d, "agent-0.env");
    symlinkSync(victim, env);
    writeFileFresh(env, "AGENT_REGISTRATION_TOKEN=t\n", 0o600);
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(lstatSync(env).isSymbolicLink()).toBe(false);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    // An existing world-readable file is replaced, not rewritten in place with its old mode.
    writeFileSync(join(d, "x.env"), "old", { mode: 0o644 });
    writeFileFresh(join(d, "x.env"), "new", 0o600);
    expect(statSync(join(d, "x.env")).mode & 0o777).toBe(0o600);
  });

  it("quotes cmd.exe arguments that need it and refuses ones that cannot be quoted", () => {
    expect(cmdQuote("C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Ollama\\ollama.exe")).toBe('"C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Ollama\\ollama.exe"');
    expect(cmdQuote("C:\\x&calc.exe")).toBe('"C:\\x&calc.exe"');
    expect(cmdQuote("pull")).toBe("pull");
    expect(cmdQuote("qwen3-coder:30b")).toBe("qwen3-coder:30b");
    expect(cmdQuote('"C:\\ProgramData\\EdgeCoder"')).toBe('"C:\\ProgramData\\EdgeCoder"');
    expect(cmdQuote("*S-1-5-32-544:(OI)(CI)F")).toBe('"*S-1-5-32-544:(OI)(CI)F"');
    for (const bad of ['a"b', 'a"b"c', "%PATH%", "a\r\nb"]) expect(() => cmdQuote(bad)).toThrow(/cmd\.exe/);
  });

  it("--json never prints registration or mesh tokens", async () => {
    const probe: Probe = () => null;
    const hw = detectHardware({ probe, platform: "linux", arch: "x64", ramGb: 32, cpuModel: "x", cpuCores: 8, hostname: "box" });
    const plan = planInstall(hw, parseInstallArgs(["plan", "--token", "secret-reg", "--mesh-token", "secret-mesh"]), true);
    const red = JSON.stringify(redactPlan(plan));
    expect(red).not.toContain("secret-reg");
    expect(red).not.toContain("secret-mesh");
    expect(red).toContain('"AGENT_REGISTRATION_TOKEN":"<redacted>"');
    expect(plan.instances[0].env.AGENT_REGISTRATION_TOKEN).toBe("secret-reg"); // the plan itself is untouched

    const host: Host = { platform: "linux", writeFile: () => undefined, removeFile: () => undefined, run: () => ({ code: 1, stdout: "", stderr: "" }), exists: () => false };
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m: unknown) => { out.push(String(m)); });
    try {
      expect(await runInstaller(["plan", "--json", "--sandbox", "docker", "--token", "secret-reg", "--mesh-token", "secret-mesh"], {}, host)).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(out.join("\n")).not.toMatch(/secret-reg|secret-mesh/);
    expect(out.join("\n")).toContain("<redacted>");
  });
});
