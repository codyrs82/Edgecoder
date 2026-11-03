// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Tab autocomplete: a small, fast code model fills in the middle (Ollama /api/generate with a
 * `suffix`), so it sees the code after the cursor too. General chat models (qwen3.5) refuse
 * fill-in-the-middle; the default is a coder model built for it.
 */

import { request } from "undici";

export const DEFAULT_COMPLETION_MODEL = "qwen2.5-coder:1.5b";
const MAX_LINES = 12;

export type CompletionResult =
  | { completion: string; model: string }
  | { completion: ""; model: string; reason: "model_missing" | "unsupported" | "error"; message: string };

/**
 * Trim a fill-in-the-middle result: stop where it starts repeating the code after the cursor,
 * and keep at most MAX_LINES lines.
 */
export function cleanCompletion(completion: string, suffix: string): string {
  let out = completion.replace(/\r/g, "");
  const nextLine = suffix.replace(/^\n+/, "").split("\n")[0]?.trim();
  if (nextLine && nextLine.length >= 3) {
    const lines = out.split("\n");
    const idx = lines.findIndex((l, i) => i > 0 && l.trim() === nextLine);
    if (idx > 0) out = lines.slice(0, idx).join("\n");
  }
  // The rest of the current line, when the model repeats it at the end of a one-line completion.
  const restOfLine = suffix.split("\n")[0];
  if (restOfLine.trim() && !out.includes("\n") && out.endsWith(restOfLine)) out = out.slice(0, -restOfLine.length);
  const lines = out.split("\n");
  if (lines.length > MAX_LINES) out = lines.slice(0, MAX_LINES).join("\n");
  return out.replace(/\s+$/, (ws) => (ws.includes("\n") ? "" : ws));
}

export async function completeAt(
  ollamaHost: string,
  input: { prefix: string; suffix: string; model?: string },
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const model = input.model || process.env.IDE_COMPLETION_MODEL || DEFAULT_COMPLETION_MODEL;
  const res = await request(`${ollamaHost}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: input.prefix,
      suffix: input.suffix,
      stream: false,
      keep_alive: "30m",
      options: { temperature: 0.2, num_predict: 128, stop: ["\n\n\n"] },
    }),
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
    signal,
  });
  const payload = (await res.body.json().catch(() => ({}))) as { response?: string; error?: string };
  if (res.statusCode >= 400 || payload.error) {
    const message = payload.error ?? `HTTP ${res.statusCode}`;
    if (/not found|pull/i.test(message)) {
      return { completion: "", model, reason: "model_missing", message: `Autocomplete needs ${model}: run \`ollama pull ${model}\` or download it in Models.` };
    }
    if (/does not support insert/i.test(message)) {
      return { completion: "", model, reason: "unsupported", message: `${model} can't complete code in place; use a coder model such as ${DEFAULT_COMPLETION_MODEL}.` };
    }
    return { completion: "", model, reason: "error", message };
  }
  return { completion: cleanCompletion(payload.response ?? "", input.suffix), model };
}
