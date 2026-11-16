// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Which models can do an agent step: take tool definitions and answer with tool calls.
 *
 * Size is not enough. deepseek-r1:14b passes a 14B floor, but it's a reasoning model: given tools
 * and "read the files", it writes a numbered plan and calls nothing. In order:
 *   1. Families known not to call tools reliably (NO_TOOL_FAMILIES) never count, even when the
 *      runtime says "tools": Ollama's deepseek-r1 template accepts tool definitions, the model
 *      just doesn't use them.
 *   2. What this computer's Ollama reports (`/api/show` -> `capabilities`, on recent versions),
 *      cached per model (recordCapabilities / ollamaCapabilities).
 *   3. The model catalog's capabilities.
 *   4. Families known to call tools (TOOL_FAMILIES).
 *   5. Anything else counts as able (an unknown model is tried; the agent loop drops to text-mode
 *      tool calls when the runtime refuses tool definitions).
 */

import { catalogEntryForTag } from "./catalog.js";

/** Families (the tag's name, before ":") that call tools: Ollama's "tools" label and they use it. */
export const TOOL_FAMILIES: readonly string[] = [
  "qwen2.5", "qwen2.5-coder", "qwen3", "qwen3-coder", "qwen3-coder-next", "qwen3.5", "qwq",
  "llama3.1", "llama3.2", "llama3.3", "llama4",
  "mistral", "mistral-nemo", "mistral-small", "mistral-small3.1", "mistral-small3.2", "mistral-large", "mixtral", "devstral", "devstral-small-2", "magistral",
  "gpt-oss", "gemma4", "granite3.1-dense", "granite3.2", "granite3.3", "granite4", "command-r", "command-r-plus", "command-a",
  "hermes3", "firefunction-v2", "smollm2", "phi4-mini", "nemotron", "llama3-groq-tool-use", "athene-v2", "cogito", "kimi-k2", "glm4.5", "glm-4.6",
];

/**
 * Families that don't call tools, or say they can and then only describe what they would do: pure
 * reasoning models and older chat/code models. Never used for an agent step.
 */
export const NO_TOOL_FAMILIES: readonly string[] = [
  "deepseek-r1", "openthinker", "marco-o1", "exaone-deep", "phi4-reasoning", "deepscaler", "smallthinker", "r1-1776",
  "deepseek-coder", "deepseek-coder-v2", "codellama", "codegemma", "starcoder", "starcoder2", "codestral",
  "llama2", "llama3", "gemma", "gemma2", "gemma3", "gemma3n", "phi", "phi3", "phi3.5", "phi4", "tinyllama", "orca-mini", "vicuna",
];

/** The family of a tag: "deepseek-r1:14b" -> "deepseek-r1", "hf.co/x/Qwen3-8B-GGUF:Q4" -> "qwen3-8b-gguf". */
export function familyOf(model: string): string {
  const name = model.trim().toLowerCase().split(":")[0];
  return name.slice(name.lastIndexOf("/") + 1);
}

const inList = (list: readonly string[], fam: string) => list.includes(fam);

/** What the runtime reported, per model tag (this process; empty on the coordinator). */
const reported = new Map<string, { caps: string[]; atMs: number }>();
/** How long a reported capability list is trusted before it's asked again. */
export const CAPABILITY_TTL_MS = 30 * 60_000;

/** Remember what the runtime says a model can do (`/api/show` capabilities). */
export function recordCapabilities(model: string, caps: readonly string[], nowMs = Date.now()): void {
  reported.set(model, { caps: caps.map((c) => String(c).toLowerCase()), atMs: nowMs });
}

/** The cached capabilities of a model, when the runtime reported them recently. */
export function reportedCapabilities(model: string, nowMs = Date.now()): string[] | undefined {
  const r = reported.get(model);
  return r && nowMs - r.atMs < CAPABILITY_TTL_MS ? r.caps : undefined;
}

/** Tests: forget what the runtime reported. */
export function clearReportedCapabilities(): void {
  reported.clear();
}

/** `capabilities` from an Ollama `/api/show` reply, or undefined when it has none (older Ollama). */
export function parseShowCapabilities(body: unknown): string[] | undefined {
  const caps = (body as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(caps) && caps.every((c) => typeof c === "string") ? (caps as string[]) : undefined;
}

/** Whether a model can do an agent step, and what said so (see the module comment for the order). */
export function toolSupport(model: string, nowMs = Date.now()): { tools: boolean; source: "denylist" | "runtime" | "catalog" | "allowlist" | "unknown" } {
  const fam = familyOf(model);
  if (inList(NO_TOOL_FAMILIES, fam)) return { tools: false, source: "denylist" };
  const caps = reportedCapabilities(model, nowMs);
  if (caps) return { tools: caps.includes("tools"), source: "runtime" };
  const entry = catalogEntryForTag(model);
  if (entry) return { tools: entry.capabilities.includes("tools"), source: "catalog" };
  if (inList(TOOL_FAMILIES, fam)) return { tools: true, source: "allowlist" };
  return { tools: true, source: "unknown" };
}

/** True when the model can do an agent step (take tools and call them). */
export function supportsTools(model: string, nowMs = Date.now()): boolean {
  return toolSupport(model, nowMs).tools;
}

/**
 * Ask this computer's Ollama what each model can do (`POST /api/show`), for the models not asked
 * recently, and cache the answers. Failures and older Ollama versions (no `capabilities`) leave the
 * fallback lists in charge. Calls run in parallel with a short timeout each.
 */
export async function refreshOllamaCapabilities(
  models: readonly string[],
  opts: { host?: string; fetch?: typeof fetch; timeoutMs?: number; nowMs?: number } = {},
): Promise<void> {
  const host = (opts.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const f = opts.fetch ?? fetch;
  const now = opts.nowMs ?? Date.now();
  await Promise.all(
    models
      .filter((m) => !reportedCapabilities(m, now))
      .map(async (model) => {
        try {
          const res = await f(`${host}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model }),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
          });
          if (!res.ok) return;
          const caps = parseShowCapabilities(await res.json());
          if (caps) recordCapabilities(model, caps, now);
        } catch {
          // keep the fallback lists
        }
      }),
  );
}
