import { describe, expect, it } from "vitest";
import { InteractiveAgent } from "../../src/agent/interactive.js";
import { EdgeCoderLocalProvider } from "../../src/model/providers.js";
import type { ModelProvider } from "../../src/model/providers.js";
import {
  parseOpenAiRequest,
  formatOpenAiResponse,
  formatOpenAiModelsResponse
} from "../../src/apps/ide/openai-compat.js";
import type { EscalationRequest } from "../../src/escalation/types.js";
import { sanitizeEscalation } from "../../src/escalation/client.js";
import { validatePythonAst } from "../../src/executor/ast-python.js";
import { validateJavaScriptAst } from "../../src/executor/ast-javascript.js";

describe("end-to-end: full agent loop", () => {
  it("completes a simple python task through the full loop", async () => {
    const provider = new EdgeCoderLocalProvider();
    const agent = new InteractiveAgent(provider);
    const result = await agent.run("Print the numbers 1 to 5", "python");

    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.history.length).toBeGreaterThanOrEqual(1);
    expect(typeof result.plan).toBe("string");
    expect(typeof result.generatedCode).toBe("string");
    expect(typeof result.escalated).toBe("boolean");
  });

  it("completes a simple javascript task through the full loop", async () => {
    const provider = new EdgeCoderLocalProvider();
    const agent = new InteractiveAgent(provider);
    const result = await agent.run("Log hello world", "javascript");

    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.history.length).toBeGreaterThanOrEqual(1);
  });

  it("OpenAI compat parses and formats correctly for a coding task", () => {
    const parsed = parseOpenAiRequest({
      model: "edgecoder-local",
      messages: [
        { role: "user", content: "Write a function that adds two numbers in python" }
      ]
    });
    expect(parsed.task).toContain("adds two numbers");

    const response = formatOpenAiResponse("req-123", "edgecoder-local", "def add(a, b): return a + b");
    expect(response.choices[0].message.content).toContain("def add");
    expect(response.choices[0].finish_reason).toBe("stop");
  });

  it("model list endpoint works for OpenAI compat", () => {
    const models = formatOpenAiModelsResponse(["edgecoder-local", "ollama-edge", "ollama-coordinator"]);
    expect(models.data.length).toBe(3);
    expect(models.data.map((m) => m.id)).toContain("ollama-edge");
  });

  it("escalation pipeline sanitizes and structures correctly", () => {
    const req: EscalationRequest = {
      taskId: "e2e-task-1",
      agentId: "test-agent",
      task: "Build auth with AKIAIOSFODNN7EXAMPLE key",
      failedCode: "import os\nprint('broken')",
      errorHistory: ["NameError: undefined"],
      language: "python",
      iterationsAttempted: 3
    };

    const sanitized = sanitizeEscalation(req);
    expect(sanitized.task).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sanitized.task).toContain("[REDACTED]");
    expect(sanitized.taskId).toBe("e2e-task-1");
  });

  it("AST sandbox validates safe python code", async () => {
    const result = await validatePythonAst(
      "def greet(name):\n    return f'Hello, {name}!'\nprint(greet('world'))"
    );
    expect(result.safe).toBe(true);
  });

  it("AST sandbox blocks unsafe python code", async () => {
    const result = await validatePythonAst("import subprocess\nsubprocess.run(['ls'])");
    expect(result.safe).toBe(false);
  });

  it("AST sandbox validates safe javascript code", () => {
    const result = validateJavaScriptAst(
      "const greet = (name) => `Hello, ${name}!`;\nconsole.log(greet('world'));"
    );
    expect(result.safe).toBe(true);
  });

  it("AST sandbox blocks unsafe javascript code", () => {
    const result = validateJavaScriptAst("const fs = require('fs');");
    expect(result.safe).toBe(false);
  });

  it("retry loop escalates after max failures", async () => {
    // Use syntactically valid but runtime-failing code so it passes the AST
    // subset check (no queueForCloud) but still fails execution every time.
    const failingProvider: ModelProvider = {
      kind: "edgecoder-local" as const,
      async generate() {
        return { text: "x = 1 / 0", provider: "edgecoder-local" as const };
      },
      async health() { return true; }
    };
    const agent = new InteractiveAgent(failingProvider, { maxIterations: 2 });
    const result = await agent.run("impossible task", "python");

    expect(result.escalated).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.history.length).toBe(2);
  });
});
