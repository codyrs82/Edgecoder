import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/svelte";

const NOW = Date.now();
const api = vi.hoisted(() => ({
  isRemoteMode: vi.fn(() => false),
  listBots: vi.fn(),
  botHistory: vi.fn(),
  listAllSessions: vi.fn(),
  getSession: vi.fn(),
  sessionTentacles: vi.fn(),
  getRecentActivity: vi.fn(),
  getUsage: vi.fn(),
}));
vi.mock("../src/lib/api", () => ({ ...api, backendReady: Promise.resolve() }));
const store = vi.hoisted(() => ({ listConversations: vi.fn() }));
vi.mock("../src/lib/chat-store", () => store);

import TaskQueue from "../src/pages/TaskQueue.svelte";

function seed() {
  store.listConversations.mockResolvedValue([
    { id: "c1", title: "Login bug", createdAt: 0, updatedAt: 0, source: "chat", messages: [
      { id: "u1", role: "user", content: "Why does login fail?", timestamp: NOW - 60_000 },
      { id: "a1", role: "assistant", content: "Because", timestamp: NOW - 57_000, usage: { cSats: 0.42, where: "Network GPU · qwen3:32b" }, toolEvents: [{ type: "tool_call", tool: "read_file", args: { path: "src/login.ts" } }] },
    ] },
    { id: "c2", title: "site", createdAt: 0, updatedAt: 0, source: "editor", messages: [
      { id: "u2", role: "user", content: "Add a footer", timestamp: NOW - 30_000 },
      { id: "a2", role: "assistant", content: "Error: No machine has qwen3:32b", timestamp: NOW - 29_000 },
    ] },
  ]);
  api.listBots.mockResolvedValue([{ id: "b1", name: "Harry" }]);
  api.botHistory.mockResolvedValue([{ id: "r1", trigger: "schedule", startedAtMs: NOW - 90_000, endedAtMs: NOW - 80_000, status: "done", summary: "Tidied the README", cSats: 12, where: "This computer · qwen3.5:9b" }]);
  api.listAllSessions.mockResolvedValue([]);
  api.getRecentActivity.mockResolvedValue([{ id: "x", kind: "api", title: "Summarize the changelog", source: "OpenAI API", startedAtMs: NOW - 10_000, endedAtMs: NOW - 8_000, status: "done", cSats: 0, steps: [], calls: [] }]);
  api.getUsage.mockRejectedValue(new Error("not_enrolled"));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.isRemoteMode.mockReturnValue(false);
});
afterEach(() => cleanup());

describe("Tasks", () => {
  it("lists chats, Code turns, bot runs and API calls together, newest first, in a table with headers", async () => {
    seed();
    render(TaskQueue);
    await screen.findByText(/Summarize the changelog/);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "What", "Where it ran", "Tokens in / out", "cSats", "Status", "Time"]);
    const rows = within(table).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
    expect(rows.map((t) => /Summarize|Add a footer|Why does login|Tidied/.exec(t)?.[0])).toEqual(["Summarize", "Add a footer", "Why does login", "Tidied"]);
    expect(rows[1]).toContain("Failed");
    expect(rows[1]).toContain("No machine has qwen3:32b");
    expect(rows[2]).toContain("Network GPU · qwen3:32b");
    expect(rows[2]).toContain("0.42");
    expect(screen.queryByText(/Couldn't read/)).toBeNull();
  });

  it("filters by kind, status and search; a row opens its steps", async () => {
    seed();
    render(TaskQueue);
    await screen.findByText(/Summarize the changelog/);
    await fireEvent.click(screen.getByRole("button", { name: "Bot" }));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    await fireEvent.click(screen.getByRole("button", { name: "All" }));
    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    status.value = "failed";
    await fireEvent.change(status);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    status.value = "all";
    await fireEvent.change(status);
    await fireEvent.input(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "login" } });
    const open = screen.getByRole("button", { name: /Why does login fail/ });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("read_file src/login.ts")).toBeTruthy();
    await fireEvent.input(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches these filters.")).toBeTruthy();
  });

  it("exports the shown rows as CSV", async () => {
    seed();
    const created: Blob[] = [];
    const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn((b: Blob) => { created.push(b); return "blob:x"; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(TaskQueue);
      await screen.findByText(/Summarize the changelog/);
      await fireEvent.click(screen.getByRole("button", { name: /CSV/ }));
      expect(click).toHaveBeenCalled();
      const text = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsText(created[0]);
      });
      expect(text.split("\n")[0]).toBe("time,kind,what,context,where,model,prompt_tokens,output_tokens,csats,status,error,seconds");
      expect(text).toContain("Tidied the README");
    } finally {
      URL.createObjectURL = orig.create;
      URL.revokeObjectURL = orig.revoke;
    }
  });

  it("empty: says what would appear; a store that can't be read is named", async () => {
    store.listConversations.mockResolvedValue([]);
    api.listBots.mockRejectedValue(new Error("down"));
    api.listAllSessions.mockResolvedValue([]);
    api.getRecentActivity.mockResolvedValue([]);
    api.getUsage.mockRejectedValue(new Error("not_enrolled"));
    render(TaskQueue);
    await screen.findByText("No tasks yet.");
    expect(screen.getByRole("status").textContent).toContain("Couldn't read: bots");
  });
});
