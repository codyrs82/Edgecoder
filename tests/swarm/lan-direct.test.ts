import { duplexPair, type Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateX25519KeyPair } from "../../src/security/envelope.js";
import {
  directCall, frame, inputDigest, LanDirectError, LanDirectHost, LAN_TICKET_TTL_MS, replyDigest, signTicket, TicketReplayCache, verifyTicket,
  type DirectSession, type LanTicket,
} from "../../src/swarm/lan-direct.js";
import { createLanDirectRequester } from "../../src/swarm/lan-direct-requester.js";

const NOW = 1_800_000_000_000;
const HOST = "agent-host";
const lanId = "00112233aabbccdd";
const lanKey = randomBytes(32);
const hostEnvelope = generateX25519KeyPair();
const request = { messages: [{ role: "user", content: "secret prompt: write fizzbuzz" }] };

function ticketFor(requesterPub: Buffer, over: Partial<LanTicket> = {}, nowMs = NOW): LanTicket {
  return {
    ...signTicket(
      { taskId: "inf-1", subtaskId: "sub-1", hostLanId: lanId, hostAgentId: HOST, requesterAgentId: "agent-req", requesterPub: requesterPub.toString("base64"), hostPub: hostEnvelope.publicKey.toString("base64"), model: "qwen2.5-coder:7b", maxTokens: 512, timeoutMs: 60_000, inputSha256: inputDigest(request) },
      lanKey,
      nowMs
    ),
    ...over,
  };
}

const verify = (t: unknown, opts: { nowMs?: number; self?: string; replay?: TicketReplayCache; key?: Buffer | null } = {}) =>
  verifyTicket(t, { selfAgentId: opts.self ?? HOST, keyFor: (id) => (id === lanId ? (opts.key === undefined ? lanKey : opts.key) : null), nowMs: opts.nowMs ?? NOW, replay: opts.replay ?? new TicketReplayCache() });

describe("direct-transfer tickets", () => {
  it("a fresh ticket for this host verifies once", () => {
    const req = generateX25519KeyPair();
    const replay = new TicketReplayCache();
    const t = ticketFor(req.publicKey);
    expect(verify(t, { replay })).toEqual({ ok: true, ticket: t });
    expect(verify(t, { replay })).toEqual({ ok: false, reason: "replayed" });
  });

  it("refused when expired, for another host, under another key, or changed in any field", () => {
    const req = generateX25519KeyPair();
    const t = ticketFor(req.publicKey);
    expect(verify(t, { nowMs: NOW + LAN_TICKET_TTL_MS + 1 })).toEqual({ ok: false, reason: "expired" });
    expect(verify(t, { self: "agent-other" })).toEqual({ ok: false, reason: "wrong_host" });
    expect(verify({ ...t, hostLanId: "ffffffffffffffff" })).toEqual({ ok: false, reason: "wrong_host" });
    expect(verify(t, { key: randomBytes(32) })).toEqual({ ok: false, reason: "bad_mac" });
    expect(verify({ ...t, maxTokens: 32_000 })).toEqual({ ok: false, reason: "bad_mac" });
    expect(verify({ ...t, exp: t.exp + 60_000 })).toEqual({ ok: false, reason: "bad_mac" });
    expect(verify({ ...t, requesterPub: generateX25519KeyPair().publicKey.toString("base64") })).toEqual({ ok: false, reason: "bad_mac" });
    expect(verify({ ...t, mac: undefined })).toEqual({ ok: false, reason: "malformed" });
    expect(verify("not a ticket")).toEqual({ ok: false, reason: "malformed" });
  });

  it("a replayed ticket stays refused until it expires, an invalid one is not recorded as used", () => {
    const req = generateX25519KeyPair();
    const replay = new TicketReplayCache();
    const t = ticketFor(req.publicKey);
    expect(verify({ ...t, model: "x" }, { replay }).ok).toBe(false);
    expect(verify(t, { replay }).ok).toBe(true);
    expect(verify(t, { replay, nowMs: NOW + 5_000 })).toEqual({ ok: false, reason: "replayed" });
  });

  it("the input digest ignores key order and absent fields", () => {
    expect(inputDigest({ messages: [{ content: "a", role: "user" }] })).toBe(inputDigest({ messages: [{ role: "user", content: "a", tool_name: undefined }], tools: [] }));
    expect(inputDigest({ messages: [{ role: "user", content: "a" }] })).not.toBe(inputDigest({ messages: [{ role: "user", content: "b" }] }));
  });
});

/** A host wired to a socket pair; returns the requester's end. */
function hostWith(onSession: (s: DirectSession) => void, opts: { remote?: string; now?: () => number } = {}) {
  const host = new LanDirectHost({ selfAgentId: HOST, keyFor: (id) => (id === lanId ? lanKey : null), envelopePrivateKey: () => hostEnvelope.privateKey, onSession, now: opts.now ?? (() => NOW), helloTimeoutMs: 200 });
  const connect = () => {
    const [a, b] = duplexPair();
    // As TCP does: the host closing its end closes the requester's.
    b.on("close", () => a.destroy());
    host.handle(b as unknown as Duplex, opts.remote ?? "192.168.1.20");
    return { sock: a, wire: tap(a) };
  };
  return { host, connect };
}

/** Everything the requester's end receives. */
function tap(sock: Duplex): Buffer[] {
  const seen: Buffer[] = [];
  sock.on("data", (c: Buffer) => seen.push(c));
  return seen;
}

/** A host that streams the request's words back and finishes. */
const echoHost = (s: DirectSession) => {
  const words = String((s.request.messages[0] as { content: string }).content).split(" ");
  words.forEach((w, i) => s.send({ t: "chunk", seq: i, delta: `${w} ` }));
  s.send({ t: "done", promptTokens: 7, outputTokens: words.length });
};

async function collect(it: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe("direct transfer end to end (fake sockets)", () => {
  it("streams the reply encrypted: nothing on the wire after the hello is readable", async () => {
    const req = generateX25519KeyPair();
    const sessions: DirectSession[] = [];
    const { connect } = hostWith((s) => {
      sessions.push(s);
      echoHost(s);
    });
    let wire: Buffer[] = [];
    const pieces = await collect(directCall({ connect: () => { const c = connect(); wire = c.wire; return c.sock; }, ticket: ticketFor(req.publicKey), requesterPrivateKey: req.privateKey, request }));
    expect(pieces).toEqual([
      { t: "chunk", seq: 0, delta: "secret " }, { t: "chunk", seq: 1, delta: "prompt: " }, { t: "chunk", seq: 2, delta: "write " }, { t: "chunk", seq: 3, delta: "fizzbuzz " },
      { t: "done", promptTokens: 7, outputTokens: 4 },
    ]);
    expect(sessions[0].request).toEqual(request);
    expect(sessions[0].remoteAddress).toBe("192.168.1.20");
    const bytes = Buffer.concat(wire).toString("latin1");
    expect(bytes).not.toContain("fizzbuzz");
    expect(bytes).not.toContain("secret");
  });

  it("no ticket, a bad ticket, or silence: the connection is closed at once with no answer", async () => {
    const req = generateX25519KeyPair();
    let sessions = 0;
    const { host, connect } = hostWith(() => sessions++);
    for (const hello of [{ t: "hello" }, { t: "hello", ticket: { ...ticketFor(req.publicKey), hostAgentId: "x" } }, { t: "GET / HTTP/1.1" }]) {
      const { sock, wire } = connect();
      const closed = new Promise((r) => sock.on("close", r));
      sock.write(frame(Buffer.from(JSON.stringify(hello))));
      await closed;
      expect(Buffer.concat(wire).length).toBe(0);
    }
    const { sock } = connect();
    await new Promise((r) => sock.on("close", r)); // hello timeout
    expect(sessions).toBe(0);
    expect(host.stats.badTicket).toBe(2);
  });

  it("a ticket works once: a second connection with it is refused", async () => {
    const req = generateX25519KeyPair();
    const { connect } = hostWith(echoHost);
    const t = ticketFor(req.publicKey);
    await collect(directCall({ connect: () => connect().sock, ticket: t, requesterPrivateKey: req.privateKey, request }));
    await expect(collect(directCall({ connect: () => connect().sock, ticket: t, requesterPrivateKey: req.privateKey, request, connectMs: 200 }))).rejects.toMatchObject({ phase: "connect" });
  });

  it("refuses a request that is not the one the coordinator queued", async () => {
    const req = generateX25519KeyPair();
    let sessions = 0;
    const { connect } = hostWith(() => sessions++);
    const err = await collect(directCall({ connect: () => connect().sock, ticket: ticketFor(req.publicKey), requesterPrivateKey: req.privateKey, request: { messages: [{ role: "user", content: "something bigger" }] } })).catch((e) => e);
    expect(err).toBeInstanceOf(LanDirectError);
    expect(err).toMatchObject({ reason: "input_mismatch", phase: "connect" });
    expect(sessions).toBe(0);
  });

  it("only LAN sources, and a cap on connections per source", () => {
    const { host, connect } = hostWith(() => undefined, { remote: "8.8.8.8" });
    const { sock } = connect();
    expect(sock.destroyed || host.stats.refused === 1).toBe(true);
    const local = hostWith(() => undefined);
    local.connect();
    local.connect();
    local.connect();
    expect(local.host.stats.refused).toBe(1);
  });

  it("someone without the ticket's key cannot read or write the session", async () => {
    const req = generateX25519KeyPair();
    const mallory = generateX25519KeyPair();
    const { connect } = hostWith(echoHost);
    // Mallory replays the requester's ticket with her own key: the host derives keys with the
    // ticket's requester key, so her frames do not open and she gets nothing.
    await expect(collect(directCall({ connect: () => connect().sock, ticket: ticketFor(req.publicKey), requesterPrivateKey: mallory.privateKey, request, connectMs: 200 }))).rejects.toMatchObject({ phase: "connect" });
  });

  it("falls back within the connect deadline when the host never answers", async () => {
    const req = generateX25519KeyPair();
    const [a] = duplexPair();
    const started = Date.now();
    await expect(collect(directCall({ connect: () => a as unknown as Duplex, ticket: ticketFor(req.publicKey), requesterPrivateKey: req.privateKey, request, connectMs: 500 }))).rejects.toMatchObject({ phase: "connect", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a host that dies mid-stream: phase stream, with what arrived", async () => {
    const req = generateX25519KeyPair();
    const { connect } = hostWith((s) => {
      s.send({ t: "chunk", seq: 0, delta: "partial " });
      setTimeout(() => s.close(), 5);
    });
    const got: unknown[] = [];
    const err = await (async () => {
      for await (const p of directCall({ connect: () => connect().sock, ticket: ticketFor(req.publicKey), requesterPrivateKey: req.privateKey, request })) got.push(p);
    })().catch((e) => e);
    expect(got).toEqual([{ t: "chunk", seq: 0, delta: "partial " }]);
    expect(err).toMatchObject({ phase: "stream", receivedSeq: 1 });
  });
});

describe("requester side in the local forwarder", () => {
  function requester(over: Partial<Parameters<typeof createLanDirectRequester>[0]> = {}) {
    const { connect } = hostWith(echoHost);
    return createLanDirectRequester({
      selfAgentId: "agent-req",
      enabled: () => true,
      anyDirectNeighbour: () => true,
      lookup: (id) => (id === lanId ? { address: "192.168.1.20", port: 4444 } : null),
      connect: () => connect().sock,
      ...over,
    });
  }

  it("adds a per-call key to the submit only when direct transfer is on and a neighbour offers it", () => {
    const body = { taskId: "inf-1", model: "m" };
    expect(requester().rewriteSubmit(body)).toMatchObject({ lanDirect: { pub: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/) } });
    expect(requester({ enabled: () => false }).rewriteSubmit(body)).toEqual(body);
    expect(requester({ anyDirectNeighbour: () => false }).rewriteSubmit(body)).toEqual(body);
  });

  it("runs the call with the key it made and writes NDJSON with the reply digest", async () => {
    const r = requester();
    const sub = r.rewriteSubmit({ taskId: "inf-1" }) as { lanDirect: { pub: string } };
    // The coordinator's ticket names the key the submit carried.
    const lines: Array<Record<string, unknown>> = [];
    await r.run({ ticket: ticketFor(Buffer.from(sub.lanDirect.pub, "base64")), request }, (o) => lines.push(o as Record<string, unknown>));
    const text = "secret prompt: write fizzbuzz ";
    expect(lines.at(-1)).toMatchObject({ t: "done", replySha256: replyDigest(text), replyBytes: Buffer.byteLength(text) });
    expect(lines.filter((l) => l.t === "chunk").map((l) => l.delta).join("")).toBe(text);
    expect(r.pendingKeys()).toBe(0);
  });

  it("falls back (connect phase) without a key, for a host it never heard, or a ticket for someone else", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const r = requester({ lookup: () => null });
    const sub = r.rewriteSubmit({ taskId: "inf-1" }) as { lanDirect: { pub: string } };
    await r.run({ ticket: ticketFor(Buffer.from(sub.lanDirect.pub, "base64")), request }, (o) => lines.push(o as Record<string, unknown>));
    await requester().run({ ticket: ticketFor(generateX25519KeyPair().publicKey), request }, (o) => lines.push(o as Record<string, unknown>));
    const r3 = requester();
    const sub3 = r3.rewriteSubmit({ taskId: "inf-1" }) as { lanDirect: { pub: string } };
    await r3.run({ ticket: { ...ticketFor(Buffer.from(sub3.lanDirect.pub, "base64")), requesterAgentId: "agent-else" }, request }, (o) => lines.push(o as Record<string, unknown>));
    expect(lines.map((l) => [l.t, l.phase, l.reason])).toEqual([["fallback", "connect", "host_not_seen"], ["fallback", "connect", "no_key"], ["fallback", "connect", "no_key"]]);
  });
});
