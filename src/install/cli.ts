// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * edgecoder-install: the one installer behind the macOS .pkg, Linux .deb, Windows MSI and the
 * curl/PowerShell bootstraps (docs/install.md). Detects the hardware, plans one agent per GPU
 * (or one per host), writes env files and services, starts them.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectHardware, type HostHardware, type Probe } from "./hardware.js";
import { helpText, inheritTuning, parseInstallArgs, parseTokensFile, TOKEN_PATTERN, validateInstallOptions, type InstallOptions } from "./options.js";
import { planInstall, type AgentInstance, type InstallPlan } from "./plan.js";
import { HOST_AGREEMENT_VERSION } from "../common/legal-notices.js";
import { appDirProblems, planBinary, stageBinary, type BinFs, type StagePlan } from "./binaries.js";
import { engineProblems, legacyVllmMarkerPath, resolveInstanceEngine, VLLM_PROFILES, vllmEnvPath, vllmInstalledPaths, vllmMarkerPath, type InstanceEngine } from "./engine.js";
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
  run(cmd, args) {
    // win32 goes through cmd.exe (icacls/schtasks take pre-quoted args); quote the rest, such as
    // an ollama path under a profile with a space in it.
    const r = process.platform === "win32"
      ? spawnSync(cmdQuote(cmd), args.map(cmdQuote), { encoding: "utf8", shell: true })
      : spawnSync(cmd, args, { encoding: "utf8" });
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

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Pull each distinct model once (the model store is shared by every instance). `ollama pull`
 * talks to the default 127.0.0.1:11434, which is instance 0's server; it was just (re)started, so
 * a pull is retried until that server is listening. Returns the models that could not be pulled.
 */
export function pullModels(host: Host, ollamaBin: string, instances: AgentInstance[], attempts = 10, sleep: (ms: number) => void = sleepSync): string[] {
  const failed: string[] = [];
  for (const model of [...new Set(instances.map((i) => i.model))]) {
    console.log(`pulling ${model}`);
    let ok = false;
    for (let a = 0; a < attempts && !ok; a++) {
      if (a > 0) sleep(3000);
      ok = host.run(ollamaBin, ["pull", model]).code === 0;
    }
    if (!ok) {
      console.error(`warning: could not pull ${model}; run \`ollama pull ${model}\` once the services are up`);
      failed.push(model);
    }
  }
  return failed;
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
  for (const g of hw.gpus) lines.push(`GPU ${g.index}: ${g.model} ${g.vramGb} GB ${g.vendor}${g.datacenter ? " datacenter" : ""}`);
  return lines.join("\n");
}

function describePlan(plan: InstallPlan, p: ServicePaths): string {
  const lines = [`Sandbox: ${plan.sandboxMode}`, `Instances (${plan.instances.length}):`];
  for (const i of plan.instances) {
    const serves = i.engine?.kind === "vllm" ? `vllm ${i.env.VLLM_URL} model ${i.env.VLLM_MODEL ?? "(whatever it serves)"}${i.env.VLLM_MAX_SLOTS ? `, ${i.env.VLLM_MAX_SLOTS} slots` : ""}`
      : i.engine?.kind === "mlx" ? `mlx ${i.env.MLX_URL ?? "http://127.0.0.1:8080"}` : `ollama :${i.ollamaPort} model ${i.model}`;
    const switched = i.engine?.previous && i.engine.previous !== i.engine.kind ? `  [switching from ${i.engine.previous}]` : "";
    lines.push(`  ${i.agentId}: ${i.gpu ? `${i.gpu.model} (${i.gpu.vramGb} GB)` : "CPU"} -> ${serves}${switched}${i.engine?.installArgs ? "  [installs vLLM]" : ""}${i.env.AGENT_REGISTRATION_TOKEN ? "" : "  [no registration token]"}`);
  }
  lines.push(`Config dir: ${p.configDir}   App dir: ${p.appDir}   Node: ${p.nodeBin}   Ollama: ${p.ollamaBin}`);
  for (const w of plan.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
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
    out[n] = resolveInstanceEngine(n, opts, { agentEnv: read(envFilePath(p, inst)), vllmEnv: read(vllmEnvPath(p.configDir, n)), markerExists });
  }
  return out;
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
      problems.push(`vLLM is not installed for instance ${inst.index} (${inst.agentId}): pass --vllm-profile ${Object.keys(VLLM_PROFILES).join("|")} to install it, or run scripts/linux/vllm/install-vllm.sh --instance ${inst.index} with --model, --gpus and --args first`);
      continue;
    }
    const gpus = inst.gpus.map((g) => g.index).join(",");
    inst.engine.installArgs = [
      `${p.appDir}/scripts/linux/vllm/install-vllm.sh`,
      "--profile", opts.vllmProfile,
      "--instance", String(inst.index),
      ...(gpus ? ["--gpus", gpus] : []),
      ...(inst.env.VLLM_MODEL ? ["--model", inst.env.VLLM_MODEL] : []),
      "--download"
    ];
  }
  return problems;
}

export async function runInstaller(argv: string[], env: NodeJS.ProcessEnv = process.env, host: Host = realHost, post: HttpPost = fetchPost, binFs: BinFs = realBinFs): Promise<number> {
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
  const hw = detectHardware({ probe, platform: host.platform });

  if (opts.command === "detect") {
    console.log(opts.json ? JSON.stringify(hw, null, 2) : describeHardware(hw));
    return 0;
  }
  if (opts.command === "status") {
    const s = serviceStatus(host, p);
    console.log(opts.json ? JSON.stringify(s, null, 2) : s.map((x) => `${x.name}: ${x.state}`).join("\n") || "no EdgeCoder services installed");
    return 0;
  }
  if (opts.command === "remove") {
    const removed = opts.dryRun ? [] : removeServices(host, p);
    console.log(opts.json ? JSON.stringify({ removed }) : `removed ${removed.length} services`);
    return 0;
  }

  // A re-run without the tuning flags (a package upgrade's apply --from-package) keeps the values
  // the previous run recorded in the first instance's env file.
  opts = inheritTuning(opts, readIfPresent(envFilePath(p, { index: 0 } as AgentInstance)));
  const dockerPresent = opts.sandbox === "docker" ? true : dockerAvailable();
  let plan = planInstall(hw, opts, dockerPresent);
  // Engines per instance index, from the flags and what each instance runs now; then the real plan.
  opts.instanceEngines = resolveEngines(opts, plan, p);
  for (const e of Object.values(opts.instanceEngines)) {
    const problems = engineProblems(e.kind, host.platform);
    if (problems.length && !opts.engine) {
      for (const msg of problems) console.error(`error: ${msg} (an existing env file says EDGECODER_ENGINE=${e.kind}; pass --engine to change it)`);
      return 2;
    }
  }
  plan = planInstall(hw, opts, dockerPresent);
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
  if (opts.enrollToken && !opts.dryRun) {
    const candidates = plan.instances.filter((i) => !opts.tokens[i.agentId] && !opts.tokens["*"]);
    if (candidates.length) {
      const { enrolled, failed } = await enrollNodes(opts, candidates, post);
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
  const result = applyPlan(plan, host, p, opts.dryRun);
  if (opts.pullModels && !opts.dryRun) pullModels(host, p.ollamaBin, plan.instances);
  if (opts.json) {
    console.log(JSON.stringify({ hardware: hw, plan: redactPlan(plan), paths: p, result }, null, 2));
  } else {
    console.log(`${describeHardware(hw)}\n${describePlan(plan, p)}`);
    console.log(`${opts.dryRun ? "Would write" : "Wrote"} ${result.files.length} files; services: ${result.services.join(", ")}`);
    if (opts.dryRun) console.log(result.commands.map((c) => `  $ ${c}`).join("\n"));
    console.log(hostAgreementLine(opts.portalUrl));
    const missing = plan.instances.filter((i) => !i.env.AGENT_REGISTRATION_TOKEN).map((i) => i.agentId);
    if (missing.length) {
      console.log(`\nEnrol these node ids on ${opts.portalUrl}/portal/dashboard (Enroll node), then re-run:\n  edgecoder-install apply ${missing.map((id) => `--token ${id}=<token>`).join(" ")}`);
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
