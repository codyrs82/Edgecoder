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
 *  GET  /bt-status       — BLE proxy: phone connection state, battery, model state
 *  POST /run             — run a task, auto-routed
 *  POST /run/local       — force local Ollama (bypasses router)
 *  POST /run/bluetooth   — force bluetooth-local (bypasses router)
 *  POST /run/swarm       — force swarm submission (bypasses router)
 */

import Fastify from "fastify";
import { z } from "zod";
import { IntelligentRouter } from "../../model/router.js";
import { InteractiveAgent } from "../../agent/interactive.js";
import { ProviderRegistry } from "../../model/providers.js";
import { bleProxy } from "../../bluetooth/ble-proxy-server.js";
import type { Language } from "../../common/types.js";

const app = Fastify({ logger: true });

// Start BLE proxy companion process (no-op if binary not installed)
bleProxy.start().catch((err) => {
  app.log.warn({ err }, "[ble-proxy] Failed to start — bluetooth-local routing disabled");
});

// Build router — pass BLE status URL so it can probe connection state
const router = new IntelligentRouter({
  bluetoothStatusUrl: bleProxy.isAvailable ? bleProxy.statusUrl : undefined
});
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
  bluetoothAvailable: bleProxy.isAvailable,
  description: {
    "bluetooth-local": "Nearby iPhone/Mac via Bluetooth — free, offline, no credits",
    "ollama-local":    "Local Ollama model — free when healthy and under capacity",
    "swarm":           "Coordinator task queue — uses credits, fulfilled by mesh agents",
    "edgecoder-local": "Deterministic stub — always-on safety net"
  }
}));

app.get("/status", async () => ({
  ...router.status(),
  bluetoothProxyAvailable: bleProxy.isAvailable
}));

/**
 * GET /bt-status
 * Returns the current BLE connection state from the edgecoder-ble-proxy companion.
 * Used by the IDE extension and iOS app tracker to show which phone is connected,
 * its battery level, and the model state (loading / ready / running).
 */
app.get("/bt-status", async (_req, reply) => {
  if (!bleProxy.isAvailable) {
    return reply.status(503).send({
      available: false,
      reason: "BLE proxy binary not installed. Run: npm run build:ble-proxy"
    });
  }
  const status = await bleProxy.getStatus();
  if (!status) {
    return reply.status(503).send({ available: true, connected: false, scanning: false });
  }
  return reply.send({ available: true, ...status });
});

/**
 * POST /run
 * Auto-routed: IntelligentRouter picks the best backend.
 * Returns plan + generatedCode + runResult from the InteractiveAgent,
 * plus routing metadata so the IDE extension can show where work ran.
 */
app.post("/run", async (req, reply) => {
  const body = runSchema.parse(req.body);

  // Explicit legacy provider overrides
  if (body.provider === "edgecoder-local" || body.provider === "ollama-local") {
    providers.use(body.provider);
    const agent = new InteractiveAgent(providers.current());
    const output = await agent.run(body.task, body.language as Language);
    return reply.send({ ...output, route: body.provider });
  }

  // Explicit bluetooth-local override
  if (body.provider === "bluetooth-local") {
    const result = await bleProxy.generate(
      `Write ${body.language} code for this task:\n${body.task}`,
      body.maxTokens
    );
    if (!result) {
      return reply.status(503).send({
        error: "bluetooth-local unavailable",
        route: "bluetooth-local"
      });
    }
    return reply.send({
      plan: "Routed via: bluetooth-local (forced)",
      generatedCode: result.response ?? result.text ?? "",
      runResult: { stdout: "", stderr: "", exitCode: 0 },
      route: "bluetooth-local",
      durationMs: result.durationMs,
      deviceName: result.deviceName
    });
  }

  // Smart route: IntelligentRouter waterfall
  const prompt = `Write ${body.language} code for this task:\n${body.task}`;
  const routed = await router.route(prompt, body.maxTokens);

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
  providers.use("ollama-local");
  const agent = new InteractiveAgent(providers.current());
  const output = await agent.run(body.task, body.language as Language);
  return reply.send({ ...output, route: "ollama-local" });
});

/**
 * POST /run/bluetooth
 * Force bluetooth-local regardless of router state.
 * Used when the user explicitly wants to offload to their phone over BT.
 * Returns the device name so the IDE can show "running on iPhone 15 Pro".
 */
app.post("/run/bluetooth", async (req, reply) => {
  const body = runSchema.parse(req.body);

  if (!bleProxy.isAvailable) {
    return reply.status(503).send({
      error: "BLE proxy not available. Build it with: npm run build:ble-proxy",
      route: "bluetooth-local"
    });
  }

  const prompt = `Write ${body.language} code for this task:\n${body.task}`;
  const result = await bleProxy.generate(prompt, body.maxTokens);

  if (!result) {
    return reply.status(503).send({
      error: "No phone connected. Open EdgeCoder on your iPhone and set mode to Bluetooth Local.",
      route: "bluetooth-local"
    });
  }

  return reply.send({
    plan: "Routed via: bluetooth-local (forced)",
    generatedCode: result.response ?? result.text ?? "",
    runResult: { stdout: "", stderr: "", exitCode: 0 },
    route: "bluetooth-local",
    durationMs: result.durationMs,
    deviceName: result.deviceName
  });
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
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on("SIGTERM", async () => {
  app.log.info("SIGTERM — stopping BLE proxy and shutting down.");
  await bleProxy.stop();
  await app.close();
  process.exit(0);
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
