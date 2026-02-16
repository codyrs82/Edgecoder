import { AgentBase, AgentExecution } from "./base.js";
import { Language } from "../common/types.js";

export class InteractiveAgent extends AgentBase {
  async run(task: string, language: Language): Promise<AgentExecution> {
    const plan = await this.planTask(task);
    const generatedCode = await this.generateCode(task, language);
    const runResult = await this.execute(generatedCode, language);
    return { plan, generatedCode, runResult };
  }
}
