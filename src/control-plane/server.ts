import Fastify from "fastify";
import { request } from "undici";
import { z } from "zod";
import { AgentMode, LocalModelManifest, NetworkMode, RolloutPolicy, RolloutStage, AgentRolloutState } from "../common/types.js";
import { adjustCredits, creditEngine } from "../credits/store.js";
import { verifyManifest } from "./manifest.js";
import { defaultDeploymentPlan } from "./deployment.js";
import { pgStore } from "../db/store.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";
import { buildAdminDashboardRoutes } from "./dashboard.js";

const app = Fastify({ logger: true });
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN ?? "";
const COORDINATOR_MESH_TOKEN = process.env.COORDINATOR_MESH_TOKEN ?? process.env.MESH_AUTH_TOKEN ?? "";
const PORTAL_SERVICE_URL = process.env.PORTAL_SERVICE_URL ?? "";
const PORTAL_SERVICE_TOKEN = process.env.PORTAL_SERVICE_TOKEN ?? "";
const UI_RETIRE_REDIRECT_URL =
  process.env.UI_RETIRE_REDIRECT_URL ??
  (PORTAL_SERVICE_URL ? `${PORTAL_SERVICE_URL.replace(/\/$/, "")}/portal/coordinator-ops` : "/");

function parseAllowedIps(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean)
  );
}

function extractClientIp(headers: Record<string, unknown>, fallbackIp: string): string {
  const flyClientIp = headers["fly-client-ip"];
  if (typeof flyClientIp === "string" && flyClientIp.length > 0) {
    return flyClientIp.trim();
  }
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return fallbackIp;
}

function extractAdminToken(headers: Record<string, unknown>): string | undefined {
  const direct = headers["x-admin-token"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return undefined;
}

function isPortalInternalRequest(headers: Record<string, unknown>): boolean {
  if (!PORTAL_SERVICE_TOKEN) return false;
  const token = headers["x-portal-service-token"];
  return typeof token === "string" && token === PORTAL_SERVICE_TOKEN;
}

function authorizeAdmin(req: { headers: Record<string, unknown>; ip: string }, reply: any): boolean {
  if (isPortalInternalRequest(req.headers)) {
    return true;
  }
  const allowedIps = parseAllowedIps(process.env.ALLOWED_ADMIN_IPS);
  if (allowedIps.size > 0) {
    const ip = extractClientIp(req.headers, req.ip);
    if (!allowedIps.has(ip)) {
      reply.code(403).send({ error: "admin_ip_forbidden" });
      return false;
    }
  }
  if (ADMIN_API_TOKEN) {
    const token = extractAdminToken(req.headers);
    if (token !== ADMIN_API_TOKEN) {
      reply.code(401).send({ error: "admin_token_required" });
      return false;
    }
  }
  return true;
}

function authorizeUi(req: { headers: Record<string, unknown>; ip: string }, reply: any): boolean {
  const allowedUiIps = parseAllowedIps(process.env.ALLOWED_UI_IPS);
  if (allowedUiIps.size > 0) {
    const ip = extractClientIp(req.headers, req.ip);
    if (!allowedUiIps.has(ip)) {
      reply.code(403).type("text/plain").send("forbidden");
      return false;
    }
  }
  return true;
}

function coordinatorMeshHeaders(contentType = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = "application/json";
  if (COORDINATOR_MESH_TOKEN) headers["x-mesh-token"] = COORDINATOR_MESH_TOKEN;
  return headers;
}

function portalHeaders(contentType = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = "application/json";
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;
  return headers;
}

function normalizeCoordinatorUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    const normalized = parsed.toString().replace(/\/$/, "");
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

async function collectCoordinatorDiscovery(): Promise<{
  coordinators: Array<{ peerId: string; coordinatorUrl: string; source: "bootstrap" | "mesh" }>;
}> {
  const discovered = new Map<string, { peerId: string; coordinatorUrl: string; source: "bootstrap" | "mesh" }>();
  const bootstrap = normalizeCoordinatorUrl(coordinatorUrl);
  if (bootstrap) {
    discovered.set(bootstrap, {
      peerId: "bootstrap",
      coordinatorUrl: bootstrap,
      source: "bootstrap"
    });
  }

  try {
    const [identityRes, peersRes] = await Promise.all([
      request(`${coordinatorUrl}/identity`, {
        method: "GET",
        headers: coordinatorMeshHeaders()
      }),
      request(`${coordinatorUrl}/mesh/peers`, {
        method: "GET",
        headers: coordinatorMeshHeaders()
      })
    ]);

    if (identityRes.statusCode >= 200 && identityRes.statusCode < 300) {
      const identity = (await identityRes.body.json()) as { peerId?: string; coordinatorUrl?: string };
      const url = normalizeCoordinatorUrl(identity.coordinatorUrl);
      if (url) {
        discovered.set(url, {
          peerId: identity.peerId ?? "unknown",
          coordinatorUrl: url,
          source: "mesh"
        });
      }
    }

    if (peersRes.statusCode >= 200 && peersRes.statusCode < 300) {
      const peers = (await peersRes.body.json()) as {
        peers?: Array<{ peerId?: string; coordinatorUrl?: string }>;
      };
      for (const peer of peers.peers ?? []) {
        const url = normalizeCoordinatorUrl(peer.coordinatorUrl);
        if (!url) continue;
        discovered.set(url, {
          peerId: peer.peerId ?? "unknown",
          coordinatorUrl: url,
          source: "mesh"
        });
      }
    }
  } catch {
    // Best-effort discovery; keep bootstrap fallback when mesh is unreachable.
  }

  return { coordinators: [...discovered.values()] };
}

async function lookupPortalNodes(nodeIds: string[]): Promise<
  Map<
    string,
    {
      ownerEmail: string;
      emailVerified: boolean;
      nodeApproved: boolean;
      active: boolean;
      sourceIp?: string;
      countryCode?: string;
      vpnDetected: boolean;
      lastSeenMs?: number;
    }
  >
> {
  const map = new Map<string, any>();
  if (!PORTAL_SERVICE_URL || nodeIds.length === 0) return map;
  try {
    const res = await request(`${PORTAL_SERVICE_URL}/internal/nodes/lookup`, {
      method: "POST",
      headers: portalHeaders(true),
      body: JSON.stringify({ nodeIds })
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return map;
    const payload = (await res.body.json()) as {
      nodes?: Array<{
        nodeId: string;
        ownerEmail: string;
        emailVerified: boolean;
        nodeApproved: boolean;
        active: boolean;
        sourceIp?: string;
        countryCode?: string;
        vpnDetected: boolean;
        lastSeenMs?: number;
      }>;
    };
    for (const node of payload.nodes ?? []) {
      map.set(node.nodeId, node);
    }
  } catch {
    return map;
  }
  return map;
}

async function listPendingPortalNodes(limit = 200): Promise<
  Array<{
    nodeId: string;
    nodeKind: "agent" | "coordinator";
    ownerEmail: string;
    emailVerified: boolean;
    nodeApproved: boolean;
    active: boolean;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected: boolean;
    lastSeenMs?: number;
    updatedAtMs?: number;
  }>
> {
  if (!PORTAL_SERVICE_URL) return [];
  try {
    const res = await request(`${PORTAL_SERVICE_URL}/internal/nodes/pending?limit=${Math.min(Math.max(limit, 1), 500)}`, {
      method: "GET",
      headers: portalHeaders()
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return [];
    const payload = (await res.body.json()) as {
      nodes?: Array<{
        nodeId: string;
        nodeKind: "agent" | "coordinator";
        ownerEmail: string;
        emailVerified: boolean;
        nodeApproved: boolean;
        active: boolean;
        sourceIp?: string;
        countryCode?: string;
        vpnDetected: boolean;
        lastSeenMs?: number;
        updatedAtMs?: number;
      }>;
    };
    return payload.nodes ?? [];
  } catch {
    return [];
  }
}

type AgentRecord = {
  agentId: string;
  os: "debian" | "ubuntu" | "windows" | "macos" | "ios";
  version: string;
  mode: AgentMode;
  health: "healthy" | "stale";
  localModelEnabled: boolean;
  lastSeenMs: number;
};

const agents = new Map<string, AgentRecord>();
const manifests = new Map<string, LocalModelManifest>();
let networkMode: NetworkMode = "public_mesh";
const deploymentPlan = defaultDeploymentPlan();

const upsertSchema = z.object({
  agentId: z.string(),
  os: z.enum(["debian", "ubuntu", "windows", "macos", "ios"]),
  version: z.string(),
  mode: z.enum(["swarm-only", "ide-enabled"])
});

const modeSchema = z.object({
  mode: z.enum(["swarm-only", "ide-enabled"])
});

const localModelSchema = z.object({
  enabled: z.boolean(),
  manifest: z
    .object({
      modelId: z.string(),
      sourceUrl: z.string().url(),
      checksumSha256: z.string(),
      signature: z.string(),
      provider: z.enum(["edgecoder-local", "ollama-local"])
    })
    .optional()
});

app.get("/agents", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const now = Date.now();
  return {
    agents: [...agents.values()].map((agent) => ({
      ...agent,
      health: now - agent.lastSeenMs > 120_000 ? "stale" : "healthy"
    }))
  };
});

app.get("/agents/catalog", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const capacityRes = await request(`${coordinatorUrl}/capacity`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    const capacity = (await capacityRes.body.json()) as { agents?: Array<any> };
    const liveAgents = capacity.agents ?? [];
    const portalNodes = await lookupPortalNodes(liveAgents.map((agent) => String(agent.agentId)));
    const catalog = await Promise.all(
      liveAgents.map(async (agent) => {
        const ownership = await pgStore?.getAgentOwnership(agent.agentId);
        const rewardAccountId = ownership?.accountId ?? agent.agentId;
        const rewardBalance = pgStore ? await pgStore.creditBalance(rewardAccountId) : creditEngine.balance(rewardAccountId);
        const portal = portalNodes.get(agent.agentId);
        return {
          ...agent,
          ownership: ownership ?? null,
          rewardAccountId,
          rewardBalance,
          ownerEmail: portal?.ownerEmail,
          emailVerified: portal?.emailVerified,
          nodeApproved: portal?.nodeApproved,
          active: portal?.active,
          sourceIp: portal?.sourceIp,
          countryCode: portal?.countryCode,
          vpnDetected: portal?.vpnDetected ?? false
        };
      })
    );
    return reply.send({ agents: catalog });
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/network/mode", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  return { networkMode };
});
app.get("/deployment/plan", async () => deploymentPlan);

app.post("/network/mode", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = z.object({ networkMode: z.enum(["public_mesh", "enterprise_overlay"]) }).parse(req.body);
  networkMode = body.networkMode;
  return reply.send({ ok: true, networkMode });
});

app.get("/network/summary", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const [capacityRes, statusRes, priceRes] = await Promise.all([
      request(`${coordinatorUrl}/capacity`, { method: "GET" }),
      request(`${coordinatorUrl}/status`, { method: "GET" }),
      request(`${coordinatorUrl}/economy/price/current`, {
        method: "GET",
        headers: coordinatorMeshHeaders()
      })
    ]);
    const capacity = capacityRes.statusCode >= 200 && capacityRes.statusCode < 300
      ? await capacityRes.body.json()
      : null;
    const status = statusRes.statusCode >= 200 && statusRes.statusCode < 300
      ? await statusRes.body.json()
      : null;
    const pricing = priceRes.statusCode >= 200 && priceRes.statusCode < 300
      ? await priceRes.body.json()
      : null;
    return reply.send({
      generatedAt: Date.now(),
      networkMode,
      capacity,
      status,
      pricing
    });
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/network/coordinators", async () => {
  const discovery = await collectCoordinatorDiscovery();
  return {
    generatedAt: Date.now(),
    count: discovery.coordinators.length,
    coordinators: discovery.coordinators
  };
});

app.get("/mesh/peers", async (_req, reply) => {
  if (!authorizeAdmin(_req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/mesh/peers`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    const json = (await res.body.json()) as unknown;
    return reply.send(json);
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/health/runtime", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/health/runtime`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/security/blacklist", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/security/blacklist`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/security/blacklist/audit", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/security/blacklist/audit`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/agent-mesh/direct-work/audit", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const query = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }).parse(req.query);
  try {
    const res = await request(`${coordinatorUrl}/agent-mesh/direct-work/audit?limit=${query.limit}`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/agent-mesh/models/available", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const query = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).optional()
    })
    .parse(req.query);
  try {
    const url = new URL(`${coordinatorUrl}/agent-mesh/models/available`);
    if (query.provider) url.searchParams.set("provider", query.provider);
    const res = await request(url.toString(), {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/security/blacklist", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = z
    .object({
      agentId: z.string(),
      reasonCode: z.enum([
        "abuse_spam",
        "abuse_malware",
        "policy_violation",
        "credential_abuse",
        "dos_behavior",
        "forged_results",
        "manual_review"
      ]),
      reason: z.string().min(3),
      reportedBy: z.string().default("admin"),
      reporterId: z.string().default("admin"),
      reporterPublicKeyPem: z.string().optional(),
      reporterSignature: z.string().optional(),
      evidenceHashSha256: z.string().length(64),
      evidenceRef: z.string().optional(),
      expiresInMs: z.number().positive().optional()
    })
    .parse(req.body);
  try {
    const res = await request(`${coordinatorUrl}/security/blacklist`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify(body)
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/credits/:accountId/balance", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ accountId: z.string() }).parse(req.params);
  if (pgStore) {
    return reply.send({ accountId: params.accountId, balance: await pgStore.creditBalance(params.accountId) });
  }
  return reply.send({ accountId: params.accountId, balance: creditEngine.balance(params.accountId) });
});

app.get("/credits/:accountId/history", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ accountId: z.string() }).parse(req.params);
  if (pgStore) {
    return reply.send({ accountId: params.accountId, history: await pgStore.creditHistory(params.accountId) });
  }
  return reply.send({ accountId: params.accountId, history: creditEngine.history(params.accountId) });
});

app.post("/credits/:accountId/faucet", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ accountId: z.string() }).parse(req.params);
  const body = z.object({ credits: z.number().positive().max(10000).default(100) }).parse(req.body);
  const tx = await adjustCredits(params.accountId, body.credits, "faucet");
  const balance = pgStore
    ? await pgStore.creditBalance(params.accountId)
    : creditEngine.balance(params.accountId);
  return reply.send({ tx, balance });
});

app.post("/credits/accounts", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const body = z
    .object({
      accountId: z.string().min(3),
      displayName: z.string().min(2),
      ownerUserId: z.string().min(2)
    })
    .parse(req.body);
  await pgStore.upsertCreditAccount({
    accountId: body.accountId,
    displayName: body.displayName,
    ownerUserId: body.ownerUserId,
    createdAtMs: Date.now()
  });
  await pgStore.upsertAccountMembership({
    accountId: body.accountId,
    userId: body.ownerUserId,
    role: "owner",
    createdAtMs: Date.now()
  });
  return reply.send({ ok: true, accountId: body.accountId });
});

app.post("/credits/accounts/:accountId/members", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ accountId: z.string() }).parse(req.params);
  const body = z
    .object({
      userId: z.string().min(2),
      role: z.enum(["owner", "admin", "member"]).default("member")
    })
    .parse(req.body);
  await pgStore.upsertAccountMembership({
    accountId: params.accountId,
    userId: body.userId,
    role: body.role,
    createdAtMs: Date.now()
  });
  return reply.send({ ok: true });
});

app.post("/credits/accounts/:accountId/agents/link", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ accountId: z.string() }).parse(req.params);
  const body = z
    .object({
      agentId: z.string().min(2),
      ownerUserId: z.string().min(2),
      machineLabel: z.string().max(120).optional()
    })
    .parse(req.body);
  const linked = await pgStore.linkAgentOwnership({
    agentId: body.agentId,
    accountId: params.accountId,
    ownerUserId: body.ownerUserId,
    machineLabel: body.machineLabel
  });
  return reply.send({ ok: true, linked });
});

app.get("/credits/accounts/:accountId/agents", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ accountId: z.string() }).parse(req.params);
  return reply.send({
    accountId: params.accountId,
    agents: await pgStore.listAgentOwnershipByAccount(params.accountId)
  });
});

app.get("/credits/users/:userId/accounts", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ userId: z.string() }).parse(req.params);
  return reply.send({
    userId: params.userId,
    accounts: await pgStore.listAccountsByUser(params.userId)
  });
});

app.post("/orchestration/install-model", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = z
    .object({
      target: z.enum(["coordinator", "agent"]),
      agentId: z.string().optional(),
      provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
      model: z.string().default("qwen2.5-coder:latest"),
      autoInstall: z.boolean().default(true),
      requestedBy: z.string().default("admin-api")
    })
    .parse(req.body);

  if (body.target === "coordinator") {
    try {
      const res = await request(`${coordinatorUrl}/orchestration/coordinator/ollama-install`, {
        method: "POST",
        headers: coordinatorMeshHeaders(true),
        body: JSON.stringify({
          provider: body.provider,
          model: body.model,
          autoInstall: body.autoInstall,
          requestedBy: body.requestedBy
        })
      });
      return reply.code(res.statusCode).send(await res.body.json());
    } catch {
      return reply.code(502).send({ error: "coordinator_unreachable" });
    }
  }

  if (!body.agentId) return reply.code(400).send({ error: "agentId_required_for_agent_target" });
  try {
    const res = await request(`${coordinatorUrl}/orchestration/agents/${body.agentId}/ollama-install`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify({
        provider: body.provider,
        model: body.model,
        autoInstall: body.autoInstall,
        requestedBy: body.requestedBy
      })
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/orchestration/rollouts", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/orchestration/rollouts`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

/* ── Staged Rollout Endpoints ───────────────────────────── */

app.get("/rollouts", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const policies = await pgStore.listRolloutPolicies();
  const enriched = await Promise.all(
    policies.map(async (policy) => {
      const agentStates = await pgStore!.listAgentRolloutStates(policy.rolloutId);
      const total = agentStates.length;
      const applied = agentStates.filter(
        (s) => s.status === "applied" || s.status === "healthy"
      ).length;
      return {
        ...policy,
        progressPercent: total > 0 ? Math.round((applied / total) * 100) : 0,
        agentCount: total
      };
    })
  );
  return reply.send({ rollouts: enriched });
});

app.get("/rollouts/:rolloutId", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ rolloutId: z.string() }).parse(req.params);
  const policy = await pgStore.getRolloutPolicy(params.rolloutId);
  if (!policy) return reply.code(404).send({ error: "rollout_not_found" });
  const agentStates = await pgStore.listAgentRolloutStates(params.rolloutId);
  return reply.send({ ...policy, agentStates });
});

app.post("/rollouts", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const body = z
    .object({
      modelId: z.string().min(1),
      targetProvider: z.enum(["ollama-local", "edgecoder-local"]),
      canaryPercent: z.number().int().min(1).max(100).default(10),
      batchSize: z.number().int().min(1).default(5),
      batchIntervalMs: z.number().int().min(0).default(60000),
      healthCheckRequired: z.boolean().default(true),
      autoPromote: z.boolean().default(false),
      rollbackOnFailurePercent: z.number().int().min(1).max(100).default(30)
    })
    .parse(req.body);

  const now = Date.now();
  const rolloutId = `rollout-${now}-${Math.random().toString(36).slice(2, 8)}`;

  const policy: RolloutPolicy = {
    rolloutId,
    modelId: body.modelId,
    targetProvider: body.targetProvider,
    stage: "canary",
    canaryPercent: body.canaryPercent,
    batchSize: body.batchSize,
    batchIntervalMs: body.batchIntervalMs,
    healthCheckRequired: body.healthCheckRequired,
    autoPromote: body.autoPromote,
    rollbackOnFailurePercent: body.rollbackOnFailurePercent,
    createdAtMs: now,
    updatedAtMs: now
  };

  await pgStore.upsertRolloutPolicy(policy);

  // Select canary agents from the currently registered agents
  const allAgentIds = [...agents.keys()];
  const canaryCount = Math.max(1, Math.ceil(allAgentIds.length * (body.canaryPercent / 100)));
  const canaryAgents = allAgentIds.slice(0, canaryCount);

  for (const agentId of canaryAgents) {
    const agentState: AgentRolloutState = {
      rolloutId,
      agentId,
      status: "pending",
      modelVersion: body.modelId,
      updatedAtMs: now
    };
    await pgStore.upsertAgentRolloutState(agentState);
  }

  return reply.code(201).send({ ...policy, canaryAgents });
});

const STAGE_ORDER: RolloutStage[] = ["canary", "batch", "full"];

app.post("/rollouts/:rolloutId/promote", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ rolloutId: z.string() }).parse(req.params);

  const policy = await pgStore.getRolloutPolicy(params.rolloutId);
  if (!policy) return reply.code(404).send({ error: "rollout_not_found" });

  if (policy.stage === "rolled_back") {
    return reply.code(400).send({ error: "cannot_promote_rolled_back" });
  }
  if (policy.stage === "paused") {
    return reply.code(400).send({ error: "cannot_promote_paused" });
  }
  if (policy.stage === "full") {
    return reply.code(400).send({ error: "already_fully_rolled_out" });
  }

  // Health check gate: verify failure rate is below threshold
  if (policy.healthCheckRequired) {
    const agentStates = await pgStore.listAgentRolloutStates(params.rolloutId);
    const total = agentStates.length;
    if (total > 0) {
      const failed = agentStates.filter((s) => s.status === "failed").length;
      const failurePercent = (failed / total) * 100;
      if (failurePercent >= policy.rollbackOnFailurePercent) {
        return reply.code(400).send({
          error: "health_check_failed",
          failurePercent: Math.round(failurePercent),
          threshold: policy.rollbackOnFailurePercent
        });
      }
    }
  }

  const previousStage = policy.stage;
  const currentIdx = STAGE_ORDER.indexOf(previousStage);
  const nextStage = STAGE_ORDER[currentIdx + 1];
  if (!nextStage) {
    return reply.code(400).send({ error: "no_next_stage" });
  }

  await pgStore.updateRolloutStage(params.rolloutId, nextStage);

  // If promoting to batch or full, add more agents
  if (nextStage === "batch" || nextStage === "full") {
    const existingStates = await pgStore.listAgentRolloutStates(params.rolloutId);
    const enrolledIds = new Set(existingStates.map((s) => s.agentId));
    const remainingAgents = [...agents.keys()].filter((id) => !enrolledIds.has(id));

    let toEnroll: string[];
    if (nextStage === "full") {
      toEnroll = remainingAgents;
    } else {
      toEnroll = remainingAgents.slice(0, policy.batchSize);
    }

    const now = Date.now();
    for (const agentId of toEnroll) {
      await pgStore.upsertAgentRolloutState({
        rolloutId: params.rolloutId,
        agentId,
        status: "pending",
        modelVersion: policy.modelId,
        updatedAtMs: now
      });
    }
  }

  const updatedPolicy = await pgStore.getRolloutPolicy(params.rolloutId);
  return reply.send({ ...updatedPolicy, previousStage });
});

app.post("/rollouts/:rolloutId/rollback", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ rolloutId: z.string() }).parse(req.params);

  const policy = await pgStore.getRolloutPolicy(params.rolloutId);
  if (!policy) return reply.code(404).send({ error: "rollout_not_found" });

  await pgStore.updateRolloutStage(params.rolloutId, "rolled_back");

  // Mark all non-failed agents as needing rollback
  const agentStates = await pgStore.listAgentRolloutStates(params.rolloutId);
  const now = Date.now();
  const rolledBackAgents: string[] = [];
  for (const state of agentStates) {
    if (state.status === "applied" || state.status === "healthy" || state.status === "pending" || state.status === "downloading") {
      await pgStore.upsertAgentRolloutState({
        ...state,
        status: "failed",
        error: "rolled_back",
        updatedAtMs: now
      });
      rolledBackAgents.push(state.agentId);
    }
  }

  const updatedPolicy = await pgStore.getRolloutPolicy(params.rolloutId);
  return reply.send({ ...updatedPolicy, rolledBackAgents });
});

/* ── Agent heartbeat rollout status reporting ──────────── */

app.post("/rollouts/:rolloutId/agents/:agentId/status", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z
    .object({ rolloutId: z.string(), agentId: z.string() })
    .parse(req.params);
  const body = z
    .object({
      status: z.enum(["pending", "downloading", "applied", "healthy", "failed"]),
      modelVersion: z.string().optional(),
      error: z.string().optional()
    })
    .parse(req.body);

  const policy = await pgStore.getRolloutPolicy(params.rolloutId);
  if (!policy) return reply.code(404).send({ error: "rollout_not_found" });

  await pgStore.upsertAgentRolloutState({
    rolloutId: params.rolloutId,
    agentId: params.agentId,
    status: body.status,
    modelVersion: body.modelVersion ?? policy.modelId,
    updatedAtMs: Date.now(),
    error: body.error
  });

  return reply.send({ ok: true });
});

app.get("/economy/price/current", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/economy/price/current`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/economy/issuance/current", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/economy/issuance/current`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/economy/issuance/history", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const query = z.object({ limit: z.coerce.number().int().positive().max(200).default(24) }).parse(req.query);
  try {
    const res = await request(`${coordinatorUrl}/economy/issuance/history?limit=${query.limit}`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/economy/credits/:accountId/quote", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ accountId: z.string() }).parse(req.params);
  try {
    const res = await request(`${coordinatorUrl}/economy/credits/${params.accountId}/quote`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/economy/price/propose", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = z
    .object({
      coordinatorId: z.string(),
      cpuCapacity: z.number().nonnegative(),
      gpuCapacity: z.number().nonnegative(),
      queuedTasks: z.number().nonnegative(),
      activeAgents: z.number().nonnegative()
    })
    .parse(req.body);
  try {
    const res = await request(`${coordinatorUrl}/economy/price/propose`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify(body)
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/economy/price/consensus", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = z
    .object({
      cpuCapacity: z.number().nonnegative(),
      gpuCapacity: z.number().nonnegative(),
      queuedTasks: z.number().nonnegative(),
      activeAgents: z.number().nonnegative()
    })
    .parse(req.body);
  try {
    const res = await request(`${coordinatorUrl}/economy/price/consensus`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify(body)
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/economy/wallets/register", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const body = z
    .object({
      accountId: z.string(),
      walletType: z.enum(["lightning", "onchain"]),
      network: z.enum(["bitcoin", "testnet", "signet"]).default("testnet"),
      xpub: z.string().optional(),
      lnNodePubkey: z.string().optional(),
      payoutAddress: z.string().optional(),
      encryptedSecretRef: z.string().optional()
    })
    .parse(req.body);
  await pgStore.upsertWalletAccount({
    accountId: body.accountId,
    walletType: body.walletType,
    network: body.network,
    xpub: body.xpub,
    lnNodePubkey: body.lnNodePubkey,
    payoutAddress: body.payoutAddress,
    encryptedSecretRef: body.encryptedSecretRef,
    createdAtMs: Date.now()
  });
  return reply.send({ ok: true, accountId: body.accountId });
});

app.get("/economy/wallets/:accountId", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ accountId: z.string() }).parse(req.params);
  const wallet = await pgStore.getWalletAccount(params.accountId);
  if (!wallet) return reply.code(404).send({ error: "wallet_not_found" });
  return reply.send({ wallet });
});

app.post("/economy/payments/intents", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = z
    .object({
      accountId: z.string(),
      walletType: z.enum(["lightning", "onchain"]).default("lightning"),
      amountSats: z.number().int().positive()
    })
    .parse(req.body);
  try {
    const res = await request(`${coordinatorUrl}/economy/payments/intents`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify(body)
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/economy/payments/intents/:intentId", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ intentId: z.string() }).parse(req.params);
  try {
    const res = await request(`${coordinatorUrl}/economy/payments/intents/${params.intentId}`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/economy/payments/intents/:intentId/confirm", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ intentId: z.string() }).parse(req.params);
  const body = z.object({ txRef: z.string().min(4) }).parse(req.body);
  try {
    const res = await request(`${coordinatorUrl}/economy/payments/intents/${params.intentId}/confirm`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify(body)
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/economy/payments/reconcile", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/economy/payments/reconcile`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify({})
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/economy/treasury/policies", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = z
    .object({
      treasuryAccountId: z.string().min(3),
      multisigDescriptor: z.string().min(12),
      quorumThreshold: z.number().int().positive(),
      totalCustodians: z.number().int().positive(),
      approvedCoordinatorIds: z.array(z.string()).default([]),
      keyRotationDays: z.number().int().positive().default(90),
      requestedBy: z.string().default("admin-api")
    })
    .parse(req.body);
  try {
    const res = await request(`${coordinatorUrl}/economy/treasury/policies`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify(body)
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/economy/treasury/policies/:policyId/activate", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ policyId: z.string() }).parse(req.params);
  const body = z.object({ requestedBy: z.string().default("admin-api") }).parse(req.body);
  try {
    const res = await request(`${coordinatorUrl}/economy/treasury/policies/${params.policyId}/activate`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify(body)
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/economy/treasury", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/economy/treasury`, {
      method: "GET",
      headers: coordinatorMeshHeaders()
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/bootstrap/coordinator", async (_req, reply) => {
  if (!authorizeAdmin(_req as any, reply)) return;
  const provider = (process.env.LOCAL_MODEL_PROVIDER ?? "edgecoder-local") as
    | "edgecoder-local"
    | "ollama-local";
  const autoInstall = process.env.OLLAMA_AUTO_INSTALL === "true";
  const model = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:latest";
  try {
    if (pgStore) {
      await pgStore.migrate();
    }
    await ensureOllamaModelInstalled({
      enabled: provider === "ollama-local",
      autoInstall,
      model,
      role: "coordinator",
      host: process.env.OLLAMA_HOST
    });
    return reply.send({
      ok: true,
      database: pgStore ? "postgres_ready" : "database_disabled",
      modelBootstrap: provider === "ollama-local" && autoInstall ? "ollama_ready" : "skipped"
    });
  } catch (error) {
    return reply.code(500).send({ ok: false, error: String(error) });
  }
});

async function loadDashboardData() {
  const capacityRes = await request(`${coordinatorUrl}/capacity`, {
    method: "GET",
    headers: coordinatorMeshHeaders()
  }).catch(() => null);
  const statusRes = await request(`${coordinatorUrl}/status`, {
    method: "GET",
    headers: coordinatorMeshHeaders()
  }).catch(() => null);
  const blacklistRes = await request(`${coordinatorUrl}/security/blacklist`, {
    method: "GET",
    headers: coordinatorMeshHeaders()
  }).catch(() => null);
  const blacklistAuditRes = await request(`${coordinatorUrl}/security/blacklist/audit`, {
    method: "GET",
    headers: coordinatorMeshHeaders()
  }).catch(() => null);
  const directWorkAuditRes = await request(`${coordinatorUrl}/agent-mesh/direct-work/audit?limit=25`, {
    method: "GET",
    headers: coordinatorMeshHeaders()
  }).catch(() => null);
  const coordinatorModelRes = await request(`${coordinatorUrl}/orchestration/coordinator/status`, {
    method: "GET",
    headers: coordinatorMeshHeaders()
  }).catch(() => null);
  const rolloutRes = await request(`${coordinatorUrl}/orchestration/rollouts`, {
    method: "GET",
    headers: coordinatorMeshHeaders()
  }).catch(() => null);
  const priceRes = await request(`${coordinatorUrl}/economy/price/current`, {
    method: "GET",
    headers: coordinatorMeshHeaders()
  }).catch(() => null);
  const pendingNodes = await listPendingPortalNodes(250);

  const capacity =
    capacityRes && capacityRes.statusCode >= 200 && capacityRes.statusCode < 300
      ? await capacityRes.body.json()
      : { totals: {}, agents: [] };
  if (Array.isArray((capacity as any).agents) && (capacity as any).agents.length > 0) {
    const ids = (capacity as any).agents.map((agent: any) => String(agent.agentId));
    const portalLookup = await lookupPortalNodes(ids);
    (capacity as any).agents = (capacity as any).agents.map((agent: any) => {
      const portal = portalLookup.get(String(agent.agentId));
      return {
        ...agent,
        ownerEmail: portal?.ownerEmail,
        emailVerified: portal?.emailVerified,
        nodeApproved: portal?.nodeApproved,
        active: portal?.active,
        sourceIp: portal?.sourceIp,
        countryCode: portal?.countryCode,
        vpnDetected: portal?.vpnDetected ?? false
      };
    });
  }
  const status =
    statusRes && statusRes.statusCode >= 200 && statusRes.statusCode < 300
      ? await statusRes.body.json()
      : { queued: 0, agents: 0, results: 0 };
  const blacklist =
    blacklistRes && blacklistRes.statusCode >= 200 && blacklistRes.statusCode < 300
      ? await blacklistRes.body.json()
      : { version: 0, records: [], lastEventHash: "BLACKLIST_GENESIS" };
  const blacklistAudit =
    blacklistAuditRes && blacklistAuditRes.statusCode >= 200 && blacklistAuditRes.statusCode < 300
      ? await blacklistAuditRes.body.json()
      : { version: 0, chainHead: "BLACKLIST_GENESIS", events: [] };
  const directWork =
    directWorkAuditRes && directWorkAuditRes.statusCode >= 200 && directWorkAuditRes.statusCode < 300
      ? await directWorkAuditRes.body.json()
      : { events: [] };
  const coordinatorModel =
    coordinatorModelRes && coordinatorModelRes.statusCode >= 200 && coordinatorModelRes.statusCode < 300
      ? await coordinatorModelRes.body.json()
      : { provider: "unknown", ollamaAutoInstall: false };
  const rollouts =
    rolloutRes && rolloutRes.statusCode >= 200 && rolloutRes.statusCode < 300
      ? await rolloutRes.body.json()
      : { rollouts: [] };
  const pricing =
    priceRes && priceRes.statusCode >= 200 && priceRes.statusCode < 300
      ? await priceRes.body.json()
      : { cpu: null, gpu: null };

  return {
    generatedAt: Date.now(),
    deploymentPlan,
    capacity,
    status,
    coordinatorModel,
    rollouts,
    pricing,
    blacklist,
    blacklistAudit,
    directWork,
    pendingNodes
  };
}

app.get("/ui/data", async (req, reply) => {
  if (!authorizeUi(req as any, reply)) return;
  return reply.code(410).send({
    error: "ui_retired_use_portal",
    redirectTo: UI_RETIRE_REDIRECT_URL
  });
});

app.get("/ops/summary", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  return reply.send(await loadDashboardData());
});

app.post("/ui/actions/coordinator-ollama", async (req, reply) => {
  if (!authorizeUi(req as any, reply)) return;
  return reply.code(410).send({
    error: "ui_retired_use_portal",
    redirectTo: UI_RETIRE_REDIRECT_URL
  });
});

app.post("/ops/coordinator-ollama", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
      model: z.string().default("qwen2.5-coder:latest"),
      autoInstall: z.boolean().default(true)
    })
    .parse(req.body);
  try {
    const res = await request(`${coordinatorUrl}/orchestration/coordinator/ollama-install`, {
      method: "POST",
      headers: coordinatorMeshHeaders(true),
      body: JSON.stringify({
        provider: body.provider,
        model: body.model,
        autoInstall: body.autoInstall,
        requestedBy: "portal"
      })
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.post("/ui/actions/node-approval", async (req, reply) => {
  if (!authorizeUi(req as any, reply)) return;
  return reply.code(410).send({
    error: "ui_retired_use_portal",
    redirectTo: UI_RETIRE_REDIRECT_URL
  });
});

app.get("/ui", async (_req, reply) => {
  if (!authorizeUi(_req as any, reply)) return;
  return reply.redirect(UI_RETIRE_REDIRECT_URL);
});

app.post("/agents/upsert", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const body = upsertSchema.parse(req.body);
  const current = agents.get(body.agentId);
  const record: AgentRecord = {
    agentId: body.agentId,
    os: body.os,
    version: body.version,
    mode: body.mode,
    health: current?.health ?? "healthy",
    localModelEnabled: current?.localModelEnabled ?? false,
    lastSeenMs: Date.now()
  };
  agents.set(body.agentId, record);
  await pgStore?.upsertAgent({
    agentId: record.agentId,
    os: record.os,
    version: record.version,
    mode: record.mode,
    localModelEnabled: record.localModelEnabled,
    lastSeenMs: record.lastSeenMs,
    activeModel: undefined,
    activeModelParamSize: undefined
  });
  return reply.send(record);
});

app.post("/agents/:agentId/mode", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const body = modeSchema.parse(req.body);
  const current = agents.get(params.agentId);
  if (!current) return reply.code(404).send({ error: "agent_not_found" });
  current.mode = body.mode;
  current.lastSeenMs = Date.now();
  agents.set(params.agentId, current);
  await pgStore?.upsertAgent({
    agentId: current.agentId,
    os: current.os,
    version: current.version,
    mode: current.mode,
    localModelEnabled: current.localModelEnabled,
    lastSeenMs: current.lastSeenMs,
    activeModel: undefined,
    activeModelParamSize: undefined
  });
  return reply.send(current);
});

app.post("/agents/:agentId/local-model", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const body = localModelSchema.parse(req.body);
  const current = agents.get(params.agentId);
  if (!current) return reply.code(404).send({ error: "agent_not_found" });
  current.localModelEnabled = body.enabled;
  current.lastSeenMs = Date.now();
  agents.set(params.agentId, current);
  await pgStore?.upsertAgent({
    agentId: current.agentId,
    os: current.os,
    version: current.version,
    mode: current.mode,
    localModelEnabled: current.localModelEnabled,
    lastSeenMs: current.lastSeenMs,
    activeModel: undefined,
    activeModelParamSize: undefined
  });

  if (body.enabled && body.manifest) {
    const verification = verifyManifest(body.manifest);
    if (!verification.ok) {
      return reply.code(400).send({ error: verification.reason });
    }
    manifests.set(params.agentId, body.manifest);
  }
  if (!body.enabled) {
    manifests.delete(params.agentId);
  }

  return reply.send({
    agent: current,
    manifest: manifests.get(params.agentId) ?? null
  });
});

app.post("/agents/:agentId/approval", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!PORTAL_SERVICE_URL) return reply.code(503).send({ error: "portal_service_not_configured" });
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const body = z.object({ approved: z.boolean() }).parse(req.body);
  try {
    const res = await request(`${PORTAL_SERVICE_URL}/internal/nodes/${params.agentId}/approval`, {
      method: "POST",
      headers: portalHeaders(true),
      body: JSON.stringify({ approved: body.approved })
    });
    const payload = await res.body.json();
    return reply.code(res.statusCode).send(payload);
  } catch {
    return reply.code(502).send({ error: "portal_service_unreachable" });
  }
});

app.post("/coordinators/:coordinatorId/approval", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!PORTAL_SERVICE_URL) return reply.code(503).send({ error: "portal_service_not_configured" });
  const params = z.object({ coordinatorId: z.string() }).parse(req.params);
  const body = z.object({ approved: z.boolean() }).parse(req.body);
  try {
    const res = await request(`${PORTAL_SERVICE_URL}/internal/nodes/${params.coordinatorId}/approval`, {
      method: "POST",
      headers: portalHeaders(true),
      body: JSON.stringify({ approved: body.approved })
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "portal_service_unreachable" });
  }
});

app.get("/wallets/:accountId", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  if (!pgStore) return reply.code(503).send({ error: "postgres_required" });
  const params = z.object({ accountId: z.string() }).parse(req.params);
  const wallet = await pgStore.getWalletAccount(params.accountId);
  const paymentIntents = await pgStore.listPaymentIntentsByAccount(params.accountId, 100);
  return reply.send({ accountId: params.accountId, wallets: wallet ? [wallet] : [], paymentIntents });
});

app.get("/agents/:agentId/manifest", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const manifest = manifests.get(params.agentId);
  if (!manifest) return reply.code(404).send({ error: "manifest_not_found" });
  return reply.send(manifest);
});

/* ── Admin Dashboard ───────────────────────────────────── */

buildAdminDashboardRoutes(app, {
  agents: agents as any,
  networkMode: () => networkMode,
  creditEngine,
  pgStore,
  coordinatorUrl,
  coordinatorMeshHeaders,
  portalServiceUrl: PORTAL_SERVICE_URL,
  authorizeAdmin,
});

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(async () => {
      if (pgStore) await pgStore.migrate();
    })
    .then(() => app.listen({ port: 4303, host: "0.0.0.0" }))
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}

export { app as controlPlaneServer };
