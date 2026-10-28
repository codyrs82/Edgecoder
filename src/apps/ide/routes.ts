// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * #36: the HTTP contract between the IDE provider server and its clients
 * (VS Code extension, desktop). tests/ide/extension-contract.test.ts checks
 * that every path the extension calls is listed here and served.
 */
export const IDE_ROUTES = [
  { method: "GET", path: "/health", auth: false },
  { method: "GET", path: "/status", auth: true },
  { method: "POST", path: "/run", auth: true },
  { method: "POST", path: "/run/local", auth: true },
  { method: "POST", path: "/run/swarm", auth: true },
  { method: "GET", path: "/models", auth: true },
  { method: "GET", path: "/v1/models", auth: true },
  { method: "POST", path: "/v1/chat/completions", auth: true },
  { method: "GET", path: "/v1/router/status", auth: true },
  { method: "GET", path: "/model/pull/progress", auth: true },
  { method: "GET", path: "/v1/ide/project", auth: true },
  { method: "POST", path: "/v1/ide/project", auth: true },
  { method: "POST", path: "/v1/ide/tool-approval", auth: true },
  { method: "POST", path: "/v1/ide/chat", auth: true }
] as const;

export type IdeRoute = (typeof IDE_ROUTES)[number];
