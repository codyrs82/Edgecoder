// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { Language } from "../common/types.js";

const FENCE_PATTERN = /```(?:python|javascript|js|py|typescript|ts)?\s*\n([\s\S]*?)```/;

export function extractCode(raw: string, _language: Language): string {
  const fenceMatch = raw.match(FENCE_PATTERN);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  return raw.trim();
}
