// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Host hardware detection shared by the installer and the agent (docs/install.md).
 *
 * One code path for every platform: NVIDIA via nvidia-smi (Linux and Windows), AMD via rocm-smi
 * (Linux, best effort), Apple silicon from the platform (its GPU shares unified memory), CPU
 * and RAM from Node. On Linux, AMD and Intel cards without ROCm tools (or with cards ROCm does
 * not support, e.g. RX 5700 XT / gfx1010, which Ollama runs through Vulkan) are found in sysfs:
 * /sys/class/drm/card<N>/device/{vendor,device,mem_info_vram_total}, with names and Vulkan device
 * numbers from `vulkaninfo --summary` when it is installed, and the ROCm target from the KFD
 * topology. Parsing is pure so it is unit-tested; the probes and file reads are injected.
 */
import { readdirSync, readFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";

export interface GpuInfo {
  index: number;
  vendor: "nvidia" | "amd" | "apple" | "intel" | "unknown";
  model: string;
  vramGb: number;
  /** Datacenter or workstation part (affects pricing class above 24 GB). */
  datacenter: boolean;
  /** How the card was found. sysfs: the kernel reports it, but no vendor tool did (no CUDA / ROCm stack). */
  source?: "nvidia-smi" | "rocm-smi" | "sysfs" | "platform";
  /** AMD: the ROCm target (gfx1010 ...) from the KFD topology, when the kernel reports one. */
  gfxTarget?: string;
  /** AMD: whether Ollama's ROCm build supports the card; undefined when unknown. */
  rocmSupported?: boolean;
  /** The card's Vulkan device number (GGML_VK_VISIBLE_DEVICES), from `vulkaninfo --summary`. */
  vulkanIndex?: number;
}

export interface HostHardware {
  platform: NodeJS.Platform;
  arch: string;
  hostname: string;
  cpuCores: number;
  cpuModel: string;
  ramGb: number;
  gpus: GpuInfo[];
  /** Apple silicon: GPU memory is the unified memory. */
  unifiedMemory: boolean;
}

/** Runs a command and returns stdout, or null when it is missing or fails. Injected for tests. */
export type Probe = (cmd: string, args: string[]) => string | null;

/** Reads a (sysfs) file or lists a directory; null when it is missing or unreadable. Injected for tests. */
export interface SysFs {
  read(path: string): string | null;
  list(dir: string): string[] | null;
}

export const realSysFs: SysFs = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return null;
    }
  }
};

const DATACENTER_PATTERN = /(^|[^a-z0-9])(H100|H200|H800|A100|A800|A40|A30|A16|A10G?|A6000|A5000|A4000|L40S?|L4|V100|B100|B200|GB200|RTX\s*6000|RTX\s*5000|RTX\s*4500|RTX\s*PRO|MI\d{3}[A-Z]?|Tesla|Quadro)(?=$|[^a-z0-9])/i;

export function isDatacenterGpu(model: string): boolean {
  return DATACENTER_PATTERN.test(model);
}

/** `nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits` → GPUs. */
export function parseNvidiaSmi(output: string): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 3) continue;
    const index = Number(parts[0]);
    const model = parts[1];
    const vramMb = Number(parts[2]);
    if (!Number.isInteger(index) || !model || !Number.isFinite(vramMb)) continue;
    out.push({ index, vendor: "nvidia", model, vramGb: Math.round(vramMb / 1024), datacenter: isDatacenterGpu(model), source: "nvidia-smi" });
  }
  return out;
}

/**
 * `rocm-smi --showproductname --showmeminfo vram --csv` → GPUs (best effort; column names vary
 * between ROCm versions, so this looks for a "card" column, a name column and a VRAM-total column).
 */
export function parseRocmSmi(output: string): GpuInfo[] {
  const lines = output.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const nameCol = header.findIndex((h) => h.includes("card series") || h.includes("product name") || h === "name");
  const memCol = header.findIndex((h) => h.includes("vram total"));
  const out: GpuInfo[] = [];
  lines.slice(1).forEach((line, i) => {
    const cols = line.split(",").map((c) => c.trim());
    const model = nameCol >= 0 ? cols[nameCol] : "AMD GPU";
    const bytes = memCol >= 0 ? Number(cols[memCol]) : NaN;
    if (!model) return;
    out.push({ index: i, vendor: "amd", model, vramGb: Number.isFinite(bytes) ? Math.round(bytes / 1024 ** 3) : 0, datacenter: isDatacenterGpu(model), source: "rocm-smi" });
  });
  return out;
}

const PCI_VENDOR: Record<string, GpuInfo["vendor"]> = { "0x1002": "amd", "0x8086": "intel", "0x10de": "nvidia" };

/** A few common AMD device ids, for a readable name when neither vulkaninfo nor the kernel names the card. */
const AMD_DEVICE_NAMES: Record<string, string> = {
  "0x7310": "Navi 10 (Radeon Pro W5700)",
  "0x7312": "Navi 10 (Radeon Pro W5700)",
  "0x7318": "Navi 10 (Radeon RX 5700 series)",
  "0x7319": "Navi 10 (Radeon RX 5700 series)",
  "0x731a": "Navi 10 (Radeon RX 5700 series)",
  "0x731b": "Navi 10 (Radeon RX 5700 series)",
  "0x731e": "Navi 10 (Radeon RX 5700 series)",
  "0x731f": "Navi 10 (Radeon RX 5600 XT / 5700 / 5700 XT)",
  "0x7340": "Navi 14 (Radeon RX 5500 series)",
  "0x7341": "Navi 14 (Radeon Pro W5500)",
  "0x67df": "Polaris 10 (Radeon RX 470 / 480 / 570 / 580)",
  "0x67ef": "Polaris 11 (Radeon RX 460 / 560)",
  "0x687f": "Vega 10 (Radeon RX Vega 56 / 64)"
};

/** One card the kernel's DRM layer reports (sysfs), before naming. */
export interface SysfsGpu {
  card: number;
  vendor: GpuInfo["vendor"];
  deviceId: string;
  vramBytes: number;
  productName?: string;
}

/**
 * The GPUs under /sys/class/drm: card<N> entries (not their connectors, card0-DP-1), with the PCI
 * vendor and device id and, for amdgpu (and discrete Intel on xe), the VRAM size. A card without
 * dedicated VRAM (an integrated GPU) is left out: it has nothing to offer over the CPU's memory.
 */
export function readSysfsGpus(fs: SysFs, root = "/sys/class/drm"): SysfsGpu[] {
  const cards = (fs.list(root) ?? []).map((n) => /^card(\d+)$/.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
  const out: SysfsGpu[] = [];
  for (const card of cards) {
    const dev = `${root}/card${card}/device`;
    const vendor = PCI_VENDOR[(fs.read(`${dev}/vendor`) ?? "").trim().toLowerCase()];
    if (!vendor) continue;
    const vram = Number((fs.read(`${dev}/mem_info_vram_total`) ?? "").trim());
    if (!Number.isFinite(vram) || vram <= 0) continue;
    const productName = (fs.read(`${dev}/product_name`) ?? "").trim();
    out.push({ card, vendor, deviceId: (fs.read(`${dev}/device`) ?? "").trim().toLowerCase(), vramBytes: vram, ...(productName ? { productName: productName.slice(0, 128) } : {}) });
  }
  return out;
}

/** One device from `vulkaninfo --summary`. */
export interface VulkanDevice {
  index: number;
  vendorId: string;
  deviceId: string;
  deviceType: string;
  deviceName: string;
}

/** `vulkaninfo --summary` -> its devices (GPU0:, GPU1:, ... blocks), in Vulkan's own numbering. */
export function parseVulkanSummary(output: string): VulkanDevice[] {
  const out: VulkanDevice[] = [];
  let cur: VulkanDevice | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const head = /^GPU(\d+):\s*$/.exec(raw.trim());
    if (head) {
      cur = { index: Number(head[1]), vendorId: "", deviceId: "", deviceType: "", deviceName: "" };
      out.push(cur);
      continue;
    }
    const kv = /^\s*(vendorID|deviceID|deviceType|deviceName)\s*=\s*(.+?)\s*$/.exec(raw);
    if (!cur || !kv) continue;
    if (kv[1] === "vendorID") cur.vendorId = kv[2].toLowerCase();
    else if (kv[1] === "deviceID") cur.deviceId = kv[2].toLowerCase();
    else if (kv[1] === "deviceType") cur.deviceType = kv[2];
    else cur.deviceName = kv[2].slice(0, 128);
  }
  return out;
}

/**
 * ROCm targets Ollama's ROCm build runs (KFD gfx_target_version, major*10000 + minor*100 + step):
 * gfx900/906/908/90a, gfx940-942, gfx1030, gfx1100-1102, gfx1150/1151, gfx1200/1201. Anything else
 * (RDNA1 gfx1010-1012, Polaris gfx803, gfx1031 without an override ...) runs on Vulkan or the CPU.
 */
const ROCM_SUPPORTED_TARGETS = new Set([90000, 90006, 90008, 90010, 90400, 90401, 90402, 100300, 110000, 110001, 110002, 110500, 110501, 120000, 120001]);

export function gfxName(version: number): string {
  const major = Math.floor(version / 10000);
  const minor = Math.floor(version / 100) % 100;
  const step = version % 100;
  return `gfx${major}${minor.toString(16)}${step.toString(16)}`;
}

/** The GPU ROCm targets the kernel's KFD topology lists (CPU nodes report 0), in node order. */
export function readKfdTargets(fs: SysFs, root = "/sys/class/kfd/kfd/topology/nodes"): number[] {
  const nodes = (fs.list(root) ?? []).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  const out: number[] = [];
  for (const n of nodes) {
    const m = /^gfx_target_version\s+(\d+)\s*$/m.exec(fs.read(`${root}/${n}/properties`) ?? "");
    const v = m ? Number(m[1]) : 0;
    if (v > 0) out.push(v);
  }
  return out;
}

/**
 * AMD cards: the ROCm target and whether Ollama's ROCm build supports it (KFD topology, in the
 * same order as rocm-smi and sysfs list the cards), and the Vulkan device number and name from
 * `vulkaninfo --summary` (matched in order among that vendor's GPUs; Vulkan may number a software
 * renderer or another card first, which is why the hosts's GGML_VK_VISIBLE_DEVICES can start at 1).
 */
function annotate(gpus: GpuInfo[], fs: SysFs, probe: Probe): void {
  const amd = gpus.filter((g) => g.vendor === "amd");
  const targets = readKfdTargets(fs);
  if (amd.length && targets.length === amd.length) {
    amd.forEach((g, i) => {
      g.gfxTarget = gfxName(targets[i]);
      g.rocmSupported = ROCM_SUPPORTED_TARGETS.has(targets[i]);
    });
  }
  const vkVendor: Record<string, string> = { amd: "0x1002", intel: "0x8086" };
  const wanted = gpus.filter((g) => vkVendor[g.vendor]);
  if (!wanted.length) return;
  const vk = probe("vulkaninfo", ["--summary"]);
  if (!vk) return;
  const devices = parseVulkanSummary(vk).filter((d) => !/CPU/i.test(d.deviceType));
  for (const vendor of ["amd", "intel"] as const) {
    const ours = gpus.filter((g) => g.vendor === vendor);
    const theirs = devices.filter((d) => d.vendorId === vkVendor[vendor] && /DISCRETE/i.test(d.deviceType));
    if (!ours.length || theirs.length !== ours.length) continue;
    ours.forEach((g, i) => {
      g.vulkanIndex = theirs[i].index;
      if (g.source === "sysfs" && theirs[i].deviceName) g.model = theirs[i].deviceName;
    });
  }
}

/** sysfs cards as GpuInfo, numbered in card order (the order ROCm / HIP and Ollama number them). */
export function gpusFromSysfs(cards: SysfsGpu[]): GpuInfo[] {
  return cards
    .filter((c) => c.vendor === "amd" || c.vendor === "intel")
    .map((c, i) => {
      const model = c.productName || (c.vendor === "amd" ? AMD_DEVICE_NAMES[c.deviceId] : undefined) || `${c.vendor === "amd" ? "AMD" : "Intel"} GPU ${c.deviceId || ""}`.trim();
      return { index: i, vendor: c.vendor, model, vramGb: Math.round(c.vramBytes / 1024 ** 3), datacenter: isDatacenterGpu(model), source: "sysfs" as const };
    });
}

export interface DetectInput {
  probe: Probe;
  /** sysfs reads (Linux); defaults to the real filesystem. */
  sysfs?: SysFs;
  platform?: NodeJS.Platform;
  arch?: string;
  cpuCores?: number;
  cpuModel?: string;
  ramGb?: number;
  hostname?: string;
}

export function detectHardware(input: DetectInput): HostHardware {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const cpu = cpus();
  const ramGb = input.ramGb ?? Number((totalmem() / 1024 ** 3).toFixed(1));
  const hw: HostHardware = {
    platform,
    arch,
    hostname: input.hostname ?? hostname(),
    cpuCores: input.cpuCores ?? cpu.length,
    cpuModel: input.cpuModel ?? (cpu[0]?.model ?? "unknown").slice(0, 128),
    ramGb,
    gpus: [],
    unifiedMemory: false
  };
  if (platform === "darwin" && arch === "arm64") {
    hw.unifiedMemory = true;
    hw.gpus.push({ index: 0, vendor: "apple", model: hw.cpuModel.replace(/\s*\(.*$/, "") || "Apple silicon", vramGb: Math.round(ramGb), datacenter: false, source: "platform" });
    return hw;
  }
  const nv = input.probe("nvidia-smi", ["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"]);
  if (nv) hw.gpus.push(...parseNvidiaSmi(nv));
  if (hw.gpus.length === 0 && platform === "linux") {
    const amd = input.probe("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--csv"]);
    if (amd) hw.gpus.push(...parseRocmSmi(amd));
    const fs = input.sysfs ?? realSysFs;
    // No vendor tool answered (no ROCm stack, or not on this PATH): the kernel still knows the cards.
    if (hw.gpus.length === 0) hw.gpus.push(...gpusFromSysfs(readSysfsGpus(fs)));
    annotate(hw.gpus, fs, input.probe);
  }
  return hw;
}

/** GPUs Ollama can only use through Vulkan here: AMD without ROCm support (or no ROCm at all), and Intel. */
export function vulkanOnlyGpus(hw: HostHardware): GpuInfo[] {
  return hw.gpus.filter((g) => (g.vendor === "amd" && (g.rocmSupported === false || (g.source === "sysfs" && g.rocmSupported !== true))) || (g.vendor === "intel" && g.source === "sysfs"));
}

/**
 * Must a GPU's offload be confirmed before the agent claims a GPU class for it? Yes for cards that
 * only Vulkan can drive (or no vendor tool found): Ollama may well be running them on the CPU.
 * NVIDIA (CUDA), ROCm-supported AMD, Apple silicon and explicit AGENT_GPU_* overrides: no.
 */
export function gpuNeedsOffloadProof(gpu: GpuInfo | undefined): boolean {
  if (!gpu) return false;
  if (gpu.vendor === "intel") return true;
  if (gpu.vendor === "amd") return gpu.rocmSupported !== true && (gpu.rocmSupported === false || gpu.source === "sysfs");
  return false;
}

/**
 * The installer's hint for AMD / Intel cards Ollama can only use through Vulkan, unless the host
 * already turned Vulkan on: the exact flags to pass. undefined when there is nothing to suggest.
 */
export function vulkanHint(hw: HostHardware, ollamaEnv: Record<string, string> = {}, instances = 1): string | undefined {
  const cards = vulkanOnlyGpus(hw);
  if (!cards.length || ollamaEnv.OLLAMA_VULKAN === "1") return undefined;
  const targets = [...new Set(cards.map((g) => g.gfxTarget).filter(Boolean))];
  const what = `${cards.length} ${cards[0].vendor === "amd" ? "AMD" : "Intel"} GPU${cards.length > 1 ? "s" : ""}${targets.length ? ` (${targets.join(", ")})` : ""}`;
  const known = cards.every((g) => g.vulkanIndex !== undefined);
  // Several instances: each instance's Ollama gets its own cards' Vulkan numbers (services.ts), so
  // OLLAMA_VULKAN=1 alone is right. One instance: name the devices, as the host would by hand.
  const devices = known ? cards.map((g) => g.vulkanIndex).join(",") : cards.map((_, i) => i).join(",");
  const flags = instances > 1 && known ? "--ollama-env OLLAMA_VULKAN=1" : `--ollama-env OLLAMA_VULKAN=1 --ollama-env GGML_VK_VISIBLE_DEVICES=${devices}`;
  return `${what} without ROCm support: Ollama can run them through Vulkan. Run: sudo edgecoder-install apply --keep-config ${flags}${known ? "" : " (check the device numbers with: vulkaninfo --summary)"}. The agent claims a GPU class once Ollama reports the model in VRAM.`;
}

/**
 * The hardware profile the agent reports for one GPU (or none): the coordinator prices it. With a
 * pool (several cards behind this instance's Ollama, src/install/plan.ts) the VRAM is the pool's
 * sum and `count` says how many cards, so a model needing the pooled memory is matched to it; the
 * reported card (model, datacenter) is the first.
 */
export function hardwareProfileFor(hw: HostHardware, gpu: GpuInfo | undefined, pool: GpuInfo[] = []): Record<string, unknown> {
  const cards = gpu && pool.length > 1 && pool.some((g) => g.index === gpu.index) ? pool : gpu ? [gpu] : [];
  return {
    cpuCores: hw.cpuCores,
    cpuModel: hw.cpuModel,
    ramGb: hw.ramGb,
    arch: hw.arch,
    platform: hw.platform,
    ...(gpu
      ? { gpu: { vendor: gpu.vendor, model: gpu.model, vramGb: cards.reduce((n, g) => n + g.vramGb, 0), datacenter: gpu.datacenter, ...(cards.length > 1 ? { count: cards.length } : {}) } }
      : {})
  };
}

/**
 * Every GPU this instance's Ollama uses: the cards CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES list
 * (nvidia-smi and rocm-smi indexes ignore those variables, so they match), else the selected one.
 */
export function selectGpuPool(hw: HostHardware, env: NodeJS.ProcessEnv): GpuInfo[] {
  const one = selectGpu(hw, env);
  if (!one) return [];
  const raw = (one.vendor === "amd" ? env.HIP_VISIBLE_DEVICES ?? env.CUDA_VISIBLE_DEVICES : env.CUDA_VISIBLE_DEVICES ?? env.HIP_VISIBLE_DEVICES) ?? "";
  const indexes = raw.split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);
  const pool = [...new Set(indexes)].map((i) => hw.gpus.find((g) => g.index === i && g.vendor === one.vendor)).filter((g): g is GpuInfo => !!g);
  return pool.length > 1 && pool.some((g) => g.index === one.index) ? pool : [one];
}

/** Which of the detected GPUs this process should report: CUDA_VISIBLE_DEVICES / EDGECODER_GPU_INDEX, else the first. */
export function selectGpu(hw: HostHardware, env: NodeJS.ProcessEnv): GpuInfo | undefined {
  if (hw.gpus.length === 0) return undefined;
  const raw = env.EDGECODER_GPU_INDEX ?? env.CUDA_VISIBLE_DEVICES ?? env.HIP_VISIBLE_DEVICES;
  if (raw !== undefined && raw.trim() !== "") {
    const first = Number(raw.split(",")[0]);
    const match = hw.gpus.find((g) => g.index === first);
    if (match) return match;
  }
  return hw.gpus[0];
}
