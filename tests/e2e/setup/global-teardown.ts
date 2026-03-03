import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = resolve(__dirname, "../docker-compose.e2e.yml");
const LOGS_DIR = resolve(__dirname, "../logs");
const CONTEXT_FILE = resolve(__dirname, "../test-context.json");

export default async function globalTeardown(): Promise<void> {
  console.log("[e2e-teardown] Collecting container logs...");

  const services = ["postgres", "portal", "coordinator", "ollama", "agent"];
  for (const svc of services) {
    try {
      execSync(
        `docker compose -f "${COMPOSE_FILE}" logs --no-color ${svc} > "${LOGS_DIR}/${svc}.log" 2>&1`,
        { stdio: "pipe" }
      );
    } catch {
      console.warn(`[e2e-teardown] Failed to collect logs for ${svc}`);
    }
  }

  console.log("[e2e-teardown] Tearing down E2E stack...");
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" down --remove-orphans`, {
      stdio: "inherit",
      timeout: 60_000,
    });
  } catch (err) {
    console.error("[e2e-teardown] Failed to tear down stack:", err);
  }

  // Clean up context file
  if (existsSync(CONTEXT_FILE)) {
    unlinkSync(CONTEXT_FILE);
  }

  console.log("[e2e-teardown] Teardown complete.");
}
