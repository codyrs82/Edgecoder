import { spawn } from "node:child_process";

export interface OllamaInstallOptions {
  enabled: boolean;
  autoInstall: boolean;
  model: string;
  role: "coordinator" | "agent";
  host?: string;
}

function runCommand(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(env ?? {}) },
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

export async function ensureOllamaModelInstalled(options: OllamaInstallOptions): Promise<void> {
  if (!options.enabled || !options.autoInstall) return;

  const env = options.host ? { OLLAMA_HOST: options.host } : undefined;
  try {
    await runCommand("ollama", ["--version"], env);
  } catch {
    throw new Error(
      `[${options.role}] ollama_cli_missing: install Ollama or disable OLLAMA_AUTO_INSTALL`
    );
  }

  await runCommand("ollama", ["pull", options.model], env);
}
