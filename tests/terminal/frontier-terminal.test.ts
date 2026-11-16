import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { SessionHub, type ClientRef } from "../../src/apps/ide/sessions.js";
import { ProviderClient } from "../../src/terminal/client.js";
import { initialModel, parseCodeArgs } from "../../src/terminal/cli.js";
import { formatKeysList } from "../../src/terminal/keys.js";
import { frontierServed } from "../../src/inference-api/frontier.js";
import { makeStyle } from "../../src/terminal/render.js";
import { Repl, placeModel, withPlacement, type ReplIO } from "../../src/terminal/repl.js";
import { sessionServer, until } from "../helpers/sessions.js";

const root = mkdtempSync(join(tmpdir(), "frontier-term-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const LEAD = "frontier/anthropic/claude-opus-5-5";

describe("edgecoder code: --lead and --worker", () => {
  it("parses them; the lead wins over --model; a frontier worker is refused", () => {
    expect(parseCodeArgs(["--lead", LEAD, "--worker", "auto"])).toMatchObject({ lead: LEAD, worker: "auto" });
    expect(initialModel({ lead: LEAD, model: "auto" })).toBe(LEAD);
    expect(parseCodeArgs(["--worker", LEAD])).toEqual({ error: expect.stringContaining("--worker can't be a frontier model") });
    expect(withPlacement(LEAD, "auto")).toBe(LEAD);
    expect(placeModel(LEAD, "network")).toBe("network/qwen3-coder:30b");
  });
});

describe("REPL: /lead, /worker and /cost on a frontier lead", () => {
  it("switches the lead and worker and shows spend on your key in USD", async () => {
    const hub = new SessionHub(
      {
        chat: (_s, emit) => async (_req, onDelta) => {
          onDelta?.("Planned it.");
          emit({ type: "usage", cSats: 0, usd: 0.42, where: "Claude Opus 5.5 · your key", model: LEAD, served: frontierServed("Anthropic", { promptTokens: 24_800, outputTokens: 312, usd: 0.42 }) });
          return { content: "Planned it.", toolCalls: [] };
        },
        systemPrompt: async () => () => "",
        executor: () => ({ execute: async () => ({}) }),
        checkpoints: new CheckpointStore(),
      },
      { dir: null },
    );
    const { app, url } = await sessionServer(hub);
    const me: ClientRef = { clientId: "term-f", kind: "terminal", label: "Terminal" };
    const client = new ProviderClient(url, "unused", me);
    const snap = await client.createSession({ projectRoot: root, model: LEAD, workerModel: "auto" });
    let out = "";
    const queued: string[] = [];
    const waiters: Array<(l: string | null) => void> = [];
    const io: ReplIO = {
      readLine: () => (queued.length ? Promise.resolve(queued.shift()!) : new Promise((r) => waiters.push(r))),
      write: (t) => void (out += t),
    };
    const feed = (l: string) => {
      const w = waiters.shift();
      if (w) w(l);
      else queued.push(l);
    };
    const done = new Repl({ client, sessionId: snap.session.id, io, style: makeStyle(false), providerLabel: "test" }).run();
    await until(() => out.includes("Claude Opus 5.5 · your key (lead) · worker auto"), 5000, "header");
    feed("plan the refactor");
    await until(() => out.includes("Anthropic · claude-opus-5-5 · your key · read 24.8k tok · wrote 312 tok · $0.42"), 5000, "turn footer");
    for (const c of ["/cost", "/lead", "/worker network/qwen3-coder:30b", "/worker frontier/anthropic/claude-haiku-5-5", "/lead auto"]) feed(c);
    await until(() => out.includes("▸ lead: auto"), 5000, "commands");
    expect(out).toContain("On your own frontier key: $0.42 (estimated; billed by the provider, not in cSats).");
    expect(out).toContain(`lead: Claude Opus 5.5 · your key (${LEAD})`);
    expect(out).toContain("▸ worker: network/qwen3-coder:30b");
    expect(out).toContain("not a frontier one");
    expect(hub.snapshot(snap.session.id).session).toMatchObject({ workerModel: "network/qwen3-coder:30b", frontierUsd: 0.42, compute: { target: "auto" } });
    feed("/exit");
    expect(await done).toBe(0);
    await app.close();
  });
});

describe("edgecoder keys list", () => {
  it("shows usable and other-account keys, settings, spend and the account rule, never a key", () => {
    const text = formatKeysList(
      {
        account: "acct-alice",
        storage: "macOS keychain",
        fallbackFile: false,
        providers: [
          { id: "anthropic", kind: "anthropic", accountId: "acct-alice", storage: "keychain", usable: true },
          { id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", accountId: "acct-bob", storage: "keychain", usable: false, reason: "Belongs to another account" },
        ],
        models: [LEAD],
        settings: { defaultLead: LEAD, workerModel: "auto", sessionCapUsd: 5, dailyCapUsd: null, useForAuto: false, effort: "high" },
        spend: { today: 0.42, last30Days: 3.1 },
      },
      makeStyle(false),
    );
    expect(text).toContain("● anthropic  usable");
    expect(text).toContain("○ openai https://api.openai.com/v1  Belongs to another account (acct-bob)");
    expect(text).toContain("Claude Opus 5.5 · your key");
    expect(text).toContain("$5.00 per session, no daily cap");
    expect(text).toContain("$0.42 today");
    expect(text).toContain("usable only by your account. Never for other people's requests or network work.");
  });
});
