// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { refreshOllamaCapabilities } from "../../model/tool-support.js";
import { writeSseHead } from "../../common/sse.js";
import Fastify, { type FastifyReply } from "fastify";
import { exposeRequestId, serviceLoggerOptions } from "../../common/http-logging.js";
import { registerMetrics } from "../../common/metrics.js";
import { registerErrorTracking } from "../../common/error-tracking.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ProviderRegistry } from "../../model/providers.js";
import { InteractiveAgent } from "../../agent/interactive.js";
import { IntelligentRouter, SwarmPostSubmitError } from "../../model/router.js";
import {
  formatOpenAiResponse,
  formatOpenAiStreamChunk,
  formatOpenAiModelsResponse,
} from "./openai-compat.js";
import { buildChatSystemPrompt, buildIdeAgentSystemPrompt, type SystemPromptContext } from "../../model/system-prompt.js";
import { ollamaTags } from "../../model/swap.js";
import { PullTracker } from "../../model/pull-tracker.js";
import { ToolExecutor, hasGitHubOrigin, preparePullRequestArgs } from "./tool-executor.js";
import { MAX_EDITOR_FILE_BYTES, ProjectFs, ProjectFsError, findPaths, readProjectRules } from "./project-fs.js";
import { CheckpointStore } from "./checkpoints.js";
import { cleanInlineEdit, inlineEditMessages } from "./inline-edit.js";
import { backendChat, makeToolRunner, ollamaChat, runAgentLoop, toolSchemas, type ChatFn } from "./agent-loop.js";
import { completeAt } from "./complete.js";
import { codebaseIndexFor } from "./codebase-index.js";
import { GitError, GitOps } from "./git-ops.js";
import { GitSetupError, cloneRepo, githubStatus, normalizeRemoteUrl } from "./git-setup.js";
import type { CredentialDeps } from "./github-auth.js";
import { connectRepoUrl, defaultProjectsFolder, getProjectsFolder, recentGitHubRepos, setProjectsFolder } from "./repo-connect.js";
import { isAbsolute } from "node:path";
import { NetworkTasks } from "./network-tasks.js";
import { buyCSats, usageSummary, cancelReservation, computeOverview, contentToText, drainAgent, createReservation, listNetworkModels, listReservations, networkContextWindow, purchaseStatus, NetworkInferenceError, parseNetworkModel, streamNetworkCompletion, call as networkCall, ownInflightTaskIds, type CompletionPiece, type NetworkDeps } from "./network-inference.js";
import { ActivityTracker, firstLine } from "./activity.js";
import { botActivity, networkTaskActivity, registerActivityRoutes, sessionActivity, tentacleActivity } from "./activity-routes.js";
import { networkWorld } from "./network-world.js";
import { ConnectionManager } from "./connections.js";
import { registerRemoteBotRoutes } from "./bot-remote.js";
import { BotManager, agentBotRunner, botBranchPrefix, botComputeChat, botWorkRoot, registerBotRoutes, type ApprovalEntry } from "./bots.js";
import { autoBackend, localBackend, networkBackend } from "../../inference-api/backends.js";
import { registerCompatRoutes, respondWith } from "../../inference-api/routes.js";
import type { RoutingHints } from "../../inference-api/job-descriptor.js";
import { AUTO_MODEL_ID, AUTO_POLICIES, autoPolicyFromEnv, isUnpinnedModel, routeInputsFrom, routeLabel, routeSummary, type ComputePolicy, type PlanOptions, type Route, type RouteInputs } from "../../inference-api/auto-route.js";
import { ChatBackendError, type ChatBackend } from "../../inference-api/types.js";
import { ATTACHMENT_BODY_LIMIT, attachmentsSchema, withAttachments } from "./attachments.js";
import { checkProject } from "./diagnostics.js";
import { isProjectTrusted, loadOrCreateMachineSalt, setProjectTrusted } from "./workspace-trust.js";
import { registerCodeRemoteRoutes } from "./code-remote.js";
import { desktopTurnFor, firstAnswer, registerDesktopChatRoutes } from "./desktop-chats.js";
import { createPreviewServer, PREVIEW_DEFAULT_PORT } from "./preview-server.js";
import { NewProjectError, PROJECT_TEMPLATES, createNewProject } from "./new-project.js";
import type { IdeStreamEvent, ToolName } from "./tool-types.js";
import { defaultPermissionsFile, PermissionStore, riskOf, type PermissionMode } from "./permissions.js";
import { decideToolCall, suggestToolRule, type Decision } from "./permission-policy.js";
import { SwarmSpendGuard, swarmBudgetFromEnv } from "./swarm-budget.js";
import { gitExecEnv, hardenedGitArgs } from "./git-safe.js";
import { allowedOrigins, createIdeAuthHook, isLoopbackHost, registerIdeCors, resolveIdeToken, resolveListenOptions } from "./ide-auth.js";
import { loadConfigOrExit } from "../../common/config.js";
import { ideProviderConfigSchema } from "../../config/ide-provider.js";
import { SessionHub, compactionModelOf, modelIdOf, parseModelId as parseModelIdForChat, workerModelOf, type ClientRef, type SessionData } from "./sessions.js";
import { cliStatus, installCli } from "./cli-install.js";
import { pickLocalHelperModel, TentacleManager } from "./tentacles.js";
import { tentacleExecutor, withTentacleGuidance, withTentacleTools } from "./delegate.js";
import { registerTentacleRoutes } from "./tentacle-routes.js";
import { chooseLeadModel, estimateTokens, parseLeadCandidates } from "./lead-model.js";
import { registerSessionRoutes } from "./session-routes.js";
import { hostedBackend, hostedConfigFromEnv } from "./hosted-backend.js";
import { GitHubDeviceLogins } from "./github-device.js";
import { FrontierAccess, autoWithFrontier, botSpendKey, frontierChat, type FrontierAccountState, type FrontierRequest } from "./frontier-access.js";
import { botFrontierChat } from "./bot-frontier.js";
import { FrontierKeyError, FrontierKeyStore } from "../../inference-api/frontier-keys.js";
import { FrontierSpend } from "../../inference-api/frontier-usage.js";
import { frontierContextWindow, isFrontierModelId } from "../../inference-api/frontier-models.js";
import { request as undiciRequest } from "undici";
import { FREE_USED_NOTE, webSystemNote, webGrounding, WebToolSession, forgetWebAvailability, isWebTool, webAvailability, webReplyLimitsFromEnv, webStatusReason, webToolSchemas, type WebToolCall } from "../../web-tool/tools.js";
import { modelCallsTools } from "../../web-tool/model-support.js";
import { toolchainFailureHint, toolchainNote } from "./toolchain.js";

// Forked by the agent: exit with it, so a restarted agent's provider can take the port.
if (process.send) process.on("disconnect", () => process.exit(0));

const app = Fastify({ ...serviceLoggerOptions("ide-provider") });
exposeRequestId(app);
registerMetrics(app, "ide-provider");
await registerErrorTracking(app, "ide-provider");

// #4: loopback bind + bearer token (except /health) + web-Origin / foreign-Host rejection.
// No import-time side effects: the token file is read/created on first authenticated
// request, and the bind address is validated only when the server is started.
// #15: the environment is validated here (a pure read); per-request reads below stay live.
const C = loadConfigOrExit("ide-provider", ideProviderConfigSchema);
const ideHost = C.IDE_PROVIDER_HOST;
const idePort = C.IDE_PROVIDER_PORT || 4304;
let ideToken: string | undefined;
const ideOrigins = allowedOrigins();
app.addHook(
  "onRequest",
  createIdeAuthHook({
    token: () => (ideToken ??= resolveIdeToken()),
    port: idePort,
    enforceLoopbackHost: isLoopbackHost(ideHost),
    allowedOrigins: ideOrigins,
  })
);
// #77: after the auth hook, so a preflight from a disallowed origin is rejected (403) first.
await registerIdeCors(app, ideOrigins);

const PKG_VERSION = (() => {
  try {
    // src/apps/ide or dist/apps/ide -> repo root package.json
    return (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

app.get("/health", async () => ({ ok: true, service: "ide-provider", version: PKG_VERSION }));

// Settings → Active work: calls to the OpenAI / Anthropic endpoints while they run. The desktop's own
// chat (no project open) marks itself with user "edgecoder-desktop-chat".
app.addHook("preHandler", async (req, reply) => {
  const path = req.url.split("?")[0];
  if (req.method !== "POST" || (path !== "/v1/chat/completions" && path !== "/v1/messages")) return;
  const b = (req.body ?? {}) as { model?: unknown; user?: unknown; messages?: Array<{ role?: unknown; content?: unknown }> };
  const lastUser = Array.isArray(b.messages) ? [...b.messages].reverse().find((m) => m?.role === "user") : undefined;
  const text = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? contentToText(lastUser.content) : "";
  const fromChat = b.user === "edgecoder-desktop-chat";
  const handle = activity.begin({
    kind: fromChat ? "chat" : "api",
    title: firstLine(text) || (typeof b.model === "string" ? b.model : "API call"),
    source: fromChat ? "EdgeCoder chat" : path === "/v1/messages" ? "Anthropic API" : "OpenAI API",
    ...(typeof b.model === "string" ? { model: b.model } : {}),
  });
  reply.raw.on("close", () => handle.end(reply.raw.statusCode >= 400 ? "failed" : reply.raw.writableFinished ? "done" : "cancelled", reply.raw.statusCode >= 400 ? `HTTP ${reply.raw.statusCode}` : undefined));
});

const providers = new ProviderRegistry();

/**
 * Frozen snapshot for swarm submissions (#8): the active project's git HEAD, so the
 * coordinator's /submit accepts the task. IDE_SWARM_SNAPSHOT_REF overrides (router).
 */
function projectHeadCommit(): string | undefined {
  if (!activeProjectRoot) return undefined;
  try {
    const head = execFileSync("git", hardenedGitArgs(["-C", activeProjectRoot, "rev-parse", "HEAD"], activeProjectRoot), {
        env: gitExecEnv(),
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return /^[0-9a-f]{40}$/i.test(head) ? head.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
const router = new IntelligentRouter({
  resolveSnapshotRef: () => process.env.IDE_SWARM_SNAPSHOT_REF?.trim() || projectHeadCommit(),
  // The local agent's forwarder accepts the same IDE token this server does.
  localAgentToken: () => (ideToken ??= resolveIdeToken())
});

// #36: the VS Code extension polls /status; alias of /v1/router/status.
// #71: per-request / per-session swarm spend caps.
const swarmBudget = new SwarmSpendGuard(swarmBudgetFromEnv());
app.get("/status", async () => ({ ...router.status(), swarmBudget: swarmBudget.status() }));
const idePullTracker = new PullTracker();

// --- IDE Agent state ---

let activeProjectRoot: string | null = null;
/** Tool calls waiting for the user, from chat turns and bot runs (`owner` says whose). */
const pendingApprovals = new Map<string, ApprovalEntry>();
/** "Always allow" answers per project (~/.edgecoder/permissions.json), shared by chat, sessions and bots. */
const permissionStore = new PermissionStore(defaultPermissionsFile());

/** The verdict on a call in a chat turn or bot run (permission-policy.ts): the mode, then the project's rules. */
function decideFor(mode: PermissionMode, root: string, tool: ToolName, args: Record<string, unknown>): Decision {
  const p = permissionStore.get(root);
  return decideToolCall(tool, args, { mode, root, rules: p.rules ?? [], legacyNames: p.shell, branch: () => currentBranch(root) }, (c) => riskOf(c, root));
}
/** The owner's requests through this provider while they run, then briefly (Settings → Active work / Tasks). */
const activity = new ActivityTracker();

// --- OpenAI-compatible endpoints ---

/** This machine's agent forwarder, when the machine is on the network (network models need it). */
const networkDeps: NetworkDeps | null = C.SWARM_VIA_LOCAL_AGENT_URL
  ? { forwarder: C.SWARM_VIA_LOCAL_AGENT_URL.replace(/\/$/, ""), token: () => (ideToken ??= resolveIdeToken()), agentId: C.AGENT_ACCOUNT_ID ?? C.AGENT_ID ?? "local-agent" }
  : null;

// --- Frontier models on the user's own key (docs/frontier-keys.md, frontier-access.ts) ---

/** The hosted endpoint and the user's API key (EDGECODER_API_KEY / _FILE), for network models without an enrolled agent. */
const hosted = hostedConfigFromEnv();

/**
 * The web tool's calls (docs/web-tool.md): to the coordinator's /v1/tools/web/* through this
 * machine's agent (signed, billed to its owner), else the hosted endpoint with the API key. The
 * search and the page fetch run on EdgeCoder's servers; nothing is fetched from this machine.
 */
const webCall: WebToolCall | null = networkDeps
  ? (path, body, signal) => networkCall(networkDeps, "POST", path, body, signal)
  : hosted
    ? async (path, body, signal) => {
        const res = await undiciRequest(`${hosted.baseUrl}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${hosted.apiKey()}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          headersTimeout: 30_000,
          bodyTimeout: 30_000,
          signal,
        });
        const text = await res.body.text();
        try {
          return { status: res.statusCode, json: JSON.parse(text) as Record<string, unknown> };
        } catch {
          return { status: res.statusCode, json: { error: "bad_response" } };
        }
      }
    : null;

/**
 * The EdgeCoder account signed in on this computer: from this machine's enrolled agent (the
 * coordinator's account summary), else from the hosted endpoint for the API key. Cached briefly.
 */
let accountCache: { at: number; id: string | null; state: FrontierAccountState } | null = null;
let lastAccount: string | undefined;
/** The account last confirmed signed in, and when (ms); cleared by a definitive "signed out". */
let confirmed: { id: string; at: number } | null = null;
/**
 * How long an "unknown" answer (coordinator slow, agent reconnecting, the machine busy compiling)
 * keeps the last confirmed account. Only a definitive "signed out" ends it sooner, so a blip
 * mid-turn no longer drops a frontier lead with "Sign in to EdgeCoder".
 */
const ACCOUNT_UNKNOWN_GRACE_MS = 10 * 60_000;
async function machineAccount(): Promise<string | null> {
  const id = await checkMachineAccount();
  if (id) return id;
  if (accountCache?.state === "unknown" && confirmed && Date.now() - confirmed.at < ACCOUNT_UNKNOWN_GRACE_MS) return confirmed.id;
  return null;
}
async function checkMachineAccount(): Promise<string | null> {
  // A definitive answer is kept a minute (signed in) or 10 s (signed out); an unknown one (the
  // agent isn't connected yet, the coordinator is slow) is retried after 3 s.
  if (accountCache && Date.now() - accountCache.at < (accountCache.state === "signed_in" ? 60_000 : accountCache.state === "signed_out" ? 10_000 : 3_000)) return accountCache.id;
  let id: string | null = null;
  let state: FrontierAccountState = "signed_out";
  try {
    if (networkDeps) {
      const ov = await computeOverview(networkDeps);
      id = ov.account?.accountId ?? null;
      // No account summary from a connected agent's coordinator is still not a "no": the agent's
      // credentials are for this machine's signed-in account, the summary just didn't come back.
      state = id ? "signed_in" : "unknown";
    } else if (hosted) {
      const res = await undiciRequest(`${hosted.baseUrl}/v1/account`, { method: "GET", headers: { authorization: `Bearer ${hosted.apiKey()}` }, headersTimeout: 10_000, bodyTimeout: 10_000 });
      const j = res.statusCode === 200 ? ((await res.body.json()) as { accountId?: unknown }) : (await res.body.dump(), null);
      id = typeof j?.accountId === "string" ? j.accountId : null;
      state = id ? "signed_in" : res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 200 ? "signed_out" : "unknown";
    }
  } catch {
    id = null;
    state = "unknown";
  }
  accountCache = { at: Date.now(), id, state };
  if (id) {
    lastAccount = id;
    confirmed = { id, at: Date.now() };
  } else if (state === "signed_out") {
    confirmed = null;
  }
  return id;
}
const machineAccountState = (): FrontierAccountState => accountCache?.state ?? "unknown";

const frontier = new FrontierAccess({ store: new FrontierKeyStore(), spend: new FrontierSpend(), account: machineAccount, accountState: machineAccountState });

const frontierChatFn = (id: string, req: Omit<FrontierRequest, "onWarn" | "onCost">, sendEvent: (e: IdeStreamEvent) => void, signal: AbortSignal, fallback?: () => ChatFn) =>
  frontierChat({ access: frontier, id, request: req, sendEvent, signal, fallback });

// --- Auto: each request at the cheapest place that fits it (src/inference-api/auto-route.ts) ---

let routeCache: { at: number; inputs: RouteInputs } | null = null;
async function routeInputsHere(): Promise<RouteInputs> {
  if (routeCache && Date.now() - routeCache.at < 15_000) return routeCache.inputs;
  const localModels = await ollamaTags().then((t) => t.models.map((m) => m.name)).catch(() => [] as string[]);
  // What each local model can do (Ollama /api/show "capabilities"), so agent steps skip models without tools.
  await refreshOllamaCapabilities(localModels, { host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434" });
  const [ov, leases] = networkDeps
    ? await Promise.all([
        computeOverview(networkDeps).catch(() => null),
        listReservations(networkDeps).then((r) => (r.status === 200 ? ((r.json.reservations as never[]) ?? []) : [])).catch(() => []),
      ])
    : [null, []];
  const inputs = routeInputsFrom({ localModels, selfAgentId: networkDeps?.agentId, machines: ov?.account?.machines, networkModels: ov?.models?.filter((m) => !m.restricted), classes: ov?.classes, leases, balanceCSats: ov?.account?.cSats });
  routeCache = { at: Date.now(), inputs };
  return inputs;
}

function runRoute(r: Route, source = "localhost:4304"): ChatBackend {
  if (r.placement === "local") return localBackend(process.env.OLLAMA_HOST || "http://127.0.0.1:11434", r.model);
  if (!networkDeps) {
    return async function* () {
      throw new ChatBackendError("This computer isn't connected to the network, so it can't reach your other machines or network models.", 503);
    };
  }
  return networkBackend(networkDeps, {
    model: r.model,
    computeClass: r.placement === "network" ? r.computeClass ?? "any" : "any",
    ...(r.placement === "mine" ? { target: "mine" as const } : {}),
    ...(r.placement === "reserved" ? { reservationId: r.reservationId } : {}),
    source,
  });
}

/**
 * Auto here: free places first (this computer, your machines, a lease, in the policy's order); the
 * network leg goes to the coordinator as model "auto", so its best-fit routing picks the model,
 * class and machine (your own machines are never picked there). The client-side network routes stay
 * behind it for an older coordinator. Chat and Code view Auto, `edgecoder code` sessions, bots
 * (Local first / Auto) and connections all run here. Without a policy it is EDGECODER_AUTO_POLICY
 * (default "auto"; "mine_only" keeps chat and API Auto on free machines). Each step's complexity
 * sizes the free places (auto-route.ts); `hysteresis` "session" is for a backend many clients share.
 */
const autoHere = (onRoute?: (r: Route) => void, source?: string, policy?: ComputePolicy, plan?: () => PlanOptions, hysteresis?: "backend" | "session") =>
  autoBackend({
    inputs: routeInputsHere,
    run: (r) => runRoute(r, source),
    onRoute,
    policy: policy ?? autoPolicyFromEnv(),
    plan,
    ...(hysteresis ? { hysteresis } : {}),
    ...(networkDeps ? { networkBestFit: (routing: RoutingHints) => networkBackend(networkDeps!, { model: AUTO_MODEL_ID, computeClass: routing.computeClass ?? "any", routing, source: source ?? "localhost:4304" }) } : {}),
  });

/** Auto for API clients (OpenAI and Anthropic routes): one backend, so a client's session id keeps its complexity window. */
const apiAuto = autoHere(undefined, undefined, undefined, undefined, "session");

app.get("/v1/models", async () => {
  // Providers, this machine's Ollama models, and models agents on the network have
  // ("network/<model>", optionally "@<class>"): one list for tools that pick a model.
  const ids = new Set<string>([AUTO_MODEL_ID, ...providers.availableProviders()]);
  try {
    for (const m of (await ollamaTags()).models) ids.add(m.name);
  } catch {
    // Ollama not running
  }
  if (networkDeps) {
    try {
      for (const m of await listNetworkModels(networkDeps)) ids.add(m.id);
    } catch {
      // not connected right now
    }
  }
  // Frontier models only when the signed-in account has a key for that provider here.
  for (const id of await frontier.modelIds().catch(() => [])) ids.add(id);
  return formatOpenAiModelsResponse([...ids]);
});

const chatRequestSchema = z.object({
  // No model (or "default"): Auto, like "auto" (isUnpinnedModel). "edgecoder-local" pins this computer.
  model: z.string().optional().transform((m) => (isUnpinnedModel(m) ? AUTO_MODEL_ID : m!)),
  messages: z.array(z.object({
    role: z.string(),
    // OpenAI clients send a string or a list of content parts.
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).transform((c) => contentToText(c))
  })).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().optional()
});

app.post("/v1/chat/completions", async (req, reply) => {
  const body = chatRequestSchema.parse(req.body);
  const requestId = `chatcmpl-${randomUUID()}`;
  // "auto": the cheapest place that fits this request (tools and all, so through the shared writer).
  if (body.model === AUTO_MODEL_ID) return respondWith(req, reply, "openai", apiAuto, AUTO_MODEL_ID);
  // "frontier/<provider>/<model>": the signed-in account's own key, straight to the provider.
  if (isFrontierModelId(body.model)) {
    const r = await frontier.resolve(body.model, { sessionKey: "api" });
    if (!r.ok) return reply.status(r.status).send({ error: { message: r.message, type: "frontier_unavailable" } });
    return respondWith(req, reply, "openai", r.backend, body.model);
  }

  // "network/<model>[@class]": run on an agent on the network, billed per second by class.
  const network = parseNetworkModel(body.model);
  if (network) {
    if (!networkDeps) {
      return reply.status(503).send({ error: { message: "Network models need this computer to be signed in to EdgeCoder and connected to the network.", type: "network_unavailable" } });
    }
    const abort = new AbortController();
    reply.raw.on("close", () => { if (!reply.raw.writableEnded) abort.abort(); });
    const pieces = streamNetworkCompletion(networkDeps, { ...network, messages: body.messages, maxTokens: body.max_tokens, temperature: body.temperature }, abort.signal);
    if (!body.stream) {
      let text = "";
      let spent: number | undefined;
      try {
        for await (const p of pieces) {
          if (p.delta) text += p.delta;
          if (p.done) {
            spent = p.creditsSpent;
            if (p.error && !text) throw new NetworkInferenceError(`The model failed: ${p.error}`, 502);
          }
        }
      } catch (err) {
        const status = err instanceof NetworkInferenceError ? err.status : 502;
        return reply.status(status).send({ error: { message: (err as Error).message, type: "network_error" } });
      }
      return reply.send({ ...formatOpenAiResponse(requestId, body.model, text), ...(spent !== undefined ? { edgecoder: { cSatsSpent: spent } } : {}) });
    }
    // Streaming: report a submit failure as an HTTP error before the stream starts.
    let first: IteratorResult<CompletionPiece>;
    try {
      first = await pieces.next();
    } catch (err) {
      const status = err instanceof NetworkInferenceError ? err.status : 502;
      return reply.status(status).send({ error: { message: (err as Error).message, type: "network_error" } });
    }
    writeSseHead(reply);
    const emit = (p: CompletionPiece) => {
      if (p.delta) reply.raw.write(`data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, body.model, p.delta))}\n\n`);
      if (p.done) {
        if (p.error) reply.raw.write(`data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, body.model, `\n\n[network error: ${p.error}]`))}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ ...formatOpenAiStreamChunk(requestId, body.model, "", "stop"), ...(p.creditsSpent !== undefined ? { edgecoder: { cSatsSpent: p.creditsSpent } } : {}) })}\n\n`);
      }
    };
    try {
      if (!first.done) emit(first.value);
      for await (const p of pieces) emit(p);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, body.model, `\n\n[network error: ${(err as Error).message}]`, "stop"))}\n\n`);
    }
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return reply;
  }

  // Build system prompt from live state
  let systemPromptMsg: { role: string; content: string } | null = null;
  try {
    let ollamaHealthy = true;
    let installedModels: Array<{ name: string; paramSize: number }> = [];
    let activeModelParamSize = 0;
    let activeModelQuantization: string | undefined;
    const activeModel = body.model !== "edgecoder-local" ? body.model : (process.env.OLLAMA_MODEL ?? "qwen3.5:9b");

    try {
      const tags = await ollamaTags();
      installedModels = tags.models.map((m) => ({
        name: m.name,
        paramSize: parseFloat(m.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0"),
      }));
      const entry = tags.models.find((m) => m.name === activeModel);
      if (entry) {
        activeModelParamSize = parseFloat(entry.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0");
        activeModelQuantization = entry.details.quantization_level;
      }
    } catch {
      ollamaHealthy = false;
    }

    const routerStatus = router.status();
    const pullProgress = idePullTracker.getProgress();

    const ctx: SystemPromptContext = {
      activeModel,
      activeModelParamSize,
      activeModelQuantization,
      installedModels,
      swarmModels: [],
      ollamaHealthy,
      queueDepth: 0,
      connectedAgents: 0,
      pullInProgress: pullProgress ? { model: pullProgress.model, progressPct: pullProgress.progressPct } : undefined,
      routeUsed: undefined,
    };
    systemPromptMsg = { role: "system", content: buildChatSystemPrompt(ctx) };
  } catch {
    // Non-critical — proceed without system prompt
  }

  // Merge: our system prompt first, then preserve client file-context system messages, then user/assistant
  const clientFileContextMsgs = body.messages.filter((m) => m.role === "system");
  const nonSystemMsgs = body.messages.filter((m) => m.role !== "system");
  const messagesWithSystem = [
    ...(systemPromptMsg ? [systemPromptMsg] : []),
    ...clientFileContextMsgs,
    ...nonSystemMsgs,
  ];

  const result = await router.routeChat(messagesWithSystem, {
    stream: body.stream,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    requestedModel: body.model !== "edgecoder-local" ? body.model : undefined,
  });

  app.log.info({ route: result.route, model: result.model }, "chat routed");

  // --- Streaming via Ollama (local or bluetooth) ---
  if (result.stream) {
    writeSseHead(reply);

    // Send route metadata as first event so the UI can show it immediately
    const routeLabels: Record<string, string> = {
      "ollama-local": "local model",
      "bluetooth-local": "nearby device",
      "swarm": "swarm network",
      "edgecoder-local": "offline",
    };
    reply.raw.write(`data: ${JSON.stringify({
      route_info: {
        route: result.route,
        label: routeLabels[result.route] ?? result.route,
        model: result.model,
        p95Ms: router.status().localLatencyP95Ms,
        concurrent: router.status().activeConcurrent,
      }
    })}\n\n`);

    const streamStart = Date.now();
    try {
      for await (const chunk of result.stream) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
        const lines = text.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };

            if (parsed.message?.content) {
              reply.raw.write(
                `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, result.model, parsed.message.content))}\n\n`,
              );
            }

            if (parsed.done) {
              router.recordStreamComplete(Date.now() - streamStart);
              reply.raw.write(
                `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, result.model, "", "stop"))}\n\n`,
              );
              reply.raw.write("data: [DONE]\n\n");
              reply.raw.end();
              return;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      // Stream ended without done flag — close gracefully
      router.recordStreamComplete(Date.now() - streamStart);
      reply.raw.write(
        `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, result.model, "", "stop"))}\n\n`,
      );
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    } catch (err) {
      router.recordStreamComplete(Date.now() - streamStart);
      const errorMsg = err instanceof Error ? err.message : "Stream failed";
      reply.raw.write(
        `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, "error", `Error: ${errorMsg}`))}` + "\n\n",
      );
      reply.raw.write(
        `data: ${JSON.stringify(formatOpenAiStreamChunk(requestId, "error", "", "stop"))}\n\n`,
      );
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    }
    return;
  }

  // --- Non-streaming response (any route) ---

  // Swarm results include route metadata
  let content = result.text ?? "";
  if (result.route === "swarm" && result.swarmTaskId) {
    content += `\n\n_Routed via swarm (task: ${result.swarmTaskId})_`;
  }

  return reply.send(formatOpenAiResponse(requestId, result.model, content));
});

// --- Router status endpoint ---

app.get("/v1/router/status", async () => {
  return router.status();
});

// --- Pull progress endpoint ---

app.get("/model/pull/progress", async (_req, reply) => {
  const progress = idePullTracker.getProgress();
  return reply.send(progress ?? { status: "idle" });
});

// --- IDE Agent endpoints ---

const projectBodySchema = z.object({
  projectRoot: z.string().min(1),
});

app.post("/v1/ide/project", async (req, reply) => {
  const body = projectBodySchema.parse(req.body);
  const { existsSync: fsExists, statSync } = await import("node:fs");
  if (!fsExists(body.projectRoot) || !statSync(body.projectRoot).isDirectory()) {
    return reply.status(400).send({ error: "Not a valid directory" });
  }
  activeProjectRoot = body.projectRoot;
  return reply.send({ ok: true, projectRoot: activeProjectRoot, trusted: isProjectTrusted(activeProjectRoot) });
});

app.get("/v1/ide/project", async (_req, reply) => {
  return reply.send({ projectRoot: activeProjectRoot });
});

// ---------------------------------------------------------------------------
// Project files for the editor and file tree, confined to the open project (project-fs.ts).
// Mutations are POST (the desktop's CORS also allows PUT, PATCH and DELETE: ide-auth.ts IDE_CORS_METHODS).
// ---------------------------------------------------------------------------

const FS_ERROR_STATUS: Record<ProjectFsError["code"], number> = {
  escape: 403, not_found: 404, not_a_file: 400, not_a_dir: 400, too_large: 413, binary: 415, exists: 409, conflict: 409, invalid: 400,
};

async function withProjectFs(reply: FastifyReply, fn: (fs: ProjectFs) => unknown): Promise<unknown> {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  try {
    return reply.send(await fn(new ProjectFs(activeProjectRoot)));
  } catch (err) {
    if (err instanceof ProjectFsError) return reply.status(FS_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid", message: err.message });
    throw err;
  }
}

const fsPath = z.string().max(4096);

app.get("/v1/ide/fs/list", (req, reply) =>
  withProjectFs(reply, (fs) => ({ entries: fs.list(z.object({ path: fsPath.default("") }).parse(req.query).path) })));
app.get("/v1/ide/fs/read", (req, reply) =>
  withProjectFs(reply, (fs) => fs.read(z.object({ path: fsPath.min(1) }).parse(req.query).path)));
app.post("/v1/ide/fs/write", (req, reply) =>
  withProjectFs(reply, (fs) => {
    const b = z.object({ path: fsPath.min(1), content: z.string().max(MAX_EDITOR_FILE_BYTES), baseMtimeMs: z.number().optional() }).parse(req.body);
    return fs.write(b.path, b.content, b.baseMtimeMs);
  }));
app.post("/v1/ide/fs/create", (req, reply) =>
  withProjectFs(reply, (fs) => {
    const b = z.object({ path: fsPath.min(1), kind: z.enum(["file", "dir"]) }).parse(req.body);
    return fs.create(b.path, b.kind);
  }));
app.post("/v1/ide/fs/rename", (req, reply) =>
  withProjectFs(reply, (fs) => {
    const b = z.object({ from: fsPath.min(1), to: fsPath.min(1) }).parse(req.body);
    return fs.rename(b.from, b.to);
  }));
app.post("/v1/ide/fs/delete", (req, reply) =>
  withProjectFs(reply, (fs) => {
    fs.remove(z.object({ path: fsPath.min(1) }).parse(req.body).path);
    return { ok: true };
  }));
app.post("/v1/ide/fs/stat", (req, reply) =>
  withProjectFs(reply, (fs) => ({ mtimes: fs.stat(z.object({ paths: z.array(fsPath).max(200) }).parse(req.body).paths) })));
app.get("/v1/ide/fs/find", (req, reply) =>
  withProjectFs(reply, () => {
    const { q, limit } = z.object({ q: z.string().max(256).default(""), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    return { matches: findPaths(activeProjectRoot!, q, limit) };
  }));
app.get("/v1/ide/fs/git-status", (_req, reply) =>
  withProjectFs(reply, (fs) => fs.gitStatus() ?? { branch: null, files: {} }));

// Agent turn checkpoints: what a turn changed, and undo (checkpoints.ts).
const checkpoints = new CheckpointStore();

app.get("/v1/ide/checkpoints/:turnId", async (req, reply) => {
  const { turnId } = z.object({ turnId: z.string().uuid() }).parse(req.params);
  const changes = checkpoints.changes(turnId);
  if (!changes) return reply.status(404).send({ error: "unknown_turn" });
  return reply.send({ turnId, changes });
});

app.post("/v1/ide/checkpoints/:turnId/revert", async (req, reply) => {
  const { turnId } = z.object({ turnId: z.string().uuid() }).parse(req.params);
  const { paths } = z.object({ paths: z.array(z.string().max(4096)).max(500).optional() }).parse(req.body ?? {});
  try {
    const reverted = checkpoints.revert(turnId, paths);
    if (!reverted) return reply.status(404).send({ error: "unknown_turn" });
    return reply.send({ ok: true, reverted });
  } catch (err) {
    if (err instanceof ProjectFsError) return reply.status(FS_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
    throw err;
  }
});

// Inline edit (Cmd+K): the local model rewrites the selection (or writes code at the cursor).
const inlineEditSchema = z.object({
  path: z.string().max(4096),
  language: z.string().max(64),
  prefix: z.string().max(20_000),
  selection: z.string().max(40_000),
  suffix: z.string().max(10_000),
  instruction: z.string().min(1).max(2_000),
  model: z.string().max(200).optional(),
});

app.post("/v1/ide/inline-edit", async (req, reply) => {
  const body = inlineEditSchema.parse(req.body);
  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const model = body.model || process.env.OLLAMA_MODEL || "qwen3.5:9b";
  const { request: httpRequest } = await import("undici");
  let res: Awaited<ReturnType<typeof httpRequest>>;
  try {
    res = await httpRequest(`${ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: inlineEditMessages(body),
        stream: false,
        think: false,
        options: { temperature: 0.2 },
      }),
      headersTimeout: 120_000,
      bodyTimeout: 120_000,
    });
  } catch (err) {
    return reply.status(503).send({ error: "model_unreachable", message: `Ollama at ${ollamaHost}: ${(err as Error).message}` });
  }
  const payload = (await res.body.json().catch(() => ({}))) as { message?: { content?: string }; error?: string };
  if (res.statusCode >= 400 || payload.error) {
    return reply.status(502).send({ error: "model_error", message: payload.error ?? `HTTP ${res.statusCode}` });
  }
  return reply.send({ model, replacement: cleanInlineEdit(payload.message?.content ?? "", body.selection) });
});

// Tab autocomplete: fill-in-the-middle from a small coder model (complete.ts).
app.post("/v1/ide/complete", async (req, reply) => {
  const body = z.object({
    prefix: z.string().max(20_000),
    suffix: z.string().max(10_000),
    model: z.string().max(200).optional(),
  }).parse(req.body);
  const abort = new AbortController();
  // The editor cancels stale requests as the user keeps typing. The response closing before it
  // was sent means the client went away (the request's own "close" fires once its body is read).
  reply.raw.on("close", () => { if (!reply.raw.writableEnded) abort.abort(); });
  try {
    return reply.send(await completeAt(process.env.OLLAMA_HOST || "http://127.0.0.1:11434", body, abort.signal));
  } catch (err) {
    if (abort.signal.aborted) return reply.status(499).send({ error: "cancelled" });
    return reply.status(503).send({ completion: "", reason: "error", message: (err as Error).message });
  }
});

// Codebase index (codebase-index.ts): build in the background, status, search by meaning.
const ollamaHostForIndex = () => process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

app.post("/v1/ide/index/build", async (_req, reply) => {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  const idx = codebaseIndexFor(activeProjectRoot, ollamaHostForIndex());
  void idx.build().catch(() => undefined); // the error is kept in the status
  return reply.send(idx.getStatus());
});

app.get("/v1/ide/index/status", async (_req, reply) => {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  return reply.send(codebaseIndexFor(activeProjectRoot, ollamaHostForIndex()).getStatus());
});

app.post("/v1/ide/index/search", async (req, reply) => {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  const { query, k } = z.object({ query: z.string().min(1).max(2_000), k: z.number().int().min(1).max(30).default(8) }).parse(req.body);
  const idx = codebaseIndexFor(activeProjectRoot, ollamaHostForIndex());
  if (idx.getStatus().state !== "ready") return reply.status(409).send({ error: "index_not_ready", status: idx.getStatus() });
  try {
    return reply.send({ hits: await idx.search(query, k) });
  } catch (err) {
    return reply.status(503).send({ error: "embedding_failed", message: (err as Error).message });
  }
});

/** search_codebase results as the agent sees them. */
function formatSearchHits(hits: Awaited<ReturnType<ReturnType<typeof codebaseIndexFor>["search"]>>): string {
  if (hits.length === 0) return "No matches.";
  return hits.map((h) => `${h.path}:${h.startLine}-${h.endLine} (score ${h.score})\n${h.snippet}`).join("\n\n---\n\n");
}

// Source control panel (git-ops.ts): the user's own git actions from the UI.
async function withGit(reply: FastifyReply, fn: (git: GitOps) => Promise<unknown>): Promise<unknown> {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  try {
    return reply.send(await fn(new GitOps(activeProjectRoot)));
  } catch (err) {
    if (err instanceof GitError) return reply.status(400).send({ error: "git", message: err.message });
    if (err instanceof ProjectFsError) return reply.status(FS_ERROR_STATUS[err.code]).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid", message: err.message });
    throw err;
  }
}
const gitPaths = z.object({ paths: z.array(z.string().max(4096)).min(1).max(1000) });

app.get("/v1/ide/git/state", (_req, reply) => withGit(reply, async (g) => (await g.state()) ?? { notARepo: true }));
app.get("/v1/ide/git/head-content", (req, reply) =>
  withGit(reply, async (g) => ({ content: await g.headContent(z.object({ path: z.string().min(1).max(4096) }).parse(req.query).path) })));
app.post("/v1/ide/git/stage", (req, reply) => withGit(reply, async (g) => { await g.stage(gitPaths.parse(req.body).paths); return { ok: true }; }));
app.post("/v1/ide/git/unstage", (req, reply) => withGit(reply, async (g) => { await g.unstage(gitPaths.parse(req.body).paths); return { ok: true }; }));
app.post("/v1/ide/git/discard", (req, reply) => withGit(reply, async (g) => { await g.discard(gitPaths.parse(req.body).paths); return { ok: true }; }));
app.post("/v1/ide/git/commit", (req, reply) =>
  withGit(reply, async (g) => {
    const b = z.object({ message: z.string().max(20_000), all: z.boolean().default(false) }).parse(req.body);
    return { commit: await g.commit(b.message, { all: b.all }) };
  }));
app.post("/v1/ide/git/checkout", (req, reply) =>
  withGit(reply, async (g) => {
    const b = z.object({ branch: z.string().min(1).max(255), create: z.boolean().default(false) }).parse(req.body);
    await g.checkout(b.branch, b.create);
    return { ok: true };
  }));
app.post("/v1/ide/git/pull", (_req, reply) => withGit(reply, async (g) => ({ output: await g.pull() })));
app.post("/v1/ide/git/push", (_req, reply) => withGit(reply, async (g) => ({ output: await g.push() })));

// Setting up git (git-setup.ts): init, clone, remotes, publishing with the GitHub CLI.
// GitHub auth stays with git's credential helper and gh's keychain login; no token passes through here.
const remoteUrl = z.string().min(1).max(2048).transform((u, ctx) => {
  try {
    return normalizeRemoteUrl(u);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: (err as Error).message });
    return z.NEVER;
  }
});
function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join("; ");
}
app.post("/v1/ide/git/init", (_req, reply) =>
  withGit(reply, async (g) => {
    await g.init();
    return { ok: true };
  }));
app.post("/v1/ide/git/remote", (req, reply) => {
  const b = z.object({ name: z.string().min(1).max(100).default("origin"), url: remoteUrl }).safeParse(req.body ?? {});
  if (!b.success) return reply.status(400).send({ error: "invalid", message: zodMessage(b.error) });
  return withGit(reply, async (g) => {
    await g.addRemote(b.data.name, b.data.url);
    return { ok: true, name: b.data.name, url: b.data.url };
  });
});
app.post("/v1/ide/git/publish", (req, reply) => {
  const b = z.object({ name: z.string().min(1).max(140), visibility: z.enum(["public", "private"]).default("private") }).safeParse(req.body ?? {});
  if (!b.success) return reply.status(400).send({ error: "invalid", message: zodMessage(b.error) });
  return withGit(reply, (g) => g.publishGitHub(b.data.name, b.data.visibility));
});
app.post("/v1/ide/git/clone", async (req, reply) => {
  const b = z.object({
    url: remoteUrl,
    parentDir: z.string().min(1).max(4096).refine((p) => isAbsolute(p), "The clone folder must be an absolute path."),
    name: z.string().min(1).max(200).optional(),
  }).safeParse(req.body ?? {});
  if (!b.success) return reply.status(400).send({ error: "invalid", message: zodMessage(b.error) });
  try {
    const projectRoot = await cloneRepo(b.data.url, b.data.parentDir, b.data.name);
    activeProjectRoot = projectRoot;
    return reply.send({ projectRoot });
  } catch (err) {
    if (err instanceof GitSetupError) return reply.status(400).send({ error: "git", message: err.message });
    throw err;
  }
});
app.get("/v1/ide/git/github/status", async (_req, reply) => reply.send(await githubStatus()));

// The agent's GitHub connection (Settings → Integrations → GitHub for the agent): the desktop reads
// the token from the portal with the signed-in user's session and hands it here, so shared sessions
// (the Code view, `edgecoder code`) and bots use it too, not only requests that carry it. Memory
// only; null clears it (disconnected). The GitHub tools fall back to gh's sign-in and git's
// credential helper without it (github-auth.ts).
let agentGitHub: { token: string | null; why: string } = { token: null, why: "the app hasn't sent it since this server started" };
const githubCreds: CredentialDeps = {
  integrationToken: () => agentGitHub.token,
  integrationMissing: () => agentGitHub.why,
};
app.post("/v1/ide/github/agent-token", async (req, reply) => {
  const body = z.object({ token: z.string().min(1).max(500).regex(/^[\x21-\x7e]+$/).nullable(), reason: z.string().max(200).optional() }).parse(req.body);
  agentGitHub = body.token ? { token: body.token, why: "" } : { token: null, why: body.reason?.trim() || "not connected" };
  return reply.send({ ok: true, connected: Boolean(body.token) });
});

// Sign in to GitHub with the GitHub CLI's device flow (github-device.ts): the code is shown in the
// app or terminal, the user enters it at github.com/login/device, and the status is polled here.
const githubLogins = new GitHubDeviceLogins();
app.post("/v1/ide/github/login", async (_req, reply) => reply.send(await githubLogins.start()));
app.get("/v1/ide/github/login/:id", async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const l = githubLogins.get(id);
  return l ? reply.send(l) : reply.status(404).send({ error: "not_found" });
});
app.post("/v1/ide/github/login/:id/cancel", async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const l = githubLogins.cancel(id);
  return l ? reply.send(l) : reply.status(404).send({ error: "not_found" });
});

// Settings > Install command-line tool (cli-install.ts): an `edgecoder` launcher on the PATH.
app.get("/v1/ide/settings/cli", async (_req, reply) => reply.send(cliStatus()));
app.post("/v1/ide/settings/cli/install", async (_req, reply) => {
  const r = installCli();
  return reply.status(r.ok ? 200 : r.state === "exists_other" ? 409 : 404).send(r);
});

// The projects folder (default ~/EdgeCoder) and connecting a repository into it (repo-connect.ts).
app.get("/v1/ide/settings/projects-folder", async (_req, reply) => {
  const f = getProjectsFolder();
  return reply.send({ path: f.path, source: f.source, defaultPath: defaultProjectsFolder() });
});
app.post("/v1/ide/settings/projects-folder", async (req, reply) => {
  const b = z.object({ path: z.string().min(1).max(4096) }).safeParse(req.body ?? {});
  if (!b.success) return reply.status(400).send({ error: "invalid", message: zodMessage(b.error) });
  try {
    return reply.send({ path: setProjectsFolder(b.data.path), source: getProjectsFolder().source });
  } catch (err) {
    if (err instanceof GitSetupError) return reply.status(400).send({ error: "invalid", message: err.message });
    throw err;
  }
});
app.get("/v1/ide/repos/recent", async (_req, reply) => {
  const st = await githubStatus();
  return reply.send({ ...st, repos: st.loggedIn ? await recentGitHubRepos(20) : [] });
});
app.post("/v1/ide/repos/connect", async (req, reply) => {
  // `open: false` (the terminal): connect without changing the desktop's open project.
  const b = z.object({ repo: remoteUrl, stream: z.boolean().default(false), open: z.boolean().default(true) }).safeParse(req.body ?? {});
  if (!b.success) return reply.status(400).send({ error: "invalid", message: zodMessage(b.error) });
  if (!b.data.stream) {
    try {
      const r = await connectRepoUrl(b.data.repo);
      if (b.data.open) activeProjectRoot = r.path;
      return reply.send(r);
    } catch (err) {
      if (err instanceof GitSetupError) return reply.status(400).send({ error: "git", message: err.message });
      throw err;
    }
  }
  // Streamed: progress lines from git as they come, then the result (or the error).
  writeSseHead(reply);
  const send = (ev: Record<string, unknown>) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  let lastAt = 0;
  try {
    const r = await connectRepoUrl(b.data.repo, {
      onProgress: (line) => {
        const now = Date.now();
        if (now - lastAt < 120 && !/done\.?$/.test(line)) return;
        lastAt = now;
        send({ type: "progress", line: line.slice(0, 300) });
      },
    });
    if (b.data.open) activeProjectRoot = r.path;
    send({ type: "done", result: r });
  } catch (err) {
    send({ type: "error", message: err instanceof GitSetupError ? err.message : "Couldn't connect the repository." });
    if (!(err instanceof GitSetupError)) req.log.error({ err }, "repo connect failed");
  }
  reply.raw.end();
  return reply;
});

// Background jobs on the network (network-tasks.ts).
const networkTasks = new NetworkTasks(router);

app.post("/v1/ide/network/tasks", async (req, reply) => {
  const b = z.object({ prompt: z.string().min(1).max(20_000), language: z.enum(["python", "javascript"]).default("python") }).parse(req.body);
  try {
    return reply.send(await networkTasks.submit(b.prompt, b.language));
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.startsWith("swarm_snapshot_ref_required") ? 409 : 502;
    return reply.status(status).send({ error: status === 409 ? "snapshot_required" : "network_submit_failed", message: msg });
  }
});

app.get("/v1/ide/network/tasks", async (_req, reply) => reply.send({ tasks: networkTasks.list() }));

// Problems: the project's own checkers on save (diagnostics.ts).
app.post("/v1/ide/diagnostics", async (req, reply) => {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  const { paths } = z.object({ paths: z.array(z.string().max(4096)).min(1).max(200) }).parse(req.body);
  const fs = new ProjectFs(activeProjectRoot);
  const inside = paths.filter((p) => { try { fs.resolve(p); return true; } catch { return false; } });
  return reply.send(await checkProject(activeProjectRoot, inside, { trusted: isProjectTrusted(activeProjectRoot) }));
});

// Whether the open folder is trusted to run its own tooling (workspace-trust.ts). Untrusted by default.
app.get("/v1/ide/project/trust", async (_req, reply) => {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  return reply.send({ projectRoot: activeProjectRoot, trusted: isProjectTrusted(activeProjectRoot) });
});
app.post("/v1/ide/project/trust", async (req, reply) => {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  const b = z.object({ trusted: z.boolean() }).safeParse(req.body ?? {});
  if (!b.success) return reply.status(400).send({ error: "invalid", message: zodMessage(b.error) });
  setProjectTrusted(activeProjectRoot, b.data.trusted);
  return reply.send({ projectRoot: activeProjectRoot, trusted: isProjectTrusted(activeProjectRoot) });
});

// Live preview of web projects (preview-server.ts), on its own loopback origin.
const previewPort = C.IDE_PREVIEW_PORT || PREVIEW_DEFAULT_PORT;
const preview = createPreviewServer(() => activeProjectRoot);
app.get("/v1/ide/preview", async (req, reply) => {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  const { path } = z.object({ path: z.string().max(4096).default("") }).parse(req.query);
  return reply.send({ url: preview.urlFor(previewPort, path) });
});

// A new project: from chat (<projects folder>/<slug of the request>) or the desktop's New project
// sheet (an exact folder name, a location, a template, git or not). It becomes the open project.
app.post("/v1/ide/projects/new", async (req, reply) => {
  const b = z.object({
    name: z.string().max(200).default(""),
    parentDir: z.string().min(1).max(4096).optional(),
    folder: z.string().min(1).max(200).optional(),
    template: z.enum(PROJECT_TEMPLATES).default("empty"),
    git: z.boolean().default(true),
  }).safeParse(req.body ?? {});
  if (!b.success) return reply.status(400).send({ error: "invalid", message: zodMessage(b.error) });
  try {
    const { name, ...opts } = b.data;
    const projectRoot = createNewProject(name, opts);
    activeProjectRoot = projectRoot;
    return reply.send({ projectRoot });
  } catch (err) {
    if (err instanceof NewProjectError) return reply.status(err.code === "exists" ? 409 : 400).send({ error: err.code, message: err.message });
    throw err;
  }
});

// Compute page: cSats balance, prices per class, network models (through this machine's agent).
app.get("/v1/ide/compute", async (_req, reply) => {
  if (!networkDeps) return reply.send({ connected: false, reason: "not_enrolled" });
  return reply.send(await computeOverview(networkDeps));
});

// Network page: the anonymized world view (other people's machines masked) and this computer's round trip to each coordinator.
app.get("/v1/ide/network/world", async (_req, reply) => {
  if (!networkDeps) return reply.send({ connected: false, reason: "not_enrolled" });
  try {
    const r = await networkWorld(networkDeps);
    if (r.status !== 200) return reply.status(r.status === 429 ? 429 : 502).send({ connected: false, reason: r.status === 429 ? "rate_limited" : "coordinator_error", status: r.status, error: r.json.error ?? null });
    // This computer's own agent, so the page can call it "This computer" (it is also marked `mine`).
    return reply.send({ connected: true, ...r.json, selfAgentId: networkDeps.agentId });
  } catch (err) {
    return reply.status(502).send({ connected: false, reason: "agent_unreachable", error: (err as Error).message });
  }
});

// Before an update restart or quit: the agent stops taking network work and hands its claims back.
app.post("/v1/ide/compute/drain", async (req, reply) => {
  if (!networkDeps || networkDeps.transport) return reply.send({ ok: true, draining: false, released: 0, reason: "not_enrolled" });
  const { resume } = z.object({ resume: z.boolean().default(false) }).parse(req.body ?? {});
  try {
    const r = await drainAgent(networkDeps, resume);
    return reply.status(r.status === 200 ? 200 : 502).send(r.json);
  } catch (err) {
    return reply.status(502).send({ ok: false, error: "agent_unreachable", detail: (err as Error).message });
  }
});

app.post("/v1/ide/compute/buy", async (req, reply) => {
  if (!networkDeps) return reply.status(409).send({ error: "not_enrolled" });
  const { amountSats } = z.object({ amountSats: z.number().int().min(100).max(1_000_000) }).parse(req.body);
  const r = await buyCSats(networkDeps, amountSats);
  return reply.status(r.status === 200 ? 200 : r.status || 502).send(r.json);
});

app.post("/v1/ide/compute/intent", async (req, reply) => {
  if (!networkDeps) return reply.status(409).send({ error: "not_enrolled" });
  const { intentId } = z.object({ intentId: z.string().min(1).max(100) }).parse(req.body);
  const r = await purchaseStatus(networkDeps, intentId);
  return reply.status(r.status === 200 ? 200 : r.status || 502).send(r.json);
});

// --- Connect to compute: a port per connection, each fixed to one place to run ---

const connections = new ConnectionManager({
  ollamaHost: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
  network: networkDeps ?? undefined,
  auto: (source) => autoHere(undefined, source, undefined, undefined, "session"),
  log: (msg, extra) => app.log.warn({ extra }, msg),
});
app.addHook("onReady", async () => {
  connections.load();
  await connections.startAll();
});
app.addHook("onClose", async () => {
  await connections.stopAll();
});

// --- Persistent bots: named agents that own a job in a project (src/apps/ide/bots.ts) ---

const bots = new BotManager({
  approvals: pendingApprovals,
  permissions: permissionStore,
  // Bots paused out of cSats resume after a top-up.
  balance: async () => (networkDeps ? (await computeOverview(networkDeps).catch(() => null))?.account?.cSats : undefined),
  log: (msg, extra) => app.log.warn({ extra }, msg),
  // Its owner's frontier key spend today (the bot view's "$0.42 today" next to cSats).
  frontierSpentToday: (id) => frontier.spend.todayFor(botSpendKey(id)),
  runner: agentBotRunner({
    // Each step on the bot's compute policy (Auto by default), within its budget and your balance.
    // A bot only its owner can start may lead with the owner's frontier key, after the owner
    // approves (bot-frontier.ts); its compute policy is then the worker.
    chat: (ctx) =>
      botFrontierChat({
        bot: ctx.bot,
        trigger: ctx.trigger ?? "manual",
        access: frontier,
        worker: botComputeChat(ctx, (policy, plan, onRoute) => autoHere(onRoute, `bot ${ctx.bot.name}`, policy, plan)),
        hooks: ctx.frontier,
        sendEvent: ctx.sendEvent,
        signal: ctx.signal,
        isCancelled: ctx.isCancelled,
      }),
    // Runs work in the bot's repository checkout when it has one, else in its home folder.
    execute: (bot) => {
      const executor = new ToolExecutor(botWorkRoot(bot), null, undefined, { branchPrefix: botBranchPrefix(bot.name), github: githubCreds });
      return (tool, args, opts) => executor.execute(tool, args, opts);
    },
    prepare: (bot) => {
      const executor = new ToolExecutor(botWorkRoot(bot), null, undefined, { branchPrefix: botBranchPrefix(bot.name), github: githubCreds });
      return (tool, args) => preparePullRequestArgs(executor, tool, args);
    },
    systemPrompt: async (bot) => {
      const ctx = await agentPromptContext(process.env.OLLAMA_MODEL || "qwen3.5:9b");
      const root = botWorkRoot(bot);
      const rules = readProjectRules(root);
      const node = toolchainNote(root);
      return (format) => [buildIdeAgentSystemPrompt(ctx, root, rules, format), node].filter(Boolean).join("\n\n");
    },
    checkpoints,
    // "Search the web" (docs/web-tool.md): through EdgeCoder's servers; refused once today's budget is spent.
    web: (ctx) =>
      webCall
        ? new WebToolSession({
            call: webCall,
            emit: ctx.sendEvent,
            signal: ctx.signal,
            allow: () => {
              const left = ctx.budgetLeft();
              return left !== null && left <= 0 ? "Today's budget for this bot is spent, so the web tool is off until tomorrow." : null;
            },
          })
        : null,
  }),
});
registerBotRoutes(app, bots, { account: machineAccount, frontierModels: () => frontier.modelIds() });
// Bots on the web: this machine's agent publishes their summaries and relays the owner's commands (bot-remote.ts).
registerRemoteBotRoutes(app, bots, { account: machineAccount });
app.addHook("onReady", async () => {
  bots.load();
});
app.addHook("onClose", async () => {
  await bots.shutdown();
});

const connectionSchema = z.object({
  name: z.string().min(1).max(80),
  target: z.enum(["local", "mine", "network", "reserved", "auto"]),
  model: z.string().min(1).max(200),
  computeClass: z.enum(["any", "cpu", "apple", "gpu", "gpu.dc"]).optional(),
  reservationId: z.string().max(100).optional(),
  maxCSatsPerSecond: z.number().positive().max(1_000_000).optional(),
  budgetCSats: z.number().positive().max(1e9).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  enabled: z.boolean().optional(),
});

app.get("/v1/ide/connections", async (_req, reply) => {
  let localModels: string[] = [];
  try {
    localModels = (await ollamaTags()).models.map((m) => m.name).filter((n) => !/embed/i.test(n));
  } catch {
    // Ollama not running
  }
  return reply.send({ connections: connections.list(), localModels, networkConnected: !!networkDeps, nextPort: connections.nextPort() });
});

app.post("/v1/ide/connections", async (req, reply) => {
  const body = connectionSchema.parse(req.body);
  try {
    return reply.send({ connection: await connections.create(body) });
  } catch (err) {
    return reply.status(400).send({ error: "invalid_connection", message: (err as Error).message });
  }
});

app.patch("/v1/ide/connections/:id", async (req, reply) => {
  const { id } = z.object({ id: z.string() }).parse(req.params);
  const body = connectionSchema.partial().extend({ rotateKey: z.boolean().optional(), resetSpent: z.boolean().optional() }).parse(req.body ?? {});
  try {
    return reply.send({ connection: await connections.update(id, body) });
  } catch (err) {
    return reply.status(400).send({ error: "invalid_connection", message: (err as Error).message });
  }
});

app.delete("/v1/ide/connections/:id", async (req, reply) => {
  const { id } = z.object({ id: z.string() }).parse(req.params);
  await connections.remove(id);
  return reply.send({ ok: true });
});

// Reserved capacity (through this machine's agent): your leases, what's free per class, reserve, cancel.
app.get("/v1/ide/reservations", async (_req, reply) => {
  if (!networkDeps) return reply.status(409).send({ error: "not_enrolled" });
  const r = await listReservations(networkDeps);
  return reply.status(r.status === 200 ? 200 : r.status || 502).send(r.json);
});

app.post("/v1/ide/reservations", async (req, reply) => {
  if (!networkDeps) return reply.status(409).send({ error: "not_enrolled" });
  const body = z.object({ computeClass: z.enum(["cpu", "apple", "gpu", "gpu.dc"]), minutes: z.number().int().min(1).max(1440), model: z.string().max(200).optional(), minVramGb: z.number().min(0).max(1024).optional() }).parse(req.body);
  const r = await createReservation(networkDeps, body);
  return reply.status(r.status === 200 ? 200 : r.status || 502).send(r.json);
});

app.get("/v1/ide/usage", async (req, reply) => {
  if (!networkDeps) return reply.status(409).send({ error: "not_enrolled" });
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query ?? {});
  const r = await usageSummary(networkDeps, days);
  return reply.status(r.status === 200 ? 200 : r.status || 502).send(r.json);
});

app.post("/v1/ide/reservations/cancel", async (req, reply) => {
  if (!networkDeps) return reply.status(409).send({ error: "not_enrolled" });
  const { reservationId } = z.object({ reservationId: z.string().min(1).max(100) }).parse(req.body);
  const r = await cancelReservation(networkDeps, reservationId);
  return reply.status(r.status === 200 ? 200 : r.status || 502).send(r.json);
});

// Anthropic Messages API on the main endpoint too (Claude Code): the model names where it runs.
registerCompatRoutes(
  app,
  {
    authenticate: async () => true, // the IDE token hook above already checked the caller
    models: async () => [],
    resolve: async (_ctx, model) => {
      // No model (or "default"): Auto, the cheapest free place that fits, else the network's best fit.
      if (!model || isUnpinnedModel(model)) return { backend: apiAuto, model: AUTO_MODEL_ID };
      if (isFrontierModelId(model)) {
        const r = await frontier.resolve(model, { sessionKey: "api" });
        return r.ok ? { backend: r.backend, model } : { status: r.status, error: r.message };
      }
      const network = parseNetworkModel(model);
      if (network) {
        if (!networkDeps) return { status: 409, error: "This computer's agent isn't connected to the network." };
        return { backend: networkBackend(networkDeps, { ...network, source: "localhost:4304" }), model };
      }
      return { backend: localBackend(process.env.OLLAMA_HOST || "http://127.0.0.1:11434", model), model };
    },
  },
  "",
  { openai: false }
);

const toolApprovalSchema = z.object({
  id: z.string().min(1),
  approved: z.boolean(),
  /** "Always allow" this command in the project: keeps the call's suggested rule (never for refused or always-ask commands). */
  always: z.boolean().default(false),
});

app.post("/v1/ide/tool-approval", async (req, reply) => {
  const body = toolApprovalSchema.parse(req.body);
  const entry = pendingApprovals.get(body.id);
  if (!entry) {
    return reply.status(404).send({ error: "No pending approval with that id" });
  }
  let rule: string | null = null;
  if (body.approved && body.always && entry.projectRoot) {
    rule = suggestToolRule(entry.tool, entry.args, { root: entry.projectRoot });
    if (rule) permissionStore.addRule(entry.projectRoot, rule);
  }
  entry.resolve(body.approved);
  pendingApprovals.delete(body.id);
  return reply.send({ ok: true, ...(rule ? { rule } : {}) });
});

const ideChatSchema = z.object({
  messages: z
    .array(z.object({ role: z.string(), content: z.string() }))
    .min(1),
  model: z.string().optional(),
  projectRoot: z.string().optional(),
  githubToken: z.string().optional(),
  /** Older clients: "edits" = mode auto-edits. */
  autoApprove: z.enum(["none", "edits"]).default("none"),
  /** The permission mode (permission-policy.ts): ask, auto-edits, auto, plan or full. Wins over autoApprove. */
  mode: z.enum(["ask", "auto-edits", "auto", "plan", "full"]).optional(),
  /** Which desktop view sent it (Settings → Active work / Tasks). */
  origin: z.enum(["chat", "code"]).optional(),
  /** Files attached to the last user message in the composer (attachments.ts). */
  attachments: attachmentsSchema.optional(),
  /** The chat's Web toggle: offer web_search and read_page (run on EdgeCoder's servers, billed per call). */
  web: z.boolean().optional(),
  /**
   * The Code view's Helpers switch (docs/tentacles.md): the lead may delegate pieces to helper
   * agents. `sessionId` is the chat's id, so budgets and results last across its turns.
   */
  helpers: z
    .object({
      sessionId: z.string().uuid(),
      enabled: z.boolean(),
      maxParallel: z.number().int().min(1).max(16).optional(),
      budgetCSats: z.number().min(0).max(1e7).optional(),
    })
    .optional(),
  /** The Code view chat this turn belongs to: its mirror session shows the turn live (desktop-chats.ts). */
  chatId: z.string().uuid().optional(),
  /** Where the model runs: this computer (default), your machines, any network agent (optionally one class), or a reserved machine. */
  compute: z
    .object({
      target: z.enum(["local", "mine", "network", "reserved", "auto"]),
      computeClass: z.enum(["any", "cpu", "apple", "gpu", "gpu.dc"]).optional(),
      reservationId: z.string().max(100).optional(),
      /** Auto only: where it may run (default EDGECODER_AUTO_POLICY, else "auto"); "mine_only" is free machines only, never the network. */
      policy: z.enum(AUTO_POLICIES).optional(),
    })
    .optional(),
});

/**
 * The chat's model runs on the user's own machine: this computer's model, "My machines", or Auto
 * kept to free machines (local_only / mine_only). Its web calls then ask to be free (docs/web-tool.md).
 * Only through this machine's agent: the coordinator grants it to an agent linked to the billed
 * account, and the hosted endpoint (an API key) never relays the claim. Frontier models and the
 * network pay as usual.
 */
function webOnOwnMachine(compute: z.infer<typeof ideChatSchema>["compute"], model: string): boolean {
  if (!networkDeps || isFrontierModelId(model) || parseNetworkModel(model)) return false;
  if (!compute || compute.target === "local" || compute.target === "mine") return true;
  if (compute.target === "auto") {
    const policy = compute.policy ?? autoPolicyFromEnv();
    return policy === "local_only" || policy === "mine_only";
  }
  return false;
}

function sessionModelId(compute: NonNullable<z.infer<typeof ideChatSchema>["compute"]>, model: string): string {
  if (compute.target === "auto") return "auto";
  if (compute.target === "mine") return `mine/${model}`;
  if (compute.target === "reserved") return `reserved/${compute.reservationId ?? ""}/${model}`;
  return `network/${model}${compute.computeClass && compute.computeClass !== "any" ? `@${compute.computeClass}` : ""}`;
}

/** The agent's model calls, on the compute the chat picked. */
function chatFnFor(compute: z.infer<typeof ideChatSchema>["compute"], model: string, ollamaHost: string, sendEvent: (e: IdeStreamEvent) => void, signal: AbortSignal, source = "EdgeCoder chat", frontierAuto?: Omit<FrontierRequest, "onWarn" | "onCost">) {
  if (compute?.target === "auto" && !networkDeps && hosted) {
    return backendChat(hostedBackend(hosted, "auto"), (cSats, served) => sendEvent({ type: "usage", cSats, where: "Auto (hosted)", ...(served ? { served } : {}) }), signal);
  }
  if (compute?.target === "auto") {
    // Auto picks the model too; each step of the agent may land somewhere else (cheapest that fits).
    // When the network isn't affordable, Auto falls back to the biggest free model (planRoutes).
    let where = "Auto";
    // The model the route ran ("qwen3.5:9b"), for the footer; the coordinator's best-fit picks its own.
    let routeModel: string | undefined;
    let reason: string | undefined;
    const auto = autoHere((r) => {
      where = routeLabel(r);
      routeModel = !r.bestFit && r.model && r.model !== AUTO_MODEL_ID ? r.model : undefined;
      reason = r.why ? `${r.reason} (${r.why})` : r.reason;
      // `route`: where this step runs and why, with its complexity (the UI's "Running on" and per-step lines).
      sendEvent({ type: "status", message: `Auto: ${reason}`, route: routeSummary(r) });
    }, source, compute.policy);
    // "Use my frontier key for Auto" (off by default): high-complexity jobs may go to the default lead.
    const backend = frontierAuto
      ? autoWithFrontier({
          auto,
          access: frontier,
          request: () => ({
            ...frontierAuto,
            onWarn: (message) => sendEvent({ type: "status", message }),
          }),
          onPick: (label) => {
            where = label;
            routeModel = undefined;
            reason = `${label} (high complexity, your frontier key)`;
            sendEvent({ type: "status", message: `Auto: ${label} (high complexity)` });
          },
        })
      : auto;
    // A frontier call's served line carries its estimated USD (the user's own key, not cSats).
    return backendChat(backend, (cSats, served) => sendEvent({ type: "usage", cSats, where, ...(reason ? { reason } : {}), ...(routeModel ? { model: routeModel } : {}), ...(served ? { served } : {}), ...(served?.usd !== undefined ? { usd: served.usd } : {}) }), signal);
  }
  if (compute && compute.target !== "local" && !networkDeps && hosted) {
    // No enrolled agent here, but an API key: the network through the hosted endpoint.
    const id = sessionModelId(compute, model);
    return backendChat(hostedBackend(hosted, id), (cSats, served) => sendEvent({ type: "usage", cSats, where: `${id} (hosted)`, model: id, ...(served ? { served } : {}) }), signal);
  }
  if (!compute || compute.target === "local" || !networkDeps) {
    // This computer: free, and the footer says so ("This computer (Apple M1 Max)").
    const local = ollamaChat(ollamaHost, model, signal);
    const fn: ChatFn = async (req, onDelta) => {
      const r = await local(req, onDelta);
      sendEvent({ type: "usage", cSats: 0, where: r.served?.hardware ?? "This computer", model, ...(r.served ? { served: r.served } : {}) });
      return r;
    };
    return fn;
  }
  const where = routeLabel({
    placement: compute.target,
    model,
    cSatsPerSecond: 0,
    reason: "",
    ...(compute.target === "network" ? { computeClass: compute.computeClass ?? "any" } : {}),
  });
  const backend = networkBackend(networkDeps, {
    model,
    computeClass: compute.target === "network" ? compute.computeClass ?? "any" : "any",
    ...(compute.target === "mine" ? { target: "mine" as const } : {}),
    ...(compute.target === "reserved" ? { reservationId: compute.reservationId } : {}),
    source,
  });
  return backendChat(backend, (cSats, served) => sendEvent({ type: "usage", cSats, where, model, ...(served ? { served } : {}) }), signal);
}

/** What the agent's system prompt says about the models here. */
async function agentPromptContext(chatModel: string): Promise<SystemPromptContext> {
  let ollamaHealthy = true;
  let installedModels: Array<{ name: string; paramSize: number }> = [];
  let activeModelParamSize = 0;
  let activeModelQuantization: string | undefined;
  const size = (s: string | undefined) => parseFloat(s?.match(/([\d.]+)/)?.[1] ?? "0");
  try {
    const tags = await ollamaTags();
    installedModels = tags.models.map((m) => ({ name: m.name, paramSize: size(m.details?.parameter_size) }));
    const entry = tags.models.find((m) => m.name === chatModel);
    if (entry) {
      activeModelParamSize = size(entry.details?.parameter_size);
      activeModelQuantization = entry.details?.quantization_level;
    }
  } catch {
    ollamaHealthy = false;
  }
  return { activeModel: chatModel, activeModelParamSize, activeModelQuantization, installedModels, swarmModels: [], ollamaHealthy, queueDepth: 0, connectedAgents: 0 };
}

app.post("/v1/ide/chat", { bodyLimit: ATTACHMENT_BODY_LIMIT }, async (req, reply) => {
  const body = ideChatSchema.parse(req.body);
  const projectRoot = body.projectRoot ?? activeProjectRoot;

  if (!projectRoot) {
    return reply.status(400).send({
      error: "No project root set. POST /v1/ide/project first or include projectRoot in body.",
    });
  }

  // The newest agent GitHub connection the app sent also serves sessions and bots.
  if (body.githubToken) agentGitHub = { token: body.githubToken, why: "" };
  const index = codebaseIndexFor(projectRoot, ollamaHostForIndex());
  const executor = new ToolExecutor(
    projectRoot,
    body.githubToken,
    index.getStatus().state === "ready" ? async (q) => formatSearchHits(await index.search(q, 6)) : undefined,
    { github: githubCreds },
  );
  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const chatModel =
    body.model || process.env.OLLAMA_MODEL || "qwen3.5:9b";

  const promptCtx = await agentPromptContext(chatModel);
  const projectRules = readProjectRules(projectRoot);
  const nodeNote = toolchainNote(projectRoot);
  const messages = withAttachments(body.messages, body.attachments ?? [], chatModel);

  const chatMode: PermissionMode = body.mode ?? (body.autoApprove === "edits" ? "auto-edits" : "ask");

  // SSE setup
  writeSseHead(reply);

  const turnId = randomUUID();
  let clientDisconnected = false;
  // The response closing before the stream ended means the client went away (the request's own
  // "close" fires as soon as its body has been read).
  reply.raw.on("close", () => {
    if (reply.raw.writableEnded) return;
    clientDisconnected = true;
    // Reject this request's pending approvals (not other chats' or bots').
    for (const [id, entry] of pendingApprovals) {
      if (entry.owner !== turnId) continue;
      entry.resolve(false);
      pendingApprovals.delete(id);
    }
  });

  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  const tracked = activity.begin({ kind: body.origin ?? "code", title: lastUser?.content ?? "", source: body.origin === "chat" ? "EdgeCoder chat" : "Code", model: chatModel });
  const abort = new AbortController();
  reply.raw.on("close", () => { if (!reply.raw.writableEnded) abort.abort(); });
  // A Code view chat's mirror session shows this turn live to the owner's phone, which may stop it
  // (abort) and answer its approvals (desktop-chats.ts).
  const mirror = body.origin !== "chat" ? desktopTurnFor(sessions, body.chatId, turnId, abort) : null;
  function sendEvent(event: IdeStreamEvent): void {
    tracked.event(event);
    mirror?.event(event);
    if (clientDisconnected) return;
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  checkpoints.begin(turnId, projectRoot);
  sendEvent({ type: "turn", id: turnId });

  // open_pull_request is offered only when the project is a GitHub repository.
  const projectTools = hasGitHubOrigin(projectRoot) ? toolSchemas() : toolSchemas().filter((t) => t.function.name !== "open_pull_request");
  // Web (docs/web-tool.md): offered by default (the chat's "Web: Auto"), and the model decides when
  // to search. Not offered when the account has no cSats or the hour's searches are used (no failed
  // searches): the reply goes ahead without the web and the app notes it once.
  // On your own machine (this computer's model, My machines) the web is free.
  const ownMachine = !isFrontierModelId(chatModel) && webOnOwnMachine(body.compute, chatModel);
  const avail = body.web && webCall ? await webAvailability(webCall, "local", { signal: abort.signal, ownMachine }) : null;
  if (avail && !avail.offer && avail.reason !== "not_configured") sendEvent({ type: "web_off", reason: avail.reason ?? "unreachable", message: avail.message ?? "" });
  const web = avail?.offer && webCall ? new WebToolSession({ call: webCall, emit: sendEvent, signal: abort.signal, ownMachine }) : null;
  if (web) executor.web = (tool, args) => web.run(tool, args);
  // Helpers (tentacles.ts): the chat's switch, never on a hub session's id, and not while planning.
  const helperId = body.helpers && !sessions.peek(body.helpers.sessionId) ? body.helpers.sessionId : null;
  const helpersOn = !!helperId && body.helpers!.enabled && chatMode !== "plan";
  const helperBinding = helperId ? bindChatHelpers(helperId, { projectRoot, mode: chatMode, model: chatModel }, (ev) => sendEvent(ev as unknown as IdeStreamEvent)) : null;
  if (helperId) tentacles.configure(helperId, { enabled: helpersOn, ...(body.helpers!.maxParallel !== undefined ? { maxParallel: body.helpers!.maxParallel } : {}), ...(body.helpers!.budgetCSats !== undefined ? { budgetCSats: body.helpers!.budgetCSats } : {}) });
  // Stopping the turn stops its helpers, like a session's stop.
  if (helperId) abort.signal.addEventListener("abort", () => void tentacles.cancelAll(helperId), { once: true });
  const baseTools = web ? [...projectTools, ...webToolSchemas()] : projectTools;
  const tools = helpersOn ? withTentacleTools(baseTools, true)! : baseTools;
  const basePrompt = (format: "native" | "text") => [promptCtx ? buildIdeAgentSystemPrompt(promptCtx, projectRoot, projectRules, format) : "", promptCtx ? nodeNote : "", web ? webSystemNote() : ""].filter(Boolean).join("\n\n");
  const executeTool = (tool: ToolName, args: Record<string, unknown>, opts: { approved: boolean }) => executor.execute(tool, args, opts);
  reply.raw.on("close", () => tracked.end("cancelled"));
  try {
    await runAgentLoop({
      chat: isFrontierModelId(chatModel)
        ? frontierChatFn(chatModel, { sessionKey: `chat:${turnId}` }, sendEvent, abort.signal)
        : chatFnFor(body.compute, chatModel, ollamaHost, sendEvent, abort.signal, "EdgeCoder chat", body.compute?.target === "auto" ? { sessionKey: `chat:${turnId}` } : undefined),
      systemPrompt: helpersOn ? withTentacleGuidance(basePrompt, true, tentacles.unreported(helperId!)) : basePrompt,
      messages,
      // Web grounding: a question that needs fresh facts is searched once before the first turn (not in Manual, where web calls ask).
      ...(web ? webGrounding(web, messages, { skip: chatMode === "ask" }) : {}),
      sendEvent,
      // Stopped here (the app closed the stream) or from the phone (the mirror aborts the turn).
      isCancelled: () => clientDisconnected || abort.signal.aborted,
      tools,
      runTool: makeToolRunner({
        prepare: (tool, args) => preparePullRequestArgs(executor, tool, args),
        execute: helpersOn ? tentacleExecutor(tentacles, helperId!, executeTool) : executeTool,
        sendEvent,
        // The first answer wins: the app (/v1/ide/tool-approval), the phone (the mirror) or 5 minutes (rejected).
        waitForApproval: (callId, tool, args) =>
          firstAnswer(
            { id: callId, tool, args },
            mirror,
            (answer) => pendingApprovals.set(callId, { resolve: answer, tool, args, owner: turnId, projectRoot }),
            () => pendingApprovals.delete(callId),
            5 * 60 * 1000,
          ),
        captureBeforeWrite: (path) => checkpoints.capture(turnId, path),
        turnId,
        decide: (tool, args) => decideFor(chatMode, projectRoot, tool, args),
        shellHint: (command, output) => toolchainFailureHint(projectRoot, command, output),
      }),
      plan: chatMode === "plan",
    });
  } finally {
    mirror?.end();
  }
  // Stopped from the phone: the app's copy says so too (the mirror's reply already does).
  if (abort.signal.aborted && !clientDisconnected) reply.raw.write(`data: ${JSON.stringify({ type: "text", content: "\n\n_(stopped)_" })}\n\n`);

  // Between turns the chat's helpers have no stream: their results reach the lead's next turn.
  if (helperBinding && chatHelpers.get(helperId!) === helperBinding) helperBinding.emit = null;
  sendEvent({ type: "done" });
  tracked.end(clientDisconnected ? "cancelled" : undefined);
  reply.raw.end();
});

// --- The web tool for chats without a project (docs/web-tool.md) ---

/**
 * Whether the chat's Web toggle can be on, for the model the chat picked: the tool is set up on
 * EdgeCoder's servers (BRAVE_SEARCH_API_KEY), this computer can reach them (an enrolled agent or an
 * API key), the model can call tools, and the account has cSats for a search.
 */
app.get("/v1/ide/web/status", async (req, reply) => {
  const q = (req.query ?? {}) as { model?: unknown; target?: unknown; policy?: unknown };
  const model = z.string().max(300).catch("").parse(q.model ?? "");
  const toolsSupported = model ? modelCallsTools(model) : true;
  // Where the chat runs (the app's compute picker; none = this computer): free web on your own machine.
  // The app sends the picker's id as the model ("mine/m", "network/m@gpu", "auto"; a bare id is this computer).
  const inferred = model === "auto" ? "auto" : model.startsWith("mine/") ? "mine" : model.startsWith("reserved/") ? "reserved" : model.startsWith("network/") ? "network" : "local";
  const target = z.enum(["local", "mine", "network", "reserved", "auto"]).catch(inferred).parse(q.target ?? inferred);
  const policy = z.enum(AUTO_POLICIES).optional().catch(undefined).parse(q.policy);
  const ownMachine = webOnOwnMachine({ target, ...(policy ? { policy } : {}) }, model);
  if (!webCall) return reply.send({ available: false, configured: false, toolsSupported, reason: "offline", message: "Web needs this computer connected to EdgeCoder (sign in, or set an API key)." });
  // A fresh look (the app asks after a top-up and now and then): the next reply asks again too.
  forgetWebAvailability("local");
  const r = await webCall("/v1/tools/web/status", ownMachine ? { ownMachine: true } : {}).catch(() => ({ status: 502, json: {} as Record<string, unknown> }));
  if (r.status !== 200) return reply.send({ available: false, configured: false, toolsSupported, reason: "unreachable", message: "Couldn't reach EdgeCoder to check web search." });
  const st = r.json as { configured?: boolean; free?: boolean; message?: string; searchCSats?: number; readCSats?: number; balanceCSats?: number | null; searchesLeftThisHour?: number };
  const configured = st.configured === true;
  const reason = webStatusReason(r.json, toolsSupported);
  const limits = webReplyLimitsFromEnv();
  return reply.send({ ...st, configured, free: ownMachine && st.free === true, ownMachine, toolsSupported, available: reason === null, reason, maxSearchesPerReply: limits.searches, maxReadsPerReply: limits.reads, ...(reason === "not_configured" ? { message: st.message ?? "Web search isn't set up yet" } : reason === "free_used" ? { message: FREE_USED_NOTE } : {}) });
});

const webChatSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
  model: z.string().optional(),
  compute: ideChatSchema.shape.compute,
});

/**
 * A chat without a project with the Web toggle on: the agent loop with only web_search and
 * read_page, on the chat's compute. Streams the same events as /v1/ide/chat (text, tool calls,
 * status lines, usage, web totals with the numbered sources).
 */
app.post("/v1/ide/web-chat", async (req, reply) => {
  const body = webChatSchema.parse(req.body);
  if (!webCall) return reply.status(503).send({ error: "web_unavailable", message: "Web needs this computer connected to EdgeCoder." });
  const chatModel = body.model || process.env.OLLAMA_MODEL || "qwen3.5:9b";
  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  // Web is offered only to a model that calls tools, and only when the account can pay for a search
  // (no failed searches); otherwise 409 web_off and the app answers through the plain chat.
  if (!modelCallsTools(body.model ?? chatModel)) return reply.status(409).send({ error: "web_off", reason: "no_tools", message: "Web is unavailable with this model." });
  const ownMachine = !isFrontierModelId(chatModel) && webOnOwnMachine(body.compute, chatModel);
  const avail = await webAvailability(webCall, "local", { ownMachine });
  if (!avail.offer) return reply.status(409).send({ error: "web_off", reason: avail.reason, message: avail.message ?? "" });
  const promptCtx = await agentPromptContext(chatModel);
  writeSseHead(reply);
  let clientDisconnected = false;
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) clientDisconnected = true;
  });
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  const tracked = activity.begin({ kind: "chat", title: lastUser?.content ?? "", source: "EdgeCoder chat", model: chatModel });
  const sendEvent = (event: IdeStreamEvent): void => {
    tracked.event(event);
    if (!clientDisconnected) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) abort.abort();
  });
  const web = new WebToolSession({ call: webCall, emit: sendEvent, signal: abort.signal, ownMachine });
  const turnId = randomUUID();
  sendEvent({ type: "turn", id: turnId });
  await runAgentLoop({
    chat: isFrontierModelId(chatModel)
      ? frontierChatFn(chatModel, { sessionKey: `chat:${turnId}` }, sendEvent, abort.signal)
      : chatFnFor(body.compute, chatModel, ollamaHost, sendEvent, abort.signal, "EdgeCoder chat", body.compute?.target === "auto" ? { sessionKey: `chat:${turnId}` } : undefined),
    systemPrompt: () => `${buildChatSystemPrompt(promptCtx)}\n\n${webSystemNote()}`,
    messages: body.messages,
    ...webGrounding(web, body.messages),
    sendEvent,
    isCancelled: () => clientDisconnected,
    tools: webToolSchemas(),
    runTool: makeToolRunner({
      execute: (tool, args) => (isWebTool(tool) ? web.run(tool, args) : Promise.resolve({ error: `${tool} isn't available in this chat.` })),
      sendEvent,
      waitForApproval: async () => false,
      captureBeforeWrite: () => null,
      turnId,
      // The toggle is the allowance; nothing else is offered here.
      decide: (tool) => (isWebTool(tool) ? { action: "run", reason: "web access is on" } : { action: "refuse", reason: "Only the web tool is available in this chat." }),
    }),
  });
  sendEvent({ type: "done" });
  tracked.end(clientDisconnected ? "cancelled" : undefined);
  reply.raw.end();
});

// --- Shared coding sessions (sessions.ts): the terminal (`edgecoder code`) and the desktop's Code view ---

function currentBranch(root: string): string | null {
  try {
    const b = execFileSync("git", hardenedGitArgs(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], root), {
      env: gitExecEnv(),
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}

/** A session's model calls by model id (lead or worker); frontier ids only for the owner's own requests. */
function sessionChat(s: SessionData, id: string, emit: (e: IdeStreamEvent) => void, signal: AbortSignal, client: ClientRef | null, role: "lead" | "worker"): ReturnType<typeof chatFnFor> {
  const source = s.origin === "terminal" ? "edgecoder code" : "EdgeCoder chat";
  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const who = { requester: client?.accountId, owner: s.ownerAccount, sessionKey: `session:${s.id}` };
  if (isFrontierModelId(id)) {
    // Never a frontier worker; a refused frontier lead falls back to the worker model.
    if (role === "worker") return sessionChat(s, workerModelOf(s), emit, signal, client, "worker");
    return frontierChatFn(id, who, emit, signal, () => sessionChat(s, workerModelOf(s), emit, signal, client, "worker"));
  }
  const p = parseModelIdForChat(id);
  const model = p.compute.target === "local" ? p.model || process.env.OLLAMA_MODEL || "qwen3.5:9b" : p.model;
  // Only the lead may let Auto pick the frontier key (when the user opted in); worker calls never do.
  return chatFnFor({ target: p.compute.target as "local", computeClass: p.compute.computeClass as never, reservationId: p.compute.reservationId }, model, ollamaHost, emit, signal, source, p.compute.target === "auto" && role === "lead" ? who : undefined);
}

// --- Tentacles (tentacles.ts, docs/tentacles.md): helper agents a session's lead delegates to ---

/**
 * A tentacle's backend: the turn hook's worker role, always on the network or this computer.
 * `modelId` is the session's worker model (workerModelOf: never a frontier id; one that slips
 * through becomes auto). "auto" goes to the coordinator's best-fit routing with the tentacle's job
 * hints (job, complexity score, quality, budget): through this machine's agent, else the hosted
 * endpoint, else Auto here. None of these paths can reach the user's frontier key.
 */
function tentacleWorkerBackend(modelId: string): ChatBackend {
  const id = workerModelOf({ workerModel: modelId });
  if (id === AUTO_MODEL_ID) {
    if (networkDeps) return networkBackend(networkDeps, { model: AUTO_MODEL_ID, computeClass: "any", source: "edgecoder tentacle" });
    if (hosted) return hostedBackend(hosted, AUTO_MODEL_ID);
    return autoHere(undefined, "edgecoder tentacle");
  }
  const { model, compute } = parseModelIdForChat(id);
  if (compute.target === "local") return localBackend(process.env.OLLAMA_HOST || "http://127.0.0.1:11434", model);
  if (!networkDeps && hosted) return hostedBackend(hosted, id);
  return runRoute({ placement: compute.target === "auto" ? "network" : (compute.target as "network"), model, cSatsPerSecond: 0, reason: "", computeClass: compute.computeClass ?? "any", reservationId: compute.reservationId }, "edgecoder tentacle");
}

/**
 * Desktop Code view chats that run helpers (POST /v1/ide/chat with `helpers`, the chat's Helpers
 * switch). They aren't hub sessions, so the tentacle host finds them here: the chat's project and
 * permission mode, and `emit`, the open turn's event stream (null between turns).
 */
interface ChatHelpers {
  data: SessionData;
  emit: ((ev: Record<string, unknown> & { type: string }) => void) | null;
}
const chatHelpers = new Map<string, ChatHelpers>();

function bindChatHelpers(id: string, o: { projectRoot: string; mode: PermissionMode; model: string }, emit: ChatHelpers["emit"]): ChatHelpers {
  const now = Date.now();
  const prev = chatHelpers.get(id);
  const data: SessionData = {
    id,
    title: "Code chat",
    projectRoot: o.projectRoot,
    branch: null,
    model: o.model,
    compute: { target: "local" },
    mode: o.mode,
    autoApprove: o.mode === "auto-edits" || o.mode === "auto" ? "edits" : "none",
    alwaysShell: [],
    origin: "desktop",
    published: false,
    createdAt: prev?.data.createdAt ?? now,
    updatedAt: now,
    cSats: 0,
    transcript: [],
    // Helpers run on auto (local first, then the network's best fit): never the chat's frontier lead.
    workerModel: "auto",
  };
  const entry: ChatHelpers = { data, emit };
  chatHelpers.delete(id);
  chatHelpers.set(id, entry);
  // Keep the most recent chats (a waiting patch can still be merged from the app); forget the oldest idle ones.
  for (const [old, c] of chatHelpers) {
    if (chatHelpers.size <= 200) break;
    if (!c.emit) chatHelpers.delete(old);
  }
  return entry;
}

const tentacles: TentacleManager = new TentacleManager({
  host: {
    session: (id): SessionData | null => sessions.peek(id) ?? (chatHelpers.has(id) ? structuredClone(chatHelpers.get(id)!.data) : null),
    publishEvent: (id, ev) => {
      const chat = chatHelpers.get(id);
      if (chat) chat.emit?.(ev);
      else sessions.publishEvent(id, ev);
    },
    // A Code view chat keeps its own transcript in the app: the tentacle's result reaches the lead and the stream.
    recordNote: (id, note) => (chatHelpers.has(id) ? null : sessions.recordNote(id, note)),
  },
  workerBackend: (model) => tentacleWorkerBackend(model),
  // Local first: a capable model on this computer for low-complexity helpers on auto (Auto's view of
  // the installed models and their tool support, routeInputsHere), else null and the network.
  localModelFor: async (need) => pickLocalHelperModel((await routeInputsHere()).localModels, need),
  localBackend: (model) => localBackend(process.env.OLLAMA_HOST || "http://127.0.0.1:11434", model),
  // Helpers run what the session's mode runs without asking (the shared classifier), never more.
  shellAllowed: (s, command) => (chatHelpers.has(s.id) ? decideFor(s.mode, s.projectRoot, "run_shell", { command }).action === "run" : sessions.allowedWithoutAsking(s, "run_shell", { command })),
  checkpoints,
});

/** The lead's model id for this turn: context graduation (lead-model.ts, EDGECODER_CONTEXT_GRADUATION=1) among network leads. */
function graduatedLead(s: SessionData, emit: (e: IdeStreamEvent) => void): string {
  const current = modelIdOf(s);
  // A frontier lead has the biggest window already; graduation never picks a frontier model itself
  // (that would spend the user's key for whoever sent the message).
  if (process.env.EDGECODER_CONTEXT_GRADUATION !== "1" || isFrontierModelId(current)) return current;
  const pick = chooseLeadModel({
    current,
    promptTokens: estimateTokens(s.transcript.filter((t) => t.role !== "note"), 12_000),
    candidates: parseLeadCandidates(process.env.EDGECODER_LEAD_CANDIDATES).filter((c) => !isFrontierModelId(c.id)),
    frontierLead: null,
  });
  if (!pick.changed) return current;
  emit({ type: "status", message: `Context: ${pick.reason}` });
  return pick.model;
}

const sessions: SessionHub = new SessionHub({
  chat: (s: SessionData, emit, signal, ctx) =>
    sessionChat(s, ctx?.role === "worker" ? workerModelOf(s) : graduatedLead(s, emit), emit, signal, ctx?.client ?? null, ctx?.role ?? "lead"),
  owner: () => lastAccount,
  systemPrompt: async (s) => {
    const ctx = await agentPromptContext(s.compute.target === "local" ? s.model : process.env.OLLAMA_MODEL || "qwen3.5:9b");
    const rules = readProjectRules(s.projectRoot);
    // The project's Node version versus the shell's, and how to run under the right one (toolchain.ts).
    const node = toolchainNote(s.projectRoot);
    return withTentacleGuidance((format) => [buildIdeAgentSystemPrompt(ctx, s.projectRoot, rules, format), node].filter(Boolean).join("\n\n"), tentacles.enabled(s.id), tentacles.unreported(s.id));
  },
  executor: (s) => {
    const index = codebaseIndexFor(s.projectRoot, ollamaHostForIndex());
    const executor = new ToolExecutor(s.projectRoot, undefined, index.getStatus().state === "ready" ? async (q) => formatSearchHits(await index.search(q, 6)) : undefined, { github: githubCreds });
    return { execute: tentacleExecutor(tentacles, s.id, (tool, args, opts) => executor.execute(tool, args, opts)), prepare: (tool, args) => preparePullRequestArgs(executor, tool, args) };
  },
  tools: (s) => withTentacleTools(hasGitHubOrigin(s.projectRoot) ? toolSchemas() : toolSchemas().filter((t) => t.function.name !== "open_pull_request"), tentacles.enabled(s.id)),
  checkpoints,
  branch: currentBranch,
  contextWindow: async (s) => {
    const fixed = Number(process.env.AGENT_CONTEXT_WINDOW);
    if (s.compute.target === "local") return Number.isInteger(fixed) && fixed >= 2048 ? fixed : 32_768;
    // A frontier lead: the model's own window (Anthropic's current models: 1M tokens).
    if (s.compute.target === "frontier") return frontierContextWindow(s.compute.provider ?? "", s.model);
    // auto may land anywhere: the default (conservative) window.
    if (s.compute.target === "auto" || !networkDeps) return undefined;
    return networkContextWindow(networkDeps, s.model).catch(() => undefined);
  },
  summarize: (s, emit, signal, ctx) => async (text) => {
    // A cheap call on the session's worker model (default auto: a small model for a short job, on
    // the network or this computer). Never the frontier lead, unless the user opted in
    // (frontier setting compactWithLead), and then only for the key owner's own turn.
    const sig = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const pick = compactionModelOf(s, frontier.store.settings().compactWithLead);
    const chat =
      pick.role === "worker" && pick.id === "auto" && !networkDeps && !hosted
        ? chatFnFor({ target: "local" }, s.compute.target === "local" ? s.model : process.env.OLLAMA_MODEL || "qwen3.5:9b", process.env.OLLAMA_HOST || "http://127.0.0.1:11434", emit, sig, "edgecoder compaction")
        : sessionChat(s, pick.id, emit, sig, ctx?.client ?? null, pick.role);
    const r = await chat({
      messages: [
        { role: "system", content: "Summarize this coding-agent conversation for the agent itself, in at most 200 words: what was asked, what was found and changed (with exact file paths and line numbers), and what is left to do. No preamble." },
        { role: "user", content: text },
      ],
    });
    return r.content.trim() || null;
  },
  onSessionStop: (id) => void tentacles.cancelAll(id),
}, { permissions: permissionStore });
registerSessionRoutes(app, sessions);
// The desktop Code view's chats, mirrored so the owner's phone can read and continue them (desktop-chats.ts).
registerDesktopChatRoutes(app, sessions);
registerTentacleRoutes(app, sessions, tentacles, { isChat: (id) => chatHelpers.has(id) && !sessions.peek(id) });
// Coding sessions driven from the phone, this Mac's side (code-remote.ts): trusted folders only, no paths out.
registerCodeRemoteRoutes(app, sessions, { account: machineAccount, checkpoints, machineSalt: (() => { let salt: string | undefined; return () => (salt ??= loadOrCreateMachineSalt()); })(), branch: currentBranch });

// Settings → Active work, Tasks and Logs (activity-routes.ts).
registerActivityRoutes(app, {
  tracker: activity,
  agentHealth: networkDeps && !networkDeps.transport
    ? () => networkCall(networkDeps, "GET", "/health").then((r) => (r.status === 200 ? r.json : null)).catch(() => null)
    : null,
  ownTaskIds: () => new Set([...ownInflightTaskIds, ...networkTasks.list().filter((t) => t.state === "running").map((t) => t.id)]),
  extra: [
    () => sessions.list().filter((s) => s.running && !s.external).map((s) => sessionActivity(s, sessions.snapshot(s.id).running as Parameters<typeof sessionActivity>[1])).filter((x) => x !== null),
    () => bots.list().map((b) => botActivity(b)).filter((x) => x !== null),
    () => sessions.list().flatMap((s) => tentacles.list(s.id).tentacles.map((t) => tentacleActivity(t, s.title))).filter((x) => x !== null),
    () => networkTasks.list().map((t) => networkTaskActivity(t)).filter((x) => x !== null),
  ],
});
app.addHook("onReady", async () => {
  sessions.load();
  void machineAccount();
});

// --- Frontier keys (Settings → Frontier models, `edgecoder keys`): loopback + IDE token like every route here ---
// The key arrives in a request body (never logged: request bodies aren't) and goes straight to the
// OS credential store; no response or error ever contains it.

async function frontierRoute(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return reply.send(await fn());
  } catch (err) {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (err instanceof FrontierKeyError || err instanceof ChatBackendError) return reply.status(err.status).send({ error: "frontier", message: err.message });
    throw err;
  }
}

const frontierKeyInput = z.object({
  id: z.string().min(1).max(32),
  kind: z.enum(["anthropic", "openai-compatible"]).optional(),
  baseUrl: z.string().max(500).optional(),
  key: z.string().min(1).max(600),
});

app.get("/v1/ide/frontier", (_req, reply) => frontierRoute(reply, () => frontier.status()));
app.post("/v1/ide/frontier/keys", (req, reply) =>
  frontierRoute(reply, async () => {
    const b = frontierKeyInput.extend({ skipTest: z.boolean().optional() }).parse(req.body ?? {});
    return frontier.add(b);
  }));
app.post("/v1/ide/frontier/keys/test", (req, reply) =>
  frontierRoute(reply, async () => {
    const b = z.object({ id: z.string().min(1).max(32), kind: z.enum(["anthropic", "openai-compatible"]).optional(), baseUrl: z.string().max(500).optional(), key: z.string().min(1).max(600).optional() }).parse(req.body ?? {});
    return b.key ? frontier.test({ ...b, key: b.key }) : frontier.retest(b.id);
  }));
app.post("/v1/ide/frontier/keys/remove", (req, reply) =>
  frontierRoute(reply, async () => {
    const b = z.object({ id: z.string().min(1).max(32), ownerAccount: z.string().min(1).max(128).optional() }).parse(req.body ?? {});
    return { removed: await frontier.remove(b.id, b.ownerAccount) };
  }));
app.post("/v1/ide/frontier/settings", (req, reply) =>
  frontierRoute(reply, async () => {
    const price = z.object({ input: z.number().min(0), output: z.number().min(0), cacheWrite: z.number().min(0).optional(), cacheRead: z.number().min(0).optional() });
    const b = z
      .object({
        defaultLead: z.string().max(240).optional(),
        workerModel: z.string().max(240).optional(),
        sessionCapUsd: z.number().min(0).nullable().optional(),
        dailyCapUsd: z.number().min(0).nullable().optional(),
        useForAuto: z.boolean().optional(),
        compactWithLead: z.boolean().optional(),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        prices: z.record(z.string().max(200), price).optional(),
      })
      .parse(req.body ?? {});
    return { settings: frontier.store.updateSettings(b) };
  }));
app.addHook("onClose", async () => {
  sessions.shutdown();
});

// --- Legacy endpoints (backward compat) ---

// #36: /run, /run/local, /run/swarm, the shape the VS Code extension expects
// (InteractiveAgent output + route + latencyMs; see src/apps/ide/routes.ts).
const runSchema = z.object({
  task: z.string().min(1),
  language: z.enum(["python", "javascript"]).default("python"),
  maxTokens: z.number().int().positive().max(8192).optional(),
  provider: z.enum(["edgecoder-local", "ollama-local"]).optional()
});

app.get("/models", async () => ({
  providers: providers.availableProviders()
}));

async function handleRun(mode: "auto" | "local" | "swarm", req: { body: unknown; log?: any }, reply: any) {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
  const body = parsed.data;
  const started = Date.now();

  if (mode === "swarm") {
    if (!router.swarmEnabled) {
      return reply.code(503).send({ error: "swarm_unavailable", message: "Swarm routing is not configured (no local agent forwarder or MESH_AUTH_TOKEN)." });
    }
    const budget = swarmBudget.reserve();
    if (!budget.ok) {
      return reply.code(402).send({ error: "swarm_spend_cap", reason: budget.reason, budget: swarmBudget.status() });
    }
    try {
      let res;
      try {
        res = await router.routeSwarm(body.task, body.maxTokens);
      } catch (error) {
        // #113: only a failed submit is free. Once the coordinator accepted the task it can
        // still run and bill, so a poll timeout counts the estimate against the cap.
        if (error instanceof SwarmPostSubmitError) swarmBudget.settle(undefined);
        else swarmBudget.release();
        throw error;
      }
      const settled = swarmBudget.settle(res.creditsSpent);
      if (settled.overPerRequestCap) {
        req.log?.warn?.({ creditsSpent: res.creditsSpent, swarmTaskId: res.swarmTaskId }, "ide_swarm_spend_over_request_cap");
      }
      return reply.send({
        plan: "",
        generatedCode: res.text,
        // Nothing ran locally: don't present swarm output as an executed, passing run.
        runResult: { stdout: "", stderr: "", exitCode: null },
        ran: false,
        route: "swarm",
        latencyMs: res.latencyMs,
        creditsSpent: res.creditsSpent,
        swarmTaskId: res.swarmTaskId
      });
    } catch (error) {
      // Log details server-side; don't echo coordinator URLs/responses to the client.
      req.log?.error?.({ err: error }, "ide /run/swarm failed");
      return reply.code(502).send({ error: "swarm_failed", message: "The swarm request failed. See the provider server log for details." });
    }
  }

  const provider = body.provider ?? "edgecoder-local";
  providers.use(provider);
  const agent = new InteractiveAgent(providers.current());
  const output = await agent.run(body.task, body.language);
  return reply.send({ ...output, ran: true, route: provider, latencyMs: Date.now() - started });
}

app.post("/run", (req, reply) => handleRun("auto", req, reply));
app.post("/run/local", (req, reply) => handleRun("local", req, reply));
app.post("/run/swarm", (req, reply) => handleRun("swarm", req, reply));

if (import.meta.url === `file://${process.argv[1]}`) {
  let listenOptions: { host: string; port: number };
  try {
    listenOptions = resolveListenOptions();
    ideToken = resolveIdeToken();
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
  // The bot scheduler runs only in the real server (not when tests import the app).
  bots.start();
  app.listen(listenOptions).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
  // Preview stays on loopback whatever the main server binds to.
  preview.server.on("error", (err) => app.log.warn({ err: String(err) }, "preview_server_unavailable"));
  preview.server.listen(previewPort, "127.0.0.1");
}

export { app as ideProviderServer };
