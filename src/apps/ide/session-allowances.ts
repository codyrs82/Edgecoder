// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * "Allow for this session" (docs/permission-modes.md): one answer approves the call that asked and
 * lets later calls of the same kind run without asking until the session ends (a bot: until the run
 * ends). Nothing is written to disk: allowances live in this provider's memory, end with the session
 * (or the provider), and lapse after ALLOWANCE_IDLE_MS without use.
 *
 * Kinds (allowanceOffer):
 *   shell     a command's "always allow" rules, kept for the session only (`npm test:*` covers
 *             `npm test …`; a command line needs every part that isn't read-only covered). Same
 *             limits as "Always allow" (permission-policy.ts rememberable): never a refused command,
 *             network beyond a plain git fetch/pull, push, deletes, secrets or paths outside the project.
 *   inline    one interpreter's inline scripts: `python3 -c '…'`, `node -e '…'`, `python3 - <<'EOF'`.
 *             Only a single invocation with nothing around it, the code single-quoted (or a quoted
 *             here-doc tag, or an unquoted one with no `$(…)` or backticks), and no path outside the
 *             project or secret in the code.
 *   edits     write_file / edit_file inside the project, off protected paths and secrets files.
 *   commit    git_commit on the current work branch (never a default branch like main).
 *   git_branch, web    the local branch tool and the web tool (web search, page reads).
 * Never offered: pushes, pull requests (ALWAYS_ASK), cost checks, a call the mode refuses, or one
 * the classifier refuses (callers only consult this for an "ask" verdict).
 *
 * The web-page guard (agent-loop.ts makeToolRunner) still applies on top: a call an allowance runs
 * asks again after a web page was read this run, and one that runs a file the run edited is never
 * covered by "Allow for the rest of this run" (edited-runs.ts).
 */

import { resolve } from "node:path";
import { containsSecret, DEFAULT_BRANCHES, isSecretPath, suggestToolRules, classifyCommand, type Decision } from "./permission-policy.js";
import { isWithin, protectedToolPath, realPathEscape } from "./tool-executor.js";
import { WEB_TOOLS, type ToolName } from "./tool-types.js";

/** Allowances lapse after this long without being granted or used. */
export const ALLOWANCE_IDLE_MS = 12 * 60 * 60_000;
/** Kinds kept per session (the oldest go first). */
export const MAX_KINDS_PER_SESSION = 64;
/** Sessions tracked at once (the least recently used go first). */
export const MAX_ALLOWANCE_SESSIONS = 500;

export interface AllowanceContext {
  root: string;
  /** The current branch (asked lazily: only commands and commits need it). */
  branch?: () => string | null;
}

/** What "Allow for this session" covers for a call: its kinds (all must be allowed) and a label for the button. */
export interface AllowanceOffer {
  keys: string[];
  label: string;
}

const INLINE_FLAGS: Record<string, RegExp> = {
  python: /^-c$/,
  node: /^(-e|--eval|-p|--print)$/,
  ruby: /^-e$/,
  perl: /^-[eE]$/,
  bun: /^(-e|--eval)$/,
  deno: /^eval$/,
};

function interpreterFamily(name: string): string | null {
  if (/^python(\d+(\.\d+)?)?$/.test(name)) return "python";
  return Object.prototype.hasOwnProperty.call(INLINE_FLAGS, name) ? name : null;
}

/** Code that names a place outside the project (home, absolute system paths, parent folders). */
const OUTSIDE_IN_CODE = /(^|[\s'"`(=,:[{])(~(\/|$|["'\s])|\.\.(\/|\\)|\/(Users|home|etc|var|private|root|tmp|System|Library|opt|usr|bin|sbin|dev|Volumes|proc|mnt|srv)(\/|\b))|expanduser|getenv\(\s*["']HOME|environ\[\s*["']HOME|homedir\(|process\.env\.HOME|ENV\[\s*["']HOME/;

function codeIsContained(code: string): boolean {
  return !OUTSIDE_IN_CODE.test(code) && !containsSecret(code);
}

/**
 * The interpreter whose inline script this command is (`python3`), or null: one invocation of a
 * known interpreter with its code given inline, nothing else on the line.
 */
export function inlineScriptOf(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const c = command.replace(/\r\n/g, "\n").trim();
  if (!c || c.length > 64 * 1024) return null;
  const nl = c.indexOf("\n");
  const first = nl < 0 ? c : c.slice(0, nl);
  // `python3 -c '…'` (single-quoted: nothing in it is expanded by the shell), optionally `2>&1`.
  const flagged = /^([A-Za-z][\w.]*)((?:\s+-[A-Za-z]+)*?)\s+(-[A-Za-z]|--eval|--print|eval)\s+'([^']*)'(\s+2>&1)?$/s.exec(c);
  if (flagged) {
    const [, bin, pre, flag, code] = flagged;
    const family = interpreterFamily(bin);
    if (!family || !INLINE_FLAGS[family].test(flag)) return null;
    // Only harmless flags before it (-u, -I, -B, -X…): no -m, no --require.
    if (pre.trim() && !pre.trim().split(/\s+/).every((f) => /^-[uIBEsSOqW]+$/.test(f))) return null;
    return codeIsContained(code) ? bin : null;
  }
  // `python3 - <<'EOF'` … `EOF` (a here-doc fed to the interpreter, the whole command).
  const head = /^([A-Za-z][\w.]*)((?:\s+-[A-Za-z]+)*?)(\s+-)?\s*<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\5(\s+2>&1)?\s*$/.exec(first);
  if (!head || nl < 0) return null;
  const [, bin, pre, , dash, quote, tag] = head;
  const family = interpreterFamily(bin);
  if (!family || family === "deno") return null;
  if (pre.trim() && !pre.trim().split(/\s+/).every((f) => /^-[uIBEsSOqW]+$/.test(f))) return null;
  const lines = c.slice(nl + 1).split("\n");
  const end = (l: string) => (dash ? l.replace(/^\t+/, "") : l) === tag;
  const at = lines.findIndex(end);
  // The terminator must be the last line: nothing may run after the script.
  if (at < 0 || at !== lines.length - 1) return null;
  const body = lines.slice(0, at).join("\n");
  // An unquoted tag expands `$(…)` and backticks in the body (shell commands): not covered.
  if (!quote && /\$\(|`/.test(body)) return null;
  return codeIsContained(body) ? bin : null;
}

function quoteRule(rule: string): string {
  return rule.replace(/:\*$/, "");
}

/**
 * What "Allow for this session" would cover for this call, or null when it can't be offered.
 * Callers consult it only for calls their mode asks about.
 */
export function allowanceOffer(tool: ToolName, args: Record<string, unknown>, ctx: AllowanceContext): AllowanceOffer | null {
  if (tool === "run_shell") {
    const branch = ctx.branch?.() ?? null;
    const cls = classifyCommand(args.command, { root: ctx.root, branch });
    if (cls.action === "refuse") return null;
    const rules = suggestToolRules(tool, args, { root: ctx.root, branch });
    if (rules.length) {
      return { keys: rules.map((r) => `shell:${r}`), label: `${rules.map((r) => quoteRule(r)).join(", ")} commands` };
    }
    const bin = inlineScriptOf(args.command);
    if (bin) return { keys: [`inline:${bin}`], label: `inline ${bin} scripts` };
    return null;
  }
  if (tool === "write_file" || tool === "edit_file") {
    const path = args.path;
    if (typeof path !== "string" || !path.trim() || path.startsWith("~")) return null;
    const abs = resolve(ctx.root, path);
    if (!isWithin(ctx.root, abs) || realPathEscape(ctx.root, abs) === "escape") return null;
    if (protectedToolPath(path) !== null || isSecretPath(path)) return null;
    if (containsSecret(tool === "write_file" ? args.content : args.new_string)) return null;
    return { keys: ["edits"], label: "edits inside the project" };
  }
  if (tool === "git_commit") {
    const b = ctx.branch?.() ?? null;
    if (!b || DEFAULT_BRANCHES.has(b) || args.amend === true) return null;
    return { keys: [`commit:${b}`], label: `git commits on ${b}` };
  }
  if (tool === "git_pull" || tool === "git_fetch") {
    const rules = suggestToolRules(tool, args, { root: ctx.root });
    return rules.length ? { keys: rules.map((r) => `shell:${r}`), label: `${rules.map((r) => quoteRule(r)).join(", ")} commands` } : null;
  }
  if (tool === "git_branch") return { keys: ["tool:git_branch"], label: "new local branches" };
  if (WEB_TOOLS.has(tool)) return { keys: ["web"], label: "web searches and page reads" };
  return null;
}

interface Held {
  kinds: Map<string, string>;
  touchedAt: number;
}

/** The allowances granted per session key (a hub session, a desktop chat, a bot run). In memory only. */
export class SessionAllowances {
  private readonly held = new Map<string, Held>();
  constructor(private readonly opts: { idleMs?: number; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private live(key: string): Held | null {
    const h = this.held.get(key);
    if (!h) return null;
    if (this.now() - h.touchedAt > (this.opts.idleMs ?? ALLOWANCE_IDLE_MS)) {
      this.held.delete(key);
      return null;
    }
    return h;
  }

  /** Allow the offer's kinds for the rest of `key`'s session. */
  grant(key: string, offer: AllowanceOffer): void {
    const h = this.live(key) ?? { kinds: new Map<string, string>(), touchedAt: this.now() };
    for (const k of offer.keys) {
      h.kinds.delete(k);
      h.kinds.set(k, offer.keys.length === 1 ? offer.label : quoteKey(k));
    }
    while (h.kinds.size > MAX_KINDS_PER_SESSION) h.kinds.delete(h.kinds.keys().next().value as string);
    h.touchedAt = this.now();
    this.held.delete(key);
    this.held.set(key, h);
    while (this.held.size > MAX_ALLOWANCE_SESSIONS) this.held.delete(this.held.keys().next().value as string);
  }

  /** True when every kind of the offer was allowed for `key` (and not lapsed); a hit keeps them alive. */
  has(key: string, offer: AllowanceOffer): boolean {
    const h = this.live(key);
    if (!h || !offer.keys.length || !offer.keys.every((k) => h.kinds.has(k))) return false;
    h.touchedAt = this.now();
    return true;
  }

  /** What `key` allows, as labels for the session's surfaces. */
  labels(key: string): string[] {
    const h = this.live(key);
    return h ? [...new Set(h.kinds.values())] : [];
  }

  clear(key: string): boolean {
    return this.held.delete(key);
  }
}

function quoteKey(k: string): string {
  if (k.startsWith("shell:")) return `${quoteRule(k.slice(6))} commands`;
  if (k.startsWith("inline:")) return `inline ${k.slice(7)} scripts`;
  if (k.startsWith("commit:")) return `git commits on ${k.slice(7)}`;
  if (k === "edits") return "edits inside the project";
  if (k === "web") return "web searches and page reads";
  if (k === "tool:git_branch") return "new local branches";
  return k;
}

/**
 * A verdict with the session's allowances applied: an "ask" the allowances cover runs (reason and
 * `sessionAllowed` say why); an "ask" they could cover carries `session` (the button's label).
 * "run" and "refuse" pass through untouched.
 */
export function withAllowances(base: Decision, allowances: SessionAllowances | null | undefined, key: string | null, tool: ToolName, args: Record<string, unknown>, ctx: AllowanceContext): Decision {
  if (base.action !== "ask") return base;
  const offer = allowanceOffer(tool, args, ctx);
  if (!offer) return base;
  if (allowances && key && allowances.has(key, offer)) return { action: "run", reason: `allowed for this session: ${offer.label}`, sessionAllowed: offer.label };
  return { ...base, session: offer.label };
}

/** The one registry this provider's chats, sessions and the phone share (sessions.ts, provider-server.ts). */
export const sharedAllowances = new SessionAllowances();
