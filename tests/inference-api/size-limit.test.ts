import { describe, expect, it } from "vitest";
import type { NetworkDeps } from "../../src/apps/ide/network-inference.js";
import { networkBackend } from "../../src/inference-api/backends.js";
import { ChatBackendError, type ChatRequest } from "../../src/inference-api/types.js";

/*
 * Network run 21: a prompt over 400,000 characters made the coordinator return 500 and the portal
 * answer 503. The coordinator now answers 413 request_too_large (400 invalid_request for another
 * malformed field), and the portal passes the status and the coordinator's message through.
 */

const deps = (status: number, json: Record<string, unknown>): NetworkDeps => ({
  forwarder: "", token: () => "", agentId: "acct-1",
  transport: async (_m, path) => (path === "/inference/submit" ? { status, json } : { status: 200, json: { chunks: [], next: 0, done: true } }),
});
const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };
async function failure(d: NetworkDeps): Promise<ChatBackendError> {
  try {
    for await (const _ of networkBackend(d, { model: "auto", computeClass: "any" })(req)) {
      // nothing
    }
  } catch (err) {
    return err as ChatBackendError;
  }
  throw new Error("no failure");
}

describe("run 21: size limits on the submit path", () => {
  it("a 413 from the coordinator reaches the caller as a 413 with its message (was: 502/503)", async () => {
    const message = "The prompt is too large: message 2 has 400,001 characters, the limit is 400,000 per message. Nothing was charged.";
    const err = await failure(deps(413, { error: "request_too_large", limit: "message_chars", size: 400_001, max: 400_000, message }));
    expect(err).toBeInstanceOf(ChatBackendError);
    expect(err.status).toBe(413);
    expect(err.message).toBe(message);
  });

  it("a 400 invalid_request too", async () => {
    const err = await failure(deps(400, { error: "invalid_request", message: "Invalid request: temperature: too big. Nothing was charged." }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/^Invalid request: temperature/);
  });
});
