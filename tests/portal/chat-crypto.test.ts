import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHAT_UNREADABLE, ChatCipher, ChatDecryptError, messageAad, parseChatKey, titleAad } from "../../src/portal/chat-crypto.js";
import { PortalStore } from "../../src/portal/store.js";
// @ts-expect-error plain ESM script without type declarations
import * as backfillScript from "../../scripts/ops/encrypt-chat-backfill.mjs";

const bf = backfillScript as any;
const KEY = randomBytes(32);
const cipher = (key: Buffer | null = KEY, warnings: string[] = []) => new ChatCipher(key, (m) => void warnings.push(m));

function decryptError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ChatDecryptError);
    return (e as ChatDecryptError).reason;
  }
  throw new Error("expected a ChatDecryptError");
}

describe("ChatCipher", () => {
  it("round-trips, in the versioned enc:v1: form, with a fresh IV each time", () => {
    const c = cipher();
    const aad = messageAad("conv-1", "msg-1");
    const a = c.seal("hello, 世界", aad);
    const b = c.seal("hello, 世界", aad);
    expect(a).toMatch(/^enc:v1:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("hello");
    expect(c.open(a, aad)).toBe("hello, 世界");
    expect(c.open(c.seal("", aad), aad)).toBe("");
  });

  it("reads existing plaintext rows (no enc: prefix) unchanged", () => {
    expect(cipher().open("an old message", messageAad("c", "m"))).toBe("an old message");
    expect(cipher(null).open("an old message", messageAad("c", "m"))).toBe("an old message");
  });

  it("refuses a ciphertext moved to another row (AES-GCM additional data)", () => {
    const c = cipher();
    const sealed = c.seal("secret", messageAad("conv-1", "msg-1"));
    expect(decryptError(() => c.open(sealed, messageAad("conv-1", "msg-2")))).toBe("auth_failed");
    expect(decryptError(() => c.open(sealed, messageAad("conv-2", "msg-1")))).toBe("auth_failed");
    const title = c.seal("My plans", titleAad("conv-1"));
    expect(decryptError(() => c.open(title, titleAad("conv-2")))).toBe("auth_failed");
    // A title can't be passed off as a message of the same conversation either.
    expect(decryptError(() => c.open(title, messageAad("conv-1", "conv-1")))).toBe("auth_failed");
    expect(c.openOrPlaceholder(sealed, messageAad("conv-1", "msg-2"))).toBe(CHAT_UNREADABLE);
  });

  it("refuses tampering, a wrong key and malformed values", () => {
    const c = cipher();
    const aad = titleAad("c");
    const sealed = c.seal("x".repeat(40), aad);
    const raw = Buffer.from(sealed.slice("enc:v1:".length), "base64");
    raw[raw.length - 1] ^= 1;
    expect(decryptError(() => c.open("enc:v1:" + raw.toString("base64"), aad))).toBe("auth_failed");
    expect(decryptError(() => cipher(randomBytes(32)).open(sealed, aad))).toBe("auth_failed");
    expect(decryptError(() => c.open("enc:v1:AAAA", aad))).toBe("bad_format");
    expect(decryptError(() => c.open("enc:v9:AAAA", aad))).toBe("bad_format");
  });

  it("without a key: writes stay plaintext with one warning; sealed rows can't be read", () => {
    const warnings: string[] = [];
    const c = cipher(null, warnings);
    expect(c.enabled).toBe(false);
    expect(c.seal("hi", messageAad("c", "m"))).toBe("hi");
    expect(c.seal("again", messageAad("c", "m2"))).toBe("again");
    expect(warnings.filter((w) => w.includes("PORTAL_CHAT_KEY is not set"))).toHaveLength(1);
    const sealed = cipher().seal("hi", messageAad("c", "m"));
    expect(decryptError(() => c.open(sealed, messageAad("c", "m")))).toBe("no_key");
    expect(c.openOrPlaceholder(sealed, messageAad("c", "m"))).toBe(CHAT_UNREADABLE);
  });

  it("reads PORTAL_CHAT_KEY as hex or base64, warns on a malformed one, never prints it", () => {
    const hex = KEY.toString("hex");
    expect(parseChatKey(hex)?.equals(KEY)).toBe(true);
    expect(parseChatKey(KEY.toString("base64"))?.equals(KEY)).toBe(true);
    expect(parseChatKey("short")).toBeNull();
    expect(ChatCipher.fromEnv({ PORTAL_CHAT_KEY: hex }, () => undefined).enabled).toBe(true);
    const warnings: string[] = [];
    expect(ChatCipher.fromEnv({ PORTAL_CHAT_KEY: "nope" }, (m) => void warnings.push(m)).enabled).toBe(false);
    expect(warnings[0]).toMatch(/malformed/);
    expect(ChatCipher.fromEnv({}, () => undefined).enabled).toBe(false);
    expect(JSON.stringify({ c: ChatCipher.fromEnv({ PORTAL_CHAT_KEY: hex }) })).not.toContain(hex);
  });

  it("stays compatible with the backfill script's own seal() and AAD strings", () => {
    const c = cipher();
    expect(bf.messageAad("c1", "m1")).toBe(messageAad("c1", "m1"));
    expect(bf.titleAad("c1")).toBe(titleAad("c1"));
    expect(bf.parseKey(KEY.toString("hex")).equals(KEY)).toBe(true);
    expect(c.open(bf.seal(KEY, "from the script", messageAad("c1", "m1")), messageAad("c1", "m1"))).toBe("from the script");
    expect(c.open(bf.seal(KEY, "a title", titleAad("c1")), titleAad("c1"))).toBe("a title");
  });
});

/** A pool that keeps portal_conversations / portal_messages rows in memory. */
function chatPool() {
  const conversations: Record<string, any>[] = [];
  const messages: Record<string, any>[] = [];
  const texts: string[] = [];
  let shared: Record<string, any>[] = [];
  return {
    conversations,
    messages,
    texts,
    setShared(rows: Record<string, any>[]) {
      shared = rows;
    },
    async query(text: string, params: any[] = []) {
      texts.push(text);
      if (text.startsWith("INSERT INTO portal_conversations")) {
        const [conversation_id, user_id, title, created_at_ms, updated_at_ms] = params;
        conversations.push({ conversation_id, user_id, title, created_at_ms, updated_at_ms });
      } else if (text.startsWith("INSERT INTO portal_messages")) {
        const [message_id, conversation_id, role, content, tokens_used, credits_spent, created_at_ms] = params;
        messages.push({ message_id, conversation_id, role, content, tokens_used, credits_spent, created_at_ms, usage_meta: null });
      } else if (text.startsWith("UPDATE portal_conversations SET title")) {
        const c = conversations.find((r) => r.conversation_id === params[2]);
        if (c) c.title = params[0];
      } else if (text.includes("FROM portal_messages m")) {
        return { rows: shared };
      } else if (text.includes("FROM portal_conversations WHERE user_id")) {
        return { rows: conversations };
      } else if (text.includes("FROM portal_messages WHERE conversation_id")) {
        return { rows: messages.filter((m) => m.conversation_id === params[0]) };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

describe("PortalStore chat at rest", () => {
  it("stores content and titles sealed and returns them decrypted", async () => {
    const pool = chatPool();
    const store = new PortalStore(pool as never, cipher());
    await store.createConversation({ conversationId: "c1", userId: "u1", title: "Tax questions" });
    await store.addMessage({ messageId: "m1", conversationId: "c1", role: "user", content: "my SSN is …" });
    expect(pool.conversations[0].title).toMatch(/^enc:v1:/);
    expect(pool.messages[0].content).toMatch(/^enc:v1:/);
    expect(JSON.stringify(pool.messages)).not.toContain("SSN");
    expect((await store.listConversations("u1"))[0].title).toBe("Tax questions");
    expect((await store.getConversationMessages("c1", 10))[0].content).toBe("my SSN is …");
    await store.renameConversation("c1", "Renamed");
    expect(pool.conversations[0].title).toMatch(/^enc:v1:/);
    expect((await store.listConversations("u1"))[0].title).toBe("Renamed");
  });

  it("the default title is sealed too, and plaintext rows from before still read", async () => {
    const pool = chatPool();
    const store = new PortalStore(pool as never, cipher());
    await store.createConversation({ conversationId: "c1", userId: "u1" });
    expect(pool.conversations[0].title).toMatch(/^enc:v1:/);
    pool.conversations.push({ conversation_id: "old", user_id: "u1", title: "Old chat", created_at_ms: 1, updated_at_ms: 1 });
    pool.messages.push({ message_id: "old-m", conversation_id: "c1", role: "assistant", content: "old reply", tokens_used: 0, credits_spent: 0, created_at_ms: 1, usage_meta: null });
    expect((await store.listConversations("u1")).map((c) => c.title)).toEqual(["New chat", "Old chat"]);
    expect((await store.getConversationMessages("c1", 10))[0].content).toBe("old reply");
  });

  it("a ciphertext copied onto another row reads as unreadable, not as the other row's text", async () => {
    const pool = chatPool();
    const store = new PortalStore(pool as never, cipher(KEY, []));
    await store.addMessage({ messageId: "m1", conversationId: "c1", role: "user", content: "victim's text" });
    pool.messages.push({ ...pool.messages[0], message_id: "m2", conversation_id: "c2" });
    expect((await store.getConversationMessages("c2", 10))[0].content).toBe(CHAT_UNREADABLE);
  });

  it("without a key it behaves as before (plaintext)", async () => {
    const pool = chatPool();
    const store = new PortalStore(pool as never, cipher(null));
    await store.createConversation({ conversationId: "c1", userId: "u1", title: "t" });
    await store.addMessage({ messageId: "m1", conversationId: "c1", role: "user", content: "hi" });
    expect(pool.conversations[0].title).toBe("t");
    expect(pool.messages[0].content).toBe("hi");
    expect((await store.getConversationMessages("c1", 10))[0].content).toBe("hi");
  });

  it("migrate adds the opt-in column, default off", async () => {
    const pool = chatPool();
    await new PortalStore(pool as never, cipher(null)).migrate();
    expect(pool.texts.join("\n")).toContain("ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS share_chat_for_improvement BOOLEAN NOT NULL DEFAULT FALSE");
  });

  it("listSharedChatMessages filters on consent in SQL and returns decrypted text, leaving out unreadable rows", async () => {
    const pool = chatPool();
    const c = cipher(KEY, []);
    const store = new PortalStore(pool as never, c);
    pool.setShared([
      { user_id: "u1", conversation_id: "c1", message_id: "m1", role: "user", content: c.seal("shared text", messageAad("c1", "m1")), created_at_ms: 5 },
      { user_id: "u1", conversation_id: "c1", message_id: "m2", role: "assistant", content: "legacy plaintext", created_at_ms: 6 },
      { user_id: "u1", conversation_id: "c1", message_id: "m3", role: "user", content: c.seal("moved", messageAad("c9", "m9")), created_at_ms: 7 }
    ]);
    const page = await store.listSharedChatMessages({ limit: 3 });
    expect(page.messages.map((m) => m.content)).toEqual(["shared text", "legacy plaintext"]);
    expect(page.next).toEqual({ createdAtMs: 7, messageId: "m3" });
    const sql = pool.texts.find((t) => t.includes("FROM portal_messages m"))!;
    expect(sql).toMatch(/share_chat_for_improvement = TRUE/);
    expect((await store.listSharedChatMessages({ limit: 10 })).next).toBeNull();
  });
});
