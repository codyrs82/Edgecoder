import { describe, expect, it } from "vitest";
import { planPrompt, codePrompt, reflectPrompt, decomposePrompt } from "../../src/model/prompts.js";

describe("prompt templates", () => {
  it("planPrompt includes the task", () => {
    const prompt = planPrompt("Add a login form");
    expect(prompt).toContain("Add a login form");
    expect(prompt).toContain("plan");
  });

  it("codePrompt includes task, plan, and language", () => {
    const prompt = codePrompt("Add login", "1. Create form\n2. Validate", "python");
    expect(prompt).toContain("python");
    expect(prompt).toContain("Add login");
    expect(prompt).toContain("Create form");
  });

  it("reflectPrompt includes code and error", () => {
    const prompt = reflectPrompt("fix bug", "print(x)", "NameError: x not defined");
    expect(prompt).toContain("print(x)");
    expect(prompt).toContain("NameError");
  });

  it("decomposePrompt requests JSON array", () => {
    const prompt = decomposePrompt("Build a REST API with auth and CRUD");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("Build a REST API");
  });
});
