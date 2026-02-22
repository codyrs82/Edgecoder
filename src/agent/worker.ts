import { AgentBase, AgentOptions } from "./base.js";
import { Language, Subtask, SubtaskResult } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";

export class SwarmWorkerAgent extends AgentBase {
  constructor(provider: ModelProvider, options?: AgentOptions) {
    super(provider, { maxIterations: 2, sandbox: "docker", ...options });
  }

  async runSubtask(subtask: Subtask, agentId: string): Promise<SubtaskResult> {
    const language: Language = subtask.language;
    const execution = await this.runWithRetry(subtask.input, language);

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
