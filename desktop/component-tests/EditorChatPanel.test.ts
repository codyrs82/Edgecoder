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
const api = vi.hoisted(() => ({ streamIdeChat: vi.fn() }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original<typeof import("../src/lib/api")>()),
  backendReady: Promise.resolve(),
  isRemoteMode: () => false,
  getGitHubToken: vi.fn(async () => null),
  // The real one fetches the portal (10 s timeout): a send would wait on the network before streaming.
  agentGitHubToken: vi.fn(async () => null),
  getModelPullProgress: vi.fn(async () => null),
  streamIdeChat: api.streamIdeChat,
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

  it("in a project, the shared slim composer has the compute picker and Auto-apply edits in the row under it", async () => {
    render(EditorChatPanel, { projectRoot: "/Users/me/EdgeCoder/site" });
    const pill = await screen.findByTestId("composer-box");
    expect(within(pill).getByRole("textbox")).toBeTruthy();
    expect(within(pill).getByRole("button", { name: "Add a file or folder" })).toBeTruthy();
    expect(within(pill).getByRole("button", { name: "Send message" })).toBeTruthy();
    const controls = screen.getByTestId("composer-controls");
    expect(within(controls).getByRole("checkbox", { name: "Auto-apply edits" })).toBeTruthy();
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
});
