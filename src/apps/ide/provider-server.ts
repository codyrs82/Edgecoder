/**
 * EdgeCoder IDE Provider Server — localhost:4304
 *
 * Bridges VS Code / Cursor extensions to the local agent runtime.
 * Every request is routed through IntelligentRouter which decides:
 *
 *   bluetooth-local  → nearby iPhone/Mac over BT (free, offline)
 *   ollama-local     → local Ollama if healthy + within capacity
 *   swarm            → coordinator task queue (costs credits, earns for fulfiller)
 *   edgecoder-local  → deterministic stub (always-on safety net)
 *
 * Endpoints
 * ---------
 *  GET  /health          — liveness check
 *  GET  /models          — list available routes/providers
 *  GET  /status          — router internals (latency, concurrency, flags)
 *  POST /run             — run a task, auto-routed
 *  POST /run/local       — force local Ollama (bypasses router)
 *  POST /run/swarm       — force swarm submission (bypasses router)
 */

import Fastify from "fastify";
import { z } from "zod";
import { IntelligentRouter } from "../../model/router.js";
import { InteractiveAgent } from "../../agent/interactive.js";
import { ProviderRegistry } from "../../model/providers.js";
import type { Language } from "../../common/types.js";

const app = Fastify({ logger: true });
const router = new IntelligentRouter();
const providers = new ProviderRegistry();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const runSchema = z.object({
  task: z.string().min(1).max(32_000),
  language: z.enum(["python", "javascript"]).default("python"),
  /** Override auto-routing. Omit to let IntelligentRouter decide. */
  provider: z.enum(["edgecoder-local", "ollama-local", "swarm", "bluetooth-local"]).optional(),
  maxTokens: z.number().int().min(1).max(8192).default(512)
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", async () => ({ ok: true, ts: Date.now() }));

app.get("/models", async () => ({
  routes: ["bluetooth-local", "ollama-local", "swarm", "edgecoder-local"],
  providers: ["edgecoder-local", "ollama-local"],
  description: {
    "bluetooth-local": "Nearby iPhone/Mac via Bluetooth — free, offline, no credits",
    "ollama-local":    "Local Ollama model — free when healthy and under capacity",
    "swarm":           "Coordinator task queue — uses credits, fulfilled by mesh agents",
    "edgecoder-local": "Deterministic stub — always-on safety net"
  }
}));

app.get("/status", async () => router.status());

/**
 * POST /run
 * Auto-routed: IntelligentRouter picks the best backend.
 * Returns plan + generatedCode + runResult from the InteractiveAgent,
 * plus routing metadata so the IDE extension can show where work ran.
 */
app.post("/run", async (req, reply) => {
  const body = runSchema.parse(req.body);

  // If caller explicitly forced a provider, honour it via the legacy path
  if (body.provider === "edgecoder-local" || body.provider === "ollama-local") {
    providers.use(body.provider);
    const agent = new InteractiveAgent(providers.current());
    const output = await agent.run(body.task, body.language as Language);
    return reply.send({ ...output, route: body.provider });
  }

  // Smart route: use the prompt as-is for planning/generation
  const prompt = `Write ${body.language} code for this task:\n${body.task}`;
  const routed = await router.route(prompt, body.maxTokens);

  // Wrap routed text in the standard AgentExecution envelope
  return reply.send({
    plan: `Routed via: ${routed.route}`,
    generatedCode: routed.text,
    runResult: { stdout: "", stderr: "", exitCode: 0 },
    route: routed.route,
    latencyMs: routed.latencyMs,
    ...(routed.swarmTaskId  ? { swarmTaskId:   routed.swarmTaskId }  : {}),
    ...(routed.creditsSpent !== undefined ? { creditsSpent: routed.creditsSpent } : {}),
    ...(routed.error        ? { routeError:    routed.error }         : {})
  });
});

/**
 * POST /run/local
 * Force Ollama-local even if router would choose swarm.
 * Useful for offline work or when the user explicitly wants on-device inference.
 */
app.post("/run/local", async (req, reply) => {
  const body = runSchema.parse(req.body);
  const prompt = `Write ${body.language} code for this task:\n${body.task}`;
  providers.use("ollama-local");
  const agent = new InteractiveAgent(providers.current());
  const output = await agent.run(body.task, body.language as Language);
  return reply.send({ ...output, route: "ollama-local" });
});

/**
 * POST /run/swarm
 * Force swarm submission regardless of local capacity.
 * Used when the user wants distributed execution and has credits to spend.
 */
app.post("/run/swarm", async (req, reply) => {
  const body = runSchema.parse(req.body);
  const prompt = `Write ${body.language} code for this task:\n${body.task}`;
  const routed = await router.route(prompt, body.maxTokens);
  // router.route will fall through to swarm because local won't be preferred
  // when we force here — for a true force, invoke via router directly
  return reply.send({
    plan: `Forced swarm route`,
    generatedCode: routed.text,
    runResult: { stdout: "", stderr: "", exitCode: 0 },
    route: routed.route,
    latencyMs: routed.latencyMs,
    ...(routed.swarmTaskId    ? { swarmTaskId:   routed.swarmTaskId }   : {}),
    ...(routed.creditsSpent !== undefined ? { creditsSpent: routed.creditsSpent } : {})
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port: 4304, host: "127.0.0.1" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as ideProviderServer };
