// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request as undiciRequest } from "undici";
import type { ActiveCoordinator } from "./active-coordinator.js";
import { AGENT_NONCE_HEADER, newAgentNonce, type ResponseVerifier } from "../trust/response-signing.js";

/*
 * The one path the worker uses to talk to its coordinator (register, heartbeat, pull, results,
 * agent-mesh, inference chunks). Every call goes to the verified URL only, carries a fresh
 * x-agent-nonce, and its response is checked against the coordinator's pinned key before the
 * caller sees a byte of it (src/trust/response-signing.ts). A refused response is never returned:
 * the failure is counted, the coordinator's verification is dropped (the loop challenges it again)
 * and CoordinatorResponseRejectedError is thrown.
 */

export class CoordinatorResponseRejectedError extends Error {
  constructor(readonly reason: string, readonly method: string, readonly path: string) {
    super(`coordinator_response_rejected: ${method} ${path}: ${reason}`);
  }
}

/** Response shape compatible with undici's for callers that read statusCode / headers / body. */
export interface VerifiedResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  /** Whether the coordinator signed it (false only for an accepted older coordinator). */
  signed: boolean;
  bodyText: string;
  body: { text(): Promise<string>; json(): Promise<unknown>; dump(): Promise<void> };
}

export type RequestFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; headersTimeout?: number; bodyTimeout?: number }
) => Promise<{ statusCode: number; headers: Record<string, unknown>; trailers?: Record<string, unknown>; body: { arrayBuffer(): Promise<ArrayBuffer> } }>;

export interface CoordinatorClientOptions {
  coordinator: ActiveCoordinator;
  verifier: ResponseVerifier;
  agentId: string;
  request?: RequestFn;
  warn?: (message: string) => void;
  /** Called after a refused response (the coordinator has already been invalidated). */
  onRejected?: (err: CoordinatorResponseRejectedError) => void;
}

export interface CoordinatorCall {
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export function createCoordinatorClient(opts: CoordinatorClientOptions) {
  const doRequest: RequestFn = opts.request ?? (undiciRequest as unknown as RequestFn);
  const warned = new Set<string>();

  async function call(c: CoordinatorCall): Promise<VerifiedResponse> {
    // Never send agent credentials to a coordinator that has not proven its key.
    const { url, identity } = opts.coordinator.requireVerifiedIdentity();
    const nonce = newAgentNonce();
    const headers: Record<string, string> = { ...(c.headers ?? {}), [AGENT_NONCE_HEADER]: nonce };
    const res = await doRequest(`${url}${c.path}`, {
      method: c.method,
      headers,
      ...(c.body !== undefined ? { body: c.body } : {}),
      ...(c.timeoutMs ? { headersTimeout: c.timeoutMs, bodyTimeout: c.timeoutMs } : {})
    });
    // The whole body (and, for a streamed response, its trailers) before anything is used.
    const bytes = Buffer.from(await res.body.arrayBuffer());
    const decision = opts.verifier.check(
      { method: c.method, path: c.path, status: res.statusCode, body: bytes, headers: res.headers, trailers: res.trailers },
      { nonce, agentId: headers["x-agent-id"] ?? "" },
      identity
    );
    if (!decision.accept) {
      const err = new CoordinatorResponseRejectedError(decision.error, c.method, c.path);
      opts.coordinator.invalidate();
      opts.onRejected?.(err);
      throw err;
    }
    if (!decision.signed && !warned.has(identity.peerId)) {
      warned.add(identity.peerId);
      opts.warn?.(decision.warning);
    }
    const text = bytes.toString("utf8");
    return {
      statusCode: res.statusCode,
      headers: res.headers,
      signed: decision.signed,
      bodyText: text,
      body: { text: async () => text, json: async () => JSON.parse(text), dump: async () => {} }
    };
  }

  return { call };
}

export type CoordinatorClient = ReturnType<typeof createCoordinatorClient>;
