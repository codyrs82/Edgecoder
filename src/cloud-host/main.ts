// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * `edgecoder cloud-host` (docs/cloud-host.md): the agent (src/swarm/worker-runner.ts) as a cloud
 * host. Sets the settings every cloud host needs, unless the environment already says otherwise,
 * then starts the agent:
 *   EDGECODER_ENGINE=cloud        the hosted-API backend (src/cloud-host/)
 *   SANDBOX_MODE=none, AGENT_INFERENCE_ONLY=1   model calls only, never task code
 *   LOCAL_MODEL_PROVIDER=ollama-local           serve network model calls
 *   AGENT_BENCHMARK=0, AGENT_REMOTE_CONTROL=off nothing local to measure or manage
 *   EDGECODER_BLE=0                             no Bluetooth mesh on a server
 * In the agent Docker image, also set SKIP_OLLAMA=true (the entrypoint then starts no Ollama).
 */

export const CLOUD_HOST_DEFAULTS: Record<string, string> = {
  EDGECODER_ENGINE: "cloud",
  SANDBOX_MODE: "none",
  AGENT_INFERENCE_ONLY: "1",
  LOCAL_MODEL_PROVIDER: "ollama-local",
  AGENT_BENCHMARK: "0",
  AGENT_REMOTE_CONTROL: "off",
  EDGECODER_BLE: "0"
};

/** The environment with the cloud-host defaults filled in (set values win, except the engine, which must be cloud). */
export function cloudHostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(CLOUD_HOST_DEFAULTS)) if (out[k] === undefined || out[k] === "") out[k] = v;
  out.EDGECODER_ENGINE = "cloud";
  return out;
}

const invokedDirectly = process.argv[1] && /cloud-host[\\/]main\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  const env = cloudHostEnv(process.env);
  for (const k of Object.keys(CLOUD_HOST_DEFAULTS)) process.env[k] = env[k];
  await import("../swarm/worker-runner.js");
}
