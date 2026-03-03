import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = resolve(__dirname, "../docker-compose.e2e.yml");
const CONTEXT_FILE = resolve(__dirname, "../test-context.json");
const PORTAL_URL = "http://localhost:14310";
const COORDINATOR_URL = "http://localhost:14301";
const OLLAMA_URL = "http://localhost:11434";

function run(cmd: string, label: string): void {
  console.log(`[e2e-setup] ${label}...`);
  execSync(cmd, { stdio: "inherit" });
}

async function waitForHealth(url: string, label: string, headers?: Record<string, string>, timeoutMs = 120_000): Promise<void> {
  console.log(`[e2e-setup] Waiting for ${label} at ${url}...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, headers ? { headers } : undefined);
      if (res.ok) {
        console.log(`[e2e-setup] ${label} is ready.`);
        return;
      }
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`[e2e-setup] ${label} failed to start within ${timeoutMs}ms`);
}

async function seedData(): Promise<void> {
  console.log("[e2e-setup] Seeding test data...");

  // 1. Sign up test user
  const signupRes = await fetch(`${PORTAL_URL}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@edgecoder.io",
      password: "TestPassword123!",
      displayName: "E2E Test User",
    }),
  });
  if (!signupRes.ok) throw new Error(`Signup failed: ${signupRes.status} ${await signupRes.text()}`);
  const { userId } = (await signupRes.json()) as { userId: string };
  console.log(`[e2e-setup] Created user: ${userId}`);

  // 2. Force-verify email via direct SQL
  const now = Date.now();
  execSync(
    `docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U edgecoder -d edgecoder -c "UPDATE portal_users SET email_verified = TRUE, verified_at_ms = ${now} WHERE user_id = '${userId}'; UPDATE portal_node_enrollments SET email_verified = TRUE, active = node_approved WHERE owner_user_id = '${userId}';"`,
    { stdio: "pipe" }
  );
  console.log("[e2e-setup] Email verified via SQL.");

  // 3. Login
  const loginRes = await fetch(`${PORTAL_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@edgecoder.io", password: "TestPassword123!" }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);
  const loginData = (await loginRes.json()) as { sessionToken: string };
  const { sessionToken } = loginData;
  console.log("[e2e-setup] Logged in, got session token.");

  // 4. Enroll coordinator node
  const coordRes = await fetch(`${PORTAL_URL}/nodes/enroll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ nodeId: "e2e-coordinator", nodeKind: "coordinator" }),
  });
  if (!coordRes.ok) throw new Error(`Coordinator enroll failed: ${coordRes.status}`);
  const coordData = (await coordRes.json()) as { registrationToken: string };
  console.log("[e2e-setup] Enrolled coordinator node.");

  // 5. Enroll agent node
  const agentRes = await fetch(`${PORTAL_URL}/nodes/enroll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ nodeId: "e2e-agent-1", nodeKind: "agent" }),
  });
  if (!agentRes.ok) throw new Error(`Agent enroll failed: ${agentRes.status}`);
  const agentData = (await agentRes.json()) as { registrationToken: string };
  console.log("[e2e-setup] Enrolled agent node.");

  // 6. Write context for test specs
  const context = {
    userId,
    sessionToken,
    coordinatorRegToken: coordData.registrationToken,
    agentRegToken: agentData.registrationToken,
    portalUrl: PORTAL_URL,
    coordinatorUrl: COORDINATOR_URL,
    ollamaUrl: OLLAMA_URL,
  };
  writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));
  console.log("[e2e-setup] Wrote test-context.json.");
}

export default async function globalSetup(): Promise<void> {
  console.log("[e2e-setup] Starting E2E test stack...");

  // Build and start all services
  run(`docker compose -f "${COMPOSE_FILE}" build`, "Building images");
  run(`docker compose -f "${COMPOSE_FILE}" up -d`, "Starting containers");

  // Wait for services to be healthy
  await waitForHealth(`${PORTAL_URL}/health`, "Portal");
  await waitForHealth(`${COORDINATOR_URL}/status`, "Coordinator", { "x-mesh-token": "e2e-mesh-token" });
  await waitForHealth(`${OLLAMA_URL}/api/tags`, "Ollama");

  // Pull tinyllama model (cached in named volume across runs)
  console.log("[e2e-setup] Checking if tinyllama model is available...");
  try {
    const tags = execSync(
      `docker compose -f "${COMPOSE_FILE}" exec -T ollama ollama list`,
      { encoding: "utf8", timeout: 30_000 }
    );
    if (tags.includes("tinyllama")) {
      console.log("[e2e-setup] tinyllama already available, skipping pull.");
    } else {
      throw new Error("not found");
    }
  } catch {
    console.log("[e2e-setup] Pulling tinyllama model (this may take a few minutes)...");
    execSync(
      `docker compose -f "${COMPOSE_FILE}" exec -T ollama ollama pull tinyllama`,
      { stdio: "inherit", timeout: 600_000 }
    );
  }

  // Create logs directory
  mkdirSync(resolve(__dirname, "../logs"), { recursive: true });

  // Seed test data
  await seedData();

  console.log("[e2e-setup] Setup complete. Ready to run tests.");
}
