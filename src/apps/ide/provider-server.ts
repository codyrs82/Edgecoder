// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

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
import { ToolExecutor } from "./tool-executor.js";
import { MAX_EDITOR_FILE_BYTES, ProjectFs, ProjectFsError, findPaths, readProjectRules } from "./project-fs.js";
import { CheckpointStore } from "./checkpoints.js";
import { cleanInlineEdit, inlineEditMessages } from "./inline-edit.js";
import { makeToolRunner, ollamaChat, runAgentLoop } from "./agent-loop.js";
import { completeAt } from "./complete.js";
import { codebaseIndexFor } from "./codebase-index.js";
import { GitError, GitOps } from "./git-ops.js";
import { NetworkTasks } from "./network-tasks.js";
import { contentToText, listNetworkModels, NetworkInferenceError, parseNetworkModel, streamNetworkCompletion, type CompletionPiece, type NetworkDeps } from "./network-inference.js";
import { checkProject } from "./diagnostics.js";
import { createPreviewServer, PREVIEW_DEFAULT_PORT } from "./preview-server.js";
import { createNewProject } from "./new-project.js";
import type { IdeStreamEvent, ToolName } from "./tool-types.js";
import { SwarmSpendGuard, swarmBudgetFromEnv } from "./swarm-budget.js";
import { allowedOrigins, createIdeAuthHook, isLoopbackHost, registerIdeCors, resolveIdeToken, resolveListenOptions } from "./ide-auth.js";

// Forked by the agent: exit with it, so a restarted agent's provider can take the port.
if (process.send) process.on("disconnect", () => process.exit(0));

const app = Fastify({ ...serviceLoggerOptions("ide-provider") });
exposeRequestId(app);
registerMetrics(app, "ide-provider");
await registerErrorTracking(app, "ide-provider");

// #4: loopback bind + bearer token (except /health) + web-Origin / foreign-Host rejection.
// No import-time side effects: the token file is read/created on first authenticated
// request, and the bind address is validated only when the server is started.
const ideHost = (process.env.IDE_PROVIDER_HOST ?? "").trim() || "127.0.0.1";
const idePort = Number(process.env.IDE_PROVIDER_PORT ?? 4304) || 4304;
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

const providers = new ProviderRegistry();

/**
 * Frozen snapshot for swarm submissions (#8): the active project's git HEAD, so the
 * coordinator's /submit accepts the task. IDE_SWARM_SNAPSHOT_REF overrides (router).
 */
function projectHeadCommit(): string | undefined {
  if (!activeProjectRoot) return undefined;
  try {
    const head = execFileSync("git", ["-C", activeProjectRoot, "rev-parse", "HEAD"], {
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
const pendingApprovals = new Map<
  string,
  {
    resolve: (approved: boolean) => void;
    tool: ToolName;
    args: Record<string, unknown>;
  }
>();

// --- OpenAI-compatible endpoints ---

/** This machine's agent forwarder, when the machine is on the network (network models need it). */
const networkDeps: NetworkDeps | null = process.env.SWARM_VIA_LOCAL_AGENT_URL
  ? { forwarder: process.env.SWARM_VIA_LOCAL_AGENT_URL.replace(/\/$/, ""), token: () => (ideToken ??= resolveIdeToken()), agentId: process.env.AGENT_ACCOUNT_ID ?? process.env.AGENT_ID ?? "local-agent" }
  : null;

app.get("/v1/models", async () => {
  // Providers, this machine's Ollama models, and models agents on the network have
  // ("network/<model>", optionally "@<class>"): one list for tools that pick a model.
  const ids = new Set<string>(providers.availableProviders());
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
  return formatOpenAiModelsResponse([...ids]);
});

const chatRequestSchema = z.object({
  model: z.string().default("edgecoder-local"),
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
  return reply.send({ ok: true, projectRoot: activeProjectRoot });
});

app.get("/v1/ide/project", async (_req, reply) => {
  return reply.send({ projectRoot: activeProjectRoot });
});

// ---------------------------------------------------------------------------
// Project files for the editor and file tree, confined to the open project (project-fs.ts).
// Mutations are POST: the desktop's CORS allows GET and POST only.
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
  return reply.send(await checkProject(activeProjectRoot, inside));
});

// Live preview of web projects (preview-server.ts), on its own loopback origin.
const previewPort = Number(process.env.IDE_PREVIEW_PORT ?? PREVIEW_DEFAULT_PORT) || PREVIEW_DEFAULT_PORT;
const preview = createPreviewServer(() => activeProjectRoot);
app.get("/v1/ide/preview", async (req, reply) => {
  if (!activeProjectRoot) return reply.status(409).send({ error: "no_project", message: "Open a project folder first" });
  const { path } = z.object({ path: z.string().max(4096).default("") }).parse(req.query);
  return reply.send({ url: preview.urlFor(previewPort, path) });
});

// A new project for something the user asked to build from chat: ~/EdgeCoder Projects/<name>.
app.post("/v1/ide/projects/new", async (req, reply) => {
  const { name } = z.object({ name: z.string().max(200).default("") }).parse(req.body ?? {});
  const projectRoot = createNewProject(name);
  activeProjectRoot = projectRoot;
  return reply.send({ projectRoot });
});

const toolApprovalSchema = z.object({
  id: z.string().min(1),
  approved: z.boolean(),
});

app.post("/v1/ide/tool-approval", async (req, reply) => {
  const body = toolApprovalSchema.parse(req.body);
  const entry = pendingApprovals.get(body.id);
  if (!entry) {
    return reply.status(404).send({ error: "No pending approval with that id" });
  }
  entry.resolve(body.approved);
  pendingApprovals.delete(body.id);
  return reply.send({ ok: true });
});

const ideChatSchema = z.object({
  messages: z
    .array(z.object({ role: z.string(), content: z.string() }))
    .min(1),
  model: z.string().optional(),
  projectRoot: z.string().optional(),
  githubToken: z.string().optional(),
  /** "edits": file writes and edits apply without asking (checkpoints keep them undoable); commands still ask. */
  autoApprove: z.enum(["none", "edits"]).default("none"),
});

app.post("/v1/ide/chat", async (req, reply) => {
  const body = ideChatSchema.parse(req.body);
  const projectRoot = body.projectRoot ?? activeProjectRoot;

  if (!projectRoot) {
    return reply.status(400).send({
      error: "No project root set. POST /v1/ide/project first or include projectRoot in body.",
    });
  }

  const index = codebaseIndexFor(projectRoot, ollamaHostForIndex());
  const executor = new ToolExecutor(
    projectRoot,
    body.githubToken,
    index.getStatus().state === "ready" ? async (q) => formatSearchHits(await index.search(q, 6)) : undefined,
  );
  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const chatModel =
    body.model || process.env.OLLAMA_MODEL || "qwen3.5:9b";

  // Build system prompt
  let promptCtx: SystemPromptContext | null = null;
  try {
    let ollamaHealthy = true;
    let installedModels: Array<{ name: string; paramSize: number }> = [];
    let activeModelParamSize = 0;
    let activeModelQuantization: string | undefined;

    try {
      const tags = await ollamaTags();
      installedModels = tags.models.map((m) => ({
        name: m.name,
        paramSize: parseFloat(
          m.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0",
        ),
      }));
      const entry = tags.models.find((m) => m.name === chatModel);
      if (entry) {
        activeModelParamSize = parseFloat(
          entry.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0",
        );
        activeModelQuantization = entry.details.quantization_level;
      }
    } catch {
      ollamaHealthy = false;
    }

    const ctx: SystemPromptContext = {
      activeModel: chatModel,
      activeModelParamSize,
      activeModelQuantization,
      installedModels,
      swarmModels: [],
      ollamaHealthy,
      queueDepth: 0,
      connectedAgents: 0,
    };
    promptCtx = ctx;
  } catch {
    // Non-critical — proceed without system prompt
  }
  const projectRules = readProjectRules(projectRoot);

  // SSE setup
  writeSseHead(reply);

  let clientDisconnected = false;
  // The response closing before the stream ended means the client went away (the request's own
  // "close" fires as soon as its body has been read).
  reply.raw.on("close", () => {
    if (reply.raw.writableEnded) return;
    clientDisconnected = true;
    // Clean up any pending approvals for this request
    for (const [id, entry] of pendingApprovals) {
      entry.resolve(false);
      pendingApprovals.delete(id);
    }
  });

  function sendEvent(event: IdeStreamEvent): void {
    if (clientDisconnected) return;
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const turnId = randomUUID();
  checkpoints.begin(turnId, projectRoot);
  sendEvent({ type: "turn", id: turnId });

  const abort = new AbortController();
  reply.raw.on("close", () => { if (!reply.raw.writableEnded) abort.abort(); });
  await runAgentLoop({
    chat: ollamaChat(ollamaHost, chatModel, abort.signal),
    systemPrompt: (format) => (promptCtx ? buildIdeAgentSystemPrompt(promptCtx, projectRoot, projectRules, format) : ""),
    messages: body.messages,
    sendEvent,
    isCancelled: () => clientDisconnected,
    runTool: makeToolRunner({
      execute: (tool, args, opts) => executor.execute(tool, args, opts),
      sendEvent,
      waitForApproval: (callId, tool, args) =>
        new Promise<boolean>((resolveApproval) => {
          // 5-minute timeout — auto-reject
          const timer = setTimeout(() => {
            if (pendingApprovals.has(callId)) {
              pendingApprovals.delete(callId);
              resolveApproval(false);
            }
          }, 5 * 60 * 1000);
          pendingApprovals.set(callId, {
            resolve: (val: boolean) => {
              clearTimeout(timer);
              resolveApproval(val);
            },
            tool,
            args,
          });
        }),
      captureBeforeWrite: (path) => checkpoints.capture(turnId, path),
      turnId,
      autoApproveEdits: body.autoApprove === "edits",
    }),
  });

  sendEvent({ type: "done" });
  reply.raw.end();
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
  app.listen(listenOptions).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
  // Preview stays on loopback whatever the main server binds to.
  preview.server.on("error", (err) => app.log.warn({ err: String(err) }, "preview_server_unavailable"));
  preview.server.listen(previewPort, "127.0.0.1");
}

export { app as ideProviderServer };
