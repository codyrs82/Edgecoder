import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  botMessages: vi.fn(),
  botHistory: vi.fn(),
  updateBot: vi.fn(),
  runBot: vi.fn(),
  deleteBot: vi.fn(),
  cancelBotRun: vi.fn(),
  sendBotMessage: vi.fn(),
  approveBotCall: vi.fn(),
  getBot: vi.fn(),
  botErrorText: (e: unknown) => String(e),
}));
vi.mock("../src/lib/api", () => api);
vi.mock("../src/lib/bots-store", () => ({ refreshBots: vi.fn().mockResolvedValue([]) }));

// jsdom has no Element.scrollTo (the conversation scrolls to the newest message).
Element.prototype.scrollTo ??= function () {};

import BotView from "../src/pages/BotView.svelte";
import type { Bot } from "../src/lib/bots";

const error = "Not enough cSats for this request (it sets aside up to 91.8 cSats; unused cSats come back).";
const harry = (over: Partial<Bot> = {}): Bot => ({
  id: "bot_h",
  name: "Harry",
  role: "Lead Developer",
  instructions: "",
  projectRoot: "/Users/me/Library/CloudStorage/Dropbox/Agents/Harry the Engineer",
  enabled: true,
  schedule: "every 30 minutes",
  budgetCSatsPerDay: 100,
  allowedTools: [],
  autoApproveEdits: true,
  compute: { policy: "local_first" },
  color: "#0090ff",
  createdAtMs: 0,
  updatedAtMs: 0,
  nextRunAtMs: Date.now() + 30 * 60_000,
  status: "error",
  spentTodayCSats: 12,
  lastRun: { id: "run_1", trigger: "schedule", startedAtMs: 0, endedAtMs: 1, status: "failed", summary: `Failed: ${error}`, cSats: 0, error },
  pending: [],
  queuedMessages: 0,
  ...over,
});

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

function setup(bot = harry()) {
  api.botMessages.mockResolvedValue([]);
  api.botHistory.mockResolvedValue([]);
  api.updateBot.mockResolvedValue(bot);
  const props = { bot, onEdit: vi.fn(), onDeleted: vi.fn(), onOpenSettings: vi.fn() };
  render(BotView, props);
  return props;
}

describe("BotView header", () => {
  it("is compact: name, status chip, one metadata line, Run now and a menu; no error text in it", () => {
    setup();
    expect(screen.getByRole("heading", { name: /Harry · Lead Developer/ })).toBeTruthy();
    expect(screen.getByTestId("bot-status-chip").textContent).toBe("Failed");
    const meta = screen.getByTestId("bot-meta").textContent ?? "";
    expect(meta).toMatch(/Every 30 minutes · next in 30 min/);
    expect(meta).toMatch(/12 \/ 100 cSats today/);
    expect(meta).toMatch(/Local first/);
    expect(meta).toMatch(/Harry the Engineer/);
    expect(meta).not.toMatch(/CloudStorage/);
    expect(screen.getByTitle("/Users/me/Library/CloudStorage/Dropbox/Agents/Harry the Engineer")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Run now/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Pause/ })).toBeNull();
    expect(document.querySelector(".bot-head")?.textContent).not.toMatch(/Not enough cSats/);
  });

  it("puts Pause, Edit and Delete in the overflow menu", async () => {
    const p = setup();
    await fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /Pause schedule/ })).toBeTruthy();
    await fireEvent.click(screen.getByRole("menuitem", { name: /Edit/ }));
    expect(p.onEdit).toHaveBeenCalled();
  });
});

describe("BotView failure notice", () => {
  it("explains the failure in plain words with actions, and can be dismissed", async () => {
    const p = setup();
    const notice = screen.getByTestId("bot-failure-notice");
    expect(notice.textContent).toMatch(/weren't enough cSats/);
    expect(notice.textContent).not.toMatch(/91\.8/);
    await fireEvent.click(screen.getByRole("button", { name: "Buy cSats" }));
    expect(p.onOpenSettings).toHaveBeenCalledWith("plan");
    await fireEvent.click(screen.getByRole("button", { name: "Switch to This computer" }));
    expect(api.updateBot).toHaveBeenCalledWith("bot_h", { compute: { policy: "local_only" } });
    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("bot-failure-notice")).toBeNull();
  });

  it("shows no notice when the last run didn't fail", () => {
    setup(harry({ status: "idle", lastRun: undefined }));
    expect(screen.queryByTestId("bot-failure-notice")).toBeNull();
    expect(screen.getByTestId("bot-status-chip").textContent).toBe("Idle");
  });
});

describe("BotView avatar, ask cards and details panel", () => {
  it("the avatar shows the bot's state", () => {
    setup(harry({ status: "needs_approval", lastRun: undefined, pending: [{ callId: "c1", tool: "run_shell", args: { command: "npm test" } }] }));
    expect(screen.getByRole("img", { name: "Harry (needs you)" }).getAttribute("data-mood")).toBe("needs");
  });

  it("asks for approval in an inline card and shows your answer", async () => {
    const waiting = harry({ status: "needs_approval", lastRun: { id: "run_2", trigger: "manual", startedAtMs: 0, status: "needs_approval", summary: "", cSats: 0 }, pending: [{ callId: "c1", tool: "run_shell", args: { command: "npm test" } }] });
    api.botMessages.mockResolvedValue([
      { id: "m1", role: "assistant", content: "", atMs: 0, runId: "run_2", events: [{ type: "tool_call", id: "c1", tool: "run_shell", args: { command: "npm test" }, requires_approval: true }] },
    ]);
    api.botHistory.mockResolvedValue([waiting.lastRun]);
    api.approveBotCall.mockResolvedValue({ ok: true });
    render(BotView, { bot: waiting, onEdit: vi.fn(), onDeleted: vi.fn() });
    const card = await screen.findByTestId("ask-card");
    expect(card.textContent).toMatch(/Harry wants to run a command/);
    expect(card.textContent).toMatch(/npm test/);
    // Only the card asks: the tool block has no second Allow/Deny bar.
    expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);
    await fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(api.approveBotCall).toHaveBeenCalledWith("bot_h", "c1", true);
  });

  it("shows an answered card with the answer", async () => {
    api.botMessages.mockResolvedValue([
      { id: "m1", role: "assistant", content: "Done.", atMs: 0, runId: "run_3", events: [{ type: "tool_call", id: "c9", tool: "git_push", args: {}, requires_approval: true }, { type: "tool_result", id: "c9", result: "ok" }, { type: "text", content: "Done." }] },
    ]);
    api.botHistory.mockResolvedValue([{ id: "run_3", trigger: "manual", startedAtMs: 0, status: "done", summary: "Done.", cSats: 0 }]);
    render(BotView, { bot: harry({ status: "idle", lastRun: undefined }), onEdit: vi.fn(), onDeleted: vi.fn() });
    const card = await screen.findByTestId("ask-card");
    expect(card.textContent).toMatch(/You: Allowed/);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("opens the details panel with routines, compute, budget, memory and folder", async () => {
    api.getBot.mockResolvedValue({ bot: harry(), memory: "- 2026-11-02: tests live in tests/" });
    const p = setup(harry({ status: "idle", lastRun: undefined }));
    expect(screen.queryByTestId("bot-details")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    const panel = screen.getByTestId("bot-details");
    expect(panel.textContent).toMatch(/Every 30 minutes/);
    expect(panel.textContent).toMatch(/Next run in 30 min/);
    expect(panel.textContent).toMatch(/Local first/);
    expect(panel.textContent).toMatch(/12 of 100 cSats/);
    // The routine toggle pauses the schedule.
    await fireEvent.click(screen.getByRole("switch"));
    expect(api.updateBot).toHaveBeenCalledWith("bot_h", { enabled: false });
    await fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
    expect(await screen.findByText(/tests live in tests/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("tab", { name: "Folder" }));
    expect(panel.textContent).toMatch(/CloudStorage\/Dropbox\/Agents\/Harry the Engineer/);
    // The "..." menu now lives in the panel and holds Edit.
    await fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Edit/ }));
    expect(p.onEdit).toHaveBeenCalled();
  });
});
