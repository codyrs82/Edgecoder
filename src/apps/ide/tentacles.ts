// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Tentacles: helper agents a session's lead spins off onto cheaper network models (docs/tentacles.md).
 *
 * The lead calls `delegate` (delegate.ts) with a scoped piece of work; it gets an id back at once
 * and keeps working. Each tentacle:
 *  - gets an isolated workspace: a git worktree of the lead's tree in a temp folder
 *    (tentacle-workspace.ts), or none for read-only work (search, summarize, readOnly), which reads
 *    the lead's tree with read tools only;
 *  - runs its own small agent loop (agent-loop.ts) on the worker model: the session's workerModel
 *    when it has one, else `auto` with job hints from the kind and complexity, so the
 *    coordinator's best-fit routing picks the model, class and machine;
 *  - sees a fresh, small context: the task, its instructions and the given files only;
 *  - runs its acceptance check in the workspace, niced;
 *  - on failure retries once on a stronger tier (quality best, complexity one level up);
 *  - comes back as a patch. A passed patch that applies cleanly to the lead's tree is applied as
 *    its own checkpoint (undoable) when the session lets edits apply on their own, or waits for
 *    the user's approval; conflicts and failed checks go back to the lead with the patch and errors.
 *
 * Limits per session: tentacles running at once (default 4; more wait in a queue), a cSat budget
 * for all of the session's tentacles, and each tentacle's own budget. Stopping or deleting the
 * session cancels its tentacles. Every step is a session event (tentacle_started / _progress /
 * _finished / _merge), and each finished tentacle is a transcript note.
 */

import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { runAgentLoop, type ChatFn, type ChatResult, type ToolSchema } from "./agent-loop.js";
import type { CheckpointStore } from "./checkpoints.js";
import { ProjectFs } from "./project-fs.js";
import { shellPrefix, workerModelOf, type SessionData, type TranscriptEntry } from "./sessions.js";
import { isReadOnlyCommand, riskOf } from "./permissions.js";
import { evaluateShellCommand, parseArgv, protectedToolPath, ToolExecutor } from "./tool-executor.js";
import { TOOL_DEFINITIONS, type IdeStreamEvent, type ToolName } from "./tool-types.js";
import {
  acceptanceCommand,
  applyPatch,
  checkPatch,
  createWorkspace,
  patchFiles,
  realOf,
  removeWorkspace,
  repoTop,
  resetWorkspace,
  runAcceptance,
  workspacePatch,
  type Acceptance,
  type CheckResult,
  type Workspace,
} from "./tentacle-workspace.js";
import type { ChatBackend } from "../../inference-api/types.js";
import type { ServedBy } from "../../swarm/served-by.js";
import type { RoutingHints, JobType, Quality } from "../../inference-api/job-descriptor.js";

export const TENTACLE_KINDS = ["tests", "code_edit", "search", "summarize", "docs", "review", "refactor_piece"] as const;
export type TentacleKind = (typeof TENTACLE_KINDS)[number];
export type TentacleComplexity = "low" | "medium" | "high";

export interface TentacleSpec {
  task: string;
  kind: TentacleKind;
  /** Paths, or ranges as path#Lx-Ly. */
  files: string[];
  instructions: string;
  acceptance?: Acceptance;
  complexity?: TentacleComplexity;
  budgetCSats?: number;
  readOnly?: boolean;
}

export type TentacleStatus = "queued" | "running" | "verifying" | "passed" | "failed" | "error" | "cancelled";

/** What became of a finished tentacle's patch in the lead's tree. */
export type MergeState =
  | "applied" // applied as its own checkpoint (undoable)
  | "awaiting_approval" // passed and applies cleanly; the user decides
  | "rejected" // the user said no
  | "conflict" // doesn't apply to the lead's tree as it is now
  | "not_applied" // failed or errored: reported to the lead, nothing applied
  | "no_changes"; // read-only, or nothing changed

export interface TentacleResult {
  status: "passed" | "failed" | "error";
  /** A git diff against the lead's tree when the tentacle started (empty for read-only). */
  patch: string;
  summary: string;
  filesTouched: string[];
  checks: CheckResult[];
  model: string;
  class: string;
  agentLabel: string;
  tokens: { prompt: number; output: number };
  cSats: number;
  durationMs: number;
  attempts: number;
  /** Each model call: where it ran (the coordinator's served-by), tokens and cSats. */
  calls: TentacleCall[];
  /** The acceptance check didn't run: the session's mode would ask first (helpers can't ask). */
  unverified?: string;
  error?: string;
}

/** One helper model call, as the session's `served` lines show it. */
export interface TentacleCall {
  cSats: number;
  where?: string;
  model: string;
  served?: ServedBy;
  promptTokens?: number;
  outputTokens?: number;
}

export interface TentacleView {
  id: string;
  sessionId: string;
  task: string;
  kind: TentacleKind;
  readOnly: boolean;
  status: TentacleStatus;
  /** The latest step ("edit_file src/a.ts", "running vitest", "retrying on a stronger tier"). */
  progress: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  cSats: number;
  model?: string;
  /** Model calls so far (each with its served line). */
  calls?: TentacleCall[];
  result?: TentacleResult;
  merge?: { state: MergeState; checkpointId?: string; error?: string };
}

export interface TentacleConfig {
  enabled: boolean;
  /** Tentacles running at once per session; more wait. */
  maxParallel: number;
  /** cSats all of a session's tentacles may spend. */
  budgetCSats: number;
  /** A tentacle's own budget when delegate doesn't say. */
  perTentacleCSats: number;
  /** "auto" (best-fit with job hints) or a model id (network/<m>[@class], mine/<m>, a local tag). */
  workerModel: string;
  /** Characters of file content a tentacle's prompt may carry (cheap models: 8-16K tokens). */
  maxContextChars: number;
}

export function tentacleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TentacleConfig {
  const num = (v: string | undefined, d: number, min: number, max: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  return {
    enabled: env.EDGECODER_TENTACLES === "1",
    maxParallel: Math.floor(num(env.EDGECODER_TENTACLES_MAX, 4, 1, 16)),
    budgetCSats: num(env.EDGECODER_TENTACLES_BUDGET_CSATS, 100, 0, 1e7),
    perTentacleCSats: num(env.EDGECODER_TENTACLE_CSATS, 25, 0, 1e7),
    workerModel: env.EDGECODER_TENTACLES_WORKER?.trim() || "auto",
    maxContextChars: Math.floor(num(env.EDGECODER_TENTACLE_CONTEXT_CHARS, 36_000, 4_000, 400_000)),
  };
}

/** What a session's tentacles need from the provider. */
export interface TentacleHost {
  /** The session (a copy), or null when it's gone. */
  session: (id: string) => SessionData | null;
  publishEvent: (id: string, ev: Record<string, unknown> & { type: string }) => void;
  recordNote: (id: string, note: Omit<TranscriptEntry, "id" | "role" | "at">) => TranscriptEntry | null;
}

export interface TentacleDeps {
  host: TentacleHost;
  /**
   * A backend for the worker model (`model` is "auto" or a network/local model id, never a
   * frontier one); hints ride on each request. It runs as the turn hook's worker role: it must
   * never carry the user's frontier key.
   */
  workerBackend: (model: string, sessionId: string, ctx: { role: "worker" }) => ChatBackend;
  checkpoints: CheckpointStore;
  config?: Partial<TentacleConfig>;
  /**
   * Whether a passed, clean patch may apply without asking: the same rule as the lead's own
   * write_file / edit_file (canAutoApply below). Override in tests only.
   */
  canAutoApply?: (s: SessionData, files: string[]) => boolean;
  /**
   * Whether the session would run this shell command without asking (the shared classifier:
   * read-only commands, "always" answers for the session or project, mode auto). Default:
   * sessionAllowsShell. Helpers can't ask, so anything this refuses is refused.
   */
  shellAllowed?: (s: SessionData, command: string) => boolean;
  /** The session's worker model (default tentacleWorkerModel). Never a frontier model: one becomes auto. */
  workerModelFor?: (s: SessionData, cfg: TentacleConfig) => string;
  /** Where workspaces go (default the OS temp folder). */
  tmpRoot?: string;
  /** Agent steps per attempt (default 12). */
  maxIterations?: number;
  /** Acceptance checks (default runAcceptance); tests swap it. */
  runCheck?: typeof runAcceptance;
}

export class TentacleError extends Error {
  constructor(readonly code: "disabled" | "budget" | "invalid" | "not_found", message: string) {
    super(message);
  }
}

interface Internal {
  view: TentacleView;
  spec: TentacleSpec;
  abort: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  /** Reported to the lead by await_tentacles. */
  reported: boolean;
  /** Spent by this tentacle (all attempts). */
  spent: number;
}

interface SessionState {
  config: TentacleConfig;
  tentacles: Map<string, Internal>;
  queue: string[];
  running: number;
  spent: number;
  /** Wakes await_tentacles callers when anything finishes. */
  waiters: Set<() => void>;
}

const LEVELS = ["low", "medium", "high", "very_high"] as const;
const READ_ONLY_KINDS: ReadonlySet<TentacleKind> = new Set(["search", "summarize"]);
const JOB_OF: Record<TentacleKind, JobType> = {
  tests: "tests",
  code_edit: "code_edit",
  search: "extract",
  summarize: "summarize",
  docs: "code_edit",
  review: "code_review",
  refactor_piece: "refactor",
};
const DEFAULT_COMPLEXITY: Record<TentacleKind, TentacleComplexity> = {
  tests: "medium",
  code_edit: "medium",
  search: "low",
  summarize: "low",
  docs: "low",
  review: "medium",
  refactor_piece: "medium",
};
const READ_TOOL_NAMES: ToolName[] = ["read_file", "list_directory", "search_files"];
const WRITE_TOOL_NAMES: ToolName[] = [...READ_TOOL_NAMES, "write_file", "edit_file", "run_shell", "git_diff", "git_status"];

/**
 * Commands a tentacle may run in its workspace without anyone approving: tests, type checks and
 * reading. Plain argv only (no shell syntax), paths inside the workspace.
 * Hook: when the terminal branch's read-only / allowlist classification lands, use it here.
 */
export const TENTACLE_SHELL_ALLOW: readonly string[][] = [
  ["npx", "vitest", "run"],
  ["npx", "tsc", "--noEmit"],
  ["npm", "test"],
  ["npm", "run", "test"],
  ["npm", "run", "lint"],
  ["npm", "run", "typecheck"],
  ["git", "diff"],
  ["git", "status"],
  ["ls"],
  ["cat"],
  ["grep"],
  ["rg"],
  ["head"],
  ["tail"],
  ["wc"],
];

/** The session's permission mode (older sessions: from autoApprove). */
export function modeOf(s: Pick<SessionData, "mode" | "autoApprove">): "ask" | "auto-edits" | "auto" {
  return s.mode ?? (s.autoApprove === "edits" ? "auto-edits" : "ask");
}

/**
 * A helper's patch applies on its own exactly when the lead's own edit to those files would: the
 * session's mode lets edits apply (auto-edits, auto) and no file is a protected path. Otherwise it
 * waits for the user's approval.
 */
export function canAutoApply(s: Pick<SessionData, "mode" | "autoApprove">, files: string[]): boolean {
  return modeOf(s) !== "ask" && files.every((f) => protectedToolPath(f) === null);
}

/**
 * Whether the session runs `command` without asking (SessionHub.allowedWithoutAsking without a
 * hub): read-only in any mode; otherwise never a risky one, and only in mode auto or for a
 * command name answered "always" for the session.
 */
export function sessionAllowsShell(s: Pick<SessionData, "mode" | "autoApprove" | "alwaysShell">, command: string, root: string): boolean {
  if (isReadOnlyCommand(command, root)) return true;
  if (riskOf(command, root) !== null) return false;
  if (modeOf(s) === "auto") return true;
  const prefix = shellPrefix(command);
  return prefix !== null && (s.alwaysShell ?? []).includes(prefix);
}

/**
 * Whether a tentacle may run `command` in `root`, and the command (niced) it runs as. The shared
 * classifier decides (permissions.ts): risky commands never run (they ask in every mode, and a
 * helper can't ask); read-only commands run; anything else must be on the tentacle allowlist AND
 * be something the session's mode runs without asking (`allowed`). A helper never goes past the
 * session's mode. `npx` runs with --no-install (the classifier checks the command without npx).
 */
export function tentacleShellDecision(command: unknown, root: string, allowed: (probe: string) => boolean = () => false): { ok: true; command: string } | { ok: false; reason: string } {
  if (typeof command !== "string" || !command.trim()) return { ok: false, reason: "command must be a non-empty string" };
  const probe = command.trim().replace(/^npx\s+(--no-install\s+)?/, "");
  const risk = riskOf(probe, root);
  if (risk) return { ok: false, reason: `risky (${risk}): it would ask in every mode, and a helper can't ask` };
  const policy = evaluateShellCommand(probe, { approved: false, root, env: { IDE_SHELL_ALLOW: "npm,git,ls,cat,grep,rg,head,tail,wc,vitest,tsc" } });
  if (!policy.allowed) return { ok: false, reason: policy.reason };
  let argv: string[];
  try {
    argv = parseArgv(command.trim());
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const nice = process.platform === "win32" ? "" : "nice -n 10 ";
  const run = command.trim().replace(/^npx\s+(--no-install\s+)?/, "npx --no-install ");
  if (isReadOnlyCommand(probe, root)) return { ok: true, command: `${nice}${run}` };
  if (!TENTACLE_SHELL_ALLOW.some((p) => p.every((w, i) => argv[i] === w))) return { ok: false, reason: `tentacles may only run read-only commands and: ${TENTACLE_SHELL_ALLOW.map((p) => p.join(" ")).join(", ")}` };
  if (!allowed(probe)) return { ok: false, reason: "the session's permission mode would ask before running this, and a helper can't ask; tell the lead to run it" };
  return { ok: true, command: `${nice}${run}` };
}

/** The acceptance check as the classifier sees it ("vitest run a.test.ts", "tsc --noEmit -p tsconfig.json", a grep). */
export function acceptanceProbe(a: Acceptance): string | null {
  const cmd = acceptanceCommand(a, "linux");
  if ("error" in cmd || !cmd.argv.length) return null;
  const argv = cmd.argv.filter((w, i) => !(i < 3 && ["nice", "-n", "10"].includes(w)));
  const i = argv[0] === "npx" ? (argv[1] === "--no-install" ? 2 : 1) : 0;
  return argv
    .slice(i)
    .map((w) => (/^[\w./:=@,+-]+$/.test(w) ? w : `'${w.replace(/'/g, "")}'`))
    .join(" ");
}

/**
 * The model a session's tentacles run on: the session's worker model (workerModelOf), or the
 * tentacle setting when the session's is auto. Never a frontier model (that would spend the user's
 * key for a helper): one becomes auto.
 */
export function tentacleWorkerModel(s: Pick<SessionData, "workerModel">, cfg: Pick<TentacleConfig, "workerModel">): string {
  const session = workerModelOf(s);
  if (session !== "auto") return session;
  return workerModelOf({ workerModel: cfg.workerModel });
}

/** Levels as complexity scores (job-complexity.ts LEVEL_SCORE). */
const LEVEL_SCORE: Record<(typeof LEVELS)[number], number> = { low: 0.15, medium: 0.4, high: 0.65, very_high: 0.9 };

/**
 * A helper job's complexity score, 0..1, for best-fit routing: its level (given or by kind), moved
 * by its size (prompt, files), whether it writes and must pass a check, and one level up on the
 * escalation retry. Small, simple helpers score low and land on small models; bigger ones graduate up.
 */
export function tentacleComplexity(spec: Pick<TentacleSpec, "kind" | "complexity" | "files" | "readOnly" | "acceptance">, o: { escalate?: boolean; promptChars?: number } = {}): { level: (typeof LEVELS)[number]; score: number } {
  const base = spec.complexity ?? DEFAULT_COMPLEXITY[spec.kind];
  const idx = Math.min(LEVELS.indexOf(base) + (o.escalate ? 1 : 0), LEVELS.length - 1);
  let score = LEVEL_SCORE[LEVELS[idx]];
  const chars = o.promptChars ?? 0;
  if (chars > 24_000) score += 0.1;
  else if (chars > 8_000) score += 0.05;
  else if (!o.escalate && chars > 0 && chars < 2_000) score -= 0.05;
  if ((spec.files?.length ?? 0) > 3) score += 0.05;
  const writes = !(spec.readOnly === true || READ_ONLY_KINDS.has(spec.kind));
  if (writes && spec.acceptance && spec.acceptance.kind !== "none" && spec.acceptance.kind !== "grep") score += 0.05;
  score = Math.min(1, Math.max(0, Number(score.toFixed(3))));
  const level = score >= 0.8 ? "very_high" : score >= 0.55 ? "high" : score >= 0.3 ? "medium" : "low";
  return { level, score };
}

/** Routing hints for a tentacle's model calls. */
export function workerHints(spec: Pick<TentacleSpec, "kind" | "complexity"> & Partial<Pick<TentacleSpec, "files" | "readOnly" | "acceptance">>, o: { escalate?: boolean; promptChars?: number; maxCSats?: number; tentacleId?: string } = {}): RoutingHints {
  const { level, score } = tentacleComplexity({ files: [], ...spec }, o);
  // The score (0..1) goes to the coordinator's best-fit routing as the job's complexity.
  const complexity = score;
  const quality: Quality = o.escalate ? "best" : level === "low" ? "fast" : "balanced";
  const promptTokens = Math.ceil((o.promptChars ?? 0) / 3);
  return {
    job: JOB_OF[spec.kind],
    complexity,
    quality,
    latency: "batch",
    needsTools: true,
    // Room for the prompt, the tool round trips and a reply; cheap models have 8-16K.
    minContext: Math.min(32_768, Math.max(8_192, promptTokens + 6_000)),
    ...(o.maxCSats !== undefined ? { maxCSats: Math.max(0, Number(o.maxCSats.toFixed(6))) } : {}),
    ...(o.tentacleId ? { sessionId: `tentacle:${o.tentacleId}` } : {}),
  };
}

/** "path#L10-L40" → { path, start, end }. */
export function parseFileRef(ref: string): { path: string; start?: number; end?: number } {
  const m = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(ref.trim());
  if (!m) return { path: ref.trim() };
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  return { path: m[1], start: Math.max(1, Math.min(start, end)), end: Math.max(start, end) };
}

/** Where a model call ran, from a backend's `where` ("routed to <model> on <class> because …", a route label). */
export function parseWhere(where: string | undefined, fallbackModel: string): { model: string; class: string; agentLabel: string } {
  const w = (where ?? "").trim();
  const routed = /routed to (\S+) on (\S+)/.exec(w);
  if (routed) return { model: routed[1], class: routed[2].replace(/[,.;]$/, ""), agentLabel: w };
  const cls = /@(gpu\.dc|gpu|apple|cpu)\b/.exec(w) ?? /\b(gpu\.dc|gpu|apple|cpu)\b/.exec(w);
  const model = /(?:network|mine)\/([^\s@]+)/.exec(w)?.[1] ?? (fallbackModel === "auto" ? (w.split(/\s/)[0] || "auto") : fallbackModel);
  return { model, class: cls?.[1] ?? (w ? "any" : "unknown"), agentLabel: w || fallbackModel };
}

/** A ChatFn over a backend that sends `hints` with every request and reports each call's usage. */
export function hintedChat(
  backend: ChatBackend,
  hints: () => RoutingHints,
  signal: AbortSignal,
  onCall: (u: { cSats: number; where?: string; promptTokens?: number; outputTokens?: number; served?: ServedBy }) => void,
  guard?: () => void,
): ChatFn {
  return async ({ messages, tools }, onDelta) => {
    guard?.();
    let content = "";
    const toolCalls: ChatResult["toolCalls"] = [];
    const req = {
      messages: messages.map((m) => ({ ...m, role: (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as "user" })),
      ...(tools ? { tools: tools as never } : {}),
      temperature: 0.2,
      hints: hints(),
    };
    for await (const p of backend(req, signal)) {
      if ("delta" in p) {
        content += p.delta;
        onDelta?.(p.delta);
      } else if ("toolCalls" in p) {
        for (const c of p.toolCalls) toolCalls.push({ name: c.function.name, arguments: c.function.arguments ?? {} });
      } else if ("done" in p) {
        onCall({ cSats: Number.isFinite(p.cSatsSpent) ? (p.cSatsSpent as number) : 0, where: p.where, promptTokens: p.promptTokens, outputTokens: p.outputTokens, ...(p.served ? { served: p.served } : {}) });
      }
    }
    return { content, toolCalls };
  };
}

function schemasFor(names: ToolName[]): ToolSchema[] {
  return TOOL_DEFINITIONS.filter((t) => names.includes(t.name)).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.name === "run_shell" ? `${t.description} Only tests, type checks and read commands run here (${TENTACLE_SHELL_ALLOW.map((p) => p.join(" ")).join(", ")}).` : t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(Object.entries(t.parameters).map(([k, p]) => [k, { type: p.type, description: p.description }])),
        required: Object.entries(t.parameters).filter(([, p]) => p.required).map(([k]) => k),
      },
    },
  }));
}

function tentacleSystemPrompt(readOnly: boolean): string {
  return [
    "You are a helper agent (a tentacle) working for a lead agent on one scoped piece of work.",
    readOnly
      ? "You can only read the project. Find what is asked and answer with the facts, file paths and line numbers."
      : "You work in a private copy of the project. Make exactly the change asked for, nothing else; keep edits small and in the style of the code around them. Paths are relative to the project folder.",
    "Use the tools to read what you need. When you are done, reply without calling a tool: a short summary of what you did (or found) and anything the lead must know.",
    "Don't ask questions; nobody will answer. If the task can't be done, say why in your summary.",
  ].join("\n");
}

/** The tentacle's first message: the task, its instructions and the given files (within the size cap). */
export function tentaclePrompt(spec: TentacleSpec, read: (path: string) => string | null, maxChars: number, extra?: string): string {
  const parts: string[] = [`# Task\n${spec.task}`];
  if (spec.instructions.trim()) parts.push(`# Instructions\n${spec.instructions.trim()}`);
  if (spec.acceptance && spec.acceptance.kind !== "none") parts.push(`# Done when\nThis check passes in your workspace: ${spec.acceptance.kind} ${JSON.stringify(spec.acceptance.args ?? "")}`);
  if (extra) parts.push(extra);
  let budget = maxChars - parts.join("\n\n").length;
  const files: string[] = [];
  for (const ref of spec.files) {
    const { path, start, end } = parseFileRef(ref);
    const text = read(path);
    if (text === null) {
      files.push(`## ${ref}\n(not found)`);
      continue;
    }
    let body = text;
    let label = path;
    if (start) {
      const lines = text.split("\n").slice(start - 1, end);
      body = lines.map((l, i) => `${start + i}: ${l}`).join("\n");
      label = `${path} (lines ${start}-${start + lines.length - 1})`;
    }
    if (budget <= 200) {
      files.push(`## ${label}\n(not included: context limit; read it with read_file if needed)`);
      continue;
    }
    if (body.length > budget - 100) body = `${body.slice(0, budget - 100)}\n… (cut: read_file with offset for the rest)`;
    budget -= body.length + label.length + 10;
    files.push(`## ${label}\n\`\`\`\n${body}\n\`\`\``);
  }
  if (files.length) parts.push(`# Files\n${files.join("\n\n")}`);
  return parts.join("\n\n");
}

const FRONTIER_REFUSED = "a helper call was answered by a frontier model; helpers run only on the network or this computer";
const round = (n: number) => Number(n.toFixed(6));
const shortTask = (t: string) => (t.length > 80 ? `${t.slice(0, 77)}…` : t);
export const formatCSatsShort = (c: number) => `${c < 10 ? c.toFixed(1) : Math.round(c)} cSats`;
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/** A helper call's served line: `model · class · host region · tokens · cSats`. */
export function tentacleCallLine(c: TentacleCall): string {
  const s = c.served;
  const cls = s?.computeClass ?? parseWhere(c.where, c.model).class;
  const place = s ? s.city ?? s.region ?? s.country ?? "" : "";
  const pin = c.promptTokens ?? s?.promptTokens ?? 0;
  const pout = c.outputTokens ?? s?.outputTokens ?? 0;
  return [c.model.replace(/^network\//, ""), cls, place ? `${s?.label ? `${s.label} ` : ""}${place}` : s?.label ?? "", pin || pout ? `${tok(pin)} in / ${tok(pout)} out tok` : "", formatCSatsShort(c.cSats)].filter(Boolean).join(" · ");
}

/** Totals over helper calls (the lead's summary): calls, models, tokens, cSats, and one line. */
export function tentacleTotals(views: Array<Pick<TentacleView, "calls" | "cSats">>): { helpers: number; calls: number; models: string[]; promptTokens: number; outputTokens: number; cSats: number; line: string } {
  const calls = views.flatMap((v) => v.calls ?? []);
  const models = [...new Set(calls.map((c) => c.model.replace(/^network\//, "")))];
  const promptTokens = calls.reduce((n, c) => n + (c.promptTokens ?? c.served?.promptTokens ?? 0), 0);
  const outputTokens = calls.reduce((n, c) => n + (c.outputTokens ?? c.served?.outputTokens ?? 0), 0);
  const cSats = round(views.reduce((n, v) => n + (Number.isFinite(v.cSats) ? v.cSats : 0), 0));
  const line = `${views.length} helper${views.length === 1 ? "" : "s"} · ${calls.length} call${calls.length === 1 ? "" : "s"}${models.length ? ` · ${models.join(", ")}` : ""} · ${tok(promptTokens)} in / ${tok(outputTokens)} out tok · ${formatCSatsShort(cSats)}`;
  return { helpers: views.length, calls: calls.length, models, promptTokens, outputTokens, cSats, line };
}

export class TentacleManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly base: TentacleConfig;

  constructor(private readonly d: TentacleDeps) {
    this.base = { ...tentacleConfigFromEnv(), ...(d.config ?? {}) };
  }

  private state(sessionId: string): SessionState {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = { config: { ...this.base }, tentacles: new Map(), queue: [], running: 0, spent: 0, waiters: new Set() };
      this.sessions.set(sessionId, st);
    }
    return st;
  }

  config(sessionId: string): TentacleConfig {
    return { ...this.state(sessionId).config };
  }

  enabled(sessionId: string): boolean {
    return this.state(sessionId).config.enabled;
  }

  configure(sessionId: string, patch: Partial<TentacleConfig>): TentacleConfig {
    const st = this.state(sessionId);
    const c = st.config;
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    if (patch.maxParallel !== undefined) c.maxParallel = Math.max(1, Math.min(16, Math.floor(patch.maxParallel)));
    if (patch.budgetCSats !== undefined) c.budgetCSats = Math.max(0, patch.budgetCSats);
    if (patch.perTentacleCSats !== undefined) c.perTentacleCSats = Math.max(0, patch.perTentacleCSats);
    if (patch.workerModel !== undefined && patch.workerModel.trim()) {
      // Helpers never run on a frontier model (the user's own key is for the lead, for its owner).
      if (workerModelOf({ workerModel: patch.workerModel.trim() }) !== patch.workerModel.trim()) throw new TentacleError("invalid", "Helpers run on auto, the network or this computer, never on a frontier model.");
      c.workerModel = patch.workerModel.trim();
    }
    if (patch.maxContextChars !== undefined) c.maxContextChars = Math.max(4_000, Math.floor(patch.maxContextChars));
    this.d.host.publishEvent(sessionId, { type: "tentacle_config", config: { ...c }, spentCSats: st.spent });
    this.pump(sessionId);
    return { ...c };
  }

  list(sessionId: string): { config: TentacleConfig; spentCSats: number; tentacles: TentacleView[] } {
    const st = this.state(sessionId);
    return { config: { ...st.config }, spentCSats: round(st.spent), tentacles: [...st.tentacles.values()].map((t) => structuredClone(t.view)) };
  }

  get(sessionId: string, id: string): TentacleView | null {
    const t = this.sessions.get(sessionId)?.tentacles.get(id);
    return t ? structuredClone(t.view) : null;
  }

  /** Start a tentacle (or queue it behind the parallel cap); returns its id at once. */
  delegate(sessionId: string, spec: TentacleSpec): TentacleView {
    const s = this.d.host.session(sessionId);
    if (!s) throw new TentacleError("not_found", "No session with that id.");
    const st = this.state(sessionId);
    if (!st.config.enabled) throw new TentacleError("disabled", "Tentacles are off for this session.");
    const committed = [...st.tentacles.values()].filter((t) => t.view.status === "queued" || t.view.status === "running" || t.view.status === "verifying").length;
    const left = st.config.budgetCSats - st.spent;
    if (left <= 0) throw new TentacleError("budget", `The session's tentacle budget (${formatCSatsShort(st.config.budgetCSats)}) is spent.`);
    if (committed >= 32) throw new TentacleError("invalid", "Too many tentacles waiting; await some first.");
    const readOnly = spec.readOnly === true || READ_ONLY_KINDS.has(spec.kind);
    const id = `t${randomUUID().slice(0, 7)}`;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const t: Internal = {
      spec: { ...spec, readOnly },
      abort: new AbortController(),
      done,
      resolveDone,
      reported: false,
      spent: 0,
      view: { id, sessionId, task: spec.task, kind: spec.kind, readOnly, status: "queued", progress: "queued", createdAt: Date.now(), cSats: 0 },
    };
    st.tentacles.set(id, t);
    st.queue.push(id);
    this.d.host.publishEvent(sessionId, { type: "tentacle_started", tentacle: structuredClone(t.view) });
    this.pump(sessionId);
    return structuredClone(t.view);
  }

  cancel(sessionId: string, id: string): boolean {
    const st = this.sessions.get(sessionId);
    const t = st?.tentacles.get(id);
    if (!st || !t) return false;
    if (t.view.status === "queued") {
      st.queue = st.queue.filter((q) => q !== id);
      this.finish(sessionId, t, "cancelled", undefined, "cancelled before it started");
      return true;
    }
    if (t.view.status !== "running" && t.view.status !== "verifying") return false;
    t.abort.abort();
    return true;
  }

  /** Cancel every tentacle of a session (it stopped, was deleted, or the provider is closing). */
  cancelAll(sessionId: string): number {
    const st = this.sessions.get(sessionId);
    if (!st) return 0;
    let n = 0;
    for (const id of [...st.tentacles.keys()]) if (this.cancel(sessionId, id)) n++;
    return n;
  }

  /**
   * Results as they finish: waits (up to timeoutS) until at least one of `ids` (default: all not
   * yet reported) has finished, then returns every finished one not yet reported, and the ids
   * still running.
   */
  async awaitResults(sessionId: string, ids?: string[], timeoutS = 120): Promise<{ finished: TentacleView[]; pending: TentacleView[]; timedOut: boolean }> {
    const st = this.state(sessionId);
    const unknown = (ids ?? []).filter((i) => !st.tentacles.has(i));
    if (unknown.length) throw new TentacleError("not_found", `No tentacle ${unknown.join(", ")} in this session.`);
    const targets = () => (ids?.length ? ids.map((i) => st.tentacles.get(i)!) : [...st.tentacles.values()].filter((t) => !t.reported));
    const isDone = (t: Internal) => !["queued", "running", "verifying"].includes(t.view.status);
    const ready = () => {
      const ts = targets();
      return ts.length === 0 || ts.some((t) => isDone(t) && !t.reported) || ts.every(isDone);
    };
    let timedOut = false;
    if (!ready()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          st.waiters.delete(wake);
          resolve();
        }, Math.max(0, Math.min(timeoutS, 600)) * 1000);
        const wake = () => {
          if (!ready()) return;
          clearTimeout(timer);
          st.waiters.delete(wake);
          resolve();
        };
        st.waiters.add(wake);
      });
    }
    const ts = targets();
    const finished = ts.filter(isDone);
    for (const t of finished) t.reported = true;
    if (finished.length) {
      // Merged back into the lead's turn: the batch's and the session's totals, for every client.
      const views = finished.map((t) => t.view);
      this.d.host.publishEvent(sessionId, { type: "tentacle_totals", ids: views.map((v) => v.id), totals: tentacleTotals(views), session: tentacleTotals([...st.tentacles.values()].map((t) => t.view)) });
    }
    return { finished: finished.map((t) => structuredClone(t.view)), pending: ts.filter((t) => !isDone(t)).map((t) => structuredClone(t.view)), timedOut };
  }

  /** Finished tentacles the lead hasn't seen yet (for the next turn's prompt). */
  unreported(sessionId: string): TentacleView[] {
    const st = this.sessions.get(sessionId);
    if (!st) return [];
    return [...st.tentacles.values()].filter((t) => !t.reported && !["queued", "running", "verifying"].includes(t.view.status)).map((t) => structuredClone(t.view));
  }

  /** The user's answer for a tentacle waiting for approval: apply its patch (checked again) or drop it. */
  decide(sessionId: string, id: string, approved: boolean): TentacleView {
    const t = this.sessions.get(sessionId)?.tentacles.get(id);
    if (!t) throw new TentacleError("not_found", "No tentacle with that id.");
    if (t.view.merge?.state !== "awaiting_approval") throw new TentacleError("invalid", "That tentacle isn't waiting for approval.");
    if (!approved) {
      t.view.merge = { state: "rejected" };
      this.mergeEvent(sessionId, t);
      return structuredClone(t.view);
    }
    const s = this.d.host.session(sessionId);
    if (!s) throw new TentacleError("not_found", "No session with that id.");
    this.applyNow(s, t);
    return structuredClone(t.view);
  }

  /** Resolves when a session's tentacles have all finished (tests, shutdown). */
  async idle(sessionId: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    await Promise.all([...st.tentacles.values()].map((t) => t.done));
  }

  // -------------------------------------------------------------------------

  /** Whether the session runs `command` without asking (the shared classifier; never past the session's mode). */
  private shellAllowed(s: SessionData, command: string, root: string): boolean {
    if (riskOf(command, root) !== null) return false;
    const fresh = this.d.host.session(s.id) ?? s; // the mode may have changed since the tentacle started
    return this.d.shellAllowed ? this.d.shellAllowed(fresh, command) : sessionAllowsShell(fresh, command, root);
  }

  private pump(sessionId: string): void {
    const st = this.state(sessionId);
    while (st.running < st.config.maxParallel && st.queue.length) {
      const id = st.queue.shift()!;
      const t = st.tentacles.get(id);
      if (!t || t.view.status !== "queued") continue;
      st.running++;
      void this.run(sessionId, st, t).finally(() => {
        st.running--;
        this.pump(sessionId);
      });
    }
  }

  private progress(sessionId: string, t: Internal, message: string, status?: TentacleStatus): void {
    t.view.progress = message;
    if (status) t.view.status = status;
    this.d.host.publishEvent(sessionId, { type: "tentacle_progress", id: t.view.id, status: t.view.status, progress: message, cSats: round(t.spent), ...(t.view.model ? { model: t.view.model } : {}) });
  }

  private async run(sessionId: string, st: SessionState, t: Internal): Promise<void> {
    const s = this.d.host.session(sessionId);
    if (!s) return this.finish(sessionId, t, "error", undefined, "the session is gone");
    t.view.startedAt = Date.now();
    const cfg = st.config;
    // The worker model: never a frontier one, whoever the lead is (workerModelOf turns one into auto).
    const model = workerModelOf({ workerModel: this.d.workerModelFor?.(s, cfg) ?? tentacleWorkerModel(s, cfg) });
    t.view.model = model;
    const calls: TentacleCall[] = [];
    t.view.calls = calls;
    let unverified: string | undefined;
    this.progress(sessionId, t, "starting", "running");
    const budget = Math.max(0, Math.min(t.spec.budgetCSats ?? cfg.perTentacleCSats, cfg.budgetCSats - st.spent));
    let ws: Workspace | null = null;
    const started = Date.now();
    const tokens = { prompt: 0, output: 0 };
    let where: string | undefined;
    const checks: CheckResult[] = [];
    try {
      if (!t.spec.readOnly) {
        ws = createWorkspace(s.projectRoot, { tmpRoot: this.d.tmpRoot, label: t.view.id });
        if (ws.notes.length) this.progress(sessionId, t, `workspace ready (${ws.notes.join("; ")})`);
      }
      const root = ws ? ws.root : s.projectRoot;
      const executor = new ToolExecutor(root);
      const toolNames = ws ? WRITE_TOOL_NAMES : READ_TOOL_NAMES;
      let lastFailure = "";
      let outcome: { status: "passed" | "failed" | "error"; summary: string; error?: string } = { status: "error", summary: "" };
      let attempts = 0;
      for (const escalate of [false, true]) {
        if (t.abort.signal.aborted) break;
        attempts++;
        if (escalate) {
          if (ws) resetWorkspace(ws);
          this.progress(sessionId, t, "retrying on a stronger tier");
        }
        checks.length = 0;
        let budgetHit = false;
        let frontierRefused = false;
        let text = "";
        const read = (p: string) => readText(root, p);
        const prompt = tentaclePrompt(t.spec, read, cfg.maxContextChars, lastFailure ? `# A previous attempt failed\n${lastFailure.slice(0, 3000)}` : undefined);
        const chat = hintedChat(
          // An explicit worker model stays the same on the retry (no surprise spend); "auto" moves up a tier by its hints.
          this.d.workerBackend(model, sessionId, { role: "worker" }),
          () => workerHints(t.spec, { escalate, promptChars: prompt.length, maxCSats: budget - t.spent, tentacleId: t.view.id }),
          t.abort.signal,
          (u) => {
            if (u.served?.computeClass === "frontier") {
              // A frontier answer for a helper means a backend let the user's key through: stop.
              frontierRefused = true;
              throw new Error(FRONTIER_REFUSED);
            }
            t.spent = round(t.spent + u.cSats);
            st.spent = round(st.spent + u.cSats);
            t.view.cSats = t.spent;
            tokens.prompt += u.promptTokens ?? 0;
            tokens.output += u.outputTokens ?? 0;
            if (u.where) where = u.where;
            const w = parseWhere(where, model);
            t.view.model = w.model;
            const call: TentacleCall = { cSats: round(u.cSats), model: w.model, ...(u.where ? { where: u.where } : {}), ...(u.served ? { served: u.served } : {}), ...(u.promptTokens !== undefined ? { promptTokens: u.promptTokens } : {}), ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}) };
            calls.push(call);
            // Each helper call's own served line (session event; the terminal and desktop show it).
            this.d.host.publishEvent(sessionId, { type: "tentacle_usage", id: t.view.id, call, line: tentacleCallLine(call), cSats: t.view.cSats, spentCSats: st.spent });
          },
          () => {
            if (frontierRefused) throw new Error(FRONTIER_REFUSED);
            // Free calls (this computer, your machines) never trip a budget.
            if ((t.spent > 0 && t.spent >= budget) || (st.spent > 0 && st.spent >= cfg.budgetCSats)) {
              budgetHit = true;
              throw new Error(`budget reached (${formatCSatsShort(budget)})`);
            }
          },
        );
        await runAgentLoop({
          chat,
          systemPrompt: () => tentacleSystemPrompt(!ws),
          messages: [{ role: "user", content: prompt }],
          native: true,
          maxIterations: this.d.maxIterations ?? 12,
          tools: schemasFor(toolNames),
          isCancelled: () => t.abort.signal.aborted,
          sendEvent: (e: IdeStreamEvent) => {
            if (e.type === "text") text += e.content;
          },
          runTool: async (tool, args) => {
            if (!toolNames.includes(tool)) return `[Error]: ${tool} isn't available to a tentacle`;
            let a = args;
            if (tool === "run_shell") {
              const dec = tentacleShellDecision(args.command, root, (probe) => this.shellAllowed(s, probe, root));
              if (!dec.ok) return `[Error]: run_shell rejected: ${dec.reason}`;
              a = { ...args, command: dec.command, timeout: Math.min(Number(args.timeout) || 120_000, 300_000) };
            }
            const target = typeof args.path === "string" ? ` ${args.path}` : typeof args.command === "string" ? ` ${String(args.command).slice(0, 60)}` : "";
            this.progress(sessionId, t, `${tool}${target}`);
            // Writes: only inside the workspace (the executor refuses paths outside its root).
            // run_shell was checked against the tentacle allowlist above, so it runs as approved.
            const r = await executor.execute(tool, a, { approved: tool === "run_shell" });
            return r.error ? `[Error]: ${r.error}` : r.result ?? "(no output)";
          },
        });
        const summary = text.replace(/^Error contacting model: .*$/m, "").trim();
        const modelError = /Error contacting model: (.*)/.exec(text)?.[1];
        if (t.abort.signal.aborted) break;
        if (frontierRefused) {
          outcome = { status: "error", summary: "", error: FRONTIER_REFUSED };
          break; // never retried
        }
        if (budgetHit) {
          outcome = { status: "error", summary, error: `The tentacle's budget ran out (${formatCSatsShort(budget)}).` };
          break; // no escalation past a budget
        }
        if (modelError && !summary) {
          outcome = { status: "error", summary, error: modelError };
          lastFailure = `The model call failed: ${modelError}`;
          continue;
        }
        // Verify.
        // The check runs project code (tests, tsc) unless it is a grep: only when the session's mode
        // would run that command without asking. Otherwise the patch comes back unverified and waits
        // for the user's approval.
        const probe = t.spec.acceptance ? acceptanceProbe(t.spec.acceptance) : null;
        const checkAllowed = !probe || t.spec.acceptance?.kind === "grep" || (riskOf(probe, root) === null && this.shellAllowed(s, probe, root));
        if (t.spec.acceptance && t.spec.acceptance.kind !== "none" && !checkAllowed) {
          unverified = `${t.spec.acceptance.kind} check not run: the session's permission mode (${modeOf(s)}) would ask before running \`${probe}\``;
          this.progress(sessionId, t, unverified);
        } else if (t.spec.acceptance && t.spec.acceptance.kind !== "none" && (ws || t.spec.acceptance.kind === "grep")) {
          this.progress(sessionId, t, `checking: ${t.spec.acceptance.kind}`, "verifying");
          const check = await (this.d.runCheck ?? runAcceptance)(t.spec.acceptance, root, { signal: t.abort.signal });
          checks.push(check);
          if (t.abort.signal.aborted) break;
          this.progress(sessionId, t, `${check.kind} ${check.passed ? "passed" : "failed"}`, "running");
          if (!check.passed) {
            outcome = { status: "failed", summary, error: `${check.command} failed (exit ${check.exitCode})` };
            lastFailure = `Your summary: ${summary.slice(0, 500)}\nThe check \`${check.command}\` failed:\n${check.output}`;
            continue;
          }
        }
        if (ws && !t.spec.readOnly && t.spec.kind !== "review") {
          const { files } = workspacePatch(ws);
          if (!files.length) {
            outcome = { status: "failed", summary, error: "The tentacle changed no files." };
            lastFailure = `Your summary: ${summary.slice(0, 500)}\nBut no file was changed. Make the change with write_file or edit_file.`;
            continue;
          }
        }
        outcome = { status: "passed", summary };
        break;
      }
      if (t.abort.signal.aborted) return this.finish(sessionId, t, "cancelled", undefined, "cancelled");
      const p = ws ? workspacePatch(ws) : { patch: "", files: [] };
      const w = parseWhere(where, model);
      const result: TentacleResult = {
        status: outcome.status,
        patch: p.patch,
        summary: outcome.summary,
        filesTouched: p.files,
        checks: [...checks],
        model: w.model,
        class: w.class,
        agentLabel: w.agentLabel,
        tokens,
        cSats: round(t.spent),
        durationMs: Date.now() - started,
        attempts,
        calls: [...calls],
        ...(unverified ? { unverified } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
      this.finish(sessionId, t, outcome.status, result, undefined, ws);
    } catch (err) {
      if (t.abort.signal.aborted) return this.finish(sessionId, t, "cancelled", undefined, "cancelled");
      const w = parseWhere(where, model);
      this.finish(sessionId, t, "error", {
        status: "error",
        patch: "",
        summary: "",
        filesTouched: [],
        checks: [...checks],
        model: w.model,
        class: w.class,
        agentLabel: w.agentLabel,
        tokens,
        cSats: round(t.spent),
        durationMs: Date.now() - started,
        attempts: 1,
        calls: [...calls],
        error: (err as Error).message,
      });
    } finally {
      if (ws) removeWorkspace(ws);
    }
  }

  private finish(sessionId: string, t: Internal, status: TentacleStatus, result?: TentacleResult, why?: string, ws?: Workspace | null): void {
    if (["passed", "failed", "error", "cancelled"].includes(t.view.status)) return;
    t.view.status = status;
    t.view.finishedAt = Date.now();
    t.view.cSats = round(t.spent);
    t.view.progress = why ?? status;
    if (result) t.view.result = result;
    const s = this.d.host.session(sessionId);
    // Merge back.
    if (status === "passed" && result && result.patch.trim() && s) {
      const top = ws?.leadTop ?? repoTop(s.projectRoot);
      const check = top ? checkPatch(top, result.patch) : { ok: false as const, error: "the project isn't a git repository" };
      if (!check.ok) t.view.merge = { state: "conflict", error: check.error };
      else if (!result.unverified && (this.d.canAutoApply ?? canAutoApply)(s, patchFiles(result.patch))) this.applyNow(s, t, false);
      else t.view.merge = { state: "awaiting_approval" };
    } else if (status === "passed" || status === "cancelled") {
      t.view.merge = { state: status === "passed" ? "no_changes" : "not_applied" };
    } else {
      t.view.merge = { state: "not_applied", ...(result?.error ? { error: result.error } : {}) };
    }
    this.d.host.publishEvent(sessionId, { type: "tentacle_finished", tentacle: structuredClone(t.view) });
    if (status !== "cancelled" || t.spent > 0) this.note(sessionId, t);
    const st = this.sessions.get(sessionId);
    t.resolveDone();
    for (const w of [...(st?.waiters ?? [])]) w();
  }

  /** Apply a checked patch to the lead's tree as its own checkpoint (undoable). */
  private applyNow(s: SessionData, t: Internal, announce = true): void {
    const result = t.view.result;
    if (!result) return;
    const top = repoTop(s.projectRoot);
    if (!top) {
      t.view.merge = { state: "conflict", error: "the project isn't a git repository" };
      if (announce) this.mergeEvent(s.id, t);
      return;
    }
    const check = checkPatch(top, result.patch);
    if (!check.ok) {
      t.view.merge = { state: "conflict", error: check.error };
      if (announce) this.mergeEvent(s.id, t);
      return;
    }
    const checkpointId = randomUUID();
    this.d.checkpoints.begin(checkpointId, s.projectRoot);
    const changed: string[] = [];
    for (const f of patchFiles(result.patch)) {
      const rel = relative(realOf(s.projectRoot), join(top, f));
      if (rel.startsWith("..")) continue;
      const tracked = this.d.checkpoints.capture(checkpointId, rel);
      if (tracked && !changed.includes(tracked)) changed.push(tracked);
    }
    const applied = applyPatch(top, result.patch);
    if (!applied.ok) {
      t.view.merge = { state: "conflict", error: applied.error };
      if (announce) this.mergeEvent(s.id, t);
      return;
    }
    t.view.merge = { state: "applied", checkpointId };
    (t as Internal & { changed?: string[] }).changed = changed;
    if (announce) {
      this.mergeEvent(s.id, t);
      // The approval came after the tentacle's note: record the applied patch as its own, undoable.
      this.d.host.recordNote(s.id, {
        content: `Tentacle applied: ${shortTask(t.view.task)} · ${result.filesTouched.length} file(s)`,
        turnId: checkpointId,
        changedFiles: changed,
        tentacle: { id: t.view.id, merge: "applied" },
      });
    }
  }

  private mergeEvent(sessionId: string, t: Internal): void {
    this.d.host.publishEvent(sessionId, { type: "tentacle_merge", id: t.view.id, merge: t.view.merge, tentacle: structuredClone(t.view) });
    for (const w of [...(this.sessions.get(sessionId)?.waiters ?? [])]) w();
  }

  /** The transcript line: "Tentacle: <task> · <model> on <class> · passed · 3.1 cSats" (collapsible, with the patch). */
  private note(sessionId: string, t: Internal): void {
    const r = t.view.result;
    const where = r ? `${r.model} on ${r.class}` : t.view.model ?? "auto";
    const merge = t.view.merge?.state;
    const content = `Tentacle: ${shortTask(t.view.task)} · ${where} · ${t.view.status}${merge && merge !== "no_changes" && merge !== "not_applied" ? ` (${merge.replace("_", " ")})` : ""} · ${formatCSatsShort(t.view.cSats)}`;
    const applied = merge === "applied";
    const changed = (t as Internal & { changed?: string[] }).changed ?? [];
    this.d.host.recordNote(sessionId, {
      content,
      usage: { cSats: t.view.cSats, where: r?.agentLabel ?? where, calls: (t.view.calls ?? []).slice(-50).map((c) => ({ cSats: c.cSats, model: c.model, ...(c.where ? { where: c.where } : {}), ...(c.served ? { served: c.served } : {}) })) },
      ...(applied && t.view.merge?.checkpointId ? { turnId: t.view.merge.checkpointId, changedFiles: changed } : {}),
      tentacle: {
        id: t.view.id,
        task: t.view.task,
        kind: t.view.kind,
        status: t.view.status,
        merge: merge ?? null,
        model: r?.model ?? t.view.model ?? null,
        class: r?.class ?? null,
        cSats: t.view.cSats,
        summary: r?.summary?.slice(0, 4000) ?? "",
        filesTouched: r?.filesTouched ?? [],
        patch: (r?.patch ?? "").slice(0, 20_000),
        checks: (r?.checks ?? []).map((c) => ({ command: c.command, passed: c.passed, exitCode: c.exitCode })),
        calls: (t.view.calls ?? []).map((c) => tentacleCallLine(c)),
        ...(r?.unverified ? { unverified: r.unverified } : {}),
        error: r?.error ?? t.view.merge?.error ?? null,
      },
    });
  }
}

/** A project file's text for the prompt (inside `root` only: ProjectFs refuses escapes, binaries and huge files), or null. */
function readText(root: string, path: string): string | null {
  try {
    return new ProjectFs(root).read(path).content;
  } catch {
    return null;
  }
}
