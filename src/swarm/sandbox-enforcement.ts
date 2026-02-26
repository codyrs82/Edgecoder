// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { SandboxMode } from "../common/types.js";
import { isDockerAvailable } from "../executor/docker-sandbox.js";

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
