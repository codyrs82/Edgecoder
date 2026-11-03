// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** New projects started from chat live in ~/EdgeCoder Projects/<name>, a fresh git repository. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitExecEnv, hardenedGitArgs } from "./git-safe.js";

export function projectsHome(): string {
  return process.env.EDGECODER_PROJECTS_DIR || join(homedir(), "EdgeCoder Projects");
}

/** A folder name from the user's words: lowercase, dashes, a few words. */
export function projectSlug(text: string): string {
  const stop = new Set(["a", "an", "the", "me", "us", "lets", "let's", "please", "build", "create", "make", "new", "write", "code", "generate", "for", "my", "i", "want", "to", "can", "you", "start", "with", "that", "of", "and", "in", "using", "simple", "some"]);
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !stop.has(w));
  return words.slice(0, 4).join("-").slice(0, 40).replace(/-+$/, "") || "project";
}

/** Create the folder (unique name), `git init` it, return its absolute path. */
export function createNewProject(name: string): string {
  const home = projectsHome();
  mkdirSync(home, { recursive: true });
  const base = projectSlug(name);
  let dir = join(home, base);
  for (let n = 2; existsSync(dir); n++) dir = join(home, `${base}-${n}`);
  mkdirSync(dir);
  try {
    execFileSync("git", hardenedGitArgs(["init", "-q", "-b", "main"]), { env: gitExecEnv(), cwd: dir, stdio: "ignore", timeout: 10_000 });
  } catch {
    // git missing: still a usable folder
  }
  return dir;
}
