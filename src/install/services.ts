// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Realise an install plan as platform services. Each instance gets an Ollama server bound to its
 * own port (pinned to its GPU) and an agent process; both restart on failure and start at boot.
 *   Linux   systemd units  edgecoder-ollama-<n>.service, edgecoder-agent-<n>.service
 *   macOS   launchd        io.edgecoder.ollama.<n>, io.edgecoder.agent.<n>  (LaunchDaemons)
 *   Windows scheduled tasks EdgeCoder\ollama-<n>, EdgeCoder\agent-<n> (ONSTART, SYSTEM) driven by
 *           generated .cmd wrappers that set the instance env.
 * File writes and commands go through an injected `Host` so the exact output is unit-tested.
 */
import type { AgentInstance, InstallPlan } from "./plan.js";
import { renderEnvFile } from "./plan.js";

export interface Host {
  platform: NodeJS.Platform;
  writeFile(path: string, content: string, mode?: number): void;
  removeFile(path: string): void;
  run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string };
  exists(path: string): boolean;
}

export interface ServicePaths {
  configDir: string;
  appDir: string;
  nodeBin: string;
  ollamaBin: string;
  /** Shared model store so N instances download each model once. */
  modelsDir: string;
  logDir: string;
  /** Linux: service user. */
  user: string;
}

export function defaultPaths(platform: NodeJS.Platform, overrides: Partial<ServicePaths> = {}): ServicePaths {
  if (platform === "win32") {
    const pd = process.env.ProgramData ?? "C:\\ProgramData";
    return {
      configDir: `${pd}\\EdgeCoder`,
      appDir: `${process.env.ProgramFiles ?? "C:\\Program Files"}\\EdgeCoder\\app`,
      nodeBin: process.execPath,
      ollamaBin: `${process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local"}\\Programs\\Ollama\\ollama.exe`,
      modelsDir: `${pd}\\EdgeCoder\\ollama`,
      logDir: `${pd}\\EdgeCoder\\logs`,
      user: "SYSTEM",
      ...overrides
    };
  }
  const mac = platform === "darwin";
  return {
    configDir: "/etc/edgecoder",
    appDir: mac ? "/opt/edgecoder/app" : "/usr/lib/edgecoder/app",
    nodeBin: process.execPath,
    ollamaBin: mac ? "/usr/local/bin/ollama" : "/usr/local/bin/ollama",
    modelsDir: mac ? "/var/lib/edgecoder/ollama" : "/var/lib/edgecoder/ollama",
    logDir: "/var/log/edgecoder",
    user: "edgecoder",
    ...overrides
  };
}

export function envFilePath(p: ServicePaths, inst: AgentInstance): string {
  return p.configDir.includes("\\") ? `${p.configDir}\\agent-${inst.index}.env` : `${p.configDir}/agent-${inst.index}.env`;
}

function ollamaEnv(p: ServicePaths, inst: AgentInstance): Record<string, string> {
  const env: Record<string, string> = {
    OLLAMA_HOST: `127.0.0.1:${inst.ollamaPort}`,
    OLLAMA_MODELS: p.modelsDir,
    OLLAMA_KEEP_ALIVE: "30m",
    HOME: p.modelsDir
  };
  // Same slot count the agent sends at once (plan.ts AGENT_PARALLEL_INFERENCE).
  if (inst.env?.AGENT_PARALLEL_INFERENCE) env.OLLAMA_NUM_PARALLEL = inst.env.AGENT_PARALLEL_INFERENCE;
  if (inst.gpu && inst.gpu.vendor !== "apple") {
    // Every card of the instance: Ollama spreads a model too big for one across them.
    const visible = (inst.gpus?.length ? inst.gpus : [inst.gpu]).map((g) => g.index).join(",");
    env.CUDA_VISIBLE_DEVICES = visible;
    env.HIP_VISIBLE_DEVICES = visible;
  }
  return env;
}

// ───────────────────────────── Linux (systemd) ─────────────────────────────
export function systemdOllamaUnit(p: ServicePaths, inst: AgentInstance): string {
  const env = Object.entries(ollamaEnv(p, inst)).map(([k, v]) => `Environment="${k}=${v}"`).join("\n");
  return `[Unit]
Description=EdgeCoder Ollama server ${inst.index}${inst.gpu ? ` (${inst.gpu.model})` : ""}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${p.user}
Group=${p.user}
ExecStart=${p.ollamaBin} serve
${env}
Restart=always
RestartSec=5
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=edgecoder-ollama-${inst.index}

[Install]
WantedBy=multi-user.target
`;
}

export function systemdAgentUnit(p: ServicePaths, inst: AgentInstance): string {
  return `[Unit]
Description=EdgeCoder agent ${inst.agentId}
After=network-online.target edgecoder-ollama-${inst.index}.service docker.service
Wants=network-online.target edgecoder-ollama-${inst.index}.service

[Service]
Type=simple
User=${p.user}
Group=${p.user}
WorkingDirectory=${p.appDir}
EnvironmentFile=${envFilePath(p, inst)}
Environment="NODE_ENV=production"
# Own state per instance (~/.edgecoder worker.db with its pending-results queue, ~/.config/edgecoder):
# systemd creates /var/lib/edgecoder/agent-${inst.index} owned by ${p.user}; a shared HOME would let one agent
# sync another's queued results, and the useradd home is root-owned when it already existed.
StateDirectory=edgecoder/agent-${inst.index}
Environment="HOME=/var/lib/edgecoder/agent-${inst.index}"
ExecStart=${p.nodeBin} ${p.appDir}/dist/swarm/worker-runner.js
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal
SyslogIdentifier=edgecoder-agent-${inst.index}

[Install]
WantedBy=multi-user.target
`;
}

// ───────────────────────────── macOS (launchd) ─────────────────────────────
function plist(label: string, args: string[], env: Record<string, string>, cwd: string, logDir: string): string {
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const envXml = Object.entries(env).map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((a) => `      <string>${xml(a)}</string>`).join("\n")}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(cwd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(logDir)}/${label}.log</string>
    <key>StandardErrorPath</key>
    <string>${xml(logDir)}/${label}.err.log</string>
  </dict>
</plist>
`;
}

export function launchdOllamaPlist(p: ServicePaths, inst: AgentInstance): string {
  return plist(`io.edgecoder.ollama.${inst.index}`, [p.ollamaBin, "serve"], { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", ...ollamaEnv(p, inst) }, p.modelsDir, p.logDir);
}

export function launchdAgentPlist(p: ServicePaths, inst: AgentInstance): string {
  return plist(`io.edgecoder.agent.${inst.index}`, [p.nodeBin, `${p.appDir}/dist/swarm/worker-runner.js`], { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", ...inst.env }, p.appDir, p.logDir);
}

// ───────────────────────────── Windows (scheduled tasks) ─────────────────────────────
function cmdWrapper(env: Record<string, string>, exe: string, args: string[], cwd: string, log: string): string {
  const lines = ["@echo off", `cd /d "${cwd}"`];
  for (const [k, v] of Object.entries(env)) lines.push(`set "${k}=${v}"`);
  lines.push(`"${exe}" ${args.map((a) => `"${a}"`).join(" ")} >> "${log}" 2>&1`);
  return lines.join("\r\n") + "\r\n";
}

export function windowsOllamaCmd(p: ServicePaths, inst: AgentInstance): string {
  return cmdWrapper(ollamaEnv(p, inst), p.ollamaBin, ["serve"], p.modelsDir, `${p.logDir}\\ollama-${inst.index}.log`);
}

export function windowsAgentCmd(p: ServicePaths, inst: AgentInstance): string {
  return cmdWrapper({ NODE_ENV: "production", ...inst.env }, p.nodeBin, [`${p.appDir}\\dist\\swarm\\worker-runner.js`], p.appDir, `${p.logDir}\\agent-${inst.index}.log`);
}

// ───────────────────────────── apply / remove ─────────────────────────────
export interface ApplyResult {
  files: string[];
  commands: string[];
  services: string[];
}

export function applyPlan(plan: InstallPlan, host: Host, p: ServicePaths, dryRun: boolean): ApplyResult {
  const result: ApplyResult = { files: [], commands: [], services: [] };
  const write = (path: string, content: string, mode?: number) => {
    result.files.push(path);
    if (!dryRun) host.writeFile(path, content, mode);
  };
  const run = (cmd: string, args: string[]) => {
    result.commands.push([cmd, ...args].join(" "));
    if (dryRun) return { code: 0, stdout: "", stderr: "" };
    return host.run(cmd, args);
  };
  for (const inst of plan.instances) write(envFilePath(p, inst), renderEnvFile(inst.env), 0o600);

  if (host.platform === "linux") {
    for (const inst of plan.instances) {
      write(`/etc/systemd/system/edgecoder-ollama-${inst.index}.service`, systemdOllamaUnit(p, inst), 0o644);
      write(`/etc/systemd/system/edgecoder-agent-${inst.index}.service`, systemdAgentUnit(p, inst), 0o644);
      result.services.push(`edgecoder-ollama-${inst.index}.service`, `edgecoder-agent-${inst.index}.service`);
    }
    run("systemctl", ["daemon-reload"]);
    // enable --now does not restart a running unit, so a re-run with tokens would not take
    // effect; restart (which also starts) picks up the rewritten env files and units.
    run("systemctl", ["enable", ...result.services]);
    run("systemctl", ["restart", ...result.services]);
  } else if (host.platform === "darwin") {
    for (const inst of plan.instances) {
      for (const [label, content] of [[`io.edgecoder.ollama.${inst.index}`, launchdOllamaPlist(p, inst)], [`io.edgecoder.agent.${inst.index}`, launchdAgentPlist(p, inst)]] as const) {
        const path = `/Library/LaunchDaemons/${label}.plist`;
        write(path, content, 0o644);
        result.services.push(label);
        run("launchctl", ["bootout", "system", path]);
        run("launchctl", ["bootstrap", "system", path]);
        run("launchctl", ["enable", `system/${label}`]);
        run("launchctl", ["kickstart", "-k", `system/${label}`]);
      }
    }
  } else if (host.platform === "win32") {
    for (const inst of plan.instances) {
      const ollamaCmd = `${p.configDir}\\ollama-${inst.index}.cmd`;
      const agentCmd = `${p.configDir}\\agent-${inst.index}.cmd`;
      write(ollamaCmd, windowsOllamaCmd(p, inst));
      write(agentCmd, windowsAgentCmd(p, inst));
      for (const [name, cmd] of [[`EdgeCoder\\ollama-${inst.index}`, ollamaCmd], [`EdgeCoder\\agent-${inst.index}`, agentCmd]] as const) {
        result.services.push(name);
        run("schtasks", ["/Create", "/F", "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TN", name, "/TR", `"${cmd}"`]);
        run("schtasks", ["/Run", "/TN", name]);
      }
    }
  } else {
    throw new Error(`unsupported platform: ${host.platform}`);
  }
  return result;
}

export function removeServices(host: Host, p: ServicePaths, maxInstances = 32): string[] {
  const removed: string[] = [];
  for (let i = 0; i < maxInstances; i++) {
    const env = envFilePath(p, { index: i } as AgentInstance);
    if (!host.exists(env)) continue;
    if (host.platform === "linux") {
      for (const svc of [`edgecoder-agent-${i}.service`, `edgecoder-ollama-${i}.service`]) {
        host.run("systemctl", ["disable", "--now", svc]);
        host.removeFile(`/etc/systemd/system/${svc}`);
        removed.push(svc);
      }
    } else if (host.platform === "darwin") {
      for (const label of [`io.edgecoder.agent.${i}`, `io.edgecoder.ollama.${i}`]) {
        const path = `/Library/LaunchDaemons/${label}.plist`;
        host.run("launchctl", ["bootout", "system", path]);
        host.removeFile(path);
        removed.push(label);
      }
    } else if (host.platform === "win32") {
      for (const name of [`EdgeCoder\\agent-${i}`, `EdgeCoder\\ollama-${i}`]) {
        host.run("schtasks", ["/Delete", "/F", "/TN", name]);
        removed.push(name);
      }
      host.removeFile(`${p.configDir}\\agent-${i}.cmd`);
      host.removeFile(`${p.configDir}\\ollama-${i}.cmd`);
    }
    host.removeFile(env);
  }
  if (host.platform === "linux" && removed.length) host.run("systemctl", ["daemon-reload"]);
  return removed;
}

export function serviceStatus(host: Host, p: ServicePaths, maxInstances = 32): Array<{ name: string; state: string }> {
  const out: Array<{ name: string; state: string }> = [];
  for (let i = 0; i < maxInstances; i++) {
    if (!host.exists(envFilePath(p, { index: i } as AgentInstance))) continue;
    if (host.platform === "linux") {
      for (const svc of [`edgecoder-ollama-${i}.service`, `edgecoder-agent-${i}.service`]) out.push({ name: svc, state: host.run("systemctl", ["is-active", svc]).stdout.trim() || "unknown" });
    } else if (host.platform === "darwin") {
      for (const label of [`io.edgecoder.ollama.${i}`, `io.edgecoder.agent.${i}`]) out.push({ name: label, state: host.run("launchctl", ["print", `system/${label}`]).code === 0 ? "running" : "stopped" });
    } else if (host.platform === "win32") {
      for (const name of [`EdgeCoder\\ollama-${i}`, `EdgeCoder\\agent-${i}`]) {
        const r = host.run("schtasks", ["/Query", "/TN", name, "/FO", "LIST"]);
        const m = /Status:\s*(.+)/.exec(r.stdout);
        out.push({ name, state: r.code === 0 ? (m?.[1]?.trim() ?? "registered") : "missing" });
      }
    }
  }
  return out;
}
