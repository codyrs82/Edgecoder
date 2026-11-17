import { afterEach, describe, expect, it, vi } from "vitest";
import { enrollmentConfirmation, pullModels, runInstaller, type HttpGet } from "../../src/install/cli.js";
import { detectHardware } from "../../src/install/hardware.js";
import { parseInstallArgs } from "../../src/install/options.js";
import { planInstall } from "../../src/install/plan.js";
import { allocateOllamaPorts, portOwner } from "../../src/install/ports.js";
import { defaultPaths, serviceStatus, type Host } from "../../src/install/services.js";

const hw = detectHardware({ probe: () => null, platform: "linux", arch: "x64", ramGb: 32, cpuModel: "x", cpuCores: 8, hostname: "nvidia-1" });
const SS = (port: number, proc: string, pid: number) => `LISTEN 0 4096 127.0.0.1:${port} 0.0.0.0:* users:(("${proc}",pid=${pid},fd=3))\n`;

/** A Linux host where `ss` reports the given listeners and systemctl the given states. */
function linuxHost(listeners: Record<number, { proc: string; pid: number }>, states: Record<string, string> = {}, files: Record<string, string> = {}) {
  const runs: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
  const host: Host = {
    platform: "linux",
    writeFile: () => undefined,
    removeFile: () => undefined,
    exists: (p) => p in files,
    run: (cmd, args, env) => {
      runs.push({ cmd, args, env });
      if (cmd === "ss") {
        const port = Number(/:(\d+)$/.exec(args[1])?.[1]);
        const l = listeners[port];
        return { code: 0, stdout: l ? SS(port, l.proc, l.pid) : "", stderr: "" };
      }
      if (cmd === "systemctl" && args[0] === "is-active") return { code: 0, stdout: `${states[args[1]] ?? "active"}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
  };
  return { host, runs };
}
const cgroups: Record<string, string> = {
  "/proc/812/cgroup": "0::/system.slice/ollama.service\n",
  "/proc/900/cgroup": "0::/system.slice/edgecoder-ollama-0.service\n"
};
const read = (f: string) => cgroups[f];

afterEach(() => vi.restoreAllMocks());

describe("an Ollama already on 11434", () => {
  it("names the holder of a port: process, pid and systemd unit", () => {
    const { host } = linuxHost({ 11434: { proc: "ollama", pid: 812 } });
    expect(portOwner(host, 11434, read)).toEqual({ pid: 812, process: "ollama", unit: "ollama.service" });
    expect(portOwner(host, 11435, read)).toBeNull();
  });

  it("skips ports another program holds, keeps EdgeCoder's own", () => {
    const { host } = linuxHost({ 11434: { proc: "ollama", pid: 812 } });
    const r = allocateOllamaPorts(2, (p) => portOwner(host, p, read));
    expect(r.ports).toEqual({ 0: 11435, 1: 11436 });
    expect(r.notes[0]).toMatch(/port 11434 is in use by ollama.service \(the system's own Ollama\).*sudo systemctl disable --now ollama.service/);
    const ours = linuxHost({ 11434: { proc: "ollama", pid: 900 } });
    expect(allocateOllamaPorts(2, (p) => portOwner(ours.host, p, read))).toEqual({ ports: { 0: 11434, 1: 11435 }, notes: [] });
  });

  it("the plan and the pull use the chosen port", () => {
    const opts = { ...parseInstallArgs(["apply", "--pull-models"]), ollamaPorts: { 0: 11435 } };
    const plan = planInstall(hw, opts, true);
    expect(plan.instances[0].ollamaPort).toBe(11435);
    expect(plan.instances[0].env.OLLAMA_HOST).toBe("http://127.0.0.1:11435");
    const { host, runs } = linuxHost({});
    expect(pullModels(host, "ollama", plan.instances, 1, () => {})).toEqual([]);
    expect(runs.at(-1)).toMatchObject({ cmd: "ollama", args: ["pull", plan.instances[0].model], env: { OLLAMA_HOST: "127.0.0.1:11435" } });
  });

  it("runInstaller plan moves instance 0 off a busy 11434 and says why", async () => {
    const { host } = linuxHost({ 11434: { proc: "ollama", pid: 812 } });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => { out.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation((m: unknown) => { out.push(String(m)); });
    expect(await runInstaller(["plan", "--json", "--sandbox", "docker", "--config-dir", "/nonexistent-ec"], {}, host, undefined, undefined, async () => ({ status: 404, json: async () => ({}) }))).toBe(0);
    const json = JSON.parse(out.find((l) => l.startsWith("{"))!);
    expect(json.plan.instances[0].ollamaPort).not.toBe(11434);
    expect(out.join("\n")).toMatch(/port 11434 is in use by/);
  });

  it("status says why edgecoder-ollama-0 is stuck activating", () => {
    const p = defaultPaths("linux", { appDir: "/opt/edgecoder" });
    const env = `${p.configDir}/agent-0.env`;
    const { host } = linuxHost({ 11434: { proc: "ollama", pid: 812 } }, { "edgecoder-ollama-0.service": "activating" }, { [env]: "x" });
    const s = serviceStatus(host, p, 4, (f) => (f === env ? "OLLAMA_HOST=http://127.0.0.1:11434\n" : read(f)));
    expect(s[0]).toEqual({ name: "edgecoder-ollama-0.service", state: "activating", reason: "port 11434 in use by ollama.service: sudo systemctl disable --now ollama, then run edgecoder-install apply again" });
    expect(s[1]).toEqual({ name: "edgecoder-agent-0.service", state: "active" });
  });
});

describe("enrolment confirmation after apply", () => {
  const get: HttpGet = async (_u, init) => {
    const t = init.headers.authorization.slice(7);
    return t === "tok-a" ? { status: 200, json: async () => ({ nodeId: "RTXA2000-Laptop", nodeKind: "agent" }) } : { status: 401, json: async () => ({}) };
  };
  const inst = (agentId: string, token: string) => ({ agentId, env: { AGENT_REGISTRATION_TOKEN: token } }) as never;

  it("Enrolled as <id> ✓, or the reason", async () => {
    expect(await enrollmentConfirmation("https://edgecoder.io", [inst("RTXA2000-Laptop", "tok-a")], [], get)).toEqual(["Enrolled as RTXA2000-Laptop ✓"]);
    const lines = await enrollmentConfirmation("https://edgecoder.io", [inst("nvidia-1-gpu", "tok-a"), inst("box-gpu0", ""), inst("box-gpu1", ""), inst("x-gpu", "tok-unknown")], ["box-gpu1"], get);
    expect(lines[0]).toBe(`Not enrolled: nvidia-1-gpu (its token is for "RTXA2000-Laptop"; re-run with --token nvidia-1-gpu=<token for nvidia-1-gpu>)`);
    expect(lines[1]).toBe("Not enrolled: box-gpu0 (no registration token)");
    expect(lines[2]).toMatch(/^Not enrolled: box-gpu1 \(enrolment with the install key failed/);
    expect(lines[3]).toMatch(/^Not confirmed: x-gpu \(https:\/\/edgecoder.io did not recognise/);
  });
});
