// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";
import { OLLAMA_ASSETS, OLLAMA_VERSION, ollamaAssetUrl, ollamaTargetFor, type OllamaAsset } from "../install/ollama-pins.js";

// ---------------------------------------------------------------------------
// Public interface (signature-stable; platform field is additive/optional)
// ---------------------------------------------------------------------------

export type OllamaPlatform = "macos" | "debian" | "ubuntu" | "windows" | "ios";

export interface OllamaInstallOptions {
  enabled: boolean;
  autoInstall: boolean;
  model: string;
  role: "coordinator" | "agent";
  host?: string;
  /** Caller passes AGENT_OS value. Derived from os.platform() if absent. */
  platform?: OllamaPlatform;
  /** Install the Ollama binary when it is missing (default true). Coordinator-directed switches pass false. */
  allowBinaryInstall?: boolean;
}

/**
 * Model names a coordinator may ask an agent to pull: Ollama library names only, `name[:tag]` or
 * `namespace/name[:tag]`. A first segment with '.' or ':' names another registry host and is refused.
 */
const OLLAMA_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const OLLAMA_TAG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
export function isOllamaLibraryModelName(model: unknown): model is string {
  if (typeof model !== "string" || model.length === 0 || model.length > 200) return false;
  const colon = model.indexOf(":");
  const name = colon >= 0 ? model.slice(0, colon) : model;
  const tag = colon >= 0 ? model.slice(colon + 1) : undefined;
  if (tag !== undefined && !OLLAMA_TAG.test(tag)) return false;
  const segs = name.split("/");
  if (segs.length > 2) return false;
  if (segs.length === 2 && segs[0].includes(".")) return false;
  return segs.every((s) => OLLAMA_SEGMENT.test(s));
}

export type OllamaStatusCallback = (phase: string, message: string, progressPct?: number) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePlatform(declared?: OllamaPlatform): OllamaPlatform {
  if (declared) return declared;
  const p = os.platform();
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "debian";
}

function log(role: string, message: string): void {
  console.log(`[${role}] ollama: ${message}`);
}

function ollamaApiBase(host?: string): string {
  if (host) {
    return host.startsWith("http") ? host.replace(/\/$/, "") : `http://${host}`;
  }
  return "http://127.0.0.1:11434";
}

// ---------------------------------------------------------------------------
// runCommand – resolves when process exits 0, rejects otherwise
// ---------------------------------------------------------------------------

function runCommand(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  opts?: { silent?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(env ?? {}) },
      stdio: opts?.silent ? "pipe" : "inherit"
    });

    let stderr = "";
    if (opts?.silent) {
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr || `${cmd} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

function sanitizeTerminalLine(line: string): string {
  return line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Phase 2: Binary detection and installation
// ---------------------------------------------------------------------------

/** Where the pinned archive is unpacked when EdgeCoder installs Ollama itself (no root needed). */
export function defaultOllamaInstallDir(platform: NodeJS.Platform = os.platform()): string {
  if (process.env.EDGECODER_OLLAMA_DIR) return process.env.EDGECODER_OLLAMA_DIR;
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "EdgeCoder", "ollama");
  }
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "EdgeCoder", "ollama");
  return path.join(os.homedir(), ".local", "share", "edgecoder", "ollama");
}

/** The binary inside an unpacked archive (Linux archives hold bin/ + lib/; macOS and Windows are flat). */
export function ollamaBinaryIn(dir: string, platform: NodeJS.Platform = os.platform()): string {
  if (platform === "win32") return path.join(dir, "ollama.exe");
  if (platform === "darwin") return path.join(dir, "ollama");
  return path.join(dir, "bin", "ollama");
}

/** The `ollama` command to run: PATH's, unless EdgeCoder installed its own pinned copy. */
let ollamaCmd = "ollama";
function adoptOwnInstallIfPresent(): void {
  const own = ollamaBinaryIn(defaultOllamaInstallDir());
  if (existsSync(own)) ollamaCmd = own;
}

async function isOllamaInstalled(env?: NodeJS.ProcessEnv): Promise<boolean> {
  for (const adoptOwn of [false, true]) {
    if (adoptOwn) adoptOwnInstallIfPresent();
    try {
      await runCommand(ollamaCmd, ["--version"], env, { silent: true });
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/** Download over https only, following redirects; rejects on a non-2xx response. */
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fetchUrl = (targetUrl: string, redirects: number) => {
      if (!targetUrl.startsWith("https://")) return reject(new Error(`refusing non-https download: ${targetUrl}`));
      if (redirects > 10) return reject(new Error("too many redirects"));
      https
        .get(targetUrl, (response) => {
          const code = response.statusCode ?? 0;
          if (code >= 300 && code < 400) {
            const location = response.headers.location;
            response.resume();
            if (!location) return reject(new Error("Redirect with no Location header"));
            fetchUrl(new URL(location, targetUrl).toString(), redirects + 1);
            return;
          }
          if (code < 200 || code >= 300) {
            response.resume();
            return reject(new Error(`download failed (${code}): ${targetUrl}`));
          }
          const file = createWriteStream(destPath);
          file.on("error", reject);
          response.on("error", reject);
          response.pipe(file);
          file.on("finish", () => { file.close(); resolve(); });
        })
        .on("error", reject);
    };
    fetchUrl(url, 0);
  });
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function extractArchive(archive: string, destDir: string): Promise<void> {
  if (archive.endsWith(".tar.zst")) return runCommand("tar", ["--zstd", "-xf", archive, "-C", destDir], undefined, { silent: true });
  if (archive.endsWith(".tgz")) return runCommand("tar", ["-xzf", archive, "-C", destDir], undefined, { silent: true });
  // Windows 10+ ships bsdtar, which reads zip archives.
  return runCommand("tar", ["-xf", archive, "-C", destDir], undefined, { silent: true });
}

export interface PinnedOllamaInstallDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  destDir?: string;
  download?: (url: string, destPath: string) => Promise<void>;
  extract?: (archive: string, destDir: string) => Promise<void>;
  /** Tests only: replaces the pinned asset. */
  asset?: OllamaAsset;
}

/**
 * Install Ollama from the pinned official release archive (src/install/ollama-pins.ts): download,
 * check the SHA-256, and only then unpack into destDir. A checksum mismatch aborts before anything
 * is unpacked or any existing install is touched. Returns the path of the installed binary.
 */
export async function installPinnedOllama(deps: PinnedOllamaInstallDeps = {}): Promise<string> {
  const platform = deps.platform ?? os.platform();
  const arch = deps.arch ?? os.arch();
  const target = ollamaTargetFor(platform, arch);
  if (!target) throw new Error(`ollama_install_unsupported: no pinned Ollama build for ${platform}-${arch}`);
  const asset = deps.asset ?? OLLAMA_ASSETS[target];
  const url = ollamaAssetUrl(asset);
  const destDir = deps.destDir ?? defaultOllamaInstallDir(platform);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "edgecoder-ollama-"));
  try {
    const archive = path.join(tmp, asset.name);
    await (deps.download ?? downloadFile)(url, archive);
    const got = await sha256File(archive);
    if (got !== asset.sha256) {
      throw new Error(`ollama_checksum_mismatch: ${url} expected ${asset.sha256}, got ${got}; not installing it`);
    }
    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });
    await (deps.extract ?? extractArchive)(archive, destDir);
    return ollamaBinaryIn(destDir, platform);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function installOllamaBinary(
  platform: OllamaPlatform,
  role: string,
  onStatus?: OllamaStatusCallback
): Promise<void> {
  if (platform === "ios") return; // Managed by native iOS app
  log(role, `binary not found on platform=${platform}, installing pinned Ollama ${OLLAMA_VERSION}...`);
  await onStatus?.("installing_ollama", `Installing Ollama ${OLLAMA_VERSION} (this may take a minute)…`);
  ollamaCmd = await installPinnedOllama();
  await onStatus?.("installing_ollama", "Ollama installed. Verifying…");
  log(role, `binary install complete: ${ollamaCmd}`);
}

// ---------------------------------------------------------------------------
// Phase 3: Start ollama serve as detached background process
// ---------------------------------------------------------------------------

async function isOllamaServing(host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const base = ollamaApiBase(host);
    const url = new URL("/api/tags", base);
    const mod = url.protocol === "https:" ? https : http;
    const req = (mod as typeof http).get(url.toString(), (res) => {
      resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

function startOllamaServeBackground(role: string, env?: NodeJS.ProcessEnv): void {
  log(role, "starting ollama serve in background...");
  const child = spawn(ollamaCmd, ["serve"], {
    env: { ...process.env, ...(env ?? {}) },
    stdio: "ignore",
    detached: true
  });
  child.unref();
  log(role, `ollama serve started (pid=${child.pid ?? "unknown"})`);
}

// ---------------------------------------------------------------------------
// Phase 4: Health-check polling loop
// ---------------------------------------------------------------------------

async function waitForOllamaReady(
  role: string,
  host: string | undefined,
  maxAttempts = 30,
  intervalMs = 1000
): Promise<void> {
  log(role, `waiting for ollama serve to be ready (max ${maxAttempts}s)...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ready = await isOllamaServing(host);
    if (ready) {
      log(role, `ollama ready after ${attempt}s`);
      return;
    }
    if (attempt < maxAttempts) {
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(
    `[${role}] ollama_serve_timeout: ollama serve did not become ready within ${maxAttempts}s`
  );
}

// ---------------------------------------------------------------------------
// Phase 5: Pull model with optional progress reporting
// ---------------------------------------------------------------------------

function runPullWithProgress(
  model: string,
  env: NodeJS.ProcessEnv | undefined,
  onStatus?: OllamaStatusCallback
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ollamaCmd, ["pull", model], {
      env: { ...process.env, ...(env ?? {}) },
      stdio: "pipe"
    });
    let stderr = "";
    let lastPct = -1;
    let lastLine = "";
    const reportChunk = (chunk: Buffer | string) => {
      const s = String(chunk);
      const lines = s
        .split(/\r?\n/)
        .map((line) => sanitizeTerminalLine(line))
        .filter(Boolean);
      for (const line of lines) {
        lastLine = line;
        const matches = [...line.matchAll(/(\d+)\s*%/g)];
        if (matches.length > 0) {
          const rawPct = matches[matches.length - 1]?.[1];
          const parsedPct = typeof rawPct === "string" ? parseInt(rawPct, 10) : NaN;
          if (Number.isFinite(parsedPct)) {
            const pct = Math.min(100, Math.max(0, parsedPct));
            if (pct !== lastPct) {
              lastPct = pct;
              void Promise.resolve(onStatus?.("pulling_model", `Pulling model… ${pct}%`, pct));
            }
            continue;
          }
        }
        if (/pulling|downloading|extracting|verifying|manifest/i.test(line)) {
          void Promise.resolve(onStatus?.("pulling_model", `Pulling model… ${line}`));
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer | string) => { reportChunk(chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const s = String(chunk);
      stderr += s;
      reportChunk(s);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        if (lastPct < 100) {
          void Promise.resolve(onStatus?.("pulling_model", "Pulling model… 100%", 100));
        }
        return resolve();
      }
      reject(new Error(stderr || lastLine || `ollama pull failed with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function ensureOllamaModelInstalled(
  options: OllamaInstallOptions,
  onStatus?: OllamaStatusCallback
): Promise<void> {
  if (!options.enabled || !options.autoInstall) return;

  const platform = resolvePlatform(options.platform);
  const { role, host } = options;
  const serveEnv = host ? { OLLAMA_HOST: host } : undefined;

  // Phase 1: iOS short-circuit — model server managed by native Swift app
  if (platform === "ios") {
    log(role, "platform=ios, skipping — Ollama managed by native iOS app");
    return;
  }

  // Phase 2: Install binary if missing
  const installed = await isOllamaInstalled(serveEnv);
  if (!installed && options.allowBinaryInstall === false) {
    throw new Error(`[${role}] ollama_not_installed: install Ollama on this host first`);
  }
  if (!installed) {
    await installOllamaBinary(platform, role, onStatus);
    const nowInstalled = await isOllamaInstalled(serveEnv);
    if (!nowInstalled) {
      throw new Error(
        `[${role}] ollama_install_failed: binary still not found after install attempt`
      );
    }
  } else {
    log(role, "binary already present, skipping install");
  }

  // Phase 3: Start serve if not already running
  const alreadyServing = await isOllamaServing(host);
  if (!alreadyServing) {
    startOllamaServeBackground(role, serveEnv);
    // Phase 4: Wait for readiness
    await waitForOllamaReady(role, host);
  } else {
    log(role, "serve already running, skipping start");
  }

  // Phase 5: Pull model
  log(role, `pulling model: ${options.model}`);
  await onStatus?.("pulling_model", "Pulling model…");
  if (onStatus) {
    await runPullWithProgress(options.model, serveEnv, onStatus);
  } else {
    await runCommand(ollamaCmd, ["pull", options.model], serveEnv);
  }
  log(role, `model ready: ${options.model}`);
}
