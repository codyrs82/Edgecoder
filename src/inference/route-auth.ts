// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { safeTokenEqual } from "../common/crypto-utils.js";

/**
 * #119 review: which inference-service routes skip the token check.
 * - "public": health, metrics (JSON and Prometheus, #14), the dashboard, and the read-only model GETs the desktop polls.
 * - "token": model mutations (POST /model/pull starts multi-GB downloads; POST /model/swap
 *   switches the model). These need x-inference-token but not a coordinator signature, since
 *   the desktop app calls them directly.
 * - "full": everything else (token, plus coordinator signatures when configured).
 */
export type InferenceRouteAuth = "public" | "token" | "full";

/**
 * The x-inference-token check: constant-time, and never satisfied when the configured token is
 * empty (an unset/empty INFERENCE_AUTH_TOKEN must not let an empty header through).
 */
export function inferenceTokenValid(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || expected.length === 0) return false;
  return safeTokenEqual(provided, expected);
}

const PUBLIC_MODEL_GETS = new Set(["/model/status", "/model/list", "/model/pull/progress"]);

export function inferenceRouteAuth(method: string, url: string): InferenceRouteAuth {
  const path = url.split("?")[0];
  if (path === "/health" || path === "/metrics" || path === "/metrics/prometheus" || path === "/dashboard" || path.startsWith("/dashboard/")) return "public";
  if (path.startsWith("/model")) {
    if (method.toUpperCase() === "GET" && PUBLIC_MODEL_GETS.has(path)) return "public";
    return "token";
  }
  return "full";
}
