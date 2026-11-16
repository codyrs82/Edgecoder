// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";

/*
 * #15: one validated config object per service, read once at startup.
 * Each service defines a zod schema over process.env (all of them are listed in src/config/index.ts)
 * and calls loadConfig(). Invalid or missing values throw a single error that lists every problem,
 * so startup fails with a clear message instead of a NaN or an undefined deep in a handler.
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

/**
 * Variables whose value must never reach a log line. Matched by name so a variable no schema
 * declares is covered too. Durations and limits that only mention a token (..._TOKEN_TTL_MS) are not secrets.
 */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PEPPER|MACAROON|PRIVATE_KEY|API_KEY|_PIN$|_DSN$|DATABASE_URL$|KEY_HEX$|KEY_PEM$|DATA_KEY$/;
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name) && !/_(MS|SATS|BPS)$/.test(name);
}

// Shorter values are left alone: redacting "1" or "true" would garble every message that contains them.
const REDACT_MIN_LENGTH = 6;

/** Replace every secret value present in `env` wherever it appears in `text`. */
export function redactSecrets(text: string, env: Record<string, string | undefined>): string {
  const secrets = Object.entries(env)
    .filter(([k, v]) => typeof v === "string" && v.length >= REDACT_MIN_LENGTH && isSecretEnvName(k))
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Validate `env` against a service schema and return the typed, frozen result. Variables the
 * schema does not declare are ignored. Error messages name the variable and the rule; secret
 * values are never included.
 */
export function loadConfig<S extends z.ZodType>(service: string, schema: S, env: NodeJS.ProcessEnv = process.env): Readonly<z.infer<S>> {
  const input = normalizeEnv(env);
  const parsed = schema.safeParse(input);
  if (parsed.success) return deepFreeze(parsed.data);
  const problems = parsed.error.issues.map((i) => {
    const name = i.path.join(".") || "(root)";
    return redactSecrets(`${name}: ${i.message}`, input);
  });
  throw new ConfigError(service, problems);
}

/** Startup helper: load, or print the problems and exit(1). */
export function loadConfigOrExit<S extends z.ZodType>(service: string, schema: S, env: NodeJS.ProcessEnv = process.env): Readonly<z.infer<S>> {
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

// A long value is more likely a pasted credential than a mistyped number, so it is not echoed.
const shown = (v: string) => (v.length <= 24 ? `"${v}"` : `a ${v.length}-character value`);

function numeric<D extends number | undefined>(kind: "an integer" | "a number", def: D, opts: { min?: number; max?: number }) {
  return z
    .string()
    .optional()
    .transform((v, ctx): number | D => {
      if (v === undefined) return def;
      const n = Number(v);
      if (kind === "an integer" ? !Number.isInteger(n) : !Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: `must be ${kind}, got ${shown(v)}` });
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
}

/** Integer in [min, max], defaulting when unset (pass `undefined` for "no default"). */
export const envInt = <D extends number | undefined>(def: D, opts: { min?: number; max?: number } = {}) => numeric("an integer", def, opts);

/** Finite number (decimals allowed) in [min, max], defaulting when unset (pass `undefined` for "no default"). */
export const envNumber = <D extends number | undefined>(def: D, opts: { min?: number; max?: number } = {}) => numeric("a number", def, opts);

/** TCP port. 0 is accepted because the readers treat it as "use the default" (or "off"). */
export const envPort = <D extends number | undefined>(def: D) => numeric("an integer", def, { min: 0, max: 65535 });

const FLAG_WORDS = ["1", "0", "true", "false", "yes", "no", "on", "off"];

const flagWord = (v: string | undefined, ctx: z.RefinementCtx): boolean => {
  if (v === undefined || FLAG_WORDS.includes(v.toLowerCase())) return true;
  ctx.addIssue({ code: "custom", message: `must be one of ${FLAG_WORDS.join(", ")}` });
  return false;
};

/**
 * A flag whose reader honours only some spellings (`=== "1"`, `!== "false"`, ...). Those readers
 * predate #15 and their exact meaning is kept: `on` lists the spellings that enable a default-off
 * flag, `off` the ones that disable a default-on flag, and every other boolean word leaves the
 * default. Anything that is not a boolean word at all ("maybe", "enabled") fails validation.
 * `ci` compares case-insensitively, for readers that lower-cased the value.
 */
export const envFlag = (rule: { on: readonly string[]; ci?: boolean } | { off: readonly string[]; ci?: boolean }) =>
  z
    .string()
    .optional()
    .transform((v, ctx): boolean => {
      if (!flagWord(v, ctx)) return z.NEVER;
      const word = rule.ci ? v?.toLowerCase() : v;
      if ("on" in rule) return word !== undefined && rule.on.includes(word);
      return word === undefined || !rule.off.includes(word);
    });

/** A boolean word, returned as written, for a flag that a library helper still interprets itself. */
export const envFlagWord = () =>
  z
    .string()
    .optional()
    .transform((v, ctx) => (flagWord(v, ctx) ? v : z.NEVER));

/** One of a fixed set of words; the message lists them. */
export const envEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, { message: `must be one of ${values.join(", ")}` });

/** Like envEnum, but compared case-insensitively and returned as written, for readers that lower-case the value themselves. */
export const envEnumCi = (values: readonly string[]) =>
  z
    .string()
    .optional()
    .refine((v) => v === undefined || values.includes(v.toLowerCase()), { message: `must be one of ${values.join(", ")}` });

/** A JSON document, returned as written (the reader parses it and checks its shape). */
export const envJson = () =>
  z
    .string()
    .optional()
    .refine(
      (v) => {
        if (v === undefined) return true;
        try {
          JSON.parse(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: "must be valid JSON" }
    );

const httpUrl = () => z.url({ protocol: /^https?$/, message: "must be an http(s) URL" });

/** http(s) URL; with a default the output is always a string, without one it may be undefined. */
export function envUrl(): z.ZodOptional<z.ZodURL>;
export function envUrl(def: string): z.ZodDefault<z.ZodURL>;
export function envUrl(def?: string) {
  return def === undefined ? httpUrl().optional() : httpUrl().default(def);
}
