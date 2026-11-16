// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Tool calls a model wrote as text instead of calling the tool. Small models (qwen2.5-coder:7b and
 * the like) often reply with the call's JSON rather than a native tool call:
 *
 *   {"name": "list_directory", "arguments": {"path": "."}}
 *   ```json\n{"name": "read_file", "arguments": {"path": "README.md"}}\n```
 *   <tool_call>{"name": "git_status", "arguments": {}}</tool_call>
 *
 * and several of them in a row. Left alone, the JSON shows up in the reply and the turn just ends.
 * TextToolCallFilter finds them in a streamed reply, keeps them off the screen and hands them back
 * so the agent loop runs them as real tool calls (with the usual permission checks).
 *
 * Strict on purpose: only an object that is nothing but a call (name + object arguments, a few
 * known wrapper keys) to a tool the model was offered counts. Anything else, an unknown name,
 * malformed JSON or JSON inside another language's code fence, stays text. Only the model's own
 * reply is ever parsed, never what the user typed.
 */

export interface TextToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const CALL_KEYS = new Set(["name", "tool", "arguments", "parameters", "args", "id", "type", "function"]);
const CALL_FENCES = new Set(["", "json", "jsonc", "tool_call", "tool_code", "tool"]);
const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
/** A candidate that hasn't closed after this many characters is text, not a call. */
const MAX_HELD = 100_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One parsed JSON value as a call to a known tool, or null. */
export function asToolCall(value: unknown, known: ReadonlySet<string>): TextToolCall | null {
  if (!isObject(value)) return null;
  let o = value;
  // OpenAI shape: {"type": "function", "function": {"name": …, "arguments": …}}
  if (isObject(o.function) && !("name" in o) && !("tool" in o)) {
    if (Object.keys(o).some((k) => k !== "function" && k !== "type" && k !== "id")) return null;
    o = o.function;
  }
  if (Object.keys(o).some((k) => !CALL_KEYS.has(k))) return null;
  const name = typeof o.name === "string" ? o.name : typeof o.tool === "string" ? o.tool : null;
  if (!name || !known.has(name)) return null;
  let args = "arguments" in o ? o.arguments : "parameters" in o ? o.parameters : "args" in o ? o.args : undefined;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!isObject(args)) return null;
  return { name, arguments: args };
}

/** Index just past the bracket matching the one at `start` (strings respected), or -1 if it isn't closed yet. */
function matchBracket(s: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -2; // mismatched: not JSON
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * A block's body as calls: one call, a JSON list of calls, or several call objects in a row
 * (separated by whitespace or commas). null unless every part is a call to a known tool.
 */
export function parseCallsBody(body: string, known: ReadonlySet<string>): TextToolCall[] | null {
  const calls: TextToolCall[] = [];
  let i = 0;
  const skip = () => {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
  };
  skip();
  if (i >= body.length) return null;
  while (i < body.length) {
    if (body[i] !== "{" && body[i] !== "[") return null;
    const end = matchBracket(body, i);
    if (end < 0) return null;
    let value: unknown;
    try {
      value = JSON.parse(body.slice(i, end));
    } catch {
      return null;
    }
    for (const v of Array.isArray(value) ? value : [value]) {
      const call = asToolCall(v, known);
      if (!call) return null;
      calls.push(call);
    }
    i = end;
    skip();
  }
  return calls.length ? calls : null;
}

type Candidate =
  | { kind: "pending" }
  /** Text through `end`; `fence` when it opened a code fence that isn't a call. */
  | { kind: "text"; end: number; fence?: boolean }
  | { kind: "call"; end: number; calls: TextToolCall[] };

function atLineStart(s: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (s[j] === " " || s[j] === "\t")) j--;
  return j < 0 || s[j] === "\n";
}

/**
 * Splits a streamed reply into the text to show and the tool calls written in it. push() returns
 * the text that can be shown now (a possible call is held back until it's known either way);
 * end() returns the rest. `calls` and `text` hold everything found and shown so far.
 */
export class TextToolCallFilter {
  readonly calls: TextToolCall[] = [];
  text = "";
  /** Whether any reply text came through push(). */
  streamed = false;
  private buf = "";
  private pos = 0;
  /** Inside a code fence of another language: no calls until it closes. */
  private inFence = false;
  /** A call was just removed: drop the whitespace that followed it. */
  private trimNext = false;

  constructor(private readonly known: ReadonlySet<string>) {}

  push(delta: string): string {
    if (!delta) return "";
    this.streamed = true;
    this.buf += delta;
    return this.scan(false);
  }

  end(): string {
    return this.scan(true);
  }

  private out(s: string): string {
    if (this.trimNext) {
      s = s.replace(/^\s+/, "");
      if (s) this.trimNext = false;
    }
    this.text += s;
    return s;
  }

  /** How much of the buffer from `from` can be shown before a marker that may still be arriving. */
  private safeEnd(from: number, final: boolean): number {
    const s = this.buf;
    if (final) return s.length;
    let end = s.length;
    // A line that may be the start of a fence ("`", "``").
    const nl = s.lastIndexOf("\n") + 1;
    const line = s.slice(Math.max(nl, from));
    if (/^[ \t]*`{1,3}$/.test(line) && atLineStart(s, s.length - line.replace(/^[ \t]*/, "").length)) end = Math.min(end, Math.max(nl, from));
    // A tag that may be "<tool_call>".
    const lt = s.lastIndexOf("<");
    if (lt >= from && s.length - lt < OPEN_TAG.length && OPEN_TAG.startsWith(s.slice(lt))) end = Math.min(end, lt);
    return Math.max(from, end);
  }

  private nextCandidate(from: number): number {
    const s = this.buf;
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (c === "{" || c === "[") return i;
      if (c === "<" && s.startsWith(OPEN_TAG, i)) return i;
      if (c === "`" && s.startsWith("```", i) && atLineStart(s, i)) return i;
    }
    return -1;
  }

  private fenceClose(from: number): number {
    const s = this.buf;
    let i = from;
    for (;;) {
      const at = s.indexOf("```", i);
      if (at < 0) return -1;
      if (atLineStart(s, at)) return at;
      i = at + 3;
    }
  }

  private candidate(c: number, final: boolean): Candidate {
    const s = this.buf;
    const held = s.length - c;
    const tooLong = held > MAX_HELD;
    if (s[c] === "{" || s[c] === "[") {
      let j = c + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j >= s.length) return final ? { kind: "text", end: s.length } : { kind: "pending" };
      if (s[c] === "{" ? s[j] !== '"' : s[j] !== "{") return { kind: "text", end: c + 1 };
      const end = matchBracket(s, c);
      if (end === -2) return { kind: "text", end: c + 1 };
      if (end === -1) return final || tooLong ? { kind: "text", end: c + 1 } : { kind: "pending" };
      const calls = parseCallsBody(s.slice(c, end), this.known);
      return calls ? { kind: "call", end, calls } : { kind: "text", end: c + 1 };
    }
    if (s[c] === "<") {
      const close = s.indexOf(CLOSE_TAG, c + OPEN_TAG.length);
      if (close < 0) {
        if (!final && !tooLong) return { kind: "pending" };
        // The model stopped before closing the tag.
        const calls = final ? parseCallsBody(s.slice(c + OPEN_TAG.length), this.known) : null;
        return calls ? { kind: "call", end: s.length, calls } : { kind: "text", end: c + OPEN_TAG.length };
      }
      const calls = parseCallsBody(s.slice(c + OPEN_TAG.length, close), this.known);
      // Not JSON calls (qwen3-coder's <function=…> XML, say): text, for the loop's own block parser.
      return calls ? { kind: "call", end: close + CLOSE_TAG.length, calls } : { kind: "text", end: close + CLOSE_TAG.length };
    }
    // A code fence.
    const nl = s.indexOf("\n", c);
    if (nl < 0) return final ? { kind: "text", end: s.length } : { kind: "pending" };
    const lang = s.slice(c + 3, nl).trim().toLowerCase();
    if (!CALL_FENCES.has(lang)) return { kind: "text", end: nl + 1, fence: true };
    const close = this.fenceClose(nl + 1);
    if (close < 0) {
      if (!final && !tooLong) return { kind: "pending" };
      const calls = final ? parseCallsBody(s.slice(nl + 1), this.known) : null;
      return calls ? { kind: "call", end: s.length, calls } : { kind: "text", end: nl + 1, fence: true };
    }
    let end = close + 3;
    const eol = s.indexOf("\n", end);
    if (eol >= 0 && !s.slice(end, eol).trim()) end = eol + 1;
    else if (eol < 0 && !s.slice(end).trim()) end = s.length;
    const calls = parseCallsBody(s.slice(nl + 1, close), this.known);
    return calls ? { kind: "call", end, calls } : { kind: "text", end };
  }

  private scan(final: boolean): string {
    let shown = "";
    const s = () => this.buf;
    while (this.pos < s().length) {
      if (this.inFence) {
        const close = this.fenceClose(this.pos);
        if (close < 0) {
          const end = this.safeEnd(this.pos, final);
          shown += this.out(s().slice(this.pos, end));
          this.pos = end;
          break;
        }
        const end = close + 3;
        shown += this.out(s().slice(this.pos, end));
        this.pos = end;
        this.inFence = false;
        continue;
      }
      const c = this.nextCandidate(this.pos);
      if (c < 0) {
        const end = this.safeEnd(this.pos, final);
        shown += this.out(s().slice(this.pos, end));
        this.pos = end;
        break;
      }
      shown += this.out(s().slice(this.pos, c));
      this.pos = c;
      const r = this.candidate(c, final);
      if (r.kind === "pending") break;
      if (r.kind === "text") {
        shown += this.out(s().slice(c, r.end));
        this.pos = r.end;
        if (r.fence) this.inFence = true;
        continue;
      }
      this.calls.push(...r.calls);
      this.pos = r.end;
      this.trimNext = true;
    }
    return shown;
  }
}

/** The tool calls written as text in a finished reply, and the reply without them. */
export function extractTextToolCalls(text: string, known: ReadonlySet<string>): { text: string; calls: TextToolCall[] } {
  const f = new TextToolCallFilter(known);
  f.push(text);
  f.end();
  return { text: f.text, calls: f.calls };
}
