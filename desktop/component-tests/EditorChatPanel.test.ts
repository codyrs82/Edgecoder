// The coding chat and its project: a chat without one shows a single prompt to pick or create a
// project; a chat in one shows project · branch above it and sends to the agent in that folder.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/svelte";
import type { Conversation } from "../src/lib/types";

const db = vi.hoisted(() => ({ convs: new Map<string, Conversation>(), saved: [] as Conversation[] }));
vi.mock("../src/lib/chat-store", async (original) => ({
  ...(await original<typeof import("../src/lib/chat-store")>()),
  listConversationsBySource: vi.fn(async () => [...db.convs.values()]),
  loadConversation: vi.fn(async (id: string) => structuredClone(db.convs.get(id))),
  saveConversation: vi.fn(async (c: Conversation) => { db.saved.push(JSON.parse(JSON.stringify(c))); }),
}));
const api = vi.hoisted(() => ({
  streamIdeChat: vi.fn(),
  // The chat's mirror on the provider (code-chat-mirror.ts): none by default.
  syncCodeChat: vi.fn(async (_b: unknown): Promise<{ sessionId: string }> => { throw new Error("no provider"); }),
  getSession: vi.fn(),
  followSession: vi.fn(async () => {}),
  sessionCancel: vi.fn(async () => ({})),
  sessionApprove: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original<typeof import("../src/lib/api")>()),
  backendReady: Promise.resolve(),
  isRemoteMode: () => false,
  getGitHubToken: vi.fn(async () => null),
  // The real one fetches the portal (10 s timeout): a send would wait on the network before streaming.
  agentGitHubToken: vi.fn(async () => null),
  getModelPullProgress: vi.fn(async () => null),
  streamIdeChat: api.streamIdeChat,
  syncCodeChat: api.syncCodeChat,
  getSession: api.getSession,
  followSession: api.followSession,
  sessionCancel: api.sessionCancel,
  sessionApprove: api.sessionApprove,
  gitState: vi.fn(async () => ({ branch: "main", upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], branches: ["main"], remotes: [], remoteUrl: null, hasCommits: true })),
  gitGitHubStatus: vi.fn(async () => ({ ghInstalled: true, loggedIn: true, login: "me" })),
  fsFind: vi.fn(async () => []),
  getAvailableModels: vi.fn(async () => []),
  getCapacity: vi.fn(async () => ({})),
  listReservations: vi.fn(async () => ({ reservations: [] })),
  computeOverview: vi.fn(async () => ({})),
}));

import EditorChatPanel from "../src/components/EditorChatPanel.svelte";

Element.prototype.scrollTo ??= function () {};

const legacy: Conversation = {
  id: "old", title: "Lets build a website.", createdAt: 0, updatedAt: 0, source: "editor",
  messages: [{ id: "m1", role: "user", content: "Lets build a website.", timestamp: 0 }, { id: "m2", role: "assistant", content: "Building a website involves several steps.", timestamp: 1 }],
};

beforeEach(() => {
  localStorage.clear();
  db.convs.clear();
  db.saved = [];
  localStorage.setItem("edgecoder-recent-projects", JSON.stringify([{ root: "/Users/me/EdgeCoder/site", openedAt: 1 }]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EditorChatPanel and projects", () => {
  it("with no project, shows one prompt to pick or create one and no composer", async () => {
    const onPickProject = vi.fn();
    const onNewProject = vi.fn();
    render(EditorChatPanel, { projectRoot: null, onPickProject, onNewProject });
    const prompt = await screen.findByRole("region", { name: "Pick a project to start" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/No folder open/)).toBeNull();
    await fireEvent.click(within(prompt).getByRole("button", { name: /^site/ }));
    expect(onPickProject).toHaveBeenCalledWith("/Users/me/EdgeCoder/site");
    await fireEvent.click(within(prompt).getByRole("button", { name: /New project/ }));
    expect(onNewProject).toHaveBeenCalled();
  });

  it("an old chat without a project keeps its messages and asks to be linked to one", async () => {
    db.convs.set("old", legacy);
    localStorage.setItem("edgecoder-last-editor-id", "old");
    render(EditorChatPanel, { projectRoot: null });
    expect(await screen.findByText("Building a website involves several steps.")).toBeTruthy();
    expect(await screen.findByRole("region", { name: "This chat isn't linked to a project" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("picking a project links the open chat to it", async () => {
    db.convs.set("old", legacy);
    localStorage.setItem("edgecoder-last-editor-id", "old");
    const { rerender } = render(EditorChatPanel, { projectRoot: null });
    await screen.findByText("Building a website involves several steps.");
    await rerender({ projectRoot: "/Users/me/EdgeCoder/site" });
    await vi.waitFor(() => expect(db.saved.at(-1)).toMatchObject({ id: "old", projectRoot: "/Users/me/EdgeCoder/site" }));
    expect(localStorage.getItem("edgecoder-last-editor-id:/Users/me/EdgeCoder/site")).toBe("old");
    expect(await screen.findByRole("button", { name: /^Branch main/ })).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("in a project, the shared slim composer has the compute picker and the permission mode picker in the row under it", async () => {
    render(EditorChatPanel, { projectRoot: "/Users/me/EdgeCoder/site" });
    const pill = await screen.findByTestId("composer-box");
    expect(within(pill).getByRole("textbox")).toBeTruthy();
    // + offers attaching files or mentioning a project file.
    expect(within(pill).getByRole("button", { name: "Add files" })).toBeTruthy();
    expect(within(pill).getByRole("button", { name: "Send message" })).toBeTruthy();
    const controls = screen.getByTestId("composer-controls");
    // New chats start in Settings' default (Accept edits).
    expect(within(controls).getByRole("button", { name: "Accept edits" }).getAttribute("aria-haspopup")).toBe("listbox");
    expect(within(controls).getByRole("button", { name: /Auto/ }).getAttribute("title")).toMatch(/^Choose the model/);
    expect(within(pill).queryByRole("checkbox")).toBeNull();
  });

  it("in a project, shows project · branch and sends to the agent in that folder", async () => {
    api.streamIdeChat.mockImplementation(async (_msgs: unknown, _root: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: "text", content: "Done." });
    });
    render(EditorChatPanel, { projectRoot: "/Users/me/EdgeCoder/site" });
    expect(await screen.findByRole("button", { name: /^Branch main/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Project" }).textContent).toContain("site");
    const box = screen.getByRole("textbox");
    expect(box.getAttribute("placeholder")).toContain("site");
    await fireEvent.input(box, { target: { value: "Add a footer" } });
    await fireEvent.keyDown(box, { key: "Enter" });
    await vi.waitFor(() => expect(api.streamIdeChat).toHaveBeenCalled());
    expect(api.streamIdeChat.mock.calls[0][1]).toBe("/Users/me/EdgeCoder/site");
    await vi.waitFor(() => expect(db.saved.at(-1)).toMatchObject({ title: "Add a footer", projectRoot: "/Users/me/EdgeCoder/site", source: "editor" }));
  });

  it("a chat stays with its project: switching projects opens that project's last chat", async () => {
    db.convs.set("a1", { ...legacy, id: "a1", title: "In api", projectRoot: "/p/api" });
    localStorage.setItem("edgecoder-last-editor-id:/p/api", "a1");
    db.convs.set("s1", { ...legacy, id: "s1", title: "In site", projectRoot: "/p/site" });
    localStorage.setItem("edgecoder-last-editor-id:/p/site", "s1");
    const { rerender } = render(EditorChatPanel, { projectRoot: "/p/site" });
    expect(await screen.findByText("In site")).toBeTruthy();
    await rerender({ projectRoot: "/p/api" });
    expect(await screen.findByText("In api")).toBeTruthy();
  });

  it("Plan mode: the chat keeps its mode, the plan gets Approve plan, and approving carries it out in Accept edits", async () => {
    api.streamIdeChat.mockImplementation(async (_msgs: unknown, _root: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: "text", content: "Plan:\n1. Add footer.html\n2. Link it" });
    });
    render(EditorChatPanel, { projectRoot: "/Users/me/EdgeCoder/site" });
    await fireEvent.click(await screen.findByRole("button", { name: "Accept edits" }));
    await fireEvent.keyDown(screen.getByRole("listbox"), { key: "4" });
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    const box = screen.getByRole("textbox");
    await fireEvent.input(box, { target: { value: "Add a footer" } });
    await fireEvent.keyDown(box, { key: "Enter" });
    await vi.waitFor(() => expect(api.streamIdeChat).toHaveBeenCalledTimes(1));
    expect(api.streamIdeChat.mock.calls[0][6]).toBe("plan");
    await vi.waitFor(() => expect(db.saved.at(-1)).toMatchObject({ permissionMode: "plan" }));
    expect(db.saved.at(-1)!.messages.at(-1)).toMatchObject({ role: "assistant", plan: true });
    api.streamIdeChat.mockImplementation(async (_msgs: unknown, _root: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: "text", content: "Done." });
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Approve plan" }));
    await vi.waitFor(() => expect(api.streamIdeChat).toHaveBeenCalledTimes(2));
    expect(api.streamIdeChat.mock.calls[1][6]).toBe("auto-edits");
    const sent = api.streamIdeChat.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(sent.at(-1)!.content).toMatch(/plan is approved/i);
    await vi.waitFor(() => expect(db.saved.at(-1)).toMatchObject({ permissionMode: "auto-edits" }));
    expect(screen.queryByTestId("plan-approval")).toBeNull();
  });
});

describe("EditorChatPanel helpers (docs/tentacles.md)", () => {
  const send = async (text: string) => {
    const box = await screen.findByRole("textbox");
    await fireEvent.input(box, { target: { value: text } });
    await fireEvent.keyDown(box, { key: "Enter" });
  };

  it("has a Helpers switch beside the pickers, off on a network lead, and sends it with the chat's id", async () => {
    api.streamIdeChat.mockImplementation(async () => {});
    render(EditorChatPanel, { projectRoot: "/Users/me/EdgeCoder/site" });
    const controls = await screen.findByTestId("composer-controls");
    expect(within(controls).getByRole("button", { name: /Helpers off/ })).toBeTruthy();
    await send("Add a footer");
    await vi.waitFor(() => expect(api.streamIdeChat).toHaveBeenCalled());
    const helpers = api.streamIdeChat.mock.calls[0][10] as { sessionId: string; enabled: boolean; maxParallel: number; budgetCSats: number };
    expect(helpers).toMatchObject({ enabled: false, maxParallel: 4, budgetCSats: 100 });
    expect(helpers.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is on by default with a frontier lead, and the chat keeps the user's choice", async () => {
    const { computeChoice } = await import("../src/lib/compute-choice");
    computeChoice.set("frontier/anthropic/claude-opus-5-5");
    try {
      api.streamIdeChat.mockImplementation(async () => {});
      render(EditorChatPanel, { projectRoot: "/Users/me/EdgeCoder/site" });
      const controls = await screen.findByTestId("composer-controls");
      await fireEvent.click(within(controls).getByRole("button", { name: /Helpers · 4 · 100 cSats/ }));
      await fireEvent.click(screen.getByRole("switch", { name: "Helpers" }));
      expect(within(controls).getByRole("button", { name: /Helpers off/ })).toBeTruthy();
      await send("Refactor the footer");
      await vi.waitFor(() => expect(api.streamIdeChat).toHaveBeenCalled());
      expect(api.streamIdeChat.mock.calls[0][10]).toMatchObject({ enabled: false });
      await vi.waitFor(() => expect(db.saved.at(-1)).toMatchObject({ helpers: { enabled: false } }));
    } finally {
      computeChoice.set(undefined);
    }
  });

  it("shows the helpers the lead starts, with where each call ran", async () => {
    const tentacle = { id: "t1234567", task: "Find the footer", kind: "search", readOnly: true, status: "running", progress: "starting", createdAt: 1, cSats: 0 };
    api.streamIdeChat.mockImplementation(async (_m: unknown, _r: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: "tentacle_started", tentacle });
      onEvent({ type: "tentacle_usage", id: "t1234567", call: { cSats: 0, model: "qwen3.5:9b", place: "local", served: { label: "This computer", own: true, computeClass: "local", tier: null, hardware: "This computer", region: null, country: null } }, cSats: 0, spentCSats: 0 });
      onEvent({ type: "text", content: "Done." });
    });
    render(EditorChatPanel, { projectRoot: "/Users/me/EdgeCoder/site" });
    await send("Where is the footer?");
    expect(await screen.findByText(/Tentacles · 1 running/)).toBeTruthy();
    expect(screen.getByText(/↳ this computer · qwen3\.5:9b/)).toBeTruthy();
  });
});

describe("EditorChatPanel on your phone (code-chat-mirror.ts)", () => {
  const PROJECT = "/Users/me/EdgeCoder/site";
  const chat: Conversation = { ...legacy, id: "c1", title: "what open PRs do we have?", projectRoot: PROJECT, permissionMode: "auto-edits" };
  const snapshot = (transcript: unknown[], running: unknown = null) => ({
    session: { id: "s1", title: chat.title, projectRoot: PROJECT, branch: "main", model: "auto", compute: { target: "auto" }, published: false, cSats: 0, transcript, mode: "auto-edits" },
    seq: 5, controller: null, clients: [], running, pending: [], queue: [],
  });
  let emit: (e: Record<string, unknown>) => void = () => {};
  beforeEach(() => {
    db.convs.set("c1", structuredClone(chat));
    localStorage.setItem("edgecoder-last-editor-id:" + PROJECT, "c1");
    api.syncCodeChat.mockImplementation(async () => ({ sessionId: "s1" }));
    api.getSession.mockImplementation(async () => snapshot([]));
    api.followSession.mockImplementation(async (_id: string, _since: number, onEvent: (e: Record<string, unknown>) => void) => {
      emit = onEvent;
    });
  });

  it("opening a chat syncs it (messages, mode) and a send carries the chat's id", async () => {
    api.streamIdeChat.mockImplementation(async (_m: unknown, _r: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: "turn", id: "11111111-1111-4111-8111-111111111111" });
      onEvent({ type: "text", content: "Fixed." });
    });
    render(EditorChatPanel, { projectRoot: PROJECT });
    await vi.waitFor(() => expect(api.syncCodeChat).toHaveBeenCalled());
    // Every call (the open chat's own and the backfill of earlier chats) carries the chat whole the first time.
    for (const [body] of api.syncCodeChat.mock.calls) {
      expect(body).toMatchObject({ chatId: "c1", projectRoot: PROJECT, mode: "auto-edits" });
      expect((body as { messages: Array<{ id: string }> }).messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    }
    await vi.waitFor(() => expect(api.followSession).toHaveBeenCalledWith("s1", 5, expect.any(Function), expect.any(AbortSignal)));
    const box = await screen.findByRole("textbox");
    await fireEvent.input(box, { target: { value: "fix it" } });
    await fireEvent.keyDown(box, { key: "Enter" });
    await vi.waitFor(() => expect(api.streamIdeChat).toHaveBeenCalled());
    expect(api.streamIdeChat.mock.calls[0][11]).toBe("c1");
    // The new message reached the mirror before the turn; afterwards so did the reply, with its turn id.
    const synced = api.syncCodeChat.mock.calls.flatMap((c) => (c[0] as { messages: Array<{ content: string; turnId?: string }> }).messages);
    expect(synced.find((m) => m.content === "fix it")).toBeTruthy();
    await vi.waitFor(() => expect(api.syncCodeChat.mock.calls.flatMap((c) => (c[0] as { messages: Array<{ content: string; turnId?: string }> }).messages).find((m) => m.content === "Fixed.")).toMatchObject({ turnId: "11111111-1111-4111-8111-111111111111" }));
  });

  it("shows what the phone did: its message, its running turn (Stop goes to the mirror) and the reply, saved with the chat", async () => {
    render(EditorChatPanel, { projectRoot: PROJECT });
    await vi.waitFor(() => expect(api.followSession).toHaveBeenCalled());
    emit({ seq: 6, type: "message", entry: { id: "p1", role: "user", content: "run the tests", at: 2, by: "remote" } });
    expect(await screen.findByText("run the tests")).toBeTruthy();
    emit({ seq: 7, type: "agent", turnId: "t2", event: { type: "turn", id: "t2" } });
    emit({ seq: 8, type: "agent", turnId: "t2", event: { type: "text", content: "Running npm test" } });
    expect(await screen.findByText("Running npm test")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.sessionCancel).toHaveBeenCalledWith("s1");
    emit({ seq: 9, type: "turn_end", entry: { id: "p2", role: "assistant", content: "Tests pass.", at: 3, turnId: "t2" } });
    expect(await screen.findByText("Tests pass.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await vi.waitFor(() => expect(db.saved.at(-1)!.messages.map((m) => m.id)).toEqual(["m1", "m2", "p1", "p2"]));
    // The app's own messages coming back from the mirror aren't added twice.
    emit({ seq: 10, type: "message", entry: { id: "m9", role: "user", content: "mine", at: 4, by: "desktop" } });
    expect(screen.queryByText("mine")).toBeNull();
  });

  it("on open, adds the phone's messages the chat missed while it was closed", async () => {
    api.getSession.mockImplementation(async () => snapshot([
      { id: "m1", role: "user", content: "Lets build a website.", at: 0, by: "desktop" },
      { id: "p1", role: "user", content: "add a contact page", at: 5, by: "remote" },
      { id: "p2", role: "assistant", content: "Added contact.html.", at: 6, turnId: "t9", changedFiles: ["contact.html"] },
    ]));
    render(EditorChatPanel, { projectRoot: PROJECT });
    expect(await screen.findByText("Added contact.html.")).toBeTruthy();
    expect(screen.getByText("add a contact page")).toBeTruthy();
    expect(screen.getAllByText("Lets build a website.")).toHaveLength(1);
  });
});
