import { openDB, type IDBPDatabase } from "idb";
import type { ChatMessage, Conversation } from "./types";

// ---------------------------------------------------------------------------
// IndexedDB persistence
// ---------------------------------------------------------------------------

const DB_NAME = "edgecoder-chat";
const DB_VERSION = 1;
const STORE_NAME = "conversations";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Chats deleted in this session. A chat that is still open somewhere (the Code view's panel, the
 * Chat view) saves itself again on its next change, on New chat and on unmount; without this, a
 * deleted open chat came straight back in the sidebar. Saves of these ids are dropped.
 */
const deletedIds = new Set<string>();

/** The chat was deleted (this session): saving it again would bring it back. */
export function isDeletedConversation(id: string): boolean {
  return deletedIds.has(id);
}

export async function saveConversation(convo: Conversation): Promise<void> {
  const db = await getDb();
  if (deletedIds.has(convo.id)) return;
  // Strip Svelte 5 reactive proxies — IndexedDB's structured clone can't handle them
  const plain = JSON.parse(JSON.stringify(convo));
  await db.put(STORE_NAME, plain);
}

export async function loadConversation(id: string): Promise<Conversation | undefined> {
  const db = await getDb();
  return db.get(STORE_NAME, id);
}

export async function listConversations(): Promise<Conversation[]> {
  const db = await getDb();
  const all = await db.getAll(STORE_NAME);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteConversation(id: string): Promise<void> {
  // Marked first, so a save already on its way (an open chat's autosave) can't recreate it.
  deletedIds.add(id);
  let convo: Conversation | undefined;
  try {
    const db = await getDb();
    convo = (await db.get(STORE_NAME, id)) as Conversation | undefined;
    await db.delete(STORE_NAME, id);
  } catch (err) {
    // Still there: it keeps saving like any other chat.
    deletedIds.delete(id);
    throw err;
  }
  // A Code view chat's mirror for your phone (code-chat-mirror.ts) goes with it.
  if (convo?.source === "editor") void import("./api").then((api) => api.forgetCodeChat(id)).catch(() => {});
}

export async function renameConversation(id: string, newTitle: string): Promise<void> {
  const convo = await loadConversation(id);
  if (convo) {
    convo.title = newTitle;
    convo.updatedAt = Date.now();
    await saveConversation(convo);
    // The phone shows the new title too (a Code view chat's mirror, code-chat-mirror.ts).
    if (convo.source === "editor" && convo.projectRoot && convo.messages.length) {
      const { projectRoot } = convo;
      void import("./api").then((api) => api.syncCodeChat({ chatId: id, projectRoot, title: newTitle, messages: [] })).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createConversation(source: "chat" | "editor" = "chat"): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source,
  };
}

export async function listConversationsBySource(source: "chat" | "editor"): Promise<Conversation[]> {
  const all = await listConversations();
  return all.filter((c) => (c.source ?? "chat") === source);
}

export function addMessage(
  convo: Conversation,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
  };
  convo.messages.push(msg);
  convo.updatedAt = Date.now();

  // Auto-title from first user message
  if (convo.messages.length === 1 && role === "user") {
    convo.title = content.slice(0, 60) + (content.length > 60 ? "..." : "");
  }

  return msg;
}
