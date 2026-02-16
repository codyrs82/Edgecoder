import { runCode } from "../executor/run.js";
import { Language, RunResult } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";

export interface AgentExecution {
  plan: string;
  generatedCode: string;
  runResult: RunResult;
}

export abstract class AgentBase {
  constructor(protected readonly provider: ModelProvider) {}

  protected async planTask(task: string): Promise<string> {
    const res = await this.provider.generate({
      prompt: `Create a short plan for this coding task:\n${task}`
    });
    return res.text;
  }

  protected async generateCode(task: string, language: Language): Promise<string> {
    const res = await this.provider.generate({
      prompt: `Write ${language} code for this task:\n${task}`
    });
    return res.text;
  }

  protected async execute(code: string, language: Language): Promise<RunResult> {
    return runCode(language, code);
  }
}
