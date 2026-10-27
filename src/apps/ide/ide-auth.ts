// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * #4: IDE provider server access control: loopback bind by default, a bearer
 * token on every route except /health, and rejection of browser (web-origin)
 * and DNS-rebinding (foreign Host) requests.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

export const IDE_PROVIDER_DEFAULT_PORT = 4304;

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Listen options for the IDE provider server. Defaults to 127.0.0.1; a
 * non-loopback bind is refused unless IDE_PROVIDER_TOKEN is explicitly set.
 */
export function resolveListenOptions(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const host = (env.IDE_PROVIDER_HOST ?? "").trim() || "127.0.0.1";
  const port = Number(env.IDE_PROVIDER_PORT ?? IDE_PROVIDER_DEFAULT_PORT) || IDE_PROVIDER_DEFAULT_PORT;
  if (!isLoopbackHost(host) && !(env.IDE_PROVIDER_TOKEN ?? "").trim()) {
    throw new Error(
      `IDE_PROVIDER_HOST=${host} is not loopback; set IDE_PROVIDER_TOKEN explicitly to expose the IDE provider server`
    );
  }
  return { host, port };
}

export function defaultIdeTokenPath(): string {
  return join(homedir(), ".edgecoder", "ide-token");
}

/** Read ~/.edgecoder/ide-token, creating it (0600, 32 random bytes base64url) if missing. */
export function loadOrCreateIdeToken(path = defaultIdeTokenPath()): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on non-POSIX */
  }
  return token;
}

export function resolveIdeToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env.IDE_PROVIDER_TOKEN ?? "").trim() || loadOrCreateIdeToken();
}

export function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Desktop (Tauri) webview origins; a web page cannot claim these. Extend with IDE_ALLOWED_ORIGINS. */
export const DEFAULT_ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env.IDE_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

/**
 * Browser pages send an http(s) Origin; editor extensions (Node http/fetch) send none.
 * Any http(s)/"null" origin not explicitly allowed is treated as a web origin.
 */
export function isWebOrigin(origin: string | undefined, allowed: Set<string> = allowedOrigins()): boolean {
  if (!origin) return false;
  const o = origin.trim().toLowerCase();
  if (allowed.has(o)) return false;
  return o === "null" || o.startsWith("http://") || o.startsWith("https://");
}

export interface IdeAuthOptions {
  token: string;
  port: number;
  /** When bound to loopback, only loopback Host headers are accepted (anti DNS-rebinding). */
  enforceLoopbackHost: boolean;
  publicPaths?: string[];
  allowedOrigins?: Set<string>;
}

export function createIdeAuthHook(opts: IdeAuthOptions) {
  const publicPaths = new Set(opts.publicPaths ?? ["/health"]);
  const origins = opts.allowedOrigins ?? allowedOrigins();
  const allowedHosts = new Set([
    `127.0.0.1:${opts.port}`,
    `localhost:${opts.port}`,
    `[::1]:${opts.port}`,
  ]);
  return async function ideAuthHook(req: FastifyRequest, reply: FastifyReply) {
    const origin = req.headers.origin;
    if (isWebOrigin(typeof origin === "string" ? origin : undefined, origins)) {
      return reply.code(403).send({ error: "forbidden_origin" });
    }
    if (opts.enforceLoopbackHost) {
      const host = String(req.headers.host ?? "").toLowerCase();
      if (!allowedHosts.has(host)) return reply.code(403).send({ error: "forbidden_host" });
    }
    const path = req.url.split("?")[0];
    if (publicPaths.has(path)) return;
    const h = req.headers.authorization ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!tok || !safeTokenEqual(tok, opts.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}
