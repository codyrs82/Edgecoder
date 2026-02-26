// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export const log = {
  info(message: string, meta?: unknown): void {
    console.log(JSON.stringify({ level: "info", message, meta, ts: Date.now() }));
  },
  warn(message: string, meta?: unknown): void {
    console.warn(JSON.stringify({ level: "warn", message, meta, ts: Date.now() }));
  },
  error(message: string, meta?: unknown): void {
    console.error(JSON.stringify({ level: "error", message, meta, ts: Date.now() }));
  }
};
