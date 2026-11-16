import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/common/logger.js";
import { redactMeta, scrubText } from "../../src/common/redaction.js";

/*
 * Bring-your-own frontier key through the IDE provider, end to end on loopback: the account comes
 * from the hosted endpoint (a fake portal), Anthropic is a fake too. The key must never show up in
 * a response, an event, a session file or a log line.
 */
const TOKEN = "test-ide-token-frontier-0123456789";
const KEY = "sk-ant-api03-FAKEKEY-abcdefghijklmnopqrstuvwxyz0123456789";
const ECK = "eck_test_hosted_key_0123456789";
const tmp = mkdtempSync(join(tmpdir(), "prov-frontier-"));
const project = mkdtempSync(join(tmpdir(), "prov-frontier-proj-"));

const seen: Array<{ url: string; auth?: string; apiKey?: string; body: any }> = [];
const account = "acct-alice";
const fake: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined, body: raw ? JSON.parse(raw) : null });
    if (req.url === "/v1/account") {
      res.writeHead(req.headers.authorization === `Bearer ${ECK}` ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify({ accountId: account, cSats: 0 }));
      return;
    }
    if (req.headers["x-api-key"] !== KEY) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      return;
    }
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (o: Record<string, unknown>) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 2000, output_tokens: 1 } } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Claude" } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } });
    ev({ type: "message_stop" });
    res.end();
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

process.env.IDE_PROVIDER_TOKEN = TOKEN;
process.env.EDGECODER_SESSIONS_DIR = join(tmp, "sessions");
process.env.EDGECODER_TRUST_FILE = join(tmp, "trusted.json");
process.env.EDGECODER_FRONTIER_FILE = join(tmp, "frontier.json");
process.env.EDGECODER_FRONTIER_KEYCHAIN = "off";
process.env.EDGECODER_URL = FAKE;
process.env.EDGECODER_API_KEY = ECK;
delete process.env.SWARM_VIA_LOCAL_AGENT_URL;
delete process.env.IDE_PROVIDER_HOST;

const { ideProviderServer: app } = await import("../../src/apps/ide/provider-server.js");
const headers = { host: "127.0.0.1:4304", authorization: `Bearer ${TOKEN}` };
const who = { clientId: "term-f", kind: "terminal", label: "Terminal" };
const LEAD = "frontier/anthropic/claude-opus-5-5";
const responses: string[] = [];
async function call(method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  responses.push(res.body);
  return res;
}

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => fake.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("provider: frontier keys", () => {
  it("keeps the routes behind the IDE token", async () => {
    for (const [method, url] of [["GET", "/v1/ide/frontier"], ["POST", "/v1/ide/frontier/keys"], ["POST", "/v1/ide/frontier/settings"]] as const) {
      expect((await app.inject({ method, url, headers: { host: "127.0.0.1:4304" }, payload: method === "POST" ? {} : undefined })).statusCode).toBe(401);
    }
  });

  it("lists no frontier model until the signed-in account adds a key, then tests and stores it", async () => {
    const before = (await call("GET", "/v1/models")).json().data.map((m: { id: string }) => m.id);
    expect(before.some((id: string) => id.startsWith("frontier/"))).toBe(false);
    const bad = await call("POST", "/v1/ide/frontier/keys", { id: "anthropic", key: "sk-ant-api03-WRONGKEY-abcdefghijklmnopqrstuvwxyz", baseUrl: FAKE });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().message).toMatch(/rejected your API key/);
    const added = await call("POST", "/v1/ide/frontier/keys", { id: "anthropic", key: KEY, baseUrl: FAKE });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ provider: { id: "anthropic", accountId: "acct-alice", storage: "file", usable: true }, models: ["claude-opus-5-5"] });
    const after = (await call("GET", "/v1/models")).json().data.map((m: { id: string }) => m.id);
    expect(after).toContain(LEAD);
    const status = (await call("GET", "/v1/ide/frontier")).json();
    expect(status).toMatchObject({ account: "acct-alice", fallbackFile: true, settings: { sessionCapUsd: 5, useForAuto: false } });
  });

  it("runs a session's lead on the key and records spend in USD, not cSats", async () => {
    const created = await call("POST", "/v1/ide/sessions", { ...who, projectRoot: project, model: LEAD, workerModel: "auto" });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().session.id;
    expect(created.json().session).toMatchObject({ model: "claude-opus-5-5", compute: { target: "frontier", provider: "anthropic" }, workerModel: "auto", ownerAccount: "acct-alice" });
    expect((await call("POST", `/v1/ide/sessions/${id}/messages`, { ...who, text: `hi, my key is ${KEY}` })).statusCode).toBe(200);
    let snap: any;
    for (let i = 0; i < 100; i++) {
      snap = (await call("GET", `/v1/ide/sessions/${id}`)).json();
      if (!snap.running && snap.session.transcript.length >= 2) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const last = snap.session.transcript.at(-1);
    expect(last.content).toBe("Hello from Claude");
    // 2000 x $4/M + 100 x $20/M
    expect(last.usage).toMatchObject({ cSats: 0, usd: 0.01, where: "Claude Opus 5.5 · your key" });
    expect(last.usage.calls[0]).toMatchObject({ cSats: 0, usd: 0.01, model: LEAD, served: { computeClass: "frontier", hardware: "Anthropic · your key", promptTokens: 2000, outputTokens: 100, usd: 0.01 } });
    expect(snap.session).toMatchObject({ cSats: 0, frontierUsd: 0.01 });
    const toAnthropic = seen.filter((s) => s.url === "/v1/messages");
    expect(toAnthropic).toHaveLength(1);
    // The key went only to the provider, and the EdgeCoder key never went there.
    expect(toAnthropic[0].apiKey).toBe(KEY);
    expect(toAnthropic[0].auth).toBeUndefined();
    for (const s of seen.filter((x) => x.url === "/v1/account")) expect(JSON.stringify(s)).not.toContain("FAKEKEY");
    // Worker models can't be frontier ones.
    expect((await call("POST", `/v1/ide/sessions/${id}/settings`, { ...who, workerModel: LEAD })).statusCode).toBe(400);
  });

  it("serves the OpenAI-compatible endpoint on the key too", async () => {
    const res = await call("POST", "/v1/chat/completions", { model: LEAD, messages: [{ role: "user", content: "hi" }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().choices[0].message.content).toBe("Hello from Claude");
  });

  it("never leaks the key into responses, session files, events or logs", async () => {
    const files = readdirSync(join(tmp, "sessions")).map((f) => readFileSync(join(tmp, "sessions", f), "utf8"));
    expect(files.length).toBeGreaterThan(0);
    for (const text of [...files, ...responses, readFileSync(join(tmp, "frontier.json"), "utf8")]) expect(text).not.toContain("FAKEKEY");
    // The message that quoted the key was redacted on disk (the transcript kept the rest).
    expect(files.join("")).toContain("hi, my key is [redacted]");
    // Logs: secrets in fields and in messages are masked.
    const lines: string[] = [];
    const logger = createLogger("ide-provider", { destination: new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }) });
    logger.error({ err: new Error(`Anthropic said: bad key ${KEY}`), apiKey: KEY, headers: { "x-api-key": KEY }, note: `key=${KEY}` }, `failed with ${KEY}`);
    logger.info({ body: { key: "sk-proj-FAKEKEYabcdefghijklmnopqrstuvwxyz0123" } }, "openai key sk-proj-FAKEKEYabcdefghijklmnopqrstuvwxyz0123");
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l).not.toContain("FAKEKEY");
    expect(scrubText(`x ${KEY} y`)).toBe("x [redacted] y");
    expect(JSON.stringify(redactMeta({ message: `gsk_${"a".repeat(30)} and xai-${"b".repeat(30)}` }))).not.toMatch(/gsk_a|xai-b/);
    // Ordinary words survive.
    expect(scrubText("use sk-learn and task-ant-colony")).toBe("use sk-learn and task-ant-colony");
  });
});
