// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Per-folder trust: whether the IDE may run tooling that comes with a project (its
 * node_modules/.bin/tsc, cargo build scripts) by itself, e.g. diagnostics when a file is opened.
 * Folders are untrusted until the user trusts them. The list lives outside every project, in
 * ~/.edgecoder/trusted-projects.json (0600), so a project can't mark itself trusted.
 *
 * The phone (code-remote.ts) may start sessions only in trusted folders, and sees each one as an
 * opaque projectId (projectIdOf, salted per machine) with its folder names, never a full path.
 * A folder the user works in from the desktop app's Code view (a chat there) is open to the phone
 * too: it is kept in the same file's `code` list, which reaches the phone only and never turns on
 * the folder's own tooling. Untrusting a folder takes it off both lists.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

interface TrustStore {
  trusted: string[];
  /** Folders used in the desktop app's Code view: open to the phone, not trusted for tooling. */
  code: string[];
}

function readStore(): TrustStore {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []);
  try {
    const parsed = JSON.parse(readFileSync(trustFile(), "utf8")) as { trusted?: unknown; code?: unknown };
    return { trusted: strings(parsed?.trusted), code: strings(parsed?.code) };
  } catch {
    return { trusted: [], code: [] };
  }
}

function writeStore(store: TrustStore): void {
  const file = trustFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(store.code.length ? store : { trusted: store.trusted }, null, 2), { mode: 0o600 });
}

function readTrusted(): string[] {
  return readStore().trusted;
}

/** True only for a folder the user explicitly trusted (exact folder, not its parents or children). */
export function isProjectTrusted(root: string): boolean {
  return readTrusted().includes(canonical(root));
}

/** Record the user's decision for `root`. */
export function setProjectTrusted(root: string, trusted: boolean): void {
  const key = canonical(root);
  const store = readStore();
  const list = store.trusted.filter((p) => p !== key);
  if (trusted) list.push(key);
  // "Don't trust" is the user's explicit answer: the folder leaves the phone's list too.
  writeStore({ trusted: list, code: trusted ? store.code : store.code.filter((p) => p !== key) });
}

/**
 * The user works in `root` from the desktop app's Code view: the phone may see it (and its Code
 * chats) and start sessions there. Never trusts the folder's own tooling (isProjectTrusted).
 */
export function markCodeProject(root: string): void {
  const key = canonical(root);
  const store = readStore();
  if (store.trusted.includes(key) || store.code.includes(key)) return;
  writeStore({ trusted: store.trusted, code: [...store.code, key] });
}

/** True for a folder the phone may reach: trusted, or used in the desktop app's Code view. */
export function isProjectOpenToPhone(root: string): boolean {
  const key = canonical(root);
  const store = readStore();
  return store.trusted.includes(key) || store.code.includes(key);
}

// --- Trusted projects for the phone (code-remote.ts) ---

/** A trusted project as the phone sees it: an opaque id and folder names, never a full path. */
export interface TrustedProject {
  projectId: string;
  /** The folder's name. */
  name: string;
  /** Its parent folder's name (tells two "app" folders apart). */
  parent: string;
  branch?: string;
}

/** Every folder open to the phone that still exists as a directory (full paths: for this computer only). */
export function trustedProjectRoots(): string[] {
  const store = readStore();
  return [...new Set([...store.trusted, ...store.code])].filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** sha256(machineSalt + canonical path), first 16 hex: stable on this computer, meaningless elsewhere. */
export function projectIdOf(path: string, machineSalt: string): string {
  return createHash("sha256").update(machineSalt + canonical(path)).digest("hex").slice(0, 16);
}

/** The trusted projects with ids for `machineSalt` and, given `branchOf`, each folder's current branch. */
export function listTrustedProjects(machineSalt: string, branchOf?: (root: string) => string | null): TrustedProject[] {
  return trustedProjectRoots().map((root) => {
    let branch: string | null = null;
    try {
      branch = branchOf?.(root) ?? null;
    } catch {
      branch = null;
    }
    return { projectId: projectIdOf(root, machineSalt), name: basename(root), parent: basename(dirname(root)), ...(branch ? { branch } : {}) };
  });
}

/** The trusted folder whose id is `projectId` right now (recomputed over the current list), or null. */
export function trustedRootForId(projectId: string, machineSalt: string): string | null {
  return trustedProjectRoots().find((root) => projectIdOf(root, machineSalt) === projectId) ?? null;
}

function saltFile(): string {
  return process.env.EDGECODER_MACHINE_SALT_FILE ?? join(homedir(), ".edgecoder", "machine-salt");
}

/**
 * This computer's random salt for project ids: ~/.edgecoder/machine-salt (0600), made once, the
 * way ~/.edgecoder/ide-token is (ide-auth.ts).
 */
export function loadOrCreateMachineSalt(file = saltFile()): string {
  const readExisting = (): string => {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on non-POSIX */
    }
    return readFileSync(file, "utf8").trim();
  };
  if (existsSync(file)) {
    const existing = readExisting();
    if (existing) return existing;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const salt = randomBytes(32).toString("base64url");
  try {
    // "wx": fail if another process created it first; then use theirs.
    writeFileSync(file, `${salt}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readExisting();
      if (existing) return existing;
    }
    throw error;
  }
  return salt;
}
