import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ChatFn } from "../../src/apps/ide/agent-loop.js";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { FrontierAccess, autoWithFrontier, frontierChat } from "../../src/apps/ide/frontier-access.js";
import { SessionHub, compactionModelOf, modelIdOf, parseModelId, workerModelOf, type ClientRef, type SessionData } from "../../src/apps/ide/sessions.js";
import { FrontierKeyStore, type Keychain } from "../../src/inference-api/frontier-keys.js";
import { FrontierSpend } from "../../src/inference-api/frontier-usage.js";
import { ChatBackendError, type ChatBackend } from "../../src/inference-api/types.js";

const tmp = mkdtempSync(join(tmpdir(), "frontier-access-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const KEY = "sk-ant-api03-FAKEKEY-abcdefghijklmnopqrstuvwxyz0123456789";

function memKeychain(): Keychain {
  const m = new Map<string, string>();
  return { name: "test keychain", set: async (a, s) => void m.set(a, s), get: async (a) => m.get(a) ?? null, remove: async (a) => void m.delete(a) };
}

function setup(account: { id: string | null }) {
  const dir = mkdtempSync(join(tmp, "a-"));
  const store = new FrontierKeyStore({ file: join(dir, "frontier.json"), keychain: memKeychain() });
  const spend = new FrontierSpend(join(dir, "usage.json"));
  const access = new FrontierAccess({ store, spend, account: async () => account.id, target: { baseDelayMs: 1, maxRetries: 1 } });
  return { dir, store, spend, access };
}

describe("frontier models: listed and usable only for the key owner's account", () => {
  it("lists frontier models only when the signed-in account has a key for the provider", async () => {
    const acct = { id: "acct-alice" as string | null };
    const { access } = setup(acct);
    expect(await access.modelIds()).toEqual([]);
    await access.add({ id: "anthropic", key: KEY, skipTest: true });
    expect(await access.modelIds()).toEqual(expect.arrayContaining(["frontier/anthropic/claude-opus-5-5", "frontier/anthropic/claude-sonnet-5-5"]));
    acct.id = "acct-bob";
    expect(await access.modelIds()).toEqual([]);
    acct.id = null;
    expect(await access.modelIds()).toEqual([]);
  });

  it("refuses other accounts, signed-out machines, and missing keys", async () => {
    const acct = { id: "acct-alice" as string | null };
    const { access } = setup(acct);
    await access.add({ id: "anthropic", key: KEY, skipTest: true });
    const id = "frontier/anthropic/claude-opus-5-5";
    expect(await access.resolve(id, { sessionKey: "s" })).toMatchObject({ ok: true, label: "Claude Opus 5.5 · your key" });
    // A remote requester from another account, or a session owned by another account.
    expect(await access.resolve(id, { sessionKey: "s", requester: "acct-bob" })).toMatchObject({ ok: false, reason: "other_account", message: "Frontier lead is limited to acct-alice's own requests." });
    expect(await access.resolve(id, { sessionKey: "s", owner: "acct-bob" })).toMatchObject({ ok: false, reason: "other_account" });
    expect(await access.resolve("frontier/openai/gpt-5", { sessionKey: "s" })).toMatchObject({ ok: false, reason: "no_key" });
    // The machine's account changed: alice's key is listed, removable, not usable.
    acct.id = "acct-bob";
    expect(await access.resolve(id, { sessionKey: "s" })).toMatchObject({ ok: false, reason: "other_account" });
    const st = await access.status();
    expect(st.providers[0]).toMatchObject({ id: "anthropic", accountId: "acct-alice", usable: false });
    expect(JSON.stringify(st)).not.toContain("FAKEKEY");
    acct.id = null;
    expect(await access.resolve(id, { sessionKey: "s" })).toMatchObject({ ok: false, reason: "not_signed_in" });
    await expect(access.add({ id: "anthropic", key: KEY, skipTest: true })).rejects.toThrow(/Sign in/);
    acct.id = "acct-bob";
    expect(await access.remove("anthropic", "acct-alice")).toBe(true);
  });

  it("says whether a missing account is signed out or just not known yet (Settings shows 'sign in' only for the first)", async () => {
    const acct = { id: "acct-alice" as string | null };
    let state: "signed_in" | "signed_out" | "unknown" = "signed_in";
    const dir = mkdtempSync(join(tmp, "s-"));
    const access = new FrontierAccess({
      store: new FrontierKeyStore({ file: join(dir, "frontier.json"), keychain: memKeychain() }),
      spend: new FrontierSpend(join(dir, "usage.json")),
      account: async () => acct.id,
      accountState: () => state,
    });
    expect(await access.status()).toMatchObject({ account: "acct-alice", accountState: "signed_in" });
    acct.id = null;
    state = "unknown";
    expect(await access.status()).toMatchObject({ account: null, accountState: "unknown" });
    state = "signed_out";
    expect(await access.status()).toMatchObject({ account: null, accountState: "signed_out" });
    // Without a state hook (older wiring), a null account reads as signed out.
    const { access: plain } = setup({ id: null });
    expect(await plain.status()).toMatchObject({ account: null, accountState: "signed_out" });
  });

  it("re-checks the account on every call: a key stops working when the account signs out mid-session", async () => {
    const acct = { id: "acct-alice" as string | null };
    const { access } = setup(acct);
    await access.add({ id: "anthropic", key: KEY, skipTest: true, baseUrl: "http://127.0.0.1:9" });
    const r = await access.resolve("frontier/anthropic/claude-opus-5-5", { sessionKey: "s" });
    if (!r.ok) throw new Error("expected ok");
    acct.id = "acct-bob";
    const run = async () => {
      for await (const _ of r.backend({ messages: [{ role: "user", content: "hi" }] })) void _;
    };
    await expect(run()).rejects.toThrow(/No anthropic key for your account/);
  });
});

describe("spend caps", () => {
  it("warns once at 80% and stops at 100% of the session cap", () => {
    const { spend } = setup({ id: "a" });
    const caps = { sessionCapUsd: 1, dailyCapUsd: 10 };
    expect(spend.check("session:1", caps).state).toBe("ok");
    spend.record("session:1", "anthropic/claude-opus-5-5", 0.85, { inputTokens: 1, outputTokens: 1 });
    const w = spend.check("session:1", caps);
    expect(w.state).toBe("warn");
    expect(w.message).toMatch(/\$0\.85 of its \$1\.00/);
    expect(spend.check("session:1", caps).state).toBe("ok"); // warned once
    spend.record("session:1", "anthropic/claude-opus-5-5", 0.2, { inputTokens: 1, outputTokens: 1 });
    expect(spend.check("session:1", caps)).toMatchObject({ state: "stop", sessionUsd: 1.05 });
    // Another session still has room in the day.
    expect(spend.check("session:2", caps).state).toBe("ok");
  });

  it("stops every session at the daily cap; null means no cap", () => {
    const { spend } = setup({ id: "a" });
    spend.record("session:1", "m", 3, { inputTokens: 0, outputTokens: 0 });
    spend.record("session:2", "m", 2, { inputTokens: 0, outputTokens: 0 });
    expect(spend.check("session:3", { sessionCapUsd: null, dailyCapUsd: 5 })).toMatchObject({ state: "stop", dayUsd: 5 });
    expect(spend.check("session:3", { sessionCapUsd: null, dailyCapUsd: null }).state).toBe("ok");
    expect(spend.summary().today).toBe(5);
  });

  it("refuses the call before anything is sent once a cap is reached", async () => {
    const { access, spend, store } = setup({ id: "acct-alice" });
    await access.add({ id: "anthropic", key: KEY, skipTest: true, baseUrl: "http://127.0.0.1:9" });
    store.updateSettings({ sessionCapUsd: 0.5 });
    spend.record("session:x", "anthropic/claude-opus-5-5", 0.5, { inputTokens: 0, outputTokens: 0 });
    const r = await access.resolve("frontier/anthropic/claude-opus-5-5", { sessionKey: "session:x" });
    if (!r.ok) throw new Error("expected ok");
    const err = await (async () => {
      for await (const _ of r.backend({ messages: [{ role: "user", content: "hi" }] })) void _;
    })().catch((e) => e as ChatBackendError);
    expect(err).toBeInstanceOf(ChatBackendError);
    expect((err as ChatBackendError).status).toBe(402);
    expect((err as Error).message).toMatch(/reached its cap/);
  });
});

describe("Auto with the frontier key", () => {
  const fake = (text: string): ChatBackend =>
    async function* () {
      yield { delta: text };
      yield { done: true };
    };
  const hard = { messages: [{ role: "user" as const, content: "Refactor the whole auth module across these files, fix the race condition in the token refresh, migrate the database schema and add tests.\n```ts\n" + "x\n".repeat(400) + "```" }], hints: { complexity: "very_high" } };

  it("stays on Auto unless the user turned it on, and then only for high-complexity jobs", async () => {
    const { access, store } = setup({ id: "acct-alice" });
    await access.add({ id: "anthropic", key: KEY, skipTest: true, baseUrl: "http://127.0.0.1:9" });
    const picked: string[] = [];
    const backend = autoWithFrontier({ auto: fake("auto"), access, request: () => ({ sessionKey: "s" }), onPick: (l) => picked.push(l) });
    const first = async (req: Parameters<ChatBackend>[0]) => {
      for await (const p of backend(req)) return p;
    };
    expect(await first(hard)).toEqual({ delta: "auto" }); // default off
    store.updateSettings({ useForAuto: true });
    expect(await first({ messages: [{ role: "user", content: "hi" }] })).toEqual({ delta: "auto" });
    // High complexity: the frontier lead is tried (the fake base URL refuses the connection).
    await expect(first(hard)).rejects.toThrow(/Couldn't reach Anthropic/);
    expect(picked).toEqual(["Claude Opus 5.5 · your key"]);
  }, 60_000);
});

describe("sessions: lead and worker", () => {
  const me: ClientRef = { clientId: "term-1", kind: "terminal" };

  it("keeps the lead as frontier/<provider>/<model> and the worker separately (never a frontier worker)", () => {
    expect(parseModelId("frontier/anthropic/claude-opus-5-5")).toEqual({ model: "claude-opus-5-5", compute: { target: "frontier", provider: "anthropic" } });
    expect(modelIdOf(parseModelId("frontier/openrouter/openai/gpt-5"))).toBe("frontier/openrouter/openai/gpt-5");
    const dir = mkdtempSync(join(tmp, "s-"));
    const hub = new SessionHub({ chat: () => async () => ({ content: "", toolCalls: [] }), systemPrompt: async () => () => "", executor: () => ({ execute: async () => ({}) }), checkpoints: new CheckpointStore(join(dir, "cp")) }, { dir });
    const s = hub.create({ projectRoot: dir, model: "frontier/anthropic/claude-opus-5-5", workerModel: "network/qwen3-coder:30b", client: me, ownerAccount: "acct-alice" });
    expect(s).toMatchObject({ model: "claude-opus-5-5", compute: { target: "frontier", provider: "anthropic" }, workerModel: "network/qwen3-coder:30b", ownerAccount: "acct-alice" });
    expect(hub.list()[0]).toMatchObject({ model: "frontier/anthropic/claude-opus-5-5", workerModel: "network/qwen3-coder:30b", frontierUsd: 0 });
    expect(() => hub.update(s.id, { workerModel: "frontier/anthropic/claude-haiku-5-5" }, me)).toThrow(/not a frontier one/);
    const u = hub.update(s.id, { leadModel: "auto", workerModel: "auto" }, me);
    expect(modelIdOf(u)).toBe("auto");
    expect(workerModelOf(u)).toBe("auto");
    expect(workerModelOf({ workerModel: "frontier/anthropic/x" })).toBe("auto");
  });

  it("runs the lead on the frontier key for the owner, and falls back to the worker for another account's message", async () => {
    const dir = mkdtempSync(join(tmp, "s2-"));
    const acct = { id: "acct-alice" as string | null };
    const { access } = setup(acct);
    await access.add({ id: "anthropic", key: KEY, skipTest: true, baseUrl: "http://127.0.0.1:9" });
    const calls: Array<{ role: string; model: string; client: string | undefined }> = [];
    const worker: ChatFn = async (_req, onDelta) => {
      onDelta?.("worker reply");
      return { content: "worker reply", toolCalls: [] };
    };
    const hub = new SessionHub(
      {
        chat: (s: SessionData, emit, signal, ctx) => {
          const role = ctx?.role ?? "lead";
          const id = role === "worker" ? workerModelOf(s) : modelIdOf(s);
          calls.push({ role, model: id, client: ctx?.client?.accountId });
          if (!id.startsWith("frontier/")) return worker;
          return frontierChat({ access, id, request: { requester: ctx?.client?.accountId, owner: s.ownerAccount, sessionKey: `session:${s.id}` }, sendEvent: emit, signal, fallback: () => worker });
        },
        systemPrompt: async () => () => "",
        executor: () => ({ execute: async () => ({}) }),
        checkpoints: new CheckpointStore(join(dir, "cp")),
        owner: () => acct.id ?? undefined,
      },
      { dir },
    );
    const s = hub.create({ projectRoot: dir, model: "frontier/anthropic/claude-opus-5-5", client: me });
    expect(s.ownerAccount).toBe("acct-alice");
    // A client authenticated as another account (remote attach) sends a message.
    const bob: ClientRef = { clientId: "remote-bob", kind: "api", accountId: "acct-bob" };
    hub.takeControl(s.id, bob);
    hub.send(s.id, "please do it", bob);
    await hub.idle(s.id);
    const snap = hub.snapshot(s.id);
    const last = snap.session.transcript.at(-1)!;
    expect(last.content).toBe("worker reply");
    expect(last.events?.some((e) => e.type === "status" && e.message.includes("Frontier lead is limited to acct-alice's own requests."))).toBe(true);
    expect(calls[0]).toMatchObject({ role: "lead", model: "frontier/anthropic/claude-opus-5-5", client: "acct-bob" });
    // The session file keeps the model id, never the key.
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const saved = readFileSync(join(dir, files[0]), "utf8");
    expect(saved).toContain('"provider":"anthropic"');
    expect(saved).not.toContain("FAKEKEY");
  });

  it("gives each queued message its sender's account: another account's message never rides on the frontier lead", async () => {
    const dir = mkdtempSync(join(tmp, "s3-"));
    const { access } = setup({ id: "acct-alice" });
    await access.add({ id: "anthropic", key: KEY, skipTest: true, baseUrl: "http://127.0.0.1:9" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const turns: Array<{ ran: "lead" | "worker"; requester: string | undefined; text: string }> = [];
    const hub = new SessionHub(
      {
        chat: (s: SessionData, _emit, _signal, ctx) => async (req, onDelta) => {
          const last = String(req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
          const r = await access.resolve(modelIdOf(s), { requester: ctx?.client?.accountId, owner: s.ownerAccount, sessionKey: `session:${s.id}` });
          turns.push({ ran: r.ok ? "lead" : "worker", requester: ctx?.client?.accountId, text: last });
          if (turns.length === 1) await gate;
          onDelta?.("ok");
          return { content: "ok", toolCalls: [] };
        },
        systemPrompt: async () => () => "",
        executor: () => ({ execute: async () => ({}) }),
        checkpoints: new CheckpointStore(join(dir, "cp")),
        owner: () => "acct-alice",
      },
      { dir },
    );
    const s = hub.create({ projectRoot: dir, model: "frontier/anthropic/claude-opus-5-5", client: me });
    const bob: ClientRef = { clientId: "remote-bob", kind: "api", accountId: "acct-bob" };
    hub.send(s.id, "alice one", me);
    await new Promise((r) => setTimeout(r, 20));
    const queuedBob = hub.send(s.id, "bob one", bob);
    const queuedAlice = hub.send(s.id, "alice two", me);
    expect(queuedBob.queued).toMatchObject({ accountId: "acct-bob", clientId: "remote-bob" });
    expect(queuedAlice.queued?.accountId).toBeUndefined();
    release();
    for (let i = 0; i < 100 && turns.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    await hub.idle(s.id);
    // Three turns: bob's message was not batched with alice's, and only bob's ran on the worker.
    expect(turns).toEqual([
      { ran: "lead", requester: undefined, text: "alice one" },
      { ran: "worker", requester: "acct-bob", text: "bob one" },
      { ran: "lead", requester: undefined, text: "alice two" },
    ]);
  });

  it("runs compaction on the worker, never the frontier lead, unless the user opted in", () => {
    const s = { ...parseModelId("frontier/anthropic/claude-opus-5-5"), workerModel: "network/qwen3-coder:30b" };
    expect(compactionModelOf(s)).toEqual({ id: "network/qwen3-coder:30b", role: "worker" });
    expect(compactionModelOf({ ...s, workerModel: undefined })).toEqual({ id: "auto", role: "worker" });
    expect(compactionModelOf(s, true)).toEqual({ id: "frontier/anthropic/claude-opus-5-5", role: "lead" });
    expect(compactionModelOf({ ...parseModelId("auto"), workerModel: "auto" }, true)).toEqual({ id: "auto", role: "worker" });
  });
});
