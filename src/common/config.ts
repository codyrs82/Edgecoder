// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";

/*
 * #15: one validated config object per service, read once at startup.
 * Each service defines a zod schema over process.env (see src/inference/config.ts) and calls
 * loadConfig(). Invalid or missing values throw a single error that lists every problem, so
 * startup fails with a clear message instead of a NaN or an undefined deep in a handler.
 */

export class ConfigError extends Error {
  constructor(readonly service: string, readonly problems: string[]) {
    super(`[${service}] invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Empty or whitespace-only env values count as unset, so defaults apply. Values are trimmed,
 * including tokens: callers must send the trimmed token (a copy with stray whitespace gets 401).
 */
function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  return out;
}

export function loadConfig<S extends z.ZodType>(service: string, schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const parsed = schema.safeParse(normalizeEnv(env));
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new ConfigError(service, problems);
}

/** Startup helper: load, or print the problems and exit(1). */
export function loadConfigOrExit<S extends z.ZodType>(service: string, schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  try {
    return loadConfig(service, schema, env);
  } catch (error) {
    console.error(`FATAL ${(error as Error).message}`);
    process.exit(1);
  }
}

// ---- field helpers ----

/** "true" | "false" (also 1/0, yes/no; case-insensitive), defaulting when unset. */
export const envBool = (def: boolean) =>
  z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["true", "false", "1", "0", "yes", "no"], { message: "must be true or false" }).optional()
    )
    .transform((v) => (v === undefined ? def : v === "true" || v === "1" || v === "yes"));

/** Integer in [min, max], defaulting when unset. */
export const envInt = (def: number, opts: { min?: number; max?: number } = {}) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return def;
      const n = Number(v);
      if (!Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: `must be an integer, got "${v}"` });
        return z.NEVER;
      }
      if (opts.min !== undefined && n < opts.min) {
        ctx.addIssue({ code: "custom", message: `must be >= ${opts.min}` });
        return z.NEVER;
      }
      if (opts.max !== undefined && n > opts.max) {
        ctx.addIssue({ code: "custom", message: `must be <= ${opts.max}` });
        return z.NEVER;
      }
      return n;
    });

export const envUrl = (def?: string) => {
  const url = z.url({ protocol: /^https?$/, message: "must be an http(s) URL" });
  return def === undefined ? url.optional() : url.default(def);
};
