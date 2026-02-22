# EdgeCoder Features 1-6 + End-to-End Integration Design

**Date:** 2026-02-22
**Status:** Approved
**Approach:** Bottom-Up Sequential (A)

---

## Summary

Implement 6 features in dependency order, then prove the system works end-to-end with a multi-file feature implementation demo. All models are free, locally-hosted Ollama models. No paid cloud APIs.

**Model hierarchy:**
- Edge agents: Qwen2.5-Coder 0.5B-1.5B (small, fast)
- Coordinator/powerful nodes: Qwen2.5-Coder 7B-14B (capable, handles hard tasks)
- "Cloud" = other nodes in the mesh running larger models, not paid APIs

---

## Feature 1: Agent Retry Loop

**Goal:** Transform the single-pass agent into a plan-code-test-iterate loop.

**Current state:** `InteractiveAgent.run()` does plan -> generateCode -> execute once.

**Design:**

State machine: `planning` -> `coding` -> `testing` -> `evaluating` -> (back to `planning` or `done` or `escalate`)

Additions to `AgentBase`:
- `maxIterations` (default 3): Max plan-code-test cycles before escalation
- `reflectOnFailure(task, code, runResult)`: Asks model to analyze failure and produce revised approach
- `extractTestResult(runResult)`: Determines pass/fail from RunResult
- Escalation: After `maxIterations` failures, produce result with `escalated: true`
- Execution history: Each iteration tracked for model context

Updated interface:
```typescript
interface IterationRecord {
  iteration: number;
  plan: string;
  code: string;
  runResult: RunResult;
}

interface AgentExecution {
  plan: string;
  generatedCode: string;
  runResult: RunResult;
  iterations: number;
  history: IterationRecord[];
  escalated: boolean;
  escalationReason?: string;
}
```

`SwarmWorkerAgent` gets same retry with tighter default (2 iterations).

**Files modified:** `src/agent/base.ts`, `src/agent/interactive.ts`, `src/agent/worker.ts`, `src/common/types.ts`
**New tests:** `tests/agent/retry-loop.test.ts`

---

## Feature 2: AST-Based Executor Sandboxing

**Goal:** Replace regex denylists with proper AST allowlists.

**Current state:** 8 Python regex patterns, 6 JS regex patterns. Easy to bypass.

**Design:**

Invert the security model: only allow known-safe AST nodes.

**Python:** Use Python's `ast` module via `python3 -c "import ast, json; ..."` to parse and validate.
- Allowed nodes: Module, FunctionDef, Return, Assign, AugAssign, For, While, If, Expr, Call, BinOp, UnaryOp, Compare, BoolOp, Num, Str, List, Dict, Tuple, Set, Name, Subscript, Attribute, ListComp, DictComp, SetComp, FormattedValue, JoinedStr, Index, Slice, Constant, Pass, Break, Continue
- Blocked: Import, ImportFrom, Global, Nonlocal, With, Try, Raise, Delete, Assert, Yield, Await, AsyncFunctionDef, ClassDef
- Allowed builtins: print, len, range, int, float, str, bool, list, dict, tuple, set, sorted, reversed, enumerate, zip, map, filter, min, max, sum, abs, round, type, isinstance, hasattr
- Blocked builtins: open, exec, eval, compile, __import__, globals, locals, getattr, setattr, delattr, vars, dir, input

**JavaScript:** Use `acorn` parser (add as dependency) to parse ESTree AST.
- Allowed nodes: Program, FunctionDeclaration, VariableDeclaration, ExpressionStatement, ReturnStatement, IfStatement, ForStatement, WhileStatement, BlockStatement, ArrayExpression, ObjectExpression, BinaryExpression, UnaryExpression, CallExpression, ArrowFunctionExpression, Literal, Identifier, MemberExpression, TemplateLiteral, ConditionalExpression, LogicalExpression, AssignmentExpression, UpdateExpression, SpreadElement, Property
- Blocked: ImportDeclaration, ImportExpression, NewExpression, ClassDeclaration, TryStatement, ThrowStatement, WithStatement, YieldExpression, AwaitExpression
- Allowed globals: console, Math, JSON, String, Number, Array, Object, Map, Set, parseInt, parseFloat, isNaN, isFinite
- Blocked globals: process, require, import, globalThis, eval, Function, Proxy, Reflect

Existing regex denylist stays as fast pre-filter. AST validation is authoritative.

**Files modified:** `src/executor/subset.ts`, `src/executor/run.ts`
**New files:** `src/executor/ast-python.ts`, `src/executor/ast-javascript.ts`
**New dependency:** `acorn` (JS parser)
**New tests:** `tests/executor/ast-sandbox.test.ts`

---

## Feature 3: Real Ollama Model Integration

**Goal:** Replace stub provider with proper Ollama integration.

**Current state:** `EdgeCoderLocalProvider` is a deterministic stub. `OllamaLocalProvider` works but uses bare prompts.

**Design:**

**Model tiers:**
- Edge tier (agents): `qwen2.5-coder:0.5b` or `qwen2.5-coder:1.5b`
- Coordinator tier: `qwen2.5-coder:7b` or `qwen2.5-coder:14b`

**Structured prompt templates:**
- `planPrompt(task)`: "You are a coding assistant. Create a step-by-step plan for: {task}. Output ONLY the plan, numbered steps."
- `codePrompt(task, plan, language)`: "Write {language} code implementing this plan: {plan}. Output ONLY executable code, no markdown fences, no explanation."
- `reflectPrompt(task, code, error)`: "This code failed with: {error}. Analyze what went wrong and produce corrected code. Output ONLY the fixed code."
- `decomposePrompt(task)`: (coordinator) "Break this task into independent subtasks. Output JSON array."

**Code extraction utility:** `extractCode(raw, language)` — strips markdown fences, trims non-code preamble/postamble, validates result.

**Provider registry expansion:**
- New `ModelProviderKind` values: `"ollama-edge"`, `"ollama-coordinator"`
- Registry routes by capability tier
- Health checks with automatic fallback to stub if Ollama unavailable

**Files modified:** `src/model/providers.ts`, `src/agent/base.ts`
**New files:** `src/model/prompts.ts`, `src/model/extract.ts`
**New tests:** `tests/model/prompts.test.ts`, `tests/model/extract.test.ts`

---

## Feature 4: Mesh-Based Hard Task Routing

**Goal:** Route hard tasks to more capable peers in the mesh instead of cloud.

**Current state:** `handshake/client.ts` sends to mock cloud server. Mock returns fake diffs.

**Design:**

Reframe "cloud handshake" as mesh escalation:

1. Agent retry loop exhausts `maxIterations` -> `escalated: true`
2. Agent calls coordinator `POST /escalate` with task + failed code + error history
3. Coordinator checks which peers run larger models (tracked in registration)
4. Coordinator routes to its inference service (7B-14B model) or capable peer
5. Larger model gets full context (task + failed attempts + errors), generates improved code
6. Result flows back: coordinator -> agent -> user

**New coordinator endpoints:**
- `POST /escalate` — accepts task escalation from agents
- `GET /escalate/:taskId` — poll for escalation result

**Escalation payload:**
```typescript
interface EscalationRequest {
  taskId: string;
  agentId: string;
  task: string;
  failedCode: string;
  errorHistory: string[];
  language: Language;
  iterationsAttempted: number;
}

interface EscalationResult {
  taskId: string;
  status: "pending" | "processing" | "completed" | "failed";
  improvedCode?: string;
  explanation?: string;
  resolvedByAgentId?: string;
  resolvedByModel?: string;
}
```

PII redaction from existing `sanitizePayload` applies to escalation payloads.

Existing `handshake/client.ts` refactored into `escalation/client.ts`.

**Files modified:** `src/swarm/coordinator.ts`, `src/inference/service.ts`
**New files:** `src/escalation/client.ts`, `src/escalation/types.ts`
**Refactored:** `src/handshake/client.ts` -> `src/escalation/client.ts`
**New tests:** `tests/escalation/mesh-routing.test.ts`

---

## Feature 5: IDE Integration (OpenAI-Compatible API)

**Goal:** Make EdgeCoder work identically to OpenAI/other model providers in Cursor, VS Code + Continue, and any OpenAI client.

**Current state:** `apps/ide/provider-server.ts` has custom `/models` and `/run` endpoints.

**Design:**

Implement the OpenAI Chat Completions API spec:

- `GET /v1/models` — Lists available EdgeCoder models (maps to Ollama models)
- `POST /v1/chat/completions` — Standard chat completions, supports `stream: true` (SSE)

Behind the scenes:
- Translates OpenAI-format requests into agent loop (plan-code-test-iterate)
- For simple prompts: direct Ollama inference
- For coding tasks: full agent loop with escalation
- Streaming: SSE chunks showing agent progress

**IDE configuration:**
- Cursor: Add EdgeCoder as custom OpenAI-compatible provider, Base URL `http://localhost:4304/v1`
- VS Code + Continue: Same base URL as OpenAI-compatible endpoint
- Any OpenAI client (Python `openai` library, etc.): works out of the box

**Files modified:** `src/apps/ide/provider-server.ts`
**New files:** `src/apps/ide/openai-compat.ts` (request/response translation)
**New tests:** `tests/ide/openai-compat.test.ts`

---

## Feature 6: Swarm Worker Sandbox

**Goal:** OS-level isolation for swarm workers via Docker containers.

**Current state:** Workers execute code directly on host. No isolation.

**Design:**

Docker-based isolation for swarm workers:
- Subtask code runs inside lightweight Docker containers
- Container: minimal image, no network, read-only FS, memory/CPU limits, auto-removed
- Executor `runCode()` gets `sandbox: "docker" | "host"` option
- `InteractiveAgent` (local user) defaults to `"host"`
- `SwarmWorkerAgent` defaults to `"docker"`

Container spec:
```
docker run --rm --no-healthcheck \
  --network=none \
  --read-only \
  --memory=256m \
  --cpus=0.5 \
  --pids-limit=50 \
  --stop-timeout=5 \
  edgecoder/sandbox-{language}:latest
```

Fallback: If Docker unavailable, use host execution with AST sandbox (Feature 2). Log warning.

**Files modified:** `src/executor/run.ts`, `src/swarm/worker-runner.ts`
**New files:** `src/executor/docker-sandbox.ts`, `docker/sandbox-python.Dockerfile`, `docker/sandbox-node.Dockerfile`
**New tests:** `tests/executor/docker-sandbox.test.ts`

---

## End-to-End Integration Test

**Scenario:** Multi-file feature implementation from IDE.

**Flow:**
1. User types "Add a user authentication module with login/logout and session management" in Cursor/Continue
2. Request hits EdgeCoder's OpenAI-compatible API (`/v1/chat/completions`)
3. Provider server creates `InteractiveAgent` with edge-tier Ollama model (0.5B-1.5B)
4. Agent plans the task (numbered steps)
5. Agent generates code for step 1, tests in AST-validated executor
6. If tests fail, agent reflects and iterates (up to 3 times)
7. If task too complex for small model, agent escalates to coordinator
8. Coordinator routes to peer running 7B model
9. Larger model generates the complex code, result flows back
10. IDE shows progress in real-time via SSE streaming
11. User sees generated code, can accept/reject

**Success criteria:**
- Entire flow works end-to-end without any external paid API
- Small model handles simple parts, larger model handles complex parts
- User sees real-time progress in IDE
- Generated code runs and passes tests in the executor
- EdgeCoder appears in IDE exactly like OpenAI/other model providers

**Test file:** `tests/e2e/full-loop.test.ts`

---

## Build Order

1. Agent retry loop (foundation for everything)
2. AST executor sandbox (needed before trusting real model output)
3. Real Ollama integration (replaces stubs with real inference)
4. Mesh escalation (routes hard tasks to capable peers)
5. OpenAI-compatible IDE API (external interface)
6. Swarm worker sandbox (enterprise security)
7. End-to-end integration test (proves it all works)

## New Dependencies

- `acorn` — JavaScript AST parser (Feature 2)

## Estimated New/Modified Files

- ~12 new source files
- ~8 modified source files
- ~8 new test files
- 2 new Dockerfiles
