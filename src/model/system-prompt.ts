// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

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
