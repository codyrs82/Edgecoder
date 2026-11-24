// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings → General → "Run unchecked commands in a sandbox" (Auto mode; on by default): kept by
 * this computer's IDE server beside permissions.json (~/.edgecoder/sandbox.json), so chats, shared
 * sessions and bots follow the same switch. Off, those commands ask as before.
 *
 *   GET  /v1/ide/sandbox            {enabled, available, kind, why}
 *   POST /v1/ide/sandbox {enabled}  turn it on or off
 */

import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defaultPermissionsFile } from "./permissions.js";
import { sandboxReady, sandboxSupport } from "./sandbox.js";

export function sandboxSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultPermissionsFile(env)), "sandbox.json");
}

let cache: { file: string; mtime: number; enabled: boolean } | null = null;

/** The switch (default on). A damaged or missing file reads as on. */
export function autoSandboxEnabled(file: string = sandboxSettingsFile()): boolean {
  try {
    if (!existsSync(file)) return true;
    const mtime = statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtime === mtime) return cache.enabled;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { autoSandbox?: unknown };
    const enabled = raw?.autoSandbox !== false;
    cache = { file, mtime, enabled };
    return enabled;
  } catch {
    return true;
  }
}

export function setAutoSandbox(enabled: boolean, file: string = sandboxSettingsFile()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ autoSandbox: enabled }, null, 2) + "\n", { mode: 0o600 });
  cache = null;
}

/** For decideToolCall's `sandbox`: the switch is on, this computer has a sandbox, and the project can be sandboxed. */
export function autoSandboxFor(root: string): boolean {
  return autoSandboxEnabled() && sandboxReady(root);
}

export function registerSandboxRoutes(app: FastifyInstance): void {
  const view = () => {
    const s = sandboxSupport();
    return { enabled: autoSandboxEnabled(), available: s.kind !== null, kind: s.kind, why: s.why };
  };
  app.get("/v1/ide/sandbox", async () => view());
  app.post("/v1/ide/sandbox", async (req, reply) => {
    const b = z.object({ enabled: z.boolean() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "enabled must be true or false" });
    setAutoSandbox(b.data.enabled);
    return view();
  });
}
