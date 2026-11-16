import { describe, expect, it } from "vitest";
import { filterTasks, mergeTaskHistory, tasksCsv, type TaskFilter } from "../src/lib/task-history";
import type { Conversation } from "../src/lib/types";
import type { ActivityItem, UsageRecord } from "../src/lib/api";
import type { BotRun } from "../src/lib/bots";

const SERVED = { label: "m-1", own: false, computeClass: "gpu", tier: "24gb", hardware: "GPU (24 GB)", region: "us-east", country: "US", promptTokens: 1200, outputTokens: 300 };

const chat: Conversation = {
  id: "c1", title: "Login bug", createdAt: 0, updatedAt: 0, source: "chat",
  messages: [
    { id: "u1", role: "user", content: "Why does login fail?\nmore", timestamp: 1_000 },
    { id: "a1", role: "assistant", content: "Because…", timestamp: 4_000, usage: { cSats: 0.42, where: "Network GPU · qwen3:32b" }, toolEvents: [{ type: "tool_call", tool: "read_file", args: { path: "src/login.ts" } }, { type: "tool_result", id: "x", error: "ENOENT" }] },
    { id: "u2", role: "user", content: "Try again", timestamp: 10_000 },
    { id: "a2", role: "assistant", content: "Error: No machine has qwen3:32b", timestamp: 11_000 },
    { id: "u3", role: "user", content: "Stop that", timestamp: 20_000 },
    { id: "a3", role: "assistant", content: "Partial\n\n_(stopped)_", timestamp: 21_000 },
  ],
};
const code: Conversation = { id: "c2", title: "site", createdAt: 0, updatedAt: 0, source: "editor", messages: [{ id: "u", role: "user", content: "Add a footer", timestamp: 30_000 }, { id: "a", role: "assistant", content: "Done", timestamp: 35_000 }] };
const run: BotRun = { id: "r1", trigger: "schedule", startedAtMs: 40_000, endedAtMs: 100_000, status: "budget", summary: "Tidied the README", cSats: 12, where: "This computer · qwen3.5:9b", pullRequests: [{ url: "https://github.com/a/b/pull/3" }] };
const recent: ActivityItem[] = [
  { id: "x1", kind: "api", title: "Summarize", source: "OpenAI API", model: "llama3.2:3b", startedAtMs: 50_000, endedAtMs: 52_000, status: "done", cSats: 0, steps: [], calls: [{ cSats: 0.1, model: "network/qwen3:32b", served: SERVED }] },
  // A chat turn the server also saw: listed once, from the conversation.
  { id: "x2", kind: "chat", title: "Why does login fail?", startedAtMs: 1_000, status: "done", cSats: 0, steps: [], calls: [] },
];
const usage: UsageRecord[] = [
  { id: "u-chat", atMs: 1_500, kind: "inference", placement: "network", model: "qwen3:32b", source: "EdgeCoder chat", ok: true, durationMs: 3000, costMsat: 420 },
  { id: "u-cursor", atMs: 60_000, kind: "inference", placement: "network", model: "qwen3:32b", computeClass: "gpu", source: "Cursor", ok: false, durationMs: 900, costMsat: 0, promptTokens: 10, outputTokens: 0 },
];

const ALL: TaskFilter = { kind: "all", status: "all", sinceMs: 0, query: "" };

describe("task history: merging sources", () => {
  const rows = mergeTaskHistory({
    conversations: [chat, code],
    bots: [{ bot: { id: "b1", name: "Harry" }, runs: [run] }],
    sessions: [{
      id: "s1", title: "auth refactor", model: "auto",
      transcript: [
        { id: "e1", role: "user", content: "Split auth", at: 70_000 },
        { id: "e2", role: "note", content: "compacted", at: 70_500 },
        { id: "e3", role: "assistant", content: "ok", at: 80_000, usage: { cSats: 2, calls: [{ cSats: 2, model: "network/qwen3:32b", served: SERVED }] }, events: [{ type: "tool_call", id: "t", tool: "edit_file", args: { path: "src/auth.ts" } }] },
      ],
      tentacles: [{ id: "t1", task: "Write auth tests", kind: "tests", readOnly: false, status: "failed", progress: "", createdAt: 75_000, startedAt: 75_500, finishedAt: 78_500, cSats: 0.3, result: { model: "qwen3:8b", class: "apple", summary: "Tests fail", filesTouched: ["a.test.ts"], patch: "", error: "vitest exited 1", attempts: 2 } }],
    }],
    recent,
    usage,
  });

  it("every kind, newest first, nothing twice, the app's own usage left to its own store", () => {
    expect(rows.map((r) => `${r.kind}:${r.title}`)).toEqual([
      "tentacle:Write auth tests",
      "code:Split auth",
      "api:qwen3:32b",
      "api:Summarize",
      "bot:Tidied the README",
      "code:Add a footer",
      "chat:Stop that",
      "chat:Try again",
      "chat:Why does login fail?",
    ]);
  });

  it("each row: where it ran, tokens, cost, status with the reason, duration, steps", () => {
    const by = (t: string) => rows.find((r) => r.title === t)!;
    expect(by("Why does login fail?")).toMatchObject({ context: "Login bug", where: "Network GPU · qwen3:32b", cSats: 0.42, status: "done", durationMs: 3000, steps: ["read_file src/login.ts", "  error: ENOENT"] });
    expect(by("Try again")).toMatchObject({ status: "failed", error: "No machine has qwen3:32b" });
    expect(by("Stop that").status).toBe("cancelled");
    expect(by("Split auth")).toMatchObject({ kind: "code", promptTokens: 1200, outputTokens: 300, cSats: 2, durationMs: 10_000, steps: ["edit_file src/auth.ts"] });
    expect(by("Split auth").where).toContain("us-east");
    expect(by("Write auth tests")).toMatchObject({ status: "failed", error: "vitest exited 1", durationMs: 3000, model: "qwen3:8b" });
    expect(by("Tidied the README")).toMatchObject({ status: "failed", error: "Stopped at the bot's daily budget", context: "Harry", durationMs: 60_000 });
    expect(by("Tidied the README").steps).toContain("opened https://github.com/a/b/pull/3");
    expect(by("qwen3:32b")).toMatchObject({ context: "Cursor", status: "failed", cSats: 0, promptTokens: 10 });
  });

  it("filters by kind, status, time and search", () => {
    expect(filterTasks(rows, { ...ALL, kind: "chat" })).toHaveLength(3);
    expect(filterTasks(rows, { ...ALL, status: "failed" }).map((r) => r.kind).sort()).toEqual(["api", "bot", "chat", "tentacle"]);
    expect(filterTasks(rows, { ...ALL, sinceMs: 60_000 })).toHaveLength(3);
    expect(filterTasks(rows, { ...ALL, query: "cursor" })).toHaveLength(1);
    expect(filterTasks(rows, { ...ALL, query: "VITEST" })).toHaveLength(1);
  });

  it("exports CSV with a header and quoted fields", () => {
    const csv = tasksCsv(rows.filter((r) => r.title === "Why does login fail?"));
    const [head, line] = csv.trim().split("\n");
    expect(head).toBe("time,kind,what,context,where,model,prompt_tokens,output_tokens,csats,status,error,seconds");
    expect(line).toBe("1970-01-01T00:00:01.000Z,chat,Why does login fail?,Login bug,Network GPU · qwen3:32b,,,,0.420,done,,3.0");
    expect(tasksCsv([{ ...rows[0], title: 'say "hi", ok' }])).toContain('"say ""hi"", ok"');
  });

  it("no sources: no rows", () => {
    expect(mergeTaskHistory({})).toEqual([]);
  });
});
