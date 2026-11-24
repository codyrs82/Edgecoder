// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What a tentacle (tentacles.ts) may run and apply without anyone approving: the shell allowlist,
 * the session's mode as the shared classifier (permissions.ts) sees it, and the acceptance check
 * as a command. A helper can't ask, so it never goes past the session's mode.
 */

import type { SessionData } from "./sessions.js";
import { isReadOnlyCommand, riskOf, type PermissionMode } from "./permissions.js";
import { decideToolCall } from "./permission-policy.js";
import { evaluateShellCommand, parseArgv, protectedToolPath } from "./tool-executor.js";
import { acceptanceCommand, type Acceptance } from "./tentacle-workspace.js";

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
export function modeOf(s: Pick<SessionData, "mode" | "autoApprove">): PermissionMode {
  return s.mode ?? (s.autoApprove === "edits" ? "auto-edits" : "ask");
}

/**
 * A helper's patch applies on its own exactly when the lead's own edit to those files would: the
 * session's mode lets edits apply (auto-edits, auto, full) and no file is a protected path. Otherwise it
 * waits for the user's approval.
 */
export function canAutoApply(s: Pick<SessionData, "mode" | "autoApprove">, files: string[]): boolean {
  const m = modeOf(s);
  return (m === "auto-edits" || m === "auto" || m === "full") && files.every((f) => protectedToolPath(f) === null);
}

/**
 * Whether the session runs `command` without asking (SessionHub.allowedWithoutAsking without a
 * hub): read-only in any mode; otherwise never a risky one, and only in mode auto or for a
 * command name answered "always" for the session.
 */
export function sessionAllowsShell(s: Pick<SessionData, "mode" | "autoApprove" | "alwaysShell">, command: string, root: string): boolean {
  if (isReadOnlyCommand(command, root)) return true;
  // A helper can't ask: anything risky never runs, whatever the mode or rules say.
  if (riskOf(command, root) !== null) return false;
  const always = s.alwaysShell ?? [];
  return decideToolCall("run_shell", { command }, { mode: modeOf(s), root, rules: always, legacyNames: always }, (c) => riskOf(c, root)).action === "run";
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
