// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

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
