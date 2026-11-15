// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Per-folder trust: whether the IDE may run tooling that comes with a project (its
 * node_modules/.bin/tsc, cargo build scripts) by itself, e.g. diagnostics when a file is opened.
 * Folders are untrusted until the user trusts them. The list lives outside every project, in
 * ~/.edgecoder/trusted-projects.json (0600), so a project can't mark itself trusted.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function trustFile(): string {
  return process.env.EDGECODER_TRUST_FILE ?? join(homedir(), ".edgecoder", "trusted-projects.json");
}

/** The folder's real path, so a symlink or `..` spelling can't alias a trusted folder. */
function canonical(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    return resolve(root);
  }
}

function readTrusted(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(trustFile(), "utf8")) as { trusted?: unknown };
    return Array.isArray(parsed?.trusted) ? parsed.trusted.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** True only for a folder the user explicitly trusted (exact folder, not its parents or children). */
export function isProjectTrusted(root: string): boolean {
  return readTrusted().includes(canonical(root));
}

/** Record the user's decision for `root`. */
export function setProjectTrusted(root: string, trusted: boolean): void {
  const key = canonical(root);
  const list = readTrusted().filter((p) => p !== key);
  if (trusted) list.push(key);
  const file = trustFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ trusted: list }, null, 2), { mode: 0o600 });
}
