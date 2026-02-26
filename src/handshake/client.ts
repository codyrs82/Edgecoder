// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import { QueueReasonCode } from "../common/types.js";

export interface CloudReviewPayload {
  task: string;
  snippet?: string;
  error?: string;
  queueReason: QueueReasonCode;
}

const REDACT_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /(?<=password\s*=\s*).+/gi,
  /(?<=api[_-]?key\s*=\s*).+/gi
];

export function sanitizePayload(payload: CloudReviewPayload): CloudReviewPayload {
  const scrub = (text?: string): string | undefined => {
    if (!text) return text;
    return REDACT_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), text);
  };

  return {
    ...payload,
    task: scrub(payload.task) ?? "",
    snippet: scrub(payload.snippet),
    error: scrub(payload.error)
  };
}

export async function queueCloudReview(
  endpoint: string,
  payload: CloudReviewPayload,
  token: string
): Promise<{ reviewId: string }> {
  const safe = sanitizePayload(payload);
  const res = await request(`${endpoint}/review`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(safe)
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Cloud review failed with status ${res.statusCode}`);
  }

  const json = (await res.body.json()) as { reviewId: string };
  return json;
}
