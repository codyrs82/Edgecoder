// Copyright (c) 2025 EdgeCoder, LLC
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

/** install-vllm.sh profiles: the model and slots each one serves (the script holds the serve flags). */
export const VLLM_PROFILES: Record<string, { model: string; slots: number }> = {
  a16x2: { model: "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", slots: 2 },
  "a100-80": { model: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8", slots: 12 }
};

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
  if (!Object.prototype.hasOwnProperty.call(VLLM_PROFILES, v)) throw new Error(`--vllm-profile must be one of ${Object.keys(VLLM_PROFILES).join(", ")}`);
  return v;
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
