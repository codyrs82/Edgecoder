import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/svelte";

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
  it("is compact: name, status chip, one metadata line and what it's doing next; no Pause or Run now; no error text in it", () => {
    setup();
    expect(screen.getByRole("heading", { name: /Harry · Lead Developer/ })).toBeTruthy();
    expect(screen.getByTestId("bot-status-chip").textContent).toBe("Failed");
    const meta = screen.getByTestId("bot-meta").textContent ?? "";
    expect(meta).toMatch(/Every 30 minutes/);
    expect(meta).toMatch(/12 \/ 100 cSats today/);
    expect(meta).toMatch(/Local first/);
    expect(meta).toMatch(/Harry the Engineer/);
    expect(meta).not.toMatch(/CloudStorage/);
    expect(screen.getByTitle("/Users/me/Library/CloudStorage/Dropbox/Agents/Harry the Engineer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run now/ })).toBeNull();
    expect(document.querySelector(".bot-head button.primary")).toBeNull();
    // It just works: pausing lives in the ⋯ menu, not the header.
    expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull();
    expect(document.querySelector(".bot-head")?.textContent).not.toMatch(/Pause|Resume/);
    expect(document.querySelector(".bot-head")?.textContent).not.toMatch(/Not enough cSats/);
  });

  it("shows when it next works on its own", () => {
    setup(harry({ status: "idle", lastRun: undefined, schedule: "", nextRun: { kind: "heartbeat", atMs: Date.now() + 12 * 60_000 } }));
    const st = screen.getByTestId("bot-auto-status");
    expect(st.getAttribute("role")).toBe("status");
    expect(st.textContent).toBe("Next check in 12 min");
    expect(screen.getByTestId("bot-meta").textContent).toMatch(/Checks in every 30 minutes/);
  });

  it("messages go through the shared slim composer, with the working placeholder while it runs", () => {
    setup(harry({ status: "running", lastRun: undefined }));
    const pill = screen.getByTestId("composer-box");
    expect(within(pill).getByRole("textbox", { name: "Harry is working; your message goes next…" })).toBeTruthy();
    // Working: the send arrow is Stop, and there is no Stop in the header.
    expect(within(pill).getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(within(pill).queryByRole("button", { name: "Send message" })).toBeNull();
    expect(within(document.querySelector(".bot-head") as HTMLElement).queryByRole("button", { name: /Stop/ })).toBeNull();
    // + attaches files, and the bot can't see images: the note says so when one is attached.
    expect(within(pill).getByRole("button", { name: "Attach files" })).toBeTruthy();
  });

  it("shows Working… while it runs; Stop in the composer cancels the run, and Enter still sends (the bot takes it next)", async () => {
    setup(harry({ status: "running", lastRun: undefined }));
    expect(screen.getByTestId("bot-auto-status").textContent).toBe("Working…");
    await fireEvent.click(within(screen.getByTestId("composer-box")).getByRole("button", { name: "Stop" }));
    expect(api.cancelBotRun).toHaveBeenCalledWith("bot_h");
    const box = screen.getByRole("textbox");
    await fireEvent.input(box, { target: { value: "then check the firewall" } });
    expect(screen.getByText("Enter to queue")).toBeTruthy();
    await fireEvent.keyDown(box, { key: "Enter" });
    expect(api.sendBotMessage).toHaveBeenCalledWith("bot_h", "then check the firewall", undefined);
  });

  it("says where the current step runs, next to the compute choice", async () => {
    const run = { id: "run_9", trigger: "message" as const, startedAtMs: 0, status: "running" as const, summary: "", cSats: 2.5 };
    api.botHistory.mockResolvedValue([]);
    api.botMessages.mockResolvedValue([
      {
        id: "a1", role: "assistant", content: "", atMs: 0, runId: "run_9",
        events: [
          { type: "status", message: "Compute: network · qwen3-coder:30b" },
          { type: "usage", cSats: 2.5, where: "Network · qwen3-coder:30b", model: "network/qwen3-coder:30b@gpu.dc", served: { label: "lin-•••3f2a", own: false, computeClass: "gpu.dc", tier: null, hardware: "Datacenter GPU (gpu.dc40)", gpu: "2× NVIDIA A16", region: null, country: null } },
        ],
      },
    ]);
    render(BotView, { bot: harry({ status: "running", lastRun: run }), onEdit: vi.fn(), onDeleted: vi.fn(), onOpenSettings: vi.fn() });
    const where = await screen.findByTestId("bot-placement");
    expect(where.textContent).toBe("Running on: Network · Datacenter GPU 2×A16 · qwen3-coder:30b · 2.5 cSats");
  });

  it("idle: the normal send arrow, no Stop", () => {
    setup(harry({ status: "idle", lastRun: undefined }));
    const pill = screen.getByTestId("composer-box");
    expect(within(pill).getByRole("button", { name: "Send message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("Pause and Resume are in the ⋯ menu and toggle the bot", async () => {
    setup(harry({ status: "idle", lastRun: undefined }));
    await fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Pause Harry" }));
    expect(api.updateBot).toHaveBeenCalledWith("bot_h", { enabled: false });
    cleanup();
    setup(harry({ status: "paused", enabled: false, lastRun: undefined }));
    // A quiet status says so; the header has no button for it.
    expect(screen.getByTestId("bot-auto-status").textContent).toBe("Paused");
    expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Resume Harry" }));
    expect(api.updateBot).toHaveBeenCalledWith("bot_h", { enabled: true });
  });

  it("keeps a manual nudge, Edit and Delete in the overflow menu", async () => {
    const p = setup(harry({ status: "idle", lastRun: undefined }));
    api.runBot.mockResolvedValue({ started: true });
    await fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Check now/ }));
    expect(api.runBot).toHaveBeenCalledWith("bot_h");
    await fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Edit/ }));
    expect(p.onEdit).toHaveBeenCalled();
  });
});

describe("BotView live run", () => {
  it("shows the reply and its steps as they arrive, as compact tool rows with the working indicator", async () => {
    const running = harry({ status: "running", lastRun: { id: "run_5", trigger: "message", startedAtMs: 0, status: "running", summary: "", cSats: 0 } });
    api.botMessages.mockResolvedValue([
      { id: "u1", role: "user", content: "read them all", atMs: 0 },
      { id: "m1", role: "assistant", content: "Listing your folder.", atMs: 0, runId: "run_5", events: [
        { type: "text", content: "Listing your folder." },
        { type: "tool_call", id: "t1", tool: "list_directory", args: { path: "." }, requires_approval: false },
        { type: "tool_result", id: "t1", result: "README.md\nTODO.md" },
        { type: "tool_call", id: "t2", tool: "read_file", args: { path: "TODO.md" }, requires_approval: false },
      ] },
    ]);
    api.botHistory.mockResolvedValue([running.lastRun]);
    render(BotView, { bot: running, onEdit: vi.fn(), onDeleted: vi.fn() });
    expect(await screen.findByText(/Listing your folder/)).toBeTruthy();
    // Both steps show while it runs (not folded into a summary), and it still looks busy.
    const rows = document.querySelectorAll(".tool-events > *");
    expect(rows.length).toBe(2);
    expect(document.querySelector(".steps-summary")).toBeNull();
    expect(document.querySelector(".tool-events")?.textContent).toMatch(/TODO\.md/);
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

describe("BotView settles (it froze the app on a bot with a last run)", () => {
  const lastRun = { id: "run_9", trigger: "schedule" as const, startedAtMs: Date.now() - 20 * 60_000, endedAtMs: Date.now() - 19 * 60_000, status: "done" as const, summary: "I'll start by checking the current status of the project.", cSats: 0, where: "This computer · qwen2.5-coder:7b" };
  const idle = () => harry({ status: "idle", lastRun: { ...lastRun }, nextRunAtMs: Date.now() + 10 * 60_000 });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("loads once per change, not once per poll of the bots list, and agrees with Last run", async () => {
    localStorage.setItem("edgecoder-bot-panel", "open");
    for (const f of [api.botMessages, api.botHistory, api.getBot]) f.mockReset();
    api.botMessages.mockResolvedValue([]);
    api.botHistory.mockResolvedValue([]);
    api.getBot.mockResolvedValue({ bot: idle(), memory: "" });
    const { rerender } = render(BotView, { bot: idle(), onEdit: vi.fn(), onDeleted: vi.fn() });
    await settle();
    // The store hands the page a new, equal bot object every poll (every 8 s).
    for (let i = 0; i < 20; i++) {
      await rerender({ bot: idle() });
      await settle();
    }
    expect(api.botMessages).toHaveBeenCalledTimes(1);
    expect(api.botHistory).toHaveBeenCalledTimes(1);
    expect(api.getBot).not.toHaveBeenCalled();
    // Runs agrees with the details panel's Last run, even when the history came back empty.
    expect(screen.getByRole("tab", { name: /Runs \(1\)/ })).toBeTruthy();
    expect(screen.getByTestId("bot-details").textContent).toMatch(/Last run\s*Done/);
    expect(screen.getByTestId("bot-last-run-note").textContent).toMatch(/last worked 20 min ago: I'll start by checking/);
    // A real change loads again, once.
    await rerender({ bot: harry({ status: "idle", lastRun: { ...lastRun, id: "run_10" } }) });
    await settle();
    expect(api.botMessages).toHaveBeenCalledTimes(2);
  });

  it("a poll doesn't close the open menu", async () => {
    setup(idle());
    await settle();
    await fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    cleanup();
    const { rerender } = render(BotView, { bot: idle(), onEdit: vi.fn(), onDeleted: vi.fn() });
    await fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await rerender({ bot: idle() });
    await settle();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("renders a huge reply quickly, trimmed to its start and latest part", async () => {
    // A small model wrote whole files as text tool calls: markdown parsing of this grows
    // quadratically, and at this size it pinned the page for minutes.
    const huge = "I'll start by checking the current status." + " self._cache".repeat(25_000) + "\n\nAll done.";
    api.botMessages.mockResolvedValue([{ id: "m1", role: "assistant", content: huge, atMs: 0, runId: "run_9", events: [{ type: "text", content: huge }] }]);
    api.botHistory.mockResolvedValue([lastRun]);
    const t = performance.now();
    render(BotView, { bot: idle(), onEdit: vi.fn(), onDeleted: vi.fn() });
    const reply = await screen.findByText(/earlier output trimmed/);
    expect(performance.now() - t).toBeLessThan(3_000);
    const text = reply.closest(".markdown")?.textContent ?? "";
    expect(text).toMatch(/^I'll start by checking/);
    expect(text.trim()).toMatch(/All done\.$/);
    expect(text.length).toBeLessThan(9_000);
  });
});
