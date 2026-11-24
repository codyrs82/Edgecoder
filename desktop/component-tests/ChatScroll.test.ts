// A chat opens at its latest messages; a streaming reply is followed only while the reader is at
// the bottom; "Jump to latest" shows when they scrolled up (a dot when something new arrived);
// `/compact` keeps a summary the next turn sends instead of the older messages.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import type { Conversation } from "../src/lib/types";

const db = vi.hoisted(() => ({ convs: new Map<string, Conversation>(), saved: [] as Conversation[] }));
vi.mock("../src/lib/chat-store", async (original) => ({
  ...(await original<typeof import("../src/lib/chat-store")>()),
  listConversationsBySource: vi.fn(async () => [...db.convs.values()]),
  loadConversation: vi.fn(async (id: string) => structuredClone(db.convs.get(id))),
  saveConversation: vi.fn(async (c: Conversation) => { db.saved.push(JSON.parse(JSON.stringify(c))); }),
}));
const api = vi.hoisted(() => ({ streamIdeChat: vi.fn(), ideCompact: vi.fn() }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original<typeof import("../src/lib/api")>()),
  backendReady: Promise.resolve(),
  isRemoteMode: () => false,
  getGitHubToken: vi.fn(async () => null),
  agentGitHubToken: vi.fn(async () => null),
  getModelPullProgress: vi.fn(async () => null),
  streamIdeChat: api.streamIdeChat,
  ideCompact: api.ideCompact,
  gitState: vi.fn(async () => ({ branch: "main", upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], branches: ["main"], remotes: [], remoteUrl: null, hasCommits: true })),
  gitGitHubStatus: vi.fn(async () => ({ ghInstalled: true, loggedIn: true, login: "me" })),
  fsFind: vi.fn(async () => []),
  getAvailableModels: vi.fn(async () => []),
  getCapacity: vi.fn(async () => ({})),
  listReservations: vi.fn(async () => ({ reservations: [] })),
  computeOverview: vi.fn(async () => ({})),
}));

import EditorChatPanel from "../src/components/EditorChatPanel.svelte";
import JumpToLatest from "../src/components/JumpToLatest.svelte";

Element.prototype.scrollTo ??= function () {};

// jsdom has no layout: the conversation region reports this size.
const layout = { scrollHeight: 2000, clientHeight: 500 };
const isRegion = (el: Element) => el.getAttribute?.("aria-label") === "Conversation";
const origSH = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
const origCH = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get() { return isRegion(this) ? layout.scrollHeight : origSH.get!.call(this); } });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get() { return isRegion(this) ? layout.clientHeight : origCH.get!.call(this); } });
  layout.scrollHeight = 2000;
  layout.clientHeight = 500;
  localStorage.clear();
  db.convs.clear();
  db.saved = [];
  const root = "/Users/me/EdgeCoder/site";
  db.convs.set("long", {
    id: "long", title: "A long chat", createdAt: 0, updatedAt: 0, source: "editor", projectRoot: root,
    messages: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: `message ${i}`, timestamp: i })) as Conversation["messages"],
  });
  localStorage.setItem(`edgecoder-last-editor-id:${root}`, "long");
  localStorage.setItem("edgecoder-recent-projects", JSON.stringify([{ root, openedAt: 1 }]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(Element.prototype, "scrollHeight", origSH);
  Object.defineProperty(Element.prototype, "clientHeight", origCH);
});

const region = () => screen.getByRole("region", { name: "Conversation" });
const jump = () => screen.queryByRole("button", { name: "Jump to latest" });

async function openLong() {
  const r = render(EditorChatPanel, { projectRoot: "/Users/me/EdgeCoder/site" });
  await screen.findByText("message 19");
  return r;
}

async function scrollTo(top: number) {
  region().scrollTop = top;
  await fireEvent.scroll(region());
}

describe("chat scroll", () => {
  it("opening a chat shows its latest messages, also when they render after it opened", async () => {
    await openLong();
    await waitFor(() => expect(region().scrollTop).toBe(2000));
    // Code blocks and images growing afterwards keep it at the bottom.
    layout.scrollHeight = 2600;
    await fireEvent.load(region().querySelector(".messages")!);
    await waitFor(() => expect(region().scrollTop).toBe(2600));
    expect(jump()).toBeNull();
    // The region stays a keyboard-focusable scroll area.
    expect(region().getAttribute("tabindex")).toBe("0");
  });

  it("a streaming reply is followed at the bottom, not after the reader scrolled up; Jump to latest shows with a dot and brings them back", async () => {
    let chunk: (t: string) => void = () => undefined;
    let finish: () => void = () => undefined;
    api.streamIdeChat.mockImplementation(async (_m: unknown, _r: string, onEvent: (e: unknown) => void) => {
      chunk = (t) => onEvent({ type: "text", content: t });
      await new Promise<void>((r) => (finish = r));
    });
    const { component } = await openLong();
    await waitFor(() => expect(region().scrollTop).toBe(2000));
    void (component as unknown as { sendMessage: (t: string) => Promise<void> }).sendMessage("go on");
    await waitFor(() => expect(api.streamIdeChat).toHaveBeenCalled());

    // At the bottom: new text is followed.
    layout.scrollHeight = 2400;
    chunk("First part. ");
    await screen.findByText(/First part/);
    await waitFor(() => expect(region().scrollTop).toBe(2400));
    expect(jump()).toBeNull();

    // The reader scrolls up to read: the next text leaves them there.
    await scrollTo(600);
    expect(jump()).toBeTruthy();
    expect(screen.queryByTestId("jump-unseen")).toBeNull();
    layout.scrollHeight = 3000;
    chunk("Second part.");
    await screen.findByText(/Second part/);
    await new Promise((r) => setTimeout(r, 50));
    expect(region().scrollTop).toBe(600);
    // Something new arrived meanwhile: the button says so.
    expect(await screen.findByTestId("jump-unseen")).toBeTruthy();

    const scrollSpy = vi.spyOn(region(), "scrollTo");
    await fireEvent.click(jump()!);
    expect(scrollSpy).toHaveBeenCalledWith({ top: 3000, behavior: "smooth" });
    await waitFor(() => expect(jump()).toBeNull());
    finish();
  });

  it("scrolling back down near the bottom (within 80 px) hides the button", async () => {
    await openLong();
    await waitFor(() => expect(region().scrollTop).toBe(2000));
    await scrollTo(400);
    expect(jump()).toBeTruthy();
    await scrollTo(2000 - 500 - 60);
    await waitFor(() => expect(jump()).toBeNull());
  });

  it("/compact keeps a summary: an inline note shows where, and the next turn sends it instead of the older messages", async () => {
    api.ideCompact.mockImplementation(async (messages: Array<{ content: string }>, _model: unknown, force: boolean) => {
      expect(force).toBe(true);
      expect(messages).toHaveLength(20);
      return { compacted: true, note: "[Earlier messages of this conversation were summarized to save tokens.]\nTalked about 0 to 15.", covered: 16, savedTokens: 12_345, summarized: true };
    });
    api.streamIdeChat.mockImplementation(async (_m: unknown, _r: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: "context", tokens: 42_000 });
      onEvent({ type: "text", content: "Sure." });
    });
    await openLong();
    const box = screen.getByRole("textbox");
    await fireEvent.input(box, { target: { value: "/compact" } });
    await fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Earlier messages summarized to save tokens · ~12,345 tokens saved")).toBeTruthy();
    expect(api.streamIdeChat).not.toHaveBeenCalled();
    await waitFor(() => expect(db.saved.at(-1)?.summary).toMatchObject({ throughId: "m15", savedTokens: 12_345, manual: true }));

    await fireEvent.input(box, { target: { value: "and now?" } });
    await fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.streamIdeChat).toHaveBeenCalled());
    const sent = api.streamIdeChat.mock.calls[0][0] as Array<{ content: string }>;
    expect(sent[0].content).toContain("Talked about 0 to 15.");
    expect(sent.map((m) => m.content)).toEqual([sent[0].content, "message 16", "message 17", "message 18", "message 19", "and now?"]);
    // The context meter beside the model picker.
    expect(await screen.findByRole("button", { name: /Compact conversation \(context ~42K tokens\)/ })).toBeTruthy();
  });
});

describe("JumpToLatest", () => {
  it("is a named button, hidden when not needed, with a dot for unseen content", async () => {
    const onJump = vi.fn();
    const { rerender } = render(JumpToLatest, { visible: false, onJump });
    expect(jump()).toBeNull();
    await rerender({ visible: true, unseen: true, onJump });
    expect(screen.getByTestId("jump-unseen")).toBeTruthy();
    jump()!.focus();
    expect(document.activeElement).toBe(jump());
    await fireEvent.click(jump()!);
    expect(onJump).toHaveBeenCalled();
  });
});
