import { pgStore } from "../db/store.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";

async function bootstrapCoordinator(): Promise<void> {
  if (pgStore) {
    await pgStore.migrate();
  }

  const provider = (process.env.LOCAL_MODEL_PROVIDER ?? "edgecoder-local") as
    | "edgecoder-local"
    | "ollama-local";
  const autoInstall = process.env.OLLAMA_AUTO_INSTALL === "true";
  const model = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
  const agentOs = (process.env.AGENT_OS ?? "macos") as
    | "macos" | "debian" | "ubuntu" | "windows" | "ios";

  await ensureOllamaModelInstalled({
    enabled: provider === "ollama-local",
    autoInstall,
    model,
    role: "coordinator",
    host: process.env.OLLAMA_HOST,
    platform: agentOs
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        database: pgStore ? "postgres_ready" : "database_disabled",
        provider,
        ollamaAutoInstall: autoInstall
      },
      null,
      2
    )
  );
}

bootstrapCoordinator().catch((error) => {
  console.error(error);
  process.exit(1);
});
