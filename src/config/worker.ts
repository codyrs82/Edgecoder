// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envEnum, envEnumCi, envFlag, envFlagWord, envInt, envNumber, envPort, envUrl } from "../common/config.js";
import { cloudModelsEnv, computeClassEnv, discoveryEnv, modelEnv, releaseEnv, sandboxEnv, serviceUrlsEnv, trustEnv, webReplyEnv } from "./shared.js";

const str = () => z.string().optional();
const amount = () => envNumber(undefined, { min: 0 });

/*
 * #15: worker agent (src/swarm/worker-runner.ts; also started by the all-in-one entry and by
 * src/swarm/ios-agent.ts). The worker runs on contributors' machines, so nothing is required:
 * every variable has a default or is optional, exactly as before. What changes is that a
 * malformed value (a non-numeric timeout, an unknown mode) stops the worker with a message that
 * names the variable instead of running with NaN or a silently ignored setting.
 */
export const workerConfigSchema = z.object({
  ...serviceUrlsEnv,
  ...modelEnv,
  ...sandboxEnv,
  ...releaseEnv,
  ...trustEnv,
  ...discoveryEnv,
  ...computeClassEnv,
  ...webReplyEnv,
  ...cloudModelsEnv,
  NODE_ENV: str(),
  HOST: str(),

  // ---- identity and mode ----
  /** Default: worker-<hostname>. */
  AGENT_ID: str(),
  AGENT_MODE: envEnum(["swarm-only", "ide-enabled"]).default("swarm-only"),
  // A free string: installers write values such as "linux" here and the worker only reports it.
  AGENT_OS: str(),
  AGENT_CLIENT_TYPE: z.string().default("edgecoder-native"),
  /** Hosting region code shown in the network's world view (e.g. "sin"); unset = FLY_REGION when on Fly. */
  AGENT_REGION: z.string().regex(/^[a-z0-9-]{2,24}$/, "a region code such as sin or us-east-1").optional(),
  AGENT_DEVICE_ID: str(),
  AGENT_REGISTRATION_TOKEN: str(),
  MESH_AUTH_TOKEN: str(),
  PORTAL_URL: envUrl(),
  /** Set by src/swarm/ios-agent.ts before it starts the worker. */
  IOS_OLLAMA_MODEL: str(),
  IOS_DEVICE_ID: str(),
  IOS_BATTERY_LEVEL_PCT: envNumber(undefined),
  IOS_LOW_POWER_MODE: envFlagWord(),
  IOS_ON_EXTERNAL_POWER: envFlagWord(),

  // ---- coordinator connection ----
  /** Default http://127.0.0.1:4301; unset also turns on coordinator discovery. */
  COORDINATOR_URL: envUrl(),
  EDGECODER_DISCOVERY: envFlag({ on: ["1"] }),
  COORDINATOR_HTTP_TIMEOUT_MS: envNumber(15_000, { min: 0 }),
  COORDINATOR_POST_RETRIES: envNumber(2, { min: 0 }),
  MAX_CONCURRENT_TASKS: envNumber(1, { min: 0 }),
  AGENT_REGISTER_REFRESH_MS: amount(),
  LEASE_HEARTBEAT_MS: amount(),
  EDGECODER_TRUST_REVERIFY_MS: amount(),
  EDGECODER_STEERING: envFlag({ off: ["off", "0", "false"], ci: true }),
  EDGECODER_STEERING_INTERVAL_MS: amount(),
  /**
   * Address the agent's mesh (gossip) server binds. Default 127.0.0.1: agents pull work from their
   * coordinator, so nothing on the LAN needs to reach it. Set 0.0.0.0 only to opt in to LAN gossip.
   */
  AGENT_MESH_HOST: z.string().trim().min(1).default("127.0.0.1"),
  /**
   * Report this machine's private IPv4 addresses to its coordinator (signed /register), so the
   * owner's desktop app can find their own machines on the same network (src/swarm/lan-proximity.ts).
   * They are shown only to the machine's owner. Default on; off/0/false turns it off.
   */
  AGENT_LAN_HINTS: envFlag({ off: ["off", "0", "false"], ci: true }),
  /** Loopback port for the IDE's swarm forwarder; unset or 0 = off. */
  LOCAL_FORWARD_PORT: envPort(undefined),

  // ---- model and execution ----
  LOCAL_MODEL_PROVIDER: envEnum(["edgecoder-local", "ollama-local"]).default("edgecoder-local"),
  OLLAMA_MODEL: z.string().default("qwen3.5:9b"),
  OLLAMA_AUTO_INSTALL: envFlag({ on: ["true"] }),
  /**
   * Engine that runs the model (src/inference-api/openai-engine.ts): ollama (default), vllm
   * (datacenter NVIDIA GPUs) or mlx (mlx_lm.server on Apple silicon). vLLM and MLX are started on
   * their own (docs/inference-engines.md); the agent checks they are up and serve a catalog model,
   * and never pulls or switches models in them. Keep LOCAL_MODEL_PROVIDER=ollama-local with them.
   */
  EDGECODER_ENGINE: envEnumCi(["ollama", "vllm", "mlx", "cloud"]),
  // ---- cloud host (EDGECODER_ENGINE=cloud or `edgecoder cloud-host`; docs/cloud-host.md) ----
  /** The platform's API key for the hosted model provider. Required for a cloud host; never logged. */
  CLOUD_HOST_API_KEY: str(),
  /** Hosted model provider: fireworks (default). */
  CLOUD_HOST_PROVIDER: envEnumCi(["fireworks"]),
  /** The provider's OpenAI-compatible base URL; default https://api.fireworks.ai/inference/v1. */
  CLOUD_HOST_BASE_URL: envUrl(),
  /** Comma-separated cloud model ids to serve (src/cloud-host/catalog.ts); unset = every catalog model of the provider. */
  CLOUD_HOST_MODELS: str(),
  /** Comma-separated <model id>=<provider model id> overrides of the catalog's provider ids. */
  CLOUD_HOST_MODEL_MAP: str(),
  /** Calls at once (1-16); default 16. */
  CLOUD_HOST_MAX_SLOTS: envInt(undefined, { min: 1, max: 16 }),
  /** Retries of a provider 429 / 5xx before anything streamed; default 3. */
  CLOUD_HOST_MAX_RETRIES: envInt(undefined, { min: 0, max: 10 }),
  /** Daily provider spend cap, USD (UTC day); default 200. */
  CLOUD_HOST_DAILY_CAP_USD: envNumber(undefined, { min: 0 }),
  /** Monthly provider spend cap, USD (UTC month); default 2000. */
  CLOUD_HOST_MONTHLY_CAP_USD: envNumber(undefined, { min: 0 }),
  /** Percent of a cap that sends the ops alert; default 80. */
  CLOUD_HOST_ALERT_PCT: envNumber(undefined, { min: 1, max: 100 }),
  /** Provider auth failures (401/403) in a row that pause the host; default 3. */
  CLOUD_HOST_AUTH_FAILURES: envInt(undefined, { min: 1, max: 100 }),
  /** While paused for a bad key, minutes between key checks; default 15. */
  CLOUD_HOST_AUTH_PROBE_MINUTES: envNumber(undefined, { min: 1, max: 1440 }),
  /** File the spend totals are kept in; default <config dir>/cloud-host-spend.json (use a volume on Fly). */
  CLOUD_HOST_STATE_FILE: str(),
  /** vLLM's OpenAI-compatible server. Default http://127.0.0.1:8000. */
  VLLM_URL: envUrl(),
  /** vLLM --api-key, when the server was started with one. */
  VLLM_API_KEY: str(),
  /** Served model id to use (one of /v1/models); unset = the first served catalog model. */
  VLLM_MODEL: str(),
  /** Model calls at once (1-16); unset = derived from vLLM's KV cache (src/swarm/engine-probe.ts). */
  VLLM_MAX_SLOTS: envInt(undefined, { min: 1, max: 16 }),
  /** mlx_lm.server. Default http://127.0.0.1:8080. */
  MLX_URL: envUrl(),
  /** The MLX model id the server was started with (--model); its /v1/models lists every cached model. */
  MLX_MODEL: str(),
  /** Model calls at once (1-16); default 1 (mlx-lm batches only from 0.28.4, and only calls without a seed). */
  MLX_MAX_SLOTS: envInt(undefined, { min: 1, max: 16 }),
  /** Served id → catalog tag for names the built-in table does not know: "Org/Repo=qwen3-coder:30b,…". */
  ENGINE_MODEL_ALIASES: z.string().trim().max(4000).optional(),
  /** 1-16 concurrent model calls; unset or out of range = by installed memory (src/swarm/parallelism.ts). */
  AGENT_PARALLEL_INFERENCE: envInt(undefined, { min: 0 }),
  /**
   * How long Ollama keeps a model loaded after a network call (Ollama keep_alive): a duration such
   * as "30m" or "1h", seconds, or "-1" for never unload. Default "30m", and "-1" for an
   * inference-only agent (a dedicated host). The agent also loads OLLAMA_MODEL at startup and after
   * a model switch, so the first call does not wait for a cold load.
   */
  AGENT_MODEL_KEEP_ALIVE: z
    .string()
    .trim()
    .regex(/^(-?\d+(\.\d+)?|-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+)$/, "a duration such as 30m, 1h or 300s, a number of seconds, or -1")
    .optional(),
  /**
   * The one context window (tokens) the agent serves network calls with; longer calls go to agents
   * with a bigger one. Default by memory, model size and parallel slots: 8k, 16k or 32k
   * (src/swarm/parallelism.ts servedContextWindow).
   */
  AGENT_CONTEXT_WINDOW: envInt(undefined, { min: 2048, max: 131_072 }),
  /**
   * Remote model control from the owner's portal (src/model/remote-control/): "off" makes this host
   * view-only (its state is still shown; no command changes anything, admin model rollouts included).
   */
  AGENT_REMOTE_CONTROL: z.string().trim().regex(/^(on|off|1|0|true|false|yes|no)$/i, "on or off").optional(),
  /**
   * The desktop's bots on the owner's web portal (src/common/bot-relay.ts): "on" (default) publishes
   * them and takes the owner's commands, "view" publishes read-only, "off" publishes nothing.
   * AGENT_REMOTE_CONTROL=off also makes them read-only.
   */
  AGENT_BOT_RELAY: z.string().trim().regex(/^(on|off|view|1|0|true|false|yes|no)$/i, "on, view or off").optional(),
  /**
   * Coding sessions on this Mac driven from the owner's phone (src/common/code-relay.ts): "off"
   * (default) publishes nothing, "view" publishes projects and sessions only (no command), "on" also
   * takes the owner's commands. AGENT_REMOTE_CONTROL=off caps it at view. Set by the desktop app's
   * "Code from your phone" setting.
   */
  AGENT_CODE_RELAY: z.string().trim().regex(/^(on|off|view|1|0|true|false|yes|no)$/i, "on, view or off").optional(),
  /**
   * Web calls on this machine for its owner's own chats (src/web-tool/local-web.ts): searches on
   * the local SearXNG (SEARXNG_URL) and page reads from this machine's connection. "off" does none.
   */
  AGENT_LOCAL_WEB: z.string().trim().regex(/^(on|off|1|0|true|false|yes|no)$/i, "on or off").optional(),
  /**
   * The host's own SearXNG for its owner's web searches, loopback http only (the installer sets
   * http://127.0.0.1:18888 on Linux; src/install/searxng.ts). Unset: no local search.
   */
  SEARXNG_URL: z.string().trim().max(200).optional(),
  /**
   * Models a remote command (the owner's, or an operator rollout) may pull or select: comma-separated
   * Ollama tags. Unset = the curated catalog; `catalog` in the list adds it back; `none` allows nothing.
   */
  AGENT_MODEL_ALLOWLIST: z.string().trim().max(4000).optional(),
  /**
   * Share of physical RAM (10-90%) models may use on this host (src/swarm/memory-budget.ts); a
   * discrete GPU's models get 90% of its VRAM. Unset or out of range: 60.
   */
  AGENT_MEMORY_BUDGET_PCT: envNumber(undefined),
  /** Distinct models this host serves on the network at once (1-8). Unset: as many as fit the budget together. */
  AGENT_MAX_NETWORK_MODELS: envInt(undefined, { min: 1, max: 8 }),
  /** System memory pressure guard (src/swarm/memory-pressure.ts): on by default; "off" disables it. */
  AGENT_MEMORY_GUARD: envFlag({ off: ["off", "0", "false"], ci: true }),
  SANDBOX_REQUIRED: envFlag({ on: ["true"] }),
  // Pull and run inference subtasks only, without a sandbox (SANDBOX_MODE=none): for GPU container hosts that cannot run Docker.
  AGENT_INFERENCE_ONLY: envFlag({ on: ["1", "true"] }),
  // Security research tier: this agent may take restricted-model calls (its owner also needs an
  // admin-approved host entitlement; docs/security-research-tier.md). Off by default.
  AGENT_ALLOW_RESTRICTED_MODELS: envFlag({ on: ["1", "true"] }),
  SNAPSHOT_ENFORCEMENT: envEnumCi(["strict", "warn", "off"]),

  // ---- hardware profile and pricing ----
  AGENT_GPU_VENDOR: str(),
  AGENT_GPU_MODEL: str(),
  AGENT_GPU_VRAM_GB: amount(),
  AGENT_GPU_DATACENTER: envFlag({ on: ["1"] }),
  AGENT_BENCHMARK: envFlag({ off: ["0"] }),
  AGENT_BENCHMARK_INTERVAL_MS: amount(),
  /** Minimum price this agent works for; unset = follow the coordinator's reference price. */
  AGENT_ASK_MSAT_PER_CREDIT: amount(),

  // ---- peers and Bluetooth ----
  /** Work offered to direct peers, separated by "||". */
  PEER_DIRECT_WORK_ITEMS: str(),
  PEER_OFFER_COOLDOWN_MS: envNumber(20_000, { min: 0 }),
  EDGECODER_BLE: envFlag({ off: ["0"] }),
  BLE_TEST_ENABLED: envFlag({ on: ["true"] }),

  // ---- files and the local IDE provider the worker shares a token with (src/apps/ide/ide-auth.ts) ----
  EDGECODER_CONFIG_DIR: str(),
  EDGECODER_LOG_DIR: str(),
  IDE_PROVIDER_HOST: str(),
  IDE_PROVIDER_PORT: envPort(undefined),
  IDE_PROVIDER_TOKEN: str(),
  IDE_ALLOWED_ORIGINS: str()
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;
