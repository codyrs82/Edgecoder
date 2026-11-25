// Copyright (c) 2025 EdgeCoder
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
import { runAgentLoop, type ToolSchema } from "./agent-loop.js";
import type { CheckpointStore } from "./checkpoints.js";
import { ProjectFs } from "./project-fs.js";
import { workerModelOf, type SessionData, type TranscriptEntry } from "./sessions.js";
import { riskOf } from "./permissions.js";
import { ToolExecutor } from "./tool-executor.js";
import { TOOL_DEFINITIONS, type IdeStreamEvent, type ToolName } from "./tool-types.js";
import {
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
import { formatCSatsShort, parseWhere, patchReturn, tentacleCallLine, tentacleRanOn, tentacleTotals, whereServed } from "./tentacle-format.js";

import { emptyAttempt, hintedChat, isProviderTierError, parseFileRef, pickLocalHelperModel, retryAfterEmpty, smallWorkerWarning, TENTACLE_HELPER_MIN_PARAMS_B, TENTACLE_LOCAL_MIN_PARAMS_B, tentacleHelperMinParamsB, tentacleLocalMinParamsB, tentaclePrompt, tentacleSystemPrompt } from "./tentacle-chat.js";
import { acceptanceProbe, canAutoApply, modeOf, sessionAllowsShell, TENTACLE_SHELL_ALLOW, tentacleShellDecision } from "./tentacle-shell.js";
import { CallHolds, ceilingRefusal, helperCallCeiling, helperContextWindow, helperReplyTokens, MIN_HELPER_CALL_CSATS, paidWorker, promptTokensOf } from "./tentacle-reserve.js";

export { acceptanceProbe, canAutoApply, modeOf, sessionAllowsShell, TENTACLE_SHELL_ALLOW, tentacleShellDecision };
export { pickLocalHelperModel, TENTACLE_HELPER_MIN_PARAMS_B, TENTACLE_LOCAL_MIN_PARAMS_B, tentacleHelperMinParamsB, tentacleLocalMinParamsB };
export { formatCSatsShort, hintedChat, parseFileRef, parseWhere, patchReturn, tentacleCallLine, tentaclePrompt, tentacleRanOn, tentacleTotals, whereServed };
import type { RoutingHints, JobType, Quality } from "../../inference-api/job-descriptor.js";
import { isFrontierModelId } from "../../inference-api/frontier-models.js";

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
  /** Where the last attempt ran: this computer's model (local first) or the network. */
  place?: TentaclePlace;
  /** The acceptance check didn't run: the session's mode would ask first (helpers can't ask). */
  unverified?: string;
  error?: string;
}

/** Where a helper call ran: this computer's own model (free), or the network (or your machines through it). */
export type TentaclePlace = "local" | "network";

/** One helper model call, as the session's `served` lines show it. */
export interface TentacleCall {
  cSats: number;
  where?: string;
  model: string;
  /** This computer or the network, shown first in the call's served line. */
  place?: TentaclePlace;
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
  /**
   * Local first: with the worker on auto, a low-complexity helper's first attempt runs on a capable
   * model on this computer (free) when one is installed; its retry, and everything else, goes to the network.
   */
  localFirst: boolean;
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
    localFirst: env.EDGECODER_TENTACLES_LOCAL !== "0",
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
  /**
   * Local first (TentacleConfig.localFirst): a tool-capable model on this computer that fits the
   * helper (pickLocalHelperModel over this computer's installed models), or null when none does.
   * Unset: helpers never run locally first.
   */
  localModelFor?: (need: { minContext: number; promptTokens: number }) => Promise<string | null>;
  /** A backend for a model on this computer (Ollama). Required with localModelFor. */
  localBackend?: (model: string) => ChatBackend;
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
  /** The price ceilings of helper calls in flight (tentacle-reserve.ts). */
  holds: CallHolds;
  /**
   * When a helper call last failed with a provider error (a cloud provider error, a 503, every
   * holder cooling down): for PROVIDER_ERROR_SKIP_MS after it, retries don't move up a tier.
   */
  providerErrorAt?: number;
  /** Explicit workers under the helper floor already warned about (their helpers run on auto). */
  floorWarned?: Set<string>;
}

/**
 * How long a provider error keeps the session's helper retries off the next tier (on auto that is
 * where a suspended cloud provider sits). The client gets no breaker state before a call, so a
 * tier is skipped once it has answered with a provider error.
 */
export const PROVIDER_ERROR_SKIP_MS = 5 * 60_000;

/**
 * A helper's history is compacted once a call's prompt passes this many tokens (agent-loop.ts
 * compactAtTokens): long histories pushed CPU hosts past their call timeout and helper calls out
 * of the network's common 8K-16K windows.
 */
export const HELPER_COMPACT_AT_TOKENS = 12_000;

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
export function workerHints(spec: Pick<TentacleSpec, "kind" | "complexity"> & Partial<Pick<TentacleSpec, "files" | "readOnly" | "acceptance">>, o: { escalate?: boolean; promptChars?: number; maxCSats?: number; tentacleId?: string; minParamsB?: number } = {}): RoutingHints {
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
    // Room for the prompt and a reply (tentacle-reserve.ts helperContextWindow): the reply is sized
    // to the window, so a helper prompt of a few thousand tokens fits the network's common 8K hosts.
    minContext: helperContextWindow(promptTokens),
    ...(o.maxCSats !== undefined ? { maxCSats: Math.max(0, Number(o.maxCSats.toFixed(6))) } : {}),
    // The helper floor (tentacleHelperMinParamsB): a hard floor, best fit never goes below it.
    ...(o.minParamsB && o.minParamsB > 0 ? { minParamsB: o.minParamsB } : {}),
    ...(o.tentacleId ? { sessionId: `tentacle:${o.tentacleId}` } : {}),
  };
}

/**
 * Where a helper's attempt runs. Local first: with the worker on auto and local first on, a
 * low-complexity first attempt runs on `localModel` (this computer, free) when there is one. The
 * retry (one level up), medium and harder pieces, and an explicit worker model go to the worker
 * (`model`: auto's best fit on the network, or exactly the model chosen). Never a frontier model.
 */
export function tentaclePlacement(o: { workerModel: string; level: (typeof LEVELS)[number]; escalate: boolean; localFirst: boolean; localModel: string | null }): { place: "local" | "worker"; model: string } {
  const worker = workerModelOf({ workerModel: o.workerModel });
  if (o.localFirst && worker === "auto" && !o.escalate && o.level === "low" && o.localModel && !isFrontierModelId(o.localModel)) return { place: "local", model: o.localModel };
  return { place: "worker", model: worker };
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

/** Where the last attempt ran, for the result: this computer when it ran locally (or Auto here served it there). */
function placeOf(place: "local" | "worker", calls: TentacleCall[]): TentaclePlace {
  return place === "local" || (calls.length > 0 && calls[calls.length - 1].place === "local") ? "local" : "network";
}

const FRONTIER_REFUSED = "a helper call was answered by a frontier model; helpers run only on the network or this computer";
const round = (n: number) => Number(n.toFixed(6));
const shortTask = (t: string) => (t.length > 80 ? `${t.slice(0, 77)}…` : t);

export class TentacleManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly base: TentacleConfig;

  constructor(private readonly d: TentacleDeps) {
    this.base = { ...tentacleConfigFromEnv(), ...(d.config ?? {}) };
  }

  private state(sessionId: string): SessionState {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = { config: { ...this.base }, tentacles: new Map(), queue: [], running: 0, spent: 0, waiters: new Set(), holds: new CallHolds() };
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
    if (patch.localFirst !== undefined) c.localFirst = !!patch.localFirst;
    this.d.host.publishEvent(sessionId, { type: "tentacle_config", config: { ...c }, spentCSats: st.spent });
    this.pump(sessionId);
    return { ...c };
  }

  list(sessionId: string): { config: TentacleConfig; spentCSats: number; patches: ReturnType<typeof patchReturn>; tentacles: TentacleView[] } {
    const st = this.state(sessionId);
    const views = [...st.tentacles.values()].map((t) => t.view);
    return { config: { ...st.config }, spentCSats: round(st.spent), patches: patchReturn(views), tentacles: views.map((v) => structuredClone(v)) };
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
    // An attempt that came back with nothing may move the retry to auto (retryAfterEmpty).
    let model = workerModelOf({ workerModel: this.d.workerModelFor?.(s, cfg) ?? tentacleWorkerModel(s, cfg) });
    // The helper floor: auto's calls never run below it, and an explicit network worker under it
    // runs on auto with the floor (warned once per session and model). EDGECODER_TENTACLES_MIN_B=0
    // keeps the explicit model.
    const minB = tentacleHelperMinParamsB();
    const small = smallWorkerWarning(model, minB);
    const smallModel = model;
    if (small) model = "auto";
    t.view.model = model;
    const calls: TentacleCall[] = [];
    t.view.calls = calls;
    let unverified: string | undefined;
    this.progress(sessionId, t, "starting", "running");
    if (small && !st.floorWarned?.has(smallModel)) {
      (st.floorWarned ??= new Set()).add(smallModel);
      this.progress(sessionId, t, small);
    }
    const budget = Math.max(0, Math.min(t.spec.budgetCSats ?? cfg.perTentacleCSats, cfg.budgetCSats - st.spent));
    let ws: Workspace | null = null;
    const started = Date.now();
    const tokens = { prompt: 0, output: 0 };
    let where: string | undefined;
    // Where the latest attempt ran (local first), and the local model when it ran here.
    let place: "local" | "worker" = "worker";
    let localModel = "";
    // `call`: the call being recorded (not yet in `calls`): its line uses only its own served-by, never an
    // earlier call's host; with none, the latest call's (a cloud reply without one read "network apple · mac-…" from a Mac attempt).
    const whereNow = (call?: { served?: ServedBy }) => (place === "local" ? { model: localModel, class: "this computer", agentLabel: "this computer" } : whereServed(where, model, (call ?? calls[calls.length - 1])?.served));
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
      // After an empty attempt on the worker: where the retry goes (another machine, or auto's next tier).
      let retry: ReturnType<typeof retryAfterEmpty> | null = null;
      const markEmpty = (why: "empty_reply" | "no_file") => {
        retry = place === "worker" ? retryAfterEmpty(model, minB, why) : null;
      };
      for (const escalate of [false, true]) {
        if (t.abort.signal.aborted) break;
        attempts++;
        const again = retry as ReturnType<typeof retryAfterEmpty> | null;
        // Whether this attempt's hints move up a tier: the retry does, unless it follows an empty
        // reply (another machine at this tier first) or a provider error was seen lately (the next
        // tier is where a suspended cloud provider sits on auto).
        let tierUp = false;
        if (escalate) {
          if (ws) resetWorkspace(ws);
          if (again) model = again.model;
          const providerDown = st.providerErrorAt !== undefined && Date.now() - st.providerErrorAt < PROVIDER_ERROR_SKIP_MS;
          tierUp = (again ? again.nextTier : true) && !providerDown;
          const skipped = providerDown && (again ? again.nextTier : place !== "local");
          this.progress(sessionId, t, skipped ? "retrying on another machine at this tier (the next tier's provider returned an error lately)" : again ? again.note : place === "local" ? "retrying on the network (a stronger tier)" : "retrying on a stronger tier");
        }
        checks.length = 0;
        let budgetHit = false;
        let budgetWhy = "";
        let holdKey: number | undefined;
        let frontierRefused = false;
        let text = "";
        const read = (p: string) => readText(root, p);
        const prompt = tentaclePrompt(t.spec, read, cfg.maxContextChars, lastFailure ? `# A previous attempt failed\n${lastFailure.slice(0, 3000)}` : undefined);
        // Local first: a low-complexity first attempt on auto runs on a capable model on this computer.
        const { level } = tentacleComplexity(t.spec, { escalate, promptChars: prompt.length });
        let local: string | null = null;
        if (!escalate && level === "low" && cfg.localFirst && model === "auto" && this.d.localModelFor && this.d.localBackend) {
          const need = workerHints(t.spec, { promptChars: prompt.length });
          local = await this.d.localModelFor({ minContext: need.minContext ?? 8_192, promptTokens: Math.ceil(prompt.length / 3) }).catch(() => null);
          if (t.abort.signal.aborted) break;
        }
        const placed = tentaclePlacement({ workerModel: model, level, escalate, localFirst: cfg.localFirst, localModel: local });
        place = placed.place;
        if (place === "local") {
          localModel = placed.model;
          t.view.model = localModel;
          this.progress(sessionId, t, `running on this computer (${localModel})`);
        } else if (escalate || attempts === 1) {
          t.view.model = model;
        }
        const chat = hintedChat(
          // Local first on this computer; otherwise the worker. An explicit worker model stays the
          // same on the retry (no surprise spend); "auto" moves up a tier by its hints, and a local
          // attempt's retry goes to the network.
          place === "local" ? this.d.localBackend!(localModel) : this.d.workerBackend(model, sessionId, { role: "worker" }),
          async () => {
            const hintsFor = (maxCSats: number) =>
              workerHints(t.spec, { escalate: tierUp, promptChars: prompt.length, maxCSats, tentacleId: escalate && (again?.freshHost || !tierUp) ? `${t.view.id}:retry` : t.view.id, ...(place === "worker" && model === "auto" ? { minParamsB: minB } : {}) });
            // Free places hold nothing; a paid call's ceiling is sized from the budgets left (tentacle-reserve.ts).
            if (place !== "worker" || !paidWorker(model)) return hintsFor(Math.max(0, budget - t.spent));
            for (;;) {
              const ceiling = helperCallCeiling({ tentacleLeft: budget - t.spent, sessionLeft: cfg.budgetCSats - st.spent, heldByOthers: st.holds.total() });
              const refusal = ceilingRefusal(ceiling, { tentacleBudget: budget, tentacleLeft: budget - t.spent });
              if (!refusal) {
                holdKey = st.holds.hold(ceiling);
                return hintsFor(ceiling);
              }
              // Other helpers' calls hold the session's budget: wait for one to end.
              if (budget - t.spent >= MIN_HELPER_CALL_CSATS && st.holds.total() > 0 && !t.abort.signal.aborted) {
                await st.holds.released(30_000, t.abort.signal);
                continue;
              }
              budgetHit = true;
              budgetWhy = refusal;
              throw new Error(refusal);
            }
          },
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
            // This call's own route line: a call without one (a named cloud model) must not take the
            // model of an earlier call's route ("qwen2.5-coder:7b · network cloud").
            where = u.where;
            const w = whereNow(u);
            t.view.model = w.model;
            const callPlace: TentaclePlace = place === "local" || u.served?.computeClass === "local" ? "local" : "network";
            const call: TentacleCall = { cSats: round(u.cSats), model: w.model, place: callPlace, ...(u.where ? { where: u.where } : {}), ...(u.served ? { served: u.served } : {}), ...(u.promptTokens !== undefined ? { promptTokens: u.promptTokens } : {}), ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}) };
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
          {
            // Each call's reply is sized to fit the smallest window that holds its prompt (an
            // 8192 reply fit no 8192-token host, so every helper call waited for one larger host).
            ...(place === "worker" ? { maxTokens: (msgs: Parameters<typeof promptTokensOf>[0], tools?: unknown[]) => helperReplyTokens(promptTokensOf(msgs, tools)) } : {}),
            after: () => {
              st.holds.release(holdKey);
              holdKey = undefined;
            },
            // A provider error (seen even when the agent loop retries the call) keeps the session's
            // retries off the next tier for a while.
            onError: (err) => {
              if (place === "worker" && isProviderTierError(err instanceof Error ? err.message : String(err))) st.providerErrorAt = Date.now();
            },
          },
        );
        await runAgentLoop({
          chat,
          systemPrompt: () => tentacleSystemPrompt(!ws),
          messages: [{ role: "user", content: prompt }],
          native: true,
          maxIterations: this.d.maxIterations ?? 12,
          // Keep a network helper's history short (C7: long histories timed out on CPU hosts).
          ...(place === "worker" ? { compactAtTokens: HELPER_COMPACT_AT_TOKENS } : {}),
          // Like a bot run, nobody is there to say "go on" after a reply that only announces work.
          continueOnIntent: true,
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
          outcome = { status: "error", summary, error: budgetWhy ? `The tentacle stopped before a call: ${budgetWhy}.` : `The tentacle's budget ran out (${formatCSatsShort(budget)}).` };
          break; // no escalation past a budget
        }
        const empty = emptyAttempt({ modelError, summary, changedFiles: ws ? workspacePatch(ws).files.length : 0, writes: !!ws && t.spec.kind !== "review" });
        if (modelError && !summary) {
          outcome = { status: "error", summary, error: modelError };
          lastFailure = `The model call failed: ${modelError}`;
          if (empty === "empty_reply") markEmpty(empty);
          continue;
        }
        if (empty === "empty_reply") {
          outcome = { status: "error", summary, error: "The helper returned an empty reply." };
          lastFailure = "Your previous attempt returned an empty reply: no summary and no change. Start by calling a tool (read_file, then edit_file or write_file), then reply with a short summary.";
          markEmpty(empty);
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
            markEmpty("no_file");
            continue;
          }
        }
        outcome = { status: "passed", summary };
        break;
      }
      if (t.abort.signal.aborted) return this.finish(sessionId, t, "cancelled", undefined, "cancelled");
      const p = ws ? workspacePatch(ws) : { patch: "", files: [] };
      const w = whereNow();
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
        place: placeOf(place, calls),
        ...(unverified ? { unverified } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
      this.finish(sessionId, t, outcome.status, result, undefined, ws);
    } catch (err) {
      if (t.abort.signal.aborted) return this.finish(sessionId, t, "cancelled", undefined, "cancelled");
      const w = whereNow();
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
        place: placeOf(place, calls),
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
    const where = r ? tentacleRanOn(r) : t.view.model ?? "auto";
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
