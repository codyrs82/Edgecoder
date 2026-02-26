/**
 * Cross-platform detection utility for EdgeCoder.
 *
 * Every function accepts optional overrides so callers (and tests) can
 * exercise any platform path without actually running on that OS.
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PlatformOS = "macos" | "linux" | "windows" | "ios" | "android";
export type PlatformArch = "x64" | "arm64" | "arm";
export type PackageManager = "apt" | "dnf" | "brew" | "choco" | "none";
export type Shell = "bash" | "zsh" | "powershell" | "cmd";

export interface PlatformInfo {
  os: PlatformOS;
  arch: PlatformArch;
  isDocker: boolean;
  isWSL: boolean;
  hasSystemd: boolean;
  packageManager: PackageManager;
  shell: Shell;
}

// ---------------------------------------------------------------------------
// Override helpers (for testability)
// ---------------------------------------------------------------------------

export interface PlatformOverrides {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
  fileRead?: (path: string) => string;
  commandExists?: (cmd: string) => boolean;
  homeDir?: string;
}

function _platform(overrides?: PlatformOverrides): NodeJS.Platform {
  return overrides?.platform ?? process.platform;
}

function _arch(overrides?: PlatformOverrides): NodeJS.Architecture {
  return overrides?.arch ?? process.arch;
}

function _env(overrides?: PlatformOverrides): Record<string, string | undefined> {
  return overrides?.env ?? (process.env as Record<string, string | undefined>);
}

function _fileExists(path: string, overrides?: PlatformOverrides): boolean {
  if (overrides?.fileExists) return overrides.fileExists(path);
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function _fileRead(path: string, overrides?: PlatformOverrides): string {
  if (overrides?.fileRead) return overrides.fileRead(path);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function _commandExists(cmd: string, overrides?: PlatformOverrides): boolean {
  if (overrides?.commandExists) return overrides.commandExists(cmd);
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execSync(`${which} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function _homeDir(overrides?: PlatformOverrides): string {
  return overrides?.homeDir ?? homedir();
}

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

/**
 * Detect the operating system. Returns a normalised PlatformOS value.
 */
export function detectOS(overrides?: PlatformOverrides): PlatformOS {
  const p = _platform(overrides);
  switch (p) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "android":
      return "android";
    default:
      // Best-effort fallback
      return "linux";
  }
}

/**
 * Normalise the CPU architecture to one of the supported values.
 */
export function detectArch(overrides?: PlatformOverrides): PlatformArch {
  const a = _arch(overrides);
  switch (a) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "arm":
      return "arm";
    default:
      return "x64";
  }
}

/**
 * Check whether we are running inside a Docker container.
 *
 * Heuristics:
 *  1. /.dockerenv exists
 *  2. /proc/1/cgroup mentions "docker" or "containerd"
 */
export function isDockerEnvironment(overrides?: PlatformOverrides): boolean {
  if (_fileExists("/.dockerenv", overrides)) return true;
  const cgroup = _fileRead("/proc/1/cgroup", overrides);
  if (cgroup && (/docker/i.test(cgroup) || /containerd/i.test(cgroup))) return true;
  return false;
}

/**
 * Check whether we are running inside Windows Subsystem for Linux.
 *
 * Heuristic: /proc/version contains "Microsoft" or "WSL".
 */
export function isWSL(overrides?: PlatformOverrides): boolean {
  const version = _fileRead("/proc/version", overrides);
  return /Microsoft|WSL/i.test(version);
}

/**
 * Check whether systemd is available (systemctl on PATH).
 */
export function hasSystemd(overrides?: PlatformOverrides): boolean {
  return _commandExists("systemctl", overrides);
}

/**
 * Detect the most likely package manager on the current platform.
 */
export function getPackageManager(overrides?: PlatformOverrides): PackageManager {
  const os = detectOS(overrides);
  switch (os) {
    case "macos":
      return _commandExists("brew", overrides) ? "brew" : "none";
    case "windows":
      return _commandExists("choco", overrides) ? "choco" : "none";
    case "linux": {
      if (_commandExists("apt-get", overrides)) return "apt";
      if (_commandExists("dnf", overrides)) return "dnf";
      if (_commandExists("brew", overrides)) return "brew";
      return "none";
    }
    default:
      return "none";
  }
}

/**
 * Detect the current default shell.
 */
export function detectShell(overrides?: PlatformOverrides): Shell {
  const env = _env(overrides);
  const os = detectOS(overrides);

  if (os === "windows") {
    // PSModulePath is a reliable indicator of PowerShell
    if (env.PSModulePath) return "powershell";
    return "cmd";
  }

  const shellEnv = env.SHELL ?? "";
  if (shellEnv.endsWith("/zsh") || shellEnv.endsWith("/zsh.exe")) return "zsh";
  if (shellEnv.endsWith("/bash") || shellEnv.endsWith("/bash.exe")) return "bash";

  // Fallback: bash on unix-likes, cmd on windows
  return os === "windows" ? "cmd" : "bash";
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * Platform-appropriate configuration directory.
 *
 * - Linux : $XDG_CONFIG_HOME/edgecoder  (default ~/.config/edgecoder)
 * - macOS : ~/Library/Application Support/EdgeCoder
 * - Windows: %APPDATA%\EdgeCoder
 */
export function getConfigDir(overrides?: PlatformOverrides): string {
  const os = detectOS(overrides);
  const env = _env(overrides);
  const home = _homeDir(overrides);

  switch (os) {
    case "linux":
    case "android": {
      const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
      return join(xdg, "edgecoder");
    }
    case "macos":
    case "ios":
      return join(home, "Library", "Application Support", "EdgeCoder");
    case "windows": {
      const appdata = env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appdata, "EdgeCoder");
    }
  }
}

/**
 * Platform-appropriate log directory.
 *
 * - Linux : /var/log/edgecoder  (system-wide) or $XDG_STATE_HOME/edgecoder/logs
 * - macOS : ~/Library/Logs/EdgeCoder
 * - Windows: %LOCALAPPDATA%\EdgeCoder\logs
 */
export function getLogDir(overrides?: PlatformOverrides): string {
  const os = detectOS(overrides);
  const env = _env(overrides);
  const home = _homeDir(overrides);

  switch (os) {
    case "linux":
    case "android": {
      const xdgState = env.XDG_STATE_HOME ?? join(home, ".local", "state");
      return join(xdgState, "edgecoder", "logs");
    }
    case "macos":
    case "ios":
      return join(home, "Library", "Logs", "EdgeCoder");
    case "windows": {
      const localAppdata = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      return join(localAppdata, "EdgeCoder", "logs");
    }
  }
}

/**
 * Platform-appropriate data directory.
 *
 * - Linux : $XDG_DATA_HOME/edgecoder  (default ~/.local/share/edgecoder)
 * - macOS : ~/Library/Application Support/EdgeCoder/data
 * - Windows: %LOCALAPPDATA%\EdgeCoder\data
 */
export function getDataDir(overrides?: PlatformOverrides): string {
  const os = detectOS(overrides);
  const env = _env(overrides);
  const home = _homeDir(overrides);

  switch (os) {
    case "linux":
    case "android": {
      const xdgData = env.XDG_DATA_HOME ?? join(home, ".local", "share");
      return join(xdgData, "edgecoder");
    }
    case "macos":
    case "ios":
      return join(home, "Library", "Application Support", "EdgeCoder", "data");
    case "windows": {
      const localAppdata = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      return join(localAppdata, "EdgeCoder", "data");
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregate detector
// ---------------------------------------------------------------------------

/**
 * Return a complete PlatformInfo snapshot.
 */
export function detectPlatform(overrides?: PlatformOverrides): PlatformInfo {
  return {
    os: detectOS(overrides),
    arch: detectArch(overrides),
    isDocker: isDockerEnvironment(overrides),
    isWSL: isWSL(overrides),
    hasSystemd: hasSystemd(overrides),
    packageManager: getPackageManager(overrides),
    shell: detectShell(overrides),
  };
}
