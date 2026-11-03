import { describe, expect, it } from "vitest";
import { buildIdeAgentSystemPrompt } from "../../src/model/system-prompt.js";

// Small local models copy a concrete example plan word for word and, given a plan format, write
// plans instead of calling tools. Native-tool prompts carry no plan format; text-mode ones use
// placeholders.
const ctx = {
  activeModel: "qwen2.5-coder:7b",
  activeModelParamSize: 7,
  installedModels: [],
  swarmModels: [],
  ollamaHealthy: true,
  queueDepth: 0,
  connectedAgents: 0,
};
const prompt = (toolFormat: "native" | "text") => buildIdeAgentSystemPrompt(ctx, "/p", "", toolFormat);

describe("IDE agent system prompt", () => {
  it("has no example task text a model could copy", () => {
    for (const f of ["native", "text"] as const) {
      expect(prompt(f)).not.toContain("Edit the function to fix the bug");
    }
  });
  it("asks native-tool models to act, without a text plan format", () => {
    expect(prompt("native")).not.toContain("## Plan Format");
    expect(prompt("native")).toContain("Act, don't narrate");
  });
  it("keeps the plan format for text-mode tools", () => {
    expect(prompt("text")).toContain("## Plan Format");
  });
});
