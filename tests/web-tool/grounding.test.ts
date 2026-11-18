import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type ChatFn, type ChatMessage } from "../../src/apps/ide/agent-loop.js";
import { DisclaimerFilter, WebToolSession, groundingSearch, isNoAccessDisclaimer, isWebTool, needsFreshInfo, utcDateLine, webGrounding, webSystemNote, webToolSchemas, type WebToolCall } from "../../src/web-tool/tools.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";

describe("needsFreshInfo (the grounding classifier)", () => {
  const fresh = [
    "What are today's zero day threats?",
    "Search the internet",
    "search the web for the best vector databases",
    "can you look it up?",
    "google the release date of GTA 6",
    "What's the latest version of Node.js?",
    "latest news on the Fed",
    "Who won the game last night?",
    "What's the weather in Denver this weekend?",
    "what's the price of bitcoin right now",
    "What happened at the 2026 World Cup?",
    "Summarise https://example.com/blog/post",
    "What is the current stable release of Python?",
    "Any recent CVEs for OpenSSL?",
    "What's new in Rust?",
    "Is the new iPhone out yet? when was it released",
  ];
  const notFresh = [
    "How do I reverse a linked list in Python?",
    "Write a function that returns the current date in JavaScript",
    "Why does my build fail now? ```\nerror TS2307: Cannot find module 'x'\n```",
    "How do I get the current directory in Node?",
    "Refactor this class so the latest value wins",
    "Explain binary search",
    "What's the difference between let and const?",
    "Fix the bug in `fetchLatest()` where it returns the old version",
    "Bump the package version in package.json",
    "Explain how TCP handshakes work",
    "write a haiku about autumn",
    "",
  ];
  for (const m of fresh) it(`fresh: ${JSON.stringify(m)}`, () => expect(needsFreshInfo(m)).toBe(true));
  for (const m of notFresh) it(`not fresh: ${JSON.stringify(m)}`, () => expect(needsFreshInfo(m)).toBe(false));

  it("ignores URLs and cues inside code", () => {
    expect(needsFreshInfo("Why does this 404?\n```js\nfetch('https://api.example.com/today/news')\n```")).toBe(false);
  });
});

describe("groundingSearch", () => {
  it("queries with the trimmed user message", () => {
    expect(groundingSearch([{ role: "user", content: "  What are today's\n zero day threats?  " }])).toEqual({ tool: "web_search", args: { query: "What are today's zero day threats?", count: 5 } });
  });

  it("a bare 'search the internet' searches for the previous question", () => {
    const messages = [
      { role: "user", content: "What are today's zero day threats?" },
      { role: "assistant", content: "As an AI I can't…" },
      { role: "user", content: "Search the internet" },
    ];
    expect(groundingSearch(messages)?.args.query).toBe("What are today's zero day threats?");
  });

  it("caps the query at 200 characters and is null for a coding question", () => {
    expect(groundingSearch([{ role: "user", content: `latest news ${"x".repeat(400)}` }])!.args.query.length).toBeLessThanOrEqual(200);
    expect(groundingSearch([{ role: "user", content: "How do I reverse a linked list in Python?" }])).toBeNull();
  });

  it("is off in Manual (web calls ask first)", () => {
    const web = { usage: () => ({ searches: 0, pages: 0, cSats: 0, sources: [] }) };
    expect(webGrounding(web, [{ role: "user", content: "latest news" }], { skip: true }).prefetch).toBeUndefined();
    expect(webGrounding(web, [{ role: "user", content: "latest news" }]).prefetch).toHaveLength(1);
  });
});

describe("webSystemNote", () => {
  it("says it has live web access, gives today's date (UTC), and never to claim no access", () => {
    const note = webSystemNote(new Date("2026-11-17T23:30:00Z"));
    expect(note).toContain("You have live web access through web_search and read_page. Today's date is 2026-11-17 (Tuesday, UTC).");
    expect(note).toMatch(/call web_search FIRST, then answer from the results with \[n\] citations/);
    expect(note).toMatch(/Never say you lack internet/);
    expect(utcDateLine(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01 (Thursday, UTC)");
    expect(webSystemNote()).toContain(new Date().toISOString().slice(0, 10));
  });
});

describe("DisclaimerFilter (post-check)", () => {
  const disclaimers = [
    "As an AI assistant, I don't have access to real-time data or current threat intelligence feeds, but here is what I know.",
    "I don't have the ability to browse the internet.",
    "I cannot access the internet or real-time information.",
    "I'm unable to browse the web.",
    "As a language model, I don't have real-time access.",
    "My knowledge cutoff is 2024, so I may not know recent events.",
  ];
  for (const d of disclaimers) it(`recognises ${JSON.stringify(d.slice(0, 40))}`, () => expect(isNoAccessDisclaimer(d)).toBe(true));
  it("leaves ordinary sentences alone", () => {
    for (const s of ["I don't see a CVE for that in the results.", "The current release is 22.4 [1].", "I can't find that in the sources [2]."]) expect(isNoAccessDisclaimer(s)).toBe(false);
  });

  it("strips the disclaimer sentence from a streamed answer once results were provided", () => {
    const f = new DisclaimerFilter(() => true);
    const chunks = ["As an AI assistant, I don't have access to real-", "time data. Here are today's", " zero-days [1]:\n- CVE-2026-1 [2]\n", "Patch soon."];
    const out = chunks.map((c) => f.push(c)).join("") + f.end();
    expect(out).toBe("Here are today's zero-days [1]:\n- CVE-2026-1 [2]\nPatch soon.");
  });

  it("passes text straight through when no web results were provided", () => {
    const f = new DisclaimerFilter(() => false);
    expect(f.push("I don't have real-time access. ")).toBe("I don't have real-time access. ");
    expect(f.end()).toBe("");
  });
});

/** A coordinator double: search answers two results; billing is counted per call. */
function coordinator(opts: { status?: number } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const call: WebToolCall = vi.fn(async (path, body) => {
    calls.push({ path, body });
    if (opts.status && opts.status !== 200) return { status: opts.status, json: { error: "needs_csats", message: "Web search needs cSats" } };
    return { status: 200, json: { cSats: 0.5, results: [{ title: "CISA KEV", url: "https://cisa.example/kev", snippet: "Known exploited" }, { title: "Vendor advisory", url: "https://vendor.example/a", snippet: "Patch" }] } };
  });
  return { call, calls };
}

/** Runs a web chat like the portal's runWebChat (web tools only), with a scripted model. */
async function webChat(userText: string, replies: ChatResult[], opts: { status?: number; limits?: { searches: number; reads: number }; history?: ChatMessage[] } = {}) {
  const c = coordinator(opts);
  const events: IdeStreamEvent[] = [];
  const sendEvent = (e: IdeStreamEvent) => events.push(e);
  const web = new WebToolSession({ call: c.call, emit: sendEvent, ...(opts.limits ? { limits: opts.limits } : {}) });
  const seen: ChatMessage[][] = [];
  let i = 0;
  const chat: ChatFn = async (req, onDelta) => {
    seen.push(req.messages.map((m) => ({ ...m })));
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r.content) onDelta?.(r.content);
    return r;
  };
  const messages = [...(opts.history ?? []), { role: "user", content: userText }];
  await runAgentLoop({
    chat,
    systemPrompt: () => webSystemNote(),
    messages,
    ...webGrounding(web, messages),
    sendEvent,
    isCancelled: () => false,
    tools: webToolSchemas(),
    runTool: async (tool, args) => {
      if (!isWebTool(tool)) return "[Error]: not available";
      const r = await web.run(tool, args);
      return r.result ?? `[Error]: ${r.error}`;
    },
  });
  const text = events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content).join("");
  return { c, events, seen, text, usage: web.usage() };
}
type ChatResult = Awaited<ReturnType<ChatFn>>;

describe("grounding in the agent loop", () => {
  it("a time-sensitive question: one server search before the first turn, injected as the model's own tool call, with sources", async () => {
    const r = await webChat("What are today's zero day threats?", [{ content: "As an AI assistant, I don't have access to real-time data. Today's top threat is CVE-2026-1 [1].", toolCalls: [] }]);
    // One search, billed through the same call, before the model ran.
    expect(r.c.calls.map((x) => x.path)).toEqual(["/v1/tools/web/search"]);
    expect(r.c.calls[0].body).toMatchObject({ query: "What are today's zero day threats?", count: 5 });
    const first = r.seen[0];
    expect(first[0]).toMatchObject({ role: "system" });
    expect(first[0].content).toContain("Today's date is");
    expect(first.at(-2)).toMatchObject({ role: "assistant", content: "", tool_calls: [{ function: { name: "web_search", arguments: { query: "What are today's zero day threats?", count: 5 } } }] });
    expect(first.at(-1)).toMatchObject({ role: "tool", tool_name: "web_search" });
    expect(first.at(-1)!.content).toContain("[1] CISA KEV");
    // "Searching the web…" and the sources go out as for a model's search.
    expect(r.events).toContainEqual({ type: "status", message: "Searching the web…" });
    expect(r.events.find((e) => e.type === "web")).toMatchObject({ searches: 1, cSats: 0.5, sources: [{ n: 1, url: "https://cisa.example/kev" }, { n: 2, url: "https://vendor.example/a" }] });
    // The post-check dropped the false disclaimer.
    expect(r.text).toBe("Today's top threat is CVE-2026-1 [1].");
    expect(r.usage).toMatchObject({ searches: 1, cSats: 0.5 });
  });

  it("a coding question isn't searched (no cost)", async () => {
    const r = await webChat("How do I reverse a linked list in Python?", [{ content: "Use a loop.", toolCalls: [] }]);
    expect(r.c.calls).toEqual([]);
    expect(r.seen[0].some((m) => m.role === "tool")).toBe(false);
    expect(r.text).toBe("Use a loop.");
  });

  it("the grounding search counts toward the per-reply limit: with 1 search per reply the model's own search is refused for free", async () => {
    const r = await webChat("latest news on OpenSSL", [{ content: "", toolCalls: [{ name: "web_search", arguments: { query: "openssl advisory" } }] }, { content: "OpenSSL 3.6 shipped [1].", toolCalls: [] }], { limits: { searches: 1, reads: 4 } });
    expect(r.c.calls).toHaveLength(1);
    expect(r.seen[1].at(-1)!.content).toMatch(/used its 1 web search/);
    expect(r.usage.searches).toBe(1);
  });

  it("no cSats (402): nothing is charged or injected as results, and the web is off for the rest of the reply", async () => {
    const r = await webChat("latest news on OpenSSL", [{ content: "", toolCalls: [{ name: "web_search", arguments: { query: "again" } }] }, { content: "I couldn't search.", toolCalls: [] }], { status: 402 });
    expect(r.c.calls).toHaveLength(1);
    expect(r.usage).toMatchObject({ searches: 0, cSats: 0, sources: [] });
    expect(r.seen[0].at(-1)!.content).toMatch(/^\[Error\]: Web search needs cSats/);
    expect(r.seen[1].at(-1)!.content).toMatch(/off for the rest of this reply/);
  });

  it("a bare follow-up 'Search the internet' searches the earlier question", async () => {
    const r = await webChat("Search the internet", [{ content: "Here's what I found [1].", toolCalls: [] }], {
      history: [
        { role: "user", content: "What are today's zero day threats?" },
        { role: "assistant", content: "I can't." },
      ],
    });
    expect(r.c.calls[0].body.query).toBe("What are today's zero day threats?");
  });
});

describe("grounding with a model that can't take tool definitions", () => {
  it("the injected search is rewritten in the text format when the loop falls back to text mode", async () => {
    const { ToolsUnsupportedError } = await import("../../src/apps/ide/agent-loop.js");
    const c = coordinator();
    const web = new WebToolSession({ call: c.call, emit: () => {} });
    const seen: ChatMessage[][] = [];
    let first = true;
    const chat: ChatFn = async (req) => {
      if (first) {
        first = false;
        throw new ToolsUnsupportedError("does not support tools");
      }
      seen.push(req.messages.map((m) => ({ ...m })));
      return { content: "Top threat [1].", toolCalls: [] };
    };
    const messages = [{ role: "user", content: "latest news on zero-days" }];
    await runAgentLoop({ chat, systemPrompt: () => webSystemNote(), messages, ...webGrounding(web, messages), sendEvent: () => {}, isCancelled: () => false, tools: webToolSchemas(), runTool: async (tool, args) => (await web.run(tool as "web_search", args)).result ?? "" });
    const m = seen[0];
    expect(m.some((x) => x.role === "tool" || x.tool_calls)).toBe(false);
    expect(m.at(-2)!.content).toMatch(/^```tool_call\n\{"tool":"web_search"/);
    expect(m.at(-1)).toMatchObject({ role: "user" });
    expect(m.at(-1)!.content).toMatch(/^\[Tool web_search result\]: <<<untrusted_web_content/);
  });
});
