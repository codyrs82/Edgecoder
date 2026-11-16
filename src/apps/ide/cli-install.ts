// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings > General > "Install command-line tool": puts an `edgecoder` launcher on the PATH that
 * runs the agent bundled inside the desktop app with the app's own Node
 * (`<Resources>/agent/node/node <Resources>/agent/dist/cli/edgecoder.js`).
 *
 *   macOS, Linux  ~/.local/bin/edgecoder (a /bin/sh script, 0755)
 *   Windows       %LOCALAPPDATA%\EdgeCoder\bin\edgecoder.cmd
 *
 * An existing file is replaced only when it is an EdgeCoder launcher (it runs dist/cli/edgecoder.js);
 * anything else there is left alone and reported. The answer says whether the folder is on PATH.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export interface CliInstallInput {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The bundled agent folder (holds node/ and dist/); default: the one this file runs from. */
  agentDir?: string;
}

export interface CliInstallResult {
  ok: boolean;
  path: string;
  dir: string;
  /** "installed", "updated" (an EdgeCoder launcher was replaced), "unchanged", or why not. */
  state: "installed" | "updated" | "unchanged" | "exists_other" | "no_agent";
  onPath: boolean;
  message: string;
}

/** The agent folder this provider runs from: <agent>/dist/apps/ide/cli-install.js → <agent>. */
export function bundledAgentDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function launcherPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): { dir: string; file: string } {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    const dir = win32.join(base, "EdgeCoder", "bin");
    return { dir, file: win32.join(dir, "edgecoder.cmd") };
  }
  const dir = join(home, ".local", "bin");
  return { dir, file: join(dir, "edgecoder") };
}

/** The launcher's text: the same shape as the hand-made one (sh on macOS and Linux, cmd on Windows). */
export function launcherContent(platform: NodeJS.Platform, agentDir: string): string {
  if (platform === "win32") {
    return [
      "@echo off",
      "rem EdgeCoder CLI launcher: runs the agent bundled inside the desktop app with the app's own Node.",
      `set "APP=${agentDir}"`,
      'if not exist "%APP%\\node\\node.exe" (echo EdgeCoder app not found at %APP% 1>&2 & exit /b 1)',
      '"%APP%\\node\\node.exe" "%APP%\\dist\\cli\\edgecoder.js" %*',
      "",
    ].join("\r\n");
  }
  const where = platform === "darwin" && agentDir.startsWith("/Applications/") ? "in /Applications" : `at ${agentDir}`;
  return [
    "#!/bin/sh",
    "# EdgeCoder CLI launcher: runs the agent bundled inside the desktop app with the app's own Node.",
    `APP="${agentDir.replace(/(["\\$`])/g, "\\$1")}"`,
    `[ -x "$APP/node/node" ] || { echo "EdgeCoder app not found ${where}" >&2; exit 1; }`,
    'exec "$APP/node/node" "$APP/dist/cli/edgecoder.js" "$@"',
    "",
  ].join("\n");
}

/** An EdgeCoder launcher (ours, or the hand-made one of the same shape) may be replaced. */
export function isEdgecoderLauncher(text: string): boolean {
  return /dist[\\/]cli[\\/]edgecoder\.js/.test(text) && /EdgeCoder/i.test(text) && text.length < 4096;
}

export function dirOnPath(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const raw = (platform === "win32" ? env.Path ?? env.PATH : env.PATH) ?? "";
  const sep = platform === "win32" ? ";" : delimiter;
  const norm = (p: string) => (platform === "win32" ? p.replace(/[\\/]+$/, "").toLowerCase() : p.replace(/\/+$/, ""));
  return raw.split(sep).filter(Boolean).some((p) => norm(p) === norm(dir));
}

export function installCli(input: CliInstallInput = {}): CliInstallResult {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  const agentDir = input.agentDir ?? bundledAgentDir();
  const { dir, file } = launcherPath(platform, home, env);
  const onPath = dirOnPath(dir, env, platform);
  const pathHint = onPath
    ? `${dir} is on your PATH: open a new terminal and run edgecoder code.`
    : platform === "win32"
      ? `${dir} is not on your PATH yet: add it in System Properties > Environment Variables, then open a new terminal.`
      : `${dir} is not on your PATH yet: add  export PATH="$HOME/.local/bin:$PATH"  to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal.`;
  const node = join(agentDir, "node", platform === "win32" ? "node.exe" : "node");
  if (!existsSync(join(agentDir, "dist", "cli", "edgecoder.js")) || !existsSync(node)) {
    return { ok: false, path: file, dir, state: "no_agent", onPath, message: `The app's bundled agent wasn't found at ${agentDir}. Install the EdgeCoder app, then try again.` };
  }
  const content = launcherContent(platform, agentDir);
  let state: CliInstallResult["state"] = "installed";
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    if (current === content) return { ok: true, path: file, dir, state: "unchanged", onPath, message: `edgecoder is already installed at ${file}. ${pathHint}` };
    if (!isEdgecoderLauncher(current)) {
      return { ok: false, path: file, dir, state: "exists_other", onPath, message: `${file} already exists and isn't an EdgeCoder launcher, so it was left alone. Move it away and try again.` };
    }
    state = "updated";
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o755 });
  renameSync(tmp, file);
  if (platform !== "win32") chmodSync(file, 0o755);
  return { ok: true, path: file, dir, state, onPath, message: `${state === "updated" ? "Updated" : "Installed"} edgecoder at ${file}. ${pathHint}` };
}

/** Status without writing (Settings shows it before the button is pressed). */
export function cliStatus(input: CliInstallInput = {}): { path: string; dir: string; installed: boolean; ours: boolean; onPath: boolean } {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const { dir, file } = launcherPath(platform, input.home ?? homedir(), env);
  const installed = existsSync(file);
  let ours = false;
  try {
    ours = installed && isEdgecoderLauncher(readFileSync(file, "utf8"));
  } catch {
    ours = false;
  }
  return { path: file, dir, installed, ours, onPath: dirOnPath(dir, env, platform) };
}
