const PORTAL_URL = process.env.E2E_PORTAL_URL ?? "http://localhost:4310";
const COORDINATOR_URL = process.env.E2E_COORDINATOR_URL ?? "http://localhost:4301";

export interface TestContext {
  userId: string;
  sessionToken: string;
  coordinatorNodeId: string;
  coordinatorRegToken: string;
  agentNodeId: string;
  agentRegToken: string;
}

export async function signUp(email: string, password: string, displayName?: string) {
  const res = await fetch(`${PORTAL_URL}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean; userId: string }>;
}

export async function forceVerifyEmail(userId: string) {
  const { execSync } = await import("node:child_process");
  const now = Date.now();
  execSync(
    `docker exec $(docker compose -f tests/e2e/docker-compose.e2e.yml ps -q postgres) psql -U edgecoder -d edgecoder -c "UPDATE portal_users SET email_verified = TRUE, verified_at_ms = ${now} WHERE user_id = '${userId}'; UPDATE portal_node_enrollments SET email_verified = TRUE, active = node_approved WHERE owner_user_id = '${userId}';"`,
    { stdio: "pipe" }
  );
}

export async function login(email: string, password: string) {
  const res = await fetch(`${PORTAL_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{
    ok: boolean;
    sessionToken: string;
    user: { userId: string; email: string; displayName: string | null; emailVerified: boolean };
  }>;
}

export async function enrollNode(
  sessionToken: string,
  nodeId: string,
  nodeKind: "agent" | "coordinator"
) {
  const res = await fetch(`${PORTAL_URL}/nodes/enroll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ nodeId, nodeKind }),
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{
    ok: boolean;
    nodeId: string;
    nodeKind: string;
    registrationToken: string;
    nodeApproved: boolean;
  }>;
}

export async function getCoordinatorStatus() {
  const res = await fetch(`${COORDINATOR_URL}/status`);
  if (!res.ok) throw new Error(`coordinator status failed: ${res.status}`);
  return res.json();
}

export async function getModelList(authToken: string) {
  const res = await fetch(`${COORDINATOR_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return { status: res.status, data: await res.json() };
}

export async function sendChatCompletion(
  authToken: string,
  messages: Array<{ role: string; content: string }>,
  model = "tinyllama"
) {
  const res = await fetch(`${COORDINATOR_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  return { status: res.status, data: await res.json() };
}

export { PORTAL_URL, COORDINATOR_URL };
