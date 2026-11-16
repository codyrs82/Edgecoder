import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planVllmInstalls, resolveEngines, runInstaller } from "../../src/install/cli.js";
import { engineProblems, legacyVllmMarkerPath, parseEnvFile, previousEngine, resolveInstanceEngine, VLLM_UNIT_PATH, vllmDropInPath, vllmMarkerPath } from "../../src/install/engine.js";
import { detectHardware } from "../../src/install/hardware.js";
import { parseInstallArgs, type InstallOptions } from "../../src/install/options.js";
import { planInstall, renderEnvFile, type InstallPlan } from "../../src/install/plan.js";
import { applyPlan, defaultPaths, envFilePath, removeServices, serviceStatus, systemdAgentUnit, type Host, type ServicePaths } from "../../src/install/services.js";

/*
 * --engine and keeping it: a re-run of the installer (a package upgrade, the GPU VM's update.sh)
 * must never drop an instance's vLLM lines, marker or Ollama switch drop-in (src/install/engine.ts).
 */

// The Chicago VM: 2x A16 pooled into one instance.
const A16X2 = "0, NVIDIA A16, 15356\n1, NVIDIA A16, 15356\n";
const hw = detectHardware({ probe: (cmd) => (cmd === "nvidia-smi" ? A16X2 : null), platform: "linux", arch: "x64", ramGb: 120, cpuModel: "Xeon", cpuCores: 12, hostname: "ec-st10-chi" });
const AWQ = "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ";
const VLLM_ENV = `# Written by install-vllm.sh (a16x2)\nVLLM_MODEL_ID=${AWQ}\nVLLM_PORT=8000\nCUDA_VISIBLE_DEVICES=0,1\nVLLM_ARGS="--tensor-parallel-size 2 --max-model-len 65536"\nHF_HUB_OFFLINE=1\n`;
const ENGINE_KEYS = /^(EDGECODER_ENGINE|VLLM_|MLX_)/m;

/** A host whose files live in a map; `run` records the commands. */
function fakeHost(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const commands: string[] = [];
  const host: Host = {
    platform: "linux",
    writeFile: (p, c) => { files.set(p, c); },
    removeFile: (p) => { files.delete(p); },
    run: (cmd, args) => { commands.push([cmd, ...args].join(" ")); return { code: 0, stdout: "active\n", stderr: "" }; },
    exists: (p) => files.has(p)
  };
  return { host, files, commands };
}

const paths = (): ServicePaths => defaultPaths("linux", { appDir: "/opt/edgecoder/app", nodeBin: "/opt/edgecoder/node/bin/node", ollamaBin: "/usr/local/bin/ollama" });
const VLLM_INSTALLED = { "/opt/edgecoder/vllm/venv/bin/vllm": "", "/etc/edgecoder/vllm-0.env": VLLM_ENV, [VLLM_UNIT_PATH]: "" };

/** One installer run as the CLI does it: resolve engines from the host's files, plan, apply. */
function run(argv: string[], h: ReturnType<typeof fakeHost>): { opts: InstallOptions; plan: InstallPlan; commands: string[] } {
  const p = paths();
  const opts = parseInstallArgs(["apply", "--single", "--sandbox", "docker", "--model", "qwen3-coder:30b", "--agent-id-prefix", "ec-st10-chi", "--token", "tok", ...argv]);
  let plan = planInstall(hw, opts, true);
  opts.instanceEngines = resolveEngines(opts, plan, p, (f) => h.files.get(f), (f) => h.files.has(f));
  plan = planInstall(hw, opts, true);
  expect(planVllmInstalls(opts, plan, p, (f) => h.files.has(f))).toEqual([]);
  h.commands.length = 0;
  const r = applyPlan(plan, h.host, p, false);
  // Every step in order: host commands and the file removals (rm -f).
  return { opts, plan, commands: r.commands };
}

const env0 = (h: ReturnType<typeof fakeHost>) => parseEnvFile(h.files.get("/etc/edgecoder/agent-0.env") ?? "");

describe("--engine flags", () => {
  it("parses --engine and the --vllm-* options; a --vllm-* flag implies --engine vllm", () => {
    expect(parseInstallArgs(["apply"]).engine).toBeUndefined();
    expect(parseInstallArgs(["apply", "--engine", "VLLM"]).engine).toBe("vllm");
    expect(parseInstallArgs(["apply", "--engine=mlx"]).engine).toBe("mlx");
    const o = parseInstallArgs(["apply", "--vllm-model", AWQ, "--vllm-slots", "2", "--vllm-url", "http://127.0.0.1:8000/", "--vllm-profile", "a16x2"]);
    expect(o).toMatchObject({ engine: "vllm", vllmModel: AWQ, vllmSlots: 2, vllmUrl: "http://127.0.0.1:8000", vllmProfile: "a16x2" });
    expect(parseInstallArgs(["apply", "--vllm-slots", "4"]).engine).toBe("vllm");
  });

  it("refuses bad values and --vllm-* with another engine", () => {
    expect(() => parseInstallArgs(["apply", "--engine", "tgi"])).toThrow(/ollama, vllm or mlx/);
    expect(() => parseInstallArgs(["apply", "--vllm-slots", "0"])).toThrow(/1 to 16/);
    expect(() => parseInstallArgs(["apply", "--vllm-slots", "17"])).toThrow(/1 to 16/);
    expect(() => parseInstallArgs(["apply", "--vllm-model", "a/b; rm -rf /"])).toThrow(/--vllm-model/);
    expect(() => parseInstallArgs(["apply", "--vllm-url", "ftp://x"])).toThrow(/--vllm-url/);
    expect(() => parseInstallArgs(["apply", "--vllm-url", "http://x/$(id)"])).toThrow(/--vllm-url/);
    expect(() => parseInstallArgs(["apply", "--vllm-profile", "h100"])).toThrow(/a16x2, a100-80/);
    expect(() => parseInstallArgs(["apply", "--engine", "ollama", "--vllm-model", AWQ])).toThrow(/go with --engine vllm/);
  });

  it("vLLM is Linux-only and MLX macOS-only", () => {
    expect(engineProblems("vllm", "linux")).toEqual([]);
    expect(engineProblems("vllm", "darwin")[0]).toMatch(/Linux/);
    expect(engineProblems("mlx", "darwin")).toEqual([]);
    expect(engineProblems("mlx", "win32")[0]).toMatch(/Apple silicon/);
    expect(engineProblems(undefined, "win32")).toEqual([]);
  });
});

describe("which engine an instance keeps", () => {
  it("a first install is Ollama; an existing env file without engine lines is Ollama", () => {
    expect(resolveInstanceEngine(0, {})).toEqual({ kind: "ollama", env: {} });
    expect(previousEngine({ agentEnv: "AGENT_ID=x\n", markerExists: false })).toBe("ollama");
    expect(previousEngine({ markerExists: false })).toBeUndefined();
  });

  it("a re-run without flags keeps vLLM and every vLLM line from the env file", () => {
    const agentEnv = `AGENT_ID=x\nEDGECODER_ENGINE=vllm\nVLLM_URL=http://127.0.0.1:8000\nVLLM_MODEL=${AWQ}\nVLLM_MAX_SLOTS=2\nVLLM_API_KEY=k-123\nENGINE_MODEL_ALIASES=my/ft=qwen3-coder:30b\n`;
    expect(resolveInstanceEngine(0, {}, { agentEnv, markerExists: true })).toEqual({
      kind: "vllm",
      previous: "vllm",
      env: { VLLM_URL: "http://127.0.0.1:8000", VLLM_MODEL: AWQ, VLLM_MAX_SLOTS: "2", VLLM_API_KEY: "k-123", ENGINE_MODEL_ALIASES: "my/ft=qwen3-coder:30b" }
    });
  });

  it("the marker without the env lines (an older installer dropped them) recovers vLLM from vllm-<n>.env", () => {
    expect(resolveInstanceEngine(0, {}, { agentEnv: "AGENT_ID=x\n", vllmEnv: VLLM_ENV, markerExists: true })).toEqual({
      kind: "vllm",
      previous: "vllm",
      env: { VLLM_URL: "http://127.0.0.1:8000", VLLM_MODEL: AWQ }
    });
  });

  it("flags override the kept values; instance n defaults to port 8000+n", () => {
    const agentEnv = `EDGECODER_ENGINE=vllm\nVLLM_URL=http://127.0.0.1:8000\nVLLM_MODEL=${AWQ}\nVLLM_MAX_SLOTS=2\n`;
    expect(resolveInstanceEngine(0, { vllmSlots: 4 }, { agentEnv, markerExists: true }).env).toMatchObject({ VLLM_MAX_SLOTS: "4", VLLM_MODEL: AWQ });
    expect(resolveInstanceEngine(3, { engine: "vllm", vllmProfile: "a100-80" }).env).toEqual({ VLLM_URL: "http://127.0.0.1:8003", VLLM_MODEL: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", VLLM_MAX_SLOTS: "12" });
  });

  it("values that would not pass the flags' checks are dropped, not written", () => {
    const agentEnv = "EDGECODER_ENGINE=vllm\nVLLM_URL=http://x/$(id)\nVLLM_MODEL=a b\nVLLM_MAX_SLOTS=99\nVLLM_API_KEY=a`b\n";
    expect(resolveInstanceEngine(1, {}, { agentEnv, markerExists: false }).env).toEqual({ VLLM_URL: "http://127.0.0.1:8001" });
    expect(previousEngine({ agentEnv: "EDGECODER_ENGINE=bogus\n", markerExists: false })).toBe("ollama");
  });

  it("MLX keeps its lines; --engine ollama drops every engine line", () => {
    const agentEnv = "EDGECODER_ENGINE=mlx\nMLX_URL=http://127.0.0.1:8080\nMLX_MODEL=mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit\nMLX_MAX_SLOTS=2\n";
    expect(resolveInstanceEngine(0, {}, { agentEnv, markerExists: false })).toEqual({ kind: "mlx", previous: "mlx", env: { MLX_URL: "http://127.0.0.1:8080", MLX_MODEL: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit", MLX_MAX_SLOTS: "2" } });
    expect(resolveInstanceEngine(0, { engine: "ollama" }, { agentEnv, markerExists: false })).toEqual({ kind: "ollama", previous: "mlx", env: {} });
  });
});

describe("applying the engine on Linux", () => {
  it("--engine vllm: env lines, marker, Ollama switch drop-in; Ollama off, vLLM started (never restarted), agent restarted", () => {
    const h = fakeHost(VLLM_INSTALLED);
    const { plan } = run(["--engine", "vllm", "--vllm-model", AWQ, "--vllm-slots", "2"], h);
    expect(env0(h)).toMatchObject({ EDGECODER_ENGINE: "vllm", VLLM_URL: "http://127.0.0.1:8000", VLLM_MODEL: AWQ, VLLM_MAX_SLOTS: "2", CUDA_VISIBLE_DEVICES: "0,1" });
    expect(h.files.get("/etc/edgecoder/vllm-0.active")).toContain("vLLM");
    expect(h.files.get(vllmDropInPath(0))).toMatch(/^\[Unit\]\nConditionPathExists=!\/etc\/edgecoder\/vllm-0\.active$/m);
    // The Ollama unit stays (so --engine ollama is one step back), with #357's memory-safety env.
    expect(h.files.get("/etc/systemd/system/edgecoder-ollama-0.service")).toMatch(/OLLAMA_MAX_LOADED_MODELS=/);
    expect(systemdAgentUnit(paths(), plan.instances[0])).toMatch(/^After=.*edgecoder-vllm@0\.service/m);
    expect(h.commands).toEqual([
      "chown -R root:root /etc/edgecoder",
      "chmod 0755 /etc/edgecoder",
      expect.stringMatching(/^id -u edgecoder/),
      "chown edgecoder:edgecoder /var/lib/edgecoder/ollama /var/log/edgecoder",
      "usermod -aG docker edgecoder",
      "systemctl daemon-reload",
      "systemctl enable edgecoder-agent-0.service edgecoder-vllm@0.service",
      "systemctl disable --now edgecoder-ollama-0.service",
      "systemctl start edgecoder-vllm@0.service",
      "systemctl restart edgecoder-agent-0.service"
    ]);
  });

  it("a re-run with no flags keeps everything (update.sh, package upgrade) and is idempotent", () => {
    const h = fakeHost(VLLM_INSTALLED);
    run(["--engine", "vllm", "--vllm-model", AWQ, "--vllm-slots", "2"], h);
    const first = new Map(h.files);
    const firstCommands = [...h.commands];
    run([], h);
    expect(new Map(h.files)).toEqual(first);
    expect(h.commands).toEqual(firstCommands);
    run([], h);
    expect(new Map(h.files)).toEqual(first);
    expect(env0(h)).toMatchObject({ EDGECODER_ENGINE: "vllm", VLLM_MODEL: AWQ, VLLM_MAX_SLOTS: "2" });
    expect(h.commands.some((c) => /(enable|restart|start) .*edgecoder-ollama-0/.test(c) && !c.includes("disable"))).toBe(false);
  });

  it("the Chicago VM as it is: hand-added lines, legacy marker and drop-in; adopting keeps vLLM up and moves to the installer's marker", () => {
    const handEnv = `AGENT_ID=ec-st10-chi-gpu0-1\nAGENT_REGISTRATION_TOKEN=tok\n\n# vLLM engine (see /root/vllm-setup); installer re-runs drop these lines, re-add them\nEDGECODER_ENGINE=vllm\nVLLM_URL=http://127.0.0.1:8000\nVLLM_MODEL=${AWQ}\nVLLM_MAX_SLOTS=2\n`;
    const h = fakeHost({
      ...VLLM_INSTALLED,
      "/etc/edgecoder/agent-0.env": handEnv,
      "/etc/edgecoder/vllm-active": "",
      [vllmDropInPath(0)]: "[Unit]\nConditionPathExists=!/etc/edgecoder/vllm-active\n"
    });
    const { commands } = run([], h);
    expect(env0(h)).toMatchObject({ EDGECODER_ENGINE: "vllm", VLLM_URL: "http://127.0.0.1:8000", VLLM_MODEL: AWQ, VLLM_MAX_SLOTS: "2" });
    expect(h.files.has("/etc/edgecoder/vllm-0.active")).toBe(true);
    expect(h.files.get(vllmDropInPath(0))).toContain("ConditionPathExists=!/etc/edgecoder/vllm-0.active");
    expect(h.files.has(legacyVllmMarkerPath("/etc/edgecoder"))).toBe(false);
    // The legacy marker goes only after systemd has read the drop-in naming the new one; vLLM is not restarted.
    expect(commands.indexOf("rm -f /etc/edgecoder/vllm-active")).toBeGreaterThan(commands.indexOf("systemctl daemon-reload"));
    expect(commands).not.toContain("systemctl restart edgecoder-vllm@0.service");
  });

  it("an instance an older run left with only the marker comes back to vLLM, not to an Ollama that cannot start", () => {
    const h = fakeHost({ ...VLLM_INSTALLED, "/etc/edgecoder/agent-0.env": "AGENT_ID=ec-st10-chi-gpu0-1\n", "/etc/edgecoder/vllm-active": "" });
    run([], h);
    expect(env0(h)).toMatchObject({ EDGECODER_ENGINE: "vllm", VLLM_URL: "http://127.0.0.1:8000", VLLM_MODEL: AWQ });
  });

  it("--engine ollama reverses it: marker and drop-in gone, vLLM stopped before Ollama starts, engine lines removed", () => {
    const h = fakeHost({ ...VLLM_INSTALLED, "/etc/edgecoder/vllm-active": "" });
    run(["--engine", "vllm", "--vllm-model", AWQ, "--vllm-slots", "2"], h);
    const { commands: c } = run(["--engine", "ollama"], h);
    const text = h.files.get("/etc/edgecoder/agent-0.env") ?? "";
    expect(text).not.toMatch(ENGINE_KEYS);
    expect(env0(h)).toMatchObject({ OLLAMA_HOST: "http://127.0.0.1:11434", OLLAMA_MODEL: "qwen3-coder:30b" });
    for (const f of ["/etc/edgecoder/vllm-0.active", "/etc/edgecoder/vllm-active", vllmDropInPath(0)]) expect(h.files.has(f), f).toBe(false);
    // vllm-<n>.env and the venv stay, so going back to vLLM needs no reinstall.
    expect(h.files.has("/etc/edgecoder/vllm-0.env")).toBe(true);
    expect(c).toContain("rm -f " + vllmDropInPath(0));
    expect(c.indexOf("systemctl disable --now edgecoder-vllm@0.service")).toBeGreaterThan(c.indexOf("systemctl daemon-reload"));
    expect(c.indexOf("systemctl disable --now edgecoder-vllm@0.service")).toBeLessThan(c.indexOf("systemctl restart edgecoder-ollama-0.service edgecoder-agent-0.service"));
    expect(c).toContain("systemctl unmask edgecoder-ollama-0.service");
    expect(c).toContain("systemctl enable edgecoder-ollama-0.service edgecoder-agent-0.service");
    // And it stays on Ollama on the next run, with none of the switch commands.
    run([], h);
    expect(h.files.get("/etc/edgecoder/agent-0.env")).not.toMatch(ENGINE_KEYS);
    expect(h.commands.filter((x) => /vllm/.test(x))).toEqual([]);
  });

  it("vLLM -> Ollama -> vLLM round trip ends where it started", () => {
    const h = fakeHost(VLLM_INSTALLED);
    run(["--engine", "vllm", "--vllm-model", AWQ, "--vllm-slots", "2"], h);
    const vllmState = new Map(h.files);
    run(["--engine", "ollama"], h);
    run(["--engine", "vllm", "--vllm-slots", "2"], h);
    expect(new Map(h.files)).toEqual(vllmState);
  });

  it("a plain Ollama install is unchanged: no engine lines, no vLLM files or commands", () => {
    const h = fakeHost();
    run([], h);
    expect(h.files.get("/etc/edgecoder/agent-0.env")).not.toMatch(ENGINE_KEYS);
    expect([...h.files.keys()].filter((f) => /vllm/.test(f))).toEqual([]);
    expect(h.commands.slice(-3)).toEqual([
      "systemctl daemon-reload",
      "systemctl enable edgecoder-ollama-0.service edgecoder-agent-0.service",
      "systemctl restart edgecoder-ollama-0.service edgecoder-agent-0.service"
    ]);
  });

  it("vLLM not installed yet: an error without --vllm-profile; with it, install-vllm.sh runs for the instance's GPUs before the services start", () => {
    const p = paths();
    const h = fakeHost();
    const opts = parseInstallArgs(["apply", "--single", "--engine", "vllm"]);
    let plan = planInstall(hw, opts, true);
    opts.instanceEngines = resolveEngines(opts, plan, p, () => undefined, () => false);
    plan = planInstall(hw, opts, true);
    expect(planVllmInstalls(opts, plan, p, h.host.exists)[0]).toMatch(/--vllm-profile a16x2\|a100-80/);

    const o2 = parseInstallArgs(["apply", "--single", "--vllm-profile", "a16x2"]);
    let plan2 = planInstall(hw, o2, true);
    o2.instanceEngines = resolveEngines(o2, plan2, p, () => undefined, () => false);
    plan2 = planInstall(hw, o2, true);
    expect(planVllmInstalls(o2, plan2, p, h.host.exists)).toEqual([]);
    expect(plan2.instances[0].env).toMatchObject({ EDGECODER_ENGINE: "vllm", VLLM_MODEL: AWQ, VLLM_MAX_SLOTS: "2" });
    applyPlan(plan2, h.host, p, false);
    const install = `bash /opt/edgecoder/app/scripts/linux/vllm/install-vllm.sh --profile a16x2 --instance 0 --gpus 0,1 --model ${AWQ} --download`;
    expect(h.commands).toContain(install);
    expect(h.commands.indexOf(install)).toBeLessThan(h.commands.indexOf("systemctl start edgecoder-vllm@0.service"));
  });

  it("status shows the vLLM unit for a vLLM instance; remove stops it and removes the switch files", () => {
    const h = fakeHost(VLLM_INSTALLED);
    run(["--engine", "vllm"], h);
    expect(serviceStatus(h.host, paths()).map((s) => s.name)).toEqual(["edgecoder-vllm@0.service", "edgecoder-agent-0.service"]);
    const removed = removeServices(h.host, paths());
    expect(removed).toContain("edgecoder-vllm@0.service");
    expect(h.files.has("/etc/edgecoder/vllm-0.active")).toBe(false);
    expect(h.files.has(vllmDropInPath(0))).toBe(false);
  });

  it("dry run lists the switch without touching anything", () => {
    const h = fakeHost(VLLM_INSTALLED);
    const p = paths();
    const opts = parseInstallArgs(["apply", "--single", "--engine", "vllm"]);
    opts.instanceEngines = resolveEngines(opts, planInstall(hw, opts, true), p, (f) => h.files.get(f), (f) => h.files.has(f));
    const before = new Map(h.files);
    const r = applyPlan(planInstall(hw, opts, true), h.host, p, true);
    expect(new Map(h.files)).toEqual(before);
    expect(r.files).toEqual(expect.arrayContaining(["/etc/edgecoder/vllm-0.active", vllmDropInPath(0)]));
    expect(r.commands).toContain("systemctl start edgecoder-vllm@0.service");
  });
});

describe("edgecoder-install plan: the engine from the real config dir", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function planJson(argv: string[], dir: string): Promise<{ code: number; plan: InstallPlan; out: string }> {
    const host: Host = { platform: "linux", writeFile: () => undefined, removeFile: () => undefined, run: () => ({ code: 1, stdout: "", stderr: "" }), exists: () => true };
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m: unknown) => { out.push(String(m)); });
    const err = vi.spyOn(console, "error").mockImplementation((m: unknown) => { out.push(String(m)); });
    try {
      const code = await runInstaller(["plan", "--json", "--sandbox", "docker", "--config-dir", dir, ...argv], {}, host);
      return { code, plan: code === 0 ? JSON.parse(out.join("\n")).plan : undefined, out: out.join("\n") } as never;
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  }

  it("keeps vLLM from agent-0.env, redacts VLLM_API_KEY, and finds the marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ec-engine-"));
    dirs.push(dir);
    writeFileSync(join(dir, "agent-0.env"), renderEnvFile({ AGENT_ID: "box-cpu", EDGECODER_ENGINE: "vllm", VLLM_URL: "http://127.0.0.1:8000", VLLM_MODEL: AWQ, VLLM_MAX_SLOTS: "2", VLLM_API_KEY: "secret-vllm-key" }));
    const { code, plan, out } = await planJson([], dir);
    expect(code).toBe(0);
    expect(plan.instances[0].env).toMatchObject({ EDGECODER_ENGINE: "vllm", VLLM_MODEL: AWQ, VLLM_MAX_SLOTS: "2", VLLM_API_KEY: "<redacted>" });
    expect(out).not.toContain("secret-vllm-key");

    rmSync(join(dir, "agent-0.env"));
    writeFileSync(join(dir, "agent-0.env"), "AGENT_ID=box-cpu\n");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "vllm-0.active"), "");
    writeFileSync(join(dir, "vllm-0.env"), VLLM_ENV);
    expect((await planJson([], dir)).plan.instances[0].env).toMatchObject({ EDGECODER_ENGINE: "vllm", VLLM_MODEL: AWQ });
    expect((await planJson(["--engine", "ollama"], dir)).plan.instances[0].env.EDGECODER_ENGINE).toBeUndefined();
    expect(existsSync(join(dir, "vllm-0.active"))).toBe(true); // plan changes nothing
    expect(readFileSync(join(dir, "agent-0.env"), "utf8")).toBe("AGENT_ID=box-cpu\n");
  });

  it("refuses --engine mlx on Linux", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ec-engine-"));
    dirs.push(dir);
    const r = await planJson(["--engine", "mlx"], dir);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Apple silicon/);
  });
});

it("the env file path helper agrees with the engine module's paths", () => {
  const p = paths();
  expect(envFilePath(p, { index: 0 } as never)).toBe("/etc/edgecoder/agent-0.env");
  expect(vllmMarkerPath(p.configDir, 0)).toBe("/etc/edgecoder/vllm-0.active");
});
