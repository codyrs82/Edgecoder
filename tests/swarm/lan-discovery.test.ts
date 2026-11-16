import { describe, expect, it } from "vitest";
import { decodePacket, EDGECODER_SERVICE, encodeQuery, encodeResponse, MDNS_GROUP, MDNS_PORT, TYPE_PTR, TYPE_SRV, TYPE_TXT, type MdnsRecord } from "../../src/swarm/lan-mdns.js";
import { checkLanProof, EchoLimiter, isLanAddress, LanDiscovery, LanIdentity, lanProof, lanProofWindow, LAN_ID_ROTATE_MS, type LanSocket, type LanSocketFactory } from "../../src/swarm/lan-discovery.js";

/** An in-memory LAN: sockets deliver to each other by (address, port); multicast to every mDNS socket. */
class FakeLan {
  private readonly sockets: Array<{ address: string; kind: "mdns" | "echo"; port: number; cb?: (m: Buffer, from: { address: string; port: number }) => void }> = [];
  private nextPort = 40000;
  sent: Array<{ from: string; to: string; port: number; buf: Buffer }> = [];
  dropEchoTo = new Set<string>();
  factory(address: string): LanSocketFactory {
    return async (kind) => {
      const entry: (typeof this.sockets)[number] = { address, kind, port: kind === "mdns" ? MDNS_PORT : this.nextPort++ };
      this.sockets.push(entry);
      const sock: LanSocket = {
        send: (buf, port, to) => {
          this.sent.push({ from: address, to, port, buf });
          const targets = to === MDNS_GROUP ? this.sockets.filter((s) => s.kind === "mdns") : this.sockets.filter((s) => s.address === to && s.port === port);
          for (const t of targets) {
            if (t.kind === "echo" && this.dropEchoTo.has(t.address)) continue;
            queueMicrotask(() => t.cb?.(buf, { address, port: entry.port }));
          }
        },
        onMessage: (cb) => (entry.cb = cb),
        port: () => entry.port,
        close: () => this.sockets.splice(this.sockets.indexOf(entry), 1),
      };
      return sock;
    };
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("mDNS codec", () => {
  it("round-trips PTR, SRV and TXT records and a query", () => {
    const recs: MdnsRecord[] = [
      { name: EDGECODER_SERVICE, type: TYPE_PTR, ttl: 120, data: `0123456789abcdef.${EDGECODER_SERVICE}` },
      { name: `0123456789abcdef.${EDGECODER_SERVICE}`, type: TYPE_SRV, ttl: 120, data: { priority: 0, weight: 0, port: 5555, target: "0123456789abcdef.local" } },
      { name: `0123456789abcdef.${EDGECODER_SERVICE}`, type: TYPE_TXT, ttl: 120, data: { v: "1", id: "0123456789abcdef", p: "aaaaaaaaaaaaaaaa", w: "42", e: "40001" } },
    ];
    const pkt = decodePacket(encodeResponse(recs))!;
    expect(pkt.response).toBe(true);
    expect(pkt.records).toEqual(recs);
    const q = decodePacket(encodeQuery([{ name: EDGECODER_SERVICE, type: TYPE_PTR }]))!;
    expect(q.response).toBe(false);
    expect(q.questions).toEqual([{ name: EDGECODER_SERVICE, type: TYPE_PTR }]);
  });

  it("reads compressed names and rejects malformed or looping packets without throwing", () => {
    // A response whose answer name is a pointer back to the question name.
    const name = Buffer.from([10, ..."_edgecoder".split("").map((c) => c.charCodeAt(0)), 4, ..."_tcp".split("").map((c) => c.charCodeAt(0)), 5, ..."local".split("").map((c) => c.charCodeAt(0)), 0]);
    const head = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
    const q = Buffer.concat([name, Buffer.from([0, 12, 0, 1])]);
    const target = Buffer.from([4, ...Buffer.from("abcd"), 0xc0, 12]);
    const ans = Buffer.concat([Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 60, 0, target.length]), target]);
    const pkt = decodePacket(Buffer.concat([head, q, ans]))!;
    expect(pkt.records[0]).toMatchObject({ name: EDGECODER_SERVICE, type: TYPE_PTR, data: `abcd.${EDGECODER_SERVICE}` });
    // A pointer to itself, a truncated record, garbage: null.
    const loop = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 1, 0, 0])]);
    expect(decodePacket(loop)).toBeNull();
    expect(decodePacket(encodeResponse([{ name: EDGECODER_SERVICE, type: TYPE_PTR, ttl: 1, data: "x.local" }]).subarray(0, 30))).toBeNull();
    expect(decodePacket(Buffer.from("not a dns packet at all"))).toBeNull();
    expect(decodePacket(Buffer.alloc(4))).toBeNull();
  });
});

describe("rotating LAN id and proofs", () => {
  it("rotates every 15 minutes, keeps the previous id for one rotation, and never reuses one", () => {
    const id = new LanIdentity({ nowMs: 0 });
    const first = id.current().id;
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(id.tick(LAN_ID_ROTATE_MS - 1)).toBe(false);
    expect(id.tick(LAN_ID_ROTATE_MS)).toBe(true);
    const second = id.current().id;
    expect(second).not.toBe(first);
    expect(id.ids()).toEqual([second, first]);
    expect(id.keyFor(first)).not.toBeNull();
    id.tick(2 * LAN_ID_ROTATE_MS);
    expect(id.ids()).not.toContain(first);
    expect(id.keyFor(first)).toBeNull();
    // What the coordinator is told: ids and keys, nothing else.
    expect(Object.keys(id.registration()[0]).sort()).toEqual(["id", "key"]);
  });

  it("a proof is valid for its window and the two before, under its own key only", () => {
    const id = new LanIdentity({ nowMs: 0 });
    const now = 10 * 60_000;
    const { id: lanId, key } = id.current();
    const w = lanProofWindow(now);
    const p = lanProof(key, lanId, w);
    expect(checkLanProof(key, lanId, p, w, now)).toBe(true);
    expect(checkLanProof(key, lanId, lanProof(key, lanId, w - 2), w - 2, now)).toBe(true);
    expect(checkLanProof(key, lanId, lanProof(key, lanId, w - 3), w - 3, now)).toBe(false);
    expect(checkLanProof(key, lanId, lanProof(key, lanId, w + 1), w + 1, now)).toBe(false);
    expect(checkLanProof(Buffer.alloc(32, 7), lanId, p, w, now)).toBe(false);
    expect(checkLanProof(key, "ffffffffffffffff", p, w, now)).toBe(false);
  });

  it("only private and link-local addresses count as LAN", () => {
    expect(isLanAddress("192.168.1.20")).toBe(true);
    expect(isLanAddress("::ffff:10.0.0.4")).toBe(true);
    expect(isLanAddress("169.254.3.3")).toBe(true);
    expect(isLanAddress("8.8.8.8")).toBe(false);
    expect(isLanAddress("100.64.1.1")).toBe(false);
  });
});

describe("LAN discovery with fake sockets", () => {
  const clock = { t: Date.now() };
  async function pair(lan = new FakeLan(), directPort?: number) {
    const now = () => clock.t;
    const a = new LanDiscovery({ sockets: lan.factory("192.168.1.10"), timers: false, now });
    const b = new LanDiscovery({ sockets: lan.factory("192.168.1.11"), timers: false, now, ...(directPort ? { directPort: () => directPort } : {}) });
    expect(await a.start()).toBe(true);
    await tick();
    clock.t += 300; // b starts a moment later and asks who is here
    expect(await b.start()).toBe(true);
    await tick();
    return { lan, a, b };
  }

  it("announces only a rotating id, a proof, a window and ports: no agent id, account, host name or address", async () => {
    const { lan, b } = await pair();
    const announce = lan.sent.find((s) => s.from === "192.168.1.11" && s.to === MDNS_GROUP && decodePacket(s.buf)?.response)!;
    const pkt = decodePacket(announce.buf)!;
    const txt = pkt.records.find((r) => r.type === TYPE_TXT)!.data as Record<string, string>;
    expect(Object.keys(txt).sort()).toEqual(["e", "id", "p", "v", "w"]);
    expect(txt.id).toBe(b.identity.current().id);
    expect(announce.buf.toString("latin1")).not.toMatch(/192\.168|worker-|agent|@/);
    expect(announce.to).toBe("224.0.0.251");
  });

  it("each side hears the other (and not itself), measures the round trip, and reports no address", async () => {
    const { a, b } = await pair();
    expect(a.list().map((n) => n.id)).toEqual([b.identity.current().id]);
    expect(b.list().map((n) => n.id)).toEqual([a.identity.current().id]);
    expect(a.list()[0].address).toBe("192.168.1.11");
    let t = 0;
    (a as unknown as { hrNow: () => number }).hrNow = () => (t += 0.7);
    await a.measure();
    const report = a.report();
    expect(report).toHaveLength(1);
    expect(report[0]).toEqual({ id: b.identity.current().id, p: expect.stringMatching(/^[0-9a-f]{16}$/), w: expect.any(Number), rttMs: expect.any(Number) });
    expect(JSON.stringify(report)).not.toMatch(/192\.168/);
  });

  it("answers a query for the service, and a goodbye removes the neighbour", async () => {
    const lan = new FakeLan();
    const { a, b } = await pair(lan);
    const before = lan.sent.filter((s) => s.from === "192.168.1.11").length;
    clock.t += 300;
    a.query();
    await tick();
    expect(lan.sent.filter((s) => s.from === "192.168.1.11").length).toBeGreaterThan(before);
    b.stop();
    await tick();
    expect(a.list()).toEqual([]);
  });

  it("ignores announcements from public addresses, its own id, and malformed TXT", async () => {
    const lan = new FakeLan();
    const a = new LanDiscovery({ sockets: lan.factory("192.168.1.10"), timers: false });
    const evil = new LanDiscovery({ sockets: lan.factory("203.0.113.9"), timers: false });
    await a.start();
    await evil.start();
    await tick();
    expect(a.list()).toEqual([]);
    // A forged record claiming a's own id, from a LAN address.
    const forger = await lan.factory("192.168.1.66")("echo");
    const id = a.identity.current().id;
    forger.send(encodeResponse([{ name: `${id}.${EDGECODER_SERVICE}`, type: TYPE_TXT, ttl: 120, data: { v: "1", id, p: "0".repeat(16), w: "1", e: "1" } }]), MDNS_PORT, MDNS_GROUP);
    forger.send(encodeResponse([{ name: `bad.${EDGECODER_SERVICE}`, type: TYPE_TXT, ttl: 120, data: { v: "1", id: "nothex", p: "x", w: "y", e: "0" } }]), MDNS_PORT, MDNS_GROUP);
    await tick();
    expect(a.list()).toEqual([]);
  });

  it("advertises the direct port only when direct transfer is on, and lookup stays local", async () => {
    const { a, b } = await pair(new FakeLan(), 45678);
    expect(a.anyDirectNeighbour()).toBe(true);
    expect(b.anyDirectNeighbour()).toBe(false);
    expect(a.lookup(b.identity.current().id)).toEqual({ address: "192.168.1.11", port: 45678 });
    expect(b.lookup(a.identity.current().id)).toBeNull();
  });

  it("a ping that is not answered (or answered by someone else) measures nothing", async () => {
    const lan = new FakeLan();
    const { a, b } = await pair(lan);
    lan.dropEchoTo.add("192.168.1.11");
    expect(await a.ping({ id: b.identity.current().id, address: "192.168.1.11", echoPort: a.list()[0].echoPort }, 30)).toBeNull();
    await a.measure();
    expect(a.report()).toEqual([]);
  });

  it("the echo responder is rate limited per source and in all", () => {
    const l = new EchoLimiter(2, 3);
    expect([l.take("x", 0), l.take("x", 0), l.take("x", 0)]).toEqual([true, true, false]);
    expect(l.take("y", 0)).toBe(true);
    expect(l.take("z", 0)).toBe(false); // global bucket spent
    expect(l.take("x", 1_000)).toBe(true);
  });

  it("off: a socket that cannot be opened leaves discovery off, without throwing", async () => {
    const d = new LanDiscovery({ sockets: async () => { throw new Error("EADDRINUSE"); }, timers: false });
    expect(await d.start()).toBe(false);
    expect(d.isRunning).toBe(false);
    expect(d.report()).toEqual([]);
  });
});

describe("settings", () => {
  it("AGENT_LAN_DISCOVERY is on and AGENT_LAN_DIRECT off unless set", async () => {
    const { workerConfigSchema } = await import("../../src/config/worker.js");
    const d = workerConfigSchema.parse({});
    expect(d.AGENT_LAN_DISCOVERY).toBe(true);
    expect(d.AGENT_LAN_DIRECT).toBe(false);
    const set = workerConfigSchema.parse({ AGENT_LAN_DISCOVERY: "off", AGENT_LAN_DIRECT: "on" });
    expect(set.AGENT_LAN_DISCOVERY).toBe(false);
    expect(set.AGENT_LAN_DIRECT).toBe(true);
    expect(workerConfigSchema.parse({ AGENT_LAN_DIRECT: "1" }).AGENT_LAN_DIRECT).toBe(true);
  });

  it("coordinators issue direct tickets unless LAN_DIRECT_TICKETS is off", async () => {
    const { coordinatorConfigSchema } = await import("../../src/swarm/coordinator-config.js");
    expect(coordinatorConfigSchema.parse({}).LAN_DIRECT_TICKETS).toBe(true);
    expect(coordinatorConfigSchema.parse({ LAN_DIRECT_TICKETS: "off" }).LAN_DIRECT_TICKETS).toBe(false);
  });
});
