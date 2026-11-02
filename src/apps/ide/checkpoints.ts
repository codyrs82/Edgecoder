// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Checkpoints for IDE agent turns: before the agent first writes a file in a turn, its original
 * content (or that it did not exist) is kept, so the user can review what the turn changed and
 * undo it per file or as a whole. In memory only; the last MAX_TURNS turns are kept.
 * Shell commands are not tracked: what they change is not known in advance.
 */

import { existsSync, statSync } from "node:fs";
import { ProjectFs, MAX_EDITOR_FILE_BYTES } from "./project-fs.js";

const MAX_TURNS = 50;

export interface FileChange {
  path: string;
  /** Content before the turn; null when the file did not exist. */
  before: string | null;
  /** Content on disk now; null when it no longer exists. */
  after: string | null;
}

interface Turn {
  root: string;
  createdAtMs: number;
  /** path -> original content (null: did not exist). Files too large or binary are not tracked. */
  originals: Map<string, string | null>;
}

export class CheckpointStore {
  private readonly turns = new Map<string, Turn>();

  begin(turnId: string, projectRoot: string): void {
    this.turns.set(turnId, { root: projectRoot, createdAtMs: Date.now(), originals: new Map() });
    while (this.turns.size > MAX_TURNS) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }

  /**
   * Record a file's current content before the turn writes it (first write per file only).
   * Returns the project-relative path tracked, or null when it can't be (outside the project,
   * too large, binary); the write itself is still the executor's decision.
   */
  capture(turnId: string, relPath: string): string | null {
    const turn = this.turns.get(turnId);
    if (!turn) return null;
    const fs = new ProjectFs(turn.root);
    let abs: string;
    try {
      abs = fs.resolve(relPath);
    } catch {
      return null;
    }
    const rel = fs.relativePath(abs);
    if (turn.originals.has(rel)) return rel;
    if (!existsSync(abs)) {
      turn.originals.set(rel, null);
      return rel;
    }
    try {
      if (statSync(abs).size > MAX_EDITOR_FILE_BYTES) return null;
      turn.originals.set(rel, fs.read(rel).content);
      return rel;
    } catch {
      return null;
    }
  }

  changes(turnId: string): FileChange[] | null {
    const turn = this.turns.get(turnId);
    if (!turn) return null;
    const fs = new ProjectFs(turn.root);
    const out: FileChange[] = [];
    for (const [path, before] of turn.originals) {
      let after: string | null = null;
      try {
        after = fs.read(path).content;
      } catch {
        after = null;
      }
      if (after !== before) out.push({ path, before, after });
    }
    return out;
  }

  /** Put files back as they were before the turn (all tracked files, or just `paths`). */
  revert(turnId: string, paths?: string[]): string[] | null {
    const turn = this.turns.get(turnId);
    if (!turn) return null;
    const fs = new ProjectFs(turn.root);
    const reverted: string[] = [];
    for (const [path, before] of turn.originals) {
      if (paths && !paths.includes(path)) continue;
      if (before === null) {
        try {
          fs.remove(path);
        } catch {
          // already gone
        }
      } else {
        fs.write(path, before);
      }
      reverted.push(path);
    }
    return reverted;
  }
}
