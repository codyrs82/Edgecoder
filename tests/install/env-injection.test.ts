import { describe, expect, it, vi } from "vitest";
import { detectHardware, type Probe } from "../../src/install/hardware.js";
import { checkServiceUrl, parseInstallArgs, validateInstallOptions } from "../../src/install/options.js";
import { planInstall, renderEnvFile } from "../../src/install/plan.js";
import { defaultPaths, windowsAgentCmd, windowsOllamaCmd, type Host } from "../../src/install/services.js";
import { enrollNodes, runInstaller, type HttpPost } from "../../src/install/cli.js";

const probe: Probe = (cmd) => (cmd === "nvidia-smi" ? "0, NVIDIA RTX 6000 Ada Generation, 49140\n" : null);
const hw = detectHardware({ probe, platform: "linux", arch: "x64", ramGb: 64, cpuModel: "x", cpuCores: 8, hostname: "box" });

const nullHost: Host = {
  platform: "linux",
  writeFile: () => { throw new Error("must not write"); },
  removeFile: () => undefined,
  run: () => { throw new Error("must not run"); },
  exists: () => false
};

describe("installer: values written into env files and .cmd wrappers", () => {
  it("renderEnvFile refuses a value that would add a line or change the systemd parse", () => {
    expect(renderEnvFile({ A: "ok-token_1.2/+=" })).toContain("A=ok-token_1.2/+=\n");
    expect(() => renderEnvFile({ AGENT_REGISTRATION_TOKEN: "x\nNODE_OPTIONS=--import data:text/javascript,1" })).toThrow(/single line/);
    expect(() => renderEnvFile({ A: "x\r" })).toThrow(/single line/);
    for (const bad of ['a"b', "a'b", "a\\b", "a$b", "a`b"]) expect(() => renderEnvFile({ A: bad })).toThrow(/quotes, backslashes/);
    expect(() => renderEnvFile({ "A\nB": "x" })).toThrow(/variable name/);
  });

  it("the Windows wrapper refuses values that break out of set \"K=V\"", () => {
    const p = defaultPaths("win32", { configDir: "C:\\ProgramData\\EdgeCoder", appDir: "C:\\Program Files\\EdgeCoder\\app", nodeBin: "C:\\node.exe", modelsDir: "C:\\ProgramData\\EdgeCoder\\ollama", logDir: "C:\\ProgramData\\EdgeCoder\\logs", user: "BOX\\me" });
    const plan = planInstall({ ...hw, platform: "win32" }, parseInstallArgs(["apply", "--token", "t"]), false);
    const inst = plan.instances[0];
    expect(windowsAgentCmd(p, inst)).toContain('set "AGENT_REGISTRATION_TOKEN=t"');
    for (const bad of ['x"&calc&"', "x%PATH%", "x&calc", "x|y", "x^y", "x<y", "x>y", "x\r\ncalc"]) {
      expect(() => windowsAgentCmd(p, { ...inst, env: { ...inst.env, AGENT_REGISTRATION_TOKEN: bad } })).toThrow(/\.cmd wrapper/);
    }
    expect(() => windowsOllamaCmd({ ...p, modelsDir: 'C:\\x"&calc' }, inst)).toThrow(/\.cmd wrapper/);
  });

  it("accepts https and loopback http, refuses plain http elsewhere", () => {
    expect(checkServiceUrl("--portal-url", "https://edgecoder.io")).toBeUndefined();
    expect(checkServiceUrl("--portal-url", "http://127.0.0.1:4310")).toBeUndefined();
    expect(checkServiceUrl("--portal-url", "http://localhost:4310/")).toBeUndefined();
    expect(checkServiceUrl("--portal-url", "http://[::1]:4310")).toBeUndefined();
    expect(checkServiceUrl("--portal-url", "http://portal.example")).toMatch(/must use https/);
    expect(checkServiceUrl("--coordinator-url", "http://127.0.0.1.evil.example")).toMatch(/must use https/);
    expect(checkServiceUrl("--coordinator-url", "ftp://c.example")).toMatch(/must use https/);
    expect(checkServiceUrl("--coordinator-url", "https://c.example/$x")).toMatch(/characters/);
    expect(checkServiceUrl("--coordinator-url", "not a url")).toMatch(/not a valid URL/);
  });

  it("validates --token, --mesh-token, --tokens-file values and both URLs", () => {
    expect(validateInstallOptions(parseInstallArgs(["apply", "--token", "a=tok", "--mesh-token", "m"]))).toEqual([]);
    expect(validateInstallOptions(parseInstallArgs(["apply", "--token", "a=x\nNODE_OPTIONS=1"]))).toHaveLength(1);
    expect(validateInstallOptions(parseInstallArgs(["apply", "--mesh-token", 'm"&x']))).toHaveLength(1);
    expect(validateInstallOptions(parseInstallArgs(["apply", "--coordinator-url", "http://c.example", "--portal-url", "http://p.example"]))).toHaveLength(2);
    expect(validateInstallOptions(parseInstallArgs(["apply"], { EDGECODER_PORTAL_URL: "http://p.example" }))).toHaveLength(1);
  });

  it("runInstaller stops before touching the host on a bad token or an http portal", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await runInstaller(["apply", "--token", "x$y"], {}, nullHost)).toBe(2);
      expect(await runInstaller(["apply", "--portal-url", "http://p.example", "--enroll", "eck_x"], {}, nullHost)).toBe(2);
      expect(await runInstaller(["plan", "--coordinator-url", "http://c.example"], {}, nullHost)).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("refuses an enrol response whose registrationToken is not a plain token", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const opts = parseInstallArgs(["apply", "--enroll", "ptok", "--portal-url", "https://portal.example"]);
      const plan = planInstall(hw, opts, true);
      const post: HttpPost = async () => ({ status: 200, json: async () => ({ registrationToken: "x\nNODE_OPTIONS=--import data:text/javascript,1" }) });
      const r = await enrollNodes(opts, plan.instances, post);
      expect(r.enrolled).toEqual([]);
      expect(r.failed).toEqual(["box-gpu"]);
      expect(opts.tokens).toEqual({});
    } finally {
      err.mockRestore();
    }
  });
});
