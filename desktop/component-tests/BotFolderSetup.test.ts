import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  setupBotFolder: vi.fn(),
  botErrorText: (e: unknown) => (e as Error).message,
}));
vi.mock("../src/lib/api", () => api);
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import BotFolderSetup from "../src/components/BotFolderSetup.svelte";
import { defaultBotFolder, statusChip, type Bot } from "../src/lib/bots";

/* A bot made on the web arrives without a folder: the card picks one here, and only here (#409). */
const webBot = (over: Partial<Bot> = {}): Bot =>
  ({
    id: "bot_w0123456789ab",
    name: "Harry",
    role: "Engineer",
    instructions: "",
    projectRoot: "",
    enabled: true,
    schedule: "",
    budgetCSatsPerDay: 100,
    allowedTools: [],
    autoApproveEdits: true,
    color: "#0090ff",
    createdAtMs: 0,
    updatedAtMs: 0,
    status: "needs_folder",
    spentTodayCSats: 0,
    pending: [],
    queuedMessages: 0,
    setup: { source: "web", requestId: "req-1", requestedBy: "acct-u1", requestedAtMs: 0 },
    ...over,
  }) as Bot;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BotFolderSetup", () => {
  it("shows the three choices with the default path", () => {
    render(BotFolderSetup, { bot: webBot() });
    expect(screen.getByRole("heading", { name: "Set up Harry's folder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose folder/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use default ~\/EdgeCoder\/Bots\/Harry/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use an existing folder" })).toBeTruthy();
    expect(statusChip(webBot()).text).toBe("Needs folder");
    expect(defaultBotFolder("a/b")).toBe("~/EdgeCoder/Bots/a b");
  });

  it("Use default asks the provider to make it (no path from the web)", async () => {
    const onDone = vi.fn();
    api.setupBotFolder.mockResolvedValue(webBot({ projectRoot: "/Users/me/EdgeCoder/Bots/Harry", status: "idle", setup: undefined }));
    render(BotFolderSetup, { bot: webBot(), onDone });
    await fireEvent.click(screen.getByRole("button", { name: /Use default/ }));
    expect(api.setupBotFolder).toHaveBeenCalledWith("bot_w0123456789ab", { choice: "default" });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("Choose folder… uses the native picker; cancelling it sends nothing", async () => {
    dialog.open.mockResolvedValueOnce(null).mockResolvedValueOnce("/Users/me/Projects/site");
    api.setupBotFolder.mockResolvedValue(webBot({ status: "idle" }));
    render(BotFolderSetup, { bot: webBot() });
    await fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
    await waitFor(() => expect(dialog.open).toHaveBeenCalledTimes(1));
    expect(api.setupBotFolder).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
    await waitFor(() => expect(api.setupBotFolder).toHaveBeenCalledWith("bot_w0123456789ab", { choice: "path", path: "/Users/me/Projects/site" }));
  });

  it("the web's suggestion is only pre-filled: nothing is sent until it's confirmed here", async () => {
    api.setupBotFolder.mockResolvedValue(webBot({ status: "idle" }));
    render(BotFolderSetup, { bot: webBot({ setup: { source: "web", requestId: "r", requestedBy: "a", requestedAtMs: 0, suggestedFolder: "/Users/me/Suggested" } }) });
    expect(screen.getByTestId("folder-suggestion").textContent).toContain("/Users/me/Suggested");
    expect(api.setupBotFolder).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Use an existing folder" }));
    const input = screen.getByLabelText("Existing folder") as HTMLInputElement;
    expect(input.value).toBe("/Users/me/Suggested");
    expect(api.setupBotFolder).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(api.setupBotFolder).toHaveBeenCalledWith("bot_w0123456789ab", { choice: "path", path: "/Users/me/Suggested" });
  });

  it("Auto asked on the web is off until confirmed here", async () => {
    api.setupBotFolder.mockResolvedValue(webBot({ status: "idle" }));
    const autoBot = webBot({ setup: { source: "web", requestId: "r", requestedBy: "a", requestedAtMs: 0, requestedMode: "auto" } });
    render(BotFolderSetup, { bot: autoBot });
    const box = screen.getByTestId("confirm-auto") as HTMLInputElement;
    expect(box.checked).toBe(false);
    await fireEvent.click(screen.getByRole("button", { name: /Use default/ }));
    expect(api.setupBotFolder).toHaveBeenLastCalledWith("bot_w0123456789ab", { choice: "default" });
    await fireEvent.click(box);
    await fireEvent.click(screen.getByRole("button", { name: /Use default/ }));
    await waitFor(() => expect(api.setupBotFolder).toHaveBeenLastCalledWith("bot_w0123456789ab", { choice: "default", allowAuto: true }));
  });

  it("shows the provider's error", async () => {
    api.setupBotFolder.mockRejectedValue(new Error("No folder at /nope"));
    render(BotFolderSetup, { bot: webBot() });
    await fireEvent.click(screen.getByRole("button", { name: "Use an existing folder" }));
    await fireEvent.input(screen.getByLabelText("Existing folder"), { target: { value: "/nope" } });
    await fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No folder at /nope"));
  });
});
