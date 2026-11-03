// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * edgecoder-install: the one installer behind the macOS .pkg, Linux .deb, Windows MSI and the
 * curl/PowerShell bootstraps (docs/install.md). Detects the hardware, plans one agent per GPU
 * (or one per host), writes env files and services, starts them.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectHardware, type HostHardware, type Probe } from "./hardware.js";
import { helpText, parseInstallArgs, parseTokensFile, type InstallOptions } from "./options.js";
import { planInstall, type AgentInstance, type InstallPlan } from "./plan.js";
import { applyPlan, defaultPaths, removeServices, serviceStatus, type Host, type ServicePaths } from "./services.js";

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

const realHost: Host = {
  platform: process.platform,
  writeFile(path, content, mode) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    if (mode !== undefined && process.platform !== "win32") chmodSync(path, mode);
  },
  removeFile(path) {
    try { unlinkSync(path); } catch { /* already gone */ }
  },
  run(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  exists: (path) => existsSync(path)
};

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
      opts.tokens[inst.agentId] = body.registrationToken;
      enrolled.push(inst.agentId);
    } catch (e) {
      console.error(`warning: could not enrol ${inst.agentId} at ${url}: ${(e as Error).message}`);
      failed.push(inst.agentId);
    }
  }
  return { enrolled, failed };
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
    lines.push(`  ${i.agentId}: ${i.gpu ? `${i.gpu.model} (${i.gpu.vramGb} GB)` : "CPU"} -> ollama :${i.ollamaPort} model ${i.model}${i.env.AGENT_REGISTRATION_TOKEN ? "" : "  [no registration token]"}`);
  }
  lines.push(`Config dir: ${p.configDir}   App dir: ${p.appDir}   Node: ${p.nodeBin}   Ollama: ${p.ollamaBin}`);
  for (const w of plan.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

export async function runInstaller(argv: string[], env: NodeJS.ProcessEnv = process.env, host: Host = realHost, post: HttpPost = fetchPost): Promise<number> {
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

  const dockerPresent = opts.sandbox === "docker" ? true : dockerAvailable();
  let plan = planInstall(hw, opts, dockerPresent);
  if (opts.command === "plan") {
    console.log(opts.json ? JSON.stringify({ hardware: hw, plan, paths: p }, null, 2) : `${describeHardware(hw)}\n${describePlan(plan, p)}`);
    return 0;
  }

  // apply
  if (!existsSync(resolve(appDir, "dist", "swarm", "worker-runner.js"))) {
    console.error(`app dir ${appDir} has no dist/swarm/worker-runner.js (build the project or pass --app-dir)`);
    return 1;
  }
  if (!opts.dryRun && !existsSync(p.ollamaBin) && !opts.fromPackage) {
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
    }
  }
  if (!opts.dryRun) {
    for (const dir of [p.configDir, p.modelsDir, p.logDir]) mkdirSync(dir, { recursive: true });
    if (host.platform === "linux") {
      if (host.run("id", ["-u", p.user]).code !== 0) host.run("useradd", ["--system", "--create-home", "--home-dir", "/var/lib/edgecoder", "--shell", "/usr/sbin/nologin", p.user]);
      host.run("chown", ["-R", `${p.user}:${p.user}`, p.modelsDir, p.logDir, p.configDir]);
      if (plan.sandboxMode === "docker") host.run("usermod", ["-aG", "docker", p.user]);
    }
  }
  const result = applyPlan(plan, host, p, opts.dryRun);
  if (opts.pullModels && !opts.dryRun) {
    for (const inst of plan.instances) {
      console.log(`pulling ${inst.model} on :${inst.ollamaPort}`);
      host.run(p.ollamaBin, ["pull", inst.model]); // OLLAMA_HOST from env would target one server; the store is shared
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({ hardware: hw, plan, paths: p, result }, null, 2));
  } else {
    console.log(`${describeHardware(hw)}\n${describePlan(plan, p)}`);
    console.log(`${opts.dryRun ? "Would write" : "Wrote"} ${result.files.length} files; services: ${result.services.join(", ")}`);
    if (opts.dryRun) console.log(result.commands.map((c) => `  $ ${c}`).join("\n"));
    const missing = plan.instances.filter((i) => !i.env.AGENT_REGISTRATION_TOKEN).map((i) => i.agentId);
    if (missing.length) {
      console.log(`\nEnrol these node ids on ${opts.portalUrl}/portal/dashboard (Enroll node), then re-run:\n  edgecoder-install apply ${missing.map((id) => `--token ${id}=<token>`).join(" ")}`);
    }
  }
  return 0;
}

if (process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runInstaller(process.argv.slice(2)).then((code) => process.exit(code));
}
