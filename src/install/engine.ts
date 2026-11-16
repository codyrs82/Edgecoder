// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Which engine serves each instance's model: Ollama (default), vLLM (Linux, NVIDIA) or MLX (macOS).
 * See docs/inference-engines.md.
 *
 * The installer rewrites agent-<n>.env on every run (a package upgrade, the GPU VM's update.sh).
 * An instance switched to vLLM has to stay on vLLM: with its Ollama held off by the switch drop-in,
 * an env file without the engine lines would leave the agent with no model at all. So a run
 * without --engine keeps the engine the instance already has, read from its env file
 * (EDGECODER_ENGINE and the VLLM_* / MLX_* lines) and, for vLLM, from the instance's marker file
 * and /etc/edgecoder/vllm-<n>.env.
 *
 * On Linux an instance on vLLM has, besides the env lines:
 *   /etc/edgecoder/vllm-<n>.active        the marker
 *   /etc/systemd/system/edgecoder-ollama-<n>.service.d/vllm-switch.conf
 *                                          ConditionPathExists=!<marker>: its Ollama never starts
 *                                          (not even through the agent unit's Wants=) while vLLM
 *                                          holds the GPUs' memory
 *   edgecoder-vllm@<n>.service enabled    from scripts/linux/vllm (install-vllm.sh)
 * --engine ollama removes all three and starts Ollama again.
 */

export type EngineKind = "ollama" | "vllm" | "mlx";
export const ENGINE_KINDS: readonly EngineKind[] = ["ollama", "vllm", "mlx"];

/** vLLM instance n listens on 8000 + n (install-vllm.sh). */
export const VLLM_BASE_PORT = 8000;
export const VLLM_SLOTS_RANGE = [1, 16] as const;

/**
 * install-vllm.sh profiles: the model and slots each one serves (the script holds the serve flags).
 * Qwen3-Coder-30B-A3B: AWQ weights ~17 GB, FP8 ~31 GB; KV cache 96 KiB per token at bf16 (48 layers
 * x 4 KV heads x 128 x 2 x 2 bytes). Every single-card profile is tensor parallel 1.
 */
export const VLLM_PROFILES: Record<string, { model: string; slots: number }> = {
  /** 2x A16 16 GB, tensor parallel 2 (needs --single so one instance owns both cards). */
  a16x2: { model: "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", slots: 2 },
  /** One 80 GB card (A100 80 GB, H100, and bigger: H200). FP8. */
  "a100-80": { model: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", slots: 12 },
  /** One A100 40 GB. AWQ: FP8 (31 GB) would leave ~3 GB of KV cache. */
  "a100-40": { model: "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", slots: 4 },
  /** One 44-48 GB card (RTX A6000, L40S, A40, RTX 6000 Ada). AWQ. */
  "gpu-48gb": { model: "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", slots: 6 },
  /** One 22-37 GB card (A10, L4, RTX 3090/4090/5090). AWQ at 16K context, one call at a time. */
  "gpu-24gb": { model: "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", slots: 1 }
};
/** --vllm-profile auto: pick the profile from each instance's GPUs (autoVllmProfile). */
export const VLLM_PROFILE_AUTO = "auto";

/** Agent env lines that belong to the engine: written for vLLM / MLX, removed for Ollama. */
export const ENGINE_ENV_KEYS = ["EDGECODER_ENGINE", "VLLM_URL", "VLLM_MODEL", "VLLM_MAX_SLOTS", "VLLM_API_KEY", "MLX_URL", "MLX_MODEL", "MLX_MAX_SLOTS", "ENGINE_MODEL_ALIASES"] as const;

export interface EngineFlags {
  engine?: EngineKind;
  vllmModel?: string;
  vllmSlots?: number;
  vllmUrl?: string;
  vllmProfile?: string;
}

export interface InstanceEngine {
  kind: EngineKind;
  /** The engine's agent env lines other than EDGECODER_ENGINE (VLLM_*, MLX_*, ENGINE_MODEL_ALIASES). */
  env: Record<string, string>;
  /** The engine the instance had before this run; undefined on a first install. */
  previous?: EngineKind;
  /** Linux vLLM: install-vllm.sh arguments when vLLM is not installed for the instance yet. */
  installArgs?: string[];
}

/** What a previous run left for instance n. */
export interface PreviousEngineState {
  /** agent-<n>.env, when it exists. */
  agentEnv?: string;
  /** vllm-<n>.env (install-vllm.sh), when it exists. */
  vllmEnv?: string;
  /** The vLLM marker (or, for instance 0, the legacy /etc/edgecoder/vllm-active) exists. */
  markerExists: boolean;
}

/** KEY=VALUE lines (systemd EnvironmentFile style); comments skipped, one pair of surrounding quotes removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function checkEngine(v: string): EngineKind {
  const k = v.trim().toLowerCase();
  if (!(ENGINE_KINDS as readonly string[]).includes(k)) throw new Error("--engine must be ollama, vllm or mlx");
  return k as EngineKind;
}
export function checkVllmModel(v: string): string {
  if (!/^[A-Za-z0-9._/:-]{1,200}$/.test(v)) throw new Error("--vllm-model must be a Hugging Face repo id (Org/Repo) or a path");
  return v;
}
export function checkVllmSlots(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < VLLM_SLOTS_RANGE[0] || n > VLLM_SLOTS_RANGE[1]) throw new Error(`--vllm-slots must be a whole number from ${VLLM_SLOTS_RANGE[0]} to ${VLLM_SLOTS_RANGE[1]}`);
  return n;
}
export function checkVllmUrl(v: string): string {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]_-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(v)) throw new Error("--vllm-url must be an http(s) URL such as http://127.0.0.1:8000");
  return v.replace(/\/+$/, "");
}
export function checkVllmProfile(v: string): string {
  if (v !== VLLM_PROFILE_AUTO && !Object.prototype.hasOwnProperty.call(VLLM_PROFILES, v)) throw new Error(`--vllm-profile must be one of ${vllmProfileChoices().join(", ")}`);
  return v;
}
/** Every --vllm-profile value: auto first, then the profiles. */
export function vllmProfileChoices(): string[] {
  return [VLLM_PROFILE_AUTO, ...Object.keys(VLLM_PROFILES)];
}

/**
 * --vllm-profile auto: the profile for an instance's GPUs (from nvidia-smi, hardware.ts), or why
 * none fits. One card: by its memory (nvidia-smi's MiB / 1024, rounded: an A10 or L4 reads 22,
 * an L40S 45, an A100 40 GB 40). Two 15-21 GB cards pooled in one instance (--single): a16x2.
 * Several bigger cards pooled: the smallest card's single-card profile (vLLM then uses the first
 * card; run --per-gpu for one vLLM per card).
 */
export function autoVllmProfile(gpus: ReadonlyArray<{ vendor: string; vramGb: number }>): { profile?: string; reason: string } {
  const nv = gpus.filter((g) => g.vendor === "nvidia");
  if (nv.length === 0 || nv.length !== gpus.length) return { reason: "vLLM needs NVIDIA GPUs, and nvidia-smi found none for this instance" };
  const min = Math.min(...nv.map((g) => g.vramGb));
  const what = `${nv.length > 1 ? `${nv.length}x ` : ""}${min} GB`;
  if (nv.length === 2 && min >= 15 && min < 22) return { profile: "a16x2", reason: `${what}: AWQ over both cards` };
  if (min >= 76) return { profile: "a100-80", reason: `${what}: FP8, 64K context, 12 slots` };
  if (min >= 44) return { profile: "gpu-48gb", reason: `${what}: AWQ, 64K context, 6 slots` };
  if (min >= 38) return { profile: "a100-40", reason: `${what}: AWQ, 64K context, 4 slots` };
  if (min >= 22) return { profile: "gpu-24gb", reason: `${what}: AWQ, 16K context, 1 slot` };
  if (nv.length === 1 && min >= 15) return { reason: `${what}: too small for vLLM's 30B model on its own; with two such cards, re-run with --single (profile a16x2), else stay on Ollama` };
  return { reason: `${what}: too small for vLLM's 30B model (needs a 22 GB card or more); stay on Ollama` };
}

/** The concrete profile an instance installs with: --vllm-profile, with auto resolved from its GPUs. */
export function instanceVllmProfile(profile: string | undefined, gpus: ReadonlyArray<{ vendor: string; vramGb: number }>): { profile?: string; reason?: string } {
  if (profile !== VLLM_PROFILE_AUTO) return { profile };
  return autoVllmProfile(gpus);
}

/** A value kept from an old env file: dropped unless it passes the same check as the flag. */
function keep<T>(v: string | undefined, check: (v: string) => T): T | undefined {
  if (v === undefined || v === "") return undefined;
  try {
    return check(v);
  } catch {
    return undefined;
  }
}
/** Free-form values (API key, aliases): single line, none of the characters an env file interprets. */
const plain = (v: string) => {
  if (/[\r\n\0"'\\$`]/.test(v) || v.length > 4000) throw new Error("unsafe");
  return v;
};
const port = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("bad port");
  return n;
};

/** The engine an existing instance runs, or undefined when it has never been installed. */
export function previousEngine(prev: PreviousEngineState): EngineKind | undefined {
  const declared = keep(parseEnvFile(prev.agentEnv ?? "").EDGECODER_ENGINE, checkEngine);
  if (declared) return declared;
  // The marker without the env lines: an earlier installer run dropped them (the bug this fixes).
  if (prev.markerExists) return "vllm";
  return prev.agentEnv !== undefined ? "ollama" : undefined;
}

/**
 * Instance n's engine for this run: --engine (and the --vllm-* flags), else what it runs now,
 * else Ollama. Settings not given as flags come from the old env file, then vllm-<n>.env, then
 * the profile.
 */
export function resolveInstanceEngine(index: number, flags: EngineFlags, prev: PreviousEngineState = { markerExists: false }): InstanceEngine {
  const previous = previousEngine(prev);
  const kind = flags.engine ?? previous ?? "ollama";
  const old = parseEnvFile(prev.agentEnv ?? "");
  const env: Record<string, string> = {};
  const fromOld = previous === kind;
  if (kind === "vllm") {
    const served = parseEnvFile(prev.vllmEnv ?? "");
    const profile = flags.vllmProfile ? VLLM_PROFILES[flags.vllmProfile] : undefined;
    const servedPort = keep(served.VLLM_PORT, port);
    const url = flags.vllmUrl ?? (fromOld ? keep(old.VLLM_URL, checkVllmUrl) : undefined) ?? `http://127.0.0.1:${servedPort ?? VLLM_BASE_PORT + index}`;
    const model = flags.vllmModel ?? (fromOld ? keep(old.VLLM_MODEL, checkVllmModel) : undefined) ?? keep(served.VLLM_MODEL_ID, checkVllmModel) ?? profile?.model;
    const slots = flags.vllmSlots ?? (fromOld ? keep(old.VLLM_MAX_SLOTS, checkVllmSlots) : undefined) ?? profile?.slots;
    const apiKey = fromOld ? keep(old.VLLM_API_KEY, plain) : undefined;
    env.VLLM_URL = url;
    if (model) env.VLLM_MODEL = model;
    if (slots !== undefined) env.VLLM_MAX_SLOTS = String(slots);
    if (apiKey) env.VLLM_API_KEY = apiKey;
  } else if (kind === "mlx" && fromOld) {
    const url = keep(old.MLX_URL, checkVllmUrl);
    const model = keep(old.MLX_MODEL, checkVllmModel);
    const slots = keep(old.MLX_MAX_SLOTS, checkVllmSlots);
    if (url) env.MLX_URL = url;
    if (model) env.MLX_MODEL = model;
    if (slots !== undefined) env.MLX_MAX_SLOTS = String(slots);
  }
  if (kind !== "ollama" && fromOld) {
    const aliases = keep(old.ENGINE_MODEL_ALIASES, plain);
    if (aliases) env.ENGINE_MODEL_ALIASES = aliases;
  }
  return { kind, env, ...(previous ? { previous } : {}) };
}

/** The agent env lines for the engine (none for Ollama: it is the default). */
export function engineEnvLines(e: InstanceEngine | undefined): Record<string, string> {
  if (!e || e.kind === "ollama") return {};
  return { EDGECODER_ENGINE: e.kind, ...e.env };
}

/** --engine on a platform that cannot run it. */
export function engineProblems(engine: EngineKind | undefined, platform: NodeJS.Platform): string[] {
  if (engine === "vllm" && platform !== "linux") return ["--engine vllm runs on Linux with NVIDIA GPUs only (docs/inference-engines.md)"];
  if (engine === "mlx" && platform !== "darwin") return ["--engine mlx runs on Apple silicon Macs only (docs/inference-engines.md)"];
  return [];
}

// ───────────────────────────── Linux files ─────────────────────────────
export const VLLM_PREFIX = "/opt/edgecoder/vllm";
export const VLLM_UNIT_PATH = "/etc/systemd/system/edgecoder-vllm@.service";

export function vllmMarkerPath(configDir: string, index: number): string {
  return `${configDir}/vllm-${index}.active`;
}
/** The marker the first hand-made switch on the Chicago VM used for instance 0; migrated to vllm-0.active. */
export function legacyVllmMarkerPath(configDir: string): string {
  return `${configDir}/vllm-active`;
}
export function vllmEnvPath(configDir: string, index: number): string {
  return `${configDir}/vllm-${index}.env`;
}
export function ollamaDropInDir(index: number): string {
  return `/etc/systemd/system/edgecoder-ollama-${index}.service.d`;
}
export function vllmDropInPath(index: number): string {
  return `${ollamaDropInDir(index)}/vllm-switch.conf`;
}

export function vllmDropIn(marker: string): string {
  return `# Written by edgecoder-install (--engine vllm). vLLM serves this instance's GPUs while
# ${marker} exists; \`edgecoder-install apply --engine ollama\` removes both.
[Unit]
ConditionPathExists=!${marker}
`;
}

export function vllmMarker(index: number): string {
  return `# edgecoder-install: instance ${index} runs its model on vLLM (edgecoder-vllm@${index}); its Ollama stays off.\n`;
}

/** What install-vllm.sh needs to have run for instance n before its unit can start. */
export function vllmInstalledPaths(configDir: string, index: number): string[] {
  return [`${VLLM_PREFIX}/venv/bin/vllm`, vllmEnvPath(configDir, index), VLLM_UNIT_PATH];
}
