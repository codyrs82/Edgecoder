// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as os from "node:os";
import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";

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

function runShell(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Shell command failed (code ${code}): ${command}`));
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

async function isOllamaInstalled(env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await runCommand("ollama", ["--version"], env, { silent: true });
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);

    const fetchUrl = (targetUrl: string) => {
      https
        .get(targetUrl, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            const location = response.headers.location;
            if (!location) return reject(new Error("Redirect with no Location header"));
            fetchUrl(location);
            return;
          }
          response.pipe(file);
          file.on("finish", () => { file.close(); resolve(); });
          response.on("error", reject);
        })
        .on("error", reject);
    };

    fetchUrl(url);
    file.on("error", reject);
  });
}

async function installOllamaBinary(
  platform: OllamaPlatform,
  role: string,
  onStatus?: OllamaStatusCallback
): Promise<void> {
  log(role, `binary not found on platform=${platform}, installing...`);
  await onStatus?.("installing_ollama", "Installing Ollama (this may take a minute)…");

  switch (platform) {
    case "macos":
    case "debian":
    case "ubuntu":
      await runShell("curl -fsSL https://ollama.com/install.sh | sh");
      break;

    case "windows": {
      const tmpExe = path.join(os.tmpdir(), "OllamaSetup.exe");
      log(role, `downloading OllamaSetup.exe to ${tmpExe}...`);
      await downloadFile("https://ollama.com/download/OllamaSetup.exe", tmpExe);
      log(role, "running OllamaSetup.exe silently...");
      await runCommand(tmpExe, ["/S"]);
      break;
    }

    case "ios":
      return; // Managed by native iOS app
  }

  await onStatus?.("installing_ollama", "Ollama installed. Verifying…");
  log(role, "binary install complete");
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
  const child = spawn("ollama", ["serve"], {
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
    const child = spawn("ollama", ["pull", model], {
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
    await runCommand("ollama", ["pull", options.model], serveEnv);
  }
  log(role, `model ready: ${options.model}`);
}
