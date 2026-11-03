// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { SandboxMode } from "../common/types.js";
import { isDockerAvailable } from "../executor/docker-sandbox.js";

export const SANDBOX_MODES: readonly SandboxMode[] = ["none", "docker", "vm"];

/**
 * Resolve SANDBOX_MODE from the environment to a value the coordinator accepts.
 * Default: "docker" for swarm-only agents, "none" otherwise. Any other value
 * (including the old docs' "process", which has no enforced isolation on Linux or
 * macOS) is treated as "none" with a warning: the node still registers and
 * heartbeats but contributes no swarm compute (#45), instead of failing
 * /register with a 500 forever.
 */
export function resolveSandboxMode(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = console.warn): SandboxMode {
  const raw = (env.SANDBOX_MODE ?? "").trim().toLowerCase();
  if (!raw) return (env.AGENT_MODE ?? "swarm-only") === "swarm-only" ? "docker" : "none";
  if ((SANDBOX_MODES as readonly string[]).includes(raw)) return raw as SandboxMode;
  warn(
    `[sandbox] SANDBOX_MODE=${env.SANDBOX_MODE} is not supported (valid: ${SANDBOX_MODES.join(", ")}); ` +
      `running as SANDBOX_MODE=none — this node will not pull swarm tasks. Install Docker and set SANDBOX_MODE=docker to contribute compute.`
  );
  return "none";
}

/**
 * Enforce sandbox policy before executing code. Returns an error message if
 * execution should be blocked, or null if execution is allowed.
 */
export async function enforceSandboxPolicy(
  sandboxMode: SandboxMode,
  sandboxRequired: boolean
): Promise<string | null> {
  if (sandboxRequired && sandboxMode === "none") {
    return "sandbox_required: SANDBOX_REQUIRED=true but SANDBOX_MODE=none — refusing to execute without sandbox";
  }
  if (sandboxMode === "docker") {
    const available = await isDockerAvailable();
    if (!available) {
      return "sandbox_unavailable: SANDBOX_MODE=docker but Docker daemon is not running";
    }
  }
  return null;
}

/**
 * #45: a node with SANDBOX_MODE=none contributes no swarm compute — it never
 * pulls coordinator tasks and never executes mesh/BLE/peer-direct code.
 */
export function swarmExecutionEnabled(sandboxMode: SandboxMode): boolean {
  return sandboxMode !== "none";
}

/**
 * #45: coordinator /pull gate, evaluated BEFORE queue.claim() so a task is
 * never claimed (and requeued) for an agent without a sandbox.
 */
export function pullSandboxRejection(
  capability: { sandboxMode?: SandboxMode } | undefined
): { subtask: null; sandboxRequired: true; reason: "agent_lacks_sandbox_capability" } | null {
  const mode: SandboxMode = capability?.sandboxMode ?? "none";
  if (mode === "none") return { subtask: null, sandboxRequired: true, reason: "agent_lacks_sandbox_capability" };
  return null;
}
