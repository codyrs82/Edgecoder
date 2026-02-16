import Fastify from "fastify";
import { request } from "undici";
import { z } from "zod";
import { AgentMode, LocalModelManifest, NetworkMode } from "../common/types.js";
import { adjustCredits, creditEngine } from "../credits/store.js";
import { verifyManifest } from "./manifest.js";
import { defaultDeploymentPlan } from "./deployment.js";
import { pgStore } from "../db/store.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";

const app = Fastify({ logger: true });
const coordinatorUrl = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN ?? "";
const COORDINATOR_MESH_TOKEN = process.env.COORDINATOR_MESH_TOKEN ?? process.env.MESH_AUTH_TOKEN ?? "";
const PORTAL_SERVICE_URL = process.env.PORTAL_SERVICE_URL ?? "";
const PORTAL_SERVICE_TOKEN = process.env.PORTAL_SERVICE_TOKEN ?? "";

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

function authorizeAdmin(req: { headers: Record<string, unknown>; ip: string }, reply: any): boolean {
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
    const capacityRes = await request(`${coordinatorUrl}/capacity`, { method: "GET" });
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

app.get("/mesh/peers", async (_req, reply) => {
  if (!authorizeAdmin(_req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/mesh/peers`, { method: "GET" });
    const json = (await res.body.json()) as unknown;
    return reply.send(json);
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/health/runtime", async (req, reply) => {
  if (!authorizeAdmin(req as any, reply)) return;
  try {
    const res = await request(`${coordinatorUrl}/health/runtime`, { method: "GET" });
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
  const capacityRes = await request(`${coordinatorUrl}/capacity`, { method: "GET" }).catch(() => null);
  const statusRes = await request(`${coordinatorUrl}/status`, { method: "GET" }).catch(() => null);
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
    directWork
  };
}

app.get("/ui/data", async (req, reply) => {
  if (!authorizeUi(req as any, reply)) return;
  return reply.send(await loadDashboardData());
});

app.post("/ui/actions/coordinator-ollama", async (req, reply) => {
  if (!authorizeUi(req as any, reply)) return;
  if (ADMIN_API_TOKEN) {
    const token = extractAdminToken((req as any).headers);
    if (token !== ADMIN_API_TOKEN) {
      return reply.code(401).send({ error: "admin_token_required" });
    }
  }
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
        requestedBy: "ui"
      })
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "coordinator_unreachable" });
  }
});

app.get("/ui", async (_req, reply) => {
  if (!authorizeUi(_req as any, reply)) return;
  const html = `<!doctype html>
  <html>
    <head>
      <title>EdgeCoder Control Plane</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; color: #0b1220; background: #f8fafc; }
        h1, h2, h3 { margin: 8px 0; }
        .meta { color: #475569; font-size: 13px; margin-bottom: 12px; }
        .cards { display: grid; grid-template-columns: repeat(4, minmax(170px, 1fr)); gap: 10px; margin: 14px 0; }
        .card { background: #ffffff; border: 1px solid #dbe3ee; border-radius: 8px; padding: 10px; }
        .k { font-size: 12px; color: #64748b; }
        .v { font-size: 20px; font-weight: 700; }
        .section { margin-top: 18px; background: #ffffff; border: 1px solid #dbe3ee; border-radius: 8px; padding: 12px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { border-bottom: 1px solid #e5e7eb; text-align: left; padding: 6px; }
        th { color: #334155; background: #f1f5f9; }
        .status-pill { display: inline-block; border-radius: 12px; padding: 2px 8px; font-size: 12px; }
        .ok { background: #dcfce7; color: #166534; }
        .warn { background: #fef3c7; color: #92400e; }
      </style>
    </head>
    <body>
      <h1>EdgeCoder Control Plane Dashboard</h1>
      <div class="meta">
        <div><strong>Coordinator UI Home:</strong> <span id="uiHome"></span></div>
        <div><strong>Coordinator Runtime:</strong> <span id="runtime"></span></div>
        <div><strong>SQL Backend:</strong> <span id="sqlBackend"></span></div>
        <div><strong>Market Price:</strong> CPU <span id="cpuPrice">n/a</span> sats/cu | GPU <span id="gpuPrice">n/a</span> sats/cu</div>
        <div><strong>Last refresh:</strong> <span id="lastRefresh"></span></div>
      </div>
      <div class="cards" id="cards"></div>

      <div class="section">
        <h2>Agents</h2>
        <table>
          <thead><tr><th>Agent</th><th>User Email</th><th>OS</th><th>Version</th><th>Mode</th><th>Client</th><th>Provider</th><th>Capacity</th><th>Peers</th><th>IP</th><th>VPN</th><th>Country</th><th>Approval</th></tr></thead>
          <tbody id="agentsBody"></tbody>
        </table>
      </div>

      <div class="section">
        <h2>Coordinator Local Model Election</h2>
        <div class="meta">
          <strong>Current provider:</strong> <span id="coordProvider">unknown</span> |
          <strong>Auto-install:</strong> <span id="coordAutoInstall">false</span>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <input id="adminTokenInput" type="password" placeholder="Admin token" style="padding:6px; min-width:240px;" />
          <input id="modelInput" type="text" value="qwen2.5-coder:latest" style="padding:6px; min-width:240px;" />
          <button id="electOllamaBtn" style="padding:6px 10px;">Elect Ollama on Coordinator</button>
        </div>
        <div class="meta" id="electResult" style="margin-top:8px;"></div>
      </div>

      <div class="section">
        <h2>Blacklist</h2>
        <div class="meta"><strong>Version:</strong> <span id="blVersion">0</span> | <strong>Chain head:</strong> <span id="blHead">BLACKLIST_GENESIS</span></div>
        <table>
          <thead><tr><th>Agent</th><th>Reason Code</th><th>Reason</th><th>Reporter</th><th>Evidence Sig</th><th>Timestamp</th><th>Expires</th></tr></thead>
          <tbody id="blacklistBody"></tbody>
        </table>
      </div>

      <div class="section">
        <h3>Recent Blacklist Audit Events</h3>
        <table>
          <thead><tr><th>Event</th><th>Agent</th><th>Prev Hash</th><th>Event Hash</th><th>Timestamp</th></tr></thead>
          <tbody id="blacklistAuditBody"></tbody>
        </table>
      </div>

      <div class="section">
        <h2>Peer Direct Work Timeline</h2>
        <table>
          <thead><tr><th>Offer</th><th>From</th><th>To</th><th>Lang</th><th>Status</th><th>Created</th><th>Completed</th></tr></thead>
          <tbody id="directWorkBody"></tbody>
        </table>
      </div>

      <div class="section">
        <h2>Recent Model Rollouts</h2>
        <table>
          <thead><tr><th>Rollout</th><th>Target</th><th>Provider</th><th>Model</th><th>Status</th><th>Requested By</th><th>Updated</th></tr></thead>
          <tbody id="rolloutsBody"></tbody>
        </table>
      </div>

      <script>
        const cardSpec = [
          ["Total Capacity", "totalCapacity"],
          ["Agents Connected", "agentsConnected"],
          ["Swarm Enabled", "swarmEnabledCount"],
          ["Local Ollama", "localOllamaCount"],
          ["IDE Enabled", "ideEnabledCount"],
          ["Active Tunnels", "activeTunnels"],
          ["Direct Accepted", "peerDirectAccepted"],
          ["Direct Completed", "peerDirectCompleted"],
          ["Blacklisted Agents", "blacklistedAgents"],
          ["Queue Depth", "queued"],
          ["Completed Results", "results"]
        ];

        const safe = (v) => String(v ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        function fmt(ts) { return ts ? new Date(ts).toISOString() : "n/a"; }

        function rowOrEmpty(rows, colspan, message) {
          if (rows.length > 0) return rows.join("");
          return '<tr><td colspan="' + colspan + '">' + message + '</td></tr>';
        }

        function render(data) {
          document.getElementById("uiHome").textContent = data.deploymentPlan.coordinatorUiHome.service + data.deploymentPlan.coordinatorUiHome.route;
          document.getElementById("runtime").textContent = data.deploymentPlan.firstCoordinatorRuntime.recommendation;
          document.getElementById("sqlBackend").textContent = data.deploymentPlan.sqlBackend.engine + " " + data.deploymentPlan.sqlBackend.version;
          document.getElementById("cpuPrice").textContent = String((data.pricing && data.pricing.cpu && data.pricing.cpu.pricePerComputeUnitSats) || "n/a");
          document.getElementById("gpuPrice").textContent = String((data.pricing && data.pricing.gpu && data.pricing.gpu.pricePerComputeUnitSats) || "n/a");
          document.getElementById("lastRefresh").textContent = new Date(data.generatedAt).toISOString();

          const totals = data.capacity.totals || {};
          const cards = cardSpec.map(([label, key]) => {
            const value = key === "queued" ? (data.status.queued || 0) : key === "results" ? (data.status.results || 0) : (totals[key] || 0);
            const cls = key === "blacklistedAgents" && value > 0 ? "warn" : "ok";
            return '<div class="card"><div class="k">' + label + '</div><div class="v"><span class="status-pill ' + cls + '">' + safe(value) + '</span></div></div>';
          }).join("");
          document.getElementById("cards").innerHTML = cards;

          const agentRows = (data.capacity.agents || []).map((a) =>
            '<tr><td>' + safe(a.agentId) + '</td><td>' + safe(a.ownerEmail || "unknown") + '</td><td>' + safe(a.os) + '</td><td>' + safe(a.version) + '</td><td>' + safe(a.mode) + '</td><td>' + safe(a.clientType || "edgecoder-native") + '</td><td>' + safe(a.localModelProvider) + '</td><td>' + safe(a.maxConcurrentTasks) + '</td><td>' + safe((a.connectedPeers || []).length) + '</td><td>' + safe(a.sourceIp || "unknown") + '</td><td>' + safe(String(Boolean(a.vpnDetected))) + '</td><td>' + safe(a.countryCode || "unknown") + '</td><td>' + safe(a.nodeApproved === undefined ? "unknown" : (a.nodeApproved ? "approved" : "pending")) + '</td></tr>'
          );
          document.getElementById("agentsBody").innerHTML = rowOrEmpty(agentRows, 13, "No agents connected");

          document.getElementById("coordProvider").textContent = String(data.coordinatorModel.provider || "unknown");
          document.getElementById("coordAutoInstall").textContent = String(Boolean(data.coordinatorModel.ollamaAutoInstall));

          document.getElementById("blVersion").textContent = String(data.blacklist.version || 0);
          document.getElementById("blHead").textContent = String(data.blacklistAudit.chainHead || "BLACKLIST_GENESIS");
          const blacklistRows = (data.blacklist.records || []).map((r) =>
            '<tr><td>' + safe(r.agentId) + '</td><td>' + safe(r.reasonCode) + '</td><td>' + safe(r.reason) + '</td><td>' + safe(r.reporterId) + '</td><td>' + safe(r.evidenceSignatureVerified) + '</td><td>' + safe(fmt(r.timestampMs)) + '</td><td>' + safe(fmt(r.expiresAtMs)) + '</td></tr>'
          );
          document.getElementById("blacklistBody").innerHTML = rowOrEmpty(blacklistRows, 7, "No active blacklist records");

          const auditRows = (data.blacklistAudit.events || []).slice(-10).reverse().map((e) =>
            '<tr><td>' + safe(e.eventId) + '</td><td>' + safe(e.agentId) + '</td><td>' + safe((e.prevEventHash || "").slice(0,16) + "...") + '</td><td>' + safe((e.eventHash || "").slice(0,16) + "...") + '</td><td>' + safe(fmt(e.timestampMs)) + '</td></tr>'
          );
          document.getElementById("blacklistAuditBody").innerHTML = rowOrEmpty(auditRows, 5, "No audit events");

          const directRows = (data.directWork.events || []).map((e) =>
            '<tr><td>' + safe(e.offerId) + '</td><td>' + safe(e.fromAgentId) + '</td><td>' + safe(e.toAgentId) + '</td><td>' + safe(e.language) + '</td><td>' + safe(e.status) + '</td><td>' + safe(fmt(e.createdAtMs)) + '</td><td>' + safe(fmt(e.result && e.result.completedAtMs)) + '</td></tr>'
          );
          document.getElementById("directWorkBody").innerHTML = rowOrEmpty(directRows, 7, "No peer direct work events");

          const rolloutRows = ((data.rollouts && data.rollouts.rollouts) || []).slice(0, 20).map((r) =>
            '<tr><td>' + safe(r.rolloutId) + '</td><td>' + safe(r.targetType + ":" + r.targetId) + '</td><td>' + safe(r.provider) + '</td><td>' + safe(r.model) + '</td><td>' + safe(r.status) + '</td><td>' + safe(r.requestedBy) + '</td><td>' + safe(fmt(r.updatedAtMs)) + '</td></tr>'
          );
          document.getElementById("rolloutsBody").innerHTML = rowOrEmpty(rolloutRows, 7, "No rollout events");
        }

        async function refresh() {
          const res = await fetch("/ui/data", { cache: "no-store" });
          if (!res.ok) throw new Error("dashboard_data_unavailable");
          render(await res.json());
        }

        async function electCoordinatorOllama() {
          const token = document.getElementById("adminTokenInput").value || "";
          const model = document.getElementById("modelInput").value || "qwen2.5-coder:latest";
          const resultEl = document.getElementById("electResult");
          resultEl.textContent = "Submitting election...";
          const res = await fetch("/ui/actions/coordinator-ollama", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-admin-token": token
            },
            body: JSON.stringify({
              provider: "ollama-local",
              model,
              autoInstall: true
            })
          });
          const payload = await res.json().catch(() => ({}));
          resultEl.textContent = res.ok ? "Election submitted: " + (payload.rolloutId || "ok") : "Election failed: " + (payload.error || res.status);
          await refresh().catch(() => undefined);
        }

        document.getElementById("electOllamaBtn").addEventListener("click", () => {
          electCoordinatorOllama().catch((err) => {
            document.getElementById("electResult").textContent = "Election failed: " + String(err);
          });
        });

        refresh().catch((err) => { console.error(err); });
        setInterval(() => { refresh().catch(() => undefined); }, 5000);
      </script>
    </body>
  </html>`;
  return reply.type("text/html").send(html);
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
    lastSeenMs: record.lastSeenMs
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
    lastSeenMs: current.lastSeenMs
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
    lastSeenMs: current.lastSeenMs
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
