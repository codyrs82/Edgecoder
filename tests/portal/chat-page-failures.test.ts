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

  it("out of cSats: our words, not the coordinator's sentence, and which account is signed in; never a toast", async () => {
    const html = await chatPage();
    expect(html).not.toContain("Chat error");
    const detailSrc = /function csatsDetail\(message\) \{[\s\S]*?\n    \}/.exec(html)![0];
    const csatsDetail = new Function(`${detailSrc}; return csatsDetail;`)() as (m: string) => string;
    expect(csatsDetail("Not enough cSats for this request (it sets aside up to 4.034 cSats; unused cSats come back).")).toBe("This chat sets aside up to 4.034 cSats; unused cSats come back.");
    expect(csatsDetail("Not enough cSats: your balance is 0")).toBe("");
    const whoSrc = /function signedInLine\(\) \{[\s\S]*?\n    \}/.exec(html)![0];
    const els: Record<string, { textContent: string }> = { accountMenuEmail: { textContent: "me@example.com" }, topTickerCredits: { textContent: "0 cSats" } };
    const signedInLine = new Function("document", `${whoSrc}; return signedInLine;`)({ getElementById: (id: string) => els[id] ?? null }) as () => string;
    expect(signedInLine()).toBe("Signed in as me@example.com \u00B7 0 cSats");
    els.topTickerCredits.textContent = "Balance unavailable";
    expect(signedInLine()).toBe("Signed in as me@example.com");
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
  // 2026-11-17: a full answer, then a red "dropped before the reply arrived" under it.
  it("once answer text arrived, the end of the stream finishes the reply: grey note only if it stops mid-sentence", async () => {
    const html = await chatPage();
    const src = /function looksTruncated\(text\) \{[\s\S]*?\n    \}/.exec(html)![0];
    const looksTruncated = new Function(`${src}; return looksTruncated;`)() as (t: string) => boolean;
    expect(looksTruncated("The video you're referring to is a parody. It ends with a full paragraph.")).toBe(false);
    expect(looksTruncated("Done!\n\n")).toBe(false);
    expect(looksTruncated("Here is the code:\n```js\nconst a = 1;\n```")).toBe(false);
    expect(looksTruncated("Here is the code:\n```js\nconst a = 1;")).toBe(true);
    expect(looksTruncated("The video you're referring to is a parody that")).toBe(true);
    expect(looksTruncated("")).toBe(false);
    // The red failure is only for no answer text at all; after text it is the grey note (or nothing).
    const fail = /function fail\(message, opts\) \{[\s\S]*?\n      \}/.exec(html)![0];
    expect(fail.indexOf("if (fullContent)")).toBeGreaterThan(-1);
    expect(fail.indexOf("if (fullContent)")).toBeLessThan(fail.indexOf("showChatFailure("));
    expect(fail).toContain("showCutShort(assistantBubble, text)");
    expect(html).toContain('label.textContent = "Reply may be cut short"');
    // A stream that closed after text with no terminator is noted only when truncated.
    expect(html).toContain("else if (!failed && !gotDone && looksTruncated(fullContent)) showCutShort(assistantBubble, text);");
  });
});
