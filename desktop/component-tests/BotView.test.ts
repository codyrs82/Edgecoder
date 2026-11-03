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
  botErrorText: (e: unknown) => String(e),
}));
vi.mock("../src/lib/api", () => api);
vi.mock("../src/lib/bots-store", () => ({ refreshBots: vi.fn().mockResolvedValue([]) }));

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
