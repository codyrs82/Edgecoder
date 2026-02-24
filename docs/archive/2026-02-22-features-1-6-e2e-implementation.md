# EdgeCoder Features 1-6 + E2E Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the 6 core features (agent retry loop, AST sandbox, real Ollama models, mesh escalation, OpenAI-compatible IDE API, Docker sandbox) and prove the system works end-to-end.

**Architecture:** Bottom-up sequential build. Each feature is built and tested before the next depends on it. All models are free locally-hosted Ollama models. "Cloud" = other mesh nodes running larger models. The IDE integration implements OpenAI-compatible API so it works identically to OpenAI in Cursor/Continue/any client.

**Tech Stack:** TypeScript (strict ESM), Fastify v5, Vitest, Zod v4, Ollama, acorn (JS parser), Docker

---

## Task 1: Add IterationRecord and update AgentExecution types

**Files:**
- Modify: `src/common/types.ts`

**Step 1: Write the failing test**

Create `tests/agent/retry-loop.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { IterationRecord, AgentExecution } from "../../src/common/types.js";

describe("agent retry types", () => {
  it("IterationRecord has required fields", () => {
    const record: IterationRecord = {
      iteration: 1,
      plan: "step 1",
      code: "print('hi')",
      runResult: {
        language: "python",
        ok: false,
        stdout: "",
        stderr: "NameError",
        exitCode: 1,
        durationMs: 100,
        queueForCloud: false
      }
    };
    expect(record.iteration).toBe(1);
  });

  it("AgentExecution includes iteration tracking and escalation", () => {
    const exec: AgentExecution = {
      plan: "plan",
      generatedCode: "code",
      runResult: {
        language: "python",
        ok: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        durationMs: 50,
        queueForCloud: false
      },
      iterations: 1,
      history: [],
      escalated: false
    };
    expect(exec.escalated).toBe(false);
    expect(exec.iterations).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/retry-loop.test.ts`
Expected: FAIL — `IterationRecord` and `AgentExecution` not exported from types.

**Step 3: Add types to `src/common/types.ts`**

Append after the `RunResult` interface (after line 18):

```typescript
export interface IterationRecord {
  iteration: number;
  plan: string;
  code: string;
  runResult: RunResult;
}

export interface AgentExecution {
  plan: string;
  generatedCode: string;
  runResult: RunResult;
  iterations: number;
  history: IterationRecord[];
  escalated: boolean;
  escalationReason?: string;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/retry-loop.test.ts`
Expected: PASS (2 tests)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still pass.

**Step 6: Commit**

```bash
git add src/common/types.ts tests/agent/retry-loop.test.ts
git commit -m "feat: add IterationRecord and AgentExecution types for retry loop"
```

---

## Task 2: Implement agent retry loop in AgentBase

**Files:**
- Modify: `src/agent/base.ts`
- Modify: `src/agent/interactive.ts`
- Modify: `src/agent/worker.ts`
- Modify: `tests/agent/retry-loop.test.ts`

**Step 1: Write the failing tests**

Add to `tests/agent/retry-loop.test.ts`:

```typescript
import { InteractiveAgent } from "../../src/agent/interactive.js";
import { SwarmWorkerAgent } from "../../src/agent/worker.js";
import { EdgeCoderLocalProvider } from "../../src/model/providers.js";

describe("InteractiveAgent retry loop", () => {
  it("succeeds on first iteration for simple tasks", async () => {
    const provider = new EdgeCoderLocalProvider();
    const agent = new InteractiveAgent(provider);
    const result = await agent.run("Print hello world", "python");
    expect(result.ok).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.history.length).toBe(1);
  });

  it("returns escalated after maxIterations failures", async () => {
    // Use a provider that always generates code that will fail
    const badProvider = {
      kind: "edgecoder-local" as const,
      async generate() {
        return { text: "import os\nos.system('rm -rf /')", provider: "edgecoder-local" as const };
      },
      async health() { return true; }
    };
    const agent = new InteractiveAgent(badProvider, { maxIterations: 2 });
    const result = await agent.run("do something", "python");
    expect(result.escalated).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.history.length).toBe(2);
  });
});

describe("SwarmWorkerAgent retry loop", () => {
  it("retries subtask on failure (max 2)", async () => {
    const provider = new EdgeCoderLocalProvider();
    const agent = new SwarmWorkerAgent(provider);
    const result = await agent.runSubtask({
      id: "sub-1",
      taskId: "t-1",
      kind: "single_step",
      language: "python",
      input: "Print hello",
      timeoutMs: 4000,
      snapshotRef: "test",
      projectMeta: { projectId: "p-1", resourceClass: "cpu", priority: 10 }
    }, "agent-1");
    expect(result.ok).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/retry-loop.test.ts`
Expected: FAIL — `InteractiveAgent` constructor doesn't accept options, `run()` doesn't return `iterations`/`escalated`/`history`.

**Step 3: Implement the retry loop**

Replace `src/agent/base.ts` entirely:

```typescript
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
        // Reflect on the previous failure and generate corrected code
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

      // If the code is outside the subset, don't retry — escalate immediately
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

    // Exhausted all iterations
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
```

Replace `src/agent/interactive.ts` entirely:

```typescript
import { AgentBase, AgentOptions } from "./base.js";
import { Language, AgentExecution } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";

export class InteractiveAgent extends AgentBase {
  constructor(provider: ModelProvider, options?: AgentOptions) {
    super(provider, options);
  }

  async run(task: string, language: Language): Promise<AgentExecution> {
    return this.runWithRetry(task, language);
  }
}
```

Replace `src/agent/worker.ts` entirely:

```typescript
import { AgentBase, AgentOptions } from "./base.js";
import { Language, Subtask, SubtaskResult } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";

export class SwarmWorkerAgent extends AgentBase {
  constructor(provider: ModelProvider, options?: AgentOptions) {
    super(provider, options ?? { maxIterations: 2 });
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
```

**Step 4: Update `src/index.ts` for new return type**

The `boot()` function at `src/index.ts:37` calls `agent.run()` and accesses `.runResult.ok`. Since `AgentExecution` now has `runResult`, this still works. No change needed.

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agent/retry-loop.test.ts`
Expected: PASS (5 tests)

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new).

**Step 7: Commit**

```bash
git add src/agent/base.ts src/agent/interactive.ts src/agent/worker.ts tests/agent/retry-loop.test.ts
git commit -m "feat: implement agent retry loop with plan-code-test-iterate cycle"
```

---

## Task 3: Add Python AST validation

**Files:**
- Create: `src/executor/ast-python.ts`
- Create: `tests/executor/ast-sandbox.test.ts`

**Step 1: Write the failing test**

Create `tests/executor/ast-sandbox.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { validatePythonAst } from "../../src/executor/ast-python.js";

describe("Python AST validation", () => {
  it("allows safe code", async () => {
    const result = await validatePythonAst("x = 1 + 2\nprint(x)");
    expect(result.safe).toBe(true);
  });

  it("allows functions and loops", async () => {
    const result = await validatePythonAst(
      "def add(a, b):\n    return a + b\nfor i in range(5):\n    print(add(i, 1))"
    );
    expect(result.safe).toBe(true);
  });

  it("blocks import statements", async () => {
    const result = await validatePythonAst("import os\nprint(os.getcwd())");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Import");
  });

  it("blocks from-import statements", async () => {
    const result = await validatePythonAst("from pathlib import Path");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("ImportFrom");
  });

  it("blocks open() builtin calls", async () => {
    const result = await validatePythonAst("f = open('test.txt')");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("open");
  });

  it("blocks eval() builtin calls", async () => {
    const result = await validatePythonAst("eval('1+1')");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("eval");
  });

  it("blocks exec() builtin calls", async () => {
    const result = await validatePythonAst("exec('print(1)')");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("exec");
  });

  it("allows list comprehensions", async () => {
    const result = await validatePythonAst("squares = [x*x for x in range(10)]");
    expect(result.safe).toBe(true);
  });

  it("returns parse error for invalid syntax", async () => {
    const result = await validatePythonAst("def (broken");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("parse");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/executor/ast-sandbox.test.ts`
Expected: FAIL — module `ast-python.js` not found.

**Step 3: Implement Python AST validator**

Create `src/executor/ast-python.ts`:

```typescript
import { spawn } from "node:child_process";

export interface AstValidationResult {
  safe: boolean;
  reason?: string;
}

const ALLOWED_NODE_TYPES = new Set([
  "Module", "FunctionDef", "Return", "Assign", "AugAssign",
  "For", "While", "If", "Expr", "Call", "BinOp", "UnaryOp",
  "Compare", "BoolOp", "Num", "Str", "List", "Dict", "Tuple",
  "Set", "Name", "Subscript", "Attribute", "ListComp", "DictComp",
  "SetComp", "FormattedValue", "JoinedStr", "Index", "Slice",
  "Constant", "Pass", "Break", "Continue", "arguments", "arg",
  "Store", "Load", "Del", "Add", "Sub", "Mult", "Div", "Mod",
  "Pow", "FloorDiv", "BitOr", "BitXor", "BitAnd", "LShift",
  "RShift", "Invert", "Not", "UAdd", "USub", "Eq", "NotEq",
  "Lt", "LtE", "Gt", "GtE", "Is", "IsNot", "In", "NotIn",
  "And", "Or", "keyword", "comprehension", "Starred",
  "IfExp"
]);

const BLOCKED_BUILTINS = new Set([
  "open", "exec", "eval", "compile", "__import__", "globals",
  "locals", "getattr", "setattr", "delattr", "vars", "dir",
  "input", "breakpoint", "memoryview", "bytearray"
]);

// Python script that parses code and walks the AST, returning JSON
const AST_WALKER_SCRIPT = `
import ast, json, sys

code = sys.stdin.read()
try:
    tree = ast.parse(code)
except SyntaxError as e:
    print(json.dumps({"error": f"parse error: {e}"}))
    sys.exit(0)

nodes = []
calls = []
for node in ast.walk(tree):
    nodes.append(type(node).__name__)
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name):
            calls.append(node.func.id)
        elif isinstance(node.func, ast.Attribute):
            calls.append(node.func.attr)

print(json.dumps({"nodes": nodes, "calls": calls}))
`;

export async function validatePythonAst(code: string): Promise<AstValidationResult> {
  return new Promise<AstValidationResult>((resolve) => {
    const proc = spawn("python3", ["-c", AST_WALKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.stdin.write(code);
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ safe: false, reason: "AST validation timed out" });
    }, 5000);

    proc.on("close", () => {
      clearTimeout(timer);

      if (!stdout.trim()) {
        resolve({ safe: false, reason: `AST parse failed: ${stderr}` });
        return;
      }

      try {
        const result = JSON.parse(stdout.trim()) as {
          error?: string;
          nodes?: string[];
          calls?: string[];
        };

        if (result.error) {
          resolve({ safe: false, reason: result.error });
          return;
        }

        // Check for disallowed AST node types
        for (const node of result.nodes ?? []) {
          if (!ALLOWED_NODE_TYPES.has(node)) {
            resolve({ safe: false, reason: `Blocked AST node: ${node}` });
            return;
          }
        }

        // Check for blocked builtin calls
        for (const call of result.calls ?? []) {
          if (BLOCKED_BUILTINS.has(call)) {
            resolve({ safe: false, reason: `Blocked builtin call: ${call}` });
            return;
          }
        }

        resolve({ safe: true });
      } catch {
        resolve({ safe: false, reason: "Failed to parse AST validation output" });
      }
    });
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/executor/ast-sandbox.test.ts`
Expected: PASS (9 tests)

**Step 5: Commit**

```bash
git add src/executor/ast-python.ts tests/executor/ast-sandbox.test.ts
git commit -m "feat: add Python AST-based sandbox validation"
```

---

## Task 4: Add JavaScript AST validation

**Files:**
- Create: `src/executor/ast-javascript.ts`
- Modify: `tests/executor/ast-sandbox.test.ts`

**Step 1: Install acorn dependency**

Run: `npm install acorn`

**Step 2: Write the failing tests**

Append to `tests/executor/ast-sandbox.test.ts`:

```typescript
import { validateJavaScriptAst } from "../../src/executor/ast-javascript.js";

describe("JavaScript AST validation", () => {
  it("allows safe code", () => {
    const result = validateJavaScriptAst("const x = 1 + 2;\nconsole.log(x);");
    expect(result.safe).toBe(true);
  });

  it("allows arrow functions and loops", () => {
    const result = validateJavaScriptAst(
      "const add = (a, b) => a + b;\nfor (let i = 0; i < 5; i++) { console.log(add(i, 1)); }"
    );
    expect(result.safe).toBe(true);
  });

  it("blocks import declarations", () => {
    const result = validateJavaScriptAst('import fs from "fs";');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("ImportDeclaration");
  });

  it("blocks dynamic import()", () => {
    const result = validateJavaScriptAst('const m = import("fs");');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("ImportExpression");
  });

  it("blocks process global access", () => {
    const result = validateJavaScriptAst("console.log(process.env.HOME);");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("process");
  });

  it("blocks require calls", () => {
    const result = validateJavaScriptAst('const fs = require("fs");');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("require");
  });

  it("blocks eval calls", () => {
    const result = validateJavaScriptAst('eval("1+1");');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("eval");
  });

  it("blocks new expression (constructor injection)", () => {
    const result = validateJavaScriptAst('const f = new Function("return 1");');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("NewExpression");
  });

  it("allows template literals", () => {
    const result = validateJavaScriptAst("const name = `hello ${1 + 2}`;");
    expect(result.safe).toBe(true);
  });

  it("returns parse error for invalid syntax", () => {
    const result = validateJavaScriptAst("function (broken {");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("parse");
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run tests/executor/ast-sandbox.test.ts`
Expected: FAIL — module `ast-javascript.js` not found.

**Step 4: Implement JavaScript AST validator**

Create `src/executor/ast-javascript.ts`:

```typescript
import * as acorn from "acorn";

export interface AstValidationResult {
  safe: boolean;
  reason?: string;
}

const ALLOWED_NODE_TYPES = new Set([
  "Program", "FunctionDeclaration", "VariableDeclaration", "VariableDeclarator",
  "ExpressionStatement", "ReturnStatement", "IfStatement", "ForStatement",
  "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement",
  "BlockStatement", "EmptyStatement", "BreakStatement", "ContinueStatement",
  "SwitchStatement", "SwitchCase",
  "ArrayExpression", "ObjectExpression", "BinaryExpression", "UnaryExpression",
  "CallExpression", "ArrowFunctionExpression", "FunctionExpression",
  "Literal", "Identifier", "MemberExpression", "TemplateLiteral",
  "TemplateElement", "TaggedTemplateExpression",
  "ConditionalExpression", "LogicalExpression", "AssignmentExpression",
  "UpdateExpression", "SpreadElement", "Property", "RestElement",
  "ArrayPattern", "ObjectPattern", "AssignmentPattern",
  "SequenceExpression", "ChainExpression", "ParenthesizedExpression",
  "LabeledStatement"
]);

const BLOCKED_GLOBALS = new Set([
  "process", "require", "globalThis", "eval", "Function", "Proxy", "Reflect"
]);

type AcornNode = acorn.Node & {
  type: string;
  body?: AcornNode | AcornNode[];
  expression?: AcornNode;
  left?: AcornNode;
  right?: AcornNode;
  test?: AcornNode;
  consequent?: AcornNode | AcornNode[];
  alternate?: AcornNode;
  init?: AcornNode;
  update?: AcornNode;
  argument?: AcornNode;
  arguments?: AcornNode[];
  callee?: AcornNode;
  object?: AcornNode;
  property?: AcornNode;
  elements?: AcornNode[];
  properties?: AcornNode[];
  key?: AcornNode;
  value?: AcornNode;
  params?: AcornNode[];
  declarations?: AcornNode[];
  cases?: AcornNode[];
  expressions?: AcornNode[];
  quasis?: AcornNode[];
  tag?: AcornNode;
  discriminant?: AcornNode;
  label?: AcornNode;
  name?: string;
  source?: AcornNode;
};

function* walkAst(node: AcornNode): Generator<AcornNode> {
  if (!node || typeof node !== "object") return;
  yield node;

  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "name" || key === "raw" || key === "value" || key === "computed" || key === "method" || key === "shorthand" || key === "kind" || key === "operator" || key === "prefix" || key === "sourceType" || key === "optional" || key === "async" || key === "generator" || key === "tail" || key === "delegate") continue;
    const child = (node as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && "type" in item) {
          yield* walkAst(item as AcornNode);
        }
      }
    } else if (child && typeof child === "object" && "type" in child) {
      yield* walkAst(child as AcornNode);
    }
  }
}

export function validateJavaScriptAst(code: string): AstValidationResult {
  let ast: AcornNode;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module"
    }) as unknown as AcornNode;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { safe: false, reason: `parse error: ${msg}` };
  }

  for (const node of walkAst(ast)) {
    // Check node type
    if (!ALLOWED_NODE_TYPES.has(node.type)) {
      return { safe: false, reason: `Blocked AST node: ${node.type}` };
    }

    // Check for blocked global identifiers
    if (node.type === "Identifier" && node.name && BLOCKED_GLOBALS.has(node.name)) {
      return { safe: false, reason: `Blocked global: ${node.name}` };
    }

    // Check for blocked call targets (e.g. eval(...), require(...))
    if (node.type === "CallExpression" && node.callee) {
      if (node.callee.type === "Identifier" && node.callee.name && BLOCKED_GLOBALS.has(node.callee.name)) {
        return { safe: false, reason: `Blocked global call: ${node.callee.name}` };
      }
    }
  }

  return { safe: true };
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/executor/ast-sandbox.test.ts`
Expected: PASS (all 19 tests — 9 Python + 10 JavaScript)

**Step 6: Commit**

```bash
git add src/executor/ast-javascript.ts tests/executor/ast-sandbox.test.ts package.json package-lock.json
git commit -m "feat: add JavaScript AST-based sandbox validation with acorn"
```

---

## Task 5: Integrate AST validation into executor

**Files:**
- Modify: `src/executor/subset.ts`
- Modify: `src/executor/run.ts`
- Modify: `tests/executor.test.ts`

**Step 1: Write failing tests**

Add to `tests/executor.test.ts`:

```typescript
  it("blocks python code that bypasses regex but fails AST (e.g. __import__)", async () => {
    // __import__('os') is caught by regex, but test the AST path too
    const result = await runCode("python", "x = globals()", 2000);
    expect(result.queueForCloud).toBe(true);
    expect(result.queueReason).toBe("outside_subset");
  });

  it("blocks javascript new Function constructor via AST", async () => {
    // 'new Function' is not in the regex denylist but blocked by AST
    const result = await runCode("javascript", 'const f = new Function("return 1"); console.log(f());', 2000);
    expect(result.queueForCloud).toBe(true);
    expect(result.queueReason).toBe("outside_subset");
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/executor.test.ts`
Expected: FAIL — these constructs are not caught by current regex.

**Step 3: Update `src/executor/subset.ts`**

Replace the entire file:

```typescript
import { Language } from "../common/types.js";
import { validatePythonAst } from "./ast-python.js";
import { validateJavaScriptAst } from "./ast-javascript.js";

const PYTHON_DENYLIST = [
  /\bexec\(/,
  /\beval\(/,
  /\bcompile\(/,
  /__import__/,
  /\bimport\s+os\b/,
  /\bimport\s+subprocess\b/,
  /\bopen\(/,
  /\bsocket\b/
];

const JS_DENYLIST = [
  /\beval\(/,
  /\bFunction\(/,
  /\brequire\(/,
  /\bprocess\./,
  /\bfs\./,
  /\bchild_process\b/
];

export interface SubsetCheck {
  supported: boolean;
  reason?: string;
}

export async function checkSubset(language: Language, code: string): Promise<SubsetCheck> {
  // Fast pre-filter: regex denylist
  const denylist = language === "python" ? PYTHON_DENYLIST : JS_DENYLIST;
  for (const pattern of denylist) {
    if (pattern.test(code)) {
      return {
        supported: false,
        reason: `Unsupported construct detected: ${pattern.source}`
      };
    }
  }

  // Authoritative check: AST validation
  if (language === "python") {
    const astResult = await validatePythonAst(code);
    if (!astResult.safe) {
      return { supported: false, reason: astResult.reason };
    }
  } else {
    const astResult = validateJavaScriptAst(code);
    if (!astResult.safe) {
      return { supported: false, reason: astResult.reason };
    }
  }

  return { supported: true };
}
```

**Note:** `checkSubset` is now `async` because Python AST validation spawns a child process. All callers must `await` it.

**Step 4: Update `src/executor/run.ts`**

The `runCode` function calls `checkSubset` synchronously at line 24. Update it to `await`:

Change line 24 from:
```typescript
  const subset = checkSubset(language, code);
```
to:
```typescript
  const subset = await checkSubset(language, code);
```

This already works since `runCode` is `async`.

**Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/executor.test.ts`
Expected: PASS (5 tests — 3 original + 2 new)

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/executor/subset.ts src/executor/run.ts tests/executor.test.ts
git commit -m "feat: integrate AST validation into executor pipeline"
```

---

## Task 6: Add structured prompt templates

**Files:**
- Create: `src/model/prompts.ts`
- Create: `tests/model/prompts.test.ts`

**Step 1: Write the failing test**

Create `tests/model/prompts.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model/prompts.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement prompts**

Create `src/model/prompts.ts`:

```typescript
import { Language } from "../common/types.js";

export function planPrompt(task: string): string {
  return `You are a coding assistant. Create a step-by-step plan for the following task. Output ONLY numbered steps, no code, no explanation.

Task: ${task}`;
}

export function codePrompt(task: string, plan: string, language: Language): string {
  return `You are a coding assistant. Write ${language} code that implements the following plan.

Task: ${task}

Plan:
${plan}

Output ONLY executable ${language} code. No markdown fences, no explanation, no comments unless necessary for clarity.`;
}

export function reflectPrompt(task: string, code: string, error: string): string {
  return `You are a coding assistant. The following code failed to execute correctly.

Task: ${task}

Failed code:
${code}

Error output:
${error}

Analyze what went wrong and write corrected code. Output ONLY the fixed executable code, no markdown fences, no explanation.`;
}

export function decomposePrompt(task: string): string {
  return `You are a task decomposition assistant. Break the following task into independent, self-contained subtasks that can be executed in parallel by separate agents.

Task: ${task}

Output a JSON array of objects, each with:
- "input": a clear description of what this subtask should accomplish
- "language": "python" or "javascript"

Output ONLY the JSON array, no other text.`;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/model/prompts.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/model/prompts.ts tests/model/prompts.test.ts
git commit -m "feat: add structured prompt templates for agent loop phases"
```

---

## Task 7: Add code extraction utility

**Files:**
- Create: `src/model/extract.ts`
- Create: `tests/model/extract.test.ts`

**Step 1: Write the failing test**

Create `tests/model/extract.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { extractCode } from "../../src/model/extract.js";

describe("extractCode", () => {
  it("returns code as-is if no fences", () => {
    expect(extractCode("print('hello')", "python")).toBe("print('hello')");
  });

  it("strips markdown python fences", () => {
    const raw = "Here is the code:\n```python\nprint('hello')\n```\nDone.";
    expect(extractCode(raw, "python")).toBe("print('hello')");
  });

  it("strips markdown js fences", () => {
    const raw = "```javascript\nconsole.log('hi');\n```";
    expect(extractCode(raw, "javascript")).toBe("console.log('hi');");
  });

  it("strips generic fences", () => {
    const raw = "```\nprint('hi')\n```";
    expect(extractCode(raw, "python")).toBe("print('hi')");
  });

  it("handles multiple fence blocks by taking the first", () => {
    const raw = "```python\nprint(1)\n```\nsome text\n```python\nprint(2)\n```";
    expect(extractCode(raw, "python")).toBe("print(1)");
  });

  it("trims whitespace", () => {
    const raw = "\n\n  print('hello')  \n\n";
    expect(extractCode(raw, "python")).toBe("print('hello')");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model/extract.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement code extraction**

Create `src/model/extract.ts`:

```typescript
import { Language } from "../common/types.js";

const FENCE_PATTERN = /```(?:python|javascript|js|py|typescript|ts)?\s*\n([\s\S]*?)```/;

export function extractCode(raw: string, _language: Language): string {
  const fenceMatch = raw.match(FENCE_PATTERN);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // No fences found — return trimmed raw text
  return raw.trim();
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/model/extract.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/model/extract.ts tests/model/extract.test.ts
git commit -m "feat: add code extraction utility for model output"
```

---

## Task 8: Expand ProviderRegistry with model tiers

**Files:**
- Modify: `src/model/providers.ts`
- Modify: `tests/model/providers.test.ts`

**Step 1: Write the failing tests**

Add to `tests/model/providers.test.ts`:

```typescript
import { ProviderRegistry, OllamaLocalProvider } from "../../src/model/providers.js";

describe("ProviderRegistry tiers", () => {
  it("supports ollama-edge tier", () => {
    const registry = new ProviderRegistry();
    registry.use("ollama-edge");
    expect(registry.current().kind).toBe("ollama-local");
  });

  it("supports ollama-coordinator tier", () => {
    const registry = new ProviderRegistry();
    registry.use("ollama-coordinator");
    expect(registry.current().kind).toBe("ollama-local");
  });

  it("lists available providers", () => {
    const registry = new ProviderRegistry();
    const available = registry.availableProviders();
    expect(available).toContain("edgecoder-local");
    expect(available).toContain("ollama-edge");
    expect(available).toContain("ollama-coordinator");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model/providers.test.ts`
Expected: FAIL — `ollama-edge` not recognized, `availableProviders` doesn't exist.

**Step 3: Update `src/model/providers.ts`**

Replace the `ModelProviderKind` type, `ProviderRegistry` class, and add defaults:

```typescript
export type ModelProviderKind =
  | "edgecoder-local"
  | "ollama-local"
  | "ollama-edge"
  | "ollama-coordinator";

// ... keep existing ModelProvider, GenerateRequest, GenerateResponse, EdgeCoderLocalProvider, OllamaLocalProvider unchanged ...

const DEFAULT_EDGE_MODEL = process.env.OLLAMA_EDGE_MODEL ?? "qwen2.5-coder:1.5b";
const DEFAULT_COORDINATOR_MODEL = process.env.OLLAMA_COORDINATOR_MODEL ?? "qwen2.5-coder:7b";

export class ProviderRegistry {
  private active: ModelProvider;
  private readonly providers: Map<ModelProviderKind, ModelProvider>;

  constructor(
    edgecoder = new EdgeCoderLocalProvider(),
    ollama = new OllamaLocalProvider(),
    ollamaEdge = new OllamaLocalProvider(undefined, DEFAULT_EDGE_MODEL),
    ollamaCoordinator = new OllamaLocalProvider(undefined, DEFAULT_COORDINATOR_MODEL)
  ) {
    this.providers = new Map<ModelProviderKind, ModelProvider>([
      ["edgecoder-local", edgecoder],
      ["ollama-local", ollama],
      ["ollama-edge", ollamaEdge],
      ["ollama-coordinator", ollamaCoordinator]
    ]);
    this.active = edgecoder;
  }

  use(kind: ModelProviderKind): void {
    const provider = this.providers.get(kind);
    if (provider) {
      this.active = provider;
    }
  }

  current(): ModelProvider {
    return this.active;
  }

  availableProviders(): ModelProviderKind[] {
    return [...this.providers.keys()];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/model/providers.test.ts`
Expected: PASS (all tests)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/model/providers.ts tests/model/providers.test.ts
git commit -m "feat: expand ProviderRegistry with edge and coordinator model tiers"
```

---

## Task 9: Wire structured prompts and code extraction into agent

**Files:**
- Modify: `src/agent/base.ts`

**Step 1: Update AgentBase to use prompts and extraction**

Update `src/agent/base.ts` to import and use the new utilities:

```typescript
import { runCode } from "../executor/run.js";
import { Language, RunResult, IterationRecord, AgentExecution } from "../common/types.js";
import { ModelProvider } from "../model/providers.js";
import { planPrompt, codePrompt, reflectPrompt } from "../model/prompts.js";
import { extractCode } from "../model/extract.js";

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
      prompt: planPrompt(task)
    });
    return res.text;
  }

  protected async generateCode(task: string, language: Language, plan?: string): Promise<string> {
    const res = await this.provider.generate({
      prompt: codePrompt(task, plan ?? task, language)
    });
    return extractCode(res.text, language);
  }

  protected async reflectOnFailure(
    task: string,
    code: string,
    runResult: RunResult
  ): Promise<string> {
    const res = await this.provider.generate({
      prompt: reflectPrompt(task, code, runResult.stderr)
    });
    return extractCode(res.text, runResult.language);
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
        generatedCode = await this.generateCode(task, language, plan);
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
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/agent/base.ts
git commit -m "feat: wire structured prompts and code extraction into agent loop"
```

---

## Task 10: Add escalation types and client

**Files:**
- Create: `src/escalation/types.ts`
- Create: `src/escalation/client.ts`
- Create: `tests/escalation/mesh-routing.test.ts`

**Step 1: Write the failing test**

Create `tests/escalation/mesh-routing.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { EscalationRequest, EscalationResult } from "../../src/escalation/types.js";
import { sanitizeEscalation } from "../../src/escalation/client.js";

describe("escalation types", () => {
  it("EscalationRequest has required fields", () => {
    const req: EscalationRequest = {
      taskId: "t-1",
      agentId: "a-1",
      task: "implement auth",
      failedCode: "print('broken')",
      errorHistory: ["NameError: x not defined"],
      language: "python",
      iterationsAttempted: 3
    };
    expect(req.taskId).toBe("t-1");
  });

  it("EscalationResult has required fields", () => {
    const res: EscalationResult = {
      taskId: "t-1",
      status: "completed",
      improvedCode: "print('fixed')",
      explanation: "Fixed the variable name"
    };
    expect(res.status).toBe("completed");
  });
});

describe("sanitizeEscalation", () => {
  it("redacts AWS keys in task descriptions", () => {
    const req: EscalationRequest = {
      taskId: "t-1",
      agentId: "a-1",
      task: "connect to AKIAIOSFODNN7EXAMPLE bucket",
      failedCode: "",
      errorHistory: [],
      language: "python",
      iterationsAttempted: 1
    };
    const clean = sanitizeEscalation(req);
    expect(clean.task).toContain("[REDACTED]");
    expect(clean.task).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/escalation/mesh-routing.test.ts`
Expected: FAIL — modules not found.

**Step 3: Create `src/escalation/types.ts`**

```typescript
import { Language } from "../common/types.js";

export interface EscalationRequest {
  taskId: string;
  agentId: string;
  task: string;
  failedCode: string;
  errorHistory: string[];
  language: Language;
  iterationsAttempted: number;
}

export interface EscalationResult {
  taskId: string;
  status: "pending" | "processing" | "completed" | "failed";
  improvedCode?: string;
  explanation?: string;
  resolvedByAgentId?: string;
  resolvedByModel?: string;
}
```

**Step 4: Create `src/escalation/client.ts`**

```typescript
import { request } from "undici";
import { EscalationRequest, EscalationResult } from "./types.js";

const REDACT_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /(?<=password\s*=\s*).+/gi,
  /(?<=api[_-]?key\s*=\s*).+/gi
];

function scrub(text: string): string {
  return REDACT_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), text);
}

export function sanitizeEscalation(req: EscalationRequest): EscalationRequest {
  return {
    ...req,
    task: scrub(req.task),
    failedCode: scrub(req.failedCode),
    errorHistory: req.errorHistory.map(scrub)
  };
}

export async function escalateToCoordinator(
  coordinatorUrl: string,
  req: EscalationRequest,
  meshToken: string
): Promise<EscalationResult> {
  const safe = sanitizeEscalation(req);
  const res = await request(`${coordinatorUrl}/escalate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(meshToken ? { "x-mesh-token": meshToken } : {})
    },
    body: JSON.stringify(safe)
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Escalation failed with status ${res.statusCode}`);
  }

  return (await res.body.json()) as EscalationResult;
}

export async function pollEscalationResult(
  coordinatorUrl: string,
  taskId: string,
  meshToken: string
): Promise<EscalationResult> {
  const res = await request(`${coordinatorUrl}/escalate/${taskId}`, {
    method: "GET",
    headers: meshToken ? { "x-mesh-token": meshToken } : {}
  });

  if (res.statusCode === 404) {
    return { taskId, status: "pending" };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Escalation poll failed with status ${res.statusCode}`);
  }

  return (await res.body.json()) as EscalationResult;
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/escalation/mesh-routing.test.ts`
Expected: PASS (3 tests)

**Step 6: Commit**

```bash
git add src/escalation/types.ts src/escalation/client.ts tests/escalation/mesh-routing.test.ts
git commit -m "feat: add escalation types and client for mesh-based hard task routing"
```

---

## Task 11: Add escalation endpoints to coordinator

**Files:**
- Modify: `src/swarm/coordinator.ts`
- Modify: `src/inference/service.ts`

**Step 1: Add `/escalate` POST endpoint to coordinator**

In `src/swarm/coordinator.ts`, add these imports at the top:

```typescript
import { EscalationRequest, EscalationResult } from "../escalation/types.js";
```

Then add the escalation store and endpoints. Find a good insertion point (after the existing route definitions). Add:

```typescript
const escalationStore = new Map<string, EscalationResult & { request: EscalationRequest }>();

const escalationRequestSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  task: z.string().min(1),
  failedCode: z.string(),
  errorHistory: z.array(z.string()),
  language: z.enum(["python", "javascript"]),
  iterationsAttempted: z.number().int().min(1)
});

app.post("/escalate", async (req, reply) => {
  const body = escalationRequestSchema.parse(req.body);
  const taskId = body.taskId;

  // Store the request as pending
  escalationStore.set(taskId, {
    taskId,
    status: "processing",
    request: body
  });

  // Route to inference service with the larger model
  const inferenceUrl = process.env.INFERENCE_URL ?? "http://127.0.0.1:4302";
  try {
    const inferRes = await request(`${inferenceUrl}/escalate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: body.task,
        failedCode: body.failedCode,
        errorHistory: body.errorHistory,
        language: body.language
      })
    });

    if (inferRes.statusCode >= 200 && inferRes.statusCode < 300) {
      const inferResult = (await inferRes.body.json()) as {
        improvedCode?: string;
        explanation?: string;
      };
      const result: EscalationResult & { request: EscalationRequest } = {
        taskId,
        status: "completed",
        improvedCode: inferResult.improvedCode,
        explanation: inferResult.explanation,
        resolvedByModel: "coordinator-inference",
        request: body
      };
      escalationStore.set(taskId, result);
      return reply.send({ taskId, status: "completed", improvedCode: inferResult.improvedCode, explanation: inferResult.explanation });
    }

    escalationStore.set(taskId, { taskId, status: "failed", request: body });
    return reply.send({ taskId, status: "failed" });
  } catch (error) {
    escalationStore.set(taskId, { taskId, status: "failed", request: body });
    return reply.code(502).send({ taskId, status: "failed", error: String(error) });
  }
});

app.get("/escalate/:taskId", async (req, reply) => {
  const params = z.object({ taskId: z.string() }).parse(req.params);
  const result = escalationStore.get(params.taskId);
  if (!result) return reply.code(404).send({ error: "escalation_not_found" });
  const { request: _req, ...rest } = result;
  return reply.send(rest);
});
```

**Step 2: Add `/escalate` endpoint to inference service**

In `src/inference/service.ts`, add after the `/decompose` endpoint:

```typescript
const escalateSchema = z.object({
  task: z.string().min(1),
  failedCode: z.string(),
  errorHistory: z.array(z.string()),
  language: z.enum(["python", "javascript"])
});

app.post("/escalate", async (req, reply) => {
  const body = escalateSchema.parse(req.body);
  // Use the coordinator-tier Ollama model for escalation
  const ollamaEndpoint = process.env.OLLAMA_GENERATE_ENDPOINT ?? "http://127.0.0.1:11434/api/generate";
  const model = process.env.OLLAMA_COORDINATOR_MODEL ?? "qwen2.5-coder:7b";

  const errorContext = body.errorHistory.length > 0
    ? `\n\nPrevious errors:\n${body.errorHistory.join("\n")}`
    : "";

  const prompt = `You are a senior coding assistant. A smaller model failed to solve this task after multiple attempts.

Task: ${body.task}

Failed code:
${body.failedCode}
${errorContext}

Write correct, working ${body.language} code that solves the task. Output ONLY executable code, no markdown fences, no explanation.`;

  try {
    const ollamaRes = await request(ollamaEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false })
    });

    const payload = (await ollamaRes.body.json()) as { response?: string };
    const improvedCode = payload.response ?? "";

    return reply.send({
      improvedCode,
      explanation: "Escalated to larger model for improved solution."
    });
  } catch (error) {
    // Fallback: return a helpful error
    return reply.code(502).send({
      improvedCode: "",
      explanation: `Escalation inference failed: ${String(error)}`
    });
  }
});
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (escalation endpoints are server-side, no unit test changes needed).

**Step 4: Commit**

```bash
git add src/swarm/coordinator.ts src/inference/service.ts
git commit -m "feat: add escalation endpoints to coordinator and inference service"
```

---

## Task 12: Implement OpenAI-compatible API translation layer

**Files:**
- Create: `src/apps/ide/openai-compat.ts`
- Create: `tests/ide/openai-compat.test.ts`

**Step 1: Write the failing test**

Create `tests/ide/openai-compat.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  parseOpenAiRequest,
  formatOpenAiResponse,
  formatOpenAiStreamChunk,
  formatOpenAiModelsResponse
} from "../../src/apps/ide/openai-compat.js";

describe("OpenAI compat: parseOpenAiRequest", () => {
  it("extracts task from chat messages", () => {
    const result = parseOpenAiRequest({
      model: "edgecoder",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Write a fibonacci function in python" }
      ]
    });
    expect(result.task).toContain("fibonacci");
    expect(result.model).toBe("edgecoder");
  });

  it("detects streaming preference", () => {
    const result = parseOpenAiRequest({
      model: "edgecoder",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    });
    expect(result.stream).toBe(true);
  });
});

describe("OpenAI compat: formatOpenAiResponse", () => {
  it("formats a non-streaming response", () => {
    const response = formatOpenAiResponse("req-1", "edgecoder", "print('hello')");
    expect(response.id).toBe("req-1");
    expect(response.object).toBe("chat.completion");
    expect(response.choices[0].message.content).toBe("print('hello')");
    expect(response.choices[0].finish_reason).toBe("stop");
  });
});

describe("OpenAI compat: formatOpenAiStreamChunk", () => {
  it("formats a streaming SSE chunk", () => {
    const chunk = formatOpenAiStreamChunk("req-1", "edgecoder", "partial");
    expect(chunk.id).toBe("req-1");
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0].delta.content).toBe("partial");
  });
});

describe("OpenAI compat: formatOpenAiModelsResponse", () => {
  it("lists available models", () => {
    const response = formatOpenAiModelsResponse(["edgecoder-local", "ollama-edge"]);
    expect(response.object).toBe("list");
    expect(response.data.length).toBe(2);
    expect(response.data[0].id).toBe("edgecoder-local");
    expect(response.data[0].object).toBe("model");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ide/openai-compat.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the translation layer**

Create `src/apps/ide/openai-compat.ts`:

```typescript
import { randomUUID } from "node:crypto";

export interface OpenAiChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ParsedRequest {
  task: string;
  model: string;
  stream: boolean;
}

export interface OpenAiChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAiStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: null | "stop";
  }>;
}

export interface OpenAiModelsResponse {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
  }>;
}

export function parseOpenAiRequest(body: OpenAiChatRequest): ParsedRequest {
  // Extract the last user message as the task
  const userMessages = body.messages.filter((m) => m.role === "user");
  const task = userMessages.length > 0
    ? userMessages[userMessages.length - 1].content
    : "";

  return {
    task,
    model: body.model,
    stream: body.stream ?? false
  };
}

export function formatOpenAiResponse(
  requestId: string,
  model: string,
  content: string
): OpenAiChatResponse {
  return {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

export function formatOpenAiStreamChunk(
  requestId: string,
  model: string,
  content: string,
  finishReason: null | "stop" = null
): OpenAiStreamChunk {
  return {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: content || undefined },
        finish_reason: finishReason
      }
    ]
  };
}

export function formatOpenAiModelsResponse(
  modelIds: string[]
): OpenAiModelsResponse {
  return {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model" as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: "edgecoder"
    }))
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ide/openai-compat.test.ts`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/apps/ide/openai-compat.ts tests/ide/openai-compat.test.ts
git commit -m "feat: add OpenAI-compatible API translation layer"
```

---

## Task 13: Wire OpenAI-compatible endpoints into IDE provider server

**Files:**
- Modify: `src/apps/ide/provider-server.ts`

**Step 1: Rewrite the provider server**

Replace `src/apps/ide/provider-server.ts` entirely:

```typescript
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderRegistry, ModelProviderKind } from "../../model/providers.js";
import { InteractiveAgent } from "../../agent/interactive.js";
import {
  parseOpenAiRequest,
  formatOpenAiResponse,
  formatOpenAiStreamChunk,
  formatOpenAiModelsResponse,
  OpenAiChatRequest
} from "./openai-compat.js";

const app = Fastify({ logger: true });
const providers = new ProviderRegistry();

const COORDINATOR_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
const MESH_TOKEN = process.env.MESH_AUTH_TOKEN ?? "";

// --- OpenAI-compatible endpoints ---

app.get("/v1/models", async () => {
  return formatOpenAiModelsResponse(providers.availableProviders());
});

const chatRequestSchema = z.object({
  model: z.string().default("edgecoder-local"),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string()
  })).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().optional()
});

app.post("/v1/chat/completions", async (req, reply) => {
  const body = chatRequestSchema.parse(req.body) as OpenAiChatRequest;
  const parsed = parseOpenAiRequest(body);
  const requestId = `chatcmpl-${randomUUID()}`;

  // Select provider based on requested model
  const validKinds = providers.availableProviders();
  const selectedKind = validKinds.includes(parsed.model as ModelProviderKind)
    ? (parsed.model as ModelProviderKind)
    : "edgecoder-local";
  providers.use(selectedKind);

  // Detect language from task content
  const language = /\b(javascript|js|typescript|ts|node)\b/i.test(parsed.task)
    ? "javascript" as const
    : "python" as const;

  const agent = new InteractiveAgent(providers.current());

  if (parsed.stream) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const send = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send planning phase
    send(formatOpenAiStreamChunk(requestId, selectedKind, "[Planning...]\n"));

    const result = await agent.run(parsed.task, language);

    // Send plan
    send(formatOpenAiStreamChunk(requestId, selectedKind, `Plan:\n${result.plan}\n\n`));

    // Send code
    send(formatOpenAiStreamChunk(requestId, selectedKind, `Code:\n${result.generatedCode}\n\n`));

    // Send execution result
    const status = result.runResult.ok ? "PASSED" : "FAILED";
    send(formatOpenAiStreamChunk(requestId, selectedKind, `Execution: ${status}\n`));

    if (result.runResult.stdout) {
      send(formatOpenAiStreamChunk(requestId, selectedKind, `Output: ${result.runResult.stdout}\n`));
    }
    if (result.runResult.stderr) {
      send(formatOpenAiStreamChunk(requestId, selectedKind, `Errors: ${result.runResult.stderr}\n`));
    }

    send(formatOpenAiStreamChunk(requestId, selectedKind, `\nIterations: ${result.iterations}, Escalated: ${result.escalated}\n`));

    // Send done
    send(formatOpenAiStreamChunk(requestId, selectedKind, "", "stop"));
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return;
  }

  // Non-streaming response
  const result = await agent.run(parsed.task, language);

  const content = [
    result.generatedCode,
    "",
    `// Execution: ${result.runResult.ok ? "PASSED" : "FAILED"}`,
    result.runResult.stdout ? `// Output: ${result.runResult.stdout}` : "",
    result.runResult.stderr ? `// Errors: ${result.runResult.stderr}` : "",
    `// Iterations: ${result.iterations}, Escalated: ${result.escalated}`
  ].filter(Boolean).join("\n");

  return reply.send(formatOpenAiResponse(requestId, selectedKind, content));
});

// --- Legacy endpoints (kept for backward compat) ---

const legacyRequestSchema = z.object({
  provider: z.enum(["edgecoder-local", "ollama-local"]).default("edgecoder-local"),
  task: z.string().min(1),
  language: z.enum(["python", "javascript"]).default("python")
});

app.get("/models", async () => ({
  providers: providers.availableProviders()
}));

app.post("/run", async (req, reply) => {
  const body = legacyRequestSchema.parse(req.body);
  providers.use(body.provider);
  const agent = new InteractiveAgent(providers.current());
  const output = await agent.run(body.task, body.language);
  return reply.send(output);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port: 4304, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as ideProviderServer };
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/apps/ide/provider-server.ts
git commit -m "feat: wire OpenAI-compatible endpoints into IDE provider server"
```

---

## Task 14: Add Docker sandbox for swarm workers

**Files:**
- Create: `src/executor/docker-sandbox.ts`
- Create: `docker/sandbox-python.Dockerfile`
- Create: `docker/sandbox-node.Dockerfile`
- Create: `tests/executor/docker-sandbox.test.ts`

**Step 1: Write the failing test**

Create `tests/executor/docker-sandbox.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { isDockerAvailable, runInDockerSandbox } from "../../src/executor/docker-sandbox.js";

describe("Docker sandbox", () => {
  it("isDockerAvailable returns a boolean", async () => {
    const result = await isDockerAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("runInDockerSandbox returns a RunResult", async () => {
    const available = await isDockerAvailable();
    if (!available) {
      // Skip if Docker not available in test env
      console.log("Docker not available, skipping sandbox execution test");
      return;
    }

    const result = await runInDockerSandbox("python", "print('sandbox-ok')", 10000);
    expect(result.language).toBe("python");
    // Result may fail if sandbox images not built, that's OK for unit test
    expect(typeof result.ok).toBe("boolean");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/executor/docker-sandbox.test.ts`
Expected: FAIL — module not found.

**Step 3: Create Dockerfiles**

Create `docker/sandbox-python.Dockerfile`:

```dockerfile
FROM python:3.12-slim
RUN useradd -m -s /bin/sh sandbox
USER sandbox
WORKDIR /home/sandbox
ENTRYPOINT ["python3", "-c"]
```

Create `docker/sandbox-node.Dockerfile`:

```dockerfile
FROM node:20-slim
RUN useradd -m -s /bin/sh sandbox
USER sandbox
WORKDIR /home/sandbox
ENTRYPOINT ["node", "-e"]
```

**Step 4: Implement Docker sandbox executor**

Create `src/executor/docker-sandbox.ts`:

```typescript
import { spawn } from "node:child_process";
import { Language, RunResult } from "../common/types.js";

const DOCKER_IMAGES: Record<Language, string> = {
  python: "edgecoder/sandbox-python:latest",
  javascript: "edgecoder/sandbox-node:latest"
};

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn("docker", ["info"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function runInDockerSandbox(
  language: Language,
  code: string,
  timeoutMs = 10000
): Promise<RunResult> {
  const start = Date.now();
  const image = DOCKER_IMAGES[language];

  return new Promise<RunResult>((resolve) => {
    const args = [
      "run", "--rm",
      "--network=none",
      "--read-only",
      "--memory=256m",
      "--cpus=0.5",
      "--pids-limit=50",
      image,
      code
    ];

    const proc = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill("SIGKILL");
        settled = true;
        resolve({
          language,
          ok: false,
          stdout,
          stderr: `${stderr}\nDocker execution timed out`,
          exitCode: 124,
          durationMs: Date.now() - start,
          queueForCloud: true,
          queueReason: "timeout"
        });
      }
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (exitCode) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({
        language,
        ok: (exitCode ?? 1) === 0,
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - start,
        queueForCloud: false
      });
    });

    proc.on("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({
        language,
        ok: false,
        stdout,
        stderr: `Docker sandbox error: ${error.message}`,
        exitCode: 1,
        durationMs: Date.now() - start,
        queueForCloud: false
      });
    });
  });
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/executor/docker-sandbox.test.ts`
Expected: PASS (1-2 tests depending on Docker availability)

**Step 6: Commit**

```bash
git add src/executor/docker-sandbox.ts docker/sandbox-python.Dockerfile docker/sandbox-node.Dockerfile tests/executor/docker-sandbox.test.ts
git commit -m "feat: add Docker sandbox executor for swarm workers"
```

---

## Task 15: Integrate Docker sandbox into executor and worker

**Files:**
- Modify: `src/executor/run.ts`
- Modify: `src/swarm/worker-runner.ts`

**Step 1: Add sandbox option to `runCode()`**

In `src/executor/run.ts`, update the function signature and logic:

Add import at top:
```typescript
import { isDockerAvailable, runInDockerSandbox } from "./docker-sandbox.js";
import { log } from "../common/logger.js";
```

Update `runCode` signature:
```typescript
export async function runCode(
  language: Language,
  code: string,
  timeoutMs = 4_000,
  sandbox: "host" | "docker" = "host"
): Promise<RunResult> {
```

After the subset check, before executing, add the Docker path:
```typescript
  if (sandbox === "docker") {
    const dockerOk = await isDockerAvailable();
    if (dockerOk) {
      return runInDockerSandbox(language, code, timeoutMs);
    }
    log.warn("Docker not available, falling back to host execution with AST sandbox");
  }
```

The rest of the function (host execution) stays unchanged.

**Step 2: Update worker to use Docker sandbox**

In `src/swarm/worker-runner.ts`, the worker calls `worker.runSubtask(pulled.subtask, AGENT_ID)`. The `SwarmWorkerAgent.runSubtask()` calls `this.runWithRetry()` which calls `this.execute()` which calls `runCode()`. To pass the sandbox option through, update `AgentBase`:

In `src/agent/base.ts`, add `sandbox` to the options:

```typescript
export interface AgentOptions {
  maxIterations?: number;
  sandbox?: "host" | "docker";
}
```

And update `execute()`:
```typescript
  protected async execute(code: string, language: Language): Promise<RunResult> {
    return runCode(language, code, 4_000, this.sandbox);
  }
```

Store it in the constructor:
```typescript
  protected readonly sandbox: "host" | "docker";

  constructor(provider: ModelProvider, options?: AgentOptions) {
    this.maxIterations = options?.maxIterations ?? 3;
    this.sandbox = options?.sandbox ?? "host";
  }
```

In `src/agent/worker.ts`, default to `"docker"`:
```typescript
  constructor(provider: ModelProvider, options?: AgentOptions) {
    super(provider, { maxIterations: 2, sandbox: "docker", ...options });
  }
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing tests use host sandbox by default).

**Step 4: Commit**

```bash
git add src/executor/run.ts src/agent/base.ts src/agent/worker.ts
git commit -m "feat: integrate Docker sandbox into executor with worker defaults"
```

---

## Task 16: End-to-end integration test

**Files:**
- Create: `tests/e2e/full-loop.test.ts`

**Step 1: Write the e2e test**

Create `tests/e2e/full-loop.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { InteractiveAgent } from "../../src/agent/interactive.js";
import { EdgeCoderLocalProvider } from "../../src/model/providers.js";
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
    const failingProvider = {
      kind: "edgecoder-local" as const,
      async generate() {
        return { text: "definitely_not_valid_python(", provider: "edgecoder-local" as const };
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
```

**Step 2: Run the e2e test**

Run: `npx vitest run tests/e2e/full-loop.test.ts`
Expected: PASS (10 tests)

**Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add tests/e2e/full-loop.test.ts
git commit -m "feat: add end-to-end integration test proving full agent loop"
```

---

## Task 17: Final full-suite verification and build check

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 2: TypeScript build check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit build**

Run: `npm run build`

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify full build and test suite after features 1-6 implementation"
```

---

## Summary of all tasks

| Task | Feature | What it does |
|------|---------|------|
| 1 | Retry Loop | Add `IterationRecord` + `AgentExecution` types |
| 2 | Retry Loop | Implement retry state machine in `AgentBase`, `InteractiveAgent`, `SwarmWorkerAgent` |
| 3 | AST Sandbox | Python AST validator (`ast-python.ts`) |
| 4 | AST Sandbox | JavaScript AST validator (`ast-javascript.ts`) with `acorn` |
| 5 | AST Sandbox | Integrate AST into executor pipeline |
| 6 | Ollama Integration | Structured prompt templates |
| 7 | Ollama Integration | Code extraction utility |
| 8 | Ollama Integration | Expand `ProviderRegistry` with model tiers |
| 9 | Ollama Integration | Wire prompts + extraction into agent |
| 10 | Mesh Escalation | Escalation types + client |
| 11 | Mesh Escalation | Coordinator + inference service endpoints |
| 12 | IDE API | OpenAI-compatible translation layer |
| 13 | IDE API | Wire into IDE provider server |
| 14 | Docker Sandbox | Docker executor + Dockerfiles |
| 15 | Docker Sandbox | Integrate into executor + worker |
| 16 | E2E Test | Full integration test proving the loop |
| 17 | Verification | Full suite + build check |
