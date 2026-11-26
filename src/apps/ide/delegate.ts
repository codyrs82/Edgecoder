// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The lead's tentacle tools (tentacles.ts, docs/tentacles.md):
 *
 *   delegate({ task, kind, files[], instructions, acceptance?, complexity?, budgetCSats?, readOnly? })
 *     → a tentacle id at once; the helper runs in parallel on a cheaper worker model.
 *   await_tentacles({ ids?, timeoutS? })  → results as they finish (status, merge, summary, patch).
 *   cancel_tentacle({ id })
 *
 * Offered only when the session has tentacles on (a session option, or EDGECODER_TENTACLES=1).
 * They plug into a session through its TurnEnv: `withTentacleTools` adds the schemas,
 * `tentacleExecutor` answers the calls and `withTentacleGuidance` adds the system-prompt guidance.
 */

import type { ToolRunnerDeps, ToolSchema } from "./agent-loop.js";
import { TentacleError, TENTACLE_KINDS, formatCSatsShort, tentacleCallLine, tentacleRanOn, tentacleTotals, type TentacleManager, type TentacleSpec, type TentacleView } from "./tentacles.js";
import type { ToolName } from "./tool-types.js";
import type { AcceptanceKind } from "./tentacle-workspace.js";

const ACCEPTANCE_KINDS: readonly AcceptanceKind[] = ["vitest", "tsc", "grep", "none"];

/** JSON-schema function definitions for the three tools (arrays and objects typed properly). */
export const TENTACLE_TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "delegate",
      description:
        "Hand an independent, well-specified piece of work to a helper agent (a tentacle) on a cheaper, slower network model. Returns a tentacle id at once; keep working and collect the result with await_tentacles. The helper sees only the files and instructions you give, works in its own copy of the project, runs the acceptance check, and its patch is merged back when it passes.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "One line: what the helper must do." },
          kind: { type: "string", description: `One of ${TENTACLE_KINDS.join(", ")}.` },
          files: { type: "array", description: "Project paths the helper needs, or ranges as path#L10-L40. Keep it small.", items: { type: "string" } } as never,
          instructions: { type: "string", description: "Everything the helper needs to know: the exact change, names, constraints, style. It can't ask you." },
          acceptance: {
            type: "object",
            description: 'How to verify it: {"kind":"vitest","args":["tests/x.test.ts"]}, {"kind":"tsc"}, {"kind":"grep","args":{"pattern":"foo\\\\(","paths":["src"],"absent":false}} or {"kind":"none"}.',
          } as never,
          complexity: { type: "string", description: "low, medium or high (picks the worker tier)." },
          budgetCSats: { type: "number", description: "Most this helper may spend, in cSats." },
          readOnly: { type: "boolean", description: "True when it only reads (search, summarize, review): no workspace, no patch." },
        },
        required: ["task", "kind", "instructions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "await_tentacles",
      description: "Wait for delegated helpers and get their results as they finish (default: every one you haven't seen yet). Returns those finished so far and the ids still running; call again for the rest.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", description: "Tentacle ids to wait for (default: all not yet reported).", items: { type: "string" } } as never,
          timeoutS: { type: "number", description: "Seconds to wait at most (default 120, max 600)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_tentacle",
      description: "Stop a delegated helper that is no longer needed.",
      parameters: { type: "object", properties: { id: { type: "string", description: "The tentacle id." } }, required: ["id"] },
    },
  },
];

/** The guidance the lead's system prompt gets when tentacles are on. */
export const TENTACLE_GUIDANCE = `## Tentacles (helper agents)
You can delegate work to helper agents on cheaper, slower network models with the delegate tool. Use it for independent, well-specified pieces: writing tests for a function, a contained edit to one or two files, a search across the codebase, a summary, docs, a review, one piece of a refactor. Start several at once when they don't depend on each other.
- Keep planning, design decisions and integration yourself. Don't delegate anything you can't specify completely in the instructions; the helper sees only the files and instructions you give it and can't ask questions.
- Give each a precise acceptance check (vitest file, tsc, or grep) so its result is verified before it is merged.
- Helpers run on network models (never your own key), within the session's permission mode: they can't run anything the user would be asked about.
- Continue your own work, then call await_tentacles. A passed patch that applies cleanly is merged into the project for you (or waits for the user's approval). For a conflict or a failed check you get the patch and the errors: re-delegate with better instructions, fix it yourself, or drop it.
- End your reply with the helpers' totals line from await_tentacles (sessionTotals) so the user sees what they cost.`;

export class DelegateArgsError extends Error {}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  if (typeof v === "string" && v.trim()) {
    // Small models send lists as a JSON string or a comma list.
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) return strList(parsed);
    } catch {
      // not JSON
    }
    return v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
};

/** delegate's arguments as a spec, or a DelegateArgsError saying what is wrong. */
export function parseDelegateArgs(args: Record<string, unknown>): TentacleSpec {
  const task = str(args.task);
  if (!task) throw new DelegateArgsError("task is required");
  if (task.length > 500) throw new DelegateArgsError("task is one line (500 characters at most); put details in instructions");
  const kind = str(args.kind) as TentacleSpec["kind"];
  if (!TENTACLE_KINDS.includes(kind)) throw new DelegateArgsError(`kind must be one of ${TENTACLE_KINDS.join(", ")}`);
  const instructions = str(args.instructions);
  if (instructions.length > 20_000) throw new DelegateArgsError("instructions are too long (20,000 characters at most)");
  const files = strList(args.files).slice(0, 40);
  if (files.some((f) => f.startsWith("/") || f.startsWith("~") || f.split(/[\\/]/).includes(".."))) throw new DelegateArgsError("files are project-relative paths");
  let acceptance: TentacleSpec["acceptance"];
  let acc: unknown = args.acceptance;
  if (typeof acc === "string" && acc.trim()) {
    try {
      acc = JSON.parse(acc);
    } catch {
      acc = { kind: (acc as string).trim() };
    }
  }
  if (acc && typeof acc === "object") {
    const a = acc as Record<string, unknown>;
    const k = str(a.kind) as AcceptanceKind;
    if (!ACCEPTANCE_KINDS.includes(k)) throw new DelegateArgsError(`acceptance.kind must be one of ${ACCEPTANCE_KINDS.join(", ")}`);
    acceptance = { kind: k, ...(a.args !== undefined ? { args: a.args } : {}) };
  }
  const complexity = str(args.complexity);
  if (complexity && !["low", "medium", "high"].includes(complexity)) throw new DelegateArgsError("complexity is low, medium or high");
  const budget = args.budgetCSats === undefined || args.budgetCSats === null || args.budgetCSats === "" ? undefined : Number(args.budgetCSats);
  if (budget !== undefined && !(Number.isFinite(budget) && budget >= 0)) throw new DelegateArgsError("budgetCSats is a number of cSats");
  const readOnly = args.readOnly === true || args.readOnly === "true";
  return {
    task,
    kind,
    files,
    instructions,
    ...(acceptance ? { acceptance } : {}),
    ...(complexity ? { complexity: complexity as TentacleSpec["complexity"] } : {}),
    ...(budget !== undefined ? { budgetCSats: budget } : {}),
    ...(readOnly ? { readOnly } : {}),
  };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

/** One finished (or running) tentacle as the lead reads it. */
export function describeTentacle(t: TentacleView): Record<string, unknown> {
  const r = t.result;
  const merge = t.merge?.state;
  const out: Record<string, unknown> = { id: t.id, task: t.task, status: t.status };
  if (merge) out.merge = merge;
  if (t.status === "queued" || t.status === "running" || t.status === "verifying") {
    out.progress = t.progress;
    return out;
  }
  if (r) {
    out.summary = cut(r.summary, 3000);
    if (r.filesTouched.length) out.filesTouched = r.filesTouched;
    if (r.checks.length) out.checks = r.checks.map((c) => ({ command: c.command, passed: c.passed, ...(c.passed ? {} : { output: cut(c.output, 2000) }) }));
    out.ranOn = tentacleRanOn(r);
    // Each model call's served line: model · class · host region · tokens · cSats.
    if (r.calls?.length) out.served = r.calls.map(tentacleCallLine);
    out.cSats = r.cSats;
    if (r.unverified) out.unverified = r.unverified;
    // Run 14: stopped at a budget with a patch (merged when its check passed, else waiting for approval).
    if (r.partial) out.partial = r.partial;
    out.attempts = r.attempts;
    if (r.error) out.error = r.error;
    // The patch matters when it wasn't merged: the lead decides what to do with it.
    if (r.patch && merge !== "applied") out.patch = cut(r.patch, 8000);
  }
  if (t.merge?.error) out.mergeError = cut(t.merge.error, 2000);
  if (merge === "applied") out.note = "Merged into the project (undoable with /undo).";
  if (merge === "awaiting_approval") out.note = "Passed and applies cleanly; waiting for the user to approve merging it.";
  if (merge === "conflict") out.note = "Doesn't apply to the project as it is now: re-delegate, apply it yourself, or drop it.";
  if (t.status === "failed") out.note = "Its check failed after a retry on a stronger tier: re-delegate with clearer instructions, fix it yourself, or drop it.";
  // Run 14: a helper stopped at its budget with work done: say what happened to the patch; don't apply it by hand.
  if (r?.partial && merge === "applied") out.note = "Stopped at its budget, but its patch passed its check and was merged (undoable with /undo). Don't apply it again.";
  if (r?.partial && merge === "awaiting_approval") out.note = "Stopped at its budget with a patch; it is waiting for the user to approve merging it. Don't apply it by hand.";
  return out;
}

/**
 * About what one helper needs on the account to run at all: the cheapest fitting (≥ 7B) model's call
 * was ~3.9 cSats in network runs 12-13 (a helper call's reserve is capped at its ceiling).
 */
export const HELPER_BALANCE_FLOOR_CSATS = 4;

/**
 * What the session's tentacle budget left, and the account's balance, cover when a helper is delegated
 * (network runs 13-14), or null when they cover every helper not finished. `short` comes first in the
 * note (the terminal cuts it after a few dozen characters); `detail` follows. With helpers finished
 * (and paid), at their average cost; before that, at each helper's own budget (`perTentacle`), the
 * most one may spend. Helpers share the budget and wait for room, and with a short balance run fewer
 * at once, so a shortfall is a warning: the helpers left when it is spent stop with "budget reached".
 */
export function budgetCoverage(o: { left: number; open: number; perTentacle: number; average?: number; balance?: number }): { short: string; detail: string } | null {
  if (o.open <= 0) return null;
  const balance = o.balance !== undefined && Number.isFinite(o.balance) ? Math.max(0, o.balance) : undefined;
  if (balance !== undefined && balance < HELPER_BALANCE_FLOOR_CSATS) {
    return { short: `Balance ${formatCSatsShort(balance)}: can't run a helper.`, detail: `The account's balance can't cover one helper call (about ${formatCSatsShort(HELPER_BALANCE_FLOOR_CSATS)}): helpers will stop. Tell the user to add cSats, or do the work yourself.` };
  }
  const byBalance = balance !== undefined && balance < Math.max(0, o.left);
  const left = byBalance ? balance! : Math.max(0, o.left);
  const what = byBalance ? "the account's balance" : "the session's tentacle budget left";
  const per = o.average !== undefined && o.average > 0 ? o.average : o.perTentacle > 0 ? o.perTentacle : 0;
  if (!per || o.open * per <= left) return null;
  const k = Math.floor(left / per);
  const basis = o.average !== undefined && o.average > 0 ? `this session's average of ${formatCSatsShort(per)} a helper` : `each helper's own budget (${formatCSatsShort(per)}), the most one may spend`;
  return {
    short: `${byBalance ? "Balance" : "Budget"} covers ~${k} of ${o.open} helpers.`,
    detail: `At ${basis}, ${what} (${formatCSatsShort(left)}) covers about ${k} of the ${o.open} helpers not finished. They share it and wait for room${byBalance ? ", fewer running at once" : ""}; if it runs out, the rest stop with "budget reached". Tell the user before they run${byBalance ? "; adding cSats lifts the limit" : "; raising the session's tentacle budget lifts it"}.`,
  };
}

/** Answer a tentacle tool call for `sessionId`; other tools go to `inner`. */
export function tentacleExecutor(manager: TentacleManager, sessionId: string, inner: ToolRunnerDeps["execute"]): ToolRunnerDeps["execute"] {
  return async (tool: ToolName, args, opts) => {
    if (tool !== "delegate" && tool !== "await_tentacles" && tool !== "cancel_tentacle") return inner(tool, args, opts);
    try {
      if (tool === "delegate") {
        const spec = parseDelegateArgs(args);
        const v = manager.delegate(sessionId, spec);
        const cfg = manager.config(sessionId);
        const listed = manager.list(sessionId);
        const left = cfg.budgetCSats - listed.spentCSats;
        const done = listed.tentacles.filter((t) => (t.status === "passed" || t.status === "failed" || t.status === "error") && t.cSats > 0);
        // Run 14: the account's balance too (helpers on paid models only; null when unknown).
        const balance = await manager.accountBalance(sessionId).catch(() => undefined);
        const cover = budgetCoverage({
          left,
          open: listed.tentacles.filter((t) => t.status === "queued" || t.status === "running" || t.status === "verifying").length,
          perTentacle: cfg.perTentacleCSats,
          ...(done.length ? { average: done.reduce((n, t) => n + t.cSats, 0) / done.length } : {}),
          ...(balance !== undefined ? { balance } : {}),
        });
        // Run 14 (c): the terminal cuts the note after a few dozen characters: the coverage goes first, short.
        const note = cover ? `${cover.short} ${cover.detail} Collect it with await_tentacles.` : `Started; ${formatCSatsShort(Math.max(0, left))} budget left. Collect it with await_tentacles.`;
        return { result: JSON.stringify({ id: v.id, status: v.status, note }) };
      }
      if (tool === "await_tentacles") {
        const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : typeof args.ids === "string" && args.ids ? args.ids.split(/[,\s]+/).filter(Boolean) : undefined;
        const timeoutS = Number.isFinite(Number(args.timeoutS)) && args.timeoutS !== undefined ? Number(args.timeoutS) : 120;
        const r = await manager.awaitResults(sessionId, ids, timeoutS);
        return {
          result: JSON.stringify({
            finished: r.finished.map(describeTentacle),
            stillRunning: r.pending.map((t) => ({ id: t.id, task: t.task, status: t.status, progress: t.progress })),
            // Totals for your summary: these results, and the session's helpers so far.
            ...(r.finished.length ? { totals: tentacleTotals(r.finished).line } : {}),
            sessionTotals: tentacleTotals(manager.list(sessionId).tentacles).line,
            ...(r.timedOut ? { timedOut: true } : {}),
          }),
        };
      }
      const id = String(args.id ?? "");
      const ok = manager.cancel(sessionId, id);
      return ok ? { result: `Cancelled ${id}.` } : { error: `No running tentacle ${id}.` };
    } catch (err) {
      if (err instanceof DelegateArgsError || err instanceof TentacleError) return { error: `${tool}: ${err.message}` };
      throw err;
    }
  };
}

/** The session's tools plus the tentacle tools when tentacles are on. */
export function withTentacleTools(tools: ToolSchema[] | undefined, on: boolean): ToolSchema[] | undefined {
  if (!on || !tools) return tools;
  return [...tools.filter((t) => !TENTACLE_TOOL_SCHEMAS.some((x) => x.function.name === t.function.name)), ...TENTACLE_TOOL_SCHEMAS];
}

/** The system prompt plus the guidance, and what finished since the lead last looked. */
export function withTentacleGuidance(prompt: (format: "native" | "text") => string, on: boolean, unreported: TentacleView[] = []): (format: "native" | "text") => string {
  if (!on) return prompt;
  const status = unreported.length
    ? `\n\nTentacles that finished since you last checked (call await_tentacles for details): ${unreported.map((t) => `${t.id} "${t.task}" ${t.status}${t.merge ? ` (${t.merge.state})` : ""}`).join("; ")}.`
    : "";
  return (format) => `${prompt(format)}\n\n${TENTACLE_GUIDANCE}${status}`;
}
