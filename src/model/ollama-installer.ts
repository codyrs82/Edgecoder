import { spawn } from "node:child_process";
import { homedir } from "node:os";

export interface OllamaInstallOptions {
  enabled: boolean;
  autoInstall: boolean;
  model: string;
  role: "coordinator" | "agent";
  host?: string;
}

export type OllamaStatusCallback = (phase: string, message: string, progressPct?: number) => void | Promise<void>;

function buildSpawnEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...(env ?? {}) };
  if (!merged.HOME || !String(merged.HOME).trim()) {
    const resolvedHome = homedir();
    merged.HOME = resolvedHome && resolvedHome.trim() ? resolvedHome : "/tmp";
  }
  return merged;
}

function sanitizeTerminalLine(line: string): string {
  return line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function runCommand(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: buildSpawnEnv(env),
      stdio: "pipe"
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr || `${cmd} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

function runShellCommand(command: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      env: buildSpawnEnv(env),
      stdio: "pipe"
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr || `Command failed with code ${code}`));
    });
  });
}

/** Install Ollama via official script when not present. Supports darwin and linux. */
async function installOllamaAutonomous(onStatus?: OllamaStatusCallback): Promise<void> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Autonomous Ollama install not supported on platform: ${platform}`);
  }
  await onStatus?.("installing_ollama", "Installing Ollama (this may take a minute)…");
  await runShellCommand("curl -fsSL https://ollama.com/install.sh | sh");
  await onStatus?.("installing_ollama", "Ollama installed. Verifying…");
}

function runPullWithProgress(
  model: string,
  env: NodeJS.ProcessEnv | undefined,
  onStatus?: OllamaStatusCallback
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ollama", ["pull", model], {
      env: buildSpawnEnv(env),
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
    child.stdout?.on("data", (chunk: Buffer | string) => {
      reportChunk(chunk);
    });
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

export async function ensureOllamaModelInstalled(
  options: OllamaInstallOptions,
  onStatus?: OllamaStatusCallback
): Promise<void> {
  if (!options.enabled) return;
  const env = options.host ? { OLLAMA_HOST: options.host } : undefined;

  let ollamaPresent = false;
  try {
    await runCommand("ollama", ["--version"], env);
    ollamaPresent = true;
  } catch {
    if (options.autoInstall && (process.platform === "darwin" || process.platform === "linux")) {
      await installOllamaAutonomous(onStatus);
      ollamaPresent = true;
    } else {
      throw new Error(
        `[${options.role}] ollama_cli_missing: install Ollama or disable OLLAMA_AUTO_INSTALL`
      );
    }
  }

  if (!ollamaPresent) return;

  await Promise.resolve(onStatus?.("pulling_model", "Pulling model…"));
  if (onStatus) {
    await runPullWithProgress(options.model, env, onStatus);
  } else {
    await runCommand("ollama", ["pull", options.model], env);
  }
}
