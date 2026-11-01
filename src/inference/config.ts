// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envBool, envInt, envUrl } from "../common/config.js";

/** Minimum INFERENCE_AUTH_TOKEN length in production (#127 review: a placeholder like "changeme" must fail). */
export const INFERENCE_PROD_MIN_TOKEN_LENGTH = 32;

/** `{ "<peerId>": "<public key PEM>" }`, both non-empty strings. */
const trustedKeysJson = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return {} as Record<string, string>;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
    const r = z.record(z.string().min(1), z.string().min(1)).safeParse(parsed);
    if (!r.success) {
      ctx.addIssue({ code: "custom", message: "must be a JSON object of non-empty peerId -> non-empty public key PEM" });
      return z.NEVER;
    }
    return r.data;
  });

/** #15: inference service (port 4302) configuration. Documented in site-docs/reference/environment-variables.md. */
export const inferenceConfigSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    INFERENCE_AUTH_TOKEN: z.string({ message: "is required" }),
    INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: envBool(false),
    INFERENCE_MAX_SIGNATURE_SKEW_MS: envInt(120_000, { min: 1_000, max: 3_600_000 }),
    INFERENCE_NONCE_TTL_MS: envInt(300_000, { min: 1_000, max: 86_400_000 }),
    INFERENCE_COORDINATOR_PEER_ID: z.string().optional(),
    INFERENCE_COORDINATOR_PUBLIC_KEY_PEM: z.string().optional(),
    INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: trustedKeysJson,
    OLLAMA_HOST: envUrl("http://127.0.0.1:11434"),
    OLLAMA_MODEL: z.string().default("qwen3.5:9b"),
    OLLAMA_COORDINATOR_MODEL: z.string().optional()
  })
  // Note (zod 4): this cross-field check runs only once every field-level check passes, so the
  // "all problems at once" message can omit these until the field errors are fixed.
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production" && c.INFERENCE_AUTH_TOKEN.length < INFERENCE_PROD_MIN_TOKEN_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["INFERENCE_AUTH_TOKEN"],
        message: `must be at least ${INFERENCE_PROD_MIN_TOKEN_LENGTH} characters in production`
      });
    }
    // #127 review: the single-key form needs both halves; one without the other is ignored at runtime.
    if (Boolean(c.INFERENCE_COORDINATOR_PEER_ID) !== Boolean(c.INFERENCE_COORDINATOR_PUBLIC_KEY_PEM)) {
      ctx.addIssue({
        code: "custom",
        path: [c.INFERENCE_COORDINATOR_PEER_ID ? "INFERENCE_COORDINATOR_PUBLIC_KEY_PEM" : "INFERENCE_COORDINATOR_PEER_ID"],
        message: "INFERENCE_COORDINATOR_PEER_ID and INFERENCE_COORDINATOR_PUBLIC_KEY_PEM must be set together"
      });
    }
    if (c.INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS && trustedCoordinatorKeys(c).size === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS"],
        message:
          "needs at least one trusted key: INFERENCE_COORDINATOR_PEER_ID + INFERENCE_COORDINATOR_PUBLIC_KEY_PEM, or a non-empty INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON"
      });
    }
  });

export type InferenceConfig = z.infer<typeof inferenceConfigSchema>;

/** Every trusted coordinator key from the validated config (single pair + JSON map). */
export function trustedCoordinatorKeys(c: {
  INFERENCE_COORDINATOR_PEER_ID?: string;
  INFERENCE_COORDINATOR_PUBLIC_KEY_PEM?: string;
  INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: Record<string, string>;
}): Map<string, string> {
  const out = new Map<string, string>(Object.entries(c.INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON));
  if (c.INFERENCE_COORDINATOR_PEER_ID && c.INFERENCE_COORDINATOR_PUBLIC_KEY_PEM) {
    out.set(c.INFERENCE_COORDINATOR_PEER_ID, c.INFERENCE_COORDINATOR_PUBLIC_KEY_PEM);
  }
  return out;
}
