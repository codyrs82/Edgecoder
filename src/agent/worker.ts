// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { AgentBase, AgentOptions } from "./base.js";
import { Language, ProgramErrorReason, RunResult, Subtask, SubtaskResult } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";

export class SwarmWorkerAgent extends AgentBase {
  constructor(provider: ModelProvider, options?: AgentOptions) {
    super(provider, { maxIterations: 2, sandbox: "docker", ...options });
  }

  async runSubtask(subtask: Subtask, agentId: string): Promise<SubtaskResult> {
    const language: Language = subtask.language;
    const started = Date.now();
    let execution: Awaited<ReturnType<typeof this.runWithRetry>>;
    try {
      execution = await this.runWithRetry(subtask.input, language);
    } catch (err) {
      // Model unavailable or no code produced: a failed result the requester can see.
      return {
        subtaskId: subtask.id,
        taskId: subtask.taskId,
        agentId,
        ok: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        executed: false
      };
    }

    const run = execution.runResult;
    return {
      subtaskId: subtask.id,
      taskId: subtask.taskId,
      agentId,
      ok: run.ok,
      output: run.stdout,
      error: run.stderr || undefined,
      durationMs: run.durationMs,
      ...executionOutcome(run)
    };
  }
}

/**
 * What the coordinator needs to tell a failed program from a failed agent (SubtaskResult.executed):
 * a buyer decides what its program does, so a program that ran and exited non-zero must not count
 * against the worker that ran it.
 */
export function executionOutcome(run: RunResult): Pick<SubtaskResult, "executed" | "exitCode" | "programError"> {
  if (run.ok) return { executed: true, exitCode: run.exitCode };
  // The sandbox policy refused the generated code: the job asked for something outside the subset.
  if (run.queueReason === "outside_subset") return { executed: true, programError: "outside_subset" };
  if (!run.executed) return { executed: false };
  const programError: ProgramErrorReason =
    run.queueReason === "timeout" ? "timeout" : run.exitCode === 137 && /output exceeded/.test(run.stderr) ? "output_limit" : "exit_nonzero";
  return { executed: true, exitCode: run.exitCode === 0 ? 1 : run.exitCode, programError };
}
