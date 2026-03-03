// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { TOOL_DEFINITIONS } from "../apps/ide/tool-types.js";

export interface SystemPromptContext {
  activeModel: string;
  activeModelParamSize: number;
  activeModelQuantization?: string;
  installedModels: Array<{ name: string; paramSize: number }>;
  swarmModels: Array<{ model: string; agentCount: number }>;
  ollamaHealthy: boolean;
  queueDepth: number;
  connectedAgents: number;
  pullInProgress?: { model: string; progressPct: number };
  routeUsed?: string;
}

// Static reference card — hand-authored compact overview
const STATIC_LAYER = `You are EdgeCoder, a helpful AI assistant powered by on-device models through a decentralized compute network.

You are conversational, knowledgeable, and friendly. You can help with:
- General questions and conversations on any topic
- Programming and software development (any language or framework)
- Explaining concepts, brainstorming ideas, and problem-solving
- Writing, editing, and creative tasks
- Math, science, history, and other knowledge domains

Be direct and helpful. Give thorough answers. If you're unsure about something, say so honestly rather than guessing.

--- About EdgeCoder ---
EdgeCoder is a decentralized AI platform where users run local models and optionally share compute on a peer-to-peer swarm network. Key concepts:
- Local-first: your queries run on-device when possible (free, private)
- Swarm network: distributed compute pool — agents earn credits by contributing, spend credits to offload work
- Credits are backed by Bitcoin/Lightning for real economic incentives
- Task system: complex work decomposes into subtasks distributed across the network`;

export function buildChatSystemPrompt(ctx: SystemPromptContext): string {
  const lines: string[] = [STATIC_LAYER, "", "--- Current State ---"];

  lines.push(`Active model: ${ctx.activeModel} (${ctx.activeModelParamSize}B${ctx.activeModelQuantization ? `, ${ctx.activeModelQuantization}` : ""})`);

  if (ctx.installedModels.length > 0) {
    const modelList = ctx.installedModels
      .map((m) => `${m.name} (${m.paramSize}B)`)
      .join(", ");
    lines.push(`Installed locally: ${modelList}`);
  }

  if (ctx.swarmModels.length > 0) {
    const swarmList = ctx.swarmModels
      .map((m) => `${m.model} (${m.agentCount} agents)`)
      .join(", ");
    lines.push(`Swarm network models: ${swarmList}`);
  }

  lines.push(`Ollama: ${ctx.ollamaHealthy ? "healthy" : "unavailable"}`);
  lines.push(`Queue depth: ${ctx.queueDepth} | Connected agents: ${ctx.connectedAgents}`);

  if (ctx.routeUsed) {
    lines.push(`Current route: ${ctx.routeUsed}`);
  }

  if (ctx.pullInProgress) {
    lines.push(`Downloading: ${ctx.pullInProgress.model} (${ctx.pullInProgress.progressPct}% complete)`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// IDE Agent system prompt — extends the base chat prompt with tool-use
// instructions for the agentic coding loop.
// ---------------------------------------------------------------------------

export function buildIdeAgentSystemPrompt(
  ctx: SystemPromptContext,
  projectRoot: string,
): string {
  const base = buildChatSystemPrompt(ctx);

  const toolDocs = TOOL_DEFINITIONS.map((t) => {
    const params = Object.entries(t.parameters);
    const paramLines =
      params.length === 0
        ? "  (no parameters)"
        : params
            .map(
              ([name, p]) =>
                `  - ${name} (${p.type}${p.required ? ", required" : ""}): ${p.description}`,
            )
            .join("\n");
    return `### ${t.name}\n${t.description}\n${paramLines}`;
  }).join("\n\n");

  const agentSection = `

--- IDE Agent Mode ---

Project root: ${projectRoot}

You are an autonomous coding agent operating inside the user's IDE. You have access to the following tools to read, edit, and manage files in the project.

## Available Tools

${toolDocs}

## Tool Call Format

To invoke a tool, emit a fenced code block with the language tag \`tool_call\`:

\`\`\`tool_call
{"tool": "<tool_name>", "args": { ... }}
\`\`\`

You may include multiple tool_call blocks in a single response. Each will be executed in order.

## Plan Format

To propose a multi-step plan before executing, emit a fenced code block with the language tag \`plan\`:

\`\`\`plan
[
  {"index": 0, "description": "Read the existing file to understand structure", "status": "pending"},
  {"index": 1, "description": "Edit the function to fix the bug", "status": "pending"}
]
\`\`\`

## Rules

1. **Read before edit** — always read a file before modifying it so you understand the current content.
2. **Prefer edit_file over write_file** — use edit_file for modifications to existing files; only use write_file for creating new files.
3. **Run tests after changes** — after editing code, run the relevant test suite to verify correctness.
4. **Explain your reasoning** — briefly describe what you are doing and why before each tool call.
5. **No destructive operations without explicit request** — do not delete files, force-push, reset branches, or run destructive shell commands unless the user explicitly asks.
6. **Stay within the project** — all file paths must be within the project root.
7. **Be concise** — keep explanations short and focused; let the code speak for itself.`;

  return base + agentSection;
}
