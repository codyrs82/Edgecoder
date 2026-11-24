// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * edgecoder-install: the one installer behind the macOS .pkg, Linux .deb, Windows MSI and the
 * curl/PowerShell bootstraps (docs/install.md). Detects the hardware, plans one agent per GPU
 * (or one per host), writes env files and services, starts them.
 */
import { randomBytes } from "node:crypto";
import { applySearxng, removeSearxng, searxngAgentEnv, searxngWanted } from "./searxng.js";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectHardware, vulkanHint, type HostHardware, type Probe } from "./hardware.js";
import { helpText, inheritConfig, inheritTuning, parseInstallArgs, parseTokensFile, TOKEN_PATTERN, validateInstallOptions, type InstallOptions } from "./options.js";
import { planInstall, type AgentInstance, type InstallPlan } from "./plan.js";
import { HOST_AGREEMENT_VERSION } from "../common/legal-notices.js";
import { appDirProblems, planBinary, stageBinary, type BinFs, type StagePlan } from "./binaries.js";
import { engineProblems, instanceVllmProfile, legacyVllmMarkerPath, ollamaDropInDir, parseEnvFile, resolveInstanceEngine, VLLM_PROFILE_AUTO, vllmEnvPath, vllmInstalledPaths, vllmMarkerPath, vllmProfileChoices, type InstanceEngine } from "./engine.js";
import { allocateOllamaPorts, portOwner } from "./ports.js";
import { RELEASE_INFO_FILE, runUpdate, updateStatusLines } from "./update.js";
import { realUpdateDeps } from "./update-host.js";
import { applyUpdateSchedule, removeUpdateSchedule, timerStatus } from "./update-schedule.js";
import { clearOverrideEntries, instanceOverridesPath, type ClearableOverride } from "./overrides-clear.js";
import { applyPlan, defaultPaths, envFilePath, lockConfigDir, removeServices, serviceStatus, windowsDirOwnerProblems, type Host, type ServicePaths } from "./services.js";

export const probe: Probe = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

function dockerAvailable(): boolean {
  return probe("docker", ["info", "--format", "{{.ServerVersion}}"]) !== null;
}

function findOllama(platform: NodeJS.Platform): string | undefined {
  const which = platform === "win32" ? "where" : "which";
  const found = probe(which, ["ollama"])?.split(/\r?\n/)[0]?.trim();
  if (found) return found;
  const candidates = platform === "win32"
    ? [`${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`, `${process.env.ProgramFiles}\\Ollama\\ollama.exe`]
    : ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama"];
  return candidates.find((c) => existsSync(c));
}

/**
 * Replace, never write through: the old file (or a symlink planted in its place) is removed and a
 * new one is created exclusively with its final mode, so a secret never sits at the umask default
 * and on Windows the file inherits the locked directory's ACL.
 */
export function writeFileFresh(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, content, { encoding: "utf8", flag: "wx", ...(mode !== undefined ? { mode } : {}) });
  if (mode !== undefined && process.platform !== "win32") chmodSync(path, mode);
}

/** One cmd.exe argument: quoted unless plain or already quoted (run() goes through cmd on win32). */
export function cmdQuote(arg: string): string {
  if (/[%\r\n]/.test(arg) || /^[^"]*"[^"]*$/.test(arg)) throw new Error(`refusing to pass ${JSON.stringify(arg)} through cmd.exe`);
  if (/^"[^"]*"$/.test(arg) || /^[A-Za-z0-9_.:\\/=+*-]+$/.test(arg)) return arg;
  if (arg.includes('"')) throw new Error(`refusing to pass ${JSON.stringify(arg)} through cmd.exe`);
  return `"${arg}"`;
}

const realHost: Host = {
  platform: process.platform,
  writeFile: writeFileFresh,
  removeFile(path) {
    try { unlinkSync(path); } catch { /* already gone */ }
  },
  run(cmd, args, env) {
    // win32 goes through cmd.exe (icacls/schtasks take pre-quoted args); quote the rest, such as
    // an ollama path under a profile with a space in it.
    const r = process.platform === "win32"
      ? spawnSync(cmdQuote(cmd), args.map(cmdQuote), { encoding: "utf8", shell: true, ...(env ? { env: { ...process.env, ...env } } : {}) })
      : spawnSync(cmd, args, { encoding: "utf8", ...(env ? { env: { ...process.env, ...env } } : {}) });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  exists: (path) => existsSync(path)
};

const realBinFs: BinFs = {
  stat(path) {
    try {
      const st = statSync(path);
      return { uid: st.uid, mode: st.mode, isDirectory: st.isDirectory() };
    } catch {
      return null;
    }
  },
  realpath: (path) => realpathSync(path),
  read(path, offset, length) {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      return buf.subarray(0, readSync(fd, buf, 0, length, offset));
    } finally {
      closeSync(fd);
    }
  },
  copy(src, dest) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, dereference: true });
  },
  secure(path) {
    for (const [cmd, args] of [["chown", ["-R", "0:0", path]], ["chmod", ["-R", "go-w", path]]] as const) {
      const r = spawnSync(cmd, [...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
    }
  }
};

/**
 * Linux/macOS: make sure the services run root-owned binaries from a root-owned app dir, staging
 * root-owned copies of node/ollama when needed (binaries.ts). Returns the problems that remain.
 */
export function secureBinaries(fs: BinFs, platform: NodeJS.Platform, p: ServicePaths, opts: { dryRun: boolean; ollama: boolean }): { plans: StagePlan[]; problems: string[] } {
  if (platform !== "linux" && platform !== "darwin") return { plans: [], problems: [] };
  const plans: StagePlan[] = [];
  const problems: string[] = [];
  const kinds = [["node", p.nodeBin], ...(opts.ollama ? [["ollama", p.ollamaBin]] : [])] as Array<["node" | "ollama", string]>;
  for (const [kind, src] of kinds) {
    const plan = planBinary(fs, platform, kind, src, p.stageDir);
    plans.push(plan);
    if (!opts.dryRun) problems.push(...stageBinary(fs, platform, plan, p.stageDir));
    if (kind === "node") p.nodeBin = plan.path;
    else p.ollamaBin = plan.path;
  }
  if (!opts.dryRun) problems.push(...appDirProblems(fs, p.appDir));
  return { plans, problems };
}

/**
 * The one HTTP call the installer makes: POST a node to the portal's /nodes/enroll. Injected so
 * tests can run the enroll path without a network; the default uses the global fetch (undici).
 */
export type HttpPost = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;

const fetchPost: HttpPost = async (url, init) => {
  const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body });
  return { status: res.status, json: () => res.json() };
};

export interface EnrollResult {
  enrolled: string[];
  failed: string[];
}

/**
 * Self-register each instance with the portal using the user's portal API key (or session token) and apply the
 * returned registration token to opts.tokens, so the normal plan/env wiring (plan.ts sets
 * AGENT_REGISTRATION_TOKEN from opts.tokens) picks it up. A node that already has a token
 * (explicit or via the "*" catch-all) is left alone. Per-node failures warn and continue.
 */
export async function enrollNodes(opts: InstallOptions, instances: AgentInstance[], post: HttpPost = fetchPost): Promise<EnrollResult> {
  const base = opts.portalUrl.replace(/\/+$/, "");
  const url = `${base}/nodes/enroll`;
  const enrolled: string[] = [];
  const failed: string[] = [];
  for (const inst of instances) {
    if (opts.tokens[inst.agentId] || opts.tokens["*"]) continue;
    try {
      const res = await post(url, {
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.enrollToken ?? ""}` },
        body: JSON.stringify({ nodeId: inst.agentId, nodeKind: "agent" })
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`portal returned HTTP ${res.status}`);
      const body = (await res.json()) as { registrationToken?: string };
      if (!body.registrationToken) throw new Error("response had no registrationToken");
      // It is written into the service env file and .cmd wrapper: refuse anything but token characters.
      if (typeof body.registrationToken !== "string" || !TOKEN_PATTERN.test(body.registrationToken)) throw new Error("response registrationToken has an invalid format");
      opts.tokens[inst.agentId] = body.registrationToken;
      enrolled.push(inst.agentId);
    } catch (e) {
      console.error(`warning: could not enrol ${inst.agentId} at ${url}: ${(e as Error).message}`);
      failed.push(inst.agentId);
    }
  }
  return { enrolled, failed };
}

/** A GET to the portal (the token's node id); injected so tests run without a network. */
export type HttpGet = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; json: () => Promise<unknown> }>;

const fetchGet: HttpGet = async (url, init) => {
  const res = await fetch(url, { method: "GET", headers: init.headers, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: () => res.json() };
};

/** Node ids the portal accepts (pages/escape.ts NODE_ID_PATTERN); also safe in an env file. */
export const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{3,128}$/;

/**
 * The node id and kind a registration token was issued for (portal GET /nodes/token-node, which
 * only the token's holder can ask), or null when the portal can't say (older portal, offline,
 * unknown token).
 */
export async function lookupTokenNode(portalUrl: string, token: string, get: HttpGet = fetchGet): Promise<{ nodeId: string; nodeKind: string } | null> {
  try {
    const res = await get(`${portalUrl.replace(/\/+$/, "")}/nodes/token-node`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { nodeId?: unknown; nodeKind?: unknown };
    if (typeof body.nodeId !== "string" || !NODE_ID_PATTERN.test(body.nodeId)) return null;
    return { nodeId: body.nodeId, nodeKind: typeof body.nodeKind === "string" ? body.nodeKind : "agent" };
  } catch {
    return null;
  }
}

export interface TokenNodeResolution {
  /** Refuse to go on (apply); plan prints it as a warning. */
  error?: string;
  /** Lines to print: which name the agent gets and why. */
  notes: string[];
}

/**
 * A registration token belongs to one node id, and the coordinator refuses an agent whose id is not
 * that one (node_not_enrolled), so the agent id must be the enrolled name, not the one computed
 * from the hostname. On a one-agent host the agent takes the token's node id: from the portal when
 * it answers, else the AGENT_ID of --token AGENT_ID=TOKEN. Several agents need one token each, so a
 * bare token is refused there. Sets opts.agentIdOverride and opts.tokens[<id>].
 */
export async function resolveTokenNodeId(opts: InstallOptions, plan: InstallPlan, get: HttpGet = fetchGet): Promise<TokenNodeResolution> {
  const notes: string[] = [];
  const keyed = Object.entries(opts.tokens).filter(([id]) => id !== "*");
  if (plan.instances.length > 1) {
    const ids = plan.instances.map((i) => i.agentId);
    if (opts.tokens["*"]) {
      return {
        notes,
        error: `a registration token belongs to one node id, but this host runs ${ids.length} agents (${ids.join(", ")}). Enrol each id on ${opts.portalUrl} → Settings → Nodes and pass --token <id>=<token> for each (or --tokens-file), or install with an install key (EDGECODER_API_KEY=eck_...), which enrols every GPU with the right name.`
      };
    }
    for (const [id] of keyed) if (!ids.includes(id)) notes.push(`warning: the token for "${id}" matches none of this host's agents (${ids.join(", ")}); it is not used.`);
    return { notes };
  }
  const inst = plan.instances[0];
  if (!inst) return { notes };
  const computed = inst.agentId;
  const [fromKey, token] = opts.tokens[computed] !== undefined ? [computed, opts.tokens[computed]]
    : opts.tokens["*"] !== undefined ? ["*", opts.tokens["*"]]
    : keyed.length === 1 ? keyed[0] : [undefined, undefined];
  if (!token) {
    if (keyed.length > 1) notes.push(`warning: none of the ${keyed.length} tokens is for this machine's id "${computed}".`);
    return { notes };
  }
  const found = await lookupTokenNode(opts.portalUrl, token, get);
  if (found && found.nodeKind !== "agent") {
    return { notes, error: `this registration token is for the ${found.nodeKind} node "${found.nodeId}", not an agent. Enrol an Agent node on ${opts.portalUrl} → Settings → Nodes.` };
  }
  let target = found?.nodeId ?? (fromKey && fromKey !== "*" ? fromKey : computed);
  if (!NODE_ID_PATTERN.test(target)) target = computed;
  if (!found) notes.push(`note: could not check with ${opts.portalUrl} which node id this token was issued for; the agent is named "${target}", which must be exactly the enrolled node id.`);
  if (target !== computed) {
    notes.push(`This machine's own id would be "${computed}", but its registration token was issued for "${target}": the agent is named "${target}".`);
    opts.agentIdOverride = target;
  }
  if (fromKey && fromKey !== "*" && fromKey !== target) notes.push(`note: --token ${fromKey}=... was issued for "${target}"; using "${target}".`);
  opts.tokens[target] = token;
  return { notes };
}

/**
 * After apply with an install key or tokens: for each agent, whether the portal has it enrolled
 * under exactly its id with the token written to its env file ("Enrolled as <id> ✓"), or why not.
 */
export async function enrollmentConfirmation(portalUrl: string, instances: AgentInstance[], enrollFailed: string[], get: HttpGet = fetchGet): Promise<string[]> {
  const lines: string[] = [];
  for (const inst of instances) {
    const token = inst.env.AGENT_REGISTRATION_TOKEN;
    if (enrollFailed.includes(inst.agentId)) {
      lines.push(`Not enrolled: ${inst.agentId} (enrolment with the install key failed; see the warning above)`);
      continue;
    }
    if (!token) {
      lines.push(`Not enrolled: ${inst.agentId} (no registration token)`);
      continue;
    }
    const found = await lookupTokenNode(portalUrl, token, get);
    if (!found) lines.push(`Not confirmed: ${inst.agentId} (${portalUrl} did not recognise its registration token, or could not be reached; the agent's log says whether it registers)`);
    else if (found.nodeId !== inst.agentId) lines.push(`Not enrolled: ${inst.agentId} (its token is for "${found.nodeId}"; re-run with --token ${inst.agentId}=<token for ${inst.agentId}>)`);
    else lines.push(`Enrolled as ${inst.agentId} ✓`);
  }
  return lines;
}

/**
 * A re-run with no token and no install key (an update with install.sh, a package upgrade) on a
 * one-agent host keeps the node id the previous install used (agent-0.env), with its token: the
 * agent may have been named after its token's enrolment rather than the hostname. Returns that id.
 */
export function keepEnrolledAgentId(opts: InstallOptions, plan: InstallPlan, p: ServicePaths, read: (path: string) => string | undefined = readIfPresent): string | undefined {
  if (plan.instances.length !== 1 || Object.keys(opts.tokens).length > 0 || opts.enrollToken) return undefined;
  const inst = plan.instances[0];
  const old = parseEnvFile(read(envFilePath(p, inst)) ?? "");
  const id = old.AGENT_ID;
  const token = old.AGENT_REGISTRATION_TOKEN;
  if (!id || id === inst.agentId || !NODE_ID_PATTERN.test(id) || !token || !TOKEN_PATTERN.test(token)) return undefined;
  opts.agentIdOverride = id;
  return id;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Pull each distinct model once (the model store is shared by every instance), through the Ollama
 * server of the first instance that runs it (OLLAMA_HOST: its port may not be 11434, ports.ts). It
 * was just (re)started, so a pull is retried until that server is listening. Returns the models
 * that could not be pulled.
 */
export function pullModels(host: Host, ollamaBin: string, instances: AgentInstance[], attempts = 10, sleep: (ms: number) => void = sleepSync): string[] {
  const failed: string[] = [];
  const ollamaInstances = instances.filter((i) => !i.engine || i.engine.kind === "ollama");
  for (const model of [...new Set(ollamaInstances.map((i) => i.model))]) {
    const inst = ollamaInstances.find((i) => i.model === model)!;
    console.log(`pulling ${model}`);
    let ok = false;
    for (let a = 0; a < attempts && !ok; a++) {
      if (a > 0) sleep(3000);
      ok = host.run(ollamaBin, ["pull", model], { OLLAMA_HOST: `127.0.0.1:${inst.ollamaPort}` }).code === 0;
    }
    if (!ok) {
      console.error(`warning: could not pull ${model}; run \`OLLAMA_HOST=127.0.0.1:${inst.ollamaPort} ollama pull ${model}\` once the services are up`);
      failed.push(model);
    }
  }
  return failed;
}

/** Env lines the host sets by hand in agent-<n>.env (docs/install.md "Host controls"): every re-run keeps them. */
export const HOST_CONTROL_ENV = ["AGENT_REMOTE_CONTROL", "AGENT_MODEL_ALLOWLIST"];
const SAFE_KEPT_VALUE = /^[A-Za-z0-9._:/,@+-]{1,512}$/;

/**
 * Per instance whose env file is for the same agent id: the host controls (always), and under
 * --keep-config its model (unless --model is given) and MAX_CONCURRENT_TASKS, so an update changes
 * nothing the host chose. Sets opts.keepEnv and opts.instanceModels.
 */
export function keptEnvLines(opts: InstallOptions, plan: InstallPlan, p: ServicePaths, read: (path: string) => string | undefined = readIfPresent): void {
  const keepEnv: Record<number, Record<string, string>> = {};
  const models: Record<number, string> = {};
  const modelGiven = (opts.given ?? []).includes("--model");
  for (const inst of plan.instances) {
    const old = parseEnvFile(read(envFilePath(p, inst)) ?? "");
    if (old.AGENT_ID !== inst.agentId) continue;
    const keys = [...HOST_CONTROL_ENV, ...(opts.keepConfig ? ["MAX_CONCURRENT_TASKS"] : [])];
    for (const k of keys) if (old[k] !== undefined && SAFE_KEPT_VALUE.test(old[k])) (keepEnv[inst.index] ??= {})[k] = old[k];
    if (opts.keepConfig && !modelGiven && old.OLLAMA_MODEL && SAFE_KEPT_VALUE.test(old.OLLAMA_MODEL)) models[inst.index] = old.OLLAMA_MODEL;
  }
  opts.keepEnv = keepEnv;
  if (Object.keys(models).length) opts.instanceModels = models;
}

const SECRET_ENV = ["AGENT_REGISTRATION_TOKEN", "MESH_AUTH_TOKEN", "VLLM_API_KEY"];

const redactEnv = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET_ENV.includes(k) && v ? "<redacted>" : v]));

/** The plan for --json output, token values replaced so logs and CI captures do not keep them. */
export function redactPlan(plan: InstallPlan): InstallPlan {
  return {
    ...plan,
    instances: plan.instances.map((i) => ({
      ...i,
      env: redactEnv(i.env),
      ...(i.engine ? { engine: { ...i.engine, env: redactEnv(i.engine.env) } } : {})
    }))
  };
}

function describeHardware(hw: HostHardware): string {
  const lines = [`Host ${hw.hostname}: ${hw.platform}/${hw.arch}, ${hw.cpuCores} cores (${hw.cpuModel}), ${hw.ramGb} GB RAM${hw.unifiedMemory ? " (unified)" : ""}`];
  if (hw.gpus.length === 0) lines.push("GPUs: none detected (CPU class)");
  for (const g of hw.gpus) {
    const extra = [g.source === "sysfs" ? "found in sysfs" : "", g.gfxTarget ? `${g.gfxTarget}${g.rocmSupported === false ? ", not supported by ROCm" : ""}` : "", g.vulkanIndex !== undefined ? `Vulkan device ${g.vulkanIndex}` : ""].filter(Boolean).join(", ");
    lines.push(`GPU ${g.index}: ${g.model} ${g.vramGb} GB ${g.vendor}${g.datacenter ? " datacenter" : ""}${extra ? ` (${extra})` : ""}`);
  }
  return lines.join("\n");
}

function describePlan(plan: InstallPlan, p: ServicePaths): string {
  const lines = [`Sandbox: ${plan.sandboxMode}`, `Instances (${plan.instances.length}):`];
  for (const i of plan.instances) {
    const serves = i.engine?.kind === "vllm" ? `vllm ${i.env.VLLM_URL} model ${i.env.VLLM_MODEL ?? "(whatever it serves)"}${i.env.VLLM_MAX_SLOTS ? `, ${i.env.VLLM_MAX_SLOTS} slots` : ""}`
      : i.engine?.kind === "mlx" ? `mlx ${i.env.MLX_URL ?? "http://127.0.0.1:8080"}` : `ollama :${i.ollamaPort} model ${i.model}`;
    const switched = i.engine?.previous && i.engine.previous !== i.engine.kind ? `  [switching from ${i.engine.previous}]` : "";
    lines.push(`  ${i.agentId}: ${i.gpu ? `${i.gpu.model} (${i.gpu.vramGb} GB)` : "CPU"} -> ${serves}${switched}${i.engine?.installArgs ? `  [installs vLLM, profile ${i.engine.installArgs[i.engine.installArgs.indexOf("--profile") + 1]}]` : ""}${i.env.AGENT_REGISTRATION_TOKEN ? "" : "  [no registration token]"}`);
  }
  lines.push(`Config dir: ${p.configDir}   App dir: ${p.appDir}   Node: ${p.nodeBin}   Ollama: ${p.ollamaBin}`);
  for (const w of plan.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

/**
 * Environment= lines a host put in its own drop-ins for instance 0's Ollama
 * (/etc/systemd/system/edgecoder-ollama-0.service.d/*.conf; apply and update never touch them), so
 * the Vulkan hint is not repeated to a host that already turned Vulkan on by hand.
 */
export function hostOllamaEnv(read: (path: string) => string | undefined, list: (dir: string) => string[], index = 0): Record<string, string> {
  const dir = ollamaDropInDir(index);
  const out: Record<string, string> = {};
  for (const name of list(dir).filter((n) => n.endsWith(".conf")).sort()) {
    for (const line of (read(`${dir}/${name}`) ?? "").split(/\r?\n/)) {
      const m = /^\s*Environment\s*=\s*(.+)$/.exec(line);
      if (!m) continue;
      for (const tok of m[1].match(/"[^"]*"|\S+/g) ?? []) {
        const kv = tok.replace(/^"|"$/g, "");
        const eq = kv.indexOf("=");
        if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }
  }
  return out;
}

function listDirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Each instance's engine for this run (engine.ts): --engine and the --vllm-* flags, else what the
 * instance runs now (its env file, its vLLM marker), so a re-run or upgrade never switches engines.
 */
export function resolveEngines(opts: InstallOptions, plan: InstallPlan, p: ServicePaths, read: (path: string) => string | undefined = readIfPresent, exists: (path: string) => boolean = existsSync): Record<number, InstanceEngine> {
  const out: Record<number, InstanceEngine> = {};
  for (const inst of plan.instances) {
    const n = inst.index;
    const markerExists = exists(vllmMarkerPath(p.configDir, n)) || (n === 0 && exists(legacyVllmMarkerPath(p.configDir)));
    // --vllm-profile auto names a profile per instance, from that instance's GPUs.
    const flags = opts.vllmProfile === VLLM_PROFILE_AUTO ? { ...opts, vllmProfile: instanceVllmProfile(opts.vllmProfile, inst.gpus).profile } : opts;
    out[n] = resolveInstanceEngine(n, flags, { agentEnv: read(envFilePath(p, inst)), vllmEnv: read(vllmEnvPath(p.configDir, n)), markerExists });
  }
  return out;
}

/**
 * A re-run without --token (switching to vLLM, an update with install.sh, a package upgrade) keeps
 * each instance's registration token from its env file, when that file is for the same agent id:
 * otherwise the rewritten env file would have none and the agent could not sign in. Returns the
 * agent ids whose token was kept.
 */
export function keepRegistrationTokens(opts: InstallOptions, plan: InstallPlan, p: ServicePaths, read: (path: string) => string | undefined = readIfPresent): string[] {
  const kept: string[] = [];
  if (opts.tokens["*"]) return kept;
  for (const inst of plan.instances) {
    if (opts.tokens[inst.agentId]) continue;
    const old = parseEnvFile(read(envFilePath(p, inst)) ?? "");
    const token = old.AGENT_REGISTRATION_TOKEN;
    if (old.AGENT_ID !== inst.agentId || !token || !TOKEN_PATTERN.test(token)) continue;
    opts.tokens[inst.agentId] = token;
    kept.push(inst.agentId);
  }
  return kept;
}

/**
 * Linux vLLM instances whose vLLM is not installed yet get install-vllm.sh arguments (with
 * --vllm-profile); without a profile that is an error, returned before anything is written.
 */
export function planVllmInstalls(opts: InstallOptions, plan: InstallPlan, p: ServicePaths, exists: (path: string) => boolean): string[] {
  const problems: string[] = [];
  for (const inst of plan.instances) {
    if (inst.engine?.kind !== "vllm") continue;
    if (vllmInstalledPaths(p.configDir, inst.index).every((f) => exists(f))) continue;
    if (!opts.vllmProfile) {
      problems.push(`vLLM is not installed for instance ${inst.index} (${inst.agentId}): pass --vllm-profile ${vllmProfileChoices().join("|")} to install it, or run scripts/linux/vllm/install-vllm.sh --instance ${inst.index} with --model, --gpus and --args first`);
      continue;
    }
    const picked = instanceVllmProfile(opts.vllmProfile, inst.gpus);
    if (!picked.profile) {
      problems.push(`--vllm-profile auto found no vLLM profile for instance ${inst.index} (${inst.agentId}): ${picked.reason}`);
      continue;
    }
    const gpus = inst.gpus.map((g) => g.index).join(",");
    inst.engine.installArgs = [
      `${p.appDir}/scripts/linux/vllm/install-vllm.sh`,
      "--profile", picked.profile,
      "--instance", String(inst.index),
      ...(gpus ? ["--gpus", gpus] : []),
      ...(inst.env.VLLM_MODEL ? ["--model", inst.env.VLLM_MODEL] : []),
      "--download"
    ];
  }
  return problems;
}

export async function runInstaller(argv: string[], env: NodeJS.ProcessEnv = process.env, host: Host = realHost, post: HttpPost = fetchPost, binFs: BinFs = realBinFs, get: HttpGet = fetchGet): Promise<number> {
  let opts: InstallOptions;
  try {
    opts = parseInstallArgs(argv, env);
  } catch (e) {
    console.error(String((e as Error).message));
    console.error(helpText());
    return 2;
  }
  if (opts.command === "help") {
    console.log(helpText());
    return 0;
  }
  if (opts.tokensFile) Object.assign(opts.tokens, parseTokensFile(readFileSync(opts.tokensFile, "utf8")));
  if (opts.command === "plan" || opts.command === "apply") {
    const errors = [...validateInstallOptions(opts), ...engineProblems(opts.engine, host.platform)];
    if (errors.length) {
      for (const e of errors) console.error(`error: ${e}`);
      return 2;
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const appDir = opts.appDir ?? resolve(here, "..", "..");
  const p = defaultPaths(host.platform, {
    appDir,
    ...(opts.configDir ? { configDir: opts.configDir } : {}),
    ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
    ...(opts.ollamaBin ? { ollamaBin: opts.ollamaBin } : {})
  });
  if (!opts.ollamaBin) {
    const found = findOllama(host.platform);
    if (found) p.ollamaBin = found;
  }
  if (opts.command === "update") {
    const deps = realUpdateDeps({ binFs, writeText: (path, text, mode) => writeFileFresh(path, text, mode), stateDir: p.stateDir, ...(opts.json ? { log: (line: string) => console.error(line) } : {}) });
    const out = await runUpdate({ check: !!opts.check, scheduled: !!opts.scheduled, ...(opts.jitterSec !== undefined ? { jitterSec: opts.jitterSec } : {}) }, { appDir, configDir: p.configDir, nodeBin: opts.nodeBin ?? process.execPath }, deps);
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    return out.code;
  }
  const hw = detectHardware({ probe, platform: host.platform });

  if (opts.command === "detect") {
    const hint = vulkanHint(hw, { ...hostOllamaEnv(readIfPresent, listDirOrEmpty), ...(inheritTuning(opts, readIfPresent(envFilePath(p, { index: 0 } as AgentInstance))).ollamaEnv ?? {}) });
    console.log(opts.json ? JSON.stringify(hw, null, 2) : `${describeHardware(hw)}${hint ? `\nhint: ${hint}` : ""}`);
    return 0;
  }
  if (opts.command === "status") {
    const s = serviceStatus(host, p, 32, readIfPresent);
    const update = updateStatusLines(readIfPresent, listDirOrEmpty, { appDir, configDir: p.configDir }, timerStatus(host));
    console.log(opts.json ? JSON.stringify({ services: s, update }, null, 2) : [s.map((x) => `${x.name}: ${x.state}${x.reason ? ` (${x.reason})` : ""}`).join("\n") || "no EdgeCoder services installed", ...update].join("\n"));
    return 0;
  }
  if (opts.command === "remove") {
    const removed = opts.dryRun ? [] : [...removeServices(host, p), ...removeUpdateSchedule(host), ...removeSearxng(host)];
    console.log(opts.json ? JSON.stringify({ removed }) : `removed ${removed.length} services`);
    return 0;
  }

  // A re-run without the tuning flags (a package upgrade's apply --from-package) keeps the values
  // the previous run recorded in the first instance's env file.
  opts = inheritTuning(opts, readIfPresent(envFilePath(p, { index: 0 } as AgentInstance)));
  // --keep-config (update): URLs, mesh token and the recorded plan flags of the previous run.
  opts = inheritConfig(opts, readIfPresent(envFilePath(p, { index: 0 } as AgentInstance)));
  if (opts.keepConfig) {
    const errors = validateInstallOptions(opts);
    if (errors.length) {
      for (const e of errors) console.error(`error: ${e}`);
      return 2;
    }
  }
  const dockerPresent = opts.sandbox === "docker" ? true : dockerAvailable();
  let plan = planInstall(hw, opts, dockerPresent);
  // The agent id must be the node id its token was enrolled as (or the one a previous install used).
  const naming = await resolveTokenNodeId(opts, plan, get);
  const say = (line: string) => { if (opts.json) console.error(line); else console.log(line); };
  if (naming.error && opts.command === "apply") {
    console.error(`error: ${naming.error}`);
    return 2;
  }
  for (const line of naming.notes) say(line);
  const keptId = keepEnrolledAgentId(opts, plan, p);
  if (keptId) say(`Keeping the node id "${keptId}" of the previous install (its registration token is for that id).`);
  if (opts.agentIdOverride) plan = planInstall(hw, opts, dockerPresent);
  keepRegistrationTokens(opts, plan, p);
  keptEnvLines(opts, plan, p);
  // Engines per instance index, from the flags and what each instance runs now; then the real plan.
  opts.instanceEngines = resolveEngines(opts, plan, p);
  for (const e of Object.values(opts.instanceEngines)) {
    const problems = engineProblems(e.kind, host.platform);
    if (problems.length && !opts.engine) {
      for (const msg of problems) console.error(`error: ${msg} (an existing env file says EDGECODER_ENGINE=${e.kind}; pass --engine to change it)`);
      return 2;
    }
  }
  // Ollama ports another program holds (a stock ollama.service on 11434) are skipped (ports.ts).
  if (host.platform === "linux" || host.platform === "darwin") {
    const { ports, notes } = allocateOllamaPorts(plan.instances.length, (port) => portOwner(host, port, readIfPresent));
    opts.ollamaPorts = ports;
    for (const line of notes) say(`note: ${line}`);
  }
  plan = planInstall(hw, opts, dockerPresent);
  if (naming.error) plan.warnings.push(naming.error);
  // AMD / Intel cards only Vulkan can drive, and Vulkan not on yet: the exact flags.
  const hint = vulkanHint(hw, { ...hostOllamaEnv(readIfPresent, listDirOrEmpty), ...(opts.ollamaEnv ?? {}) }, plan.instances.length);
  if (hint) plan.warnings.push(hint);
  if (host.platform === "linux") {
    const problems = planVllmInstalls(opts, plan, p, (f) => host.exists(f));
    if (problems.length && opts.command === "plan") plan.warnings.push(...problems);
    else if (problems.length) {
      for (const msg of problems) console.error(`error: ${msg}`);
      return 1;
    }
  }
  if (opts.command === "plan") {
    console.log(opts.json ? JSON.stringify({ hardware: hw, plan: redactPlan(plan), paths: p }, null, 2) : `${describeHardware(hw)}\n${describePlan(plan, p)}`);
    return 0;
  }

  // apply
  if (!existsSync(resolve(appDir, "dist", "swarm", "worker-runner.js"))) {
    console.error(`app dir ${appDir} has no dist/swarm/worker-runner.js (build the project or pass --app-dir)`);
    return 1;
  }
  const needsOllama = plan.instances.some((i) => i.engine?.kind !== "vllm");
  if (needsOllama && !opts.dryRun && !existsSync(p.ollamaBin) && !opts.fromPackage) {
    console.error(`ollama not found at ${p.ollamaBin}; install it (https://ollama.com/download) or pass --ollama-bin`);
    return 1;
  }
  let enrollFailed: string[] = [];
  if (opts.enrollToken && !opts.dryRun) {
    const candidates = plan.instances.filter((i) => !opts.tokens[i.agentId] && !opts.tokens["*"]);
    if (candidates.length) {
      const { enrolled, failed } = await enrollNodes(opts, candidates, post);
      enrollFailed = failed;
      if (enrolled.length === 0) {
        console.error(`enrolment failed for all ${failed.length} node(s) at ${opts.portalUrl}; check the --enroll API key (or EDGECODER_API_KEY) and portal URL`);
        return 1;
      }
      // Re-plan so the env files and warnings reflect the registration tokens just applied.
      plan = planInstall(hw, opts, dockerPresent);
      if (host.platform === "linux") planVllmInstalls(opts, plan, p, (f) => host.exists(f));
    }
  }
  if (host.platform === "win32" && (!p.user || /^(SYSTEM|.*\$)$/i.test(p.user.split("\\").pop() ?? ""))) {
    console.error(`the services run as the installing user, but this is running as "${p.user || "unknown"}"; run edgecoder-install from an elevated prompt of the account the agents should run as`);
    return 1;
  }
  if (!opts.dryRun) {
    const dirs = [p.configDir, p.modelsDir, p.logDir, p.stateDir];
    if (host.platform === "win32") {
      // A pre-created ProgramData\EdgeCoder keeps its creator as owner: refuse it, then create and
      // lock the config dir before its subdirs or any secret exist, and check again after.
      const run = (cmd: string, args: string[]) => host.run(cmd, args);
      const before = windowsDirOwnerProblems(p, run);
      if (before.length === 0) {
        mkdirSync(p.configDir, { recursive: true });
        lockConfigDir(p, host.platform, run);
        for (const dir of dirs) mkdirSync(dir, { recursive: true });
      }
      const problems = before.length ? before : windowsDirOwnerProblems(p, run);
      if (problems.length) {
        for (const msg of problems) console.error(`error: ${msg}`);
        return 1;
      }
    } else {
      for (const dir of dirs) mkdirSync(dir, { recursive: true });
    }
  }
  // Services never run binaries a non-root user can replace (Linux/macOS; Windows runs as the user).
  const staged = secureBinaries(binFs, host.platform, p, { dryRun: opts.dryRun, ollama: !!binFs.stat(p.ollamaBin) });
  for (const s of staged.plans) if (s.copy && !opts.json) console.log(`${opts.dryRun ? "would copy" : "copied"} ${s.kind} ${s.copy.from} -> ${s.copy.to} (root-owned; ${s.reason})`);
  if (staged.problems.length) {
    for (const msg of staged.problems) console.error(`error: ${msg}`);
    console.error("refusing to create services that run code a non-root user can replace");
    return 1;
  }
  // Local web search (searxng.ts): the agents get SEARXNG_URL while it's on; set up after the services.
  const searxngOn = searxngWanted(host.platform, opts.searxng, readIfPresent, p.configDir);
  for (const inst of plan.instances) Object.assign(inst.env, searxngAgentEnv(searxngOn));
  // auto: a portal override of the same setting would keep pinning it; drop that entry before the restart.
  const autoKeys: ClearableOverride[] = [...(opts.contextWindow === "auto" ? ["contextWindow" as const] : []), ...(opts.parallel === "auto" ? ["parallel" as const] : [])];
  if (autoKeys.length && !opts.dryRun) {
    for (const inst of plan.instances) {
      const path = instanceOverridesPath(host.platform, p, inst.index);
      if (!path) continue;
      try {
        const r = clearOverrideEntries(path, autoKeys);
        if (r === "cleared" && !opts.json) console.log(`cleared the portal's ${autoKeys.join(" and ")} override in ${path}`);
        if (r === "unreadable") console.error(`warning: ${path} is not valid JSON; left as is (the agent ignores it)`);
      } catch (e) {
        console.error(`warning: could not update ${path}: ${String(e)}`);
      }
    }
  }
  const result = applyPlan(plan, host, p, opts.dryRun);
  const searxng = applySearxng(host, p, { ...(opts.searxng !== undefined ? { flag: opts.searxng } : {}), dryRun: opts.dryRun, read: readIfPresent, randomHex: () => randomBytes(32).toString("hex") });
  result.files.push(...searxng.files);
  result.commands.push(...searxng.commands);
  const schedule = applyUpdateSchedule(host, p, { ...(opts.autoUpdate !== undefined ? { flag: opts.autoUpdate } : {}), releaseInstall: existsSync(resolve(appDir, RELEASE_INFO_FILE)), dryRun: opts.dryRun, insideUpdate: env.EDGECODER_UPDATE_RUN === "1", read: readIfPresent, listDir: listDirOrEmpty, instances: plan.instances.map((i) => i.index) });
  result.files.push(...schedule.files);
  result.commands.push(...schedule.commands);
  if (opts.pullModels && !opts.dryRun) pullModels(host, p.ollamaBin, plan.instances);
  if (opts.json) {
    console.log(JSON.stringify({ hardware: hw, plan: redactPlan(plan), paths: p, result }, null, 2));
  } else {
    console.log(`${describeHardware(hw)}\n${describePlan(plan, p)}`);
    console.log(`${opts.dryRun ? "Would write" : "Wrote"} ${result.files.length} files; services: ${result.services.join(", ")}`);
    if (opts.dryRun) console.log(result.commands.map((c) => `  $ ${c}`).join("\n"));
    if (!opts.dryRun && (opts.enrollToken || Object.keys(opts.tokens).length > 0)) {
      for (const line of await enrollmentConfirmation(opts.portalUrl, plan.instances, enrollFailed, get)) console.log(line);
    }
    console.log(schedule.summary);
    console.log(searxng.summary);
    console.log(hostAgreementLine(opts.portalUrl));
    const missing = plan.instances.filter((i) => !i.env.AGENT_REGISTRATION_TOKEN).map((i) => i.agentId);
    if (missing.length) {
      console.log(`\nEnrol these node ids, exactly as written, on ${opts.portalUrl}/portal/settings/nodes (Enroll a node), then re-run:\n  edgecoder-install apply ${missing.map((id) => `--token ${id}=<token>`).join(" ")}\nOr re-run with an install key (EDGECODER_API_KEY=eck_...), which enrols them for you.`);
    }
  }
  return 0;
}

/** Printed after an install: running the agent means hosting other people's work under the Host Agreement. */
export function hostAgreementLine(portalUrl: string): string {
  return `\nBy running the EdgeCoder agent on this machine you agree to the Host Agreement (version ${HOST_AGREEMENT_VERSION}): ${portalUrl.replace(/\/$/, "")}/host-agreement\nIt runs other people's AI and code jobs here; the sandbox reduces risk but doesn't guarantee isolation.`;
}

if (process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runInstaller(process.argv.slice(2)).then((code) => process.exit(code));
}
