// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Requests for job-description and best-fit routing tests: a simple question, a one-line fix, a
 * multi-file refactor, a long log to summarize, an agentic coding loop, a classification and a
 * single-file edit.
 */
import type { ChatMessage, ToolSpec } from "../../src/inference-api/types.js";

export interface FixtureRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

const code = "```ts\n" + Array.from({ length: 60 }, (_, i) => `const x${i} = compute(${i});`).join("\n") + "\n```";
const log = Array.from({ length: 800 }, (_, i) => `2026-11-15T10:${String(i % 60).padStart(2, "0")}:00Z INFO worker ${i} processed batch ok in ${i % 97} ms`).join("\n");
export const TOOLS: ToolSpec[] = ["read_file", "edit_file", "run_tests"].map((name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } }));

export const SIMPLE_QA: FixtureRequest = { messages: [{ role: "user", content: "What is a closure in JavaScript?" }] };

export const ONE_LINE_FIX: FixtureRequest = { messages: [{ role: "user", content: "Fix the typo in this line:\n```js\nconsle.log('hi')\n```" }] };

export const MULTI_FILE_REFACTOR: FixtureRequest = {
  messages: [
    {
      role: "user",
      content: `Refactor the auth flow across src/auth/login.ts, src/auth/session.ts, src/api/routes.ts and src/db/users.ts so session handling lives in one module. Plan the design first and keep the behaviour.\n${code}`,
    },
  ],
  maxTokens: 4096,
};

export const LONG_LOG_SUMMARY: FixtureRequest = { messages: [{ role: "user", content: `Summarize this log:\n${log}` }] };

export const AGENTIC_LOOP: FixtureRequest = {
  messages: [
    { role: "system", content: "You are a coding agent. Use the tools to change the repository." },
    { role: "user", content: "Make the failing test in tests/api.test.ts pass." },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "tests/api.test.ts" } } }] },
    { role: "tool", tool_name: "read_file", content: "import { handler } from '../src/api/routes';\ntest('lists', () => expect(handler()).toEqual([]));" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "run_tests", arguments: {} } }] },
    { role: "tool", tool_name: "run_tests", content: "FAIL tests/api.test.ts\nTypeError: x is undefined\n    at handler (src/api/routes.ts:10:5)" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "src/api/routes.ts" } } }] },
    { role: "tool", tool_name: "read_file", content: "export function handler() { return x.list(); }" },
  ],
  tools: TOOLS,
};

export const CLASSIFY: FixtureRequest = { messages: [{ role: "user", content: "Classify the sentiment of this review: 'Great product, fast shipping.'" }] };

export const SINGLE_EDIT: FixtureRequest = {
  messages: [{ role: "user", content: `In src/api/routes.ts, implement pagination for the list handler and update src/db/users.ts to match.\n${code}` }],
};
