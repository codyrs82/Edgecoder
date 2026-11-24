// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { ToolRunnerDeps } from "./agent-loop.js";
import type { ToolName } from "./tool-types.js";

/**
 * Shows a tool call's result (a command's output, or the result or error) and gives the text for
 * the model; `denied`: what the sandbox blocked when a sandboxed command failed (sandbox.ts).
 */
export function reportToolResult(d: Pick<ToolRunnerDeps, "sendEvent" | "shellHint">, callId: string, tool: ToolName, args: Record<string, unknown>, result: { result?: string; error?: string }): { text: string; denied: string | null } {
  let hint: string | null = null;
  let denied: string | null = null;
  if (tool === "run_shell" && result.result) {
    try {
      const shell = JSON.parse(result.result) as { stdout: string; stderr: string; exit_code: number; sandboxed?: boolean; sandbox_denied?: string };
      denied = typeof shell.sandbox_denied === "string" ? shell.sandbox_denied : null;
      d.sendEvent({ type: "shell_output", id: callId, stdout: shell.stdout, stderr: shell.stderr, exit_code: shell.exit_code, ...(shell.sandboxed ? { sandboxed: true as const } : {}), ...(denied ? { sandbox_denied: denied } : {}) });
      if (d.shellHint) {
        try {
          hint = d.shellHint(String(args.command ?? ""), `${shell.stdout ?? ""}\n${shell.stderr ?? ""}`);
        } catch {
          hint = null;
        }
      }
    } catch {
      d.sendEvent({ type: "tool_result", id: callId, result: result.result, error: result.error });
    }
  } else {
    d.sendEvent({ type: "tool_result", id: callId, result: result.result, error: result.error });
  }
  if (result.error) return { text: `[Error]: ${result.error}`, denied };
  const text = result.result ?? "(no output)";
  return { text: hint ? `${text}\n\n${hint}` : text, denied };
}
