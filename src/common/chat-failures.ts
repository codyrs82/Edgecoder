// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What kind a chat failure is and the compact line a reply shows for it: the same wording as the
 * desktop app (desktop/src/lib/failures.ts, #405). The desktop app does not import from src/, so
 * the two are kept equal and tests/common/chat-failures.test.ts checks they agree. The web chat
 * (src/portal/pages/chat.ts) ships failureKind to the browser via Function.prototype.toString
 * (CHAT_FAILURES_BROWSER_LIB), so it is a self-contained function declaration.
 */

export type FailureKind = "csats" | "budget" | "class" | "offline" | "model" | "other";

/** The kind of a failure message (src/inference-api/auto-route.ts words them). */
export function failureKind(error: string | undefined): FailureKind {
  const e = (error ?? "").trim();
  if (/budget is spent|no cSats left today/i.test(e)) return "budget";
  if (/not enough cSats|no cSats|insufficient|balance 0|costs more than the .* cSats ceiling/i.test(e)) return "csats";
  if (/^No .+ machines? online|machine runs .* right now|no network .* machine has a model|no agent with a model is online/i.test(e)) return "class";
  if (/isn't connected|not connected|offline|isn't running|unreachable/i.test(e)) return "offline";
  if (/isn't installed|no model is installed|no model is available|no model fits|no model on the network fits|no machine on the network can run/i.test(e)) return "model";
  return "other";
}

/** The compact conversation line. */
export const FAILURE_LINE: Record<FailureKind, string> = {
  csats: "Couldn't run: out of cSats",
  budget: "Couldn't run: today's budget is spent",
  class: "Couldn't run: no machines of that class online",
  offline: "Couldn't run: offline",
  model: "Couldn't run: no model available",
  other: "Couldn't run",
};

/** Where "Buy cSats" goes on the web (Settings > Wallet). */
export const BUY_CSATS_URL = "/portal/settings/plan";

/** failureKind, FAILURE_LINE and BUY_CSATS_URL as browser JS. */
export const CHAT_FAILURES_BROWSER_LIB = [
  "var __name = function (f) { return f; };",
  `var FAILURE_LINE = ${JSON.stringify(FAILURE_LINE)};`,
  `var BUY_CSATS_URL = ${JSON.stringify(BUY_CSATS_URL)};`,
  failureKind.toString(),
].join("\n");
