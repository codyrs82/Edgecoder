// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envBool, envInt, envUrl } from "../common/config.js";

/** #15: inference service (port 4302) configuration. Documented in site-docs/reference/environment-variables.md. */
export const inferenceConfigSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    INFERENCE_AUTH_TOKEN: z.string({ message: "is required" }),
    INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS: envBool(false),
    INFERENCE_MAX_SIGNATURE_SKEW_MS: envInt(120_000, { min: 1_000, max: 3_600_000 }),
    INFERENCE_NONCE_TTL_MS: envInt(300_000, { min: 1_000, max: 86_400_000 }),
    INFERENCE_COORDINATOR_PEER_ID: z.string().default(""),
    INFERENCE_COORDINATOR_PUBLIC_KEY_PEM: z.string().default(""),
    INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON: z
      .string()
      .default("")
      .refine((v) => {
        if (!v) return true;
        try {
          const parsed = JSON.parse(v);
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
        } catch {
          return false;
        }
      }, "must be a JSON object of peerId -> public key PEM"),
    OLLAMA_HOST: envUrl("http://127.0.0.1:11434"),
    OLLAMA_MODEL: z.string().default("qwen3.5:9b"),
    OLLAMA_COORDINATOR_MODEL: z.string().optional()
  })
  .superRefine((c, ctx) => {
    // Signed coordinator requests need at least one trusted key to check against.
    if (c.INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS && !c.INFERENCE_COORDINATOR_PUBLIC_KEY_PEM && !c.INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON) {
      ctx.addIssue({
        code: "custom",
        path: ["INFERENCE_REQUIRE_SIGNED_COORDINATOR_REQUESTS"],
        message: "needs INFERENCE_COORDINATOR_PUBLIC_KEY_PEM or INFERENCE_TRUSTED_COORDINATOR_KEYS_JSON"
      });
    }
  });

export type InferenceConfig = z.infer<typeof inferenceConfigSchema>;
