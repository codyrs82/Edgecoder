// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * When `edgecoder-install update --scheduled` runs (update.ts), and how a host turns it off.
 *   Linux   edgecoder-update.service (oneshot, as root) + edgecoder-update.timer: every hour,
 *           RandomizedDelaySec=10min so a fleet does not update at once, Persistent=true so a
 *           missed run happens after boot. edgecoder-update.path starts the same service when an
 *           agent writes its update-request file (the coordinator's nudge, src/swarm/update-nudge.ts).
 *   macOS   /Library/LaunchDaemons/io.edgecoder.update.plist (root): every hour, with up to 10
 *           minutes of jitter inside the run (launchd has no randomized delay), and WatchPaths on
 *           the agents' update-request files for the nudge.
 *   Windows not yet: the agents are scheduled tasks of the installing user, and replacing
 *           C:\Program Files\EdgeCoder\app needs an elevated task; re-run install.ps1 to update.
 * The nudge only starts the same scheduled check early: the updater never reads the request file
 * (the agent is unprivileged and its HOME untrusted), runs the same signed-release flow, and does
 * nothing when it checked less than MIN_SCHEDULED_GAP_MS ago (update.ts).
 * Only a signed release install (its app dir has edgecoder-release.json) gets the schedule: a
 * .deb/.pkg is updated by its package manager and a --from-source install by hand.
 *
 * Opt-out: EDGECODER_AUTO_UPDATE=off in /etc/edgecoder/auto-update.env (`apply --auto-update off`
 * writes it; every later apply keeps it), or in any other /etc/edgecoder/*.env. Then the timer is
 * disabled and a scheduled run does nothing; `sudo edgecoder-install update` still updates by hand.
 */
import type { Host, ServicePaths } from "./services.js";

export const AUTO_UPDATE_ENV_FILE = "auto-update.env";
export const AUTO_UPDATE_KEY = "EDGECODER_AUTO_UPDATE";
export const UPDATE_SERVICE = "edgecoder-update.service";
export const UPDATE_TIMER = "edgecoder-update.timer";
export const UPDATE_PATH_UNIT = "edgecoder-update.path";
/** Written by an agent in its own HOME (stateDir/agent-<n>) to ask for an early check (update-nudge.ts). */
export const UPDATE_REQUEST_FILE = "update-request";
export const UPDATE_LAUNCHD_LABEL = "io.edgecoder.update";
export const UPDATE_INTERVAL_SEC = 3600;
export const UPDATE_JITTER_SEC = 600;

const OFF = /^(off|0|false|no|disabled?)$/i;

/** Whether scheduled updates are on, and which file says so. Default on. */
export function autoUpdateSetting(read: (path: string) => string | undefined, listDir: (dir: string) => string[], configDir: string): { enabled: boolean; source: string } {
  const sep = configDir.includes("\\") ? "\\" : "/";
  let names: string[] = [];
  try {
    names = listDir(configDir).filter((n) => n.endsWith(".env")).sort();
  } catch {
    names = [];
  }
  // auto-update.env first: it is the file this setting lives in.
  names = [AUTO_UPDATE_ENV_FILE, ...names.filter((n) => n !== AUTO_UPDATE_ENV_FILE)];
  for (const name of names) {
    const text = read(`${configDir}${sep}${name}`);
    if (!text) continue;
    const line = text.split(/\r?\n/).reverse().find((l) => new RegExp(`^\\s*${AUTO_UPDATE_KEY}\\s*=`).test(l));
    if (!line) continue;
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (OFF.test(value)) return { enabled: false, source: `${AUTO_UPDATE_KEY}=${value} in ${configDir}${sep}${name}` };
  }
  return { enabled: true, source: "default; EDGECODER_AUTO_UPDATE=off in " + `${configDir}${sep}${AUTO_UPDATE_ENV_FILE}` + " turns it off" };
}

export function autoUpdateEnvFile(enabled: boolean): string {
  return `# edgecoder-install: scheduled agent updates (docs/install.md, "Updates"). off disables the timer;\n# sudo edgecoder-install update still updates by hand. Every apply keeps this file.\n${AUTO_UPDATE_KEY}=${enabled ? "on" : "off"}\n`;
}

export function updateCommand(p: Pick<ServicePaths, "nodeBin" | "appDir" | "configDir">): string[] {
  return [p.nodeBin, `${p.appDir}/dist/install/cli.js`, "update", "--scheduled", "--config-dir", p.configDir];
}

export function systemdUpdateService(p: Pick<ServicePaths, "nodeBin" | "appDir" | "configDir">): string {
  return `[Unit]
Description=EdgeCoder agent update (signed releases only)
Documentation=https://github.com/codyrs82/Edgecoder/blob/main/docs/install.md#updates
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Root: it replaces the root-owned app dir and restarts the agents. It runs only code that verified
# against the release key pinned in the installed app (src/install/release-key.ts).
ExecStart=${updateCommand(p).join(" ")}
# Up to 10 minutes waiting for running work, the download, and the health check.
TimeoutStartSec=45min
Nice=10
PrivateTmp=yes
ProtectHome=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=edgecoder-update
`;
}

/** The update-request file of each agent instance (they live in stateDir/agent-<n>, services.ts). */
export function updateRequestPaths(p: Pick<ServicePaths, "stateDir">, instances: number[]): string[] {
  return [...new Set(instances)].sort((a, b) => a - b).map((n) => `${p.stateDir}/agent-${n}/${UPDATE_REQUEST_FILE}`);
}

export function systemdUpdateTimer(): string {
  return `[Unit]
Description=EdgeCoder agent update check, every hour

[Timer]
OnCalendar=hourly
RandomizedDelaySec=10min
Persistent=true
Unit=${UPDATE_SERVICE}

[Install]
WantedBy=timers.target
`;
}

/**
 * Starts edgecoder-update.service when an agent writes its update-request file. Root never reads or
 * writes that file; systemd only watches it. The service is the timer's own (one run at a time),
 * and the updater ignores a start that comes less than MIN_SCHEDULED_GAP_MS after its last check.
 */
export function systemdUpdatePath(requestPaths: string[]): string {
  return `[Unit]
Description=EdgeCoder agent update check, early when an agent hears of a newer release
Documentation=https://github.com/codyrs82/Edgecoder/blob/main/docs/install.md#updates

[Path]
${requestPaths.map((r) => `PathModified=${r}`).join("\n")}
Unit=${UPDATE_SERVICE}

[Install]
WantedBy=paths.target
`;
}

export function launchdUpdatePlist(p: Pick<ServicePaths, "nodeBin" | "appDir" | "configDir" | "logDir">, requestPaths: string[] = []): string {
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const args = [...updateCommand(p), "--jitter", String(UPDATE_JITTER_SEC)];
  // The agents' nudge: launchd starts the job when one writes its update-request file.
  const watch = requestPaths.length
    ? `
    <key>WatchPaths</key>
    <array>
${requestPaths.map((r) => `      <string>${xml(r)}</string>`).join("\n")}
    </array>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${UPDATE_LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((a) => `      <string>${xml(a)}</string>`).join("\n")}
    </array>
    <key>StartInterval</key>
    <integer>${UPDATE_INTERVAL_SEC}</integer>${watch}
    <key>RunAtLoad</key>
    <false/>
    <key>LowPriorityIO</key>
    <true/>
    <key>Nice</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(p.logDir)}/${UPDATE_LAUNCHD_LABEL}.log</string>
    <key>StandardErrorPath</key>
    <string>${xml(p.logDir)}/${UPDATE_LAUNCHD_LABEL}.log</string>
  </dict>
</plist>
`;
}

export interface ScheduleResult {
  files: string[];
  commands: string[];
  /** One line for apply's output. */
  summary: string;
}

/**
 * Install (or turn off) the update schedule. `flag`: --auto-update on|off given now (written to
 * auto-update.env); undefined keeps what the host has. `releaseInstall`: the app dir is a signed
 * release; otherwise nothing is scheduled.
 */
export function applyUpdateSchedule(host: Host, p: ServicePaths, opts: { flag?: boolean; releaseInstall: boolean; dryRun: boolean; insideUpdate?: boolean; read: (path: string) => string | undefined; listDir: (dir: string) => string[]; /** Agent instance indices: their update-request files are watched for the nudge. */ instances?: number[] }): ScheduleResult {
  const requests = updateRequestPaths(p, opts.instances ?? []);
  const out: ScheduleResult = { files: [], commands: [], summary: "" };
  const write = (path: string, content: string, mode: number) => {
    out.files.push(path);
    if (!opts.dryRun) host.writeFile(path, content, mode);
  };
  const run = (cmd: string, args: string[]) => {
    out.commands.push([cmd, ...args].join(" "));
    if (!opts.dryRun) host.run(cmd, args);
  };
  if (host.platform !== "linux" && host.platform !== "darwin") {
    out.summary = "Automatic updates: not supported on Windows yet; re-run install.ps1 to update.";
    return out;
  }
  if (opts.flag !== undefined) write(`${p.configDir}/${AUTO_UPDATE_ENV_FILE}`, autoUpdateEnvFile(opts.flag), 0o644);
  const setting = opts.flag !== undefined
    ? { enabled: opts.flag, source: `--auto-update ${opts.flag ? "on" : "off"}` }
    : autoUpdateSetting(opts.read, opts.listDir, p.configDir);
  const on = opts.releaseInstall && setting.enabled;
  if (host.platform === "linux") {
    const service = `/etc/systemd/system/${UPDATE_SERVICE}`;
    const timer = `/etc/systemd/system/${UPDATE_TIMER}`;
    const pathUnit = `/etc/systemd/system/${UPDATE_PATH_UNIT}`;
    if (opts.releaseInstall) {
      write(service, systemdUpdateService(p), 0o644);
      write(timer, systemdUpdateTimer(), 0o644);
      if (requests.length) write(pathUnit, systemdUpdatePath(requests), 0o644);
      run("systemctl", ["daemon-reload"]);
      if (on) run("systemctl", ["enable", "--now", UPDATE_TIMER]);
      else run("systemctl", ["disable", "--now", UPDATE_TIMER]);
      // restart, not start: a running path unit keeps watching the old instances' files.
      if (on && requests.length) {
        run("systemctl", ["enable", UPDATE_PATH_UNIT]);
        run("systemctl", ["restart", UPDATE_PATH_UNIT]);
      }
      else if (host.exists(pathUnit)) run("systemctl", ["disable", "--now", UPDATE_PATH_UNIT]);
    } else {
      if (host.exists(timer)) run("systemctl", ["disable", "--now", UPDATE_TIMER]);
      if (host.exists(pathUnit)) run("systemctl", ["disable", "--now", UPDATE_PATH_UNIT]);
    }
  } else {
    // Booting the job out kills its processes, and an update's own apply runs inside that job
    // (insideUpdate): then the plist is only rewritten, and launchd reads it at the next boot or apply.
    const path = `/Library/LaunchDaemons/${UPDATE_LAUNCHD_LABEL}.plist`;
    const content = launchdUpdatePlist(p, requests);
    if (on) {
      const same = opts.read(path) === content;
      if (!same) write(path, content, 0o644);
      if (!opts.insideUpdate && !same) {
        run("launchctl", ["bootout", "system", path]);
        run("launchctl", ["bootstrap", "system", path]);
      } else if (!opts.insideUpdate && host.run("launchctl", ["print", `system/${UPDATE_LAUNCHD_LABEL}`]).code !== 0) {
        run("launchctl", ["bootstrap", "system", path]);
      }
      if (!opts.insideUpdate) run("launchctl", ["enable", `system/${UPDATE_LAUNCHD_LABEL}`]);
    } else if (host.exists(path)) {
      if (!opts.insideUpdate) run("launchctl", ["bootout", "system", path]);
      out.commands.push(`rm -f ${path}`);
      if (!opts.dryRun) host.removeFile(path);
    }
  }
  out.summary = !opts.releaseInstall
    ? `Automatic updates: off (${p.appDir} is not a signed release install; update it the way it was installed).`
    : on
      ? `Automatic updates: on, every hour and when the coordinator announces a release (${host.platform === "linux" ? `${UPDATE_TIMER}, ${UPDATE_PATH_UNIT}` : UPDATE_LAUNCHD_LABEL}); turn off with: sudo edgecoder-install apply --auto-update off`
      : `Automatic updates: off (${setting.source}); update by hand with: sudo edgecoder-install update`;
  return out;
}

/** `remove`: the schedule goes with the services. */
export function removeUpdateSchedule(host: Host): string[] {
  if (host.platform === "linux") {
    host.run("systemctl", ["disable", "--now", UPDATE_TIMER]);
    host.run("systemctl", ["disable", "--now", UPDATE_PATH_UNIT]);
    host.removeFile(`/etc/systemd/system/${UPDATE_TIMER}`);
    host.removeFile(`/etc/systemd/system/${UPDATE_PATH_UNIT}`);
    host.removeFile(`/etc/systemd/system/${UPDATE_SERVICE}`);
    return [UPDATE_TIMER, UPDATE_PATH_UNIT, UPDATE_SERVICE];
  }
  if (host.platform === "darwin") {
    const path = `/Library/LaunchDaemons/${UPDATE_LAUNCHD_LABEL}.plist`;
    host.run("launchctl", ["bootout", "system", path]);
    host.removeFile(path);
    return [UPDATE_LAUNCHD_LABEL];
  }
  return [];
}

/** "edgecoder-update.timer active, next ..." for status; null when there is none. */
export function timerStatus(host: Host): string | null {
  if (host.platform === "linux") {
    const state = host.run("systemctl", ["is-active", UPDATE_TIMER]).stdout.trim();
    if (!state || state === "unknown") return null;
    const next = host.run("systemctl", ["show", UPDATE_TIMER, "-p", "NextElapseUSecRealtime", "--value"]).stdout.trim();
    return `${UPDATE_TIMER} ${state}${next && state === "active" ? `, next run ${next}` : ""}`;
  }
  if (host.platform === "darwin") {
    return host.run("launchctl", ["print", `system/${UPDATE_LAUNCHD_LABEL}`]).code === 0 ? `${UPDATE_LAUNCHD_LABEL} loaded` : null;
  }
  return null;
}
