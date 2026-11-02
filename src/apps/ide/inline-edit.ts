// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Inline edit (Cmd+K in the editor): rewrite the selected code, or write new code at the cursor,
 * from a one-line instruction. The model sees the code around the selection and returns only the
 * replacement; the editor shows it as a diff to accept or reject.
 */

export interface InlineEditRequest {
  path: string;
  language: string;
  /** Code before the selection (the editor sends up to a few thousand characters). */
  prefix: string;
  /** The selected code; empty to insert at the cursor. */
  selection: string;
  suffix: string;
  instruction: string;
}

export function inlineEditMessages(r: InlineEditRequest): Array<{ role: "system" | "user"; content: string }> {
  const task = r.selection
    ? "Rewrite the code between <selection> and </selection> as the instruction asks."
    : "Write the code to insert at <cursor/>, as the instruction asks.";
  const system = [
    "You are a code editor. You change exactly one region of a file.",
    task,
    "Reply with ONLY the new code for that region: no explanation, no markdown fences, nothing before or after it.",
    "Keep the surrounding indentation and the file's style. Do not repeat the code outside the region.",
  ].join("\n");
  const region = r.selection ? `<selection>\n${r.selection}\n</selection>` : "<cursor/>";
  const user = [
    `File: ${r.path} (${r.language})`,
    "",
    `${r.prefix}${region}${r.suffix}`,
    "",
    `Instruction: ${r.instruction}`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * The model's reply as replacement text: strips a wrapping ``` fence or <selection> tags it may
 * add anyway, and keeps the selection's trailing newline convention.
 */
export function cleanInlineEdit(reply: string, selection: string): string {
  let out = reply.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
  const fence = out.match(/^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/);
  if (fence) out = fence[1];
  out = out.replace(/^\s*<selection>\n?/, "").replace(/\n?<\/selection>\s*$/, "");
  if (!selection) return out.replace(/^\n+/, "").replace(/\s+$/, "");
  const wantsNewline = selection.endsWith("\n");
  out = out.replace(/\s+$/, "");
  return wantsNewline ? `${out}\n` : out;
}
