import { describe, expect, it } from "vitest";
import {
  detectHardware,
  gpuNeedsOffloadProof,
  gfxName,
  hardwareProfileFor,
  parseVulkanSummary,
  readSysfsGpus,
  selectGpu,
  selectGpuPool,
  vulkanHint,
  type Probe,
  type SysFs
} from "../../src/install/hardware.js";
import { checkOllamaEnv, inheritConfig, inheritTuning, installArgsFromEnvFile, parseInstallArgs, renderInstallArgs } from "../../src/install/options.js";
import { planInstall, renderEnvFile } from "../../src/install/plan.js";
import { applyPlan, defaultPaths, removeServices, systemdOllamaUnit, type Host } from "../../src/install/services.js";
import { hostOllamaEnv } from "../../src/install/cli.js";
import { claimedProfile, decideGpuClaim, GPU_CLASS_MIN_BANDWIDTH_GBPS } from "../../src/swarm/gpu-claim.js";
import { classifyHardware } from "../../src/economy/compute-classes.js";
import { modelSourceNote } from "../../src/portal/pages/settings-machines.js";

const GIB = 1024 ** 3;

/** A fake sysfs: Patrick's rig, 4x RX 5700 XT (Navi 10, gfx1010, 8 GiB), plus an ASPEED BMC card without VRAM. */
function rig(opts: { kfd?: boolean } = {}): SysFs {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  dirs.set("/sys/class/drm", ["card0", "card0-HDMI-A-1", "card1", "card2", "card3", "card4", "renderD128", "version"]);
  files.set("/sys/class/drm/card0/device/vendor", "0x1a03\n"); // ASPEED: ignored
  for (const c of [1, 2, 3, 4]) {
    files.set(`/sys/class/drm/card${c}/device/vendor`, "0x1002\n");
    files.set(`/sys/class/drm/card${c}/device/device`, "0x731f\n");
    files.set(`/sys/class/drm/card${c}/device/mem_info_vram_total`, `${8 * GIB}\n`);
  }
  if (opts.kfd !== false) {
    dirs.set("/sys/class/kfd/kfd/topology/nodes", ["0", "1", "2", "3", "4"]);
    files.set("/sys/class/kfd/kfd/topology/nodes/0/properties", "cpu_cores_count 16\ngfx_target_version 0\n");
    for (const n of [1, 2, 3, 4]) files.set(`/sys/class/kfd/kfd/topology/nodes/${n}/properties`, "simd_count 80\ngfx_target_version 100100\n");
  }
  return { read: (p) => files.get(p) ?? null, list: (d) => dirs.get(d) ?? null };
}

const VULKAN_SUMMARY = `==========
VULKANINFO
==========

Devices:
========
GPU0:
	apiVersion         = 1.3.274
	vendorID           = 0x10005
	deviceID           = 0x0000
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 17.0.6, 256 bits)
${[1, 2, 3, 4]
  .map(
    (i) => `GPU${i}:
	apiVersion         = 1.3.274
	vendorID           = 0x1002
	deviceID           = 0x731f
	deviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
	deviceName         = AMD Radeon RX 5700 XT (RADV NAVI10)`
  )
  .join("\n")}
`;

const vulkanProbe: Probe = (cmd) => (cmd === "vulkaninfo" ? VULKAN_SUMMARY : null);
const base = { platform: "linux" as const, arch: "x64", ramGb: 64, cpuModel: "Ryzen", cpuCores: 16, hostname: "rig" };

describe("AMD without ROCm: sysfs and Vulkan detection", () => {
  it("reads card<N> devices with VRAM from sysfs, skipping connectors and cards without VRAM", () => {
    const cards = readSysfsGpus(rig());
    expect(cards.map((c) => c.card)).toEqual([1, 2, 3, 4]);
    expect(cards[0]).toMatchObject({ vendor: "amd", deviceId: "0x731f", vramBytes: 8 * GIB });
  });

  it("parses vulkaninfo --summary in Vulkan's numbering", () => {
    const d = parseVulkanSummary(VULKAN_SUMMARY);
    expect(d).toHaveLength(5);
    expect(d[0]).toMatchObject({ index: 0, deviceType: "PHYSICAL_DEVICE_TYPE_CPU" });
    expect(d[4]).toMatchObject({ index: 4, vendorId: "0x1002", deviceName: "AMD Radeon RX 5700 XT (RADV NAVI10)" });
    expect(gfxName(100100)).toBe("gfx1010");
    expect(gfxName(90010)).toBe("gfx90a");
  });

  it("no nvidia-smi / rocm-smi: four Navi 10 cards from sysfs, named and numbered by Vulkan, gfx1010 not ROCm", () => {
    const hw = detectHardware({ ...base, probe: vulkanProbe, sysfs: rig() });
    expect(hw.gpus).toHaveLength(4);
    expect(hw.gpus[0]).toMatchObject({ index: 0, vendor: "amd", model: "AMD Radeon RX 5700 XT (RADV NAVI10)", vramGb: 8, source: "sysfs", gfxTarget: "gfx1010", rocmSupported: false, vulkanIndex: 1 });
    expect(hw.gpus.map((g) => g.vulkanIndex)).toEqual([1, 2, 3, 4]);
    // Pooled as the installer writes it: 32 GB x4, as the portal showed.
    const env = { HIP_VISIBLE_DEVICES: "0,1,2,3", CUDA_VISIBLE_DEVICES: "0,1,2,3", EDGECODER_GPU_INDEX: "0" };
    expect(hardwareProfileFor(hw, selectGpu(hw, env), selectGpuPool(hw, env)).gpu).toMatchObject({ vendor: "amd", vramGb: 32, count: 4 });
    expect(gpuNeedsOffloadProof(selectGpu(hw, env))).toBe(true);
  });

  it("without vulkaninfo the card is still found (named from its PCI id)", () => {
    const hw = detectHardware({ ...base, probe: () => null, sysfs: rig() });
    expect(hw.gpus[0]).toMatchObject({ model: "Navi 10 (Radeon RX 5600 XT / 5700 / 5700 XT)", vramGb: 8, rocmSupported: false });
    expect(hw.gpus[0].vulkanIndex).toBeUndefined();
  });

  it("rocm-smi lists a gfx1010 card: annotated as not ROCm-supported, so its offload must be proven", () => {
    const rocm = "device,VRAM Total Memory (B),Card series\ncard0,8573157376,Navi 10 [Radeon RX 5600 OEM/5600 XT / 5700/5700 XT]\n".replace(/\n$/, "") +
      "\n" + [1, 2, 3].map((i) => `card${i},8573157376,Navi 10 [Radeon RX 5600 OEM/5600 XT / 5700/5700 XT]`).join("\n") + "\n";
    const probe: Probe = (cmd) => (cmd === "rocm-smi" ? rocm : cmd === "vulkaninfo" ? VULKAN_SUMMARY : null);
    const hw = detectHardware({ ...base, probe, sysfs: rig() });
    expect(hw.gpus).toHaveLength(4);
    expect(hw.gpus[0]).toMatchObject({ source: "rocm-smi", gfxTarget: "gfx1010", rocmSupported: false, vulkanIndex: 1 });
    expect(gpuNeedsOffloadProof(hw.gpus[0])).toBe(true);
  });

  it("NVIDIA and ROCm-supported AMD keep being claimed as detected", () => {
    expect(gpuNeedsOffloadProof({ index: 0, vendor: "nvidia", model: "RTX 4090", vramGb: 24, datacenter: false, source: "nvidia-smi" })).toBe(false);
    expect(gpuNeedsOffloadProof({ index: 0, vendor: "amd", model: "RX 7900 XTX", vramGb: 24, datacenter: false, source: "rocm-smi", rocmSupported: true })).toBe(false);
    // rocm-smi with no KFD topology to say otherwise: as before.
    expect(gpuNeedsOffloadProof({ index: 0, vendor: "amd", model: "MI300X", vramGb: 192, datacenter: true, source: "rocm-smi" })).toBe(false);
    expect(gpuNeedsOffloadProof(undefined)).toBe(false);
  });

  it("prints the exact --ollama-env suggestion, and nothing once Vulkan is on", () => {
    const hw = detectHardware({ ...base, probe: vulkanProbe, sysfs: rig() });
    const hint = vulkanHint(hw);
    expect(hint).toContain("4 AMD GPUs (gfx1010) without ROCm support");
    expect(hint).toContain("sudo edgecoder-install apply --keep-config --ollama-env OLLAMA_VULKAN=1 --ollama-env GGML_VK_VISIBLE_DEVICES=1,2,3,4");
    expect(vulkanHint(hw, { OLLAMA_VULKAN: "1" })).toBeUndefined();
    // Several instances: each gets its own cards' devices, so OLLAMA_VULKAN=1 alone.
    expect(vulkanHint(hw, {}, 4)).toContain("--ollama-env OLLAMA_VULKAN=1.");
    // Unknown Vulkan numbering: a guess, with how to check it.
    expect(vulkanHint(detectHardware({ ...base, probe: () => null, sysfs: rig() }))).toContain("vulkaninfo --summary");
  });
});

describe("GPU claim: only when the engine offloads (or the benchmark says GPU)", () => {
  const detected = { cpuCores: 16, ramGb: 64, platform: "linux", arch: "x64", gpu: { vendor: "amd", model: "Navi 10", vramGb: 32, datacenter: false, count: 4 } };
  const coder = { name: "qwen3-coder:30b", sizeBytes: 19 * GIB, vramBytes: 19 * GIB };

  it("vendor-stack GPUs are claimed as detected", () => {
    expect(decideGpuClaim({ needsProof: false })).toMatchObject({ claimGpu: true, evidence: "detected" });
  });

  it("starts as CPU with no evidence", () => {
    const d = decideGpuClaim({ needsProof: true });
    expect(d).toMatchObject({ claimGpu: false, evidence: "unconfirmed" });
    expect(classifyHardware(claimedProfile(detected, d.claimGpu) as never)).toMatchObject({ computeClass: "cpu", tier: "cpu.std" });
  });

  it("Ollama /api/ps with the served model fully in VRAM: GPU class by VRAM", () => {
    const d = decideGpuClaim({ needsProof: true, loaded: [coder], model: "qwen3-coder:30b" });
    expect(d).toMatchObject({ claimGpu: true, evidence: "offload" });
    expect(classifyHardware(claimedProfile(detected, d.claimGpu) as never)).toMatchObject({ computeClass: "gpu", tier: "gpu.c32", vramGb: 32 });
  });

  it("partial offload (mostly on the CPU) stays CPU, even with a fast-looking benchmark", () => {
    const half = { ...coder, vramBytes: 9 * GIB };
    expect(decideGpuClaim({ needsProof: true, loaded: [half], model: "qwen3-coder:30b", benchmarkBandwidthGbps: 500, previous: true })).toMatchObject({ claimGpu: false, evidence: "partial_offload" });
  });

  it("judges the served model first, else the largest loaded one", () => {
    const cpuSmall = { name: "qwen3.5:9b", sizeBytes: 6 * GIB, vramBytes: 0 };
    expect(decideGpuClaim({ needsProof: true, loaded: [coder, cpuSmall], model: "qwen3.5:9b" }).claimGpu).toBe(false);
    expect(decideGpuClaim({ needsProof: true, loaded: [cpuSmall, coder], model: "other:1b" }).claimGpu).toBe(true);
  });

  it("nothing loaded: the self-benchmark decides against the GPU class floor", () => {
    expect(decideGpuClaim({ needsProof: true, benchmarkBandwidthGbps: GPU_CLASS_MIN_BANDWIDTH_GBPS + 1 })).toMatchObject({ claimGpu: true, evidence: "benchmark" });
    expect(decideGpuClaim({ needsProof: true, benchmarkBandwidthGbps: 20, previous: true })).toMatchObject({ claimGpu: false, evidence: "slow_benchmark" });
    // Nothing at all: keeps the last decision (a model unloaded by keep-alive says nothing).
    expect(decideGpuClaim({ needsProof: true, previous: true })).toMatchObject({ claimGpu: true, evidence: "unconfirmed" });
  });
});

describe("--ollama-env: persisted through --keep-config and updates", () => {
  const hw = detectHardware({ ...base, probe: vulkanProbe, sysfs: rig() });

  it("parses, validates and refuses what would break the instance", () => {
    const o = parseInstallArgs(["apply", "--single", "--ollama-env", "OLLAMA_VULKAN=1", "--ollama-env=GGML_VK_VISIBLE_DEVICES=1,2,3,4"]);
    expect(o.ollamaEnv).toEqual({ OLLAMA_VULKAN: "1", GGML_VK_VISIBLE_DEVICES: "1,2,3,4" });
    expect(() => checkOllamaEnv("OLLAMA_HOST=0.0.0.0:11434")).toThrow(/set by the installer/);
    expect(() => checkOllamaEnv("X=$(id)")).toThrow();
    expect(() => checkOllamaEnv("X=a b")).toThrow();
    expect(() => checkOllamaEnv("novalue")).toThrow(/KEY=VALUE/);
  });

  it("is written into the Ollama unit and recorded in EDGECODER_INSTALL_ARGS, which a later run (update) keeps", () => {
    let o = parseInstallArgs(["apply", "--single", "--token", "t", "--ollama-env", "OLLAMA_VULKAN=1", "--ollama-env", "GGML_VK_VISIBLE_DEVICES=1,2,3,4"]);
    o = inheritTuning(o, undefined);
    const plan = planInstall(hw, o, true);
    const p = defaultPaths("linux", { nodeBin: "/usr/bin/node", appDir: "/opt/edgecoder/app" });
    const unit = systemdOllamaUnit(p, plan.instances[0]);
    expect(unit).toContain('Environment="OLLAMA_VULKAN=1"');
    expect(unit).toContain('Environment="GGML_VK_VISIBLE_DEVICES=1,2,3,4"');
    const envFile = renderEnvFile(plan.instances[0].env);
    expect(envFile).toMatch(/^EDGECODER_INSTALL_ARGS=.*ollama-env:OLLAMA_VULKAN=1/m);
    expect(installArgsFromEnvFile(envFile).ollamaEnv).toEqual({ OLLAMA_VULKAN: "1", GGML_VK_VISIBLE_DEVICES: "1,2,3,4" });

    // What `update` runs: apply --from-package --keep-config, no --ollama-env given.
    let again = parseInstallArgs(["apply", "--from-package", "--keep-config"]);
    again = inheritConfig(inheritTuning(again, envFile), envFile);
    expect(again.ollamaEnv).toEqual({ OLLAMA_VULKAN: "1", GGML_VK_VISIBLE_DEVICES: "1,2,3,4" });
    expect(again.layout).toBe("single");
    const plan2 = planInstall(hw, again, true);
    expect(systemdOllamaUnit(p, plan2.instances[0])).toContain('Environment="GGML_VK_VISIBLE_DEVICES=1,2,3,4"');
    expect(renderInstallArgs(again)).toContain("ollama-env:GGML_VK_VISIBLE_DEVICES=1%2C2%2C3%2C4");

    // A package upgrade without --keep-config keeps it too.
    expect(inheritTuning(parseInstallArgs(["apply", "--from-package"]), envFile).ollamaEnv).toEqual({ OLLAMA_VULKAN: "1", GGML_VK_VISIBLE_DEVICES: "1,2,3,4" });
    // Given again: merged; KEY= removes one.
    expect(inheritTuning(parseInstallArgs(["apply", "--ollama-env", "GGML_VK_VISIBLE_DEVICES=", "--ollama-env", "OLLAMA_DEBUG=1"]), envFile).ollamaEnv).toEqual({ OLLAMA_VULKAN: "1", OLLAMA_DEBUG: "1" });
  });

  it("a tampered record adds nothing", () => {
    expect(installArgsFromEnvFile("EDGECODER_INSTALL_ARGS=ollama-env:OLLAMA_HOST=0.0.0.0,ollama-env:X=%24(id)").ollamaEnv).toBeUndefined();
  });

  it("OLLAMA_VULKAN=1 alone: each instance gets its own cards' Vulkan devices", () => {
    const o = inheritTuning(parseInstallArgs(["apply", "--per-gpu", "--ollama-env", "OLLAMA_VULKAN=1"]), undefined);
    const plan = planInstall(hw, o, true);
    const p = defaultPaths("linux");
    expect(plan.instances).toHaveLength(4);
    expect(systemdOllamaUnit(p, plan.instances[2])).toContain('Environment="GGML_VK_VISIBLE_DEVICES=3"');
    expect(planInstall(hw, inheritTuning(parseInstallArgs(["apply", "--per-gpu", "--ollama-env", "GGML_VK_VISIBLE_DEVICES=1"]), undefined), true).warnings.join("\n")).toContain("applies to all 4 instances");
  });
});

describe("systemd drop-ins: never touched by apply, update or remove", () => {
  function fakeHost() {
    const files = new Map<string, string>();
    const removed: string[] = [];
    const host: Host = {
      platform: "linux",
      writeFile: (p, c) => { files.set(p, c); },
      removeFile: (p) => { removed.push(p); files.delete(p); },
      run: () => ({ code: 0, stdout: "", stderr: "" }),
      exists: (p) => files.has(p)
    };
    return { host, files, removed };
  }
  const dropIn = "/etc/systemd/system/edgecoder-ollama-0.service.d/override.conf";
  const conf = "[Service]\nEnvironment=OLLAMA_VULKAN=1\nEnvironment=GGML_VK_VISIBLE_DEVICES=1,2,3,4\n";

  it("apply (and a re-apply) rewrites the unit but leaves the host's drop-in as it was", () => {
    const hw = detectHardware({ ...base, probe: vulkanProbe, sysfs: rig() });
    const { host, files, removed } = fakeHost();
    files.set(dropIn, conf);
    const p = defaultPaths("linux", { nodeBin: "/usr/bin/node", appDir: "/opt/edgecoder/app" });
    const plan = planInstall(hw, parseInstallArgs(["apply", "--single", "--token", "t"]), true);
    const r1 = applyPlan(plan, host, p, false);
    const r2 = applyPlan(plan, host, p, false);
    expect(files.get(dropIn)).toBe(conf);
    expect([...r1.files, ...r2.files].filter((f) => f.includes(".service.d/"))).toEqual([]);
    expect(removed.filter((f) => f.includes(".service.d/"))).toEqual([]);
    expect([...r1.commands, ...r2.commands].filter((c) => c.includes(".service.d"))).toEqual([]);
    expect(files.get("/etc/systemd/system/edgecoder-ollama-0.service")).toContain("go in a drop-in, which apply and update never touch");
    // remove takes our units, never the host's drop-in.
    files.set("/etc/edgecoder/agent-0.env", "x");
    removeServices(host, p);
    expect(files.get(dropIn)).toBe(conf);
    expect(removed).not.toContain(dropIn);
  });

  it("reads Environment= lines a host put in its drop-ins (so the Vulkan hint is not repeated)", () => {
    const read = (p: string) => (p === dropIn ? conf + 'Environment="OLLAMA_DEBUG=1" FOO=bar\n' : undefined);
    const list = (d: string) => (d === "/etc/systemd/system/edgecoder-ollama-0.service.d" ? ["override.conf", "notes.txt"] : []);
    expect(hostOllamaEnv(read, list)).toEqual({ OLLAMA_VULKAN: "1", GGML_VK_VISIBLE_DEVICES: "1,2,3,4", OLLAMA_DEBUG: "1", FOO: "bar" });
  });
});

describe("Models panel: who chooses the model and how to change it", () => {
  const st = { activeModel: "qwen3.5:9b", remoteControl: "on", sources: { model: "env" }, loaded: [{ name: "qwen3-coder:30b" }] };

  it("host config, remote control on: Use here (saved, kept through updates) or the exact command", () => {
    const t = modelSourceNote(st, true);
    expect(t).toContain("This machine's own config (OLLAMA_MODEL in /etc/edgecoder/agent-<n>.env) chooses qwen3.5:9b.");
    expect(t).toContain("To switch from here, press Use next to an installed model");
    expect(t).toContain("kept through updates");
    expect(t).toContain("sudo edgecoder-install apply --keep-config --model <model>");
    // A model loaded by hand is not the served one.
    expect(t).toContain("Also loaded in Ollama: qwen3-coder:30b");
    expect(t).toContain("press Use on qwen3-coder:30b to serve it instead");
  });

  it("remote control off: only the machine can change it", () => {
    const t = modelSourceNote({ ...st, remoteControl: "off" }, true);
    expect(t).toContain("Remote control is off on this machine, so change it on the machine: sudo edgecoder-install apply --keep-config --model <model>");
    expect(t).toContain("run on the machine: sudo edgecoder-install apply --keep-config --model qwen3-coder:30b");
  });

  it("chosen here: says it persists and what replaces it", () => {
    const t = modelSourceNote({ activeModel: "qwen3-coder:30b", remoteControl: "on", sources: { model: "remote" }, loaded: [{ name: "qwen3-coder:30b" }] }, true);
    expect(t).toBe("Active model qwen3-coder:30b was chosen here. It is saved on the machine and kept through updates; a later model change on the machine itself (sudo edgecoder-install apply --keep-config --model <model>) replaces it.");
  });
});
