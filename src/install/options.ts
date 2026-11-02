// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * The one option table every installer shares. The macOS .pkg, the Linux .deb, the Windows MSI
 * and the curl/PowerShell bootstraps all end in `edgecoder-install apply ...` with these flags,
 * so a feature added here reaches every platform at once (tests/install/parity.test.ts checks
 * that the platform entry points and docs/install.md stay in step).
 */

export interface InstallOptions {
  command: "detect" | "plan" | "apply" | "status" | "remove" | "help";
  coordinatorUrl: string;
  portalUrl: string;
  meshToken?: string;
  /** agentId -> registration token; "*" applies to every instance. */
  tokens: Record<string, string>;
  tokensFile?: string;
  /** Portal session token: self-enrol every instance that has no --token and apply the returned registration token. */
  enrollToken?: string;
  model?: string;
  perGpu: boolean;
  instances?: number;
  sandbox: "auto" | "docker" | "none";
  agentIdPrefix?: string;
  pullModels: boolean;
  dryRun: boolean;
  json: boolean;
  fromPackage: boolean;
  configDir?: string;
  appDir?: string;
  nodeBin?: string;
  ollamaBin?: string;
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
  { name: "help", description: "Show this help." }
];

export const INSTALL_OPTIONS: OptionSpec[] = [
  { flag: "--coordinator-url", arg: "URL", description: `Coordinator to join (default ${DEFAULT_COORDINATOR_URL}).` },
  { flag: "--portal-url", arg: "URL", description: `Portal for node enrolment and discovery (default ${DEFAULT_PORTAL_URL}).` },
  { flag: "--mesh-token", arg: "TOKEN", description: "Mesh auth token for the coordinator (MESH_AUTH_TOKEN)." },
  { flag: "--token", arg: "[AGENT_ID=]TOKEN", description: "Registration token from the portal Nodes page; repeatable. Without AGENT_ID= it applies to every instance." },
  { flag: "--tokens-file", arg: "PATH", description: "File of AGENT_ID=TOKEN lines (one per instance)." },
  { flag: "--enroll", arg: "PORTAL_TOKEN", description: "Portal session token: self-enrol each un-tokened instance with the portal and apply the registration token it returns." },
  { flag: "--model", arg: "TAG", description: "Ollama model for every instance (default: largest coding model that fits each GPU)." },
  { flag: "--per-gpu", description: "One agent and one Ollama server per discrete GPU (default when GPUs are present)." },
  { flag: "--single", description: "One agent for the whole host, even with several GPUs." },
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
  { flag: "--ollama-bin", arg: "PATH", description: "Ollama binary (default: found on PATH or the platform install location)." }
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
  if (env.EDGECODER_COORDINATOR_URL) o.coordinatorUrl = env.EDGECODER_COORDINATOR_URL;
  if (env.EDGECODER_PORTAL_URL) o.portalUrl = env.EDGECODER_PORTAL_URL;
  if (env.EDGECODER_MESH_TOKEN) o.meshToken = env.EDGECODER_MESH_TOKEN;
  if (env.EDGECODER_REGISTRATION_TOKEN) o.tokens["*"] = env.EDGECODER_REGISTRATION_TOKEN;
  if (env.EDGECODER_ENROLL_TOKEN) o.enrollToken = env.EDGECODER_ENROLL_TOKEN;
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
      case "--per-gpu": o.perGpu = true; break;
      case "--single": o.perGpu = false; break;
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
      case "--help": case "-h": o.command = "help"; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  return o;
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

export function helpText(): string {
  const lines = ["edgecoder-install <command> [options]", "", "Commands:"];
  for (const c of INSTALL_COMMANDS) lines.push(`  ${c.name.padEnd(10)} ${c.description}`);
  lines.push("", "Options (identical on macOS, Linux and Windows):");
  for (const o of INSTALL_OPTIONS) lines.push(`  ${(o.flag + (o.arg ? " " + o.arg : "")).padEnd(34)} ${o.description}`);
  lines.push("", "Environment: EDGECODER_COORDINATOR_URL, EDGECODER_PORTAL_URL, EDGECODER_MESH_TOKEN, EDGECODER_REGISTRATION_TOKEN, EDGECODER_ENROLL_TOKEN set the defaults.");
  return lines.join("\n");
}
