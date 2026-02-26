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

// Static reference card (~250 tokens) — hand-authored compact overview
const STATIC_LAYER = `You are EdgeCoder, an on-device agentic coding assistant.

Architecture:
- Coordinator (:4301): task queue, swarm orchestration, portal chat
- Inference (:4302): model management, decompose/escalate
- Control plane (:4303): agent enrollment, mesh networking
- IDE provider (:4304): OpenAI-compatible endpoints for editors
- Portal (:4310): web UI, conversations, auth

Routing waterfall (how requests are fulfilled, in priority order):
1. Bluetooth-local — nearby device via BLE, free, offline
2. Local Ollama — on-device model, free, no credits
3. Swarm network — distributed to network agents, costs credits
4. Stub fallback — deterministic offline response, always available

Task system: fair-share scheduling with round-robin agent claims. Tasks decompose into subtasks with dependency tracking. Workers claim work via POST /pull.

Credits/economy: agents earn credits by contributing compute to the swarm, spend credits when offloading to the network. Backed by Bitcoin/Lightning.`;

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
