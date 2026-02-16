import { AgentBase } from "./base.js";
import { Language, Subtask, SubtaskResult } from "../common/types.js";

export class SwarmWorkerAgent extends AgentBase {
  async runSubtask(subtask: Subtask, agentId: string): Promise<SubtaskResult> {
    const language: Language = subtask.language;
    const code = await this.generateCode(subtask.input, language);
    const result = await this.execute(code, language);

    return {
      subtaskId: subtask.id,
      taskId: subtask.taskId,
      agentId,
      ok: result.ok,
      output: result.stdout,
      error: result.stderr || undefined,
      durationMs: result.durationMs
    };
  }
}
