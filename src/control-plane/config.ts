// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envBool, envUrl } from "../common/config.js";

/** Minimum ADMIN_API_TOKEN length when NODE_ENV=production (same floor as INFERENCE_AUTH_TOKEN). */
export const ADMIN_PROD_MIN_TOKEN_LENGTH = 32;

/**
 * #15: control-plane (port 4303) configuration, validated once at startup.
 * ADMIN_API_TOKEN is required in every environment (unchanged). ALLOWED_ADMIN_IPS and
 * ALLOWED_UI_IPS are still read per request so they can change at runtime. Documented in
 * site-docs/reference/environment-variables.md.
 */
export const controlPlaneConfigSchema = z.object({
  NODE_ENV: z.string().default("development"),
  COORDINATOR_URL: envUrl("http://127.0.0.1:4301"),
  ADMIN_API_TOKEN: z.string({ message: "is required" }),
  COORDINATOR_MESH_TOKEN: z.string().optional(),
  MESH_AUTH_TOKEN: z.string().optional(),
  PORTAL_SERVICE_URL: envUrl(),
  PORTAL_SERVICE_TOKEN: z.string().optional(),
  /** Absolute URL or a site path such as "/". */
  UI_RETIRE_REDIRECT_URL: z
    .string()
    .refine((v) => v.startsWith("/") || /^https?:\/\//i.test(v), { message: "must be an http(s) URL or a path starting with /" })
    .optional(),
  LOCAL_MODEL_PROVIDER: z
    .enum(["edgecoder-local", "ollama-local"], { message: "must be edgecoder-local or ollama-local" })
    .default("edgecoder-local"),
  OLLAMA_AUTO_INSTALL: envBool(false),
  OLLAMA_MODEL: z.string().default("qwen3.5:9b"),
  OLLAMA_HOST: envUrl()
}).superRefine((c, ctx) => {
  if (c.NODE_ENV === "production" && c.ADMIN_API_TOKEN.length < ADMIN_PROD_MIN_TOKEN_LENGTH) {
    ctx.addIssue({
      code: "custom",
      path: ["ADMIN_API_TOKEN"],
      message: `must be at least ${ADMIN_PROD_MIN_TOKEN_LENGTH} characters in production`
    });
  }
});

export type ControlPlaneConfig = z.infer<typeof controlPlaneConfigSchema>;
