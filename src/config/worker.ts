// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envEnum, envEnumCi, envFlag, envFlagWord, envInt, envNumber, envPort, envUrl } from "../common/config.js";
import { computeClassEnv, discoveryEnv, modelEnv, releaseEnv, sandboxEnv, serviceUrlsEnv, trustEnv } from "./shared.js";

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
  NODE_ENV: str(),
  HOST: str(),

  // ---- identity and mode ----
  /** Default: worker-<hostname>. */
  AGENT_ID: str(),
  AGENT_MODE: envEnum(["swarm-only", "ide-enabled"]).default("swarm-only"),
  // A free string: installers write values such as "linux" here and the worker only reports it.
  AGENT_OS: str(),
  AGENT_CLIENT_TYPE: z.string().default("edgecoder-native"),
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
  /** Loopback port for the IDE's swarm forwarder; unset or 0 = off. */
  LOCAL_FORWARD_PORT: envPort(undefined),

  // ---- model and execution ----
  LOCAL_MODEL_PROVIDER: envEnum(["edgecoder-local", "ollama-local"]).default("edgecoder-local"),
  OLLAMA_MODEL: z.string().default("qwen3.5:9b"),
  OLLAMA_AUTO_INSTALL: envFlag({ on: ["true"] }),
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
  SANDBOX_REQUIRED: envFlag({ on: ["true"] }),
  // Pull and run inference subtasks only, without a sandbox (SANDBOX_MODE=none): for GPU container hosts that cannot run Docker.
  AGENT_INFERENCE_ONLY: envFlag({ on: ["1", "true"] }),
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
