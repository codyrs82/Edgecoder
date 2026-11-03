// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Host hardware detection shared by the installer and the agent (docs/install.md).
 *
 * One code path for every platform: NVIDIA via nvidia-smi (Linux and Windows), AMD via rocm-smi
 * (Linux, best effort), Apple silicon from the platform (its GPU shares unified memory), CPU
 * and RAM from Node. Parsing is pure so it is unit-tested; the probes are injected.
 */
import { cpus, hostname, totalmem } from "node:os";

export interface GpuInfo {
  index: number;
  vendor: "nvidia" | "amd" | "apple" | "intel" | "unknown";
  model: string;
  vramGb: number;
  /** Datacenter or workstation part (affects pricing class above 24 GB). */
  datacenter: boolean;
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
    out.push({ index, vendor: "nvidia", model, vramGb: Math.round(vramMb / 1024), datacenter: isDatacenterGpu(model) });
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
    out.push({ index: i, vendor: "amd", model, vramGb: Number.isFinite(bytes) ? Math.round(bytes / 1024 ** 3) : 0, datacenter: isDatacenterGpu(model) });
  });
  return out;
}

export interface DetectInput {
  probe: Probe;
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
    hw.gpus.push({ index: 0, vendor: "apple", model: hw.cpuModel.replace(/\s*\(.*$/, "") || "Apple silicon", vramGb: Math.round(ramGb), datacenter: false });
    return hw;
  }
  const nv = input.probe("nvidia-smi", ["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"]);
  if (nv) hw.gpus.push(...parseNvidiaSmi(nv));
  if (hw.gpus.length === 0 && platform === "linux") {
    const amd = input.probe("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--csv"]);
    if (amd) hw.gpus.push(...parseRocmSmi(amd));
  }
  return hw;
}

/** The hardware profile the agent reports for one GPU (or none): the coordinator prices it. */
export function hardwareProfileFor(hw: HostHardware, gpu: GpuInfo | undefined): Record<string, unknown> {
  return {
    cpuCores: hw.cpuCores,
    cpuModel: hw.cpuModel,
    ramGb: hw.ramGb,
    arch: hw.arch,
    platform: hw.platform,
    ...(gpu ? { gpu: { vendor: gpu.vendor, model: gpu.model, vramGb: gpu.vramGb, datacenter: gpu.datacenter } } : {})
  };
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
