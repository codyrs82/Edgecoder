// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { AgentBase, AgentOptions } from "./base.js";
import { Language, Subtask, SubtaskResult } from "../common/types.js";
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
        durationMs: Date.now() - started
      };
    }

    return {
      subtaskId: subtask.id,
      taskId: subtask.taskId,
      agentId,
      ok: execution.runResult.ok,
      output: execution.runResult.stdout,
      error: execution.runResult.stderr || undefined,
      durationMs: execution.runResult.durationMs
    };
  }
}
