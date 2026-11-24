// chat-store: a deleted chat stays deleted. The chat that was open saves itself again (New chat,
// unmount, its next change); those saves are dropped, so it can't come back in the sidebar.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../src/lib/types";

const idb = vi.hoisted(() => ({ rows: new Map<string, unknown>(), failDelete: false, deleteGate: null as Promise<void> | null }));
vi.mock("idb", () => ({
  openDB: async () => ({
    put: async (_s: string, v: { id: string }) => void idb.rows.set(v.id, structuredClone(v)),
    get: async (_s: string, id: string) => structuredClone(idb.rows.get(id)),
    getAll: async () => [...idb.rows.values()],
    delete: async (_s: string, id: string) => {
      if (idb.deleteGate) await idb.deleteGate;
      if (idb.failDelete) throw new Error("locked");
      idb.rows.delete(id);
    },
  }),
}));

const api = vi.hoisted(() => ({ forgetCodeChat: vi.fn(async () => ({ removed: true })) }));
vi.mock("../src/lib/api", () => api);

import { deleteConversation, isDeletedConversation, listConversations, loadConversation, renameConversation, saveConversation } from "../src/lib/chat-store";

let seq = 0;
const chat = (title: string): Conversation => ({ id: `c${++seq}`, title, messages: [{ id: `m${seq}`, role: "user", content: title, timestamp: 1 }], createdAt: 1, updatedAt: seq, source: "editor" });

beforeEach(() => {
  idb.rows.clear();
  idb.failDelete = false;
  idb.deleteGate = null;
  api.forgetCodeChat.mockClear();
});

describe("chat-store delete", () => {
  it("removes the chat, and saving or renaming it again doesn't bring it back", async () => {
    const open = chat("Lets build a website.");
    const other = chat("Add a contact form");
    await saveConversation(open);
    await saveConversation(other);
    await deleteConversation(open.id);
    expect(isDeletedConversation(open.id)).toBe(true);
    await saveConversation({ ...open, updatedAt: 99 });
    await renameConversation(open.id, "Renamed");
    expect(await loadConversation(open.id)).toBeUndefined();
    expect((await listConversations()).map((c) => c.id)).toEqual([other.id]);
    // The Code chat's mirror for the phone goes with it.
    await vi.waitFor(() => expect(api.forgetCodeChat).toHaveBeenCalledWith(open.id));
    // Other chats save as before.
    await saveConversation({ ...other, title: "Add a contact form, v2" });
    expect((await loadConversation(other.id))?.title).toBe("Add a contact form, v2");
  });

  it("a save racing the delete doesn't recreate it", async () => {
    const open = chat("Racing");
    await saveConversation(open);
    let release!: () => void;
    idb.deleteGate = new Promise((r) => (release = r));
    const deleting = deleteConversation(open.id);
    const saving = saveConversation({ ...open, updatedAt: 100 });
    release();
    await Promise.all([deleting, saving]);
    expect(await loadConversation(open.id)).toBeUndefined();
  });

  it("a failed delete rejects and the chat keeps saving", async () => {
    const open = chat("Stays");
    await saveConversation(open);
    idb.failDelete = true;
    await expect(deleteConversation(open.id)).rejects.toThrow("locked");
    expect(isDeletedConversation(open.id)).toBe(false);
    expect(api.forgetCodeChat).not.toHaveBeenCalled();
    await saveConversation({ ...open, title: "Stays, edited" });
    expect((await loadConversation(open.id))?.title).toBe("Stays, edited");
  });
});
