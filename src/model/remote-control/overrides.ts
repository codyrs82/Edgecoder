// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Model settings the owner changed remotely, kept where the agent can write without root.
 *
 * Headless installs keep their configuration in /etc/edgecoder/agent-N.env (root's) and run the
 * agent as the unprivileged `edgecoder` user, so the agent cannot rewrite it. Remote changes go to
 * `<config dir>/model-overrides.json` instead (on a Linux install
 * /var/lib/edgecoder/agent-N/.config/edgecoder/model-overrides.json, the agent's own systemd
 * StateDirectory), mode 0600, written atomically. At startup the file is layered over the env:
 *
 *   effective = env file value, unless the override file has a valid value for that key whose
 *               recorded env baseline still equals the env file's current value.
 *
 * Each override records the env value it replaced (`baseline`). When the operator (or the desktop
 * app, which owns its own config) later changes that setting locally, the env no longer matches the
 * baseline and the local value wins: local changes always beat remote ones, and the portal then
 * shows the local value. Values out of bounds, a malformed file or an unknown key are ignored (and
 * logged), never fatal: the env file alone is always a working configuration.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { isOllamaLibraryModelName } from "../ollama-installer.js";
import { settingsProblem } from "./policy.js";

export const OVERRIDES_FILE_NAME = "model-overrides.json";

export type OverrideKey = "model" | "contextWindow" | "parallel" | "keepAlive";
const KEYS: readonly OverrideKey[] = ["model", "contextWindow", "parallel", "keepAlive"];

export interface OverrideEntry<T> {
  value: T;
  /** The env value (as text, "" when unset) this override replaced. */
  baseline: string;
  updatedAtMs: number;
  /** The account that asked (acct-<userId>), for the record. */
  updatedBy: string;
  commandId?: string;
}

export interface ModelOverridesFile {
  version: 1;
  model?: OverrideEntry<string>;
  contextWindow?: OverrideEntry<number>;
  parallel?: OverrideEntry<number>;
  keepAlive?: OverrideEntry<string>;
}

/** The env values the overrides layer over (as the env file has them; undefined = unset). */
export interface EnvModelSettings {
  model?: string;
  contextWindow?: string;
  parallel?: string;
  keepAlive?: string;
}

export function overridesPath(configDir: string): string {
  return join(configDir, OVERRIDES_FILE_NAME);
}

function validValue(key: OverrideKey, value: unknown): boolean {
  if (key === "model") return isOllamaLibraryModelName(value);
  if (key === "contextWindow") return typeof value === "number" && settingsProblem({ contextWindow: value }) === null;
  if (key === "parallel") return typeof value === "number" && settingsProblem({ parallel: value }) === null;
  return typeof value === "string" && settingsProblem({ keepAlive: value }) === null;
}

/** Reads and validates the file; problems are returned, not thrown. A missing file is empty. */
export function loadOverrides(path: string): { overrides: ModelOverridesFile; problems: string[] } {
  const problems: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { overrides: { version: 1 }, problems };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { overrides: { version: 1 }, problems: [`${path}: not JSON, ignored`] };
  }
  const out: ModelOverridesFile = { version: 1 };
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
    return { overrides: out, problems: [`${path}: unknown version, ignored`] };
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === "version") continue;
    if (!(KEYS as readonly string[]).includes(k)) {
      problems.push(`${path}: unknown key ${k} ignored`);
      continue;
    }
    const e = v as Partial<OverrideEntry<unknown>> | null;
    if (!e || typeof e !== "object" || typeof e.baseline !== "string" || !validValue(k as OverrideKey, e.value)) {
      problems.push(`${path}: ${k} out of bounds or malformed, ignored`);
      continue;
    }
    (out as unknown as Record<string, unknown>)[k] = {
      value: e.value,
      baseline: e.baseline,
      updatedAtMs: Number(e.updatedAtMs) || 0,
      updatedBy: typeof e.updatedBy === "string" ? e.updatedBy.slice(0, 160) : "",
      ...(typeof e.commandId === "string" ? { commandId: e.commandId.slice(0, 64) } : {})
    };
  }
  return { overrides: out, problems };
}

/** Atomic write (temp file + rename), readable by the agent's user only. */
export function saveOverrides(path: string, overrides: ModelOverridesFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows: mode bits are advisory */
  }
  renameSync(tmp, path);
}

export interface LayeredSettings {
  /** The env with each live override applied (still text, as the env would hold it). */
  env: EnvModelSettings;
  /** Where each value came from. */
  sources: Record<OverrideKey, "env" | "remote">;
  /** Overrides dropped because the local value changed since (local wins). */
  superseded: OverrideKey[];
}

/** Layers the overrides over the env: an override applies only while its baseline is the env's value. */
export function layerOverrides(env: EnvModelSettings, overrides: ModelOverridesFile): LayeredSettings {
  const out: EnvModelSettings = { ...env };
  const sources: Record<OverrideKey, "env" | "remote"> = { model: "env", contextWindow: "env", parallel: "env", keepAlive: "env" };
  const superseded: OverrideKey[] = [];
  for (const key of KEYS) {
    const o = overrides[key] as OverrideEntry<string | number> | undefined;
    if (!o) continue;
    if (o.baseline !== (env[key] ?? "")) {
      superseded.push(key);
      continue;
    }
    out[key] = String(o.value);
    sources[key] = "remote";
  }
  return { env: out, sources, superseded };
}

/** Records a remote change of one setting against the current env value. */
export function withOverride<K extends OverrideKey>(
  overrides: ModelOverridesFile,
  key: K,
  value: NonNullable<ModelOverridesFile[K]>["value"],
  env: EnvModelSettings,
  meta: { updatedBy: string; commandId?: string; nowMs?: number }
): ModelOverridesFile {
  return {
    ...overrides,
    [key]: { value, baseline: env[key] ?? "", updatedAtMs: meta.nowMs ?? Date.now(), updatedBy: meta.updatedBy, ...(meta.commandId ? { commandId: meta.commandId } : {}) }
  };
}

/** Drops overrides the local config superseded, so the file says what is in force. */
export function withoutKeys(overrides: ModelOverridesFile, keys: OverrideKey[]): ModelOverridesFile {
  const out = { ...overrides };
  for (const k of keys) delete out[k];
  return out;
}
