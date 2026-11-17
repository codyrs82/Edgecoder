import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";

async function chatPage(): Promise<string> {
  const app = Fastify();
  registerPortalPages(app);
  const res = await app.inject({ url: "/portal/chat" });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.body;
}

// The web chat never shows a raw "Load failed" or an endless "Thinking...".
describe("web chat failures", () => {
  it("ships the shared failure wording, Buy cSats, Retry and the client timeouts", async () => {
    const html = await chatPage();
    expect(html).toContain("function failureKind(");
    expect(html).toContain("Couldn't run: out of cSats");
    expect(html).toContain('var BUY_CSATS_URL = "/portal/settings/plan"');
    expect(html).toContain("function showChatFailure(");
    expect(html).toContain('retry.textContent = "Retry"');
    expect(html).toContain("var CHAT_IDLE_TIMEOUT_MS = 45000");
    expect(html).toContain("var CHAT_FIRST_REPLY_TIMEOUT_MS = 180000");
    expect(html).toContain("chatBody.resend = true");
    for (const m of html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow();
  });

  it("turns browser network errors and server codes into words", async () => {
    const html = await chatPage();
    const src = /function chatErrorText\(message\) \{[\s\S]*?\n    \}/.exec(html)![0];
    const chatErrorText = new Function(`${src}; return chatErrorText;`)() as (m: string) => string;
    expect(chatErrorText("Load failed")).toBe("The connection to EdgeCoder dropped before the reply arrived.");
    expect(chatErrorText("Failed to fetch")).toBe("The connection to EdgeCoder dropped before the reply arrived.");
    expect(chatErrorText("all_coordinators_failed")).toMatch(/didn't answer/);
    expect(chatErrorText("stream_interrupted")).toBe("The reply was cut off.");
  });
});
