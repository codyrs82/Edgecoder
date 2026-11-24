// Deleting a chat from the sidebar removes it for good, even the open one: the open chat panel
// saves its chat again on New chat, on unmount and on its next change, which used to bring a
// deleted open chat straight back ("it never goes away"). Runs the real chat-store over an
// in-memory IndexedDB.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/svelte";
import type { Conversation } from "../src/lib/types";

const idb = vi.hoisted(() => ({ rows: new Map<string, unknown>(), failDelete: false }));
vi.mock("idb", () => ({
  openDB: async () => ({
    put: async (_s: string, v: { id: string }) => { idb.rows.set(v.id, structuredClone(v)); },
    get: async (_s: string, id: string) => structuredClone(idb.rows.get(id)),
    getAll: async () => [...idb.rows.values()].map((v) => structuredClone(v)),
    delete: async (_s: string, id: string) => {
      if (idb.failDelete) throw new Error("The database is locked");
      idb.rows.delete(id);
    },
  }),
}));
const toast = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("../src/lib/toast", () => toast);
vi.mock("../src/lib/api", () => ({
  computeOverview: vi.fn(async () => ({})),
  portalWebUrl: (p = "") => p,
  portalDeleteConversation: vi.fn(async () => undefined),
  portalRenameConversation: vi.fn(async () => undefined),
}));

import ProjectSidebar from "../src/components/ProjectSidebar.svelte";
import ConversationSidebar from "../src/components/ConversationSidebar.svelte";
import { saveConversation, listConversationsBySource } from "../src/lib/chat-store";

const ROOT = "/Users/me/EdgeCoder/Edgecoder";
// Chat ids are UUIDs: a deleted id is never saved again (this session), so each test has its own.
let seq = 0;
const ids: Record<string, string> = {};
const chat = (key: string, title: string, source: "editor" | "chat" = "editor"): Conversation => ({
  id: (ids[key] = `${key}-${++seq}`), title, createdAt: 1, updatedAt: Date.now(), source, projectRoot: ROOT,
  messages: [{ id: `${key}-m`, role: "user", content: title, timestamp: 1 }],
});

beforeEach(async () => {
  idb.rows.clear();
  idb.failDelete = false;
  localStorage.clear();
  localStorage.setItem("edgecoder-recent-projects", JSON.stringify([{ root: ROOT, openedAt: 1 }]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function confirmDelete(title: string) {
  await fireEvent.click(await screen.findByRole("button", { name: `More options for ${title}` }));
  await fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
  await fireEvent.click(await screen.findByRole("menuitem", { name: /Confirm delete\?/ }));
}

const titles = async (source: "editor" | "chat") => (await listConversationsBySource(source)).map((c) => c.title);

describe("Code view: deleting a chat (ProjectSidebar)", () => {
  it("deletes a chat that isn't open", async () => {
    const open = chat("a", "Add a contact form");
    await saveConversation(open);
    await saveConversation(chat("b", "Lets build a website."));
    const onNewChat = vi.fn();
    render(ProjectSidebar, { currentProject: ROOT, activeChatId: ids.a, onOpenProject: vi.fn(), onSelectChat: vi.fn(), onNewChat, onNewProject: vi.fn(), onOpenFolder: vi.fn(), onClone: vi.fn() });
    await confirmDelete("Lets build a website.");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Lets build a website\./ })).toBeNull());
    expect(await titles("editor")).toEqual(["Add a contact form"]);
    expect(onNewChat).not.toHaveBeenCalled();
    // The open chat still saves.
    open.title = "Add a contact form, with captcha";
    await saveConversation(open);
    expect(await titles("editor")).toEqual(["Add a contact form, with captcha"]);
  });

  it("deletes the open chat for good and moves the panel to a new chat", async () => {
    const open = chat("b", "Lets build a website.");
    await saveConversation(open);
    await saveConversation(chat("a", "Add a contact form"));
    // What the open panel does on New chat (EditorChatPanel.newChat → persist): save the chat it had.
    const onNewChat = vi.fn(async () => { await saveConversation(open); });
    render(ProjectSidebar, { currentProject: ROOT, activeChatId: ids.b, onOpenProject: vi.fn(), onSelectChat: vi.fn(), onNewChat, onNewProject: vi.fn(), onOpenFolder: vi.fn(), onClone: vi.fn() });
    await confirmDelete("Lets build a website.");
    await waitFor(() => expect(onNewChat).toHaveBeenCalledWith(ROOT));
    // A later autosave (unmount, the next change) doesn't bring it back either.
    open.updatedAt = Date.now();
    await saveConversation(open);
    expect(await titles("editor")).toEqual(["Add a contact form"]);
    const list = await screen.findByRole("list", { name: /Chats in/ });
    await waitFor(() => expect(within(list).queryByRole("button", { name: /^Lets build a website\./ })).toBeNull());
  });

  it("a delete that fails says so and keeps the chat (and it still saves)", async () => {
    const open = chat("b", "Lets build a website.");
    await saveConversation(open);
    idb.failDelete = true;
    const onNewChat = vi.fn();
    render(ProjectSidebar, { currentProject: ROOT, activeChatId: ids.b, onOpenProject: vi.fn(), onSelectChat: vi.fn(), onNewChat, onNewProject: vi.fn(), onOpenFolder: vi.fn(), onClone: vi.fn() });
    await confirmDelete("Lets build a website.");
    await waitFor(() => expect(toast.notify).toHaveBeenCalledWith(expect.stringMatching(/Couldn't delete "Lets build a website\.": The database is locked/), "error"));
    expect(onNewChat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Lets build a website\./ })).toBeTruthy();
    open.title = "Lets build a website, v2";
    await saveConversation(open);
    expect(await titles("editor")).toEqual(["Lets build a website, v2"]);
  });
});

describe("Chat view: deleting a chat (ConversationSidebar)", () => {
  const props = (activeConversationId: string, onNewChat = vi.fn()) => ({ open: true, inline: true, onClose: vi.fn(), onSelectConversation: vi.fn(), onNewChat, activeConversationId });

  it("deletes a chat that isn't open", async () => {
    await saveConversation(chat("a", "First chat", "chat"));
    await saveConversation(chat("b", "Second chat", "chat"));
    const p = props(ids.a);
    render(ConversationSidebar, p);
    await confirmDelete("Second chat");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Second chat/ })).toBeNull());
    expect(await titles("chat")).toEqual(["First chat"]);
    expect(p.onNewChat).not.toHaveBeenCalled();
  });

  it("deletes the open chat for good and starts a new one", async () => {
    const open = chat("b", "Second chat", "chat");
    await saveConversation(chat("a", "First chat", "chat"));
    await saveConversation(open);
    // ChatView.newChat saves the chat it had.
    const onNewChat = vi.fn(async () => { await saveConversation(open); });
    render(ConversationSidebar, props(ids.b, onNewChat));
    await confirmDelete("Second chat");
    await waitFor(() => expect(onNewChat).toHaveBeenCalled());
    expect(await titles("chat")).toEqual(["First chat"]);
  });

  it("a delete that fails says so and keeps the chat", async () => {
    await saveConversation(chat("b", "Second chat", "chat"));
    idb.failDelete = true;
    const p = props(ids.b);
    render(ConversationSidebar, p);
    await confirmDelete("Second chat");
    await waitFor(() => expect(toast.notify).toHaveBeenCalledWith(expect.stringMatching(/Couldn't delete "Second chat"/), "error"));
    expect(p.onNewChat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Second chat/ })).toBeTruthy();
  });
});
