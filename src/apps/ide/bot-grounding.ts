// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Bits don't write made-up facts or figures. A market-notes bit on a small network model wrote a
 * daily snapshot with economic figures, then said "I made up some of the PCE figures in that
 * snapshot — I shouldn't do that. Let me search for the actual news before finalizing."
 *
 *   - groundingRules: the system prompt's rules (facts and figures come from a tool result in this
 *     run; "unknown" otherwise; search before writing).
 *   - GroundingGuard: a cheap check after the run. Data-like figures (decimals, percentages, prices,
 *     comma-grouped amounts) the bit wrote into a notes/data file, a pull request or its reply that
 *     appear in no tool result, message, instruction or memory of the run get a soft warning in the
 *     run log ("figures not found in any source this run"). Only when the bit had a web or data
 *     tool, and never blocking a write.
 *   - Self-admission: when the bit says it made something up, the files it wrote before that are
 *     suspect. The next tool result tells it to correct them in this run; any it doesn't rewrite
 *     mark the run as needing review.
 */

import { extname } from "node:path";

/** The grounding rules in every bit's system prompt. */
export function groundingRules(): string {
  return [
    `Facts and figures:`,
    `- Facts, numbers, prices, rates, dates and quotes about the outside world must come from a tool result in this run: a web search or page read, a script's or command's output, or a file you read. Your memory and the user's messages count too.`,
    `- If you can't get one, write "unknown" (or leave it out) and say so in your summary.`,
    `- Never estimate, recall figures from your own knowledge or use placeholder numbers as if they were real.`,
    `- Search or run the script first, then write. Don't write a figure and check it later.`,
    `- If you notice you wrote something you made up, fix that file in this run with sourced figures or "unknown" before you finish.`,
  ].join("\n");
}

/** The short reminder in each run prompt nobody typed (runPrompt). */
export const GROUNDING_REMINDER = `Any facts or figures you write must come from your tools in this run (search first); if you can't get one, write "unknown".`;

/** A data-like figure in text: "$412.30", "2.4%", "3.1", "215,000", "$2.5B". */
export interface Figure {
  raw: string;
  value: number;
  /** Digits after the decimal point (a source number matches when it rounds to the same value). */
  decimals: number;
}

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
/**
 * A number not inside a word, path or version ("v1.2", "1.2.3", "file2.5"), with an optional
 * currency sign, percent sign or scale suffix.
 */
const FIGURE = new RegExp(String.raw`(?<![\w.,/:])(?:([$€£¥])\s?)?(${NUM})(?:\s?(%)|(?:[kKmMbBtT]|bn|mn)(?![\w]))?(?![\w]|[.,:]\d)`, "g");
/** Every number in a source, for matching ("2.4", "215,000", "1,234.5"). */
const SOURCE_NUM = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * The data-like figures in text: decimals, percentages, prices and comma-grouped amounts. Plain
 * integers (counts, line numbers, years, list markers) are left out, as are versions and dates.
 */
export function dataFigures(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const [raw, currency, num, percent] = m;
    const decimalPart = num.split(".")[1];
    if (!currency && !percent && decimalPart === undefined && !num.includes(",")) continue;
    const value = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    out.push({ raw: raw.trim(), value, decimals: decimalPart?.length ?? 0 });
  }
  return out;
}

/** The numbers seen in a run's sources, matched at each figure's precision. */
export class SourceIndex {
  private values = new Set<number>();
  private byDecimals = new Map<number, Set<string>>();

  add(text: string | undefined | null): void {
    if (!text) return;
    for (const m of text.matchAll(SOURCE_NUM)) {
      const v = Number(m[0].replace(/,/g, ""));
      if (Number.isFinite(v) && !this.values.has(v)) {
        this.values.add(v);
        for (const [d, set] of this.byDecimals) set.add(v.toFixed(d));
      }
    }
  }

  /** A source number equal to the figure, or rounding to it ("2.437" grounds "2.44"). */
  has(f: Figure): boolean {
    let set = this.byDecimals.get(f.decimals);
    if (!set) {
      set = new Set([...this.values].map((v) => v.toFixed(f.decimals)));
      this.byDecimals.set(f.decimals, set);
    }
    return set.has(f.value.toFixed(f.decimals));
  }
}

/** The figures in `text` found in no source (and not already in `before`, the file as it was). Deduped, in order. */
export function ungroundedFigures(text: string, sources: SourceIndex, before = ""): string[] {
  const prior = new SourceIndex();
  prior.add(before);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of dataFigures(text)) {
    if (seen.has(f.raw) || sources.has(f) || (before && prior.has(f))) continue;
    seen.add(f.raw);
    out.push(f.raw);
  }
  return out;
}

/**
 * The model saying it made something up ("I made up some of the PCE figures", "those numbers were
 * placeholders"). Negated forms ("I didn't make up") don't match.
 */
const ADMISSION = [
  /\bI(?:'ve|\s+have|\s+just)?\s+(?:made\s+up|fabricated|invented|hallucinated|guessed\s+at)\b/i,
  /\b(?:figures|numbers|data|values|prices|quotes|stats|statistics|rates|estimates)\b(?:\s+\w+){0,4}?\s+(?:were|was|are|is)\s+(?:just\s+|all\s+)?(?:made[\s-]up|fabricated|invented|hallucinated|placeholders?|not\s+real)\b/i,
];

export function admitsFabrication(text: string): boolean {
  return ADMISSION.some((r) => r.test(text));
}

/** Files whose figures are worth checking: notes and data, not code (a constant like 0.5 is no claim). */
const CHECKED_EXT = new Set(["", ".md", ".markdown", ".mdx", ".txt", ".text", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".html", ".htm", ".rst", ".adoc", ".org", ".log"]);

export function isCheckedFile(path: string): boolean {
  return CHECKED_EXT.has(extname(path).toLowerCase());
}

/** The tools that give a bit facts to write from: with none of them, the figure check stays off. */
export const DATA_TOOLS = ["web_search", "read_page", "run_shell"];
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const MESSAGE_TOOLS = new Set(["github_create_pr", "open_pull_request"]);
/** Kept per written file for the end-of-run check. */
const MAX_KEPT = 200_000;
const MAX_LISTED = 6;

export interface GroundingWarning {
  message: string;
  /** The run needs the user's review (it said it made something up and didn't correct it). */
  review?: true;
}

interface Written {
  text: string;
  before: string;
  /** Checked for figures (a notes/data file or a message), not code. */
  checked: boolean;
}

/**
 * One run's grounding guard (agentBotRunner). Feed it the model's text (`text`) and each tool call
 * (`before`, then `after` with its result), then call `finish` for the run's warnings.
 */
export class GroundingGuard {
  private sources = new SourceIndex();
  private written = new Map<string, Written>();
  /** Model text not yet looked at for an admission. */
  private pending = "";
  /** Model text since the last tool call: the final reply at the end. */
  private tail = "";
  /** Files written since the last admission (an admission makes them suspect). */
  private recent = new Set<string>();
  /** Files written before an admission and not rewritten since. */
  private suspect = new Set<string>();
  private nudged = false;
  private readBefore: (path: string) => string | null;
  readonly checkFigures: boolean;

  constructor(opts: {
    /** A web or data tool was available this run. */
    checkFigures: boolean;
    /** The run's own inputs: the conversation, instructions and memory. */
    seed?: string[];
    /** A file's text before the run wrote it (figures already there aren't new). */
    readBefore?: (path: string) => string | null;
  }) {
    this.checkFigures = opts.checkFigures;
    for (const s of opts.seed ?? []) this.sources.add(s);
    this.readBefore = opts.readBefore ?? (() => null);
  }

  /** The model's streamed text. */
  text(chunk: string): void {
    this.pending += chunk;
    this.tail += chunk;
    if (this.pending.length > 20_000) this.pending = this.pending.slice(-10_000);
    if (this.tail.length > MAX_KEPT) this.tail = this.tail.slice(-MAX_KEPT);
  }

  /** Looks for an admission in the text since the last look: what it wrote since the last one becomes suspect. */
  private scan(): void {
    if (!this.pending) return;
    const text = this.pending;
    this.pending = "";
    if (!admitsFabrication(text)) return;
    this.nudged = false;
    for (const p of this.recent) this.suspect.add(p);
    this.recent.clear();
  }

  /** Before a tool call runs. */
  before(): void {
    this.scan();
    this.tail = "";
  }

  /**
   * After a tool call: its result is a source (unless it was the bit's own write); writes are kept
   * for the check. Returns the result, once with a nudge to correct the suspect files.
   */
  after(tool: string, args: Record<string, unknown>, result: string): string {
    const failed = /^\[(Error|Refused)\]/.test(result) || /rejected by the user/.test(result);
    if (WRITE_TOOLS.has(tool) || MESSAGE_TOOLS.has(tool)) {
      if (!failed) this.record(tool, args);
    } else if (tool !== "remember" && tool !== "follow_up") {
      this.sources.add(result);
    }
    if (this.suspect.size && !this.nudged) {
      this.nudged = true;
      return `${result}\n\n[Note]: You said you made something up. Before you finish, correct ${[...this.suspect].join(", ")} in this run with figures from a source you got in this run, or write "unknown" where you couldn't get them.`;
    }
    return result;
  }

  private record(tool: string, args: Record<string, unknown>): void {
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const path = MESSAGE_TOOLS.has(tool) ? "the pull request" : str(args.path);
    if (!path) return;
    if (MESSAGE_TOOLS.has(tool)) {
      this.written.set(path, { text: [str(args.title), str(args.body)].join("\n").slice(0, MAX_KEPT), before: "", checked: true });
    } else {
      const prev = this.written.get(path);
      const before = prev ? prev.before : (this.readBefore(path) ?? "").slice(0, MAX_KEPT);
      if (tool === "edit_file") {
        // What the edit adds; the text it replaced was already there.
        const text = `${prev?.text ?? ""}\n${str(args.new_string)}`.slice(-MAX_KEPT);
        this.written.set(path, { text, before: `${before}\n${str(args.old_string)}`.slice(-MAX_KEPT), checked: isCheckedFile(path) });
      } else {
        this.written.set(path, { text: str(args.content).slice(0, MAX_KEPT), before, checked: isCheckedFile(path) });
      }
    }
    this.recent.add(path);
    // Rewritten after the admission: corrected (the figure check still applies).
    this.suspect.delete(path);
  }

  /** The run's warnings: suspect files left as they were, then unverified figures. */
  finish(): GroundingWarning[] {
    this.scan();
    const warnings: GroundingWarning[] = [];
    const list = (xs: string[]) => `${xs.slice(0, MAX_LISTED).join(", ")}${xs.length > MAX_LISTED ? ` and ${xs.length - MAX_LISTED} more` : ""}`;
    if (this.suspect.size) {
      warnings.push({ review: true, message: `Needs review: the bit said it made something up and didn't correct ${list([...this.suspect])} in this run.` });
    }
    if (this.checkFigures) {
      for (const [path, w] of this.written) {
        if (!w.checked || this.suspect.has(path)) continue;
        const figs = ungroundedFigures(w.text, this.sources, w.before);
        if (figs.length) warnings.push({ message: `Unverified figures in ${path}: ${list(figs)} (figures not found in any source this run). Check them before relying on it.` });
      }
      const figs = ungroundedFigures(this.tail, this.sources);
      if (figs.length) warnings.push({ message: `Unverified figures in the reply: ${list(figs)} (figures not found in any source this run).` });
    }
    return warnings;
  }
}
