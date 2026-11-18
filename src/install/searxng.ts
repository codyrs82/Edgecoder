// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Free web search for the owner's own chats, from the host itself (docs/web-tool.md, "Searches on
 * your own machine"): a SearXNG on 127.0.0.1 that the agent asks when its coordinator relays a
 * search for its owner (src/web-tool/local-web.ts). Linux (systemd) only for now; macOS and Windows
 * hosts keep EdgeCoder's servers (Brave) for every chat.
 *
 *   /opt/edgecoder/searxng/src-<commit>   SearXNG at a pinned commit: the GitHub archive, checked
 *                                         against SEARXNG_TARBALL_SHA256 before it is unpacked
 *   /opt/edgecoder/searxng/venv           a Python venv with requirements.lock installed by pip with
 *                                         --require-hashes --only-binary=:all: (every wheel hash-pinned)
 *   /etc/edgecoder/searxng/settings.yml   root-only (0600): 127.0.0.1, JSON on, its own secret_key
 *                                         (kept across runs), a few engines that need no keys
 *   edgecoder-searxng.service             DynamicUser, read-only system, the settings handed over as
 *                                         a systemd credential (the service user never owns them)
 * The download and the venv are scripts/linux/searxng/install-searxng.sh (root, re-runnable, does
 * nothing when the pinned commit is already there). The agent release carries only dist/, so the
 * script and the lock ride in searxng-assets.ts and are written to /opt/edgecoder/searxng/installer/
 * (root-owned) before it runs. What it writes and runs is decided here, so the exact unit and
 * settings are unit-tested.
 *
 * Why a venv and not a container: hosts run with and without Docker, and the agent's sandbox may
 * use Docker for code runs; a venv needs only python3 (3.10+, every supported Ubuntu/Debian) and
 * python3-venv, pins every dependency by hash, and runs under the same systemd hardening as the
 * agent. No compiler is needed (wheels only).
 *
 * Opt-out: `apply --searxng off` (or --no-searxng) writes EDGECODER_SEARXNG=off to
 * /etc/edgecoder/searxng.env; every later apply, `update` included, keeps it. Off stops and removes
 * the unit and drops SEARXNG_URL from the agents; the venv stays (like vLLM's), for a later on.
 * A failed install is not an apply failure: the agents fall back to EdgeCoder's servers.
 */
import type { Host, ServicePaths } from "./services.js";
import { SEARXNG_INSTALL_SCRIPT, SEARXNG_REQUIREMENTS_LOCK } from "./searxng-assets.js";

/** SearXNG at this commit (searxng/searxng, 2026-11-02, "[fix] brave api: set cache control header to no-cache"). */
export const SEARXNG_COMMIT = "cccbc9e158b0ac3bb2158e9841a647a5bec57b57";
/** sha256 of https://github.com/searxng/searxng/archive/<SEARXNG_COMMIT>.tar.gz */
export const SEARXNG_TARBALL_SHA256 = "fd685caeae4773d668c0fe8e8242986ca6a6e24ceb72449ff4fdf4abd8573a85";
export const SEARXNG_PREFIX = "/opt/edgecoder/searxng";
export const SEARXNG_PORT = 18888;
export const SEARXNG_URL = `http://127.0.0.1:${SEARXNG_PORT}`;
export const SEARXNG_SERVICE = "edgecoder-searxng.service";
export const SEARXNG_UNIT_PATH = `/etc/systemd/system/${SEARXNG_SERVICE}`;
export const SEARXNG_ENV_FILE = "searxng.env";
export const SEARXNG_KEY = "EDGECODER_SEARXNG";
/**
 * Engines that answer without API keys. Several, so one that blocks or changes its page doesn't
 * leave the owner without results (the agent falls back to EdgeCoder's servers when none answer).
 */
export const SEARXNG_ENGINES = ["duckduckgo", "brave", "mojeek", "startpage", "wikipedia"] as const;
/** Off by default upstream ("inactive"); turned on here. */
const SEARXNG_ACTIVATE = ["mojeek", "startpage"];

const OFF = /^(off|0|false|no|disabled?)$/i;

export function searxngSettingsDir(p: Pick<ServicePaths, "configDir">): string {
  return `${p.configDir}/searxng`;
}
export function searxngSettingsPath(p: Pick<ServicePaths, "configDir">): string {
  return `${searxngSettingsDir(p)}/settings.yml`;
}

/** On unless searxng.env says off (Linux only). */
export function searxngSetting(read: (path: string) => string | undefined, configDir: string): { enabled: boolean; source: string } {
  const path = `${configDir}/${SEARXNG_ENV_FILE}`;
  const text = read(path);
  const line = text?.split(/\r?\n/).reverse().find((l) => new RegExp(`^\\s*${SEARXNG_KEY}\\s*=`).test(l));
  if (line) {
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (OFF.test(value)) return { enabled: false, source: `${SEARXNG_KEY}=${value} in ${path}` };
  }
  return { enabled: true, source: "default" };
}

export function searxngEnvFile(enabled: boolean): string {
  return `# edgecoder-install: local web search (SearXNG on 127.0.0.1) for this host owner's own chats\n# (docs/web-tool.md). off removes it; every apply and update keeps this file.\n${SEARXNG_KEY}=${enabled ? "on" : "off"}\n`;
}

/** The secret_key of an existing settings.yml (64 hex characters), so a re-run keeps it. */
export function existingSecret(settings: string | undefined): string | undefined {
  const m = settings?.match(/^\s*secret_key:\s*"([0-9a-f]{64})"\s*$/m);
  return m?.[1];
}

/** settings.yml: upstream defaults, then loopback only, JSON on, no limiter, no metrics, a few keyless engines. */
export function searxngSettings(secret: string, port = SEARXNG_PORT): string {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("searxng secret must be 64 hex characters");
  return `# Written by edgecoder-install (src/install/searxng.ts); rewritten on every apply (the secret is kept).
# Local web search for this host owner's own EdgeCoder chats. Reachable from this machine only.
use_default_settings:
  engines:
    keep_only:
${SEARXNG_ENGINES.map((e) => `      - ${e}`).join("\n")}

general:
  instance_name: "EdgeCoder local search"
  debug: false
  enable_metrics: false

search:
  safe_search: 1
  autocomplete: ""
  formats:
    - html
    - json

server:
  bind_address: "127.0.0.1"
  port: ${port}
  base_url: false
  secret_key: "${secret}"
  # One user on loopback: SearXNG's limiter (bot detection for public instances, needs valkey) would
  # only refuse the agent. The agent itself caps calls (AGENT_LOCAL_WEB_PER_WINDOW) so the engines
  # don't see a burst from this IP, and the coordinator caps them per account and hour.
  limiter: false
  public_instance: false
  image_proxy: false
  method: "GET"

valkey:
  url: false

outgoing:
  request_timeout: 3.0
  max_request_timeout: 6.0
  pool_connections: 20
  pool_maxsize: 10

engines:
${SEARXNG_ACTIVATE.map((e) => `  - name: ${e}\n    inactive: false\n    disabled: false`).join("\n")}
`;
}

/** The unit: granian (SearXNG's own server) on 127.0.0.1 only, as a throwaway user, read-only system. */
export function systemdSearxngUnit(p: Pick<ServicePaths, "configDir">, port = SEARXNG_PORT): string {
  const src = `${SEARXNG_PREFIX}/current`;
  return `[Unit]
Description=EdgeCoder local web search (SearXNG on 127.0.0.1:${port}, for this host owner's own chats)
Documentation=https://github.com/codyrs82/Edgecoder/blob/main/docs/web-tool.md
After=network-online.target
Wants=network-online.target
ConditionPathExists=${SEARXNG_PREFIX}/venv/bin/granian

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=${src}
# The settings (with the secret) stay root-only; systemd hands this service a private copy.
LoadCredential=settings.yml:${searxngSettingsPath(p)}
Environment=PYTHONPATH=${src}
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=GRANIAN_INTERFACE=wsgi
Environment=GRANIAN_HOST=127.0.0.1
Environment=GRANIAN_PORT=${port}
Environment=GRANIAN_WORKERS=1
Environment=GRANIAN_BLOCKING_THREADS=4
Environment=GRANIAN_WEBSOCKETS=false
Environment=GRANIAN_PROCESS_NAME=edgecoder-searxng
ExecStart=/bin/sh -c 'SEARXNG_SETTINGS_PATH="$CREDENTIALS_DIRECTORY/settings.yml" exec ${SEARXNG_PREFIX}/venv/bin/granian searx.webapp:app'
Restart=on-failure
RestartSec=10
Nice=5
MemoryMax=768M
TasksMax=256
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
SystemCallArchitectures=native
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=edgecoder-searxng

[Install]
WantedBy=multi-user.target
`;
}

export const SEARXNG_INSTALLER_DIR = `${SEARXNG_PREFIX}/installer`;

/** install-searxng.sh (written by apply) with the pinned commit, checksum and lock. */
export function searxngInstallCommand(): [string, string[]] {
  return ["bash", [`${SEARXNG_INSTALLER_DIR}/install-searxng.sh`, "--commit", SEARXNG_COMMIT, "--sha256", SEARXNG_TARBALL_SHA256, "--lock", `${SEARXNG_INSTALLER_DIR}/requirements.lock`]];
}

/** Whether this run sets SearXNG up (and gives the agents SEARXNG_URL). */
export function searxngWanted(platform: NodeJS.Platform, flag: boolean | undefined, read: (path: string) => string | undefined, configDir: string): boolean {
  if (platform !== "linux") return false;
  return flag ?? searxngSetting(read, configDir).enabled;
}

/** Agent env lines for local search (none when it's off). */
export function searxngAgentEnv(wanted: boolean): Record<string, string> {
  return wanted ? { SEARXNG_URL } : {};
}

export interface SearxngResult {
  files: string[];
  commands: string[];
  /** One line for apply's output. */
  summary: string;
  /** SearXNG answered (or would, on a dry run). */
  ok: boolean;
}

/**
 * Set up (or turn off) local search. `flag`: --searxng given now (written to searxng.env); undefined
 * keeps the host's setting. `randomHex`: 32 random bytes as hex (a new secret when there is none).
 */
export function applySearxng(
  host: Host,
  p: ServicePaths,
  opts: { flag?: boolean; dryRun: boolean; read: (path: string) => string | undefined; randomHex: () => string },
): SearxngResult {
  const out: SearxngResult = { files: [], commands: [], summary: "", ok: false };
  const write = (path: string, content: string, mode: number) => {
    out.files.push(path);
    if (!opts.dryRun) host.writeFile(path, content, mode);
  };
  const run = (cmd: string, args: string[]): number => {
    out.commands.push([cmd, ...args].join(" "));
    return opts.dryRun ? 0 : host.run(cmd, args).code;
  };
  if (host.platform !== "linux") {
    out.summary = "Local web search: not on this platform yet; your own chats search through EdgeCoder's servers.";
    return out;
  }
  if (opts.flag !== undefined) write(`${p.configDir}/${SEARXNG_ENV_FILE}`, searxngEnvFile(opts.flag), 0o644);
  const setting = opts.flag !== undefined ? { enabled: opts.flag, source: `--searxng ${opts.flag ? "on" : "off"}` } : searxngSetting(opts.read, p.configDir);
  if (!setting.enabled) {
    if (host.exists(SEARXNG_UNIT_PATH)) {
      run("systemctl", ["disable", "--now", SEARXNG_SERVICE]);
      out.commands.push(`rm -f ${SEARXNG_UNIT_PATH}`);
      if (!opts.dryRun) host.removeFile(SEARXNG_UNIT_PATH);
      run("systemctl", ["daemon-reload"]);
    }
    out.summary = `Local web search: off (${setting.source}); turn on with: sudo edgecoder-install apply --searxng on`;
    return out;
  }
  const secret = existingSecret(opts.read(searxngSettingsPath(p))) ?? opts.randomHex();
  write(searxngSettingsPath(p), searxngSettings(secret), 0o600);
  write(SEARXNG_UNIT_PATH, systemdSearxngUnit(p), 0o644);
  write(`${SEARXNG_INSTALLER_DIR}/install-searxng.sh`, SEARXNG_INSTALL_SCRIPT, 0o700);
  write(`${SEARXNG_INSTALLER_DIR}/requirements.lock`, SEARXNG_REQUIREMENTS_LOCK, 0o644);
  const [cmd, args] = searxngInstallCommand();
  if (run(cmd, args) !== 0) {
    // Not an apply failure: the agents use EdgeCoder's servers until a later run gets it installed.
    run("systemctl", ["disable", "--now", SEARXNG_SERVICE]);
    out.summary = `Local web search: not installed this time (see the messages above); your own chats search through EdgeCoder's servers. Retry with: sudo edgecoder-install apply, or turn it off with --searxng off`;
    return out;
  }
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["enable", SEARXNG_SERVICE]);
  // Restart: a new commit, settings or unit take effect now.
  run("systemctl", ["restart", SEARXNG_SERVICE]);
  out.ok = true;
  out.summary = `Local web search: on (SearXNG on ${SEARXNG_URL}, ${SEARXNG_SERVICE}); free for your own chats. Turn off with: sudo edgecoder-install apply --searxng off`;
  return out;
}

/** `remove`: the service goes with the others (the venv stays, like the models). */
export function removeSearxng(host: Host): string[] {
  if (host.platform !== "linux" || !host.exists(SEARXNG_UNIT_PATH)) return [];
  host.run("systemctl", ["disable", "--now", SEARXNG_SERVICE]);
  host.removeFile(SEARXNG_UNIT_PATH);
  return [SEARXNG_SERVICE];
}
