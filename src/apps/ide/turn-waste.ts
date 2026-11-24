// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Waste inside one agent turn (agent-loop.ts): a lead re-reading the same files call after call,
 * or reading far more than it writes without changing anything. Seen on glm-5.3 in a big repo: 20
 * calls, 296K tokens read, 4.6K written, the same large files read again every step.
 *
 * Two things here:
 *
 * - Re-read dedupe. read_file of a path (same offset/limit) whose content is byte-identical to an
 *   earlier read, with that earlier result still in the conversation, returns a short pointer
 *   ("unchanged since step 3 … summary: …") instead of the whole file again. The file is still read
 *   (the content hash is what decides), so any change, by an edit, a command or anything else, gives
 *   the full content; a changed mtime/size (the optional `stamp`) does too. Once compaction has
 *   replaced the earlier result with its one-line label, the full content is sent again.
 *
 * - Waste signals: re-reads of a path with no edit in between, and a read/write ratio far above a
 *   working turn's (input ≫ output, no edits after RATIO_MIN_CALLS calls). The loop acts on the first
 *   signal (compacts older tool results, steers lookups to helpers when they're on); a signal that
 *   persists after that becomes "Switch to a cheaper model" in the next cost check (cost-guard.ts).
 */

import { createHash } from "node:crypto";

/** Re-reads (same path, no edit in between) before the turn counts as wasteful. */
export const REREAD_TRIGGER = 2;
/** Model calls before the read/write ratio is judged. */
export const RATIO_MIN_CALLS = 8;
/** Estimated input tokens per output token above which a turn with no edits reads too much. */
export const WASTE_RATIO = 40;
/** And at least this much read in all (a short Q&A turn is never "wasteful"). */
export const RATIO_MIN_INPUT = 100_000;
/** A result shorter than this is sent again as it is (the pointer saves next to nothing). */
export const DEDUPE_MIN_CHARS = 1_200;

interface ReadRecord {
  path: string;
  hash: string;
  stamp: string | null;
  /** The model call (1-based) after which it was read. */
  step: number;
  lines: number;
  summary: string;
  /** The conversation message holding the full result (attach). */
  ref?: object;
}

export type WasteState = "none" | "acted" | "persists";

/** One-line summary of a read_file result: its declarations, else its first lines. */
export function readSummary(result: string): string {
  const lines = result.split("\n").map((l) => l.replace(/^\s*\d+[\t|:]\s?/, "").trim()).filter(Boolean);
  const decl = lines.filter((l) => /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|def|fn|pub\s+fn|struct|impl|func|module)\b/.test(l));
  const pick = (decl.length ? decl : lines).slice(0, 4).map((l) => (l.length > 90 ? `${l.slice(0, 89)}…` : l));
  return pick.join(" | ").slice(0, 360);
}

function keyOf(args: Record<string, unknown>): { key: string; path: string } | null {
  const raw = args.path ?? args.file;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return { key: `${path}#${String(args.offset ?? "")}#${String(args.limit ?? "")}`, path };
}

export class TurnWaste {
  /** Model calls so far, and their estimated input and output tokens. */
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  /** write_file / edit_file calls in the turn. */
  edits = 0;
  /** Reads of a path already read with no edit to it in between. */
  rereads = 0;
  /** Re-reads answered with a pointer, and the tokens that saved. */
  skipped = 0;
  savedTokens = 0;
  private readonly skippedPaths = new Set<string>();
  private readonly reads = new Map<string, ReadRecord>();
  /** Paths read since their last edit (for the re-read count). */
  private readonly seen = new Set<string>();
  private state: WasteState = "none";
  private actedAt = { calls: 0, rereads: 0 };

  constructor(private readonly o: { stamp?: (path: string) => string | null } = {}) {}

  /** A model call finished: its estimated prompt and output tokens. */
  onCall(promptTokens: number, outputTokens: number): void {
    this.calls++;
    this.inputTokens += Math.max(0, promptTokens);
    this.outputTokens += Math.max(0, outputTokens);
  }

  /** A tool is about to run: an edit forgets what was read of that path. */
  beforeTool(tool: string, args: Record<string, unknown>): void {
    if (tool !== "write_file" && tool !== "edit_file") return;
    this.edits++;
    const k = keyOf(args);
    if (!k) return;
    this.seen.delete(k.path);
    for (const [key, r] of this.reads) if (r.path === k.path) this.reads.delete(key);
  }

  /**
   * A read_file result. Returns the text the model should see: the result itself, or a pointer when
   * the same read gave the same content earlier and that result is still in the conversation.
   */
  afterRead(args: Record<string, unknown>, result: string, inContext: (ref: object) => boolean): { text: string; key: string | null; deduped: boolean } {
    const k = keyOf(args);
    if (!k || result.startsWith("[Error]") || result.startsWith("[Rejected]") || result.startsWith("[Refused]")) return { text: result, key: null, deduped: false };
    if (this.seen.has(k.path)) this.rereads++;
    this.seen.add(k.path);
    const hash = createHash("sha256").update(result).digest("hex");
    let stamp: string | null = null;
    try {
      stamp = this.o.stamp?.(k.path) ?? null;
    } catch {
      stamp = null;
    }
    const prev = this.reads.get(k.key);
    const same = prev && prev.hash === hash && prev.stamp === stamp && prev.ref && inContext(prev.ref);
    if (same && result.length >= DEDUPE_MIN_CHARS) {
      const text = `[Unchanged since step ${prev.step}: ${k.path} is exactly what read_file returned at step ${prev.step} (${prev.lines} lines), and that result is still above in this conversation, so it isn't repeated here. Summary: ${prev.summary || "(no summary)"}. Use the earlier result; don't read this file again unless it changes.]`;
      this.skipped++;
      this.skippedPaths.add(k.path);
      this.savedTokens += Math.max(0, Math.ceil((result.length - text.length) / 3));
      return { text, key: null, deduped: true };
    }
    this.reads.set(k.key, { path: k.path, hash, stamp, step: this.calls, lines: result.split("\n").length, summary: readSummary(result) });
    return { text: result, key: k.key, deduped: false };
  }

  /** The conversation message that now holds a read's full result (the pointer refers to it). */
  attach(key: string, ref: object): void {
    const r = this.reads.get(key);
    if (r) r.ref = ref;
  }

  /** Why the turn looks wasteful now, or null. */
  signal(): string | null {
    if (this.rereads >= REREAD_TRIGGER) return `re-read ${this.rereads} file${this.rereads === 1 ? "" : "s"} it had already read`;
    if (this.edits === 0 && this.calls >= RATIO_MIN_CALLS && this.inputTokens >= RATIO_MIN_INPUT && this.inputTokens >= WASTE_RATIO * Math.max(1, this.outputTokens)) {
      return `read ${Math.round(this.inputTokens / 1000)}K tokens and wrote ${(this.outputTokens / 1000).toFixed(1)}K without changing anything`;
    }
    return null;
  }

  /** True once, the first time the turn looks wasteful: the loop acts then (compaction, helpers). */
  shouldAct(): boolean {
    if (this.state !== "none" || !this.signal()) return false;
    this.state = "acted";
    this.actedAt = { calls: this.calls, rereads: this.rereads };
    return true;
  }

  /**
   * After acting, the waste goes on: two more re-reads, or four more calls with still no edit and
   * the ratio still high. The reason, else null.
   */
  persists(): string | null {
    if (this.state === "persists") return this.signal() ?? "kept reading without changing anything";
    if (this.state !== "acted") return null;
    const moreRereads = this.rereads - this.actedAt.rereads >= REREAD_TRIGGER;
    const moreCalls = this.calls - this.actedAt.calls >= 4 && this.edits === 0 && this.inputTokens >= WASTE_RATIO * Math.max(1, this.outputTokens);
    if (!moreRereads && !moreCalls) return null;
    this.state = "persists";
    return this.signal() ?? "kept reading without changing anything";
  }

  /** "Skipped re-reading 3 unchanged files · ~90K tokens saved", or null when nothing was skipped. */
  savedLine(): string | null {
    if (!this.skipped) return null;
    const files = this.skippedPaths.size;
    const k = this.savedTokens >= 1000 ? `${Math.round(this.savedTokens / 1000)}K` : String(this.savedTokens);
    return `Skipped re-reading ${files} unchanged file${files === 1 ? "" : "s"} · ~${k} tokens saved`;
  }
}
