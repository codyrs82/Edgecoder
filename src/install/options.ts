// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The one option table every installer shares. The macOS .pkg, the Linux .deb, the Windows MSI
 * and the curl/PowerShell bootstraps all end in `edgecoder-install apply ...` with these flags,
 * so a feature added here reaches every platform at once (tests/install/parity.test.ts checks
 * that the platform entry points and docs/install.md stay in step).
 */

import { checkEngine, checkVllmModel, checkVllmProfile, checkVllmSlots, checkVllmUrl, vllmProfileChoices, type EngineKind, type InstanceEngine } from "./engine.js";

export interface InstallOptions {
  command: "detect" | "plan" | "apply" | "status" | "remove" | "update" | "help";
  coordinatorUrl: string;
  portalUrl: string;
  meshToken?: string;
  /** agentId -> registration token; "*" applies to every instance. */
  tokens: Record<string, string>;
  tokensFile?: string;
  /** Portal API key (eck_...) or session token: self-enrol every instance that has no --token and apply the returned registration token. */
  enrollToken?: string;
  model?: string;
  /** Tuning: the context window every network call is served with (AGENT_CONTEXT_WINDOW). */
  contextWindow?: number;
  /** Tuning: parallel model calls per instance (AGENT_PARALLEL_INFERENCE and Ollama's OLLAMA_NUM_PARALLEL). */
  parallel?: number;
  /** Tuning: how long Ollama keeps the model loaded (AGENT_MODEL_KEEP_ALIVE and OLLAMA_KEEP_ALIVE). */
  keepAlive?: string;
  /**
   * --ollama-env KEY=VALUE (repeatable): extra environment for every instance's Ollama server
   * (e.g. OLLAMA_VULKAN=1 for AMD cards ROCm does not support). Recorded in EDGECODER_INSTALL_ARGS
   * and kept by every later run (an update, a package upgrade) until changed; KEY= removes one.
   */
  ollamaEnv?: Record<string, string>;
  /** Engine for every instance (engine.ts). Unset: each instance keeps the engine it runs now (Ollama on a first install). */
  engine?: EngineKind;
  /** vLLM: the served Hugging Face id (VLLM_MODEL), model calls at once (VLLM_MAX_SLOTS), the server URL (VLLM_URL). */
  vllmModel?: string;
  vllmSlots?: number;
  vllmUrl?: string;
  /** vLLM: install-vllm.sh profile used when vLLM is not installed for an instance yet. */
  vllmProfile?: string;
  /** Resolved per instance index by the CLI (flags, then what each instance runs now); planInstall reads it. */
  instanceEngines?: Record<number, InstanceEngine>;
  perGpu: boolean;
  /** GPU layout: per-gpu (one model per card), mixed (half per card, half in pairs), single (all cards pooled). Default: mixed on 4+ cards of 40 GB+, else per-gpu. */
  layout?: "per-gpu" | "mixed" | "single";
  /** Pool this many GPUs per instance (overrides layout), for models bigger than one card. */
  gpusPerInstance?: number;
  instances?: number;
  sandbox: "auto" | "docker" | "none";
  agentIdPrefix?: string;
  /**
   * The node id of a one-agent install, set by the CLI (not a flag) from the registration token's
   * enrolment (cli.ts resolveTokenNodeId) or the previous install's env file, so the agent's id is
   * exactly the enrolled name. Ignored when the host runs several instances.
   */
  agentIdOverride?: string;
  /** Each instance's Ollama port, set by the CLI around ports other programs hold (ports.ts); unset: 11434 + index. */
  ollamaPorts?: Record<number, number>;
  pullModels: boolean;
  dryRun: boolean;
  json: boolean;
  fromPackage: boolean;
  configDir?: string;
  appDir?: string;
  nodeBin?: string;
  ollamaBin?: string;
  /** apply: --auto-update on|off (auto-update.env); unset keeps the host's setting (default on). */
  autoUpdate?: boolean;
  /** apply: --searxng on|off / --no-searxng (searxng.env); unset keeps the host's setting (default on, Linux). */
  searxng?: boolean;
  /**
   * --keep-config (what `update` runs): a re-run that keeps the host's configuration from its env
   * files: coordinator and portal URLs, mesh token, the recorded plan flags (EDGECODER_INSTALL_ARGS),
   * and each instance's model and MAX_CONCURRENT_TASKS. Flags given now still win.
   */
  keepConfig?: boolean;
  /** update: report only. */
  check?: boolean;
  /** update: the timer's run (honours the opt-out, skips a tag that failed here before). */
  scheduled?: boolean;
  /** update: sleep up to N seconds first (launchd has no randomized delay). */
  jitterSec?: number;
  /** Set by the CLI under --keep-config: per instance index, the model and env lines to keep. */
  instanceModels?: Record<number, string>;
  keepEnv?: Record<number, Record<string, string>>;
  /** The flags (and EDGECODER_* variables, as their flag) given on this run. */
  given?: string[];
}

export interface OptionSpec {
  flag: string;
  arg?: string;
  description: string;
}

export const DEFAULT_COORDINATOR_URL = "https://coordinator.edgecoder.io";
export const DEFAULT_PORTAL_URL = "https://edgecoder.io";

export const INSTALL_COMMANDS: Array<{ name: InstallOptions["command"]; description: string }> = [
  { name: "detect", description: "Print the detected CPU, RAM and GPUs." },
  { name: "plan", description: "Show the agent instances, models and services that apply would create." },
  { name: "apply", description: "Write env files and services for every instance, enable and start them." },
  { name: "status", description: "Show the state of every EdgeCoder service on this host." },
  { name: "remove", description: "Stop and remove the EdgeCoder services and env files (keeps models)." },
  { name: "update", description: "Update to the newest signed agent release (Linux, macOS): verify, wait for idle agents, swap, re-apply, health-check, roll back on failure." },
  { name: "help", description: "Show this help." }
];

export const INSTALL_OPTIONS: OptionSpec[] = [
  { flag: "--coordinator-url", arg: "URL", description: `Coordinator to join (default ${DEFAULT_COORDINATOR_URL}).` },
  { flag: "--portal-url", arg: "URL", description: `Portal for node enrolment and discovery (default ${DEFAULT_PORTAL_URL}).` },
  { flag: "--mesh-token", arg: "TOKEN", description: "Mesh auth token for the coordinator (MESH_AUTH_TOKEN)." },
  { flag: "--token", arg: "[AGENT_ID=]TOKEN", description: "Registration token from the portal Nodes page; repeatable. A one-agent host names its agent after the node id the token was issued for; several agents need one AGENT_ID=TOKEN each." },
  { flag: "--tokens-file", arg: "PATH", description: "File of AGENT_ID=TOKEN lines (one per instance)." },
  { flag: "--enroll", arg: "API_KEY", description: "Portal API key (eck_..., Settings → API keys; or a portal session token; or set EDGECODER_API_KEY): self-enrol each un-tokened instance with the portal and apply the registration token it returns." },
  { flag: "--model", arg: "TAG", description: "Ollama model for every instance (default: the strongest that fits each instance's VRAM: 30B coder per 48 GB card, qwen3-coder-next on 80 GB+, qwen3:235b on 160 GB+, qwen3-coder:480b on 320 GB+)." },
  { flag: "--context-window", arg: "N", description: "Context window (tokens, 2048-131072) every network call is served with (AGENT_CONTEXT_WINDOW). Default: sized by the model and the GPU's free VRAM (RAM without a discrete GPU)." },
  { flag: "--parallel", arg: "N", description: "Parallel model calls per instance, 1-16 (AGENT_PARALLEL_INFERENCE and the instance's OLLAMA_NUM_PARALLEL). Default: sized by VRAM and model." },
  { flag: "--keep-alive", arg: "DUR", description: "How long Ollama keeps the model loaded after a call: a duration (30m, 1h30m), seconds, or -1 for always (AGENT_MODEL_KEEP_ALIVE and OLLAMA_KEEP_ALIVE). Default 30m." },
  { flag: "--ollama-env", arg: "KEY=VALUE", description: "Extra environment for every instance's Ollama server, repeatable (e.g. --ollama-env OLLAMA_VULKAN=1 --ollama-env GGML_VK_VISIBLE_DEVICES=0,1 for AMD cards ROCm does not support). Kept by later runs and updates; KEY= removes one. Settings in a systemd drop-in (/etc/systemd/system/edgecoder-ollama-<n>.service.d/*.conf) also survive updates and win over these." },
  { flag: "--engine", arg: "ollama|vllm|mlx", description: "Engine that serves each instance's model (docs/inference-engines.md). vllm: Linux NVIDIA hosts, edgecoder-vllm@<n> serves the model and the instance's Ollama stays off. mlx: Apple silicon, you run mlx_lm.server. Default: each instance keeps the engine it runs now (Ollama on a first install), so re-runs and upgrades never switch engines." },
  { flag: "--vllm-model", arg: "ORG/REPO", description: "vLLM: the Hugging Face model id vLLM serves (VLLM_MODEL). Implies --engine vllm. Default: the one already set, else vllm-<n>.env's VLLM_MODEL_ID." },
  { flag: "--vllm-slots", arg: "N", description: "vLLM: model calls at once, 1-16 (VLLM_MAX_SLOTS). Implies --engine vllm. Default: the one already set, else derived from vLLM's KV cache." },
  { flag: "--vllm-url", arg: "URL", description: "vLLM: the server URL (VLLM_URL). Implies --engine vllm. Default http://127.0.0.1:<8000+n>." },
  { flag: "--vllm-profile", arg: `${vllmProfileChoices().join("|")}`, description: "vLLM: when vLLM is not installed for an instance yet, run scripts/linux/vllm/install-vllm.sh with this profile (model, serve flags, slots) and download the weights. auto picks the profile from each instance's GPUs (nvidia-smi). Implies --engine vllm." },
  { flag: "--layout", arg: "per-gpu|mixed|single", description: "How GPUs are used. per-gpu: one model per card (most parallel work). mixed: half the cards one per card, the rest in pairs for a bigger model (default on 4+ cards of 40 GB+). single: every card pooled for the biggest model." },
  { flag: "--gpus-per-instance", arg: "N", description: "Pool N GPUs per instance (overrides --layout), e.g. 2 for qwen3-coder-next on 48 GB cards, 8 for qwen3-coder:480b." },
  { flag: "--per-gpu", description: "Same as --layout per-gpu." },
  { flag: "--single", description: "Same as --layout single: one agent with every GPU pooled." },
  { flag: "--instances", arg: "N", description: "Exact number of agent instances to run (overrides --per-gpu/--single)." },
  { flag: "--sandbox", arg: "auto|docker|none", description: "Swarm task sandbox. auto uses Docker when present (default)." },
  { flag: "--agent-id-prefix", arg: "NAME", description: "Node id prefix (default: this hostname); ids are <prefix>-gpu<N> or <prefix>-cpu." },
  { flag: "--pull-models", description: "Pull each instance's model after the services start." },
  { flag: "--dry-run", description: "Print what would be written and run; change nothing." },
  { flag: "--json", description: "Machine-readable output." },
  { flag: "--from-package", description: "Non-interactive mode used by the .pkg/.deb/.msi post-install hooks." },
  { flag: "--config-dir", arg: "DIR", description: "Config directory (default /etc/edgecoder, Windows C:\\ProgramData\\EdgeCoder)." },
  { flag: "--app-dir", arg: "DIR", description: "Installed app directory containing dist/ (default: where this installer lives)." },
  { flag: "--node-bin", arg: "PATH", description: "Node binary for the services (default: the one running the installer)." },
  { flag: "--ollama-bin", arg: "PATH", description: "Ollama binary (default: found on PATH or the platform install location)." },
  { flag: "--searxng", arg: "on|off", description: "Free web search for your own chats from this machine: a local SearXNG on 127.0.0.1 (Linux; default on). --no-searxng is --searxng off. Kept in /etc/edgecoder/searxng.env, so later runs and updates keep it." },
  { flag: "--auto-update", arg: "on|off", description: "Scheduled updates to new signed releases (Linux, macOS; default on). Kept in /etc/edgecoder/auto-update.env, so later runs keep it." },
  { flag: "--keep-config", description: "Re-run with this host's configuration from its env files (URLs, mesh token, layout and model flags, models); what update runs." },
  { flag: "--check", description: "update: only report whether a newer release exists." },
  { flag: "--scheduled", description: "update: the timer's run; does nothing when auto-update is off, skips a release that already failed here." },
  { flag: "--jitter", arg: "SECONDS", description: "update: wait a random time up to SECONDS first." }
];

export function defaultOptions(): InstallOptions {
  return {
    command: "help",
    coordinatorUrl: DEFAULT_COORDINATOR_URL,
    portalUrl: DEFAULT_PORTAL_URL,
    tokens: {},
    perGpu: true,
    sandbox: "auto",
    pullModels: false,
    dryRun: false,
    json: false,
    fromPackage: false
  };
}

export function parseInstallArgs(argv: string[], env: NodeJS.ProcessEnv = {}): InstallOptions {
  const o = defaultOptions();
  const given: string[] = [];
  o.given = given;
  if (env.EDGECODER_COORDINATOR_URL) { o.coordinatorUrl = env.EDGECODER_COORDINATOR_URL; given.push("--coordinator-url"); }
  if (env.EDGECODER_PORTAL_URL) { o.portalUrl = env.EDGECODER_PORTAL_URL; given.push("--portal-url"); }
  if (env.EDGECODER_MESH_TOKEN) { o.meshToken = env.EDGECODER_MESH_TOKEN; given.push("--mesh-token"); }
  if (env.EDGECODER_REGISTRATION_TOKEN) o.tokens["*"] = env.EDGECODER_REGISTRATION_TOKEN;
  if (env.EDGECODER_ENROLL_TOKEN) o.enrollToken = env.EDGECODER_ENROLL_TOKEN;
  if (env.EDGECODER_API_KEY) o.enrollToken = env.EDGECODER_API_KEY;
  const args = [...argv];
  const next = (flag: string): string => {
    const v = args.shift();
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  while (args.length) {
    const a = args.shift() as string;
    if (!a.startsWith("--")) {
      const cmd = INSTALL_COMMANDS.find((c) => c.name === a);
      if (!cmd) throw new Error(`unknown command: ${a}`);
      o.command = cmd.name;
      continue;
    }
    const [flag, inline] = a.includes("=") && !a.startsWith("--token=") ? a.split(/=(.*)/s) : [a, undefined];
    const val = () => (inline !== undefined ? inline : next(flag));
    given.push(flag === "--token=" ? "--token" : flag);
    switch (flag) {
      case "--coordinator-url": o.coordinatorUrl = val(); break;
      case "--portal-url": o.portalUrl = val(); break;
      case "--mesh-token": o.meshToken = val(); break;
      case "--token": case "--token=": {
        const raw = a.startsWith("--token=") ? a.slice("--token=".length) : next("--token");
        const eq = raw.indexOf("=");
        if (eq > 0) o.tokens[raw.slice(0, eq)] = raw.slice(eq + 1);
        else o.tokens["*"] = raw;
        break;
      }
      case "--tokens-file": o.tokensFile = val(); break;
      case "--enroll": o.enrollToken = val(); break;
      case "--model": o.model = val(); break;
      case "--context-window": o.contextWindow = checkContextWindow(val()); break;
      case "--parallel": o.parallel = checkParallel(val()); break;
      case "--keep-alive": o.keepAlive = checkKeepAlive(val()); break;
      case "--ollama-env": {
        const [k, v] = checkOllamaEnv(val());
        o.ollamaEnv = { ...(o.ollamaEnv ?? {}), [k]: v };
        break;
      }
      case "--engine": o.engine = checkEngine(val()); break;
      case "--vllm-model": o.vllmModel = checkVllmModel(val()); break;
      case "--vllm-slots": o.vllmSlots = checkVllmSlots(val()); break;
      case "--vllm-url": o.vllmUrl = checkVllmUrl(val()); break;
      case "--vllm-profile": o.vllmProfile = checkVllmProfile(val()); break;
      case "--per-gpu": o.perGpu = true; o.layout = "per-gpu"; break;
      case "--single": o.perGpu = false; o.layout = "single"; break;
      case "--layout": {
        const v = val();
        if (v !== "per-gpu" && v !== "mixed" && v !== "single") throw new Error("--layout must be per-gpu, mixed or single");
        o.layout = v;
        o.perGpu = v !== "single";
        break;
      }
      case "--gpus-per-instance": o.gpusPerInstance = Number(val()); if (!Number.isInteger(o.gpusPerInstance) || o.gpusPerInstance < 1) throw new Error("--gpus-per-instance must be a positive integer"); break;
      case "--instances": o.instances = Number(val()); if (!Number.isInteger(o.instances) || o.instances < 1) throw new Error("--instances must be a positive integer"); break;
      case "--sandbox": { const s = val(); if (s !== "auto" && s !== "docker" && s !== "none") throw new Error("--sandbox must be auto, docker or none"); o.sandbox = s; break; }
      case "--agent-id-prefix": o.agentIdPrefix = val(); break;
      case "--pull-models": o.pullModels = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--json": o.json = true; break;
      case "--from-package": o.fromPackage = true; break;
      case "--config-dir": o.configDir = val(); break;
      case "--app-dir": o.appDir = val(); break;
      case "--node-bin": o.nodeBin = val(); break;
      case "--ollama-bin": o.ollamaBin = val(); break;
      case "--auto-update": { const v = val(); if (v !== "on" && v !== "off") throw new Error("--auto-update must be on or off"); o.autoUpdate = v === "on"; break; }
      case "--searxng": { const v = val(); if (v !== "on" && v !== "off") throw new Error("--searxng must be on or off"); o.searxng = v === "on"; break; }
      case "--no-searxng": o.searxng = false; break;
      case "--keep-config": o.keepConfig = true; break;
      case "--check": o.check = true; break;
      case "--scheduled": o.scheduled = true; break;
      case "--jitter": { const n = Number(val()); if (!Number.isInteger(n) || n < 0 || n > 86_400) throw new Error("--jitter must be 0 to 86400 seconds"); o.jitterSec = n; break; }
      case "--help": case "-h": o.command = "help"; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  const vllmFlags = o.vllmModel !== undefined || o.vllmSlots !== undefined || o.vllmUrl !== undefined || o.vllmProfile !== undefined;
  if (vllmFlags) {
    if (o.engine && o.engine !== "vllm") throw new Error(`--vllm-model, --vllm-slots, --vllm-url and --vllm-profile go with --engine vllm, not --engine ${o.engine}`);
    o.engine = "vllm";
  }
  return o;
}

export const CONTEXT_WINDOW_RANGE = [2048, 131_072] as const;
export const PARALLEL_RANGE = [1, 16] as const;
/** Ollama keep_alive: -1 (never unload), whole seconds, or a Go duration such as 30m or 1h30m. */
const KEEP_ALIVE_PATTERN = /^(-1|\d{1,7}|(\d{1,5}(\.\d{1,3})?(ms|s|m|h)){1,4})$/;

function checkContextWindow(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < CONTEXT_WINDOW_RANGE[0] || n > CONTEXT_WINDOW_RANGE[1]) throw new Error(`--context-window must be a whole number of tokens from ${CONTEXT_WINDOW_RANGE[0]} to ${CONTEXT_WINDOW_RANGE[1]}`);
  return n;
}
function checkParallel(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < PARALLEL_RANGE[0] || n > PARALLEL_RANGE[1]) throw new Error(`--parallel must be a whole number from ${PARALLEL_RANGE[0]} to ${PARALLEL_RANGE[1]}`);
  return n;
}
function checkKeepAlive(v: string): string {
  if (!KEEP_ALIVE_PATTERN.test(v)) throw new Error("--keep-alive must be -1, a number of seconds or a duration such as 30m or 1h30m");
  return v;
}

/** Variables the installer sets itself for each Ollama: changing them would break the instance. */
const OLLAMA_ENV_RESERVED = new Set(["OLLAMA_HOST", "OLLAMA_MODELS", "HOME", "PATH", "LD_PRELOAD"]);
const OLLAMA_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Values that are safe in a systemd Environment= line, a launchd plist and a Windows .cmd wrapper. */
const OLLAMA_ENV_VALUE = /^[A-Za-z0-9._:/,=+@-]{0,256}$/;

/** "KEY=VALUE" -> [KEY, VALUE]; an empty VALUE means "remove". Throws on anything unsafe. */
export function checkOllamaEnv(raw: string): [string, string] {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new Error("--ollama-env must be KEY=VALUE");
  const k = raw.slice(0, eq);
  const v = raw.slice(eq + 1);
  if (!OLLAMA_ENV_KEY.test(k)) throw new Error(`--ollama-env: invalid variable name ${JSON.stringify(k)}`);
  if (OLLAMA_ENV_RESERVED.has(k.toUpperCase())) throw new Error(`--ollama-env: ${k} is set by the installer for each instance and cannot be overridden`);
  if (!OLLAMA_ENV_VALUE.test(v)) throw new Error(`--ollama-env: ${k} may only contain letters, digits and . _ : / , = + @ - (up to 256)`);
  return [k, v];
}

/** The set without removals (empty values). */
export function effectiveOllamaEnv(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([, v]) => v !== ""));
}

export type InstallTuning = Pick<InstallOptions, "contextWindow" | "parallel" | "keepAlive">;

/** The env-file line that records which tuning flags set the values, so a later run can keep them. */
export const TUNING_ENV_KEY = "EDGECODER_INSTALL_TUNING";

/** "context-window:32768,parallel:8,keep-alive:-1" for the flags given; undefined when none was. */
export function renderTuning(t: InstallTuning): string | undefined {
  const parts: string[] = [];
  if (t.contextWindow !== undefined) parts.push(`context-window:${t.contextWindow}`);
  if (t.parallel !== undefined) parts.push(`parallel:${t.parallel}`);
  if (t.keepAlive !== undefined) parts.push(`keep-alive:${t.keepAlive}`);
  return parts.length ? parts.join(",") : undefined;
}

/**
 * The tuning flags a previous run wrote into an instance's env file (EDGECODER_INSTALL_TUNING).
 * Values that do not pass the flags' own checks are dropped, so a tampered file adds nothing.
 */
export function tuningFromEnvFile(text: string): InstallTuning {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${TUNING_ENV_KEY}=`));
  const out: InstallTuning = {};
  if (!line) return out;
  for (const part of line.slice(TUNING_ENV_KEY.length + 1).split(",")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const [k, v] = [part.slice(0, i), part.slice(i + 1)];
    try {
      if (k === "context-window") out.contextWindow = checkContextWindow(v);
      else if (k === "parallel") out.parallel = checkParallel(v);
      else if (k === "keep-alive") out.keepAlive = checkKeepAlive(v);
    } catch { /* ignore an invalid value */ }
  }
  return out;
}

/**
 * Options for a re-run (a package upgrade runs `apply --from-package` with no tuning flags): every
 * tuning flag not given now takes the value the previous run recorded in `previousEnvFile`.
 */
export function inheritTuning(o: InstallOptions, previousEnvFile: string | undefined): InstallOptions {
  if (!previousEnvFile) return { ...o, ...(o.ollamaEnv ? { ollamaEnv: effectiveOllamaEnv(o.ollamaEnv) } : {}) };
  const prev = tuningFromEnvFile(previousEnvFile);
  // --ollama-env is kept by every re-run (not only --keep-config): losing OLLAMA_VULKAN=1 on a
  // package upgrade would put an AMD host back on its CPU. Given now: merged over the recorded
  // set, an empty value removing that key.
  const recorded = installArgsFromEnvFile(previousEnvFile).ollamaEnv;
  const merged = effectiveOllamaEnv({ ...(recorded ?? {}), ...(o.ollamaEnv ?? {}) });
  return {
    ...o,
    contextWindow: o.contextWindow ?? prev.contextWindow,
    parallel: o.parallel ?? prev.parallel,
    keepAlive: o.keepAlive ?? prev.keepAlive,
    ...(Object.keys(merged).length ? { ollamaEnv: merged } : { ollamaEnv: undefined })
  };
}

/**
 * The plan-shaping flags of a run, recorded in each env file (EDGECODER_INSTALL_ARGS) so an
 * `update` (apply --keep-config) plans the same agents: model, layout, pooling, instance count,
 * sandbox, id prefix and the Ollama binary.
 */
export const INSTALL_ARGS_ENV_KEY = "EDGECODER_INSTALL_ARGS";

export type RecordedArgs = Partial<Pick<InstallOptions, "model" | "layout" | "gpusPerInstance" | "instances" | "sandbox" | "agentIdPrefix" | "ollamaBin" | "ollamaEnv">>;

const RECORD_VALUE = /^[A-Za-z0-9._:/@+-]{1,256}$/;

/** "model:qwen3-coder:30b,layout:mixed" for the flags given on this run; undefined when none was. */
export function renderInstallArgs(o: InstallOptions): string | undefined {
  const given = new Set(o.given ?? []);
  const parts: string[] = [];
  const add = (k: string, v: string | number | undefined) => {
    if (v === undefined || !RECORD_VALUE.test(String(v))) return;
    parts.push(`${k}:${v}`);
  };
  if (o.model !== undefined) add("model", o.model);
  if (o.layout !== undefined) add("layout", o.layout);
  if (o.gpusPerInstance !== undefined) add("gpus-per-instance", o.gpusPerInstance);
  if (o.instances !== undefined) add("instances", o.instances);
  if (o.sandbox !== "auto" && (given.has("--sandbox") || o.keepConfig)) add("sandbox", o.sandbox);
  if (o.agentIdPrefix !== undefined) add("agent-id-prefix", o.agentIdPrefix);
  if (o.ollamaBin !== undefined) add("ollama-bin", o.ollamaBin);
  // ollama-env:KEY=<value, percent-encoded> (a value may hold commas: GGML_VK_VISIBLE_DEVICES=1,2,3,4).
  for (const [k, v] of Object.entries(effectiveOllamaEnv(o.ollamaEnv))) parts.push(`ollama-env:${k}=${encodeURIComponent(v)}`);
  return parts.length ? parts.join(",") : undefined;
}

/** The recorded flags, each through its flag's own check (a tampered value is dropped). */
export function installArgsFromEnvFile(text: string): RecordedArgs {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${INSTALL_ARGS_ENV_KEY}=`));
  const out: RecordedArgs = {};
  if (!line) return out;
  for (const part of line.slice(INSTALL_ARGS_ENV_KEY.length + 1).split(",")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const [k, v] = [part.slice(0, i), part.slice(i + 1)];
    if (k === "ollama-env") {
      try {
        const eq = v.indexOf("=");
        const [ek, ev] = checkOllamaEnv(eq > 0 ? `${v.slice(0, eq)}=${decodeURIComponent(v.slice(eq + 1))}` : v);
        if (ev !== "") out.ollamaEnv = { ...(out.ollamaEnv ?? {}), [ek]: ev };
      } catch { /* a tampered or malformed entry is dropped */ }
      continue;
    }
    if (!RECORD_VALUE.test(v)) continue;
    const n = Number(v);
    if (k === "model") out.model = v;
    else if (k === "layout" && (v === "per-gpu" || v === "mixed" || v === "single")) out.layout = v;
    else if (k === "gpus-per-instance" && Number.isInteger(n) && n >= 1) out.gpusPerInstance = n;
    else if (k === "instances" && Number.isInteger(n) && n >= 1) out.instances = n;
    else if (k === "sandbox" && (v === "docker" || v === "none")) out.sandbox = v;
    else if (k === "agent-id-prefix") out.agentIdPrefix = v;
    else if (k === "ollama-bin" && v.startsWith("/")) out.ollamaBin = v;
  }
  return out;
}

/**
 * --keep-config: the previous run's configuration from the first instance's env file, for every
 * setting not given on this run: coordinator / portal URL, mesh token and the recorded flags.
 */
export function inheritConfig(o: InstallOptions, previousEnvFile: string | undefined): InstallOptions {
  if (!o.keepConfig || !previousEnvFile) return o;
  const given = new Set(o.given ?? []);
  const env: Record<string, string> = {};
  for (const l of previousEnvFile.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (m) env[m[1]] = m[2];
  }
  const rec = installArgsFromEnvFile(previousEnvFile);
  const out: InstallOptions = { ...o };
  if (!given.has("--coordinator-url") && env.COORDINATOR_URL && !checkServiceUrl("COORDINATOR_URL", env.COORDINATOR_URL)) out.coordinatorUrl = env.COORDINATOR_URL;
  if (!given.has("--portal-url") && env.PORTAL_URL && !checkServiceUrl("PORTAL_URL", env.PORTAL_URL)) out.portalUrl = env.PORTAL_URL;
  if (!given.has("--mesh-token") && env.MESH_AUTH_TOKEN && TOKEN_PATTERN.test(env.MESH_AUTH_TOKEN)) out.meshToken = env.MESH_AUTH_TOKEN;
  const layoutGiven = ["--layout", "--per-gpu", "--single", "--gpus-per-instance", "--instances"].some((f) => given.has(f));
  if (!given.has("--model") && rec.model) out.model = rec.model;
  if (!layoutGiven) {
    if (rec.layout) { out.layout = rec.layout; out.perGpu = rec.layout !== "single"; }
    if (rec.gpusPerInstance) out.gpusPerInstance = rec.gpusPerInstance;
    if (rec.instances) out.instances = rec.instances;
  }
  if (!given.has("--sandbox") && rec.sandbox) out.sandbox = rec.sandbox;
  if (!given.has("--agent-id-prefix") && rec.agentIdPrefix) out.agentIdPrefix = rec.agentIdPrefix;
  if (!given.has("--ollama-bin") && rec.ollamaBin) out.ollamaBin = rec.ollamaBin;
  return out;
}

export function parseTokensFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Registration and mesh tokens end up in a systemd EnvironmentFile and a Windows .cmd wrapper, so
 * they are limited to URL-safe and base64 characters (what the portal and coordinator issue).
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
const TOKEN_CHARS = "A-Z a-z 0-9 . _ ~ + / = -";

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** https, or http to this machine only: the enrol API key and the tokens travel over it. */
export function checkServiceUrl(name: string, value: string): string | undefined {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return `${name} is not a valid URL: ${JSON.stringify(value)}`;
  }
  if (/[\s"'%$`\\]/.test(value)) return `${name} contains characters not allowed in a service URL`;
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return undefined;
  return `${name} must use https (http is accepted only for localhost): ${value}`;
}

/** Problems with the URLs and tokens that are written into the service env files; empty when all are safe. */
export function validateInstallOptions(o: InstallOptions): string[] {
  const errors: string[] = [];
  for (const [name, url] of [["--coordinator-url", o.coordinatorUrl], ["--portal-url", o.portalUrl]] as const) {
    const err = checkServiceUrl(name, url);
    if (err) errors.push(err);
  }
  if (o.meshToken !== undefined && !TOKEN_PATTERN.test(o.meshToken)) errors.push(`--mesh-token may only contain ${TOKEN_CHARS}`);
  for (const [id, tok] of Object.entries(o.tokens)) {
    if (!TOKEN_PATTERN.test(tok)) errors.push(`registration token${id === "*" ? "" : ` for ${id}`} may only contain ${TOKEN_CHARS}`);
  }
  return errors;
}

export function helpText(): string {
  const lines = ["edgecoder-install <command> [options]", "", "Commands:"];
  for (const c of INSTALL_COMMANDS) lines.push(`  ${c.name.padEnd(10)} ${c.description}`);
  lines.push("", "Options (identical on macOS, Linux and Windows):");
  for (const o of INSTALL_OPTIONS) lines.push(`  ${(o.flag + (o.arg ? " " + o.arg : "")).padEnd(34)} ${o.description}`);
  lines.push("", "Updates (Linux, macOS release installs): a timer runs `update --scheduled` every 6 hours; `sudo edgecoder-install update` updates now; `apply --auto-update off` turns the timer off.");
  lines.push("", "Environment: EDGECODER_COORDINATOR_URL, EDGECODER_PORTAL_URL, EDGECODER_MESH_TOKEN, EDGECODER_REGISTRATION_TOKEN, EDGECODER_ENROLL_TOKEN, EDGECODER_API_KEY (same as --enroll, kept out of shell history) set the defaults.");
  return lines.join("\n");
}
