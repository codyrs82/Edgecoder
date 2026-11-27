// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What a bot's runs came to, so it doesn't loop on its own. A bot checking in every 30 minutes on a
 * small model asked to run `npm test` in a Dropbox notes folder 50 times: you allowed it, npm said
 * there's no package.json, the bot wrote the same "Summary / Next steps" and asked again next run.
 *
 *   - outcomeOf: a run's actions (tool, command, whether you were asked and what you said, the
 *     error) and its final message, kept on the run.
 *   - runsDigest: the last few runs as a short "last runs" block in the next run's prompt, with the
 *     commands that already failed or that you said no to.
 *   - KnownBlock: those commands (same command, same folder). Runs the bot starts on its own don't
 *     ask for them again; the tool result says it failed before (or that you said no).
 *   - stuckProblem: the same problem (same action, same failure, a near-identical message) three
 *     runs in a row pauses the bot until you message it or resume it. A run that failed only because
 *     the network couldn't be reached right now (networkUnavailable) never counts: nothing the bot
 *     does would change it, so it waits and tries again instead (bots.ts).
 *   - projectCheck: npm, git, pytest, cargo … in a folder that isn't a code project are refused
 *     before anyone is asked, with a tool result that says so and what to do instead.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { IdeStreamEvent } from "./tool-types.js";
import { runFailureClass } from "../../common/run-failures.js";

export { runFailureClass, type RunFailureClass } from "../../common/run-failures.js";

/** What happened to one tool call in a run. */
export interface RunAction {
  tool: string;
  /** The same call in the same folder: tool + normalized command/args + folder. */
  key: string;
  /** "npm test src/x.ts", "git push", "write_file README.md". */
  label: string;
  /** Asked and answered (approved/denied), not answered (timeout), not asked (auto), or held back (skipped: known failure, not a project). */
  approval: "approved" | "denied" | "unanswered" | "auto" | "skipped";
  /** The failure, in a few words ("package.json not found"). */
  error?: string;
}

export interface RunOutcome {
  actions: RunAction[];
  /** The run's first problem in a few words ("npm test: package.json not found"); none when nothing failed. */
  problem?: string;
  /** The run's final message, shortened. */
  reply: string;
  /** It failed only because the network couldn't be reached right now (networkUnavailable): not the bot's problem. */
  unavailable?: true;
}

/**
 * A run error that says the network couldn't be reached right now, not that the bot did anything
 * wrong: this computer's agent isn't connected (it is starting, reconnecting after sleep or a
 * network change, or its coordinator is restarting), the coordinator is restarting for an update,
 * every machine for the model is busy, or the local agent didn't answer. Waiting fixes these.
 * (Out of cSats is not one of them: bots.ts handles it on its own.)
 */
export function networkUnavailable(error: string | undefined): boolean {
  return runFailureClass(error) === "transient";
}


/** A command not to ask about again in this bot: it failed after you allowed it, or you said no. */
export interface KnownBlock {
  key: string;
  tool: string;
  label: string;
  kind: "failed" | "denied";
  error?: string;
  atMs: number;
  /** Times it was asked and failed (or denied). */
  count: number;
}

export const MAX_KNOWN_BLOCKS = 20;
/** Near-identical: the normalized final messages share at least this much (word-pair overlap). */
export const SIMILAR_REPLY = 0.8;
/** The same problem this many runs in a row pauses the bot. */
export const STUCK_RUNS = 3;
const MAX_ACTIONS = 8;
const MAX_REPLY = 600;
export const MAX_DIGEST_CHARS = 1_800;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Text for comparing: lowercase words, no paths, numbers, times, ids or markdown. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/`+|\*+|#+|_+|>+/g, " ")
    .replace(/(?:\/[\w.@~+-]+){2,}\/?/g, " path ")
    .replace(/\b(?:run|tc|bot)_[0-9a-f]+\b/g, " id ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0..1: how alike two messages are (Dice on word pairs of the normalized text). */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const pairs = (s: string) => {
    const w = s.split(" ").filter(Boolean);
    const out = new Map<string, number>();
    if (w.length === 1) out.set(w[0], 1);
    for (let i = 0; i < w.length - 1; i++) out.set(`${w[i]} ${w[i + 1]}`, (out.get(`${w[i]} ${w[i + 1]}`) ?? 0) + 1);
    return out;
  };
  const pa = pairs(na);
  const pb = pairs(nb);
  let total = 0;
  let shared = 0;
  for (const n of pa.values()) total += n;
  for (const n of pb.values()) total += n;
  for (const [k, n] of pa) shared += Math.min(n, pb.get(k) ?? 0);
  return total ? (2 * shared) / total : 0;
}

/** The command a call stands for, for people: "npm test src/x.ts", "git push", "write_file a.md". */
export function actionLabel(tool: string, args: Record<string, unknown>): string {
  if (tool === "run_shell" && typeof args.command === "string") return clip(oneLine(args.command), 160);
  const target = [args.path, args.branch, args.title, args.message].find((v) => typeof v === "string" && v.trim());
  return clip(`${tool.replace(/_/g, " ")}${target ? ` ${oneLine(String(target))}` : ""}`, 160);
}

/** The same call in the same folder (whitespace in a command doesn't matter). */
export function actionKey(tool: string, args: Record<string, unknown>, cwd: string): string {
  const what =
    tool === "run_shell" && typeof args.command === "string"
      ? oneLine(args.command)
      : JSON.stringify(Object.keys(args).sort().filter((k) => k !== "content" && k !== "body").map((k) => [k, args[k]]));
  return `${tool}\u0000${what}\u0000${resolve(cwd)}`;
}

/** A failure in a few words: "package.json not found", "not a git repository", the first error line. */
export function errorGist(text: string): string {
  const t = text.trim();
  if (!t) return "failed";
  const pkg = /(?:no such file or directory|ENOENT|could not read|not found|missing)[^\n]*package\.json|package\.json[^\n]*(?:not found|ENOENT|no such file)/i.exec(t);
  if (pkg) return "package.json not found";
  if (/not a git repository/i.test(t)) return "not a git repository";
  const notFound = /(?:command not found|not found|not recognized)[:\s]*([\w.-]+)?/i.exec(t);
  if (/command not found|is not recognized as/i.test(t) && notFound) return clip(oneLine(notFound[0]), 100);
  if (/rejected by the user/i.test(t)) return "you said no";
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /\berr(or)?\b|failed|fatal|cannot|can't|unable|denied|refused/i.test(l)) ?? lines[0];
  return clip(oneLine(line.replace(/^(npm (ERR!|error)|error:?|fatal:?|\[error\]:?)\s*/i, "")), 120) || "failed";
}

/**
 * A run's outcome from its stream events: each tool call with what you answered and how it ended,
 * the first problem, and the final message. `decisions`: callId → what happened to an approval.
 */
export function outcomeOf(opts: {
  events: IdeStreamEvent[];
  decisions: Map<string, "approved" | "denied" | "unanswered">;
  cwd: string;
  reply: string;
  runError?: string;
}): RunOutcome {
  const calls = new Map<string, RunAction>();
  const order: RunAction[] = [];
  for (const e of opts.events) {
    if (e.type === "tool_call") {
      const a: RunAction = {
        tool: e.tool,
        key: actionKey(e.tool, e.args ?? {}, opts.cwd),
        label: actionLabel(e.tool, e.args ?? {}),
        approval: e.requires_approval ? opts.decisions.get(e.id) ?? "unanswered" : "auto",
      };
      calls.set(e.id, a);
      order.push(a);
    } else if (e.type === "tool_result" && e.error) {
      const a = calls.get(e.id);
      if (!a) continue;
      // Held back without asking (heldGist): it counts as the problem it was held back for.
      const held = a.approval === "auto" ? heldGist(e.error) : null;
      if (held) a.approval = "skipped";
      a.error = a.approval === "denied" ? "you said no" : held ?? errorGist(e.error);
    } else if (e.type === "shell_output" && e.exit_code !== 0) {
      const a = calls.get(e.id);
      if (a) a.error = errorGist(`${e.stderr}\n${e.stdout}`);
    }
  }
  // Tools that only look (read_file, list_directory) can miss a file without anything being wrong.
  const looked = (a: RunAction) => a.approval === "auto" && /^(read_file|list_directory|search_files|search_codebase|git_status|git_diff|git_log)$/.test(a.tool);
  const bad = order.find((a) => (a.error && !looked(a)) || a.approval === "unanswered");
  const problem = opts.runError
    ? clip(oneLine(opts.runError), 140)
    : bad
      ? `${clip(bad.label, 80)}: ${bad.approval === "unanswered" ? "waiting for your approval" : bad.error}`
      : undefined;
  // The interesting calls first: those that asked you or failed.
  const kept = [...order.filter((a) => a.approval !== "auto" || a.error), ...order.filter((a) => a.approval === "auto" && !a.error)].slice(0, MAX_ACTIONS);
  return { actions: kept, ...(problem ? { problem } : {}), reply: clip(oneLine(lastParagraphs(opts.reply)), MAX_REPLY), ...(networkUnavailable(opts.runError) ? { unavailable: true as const } : {}) };
}

/** The end of a reply (its conclusion), where a looping bot repeats itself. */
function lastParagraphs(text: string): string {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras.slice(-4).join("\n\n");
}

/** Two runs that came to the same thing: the same failing action(s), the same problem, a near-identical message. */
export function sameOutcome(a: RunOutcome, b: RunOutcome): boolean {
  if (!a.problem || !b.problem) return false;
  // The network was out of reach: waiting fixes it, so it never makes a streak.
  if (a.unavailable || b.unavailable) return false;
  if (normalizeText(a.problem) !== normalizeText(b.problem)) return false;
  const failing = (o: RunOutcome) => o.actions.filter((x) => x.error || x.approval === "unanswered" || x.approval === "denied").map((x) => x.key).sort().join("\n");
  if (failing(a) !== failing(b)) return false;
  return textSimilarity(a.reply, b.reply) >= SIMILAR_REPLY;
}

/** The problem when the last STUCK_RUNS outcomes (oldest first) all came to the same thing; else null. */
export function stuckProblem(outcomes: RunOutcome[], runs = STUCK_RUNS): string | null {
  if (outcomes.length < runs) return null;
  const last = outcomes.slice(-runs);
  for (let i = 1; i < last.length; i++) if (!sameOutcome(last[i - 1], last[i])) return null;
  return last[last.length - 1].problem ?? null;
}

/** Known blocks after a run's actions: failures and refusals added, a command that now worked dropped. */
export function updateBlocks(blocks: KnownBlock[], actions: RunAction[], atMs: number): KnownBlock[] {
  let out = [...blocks];
  for (const a of actions) {
    if (a.approval === "approved" && !a.error) {
      out = out.filter((b) => b.key !== a.key);
      continue;
    }
    const kind = a.approval === "denied" ? "denied" : a.approval === "approved" && a.error ? "failed" : null;
    if (!kind) continue;
    const prev = out.find((b) => b.key === a.key);
    const next: KnownBlock = { key: a.key, tool: a.tool, label: a.label, kind, ...(kind === "failed" && a.error ? { error: a.error } : {}), atMs, count: (prev?.count ?? 0) + 1 };
    out = [...out.filter((b) => b.key !== a.key), next];
  }
  return out.slice(-MAX_KNOWN_BLOCKS);
}

const HELD_DENIED = "Not asked again: the user said no";
const HELD_FAILED = "Not run again:";

/**
 * What a held-back call's tool result (blockedResult, projectCheck) was held back for, in a few
 * words ("Missing script: \"test\"", "you said no", "not a code project (no package.json)"); null
 * for any other result.
 */
export function heldGist(text: string): string | null {
  const notProject = /isn't a code project \((no [^)]+)\)/.exec(text);
  if (notProject) return `not a code project (${notProject[1]})`;
  if (text.startsWith(HELD_DENIED)) return "you said no";
  const failed = text.startsWith(HELD_FAILED) ? /and failed: ([\s\S]*?)\. Running it again won't change that\./.exec(text) : null;
  return failed ? failed[1] : null;
}

/** The tool result for a call held back because of a known block. */
export function blockedResult(b: KnownBlock, when: string): string {
  return b.kind === "denied"
    ? `${HELD_DENIED} to \`${b.label}\` (${when}). Don't ask for it again unless the user tells you to; do something else or ask the user what they want.`
    : `${HELD_FAILED} \`${b.label}\` already ran here (${when}, after the user allowed it) and failed: ${b.error ?? "failed"}. Running it again won't change that. Don't retry it without a new reason: fix the cause first, or tell the user what's blocking you and ask what to do.`;
}

interface DigestRun {
  trigger: string;
  startedAtMs: number;
  status: string;
  summary: string;
  outcome?: RunOutcome;
}

const TRIGGER_WORDS: Record<string, string> = { start: "start", heartbeat: "check-in", schedule: "scheduled", follow_up: "follow-up", message: "your message", github: "GitHub", manual: "check now" };
const APPROVAL_WORDS: Record<RunAction["approval"], string> = { approved: "you allowed it", denied: "you said no", unanswered: "not answered", auto: "", skipped: "held back" };

/**
 * The "last runs" block for the next run's prompt: what each recent run tried, what failed and why,
 * what you answered; then the commands not to repeat. Newest runs are kept when it's too long.
 */
export function runsDigest(runs: DigestRun[], blocks: KnownBlock[], fmt: (ms: number) => string, max = MAX_DIGEST_CHARS): string {
  const lines: string[] = [];
  for (const r of runs.slice(-5)) {
    const o = r.outcome;
    const acts = (o?.actions ?? [])
      .filter((a) => a.approval !== "auto" || a.error)
      .slice(0, 3)
      .map((a) => `\`${clip(a.label, 70)}\`${APPROVAL_WORDS[a.approval] ? ` (${APPROVAL_WORDS[a.approval]})` : ""}${a.error ? ` → failed: ${clip(a.error, 90)}` : " → ok"}`);
    const said = o?.reply ? clip(o.reply, 160) : clip(oneLine(r.summary), 160);
    lines.push(`- ${fmt(r.startedAtMs)} (${TRIGGER_WORDS[r.trigger] ?? r.trigger}, ${r.status}): ${acts.length ? `tried ${acts.join("; ")}. ` : ""}${said ? `Ended with: "${said}"` : ""}`.trim());
  }
  const avoid = blocks.slice(-6).map((b) => `- \`${clip(b.label, 80)}\`: ${b.kind === "denied" ? "the user said no" : `failed (${clip(b.error ?? "failed", 80)})${b.count > 1 ? `, ${b.count} times` : ""}`}`);
  if (!lines.length && !avoid.length) return "";
  const head = "Your last runs (oldest first):";
  const rule =
    "Don't repeat an action that failed or that the user said no to unless something has changed or you have a new reason; commands listed under \"Don't repeat\" won't be asked about again. If the same thing keeps blocking you, say plainly what's blocking you and ask the user one clear question instead of writing the same summary again.";
  const build = (ls: string[]) => [head, ...ls, ...(avoid.length ? ["Don't repeat (same command, same folder):", ...avoid] : []), rule].join("\n");
  let kept = [...lines];
  let out = build(kept);
  while (out.length > max && kept.length > 1) {
    kept = kept.slice(1);
    out = build(kept);
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ---------------------------------------------------------------------------
// Working folder sanity: repo commands need a project
// ---------------------------------------------------------------------------

interface ProjectRule {
  /** The command (after env assignments) starts like this. */
  match: RegExp;
  /** …unless it's one of these (works anywhere: init, create, --version …). */
  anywhere?: RegExp;
  markers: string[];
  /** What it looks for, for the message ("package.json"). */
  name: string;
  /** Look above the working folder too (git finds a repository in any parent). */
  upward?: boolean;
}

const RULES: ProjectRule[] = [
  { match: /^(npm|yarn|pnpm|bun)(\s|$)/, anywhere: /^(npm|yarn|pnpm|bun)\s+(init|create|exec|dlx|x|view|info|search|login|whoami|config|cache|-v|--version|-g|--global|help|-h|--help)\b|\s(-g|--global)\b|^(npm|yarn|pnpm|bun)\s*$/, markers: ["package.json"], name: "package.json" },
  { match: /^git(\s|$)/, anywhere: /^git\s+(init|clone|config|--version|version|help|-h|--help|ls-remote)\b|^git\s*$/, markers: [".git"], name: ".git", upward: true },
  { match: /^(pytest|py\.test|tox|nox|poetry|python3?\s+-m\s+(pytest|unittest|tox))(\s|$)/, anywhere: /^poetry\s+(new|init|--version)\b/, markers: ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "noxfile.py", "requirements.txt"], name: "pyproject.toml or setup.py" },
  { match: /^cargo(\s|$)/, anywhere: /^cargo\s+(new|init|install|search|--version|-V|help)\b|^cargo\s*$/, markers: ["Cargo.toml"], name: "Cargo.toml" },
  { match: /^go\s+(test|build|run|vet|generate|mod\s+(tidy|download|vendor|verify))\b/, markers: ["go.mod"], name: "go.mod" },
  { match: /^(make|gmake)(\s|$)/, markers: ["Makefile", "makefile", "GNUmakefile"], name: "Makefile" },
  { match: /^mvn(\s|$)/, anywhere: /^mvn\s+(-v|--version|archetype:generate)\b/, markers: ["pom.xml"], name: "pom.xml" },
  { match: /^(gradle|\.\/gradlew)(\s|$)/, anywhere: /^gradle\s+(init|--version|-v)\b/, markers: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], name: "build.gradle" },
];

function hasMarker(dir: string, markers: string[], stopAt: string | null): boolean {
  let d = dir;
  for (;;) {
    if (markers.some((m) => existsSync(join(d, m)))) return true;
    if (stopAt !== null && resolve(d) === resolve(stopAt)) return false;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

/**
 * A command segment with its program written plainly: PowerShell's call operator (`& npm`), a
 * quoted program, a Windows extension (npm.cmd, git.exe) and the case of the name don't matter.
 */
function programName(seg: string): string {
  const s = seg.replace(/^&\s+/, "");
  const m = /^("([^"]+)"|'([^']+)'|(\S+))(.*)$/s.exec(s);
  if (!m) return s;
  const prog = (m[2] ?? m[3] ?? m[4]).replace(/\.(cmd|exe|bat|ps1)$/i, "");
  // A path to the program (C:\nodejs\npm.cmd, /usr/bin/git) is the program; ./gradlew stays as it is.
  const base = /^\.[\\/]/.test(prog) ? prog.replace(/\\/g, "/") : (prog.split(/[\\/]/).pop() ?? prog);
  return `${/^\.\//.test(base) ? base : base.toLowerCase()}${m[5]}`;
}

/**
 * Whether a shell command that needs a code project (npm, git, pytest, cargo, go, make …) is run
 * in a folder that has one. Null when it's fine (or not such a command); else the tool result to
 * give instead of running it: "This folder isn't a code project (no package.json). Your working folder is …".
 * Looks in the folder the command runs in and its parents up to the work folder (git: any parent);
 * follows a leading `cd dir &&`.
 */
export function projectCheck(command: string, root: string): string | null {
  let cwd = resolve(root);
  for (const raw of command.split(/&&|\|\||;|\|/)) {
    const seg = programName(raw.trim().replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, ""));
    if (!seg) continue;
    const cd = /^(?:cd|chdir|set-location)(?:\s+\/d)?\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(seg);
    if (cd) {
      const to = cd[2] ?? cd[3] ?? cd[4];
      if (to.startsWith("~") || to.startsWith("$")) return null; // can't tell where that is
      cwd = isAbsolute(to) ? resolve(to) : resolve(cwd, to);
      continue;
    }
    const rule = RULES.find((r) => r.match.test(seg));
    if (!rule || rule.anywhere?.test(seg)) continue;
    const inside = !relative(resolve(root), cwd).startsWith("..");
    if (!existsSync(cwd)) continue; // the shell will say so
    if (hasMarker(cwd, rule.markers, rule.upward || !inside ? null : root)) continue;
    const here = resolve(cwd) === resolve(root) ? "This folder" : `This folder (${cwd})`;
    return (
      `${here} isn't a code project (no ${rule.name}). Your working folder is ${resolve(root)}. ` +
      `\`${clip(oneLine(seg), 80)}\` needs a project here, so it wasn't run. Don't create ${rule.name} or other project files here to make it work: ` +
      `if the code lives somewhere else, ask the user for the repository path (they can set it as the bot's Repository in its settings).`
    );
  }
  return null;
}
