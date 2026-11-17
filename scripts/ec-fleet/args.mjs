// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * ec-fleet command-line parsing (pure: no I/O), and the task preamble every fleet session gets.
 */

import { parseArgs } from "node:util";

export const DEFAULT_LEAD = "frontier/anthropic/claude-opus-5-5";
export const DEFAULT_WORKER = "auto";
export const DEFAULT_MODE = "auto-edits";
export const DEFAULT_PROVIDER = "http://127.0.0.1:4304";
export const DEFAULT_MAX_CONCURRENT = 2;
export const MODES = ["ask", "auto-edits", "auto"];
export const COMMANDS = ["start", "watch", "approve", "send", "status", "stop", "help"];

export const USAGE = `ec-fleet: drive EdgeCoder coding sessions (one worktree + branch + draft PR each) from a supervising session.

  ec-fleet start --task <file.md|text> --branch ec/<slug> [--repo <path>] [--lead <id>] [--worker <id>]
                 [--mode ask|auto-edits|auto] [--title <t>] [--base origin/main] [--node-modules <dir>]
                 [--trailer "<line>"]... [--max-concurrent 2] [--dry-run]
  ec-fleet watch <slug> [--approve] [--since N] [--timeout <minutes>] [--verbose]
  ec-fleet approve <slug> [--all-safe] [--call <id> [--deny]]
  ec-fleet send <slug> "<notes>"
  ec-fleet status [<slug>] [--json]
  ec-fleet stop <slug> [--cleanup]

Defaults: --lead ${DEFAULT_LEAD} (your own key, this account only), --worker ${DEFAULT_WORKER}, --mode ${DEFAULT_MODE}.
Provider: $EC_FLEET_PROVIDER or ${DEFAULT_PROVIDER}; token: $IDE_PROVIDER_TOKEN or ~/.edgecoder/ide-token (never printed).
watch exits 0 when the session is idle, 3 when an approval needs a human, 4 on timeout.
`;

export class UsageError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;

/** "ec/fix-fee" or "fix-fee" -> { slug, branch }. */
export function slugAndBranch(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new UsageError("Give a branch (--branch ec/<slug>) or a slug.");
  const slug = raw.startsWith("ec/") ? raw.slice(3) : raw;
  if (!SLUG.test(slug)) throw new UsageError(`"${slug}" isn't a valid slug: lowercase letters, digits and dashes, at most 50.`);
  return { slug, branch: `ec/${slug}` };
}

function int(name, v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be an integer from ${min} to ${max}.`);
  return n;
}

/** Parse argv (without node and the script) into { command, ...options }. Throws UsageError. */
export function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return { command: "help" };
  if (!COMMANDS.includes(command)) throw new UsageError(`Unknown command "${command}". Commands: ${COMMANDS.join(", ")}.`);
  const specs = {
    start: { task: { type: "string" }, repo: { type: "string" }, branch: { type: "string" }, lead: { type: "string" }, worker: { type: "string" }, mode: { type: "string" }, title: { type: "string" }, base: { type: "string" }, "node-modules": { type: "string" }, trailer: { type: "string", multiple: true }, "max-concurrent": { type: "string" }, "dry-run": { type: "boolean" } },
    watch: { approve: { type: "boolean" }, since: { type: "string" }, timeout: { type: "string" }, verbose: { type: "boolean" }, repo: { type: "string" } },
    approve: { "all-safe": { type: "boolean" }, call: { type: "string" }, deny: { type: "boolean" }, repo: { type: "string" } },
    send: { repo: { type: "string" } },
    status: { json: { type: "boolean" }, repo: { type: "string" } },
    stop: { cleanup: { type: "boolean" }, repo: { type: "string" } },
  }[command];
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...specs, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values: v, positionals: pos } = parsed;
  if (v.help) return { command: "help" };
  const out = { command, repo: v.repo };

  if (command === "start") {
    if (pos.length) throw new UsageError(`start takes no positional arguments (got ${pos.join(" ")}); put the task in --task.`);
    if (!v.task) throw new UsageError("start needs --task <file.md|text>.");
    Object.assign(out, slugAndBranch(v.branch));
    if (!String(v.branch).startsWith("ec/")) throw new UsageError("--branch must be ec/<slug>.");
    const mode = v.mode ?? DEFAULT_MODE;
    if (!MODES.includes(mode)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}.`);
    const worker = v.worker ?? DEFAULT_WORKER;
    if (worker.toLowerCase().startsWith("frontier/")) throw new UsageError("--worker can't be a frontier model (helpers run on auto, the network or this computer).");
    Object.assign(out, {
      task: v.task,
      lead: v.lead ?? DEFAULT_LEAD,
      worker,
      mode,
      title: (v.title ?? `ec-fleet: ${out.slug}`).slice(0, 120),
      base: v.base ?? "origin/main",
      nodeModules: v["node-modules"],
      trailers: v.trailer ?? [],
      maxConcurrent: v["max-concurrent"] === undefined ? DEFAULT_MAX_CONCURRENT : int("max-concurrent", v["max-concurrent"], 1, 8),
      dryRun: v["dry-run"] ?? false,
    });
    return out;
  }
  if (command === "status") {
    if (pos.length > 1) throw new UsageError("status takes at most one slug.");
    if (pos[0]) out.slug = slugAndBranch(pos[0]).slug;
    out.json = v.json ?? false;
    return out;
  }
  if (!pos[0]) throw new UsageError(`${command} needs a slug.`);
  Object.assign(out, slugAndBranch(pos[0]));
  if (command === "send") {
    const text = pos.slice(1).join(" ").trim();
    if (!text) throw new UsageError('send needs the notes: ec-fleet send <slug> "<notes>".');
    out.text = text;
    return out;
  }
  if (pos.length > 1) throw new UsageError(`${command} takes one slug (got ${pos.join(" ")}).`);
  if (command === "watch") {
    out.approve = v.approve ?? false;
    out.since = v.since === undefined ? undefined : int("since", v.since, 0, Number.MAX_SAFE_INTEGER);
    out.timeoutMin = v.timeout === undefined ? 60 : int("timeout", v.timeout, 1, 24 * 60);
    out.verbose = v.verbose ?? false;
  } else if (command === "approve") {
    out.allSafe = v["all-safe"] ?? false;
    out.call = v.call;
    out.deny = v.deny ?? false;
    if (out.deny && !out.call) throw new UsageError("--deny needs --call <id>.");
    if (out.call && out.allSafe) throw new UsageError("Use --call or --all-safe, not both.");
  } else if (command === "stop") {
    out.cleanup = v.cleanup ?? false;
  }
  return out;
}

/** The standard preamble: repo rules wrapped around the task. */
export function buildPrompt({ task, branch, worktree, trailers }) {
  const lines = trailers.length ? trailers : ["Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"];
  return `You are an EdgeCoder coding session in a fleet supervised by a Claude Code session. Work on the task at the end, then stop with a short summary.

Where you are
- Project: ${worktree} (a git worktree of github.com/codyrs82/Edgecoder, a public repository).
- Branch: ${branch}, already checked out, based on origin/main. Work only on this branch.

Rules
- Never push to main or any branch other than ${branch}; never force-push. Never merge a PR.
- Don't edit protected paths: .github/workflows/**, deploy/**, Dockerfiles, fly*.toml, **/migrations/**, lockfiles (package-lock.json, Cargo.lock, ...), .env*, .claude/settings.json, .claude/harness.json, .claude/hooks/**. If the task seems to need one, stop and say so.
- No new dependencies; no npm install / npm ci.
- Tests: only targeted ones, e.g. \`nice -n 10 npx vitest run tests/<area>/<file>.test.ts --maxWorkers=2\`. Never the whole suite (this computer is shared and fragile). Type-check with \`npx tsc --noEmit -p tsconfig.json\` when you change src/**/*.ts.
- node_modules is a symlink to a shared install: never edit or commit it (don't \`git add -f\`).
- Keep the change small and focused on the task; match the surrounding code style and comments.
- Commit with git_commit. Every commit message ends with exactly these lines (after a blank line):
${lines.map((l) => `    ${l}`).join("\n")}
- When the change is committed and its tests pass: \`git push -u origin ${branch}\`, then open a draft PR:
    gh pr create --draft --base main --head ${branch} --title "<title>" --body "<what changed, why, how it was tested>"
- End with: files changed, tests run and their result, the PR link.

Task
${task.trim()}
`;
}
