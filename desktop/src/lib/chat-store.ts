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

export async function saveConversation(convo: Conversation): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, convo);
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
  const db = await getDb();
  await db.delete(STORE_NAME, id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
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
