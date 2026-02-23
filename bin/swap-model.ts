#!/usr/bin/env node
/**
 * EdgeCoder Model Management CLI
 *
 * Usage:
 *   npx tsx bin/swap-model.ts list
 *   npx tsx bin/swap-model.ts swap <model-name>
 *   npx tsx bin/swap-model.ts status
 *   npx tsx bin/swap-model.ts pull <model-name>
 */

const INFERENCE_URL = process.env.INFERENCE_URL ?? "http://127.0.0.1:4302";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    console.log(`EdgeCoder Model Management

Commands:
  list              Show installed and available models
  swap <model>      Swap the active model
  status            Show current model and health
  pull <model>      Pull a model without activating

Options:
  --host <url>      Inference service URL (default: ${INFERENCE_URL})
`);
    process.exit(0);
  }

  const host = getHost(args);

  switch (command) {
    case "list":
      await listModels(host);
      break;
    case "swap":
      await swapModel(host, args[0]);
      break;
    case "status":
      await getStatus(host);
      break;
    case "pull":
      await pullModel(host, args[0]);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

function getHost(args: string[]): string {
  const hostIdx = args.indexOf("--host");
  if (hostIdx !== -1 && args[hostIdx + 1]) {
    return args[hostIdx + 1];
  }
  return INFERENCE_URL;
}

async function listModels(host: string): Promise<void> {
  const res = await fetch(`${host}/model/list`);
  if (!res.ok) {
    console.error(`Error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const models = await res.json() as Array<{ modelId: string; paramSize: number; installed: boolean; active: boolean }>;

  console.log("\nInstalled Models:");
  console.log("\u2500".repeat(50));
  const installed = models.filter((m: any) => m.installed);
  if (installed.length === 0) {
    console.log("  (none)");
  } else {
    for (const m of installed) {
      const active = m.active ? " \u2190 active" : "";
      console.log(`  ${m.modelId} (${m.paramSize}B)${active}`);
    }
  }

  const available = models.filter((m: any) => !m.installed);
  if (available.length > 0) {
    console.log("\nAvailable (not installed):");
    console.log("\u2500".repeat(50));
    for (const m of available) {
      console.log(`  ${m.model} (${m.paramSize}B)`);
    }
  }
  console.log();
}

async function swapModel(host: string, model: string | undefined): Promise<void> {
  if (!model) {
    console.error("Usage: swap <model-name>");
    process.exit(1);
  }
  const res = await fetch(`${host}/model/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model })
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: ${res.status} ${body}`);
    process.exit(1);
  }
  const result = await res.json() as { previous: string; active: string; status: string; paramSize: number; progress?: number };

  if (result.status === "ready") {
    console.log(`\nSwapped: ${result.previous} \u2192 ${result.active} (${result.paramSize}B)`);
  } else if (result.status === "pulling") {
    console.log(`\nPulling ${model}... (${result.progress ?? 0}%)`);
    console.log("Run 'status' to check progress.");
  } else {
    console.log(`\nSwap status: ${result.status}`);
  }
  console.log();
}

async function getStatus(host: string): Promise<void> {
  const res = await fetch(`${host}/model/status`);
  if (!res.ok) {
    console.error(`Error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const status = await res.json() as { model: string; paramSize: number; status: string; ollamaHealthy: boolean };
  console.log(`\nModel Status:`);
  console.log("\u2500".repeat(50));
  console.log(`  Active:  ${status.model}`);
  console.log(`  Params:  ${status.paramSize}B`);
  console.log(`  Status:  ${status.status}`);
  console.log(`  Ollama:  ${status.ollamaHealthy ? "connected" : "disconnected"}`);
  console.log();
}

async function pullModel(host: string, model: string | undefined): Promise<void> {
  if (!model) {
    console.error("Usage: pull <model-name>");
    process.exit(1);
  }
  // Pull is the same as swap — the endpoint handles pulling if not installed
  // But we tell the user it's pulling, not swapping
  const res = await fetch(`${host}/model/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model })
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: ${res.status} ${body}`);
    process.exit(1);
  }
  const result = await res.json() as { status: string; progress?: number };

  if (result.status === "pulling") {
    console.log(`\nPulling ${model}... (${result.progress ?? 0}%)`);
    console.log("Run 'status' to check progress.");
  } else if (result.status === "ready") {
    console.log(`\n${model} is already installed.`);
  } else {
    console.log(`\nPull status: ${result.status}`);
  }
  console.log();
}

main().catch((err) => {
  if (err instanceof TypeError && err.message.includes("fetch")) {
    console.error(`\nCannot connect to inference service at ${INFERENCE_URL}`);
    console.error("Make sure it's running: npm run dev:inference\n");
  } else {
    console.error(err);
  }
  process.exit(1);
});
