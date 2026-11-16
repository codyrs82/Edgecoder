// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from "node:fs";

let cached: string | undefined;

/** The agent's version from the package it runs from (src/common or dist/common -> package.json), read once. */
export function appVersion(): string {
  if (cached !== undefined) return cached;
  try {
    cached = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
