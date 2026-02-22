import { runCode } from "../executor/run.js";
import { Language, RunResult, IterationRecord, AgentExecution } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";

export interface AgentOptions {
  maxIterations?: number;
}

export abstract class AgentBase {
  protected readonly maxIterations: number;

  constructor(
    protected readonly provider: ModelProvider,
    options?: AgentOptions
  ) {
    this.maxIterations = options?.maxIterations ?? 3;
  }

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

  protected async reflectOnFailure(
    task: string,
    code: string,
    runResult: RunResult
  ): Promise<string> {
    const res = await this.provider.generate({
      prompt: `This ${runResult.language} code failed.\nTask: ${task}\nCode:\n${code}\nError: ${runResult.stderr}\nExit code: ${runResult.exitCode}\nAnalyze the failure and write corrected code. Output ONLY the fixed code.`
    });
    return res.text;
  }

  protected async execute(code: string, language: Language): Promise<RunResult> {
    return runCode(language, code);
  }

  protected async runWithRetry(
    task: string,
    language: Language
  ): Promise<AgentExecution> {
    const history: IterationRecord[] = [];
    let plan = "";
    let generatedCode = "";
    let runResult: RunResult | undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      if (i === 0) {
        plan = await this.planTask(task);
        generatedCode = await this.generateCode(task, language);
      } else {
        generatedCode = await this.reflectOnFailure(task, generatedCode, runResult!);
        plan = `Retry ${i + 1}: fixing previous error`;
      }

      runResult = await this.execute(generatedCode, language);

      history.push({
        iteration: i + 1,
        plan,
        code: generatedCode,
        runResult
      });

      if (runResult.ok) {
        return {
          plan,
          generatedCode,
          runResult,
          iterations: i + 1,
          history,
          escalated: false
        };
      }

      if (runResult.queueForCloud) {
        return {
          plan,
          generatedCode,
          runResult,
          iterations: i + 1,
          history,
          escalated: true,
          escalationReason: runResult.queueReason ?? "outside_subset"
        };
      }
    }

    return {
      plan,
      generatedCode: generatedCode!,
      runResult: runResult!,
      iterations: this.maxIterations,
      history,
      escalated: true,
      escalationReason: "max_iterations_exhausted"
    };
  }
}
