// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from "node:crypto";
import { safeTokenEqual } from "../common/crypto-utils.js";
import { readHeaderValue } from "./coordinator-utils.js";

/**
 * A secret only the embedded worker holds. The all-in-one entry (src/index.ts) runs the
 * coordinator and forks its own worker; the worker gets this value in EDGECODER_SELF_AGENT_SECRET
 * and sends it on /register to its local coordinator, which then lets it register without a
 * portal enrollment token, in production too. It is random per process and never stored, so no
 * other program on the machine (or behind a same-host proxy) knows it.
 */
export const SELF_AGENT_SECRET = randomBytes(32).toString("base64url");
export const SELF_AGENT_HEADER = "x-edgecoder-self-agent";

/** True when the request carries this process's self-agent secret. */
export function hasSelfAgentProof(headers: Record<string, unknown> | undefined, secret: string = SELF_AGENT_SECRET): boolean {
  const value = headers ? readHeaderValue(headers, SELF_AGENT_HEADER) : undefined;
  return typeof value === "string" && value.length > 0 && safeTokenEqual(value, secret);
}
