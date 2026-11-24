// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * `--context-window auto` / `--parallel auto`: also drop that setting's remote (portal) override.
 *
 * A portal change is kept in the agent's own model-overrides.json (src/model/remote-control/overrides.ts)
 * and applies while its recorded env baseline equals the env file's value. One applied while the
 * value was already automatic (baseline "") would survive the installer clearing the env value, so
 * the installer (root) removes just that entry from each instance's file before the agents restart.
 * Other entries (a portal-chosen model, keep-alive) stay. A missing file is nothing to do; a file
 * that is not the expected JSON is left alone (the agent already ignores it). The file keeps its
 * owner and mode: rewritten in place through a temp file given the original's owner and mode.
 */

import { chmodSync, chownSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { OVERRIDES_FILE_NAME } from "../model/remote-control/overrides.js";
import { agentHome, type ServicePaths } from "./services.js";

export type ClearableOverride = "contextWindow" | "parallel";

/** The agent's model-overrides.json for an instance (its HOME's config dir), or undefined where the installer does not manage it. */
export function instanceOverridesPath(platform: NodeJS.Platform, p: ServicePaths, index: number): string | undefined {
  const home = agentHome(p, { index });
  if (platform === "linux") return `${home}/.config/edgecoder/${OVERRIDES_FILE_NAME}`;
  if (platform === "darwin") return `${home}/Library/Application Support/EdgeCoder/${OVERRIDES_FILE_NAME}`;
  return undefined;
}

export type ClearResult = "missing" | "unchanged" | "cleared" | "unreadable";

/** Removes `keys` from the overrides file at `path`, keeping everything else, its owner and its mode. */
export function clearOverrideEntries(path: string, keys: readonly ClearableOverride[]): ClearResult {
  let raw: string;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
    raw = readFileSync(path, "utf8");
  } catch {
    return "missing";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
  const obj = parsed as Record<string, unknown>;
  const present = keys.filter((k) => Object.prototype.hasOwnProperty.call(obj, k));
  if (present.length === 0) return "unchanged";
  for (const k of present) delete obj[k];
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
    try {
      chownSync(tmp, Number(st.uid), Number(st.gid));
    } catch {
      /* not root (tests): the file is ours already */
    }
    chmodSync(tmp, Number(st.mode) & 0o777);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created */
    }
    throw e;
  }
  return "cleared";
}
