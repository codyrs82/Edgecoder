import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectHardware, isDatacenterGpu, parseNvidiaSmi, parseRocmSmi, selectGpu, type Probe } from "../../src/install/hardware.js";
import { helpText, parseInstallArgs, parseTokensFile, INSTALL_OPTIONS } from "../../src/install/options.js";
import { pickModel, planInstall, renderEnvFile } from "../../src/install/plan.js";
import { applyPlan, defaultPaths, launchdAgentPlist, removeServices, systemdAgentUnit, systemdOllamaUnit, windowsAgentCmd, type Host } from "../../src/install/services.js";
import { enrollNodes, pullModels, type HttpPost } from "../../src/install/cli.js";

const NVIDIA_8X = Array.from({ length: 8 }, (_, i) => `${i}, NVIDIA RTX 6000 Ada Generation, 49140`).join("\n") + "\n";

function fakeHost(platform: NodeJS.Platform) {
  const files = new Map<string, string>();
  const modes = new Map<string, number | undefined>();
  const commands: string[] = [];
  const host: Host = {
    platform,
    writeFile: (p, c, m) => { files.set(p, c); modes.set(p, m); },
    removeFile: (p) => { files.delete(p); },
    run: (cmd, args) => { commands.push([cmd, ...args].join(" ")); return { code: 0, stdout: "active\n", stderr: "" }; },
    exists: (p) => files.has(p)
  };
  return { host, files, commands, modes };
}

describe("hardware detection", () => {
  it("parses nvidia-smi and flags workstation/datacenter parts", () => {
    const gpus = parseNvidiaSmi(NVIDIA_8X);
    expect(gpus).toHaveLength(8);
    expect(gpus[7]).toMatchObject({ index: 7, vendor: "nvidia", model: "NVIDIA RTX 6000 Ada Generation", vramGb: 48, datacenter: true });
    expect(parseNvidiaSmi("0, NVIDIA GeForce RTX 4090, 24564\n")[0]).toMatchObject({ vramGb: 24, datacenter: false });
    expect(isDatacenterGpu("NVIDIA H100 80GB HBM3")).toBe(true);
    expect(isDatacenterGpu("NVIDIA GeForce RTX 3060")).toBe(false);
  });

  it("parses rocm-smi csv best effort", () => {
    const out = "device,Card series,VRAM Total Memory (B)\ncard0,AMD Instinct MI300X,206158430208\n";
    expect(parseRocmSmi(out)[0]).toMatchObject({ vendor: "amd", model: "AMD Instinct MI300X", vramGb: 192, datacenter: true });
  });

  it("detects Apple silicon as a unified-memory GPU and NVIDIA via the probe", () => {
    const probe: Probe = (cmd) => (cmd === "nvidia-smi" ? NVIDIA_8X : null);
    const mac = detectHardware({ probe, platform: "darwin", arch: "arm64", ramGb: 64, cpuModel: "Apple M3 Max", cpuCores: 16, hostname: "studio" });
    expect(mac.gpus[0]).toMatchObject({ vendor: "apple", vramGb: 64 });
    expect(mac.unifiedMemory).toBe(true);
    const linux = detectHardware({ probe, platform: "linux", arch: "x64", ramGb: 512, cpuModel: "EPYC", cpuCores: 64, hostname: "gpu-box" });
    expect(linux.gpus).toHaveLength(8);
    const none = detectHardware({ probe: () => null, platform: "linux", arch: "x64", ramGb: 16, cpuModel: "i7", cpuCores: 8, hostname: "pc" });
    expect(none.gpus).toEqual([]);
  });

  it("selects the GPU an instance owns from CUDA_VISIBLE_DEVICES", () => {
    const hw = detectHardware({ probe: () => NVIDIA_8X, platform: "linux", arch: "x64", ramGb: 512, cpuModel: "x", cpuCores: 1, hostname: "h" });
    expect(selectGpu(hw, { CUDA_VISIBLE_DEVICES: "5" })?.index).toBe(5);
    expect(selectGpu(hw, { EDGECODER_GPU_INDEX: "2", CUDA_VISIBLE_DEVICES: "5" })?.index).toBe(2);
    expect(selectGpu(hw, {})?.index).toBe(0);
  });
});

describe("options", () => {
  it("parses the shared option table and tokens", () => {
    const o = parseInstallArgs(["apply", "--mesh-token", "m", "--token", "box-gpu0=t0", "--token", "t-all", "--instances", "2", "--sandbox", "none", "--single", "--json"]);
    expect(o).toMatchObject({ command: "apply", meshToken: "m", tokens: { "box-gpu0": "t0", "*": "t-all" }, instances: 2, sandbox: "none", perGpu: false, json: true });
    expect(parseInstallArgs(["plan", "--coordinator-url=https://c.example"]).coordinatorUrl).toBe("https://c.example");
    expect(() => parseInstallArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseInstallArgs(["apply", "--instances", "0"])).toThrow(/positive/);
    expect(parseInstallArgs([], { EDGECODER_REGISTRATION_TOKEN: "envtok" }).tokens["*"]).toBe("envtok");
    expect(parseTokensFile("# c\nbox-gpu0=a\nbox-gpu1 = b\n")).toEqual({ "box-gpu0": "a", "box-gpu1": "b" });
    for (const opt of INSTALL_OPTIONS) expect(helpText()).toContain(opt.flag);
  });
});

describe("plan", () => {
  const probe: Probe = (cmd) => (cmd === "nvidia-smi" ? NVIDIA_8X : null);
  const gpuBox = detectHardware({ probe, platform: "linux", arch: "x64", ramGb: 512, cpuModel: "EPYC", cpuCores: 64, hostname: "GPU-Box.local" });

  it("picks the largest coding model that fits with headroom", () => {
    expect(pickModel(48)).toBe("qwen3-coder:30b");
    expect(pickModel(16)).toBe("qwen3.5:9b");
    expect(pickModel(8)).toBe("qwen3.5:4b");
    expect(pickModel(24)).toBe("qwen3-coder:30b");
    expect(pickModel(4)).toBe("qwen3.5:2b");
    expect(pickModel(3)).toBe("qwen3.5:0.8b");
  });

  it("one agent and one Ollama per GPU, pinned, with tokens matched by agent id", () => {
    const o = parseInstallArgs(["apply", "--mesh-token", "m", "--per-gpu", "--token", "gpu-box-local-gpu3=tok3"]);
    const plan = planInstall(gpuBox, o, true);
    expect(plan.instances).toHaveLength(8);
    expect(plan.sandboxMode).toBe("docker");
    const i3 = plan.instances[3];
    expect(i3.agentId).toBe("gpu-box-local-gpu3");
    expect(i3.ollamaPort).toBe(11437);
    expect(i3.env).toMatchObject({ CUDA_VISIBLE_DEVICES: "3", EDGECODER_GPU_INDEX: "3", AGENT_REGISTRATION_TOKEN: "tok3", OLLAMA_HOST: "http://127.0.0.1:11437", OLLAMA_MODEL: "qwen3-coder:30b", SANDBOX_MODE: "docker", AGENT_PARALLEL_INFERENCE: "4" });
    // Detected hardware is not written as AGENT_GPU_* overrides (that would mark the profile overridden).
    expect(Object.keys(i3.env).filter((k) => k.startsWith("AGENT_GPU_"))).toEqual([]);
    expect(new Set(plan.instances.map((i) => i.ollamaPort)).size).toBe(8);
    expect(plan.instances.map((i) => i.agentId)).toEqual(Array.from({ length: 8 }, (_, n) => `gpu-box-local-gpu${n}`));
    expect(plan.warnings.filter((w) => w.includes("no registration token"))).toHaveLength(7);
    expect(renderEnvFile(i3.env)).toContain("AGENT_ID=gpu-box-local-gpu3\n");
  });

  it("edgecoder.io agents get strict trust with the seed keys; other coordinators keep the default", () => {
    const net = planInstall(gpuBox, parseInstallArgs(["apply", "--token", "t", "--coordinator-url=https://coordinator.edgecoder.io"]), true);
    for (const i of net.instances) {
      expect(i.env.EDGECODER_TRUST_MODE).toBe("strict");
      expect(i.env.TRUSTED_COORDINATOR_KEYS).toMatch(/^coord-25bacdd7b3f3:[0-9a-f]{64},coord-b17fb990ea6b:[0-9a-f]{64}$/);
    }
    const own = planInstall(gpuBox, parseInstallArgs(["apply", "--token", "t", "--coordinator-url=https://c.example"]), true);
    expect(own.instances[0].env.EDGECODER_TRUST_MODE).toBeUndefined();
  });

  it("an 8x 48 GB host defaults to mixed: four cards one each, two pairs for gpt-oss:120b", () => {
    const plan = planInstall(gpuBox, parseInstallArgs(["apply", "--token", "t"]), true);
    expect(plan.instances.map((i) => [i.agentId, i.env.CUDA_VISIBLE_DEVICES, i.model, i.memoryGb])).toEqual([
      ["gpu-box-local-gpu0", "0", "qwen3-coder:30b", 48],
      ["gpu-box-local-gpu1", "1", "qwen3-coder:30b", 48],
      ["gpu-box-local-gpu2", "2", "qwen3-coder:30b", 48],
      ["gpu-box-local-gpu3", "3", "qwen3-coder:30b", 48],
      ["gpu-box-local-gpu4-5", "4,5", "gpt-oss:120b", 96],
      ["gpu-box-local-gpu6-7", "6,7", "gpt-oss:120b", 96],
    ]);
    // The pooled instance's Ollama sees both cards.
    expect(plan.instances[4].gpus.map((g) => g.index)).toEqual([4, 5]);
  });

  it("pools cards for the biggest models: --layout single, --gpus-per-instance", () => {
    const single = planInstall(gpuBox, parseInstallArgs(["apply", "--layout", "single", "--token", "t"]), true);
    expect(single.instances.map((i) => [i.agentId, i.env.CUDA_VISIBLE_DEVICES, i.model])).toEqual([["gpu-box-local-gpu0-7", "0,1,2,3,4,5,6,7", "qwen3-coder:480b"]]);
    const fours = planInstall(gpuBox, parseInstallArgs(["apply", "--gpus-per-instance", "4", "--token", "t"]), true);
    expect(fours.instances.map((i) => i.model)).toEqual(["qwen3:235b", "qwen3:235b"]);
    const chosen = planInstall(gpuBox, parseInstallArgs(["apply", "--gpus-per-instance", "2", "--model", "llama3.3:70b", "--token", "t"]), true);
    expect(chosen.instances.map((i) => i.model)).toEqual(Array(4).fill("llama3.3:70b"));
    expect(() => parseInstallArgs(["apply", "--layout", "huge"])).toThrow(/--layout/);
  });

  it("sizes parallel model calls by each GPU's VRAM, not host RAM", () => {
    const mixed: Probe = (cmd) => (cmd === "nvidia-smi" ? "0, NVIDIA RTX 6000 Ada Generation, 49140\n1, NVIDIA GeForce RTX 4080, 16376\n2, NVIDIA GeForce RTX 3070, 8192\n" : null);
    const hw = detectHardware({ probe: mixed, platform: "linux", arch: "x64", ramGb: 512, cpuModel: "EPYC", cpuCores: 64, hostname: "mix" });
    const plan = planInstall(hw, parseInstallArgs(["apply", "--token", "t"]), true);
    expect(plan.instances.map((i) => i.env.AGENT_PARALLEL_INFERENCE)).toEqual(["4", "2", "1"]);
    const p = defaultPaths("linux", { nodeBin: "/usr/bin/node" });
    expect(systemdOllamaUnit(p, plan.instances[2])).toContain('Environment="OLLAMA_NUM_PARALLEL=1"');
  });

  it("the curl bootstrap installs zstd (Ollama's .tar.zst) first and hands every option to edgecoder-install", () => {
    const sh = readFileSync("deploy/install.sh", "utf8");
    expect(sh).toMatch(/ensure_base\(\) \{[\s\S]*pkgs="[^"\n]*\bzstd\b/);
    expect(sh).toContain("ensure_base; ensure_node; ensure_ollama; ensure_docker");
    expect(sh).not.toMatch(/ollama\.com\/install\.sh \| sh/);
    // edgecoder-install on PATH is a wrapper: a symlink to scripts/edgecoder-install resolved dist/ under /usr/local.
    expect(sh).not.toMatch(/ln -sf[^\n]*edgecoder-install/);
    expect(sh).toContain('/dist/install/cli.js" "$@"');
    // Signed releases only (tests/install/signed-release.test.ts); git is for --from-source alone.
    expect(sh).toContain('install_release "$tag"');
  });

  it("--single, --instances and no-docker behave", () => {
    expect(planInstall(gpuBox, parseInstallArgs(["apply", "--single"]), true).instances).toHaveLength(1);
    expect(planInstall(gpuBox, parseInstallArgs(["apply", "--instances", "2"]), true).instances.map((i) => i.gpu?.index)).toEqual([0, 1]);
    const noDocker = planInstall(gpuBox, parseInstallArgs(["apply"]), false);
    expect(noDocker.sandboxMode).toBe("none");
    expect(noDocker.warnings[0]).toMatch(/Docker is not available/);
    const mac = detectHardware({ probe: () => null, platform: "darwin", arch: "arm64", ramGb: 36, cpuModel: "Apple M3 Pro", cpuCores: 12, hostname: "mbp" });
    const macPlan = planInstall(mac, parseInstallArgs(["apply", "--token", "t"]), true);
    expect(macPlan.instances).toHaveLength(1);
    expect(macPlan.instances[0].agentId).toBe("mbp-gpu");
    expect(macPlan.instances[0].env.CUDA_VISIBLE_DEVICES).toBeUndefined();
    expect(macPlan.instances[0].model).toBe("qwen3-coder:30b");
  });
});

describe("services: the same plan on every platform", () => {
  const probe: Probe = (cmd) => (cmd === "nvidia-smi" ? "0, NVIDIA RTX 6000 Ada Generation, 49140\n1, NVIDIA RTX 6000 Ada Generation, 49140\n" : null);
  const o = parseInstallArgs(["apply", "--token", "t"]);

  it("linux: systemd units per instance, pinned GPU, shared model store", () => {
    const hw = detectHardware({ probe, platform: "linux", arch: "x64", ramGb: 256, cpuModel: "x", cpuCores: 32, hostname: "box" });
    const plan = planInstall(hw, o, true);
    const p = defaultPaths("linux", { nodeBin: "/usr/bin/node", appDir: "/opt/edgecoder/app" });
    const { host, files, commands } = fakeHost("linux");
    const r = applyPlan(plan, host, p, false);
    expect(r.services).toEqual(["edgecoder-ollama-0.service", "edgecoder-agent-0.service", "edgecoder-ollama-1.service", "edgecoder-agent-1.service"]);
    expect(files.get("/etc/systemd/system/edgecoder-ollama-1.service")).toContain('Environment="CUDA_VISIBLE_DEVICES=1"');
    expect(files.get("/etc/systemd/system/edgecoder-ollama-1.service")).toContain("OLLAMA_HOST=127.0.0.1:11435");
    expect(files.get("/etc/systemd/system/edgecoder-agent-1.service")).toContain("EnvironmentFile=/etc/edgecoder/agent-1.env");
    expect(files.get("/etc/edgecoder/agent-0.env")).toContain("AGENT_REGISTRATION_TOKEN=t");
    // restart, not enable --now: a re-run with new tokens must restart running units.
    expect(commands.slice(-2)).toEqual(["systemctl enable " + r.services.join(" "), "systemctl restart " + r.services.join(" ")]);
    expect(files.get("/etc/systemd/system/edgecoder-ollama-1.service")).toContain('Environment="OLLAMA_NUM_PARALLEL=4"');
    expect(files.get("/etc/edgecoder/agent-1.env")).toContain("AGENT_PARALLEL_INFERENCE=4\n");
    // Each agent has its own writable HOME (worker.db, pending results), created by systemd.
    expect(files.get("/etc/systemd/system/edgecoder-agent-1.service")).toContain("StateDirectory=edgecoder/agent-1\n");
    expect(files.get("/etc/systemd/system/edgecoder-agent-1.service")).toContain('Environment="HOME=/var/lib/edgecoder/agent-1"');
    expect(systemdOllamaUnit(p, plan.instances[0])).toContain("OLLAMA_MODELS=/var/lib/edgecoder/ollama");
    expect(systemdAgentUnit(p, plan.instances[0])).toContain("ExecStart=/usr/bin/node /opt/edgecoder/app/dist/swarm/worker-runner.js");
    expect(removeServices(host, p)).toHaveLength(4);
    expect(files.size).toBe(0);
  });

  it("macOS: launchd plists with the instance env", () => {
    const hw = detectHardware({ probe: () => null, platform: "darwin", arch: "arm64", ramGb: 64, cpuModel: "Apple M2 Ultra", cpuCores: 24, hostname: "studio" });
    const plan = planInstall(hw, o, true);
    const p = defaultPaths("darwin", { nodeBin: "/opt/homebrew/bin/node" });
    const { host, files, commands, modes } = fakeHost("darwin");
    const r = applyPlan(plan, host, p, false);
    expect(r.services).toEqual(["io.edgecoder.ollama.0", "io.edgecoder.agent.0"]);
    // The agent plist holds the mesh and registration tokens: root-only.
    expect(modes.get("/Library/LaunchDaemons/io.edgecoder.agent.0.plist")).toBe(0o600);
    expect(modes.get("/Library/LaunchDaemons/io.edgecoder.ollama.0.plist")).toBe(0o644);
    const agent = files.get("/Library/LaunchDaemons/io.edgecoder.agent.0.plist")!;
    expect(agent).toContain("<key>OLLAMA_MODEL</key>");
    expect(agent).toContain("<string>qwen3-coder:30b</string>");
    expect(launchdAgentPlist(p, plan.instances[0])).toContain("/opt/edgecoder/app/dist/swarm/worker-runner.js");
    expect(commands).toContain("launchctl bootstrap system /Library/LaunchDaemons/io.edgecoder.agent.0.plist");
  });

  it("windows: scheduled tasks and cmd wrappers", () => {
    const hw = detectHardware({ probe, platform: "win32", arch: "x64", ramGb: 128, cpuModel: "x", cpuCores: 16, hostname: "WINBOX" });
    const plan = planInstall(hw, o, true);
    const p = defaultPaths("win32", { configDir: "C:\\ProgramData\\EdgeCoder", appDir: "C:\\Program Files\\EdgeCoder\\app", nodeBin: "C:\\Program Files\\nodejs\\node.exe", ollamaBin: "C:\\ollama.exe", modelsDir: "C:\\ProgramData\\EdgeCoder\\ollama", logDir: "C:\\ProgramData\\EdgeCoder\\logs", user: "BOX\\me" });
    const { host, files, commands } = fakeHost("win32");
    const r = applyPlan(plan, host, p, false);
    expect(r.services).toEqual(["EdgeCoder\\ollama-0", "EdgeCoder\\agent-0", "EdgeCoder\\ollama-1", "EdgeCoder\\agent-1"]);
    expect(files.get("C:\\ProgramData\\EdgeCoder\\agent-1.cmd")).toContain('set "CUDA_VISIBLE_DEVICES=1"');
    expect(windowsAgentCmd(p, plan.instances[1])).toContain("worker-runner.js");
    expect(commands.some((c) => c.startsWith("schtasks /Create /F /SC ONLOGON /RU \"BOX\\me\" /IT /RL LIMITED /TN EdgeCoder\\agent-1"))).toBe(true);
  });

  it("--pull-models pulls each distinct model once, retrying until Ollama is listening", () => {
    const plan = planInstall(detectHardware({ probe: () => NVIDIA_8X, platform: "linux", arch: "x64", ramGb: 512, cpuModel: "x", cpuCores: 64, hostname: "box" }), { ...o, layout: "per-gpu" }, true);
    const calls: string[] = [];
    let n = 0;
    const host = { ...fakeHost("linux").host, run: (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(" ")); return { code: ++n < 3 ? 1 : 0, stdout: "", stderr: "" }; } };
    expect(pullModels(host, "/usr/local/bin/ollama", plan.instances, 10, () => {})).toEqual([]);
    expect(calls).toEqual(Array(3).fill("/usr/local/bin/ollama pull qwen3-coder:30b"));
    const down = { ...host, run: () => ({ code: 1, stdout: "", stderr: "" }) };
    expect(pullModels(down, "ollama", plan.instances, 2, () => {})).toEqual(["qwen3-coder:30b"]);
  });

  it("dry run writes nothing", () => {
    const hw = detectHardware({ probe, platform: "linux", arch: "x64", ramGb: 256, cpuModel: "x", cpuCores: 32, hostname: "box" });
    const { host, files, commands } = fakeHost("linux");
    const r = applyPlan(planInstall(hw, o, true), host, defaultPaths("linux"), true);
    expect(r.files.length).toBeGreaterThan(0);
    expect(files.size).toBe(0);
    expect(commands).toEqual([]);
  });
});

describe("enrolment: --enroll self-registers nodes with the portal", () => {
  const probe: Probe = (cmd) => (cmd === "nvidia-smi" ? "0, NVIDIA RTX 6000 Ada Generation, 49140\n1, NVIDIA RTX 6000 Ada Generation, 49140\n" : null);
  const twoGpu = detectHardware({ probe, platform: "linux", arch: "x64", ramGb: 256, cpuModel: "x", cpuCores: 32, hostname: "box" });

  it("POSTs /nodes/enroll per un-tokened instance and lands the tokens in the services' env", async () => {
    const opts = parseInstallArgs(["apply", "--enroll", "ptok", "--portal-url", "https://portal.example"]);
    const plan = planInstall(twoGpu, opts, true);
    expect(plan.instances).toHaveLength(2);
    const calls: Array<{ url: string; headers: Record<string, string>; body: { nodeId: string; nodeKind: string } }> = [];
    const post: HttpPost = async (url, init) => {
      const body = JSON.parse(init.body) as { nodeId: string; nodeKind: string };
      calls.push({ url, headers: init.headers, body });
      return { status: 200, json: async () => ({ ok: true, nodeId: body.nodeId, registrationToken: `rt-${body.nodeId}`, nodeApproved: false }) };
    };

    const { enrolled, failed } = await enrollNodes(opts, plan.instances, post);
    expect(enrolled).toEqual(["box-gpu0", "box-gpu1"]);
    expect(failed).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://portal.example/nodes/enroll");
    expect(calls[0].headers.authorization).toBe("Bearer ptok");
    expect(calls[0].body).toEqual({ nodeId: "box-gpu0", nodeKind: "agent" });

    // The normal plan/env wiring (plan.ts reads opts.tokens) now carries the tokens into every service.
    const applied = planInstall(twoGpu, opts, true);
    expect(applied.instances[0].env.AGENT_REGISTRATION_TOKEN).toBe("rt-box-gpu0");
    expect(applied.instances[1].env.AGENT_REGISTRATION_TOKEN).toBe("rt-box-gpu1");
    expect(renderEnvFile(applied.instances[1].env)).toContain("AGENT_REGISTRATION_TOKEN=rt-box-gpu1");
    expect(applied.warnings.filter((w) => w.includes("no registration token"))).toHaveLength(0);
  });

  it("leaves an already-tokened instance alone and reports the ones that fail", async () => {
    const opts = parseInstallArgs(["apply", "--enroll", "ptok", "--token", "box-gpu0=keep"]);
    const plan = planInstall(twoGpu, opts, true);
    const seen: string[] = [];
    const post: HttpPost = async (_url, init) => {
      seen.push((JSON.parse(init.body) as { nodeId: string }).nodeId);
      return { status: 500, json: async () => ({}) };
    };

    const { enrolled, failed } = await enrollNodes(opts, plan.instances, post);
    expect(seen).toEqual(["box-gpu1"]); // gpu0 already has --token, so it is skipped
    expect(enrolled).toEqual([]);
    expect(failed).toEqual(["box-gpu1"]);
    expect(opts.tokens["box-gpu0"]).toBe("keep");
  });

  it("takes a portal API key from --enroll or EDGECODER_API_KEY, and never puts it in the plan", () => {
    expect(parseInstallArgs(["apply", "--enroll", "eck_flag"]).enrollToken).toBe("eck_flag");
    expect(parseInstallArgs(["apply", "--enroll=eck_inline"]).enrollToken).toBe("eck_inline");
    expect(parseInstallArgs(["apply"], { EDGECODER_API_KEY: "eck_env" }).enrollToken).toBe("eck_env");
    expect(parseInstallArgs(["apply"], { EDGECODER_API_KEY: "eck_env", EDGECODER_ENROLL_TOKEN: "sess" }).enrollToken).toBe("eck_env");
    expect(parseInstallArgs(["apply"], { EDGECODER_ENROLL_TOKEN: "sess" }).enrollToken).toBe("sess");
    expect(parseInstallArgs(["apply", "--enroll", "eck_flag"], { EDGECODER_API_KEY: "eck_env" }).enrollToken).toBe("eck_flag");
    expect(() => parseInstallArgs(["apply", "--enroll"])).toThrow(/needs a value/);
    expect(helpText()).toContain("EDGECODER_API_KEY");
    const plan = planInstall(twoGpu, parseInstallArgs(["apply"], { EDGECODER_API_KEY: "eck_secret" }), true);
    expect(JSON.stringify(plan)).not.toContain("eck_secret");
  });
});
