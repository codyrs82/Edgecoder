// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * LAN discovery between EdgeCoder agents of any account (docs/security/lan-proximity.md).
 *
 * Every agent with AGENT_LAN_DISCOVERY on (the default) announces itself on the local network
 * with mDNS / DNS-SD (`_edgecoder._tcp.local`, multicast 224.0.0.251:5353, TTL 1: link-local
 * only). The announcement carries no account, no agent id and no host name, only:
 *
 *   id  a random LAN id (16 hex), replaced every LAN_ID_ROTATE_MS (15 min)
 *   p   proof: HMAC-SHA256(lanKey, id + minute window), 16 hex. lanKey is a random key that
 *       rotates with the id and that only this agent and its coordinator know (the agent sends it
 *       over its signed heartbeat). The coordinator maps id -> agent, and a fresh proof shows a
 *       neighbour saw this agent within the last few minutes (it cannot be made up from an old one).
 *   w   that minute window
 *   e   the UDP port of the echo responder (below)
 *   d   only with AGENT_LAN_DIRECT on: the TCP port of the direct-transfer listener (lan-direct.ts)
 *
 * Round trip: each agent pings the neighbours it heard (UDP, `ECP1 PING <nonce>`, three tries,
 * the fastest counted); the responder answers only `ECP1 PONG <its LAN id> <nonce>`, at most
 * ECHO_RATE_PER_SOURCE per second per sender and ECHO_RATE_GLOBAL in all. It reveals nothing the
 * announcement did not.
 *
 * Each agent then tells its coordinator, in its signed heartbeat, "I see LAN id X (proof p, window
 * w) at N ms" for up to LAN_REPORT_MAX neighbours. The neighbours' addresses never leave this
 * computer: they are kept only to ping them and, with direct transfer on, to connect to them.
 *
 * The sockets are behind a small interface (LanSocket) so tests drive it with fakes.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";
import { isPrivateIPv4 } from "./lan-proximity.js";
import { decodePacket, EDGECODER_SERVICE, encodeQuery, encodeResponse, MDNS_GROUP, MDNS_PORT, TYPE_PTR, TYPE_SRV, TYPE_TXT, type MdnsRecord } from "./lan-mdns.js";

export const LAN_ID_ROTATE_MS = 15 * 60_000;
export const LAN_PROOF_WINDOW_MS = 60_000;
/** A proof is accepted for its window and the two before it (a neighbour re-announces every 30 s). */
export const LAN_PROOF_WINDOWS_ACCEPTED = 3;
export const LAN_ANNOUNCE_MS = 30_000;
export const LAN_MEASURE_MS = 60_000;
export const LAN_NEIGHBOUR_TTL_MS = 3 * 60_000;
export const LAN_ECHO_TIMEOUT_MS = 500;
export const LAN_MAX_NEIGHBOURS = 32;
export const LAN_REPORT_MAX = 16;
export const ECHO_RATE_PER_SOURCE = 5;
export const ECHO_RATE_GLOBAL = 50;
/** mDNS record TTL we announce with (seconds). */
const RECORD_TTL_S = 120;

const LAN_ID_RE = /^[0-9a-f]{16}$/;
const PROOF_RE = /^[0-9a-f]{16}$/;

export function isLanId(s: unknown): s is string {
  return typeof s === "string" && LAN_ID_RE.test(s);
}

export function lanProofWindow(nowMs: number): number {
  return Math.floor(nowMs / LAN_PROOF_WINDOW_MS);
}

/** HMAC-SHA256(key, "edgecoder-lan-proof\n<id>\n<window>"), first 16 hex. */
export function lanProof(key: Buffer, lanId: string, window: number): string {
  return createHmac("sha256", key).update(`edgecoder-lan-proof\n${lanId}\n${window}`).digest("hex").slice(0, 16);
}

/** `p` is `lanId`'s proof for `window` under `key`, and `window` is recent at `nowMs`. */
export function checkLanProof(key: Buffer, lanId: string, p: string, window: number, nowMs: number): boolean {
  const now = lanProofWindow(nowMs);
  if (!Number.isInteger(window) || window > now || window <= now - LAN_PROOF_WINDOWS_ACCEPTED) return false;
  if (!PROOF_RE.test(p)) return false;
  return timingSafeEqual(Buffer.from(lanProof(key, lanId, window)), Buffer.from(p));
}

/** A private (RFC 1918) or link-local IPv4 address: where a LAN neighbour can be. */
export function isLanAddress(ip: string): boolean {
  const s = ip.replace(/^::ffff:/i, "");
  return isIPv4(s) && (isPrivateIPv4(s) || s.startsWith("169.254."));
}

// ── Rotating identity ──

export interface LanIdKey {
  id: string;
  key: Buffer;
  createdAtMs: number;
}

/** The agent's rotating LAN id and key (the previous pair is kept for one rotation, so late reports still resolve). */
export class LanIdentity {
  private cur: LanIdKey;
  private prev: LanIdKey | null = null;
  constructor(private readonly opts: { rotateMs?: number; random?: (n: number) => Buffer; nowMs?: number } = {}) {
    this.cur = this.fresh(opts.nowMs ?? Date.now());
  }
  private fresh(nowMs: number): LanIdKey {
    const rnd = this.opts.random ?? randomBytes;
    return { id: rnd(8).toString("hex"), key: rnd(32), createdAtMs: nowMs };
  }
  /** The current pair, rotated when it is older than rotateMs. Returns whether it rotated. */
  tick(nowMs: number): boolean {
    if (nowMs - this.cur.createdAtMs < (this.opts.rotateMs ?? LAN_ID_ROTATE_MS)) return false;
    this.prev = this.cur;
    this.cur = this.fresh(nowMs);
    return true;
  }
  current(): LanIdKey {
    return this.cur;
  }
  /** The key of one of this agent's ids (current or previous), else null. */
  keyFor(id: string): Buffer | null {
    if (id === this.cur.id) return this.cur.key;
    return this.prev && id === this.prev.id ? this.prev.key : null;
  }
  /** The ids this agent answers to (current, then previous). */
  ids(): string[] {
    return this.prev ? [this.cur.id, this.prev.id] : [this.cur.id];
  }
  proof(nowMs: number): { id: string; p: string; w: number } {
    const w = lanProofWindow(nowMs);
    return { id: this.cur.id, p: lanProof(this.cur.key, this.cur.id, w), w };
  }
  /** What the coordinator is told (signed heartbeat): each id with its key, base64. */
  registration(): Array<{ id: string; key: string }> {
    return [this.cur, ...(this.prev ? [this.prev] : [])].map((k) => ({ id: k.id, key: k.key.toString("base64") }));
  }
}

// ── Sockets ──

export interface LanSocket {
  send(buf: Buffer, port: number, address: string): void;
  onMessage(cb: (msg: Buffer, from: { address: string; port: number }) => void): void;
  /** The bound local port. */
  port(): number;
  close(): void;
}

/** Opens the mDNS socket (bound to 5353, joined to 224.0.0.251, multicast TTL 1) and the echo socket (an ephemeral UDP port). */
export type LanSocketFactory = (kind: "mdns" | "echo") => Promise<LanSocket>;

export const dgramSocketFactory: LanSocketFactory = async (kind) => {
  const dgram = await import("node:dgram");
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: kind === "mdns" });
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(kind === "mdns" ? MDNS_PORT : 0, () => {
      sock.off("error", reject);
      resolve();
    });
  });
  sock.on("error", () => undefined);
  if (kind === "mdns") {
    sock.addMembership(MDNS_GROUP);
    // Link-local only: a multicast hop limit of 1 never leaves the local network.
    sock.setMulticastTTL(1);
    sock.setMulticastLoopback(true);
  } else {
    sock.setTTL(64);
  }
  return {
    send: (buf, port, address) => sock.send(buf, port, address, () => undefined),
    onMessage: (cb) => sock.on("message", (msg, rinfo) => cb(msg, { address: rinfo.address, port: rinfo.port })),
    port: () => sock.address().port,
    close: () => {
      try {
        sock.close();
      } catch {
        // already closed
      }
    },
  };
};

// ── Rate limiting ──

/** Per-key and global token buckets (refilled per second). */
export class EchoLimiter {
  private readonly perKey = new Map<string, { tokens: number; atMs: number }>();
  private global = { tokens: 0, atMs: 0 };
  constructor(private readonly perSecond = ECHO_RATE_PER_SOURCE, private readonly globalPerSecond = ECHO_RATE_GLOBAL) {
    this.global.tokens = globalPerSecond;
  }
  take(key: string, nowMs: number): boolean {
    const refill = (b: { tokens: number; atMs: number }, rate: number) => {
      b.tokens = Math.min(rate, b.tokens + ((nowMs - b.atMs) / 1000) * rate);
      b.atMs = nowMs;
    };
    refill(this.global, this.globalPerSecond);
    const b = this.perKey.get(key) ?? { tokens: this.perSecond, atMs: nowMs };
    refill(b, this.perSecond);
    if (this.perKey.size > 1024) this.perKey.clear();
    this.perKey.set(key, b);
    if (b.tokens < 1 || this.global.tokens < 1) return false;
    b.tokens--;
    this.global.tokens--;
    return true;
  }
}

// ── Discovery ──

export interface LanNeighbour {
  id: string;
  p: string;
  w: number;
  /** Local only: never reported to anyone. */
  address: string;
  echoPort: number;
  /** TCP port of its direct-transfer listener when it has direct transfer on. */
  directPort: number | null;
  seenAtMs: number;
  rttMs: number | null;
  rttAtMs: number;
}

/** What goes to the coordinator: no address. */
export interface LanNeighbourReport {
  id: string;
  p: string;
  w: number;
  rttMs: number;
}

export interface LanDiscoveryOptions {
  identity?: LanIdentity;
  sockets?: LanSocketFactory;
  /** TCP port of this agent's direct listener (AGENT_LAN_DIRECT on), announced as `d`. */
  directPort?: () => number | null;
  now?: () => number;
  /** High-resolution clock for round trips (ms). */
  hrNow?: () => number;
  log?: (msg: string) => void;
  /** Timers off in tests (drive announce() / measure() by hand). */
  timers?: boolean;
}

const ECHO_PREFIX = "ECP1 ";
const QUERY_ANSWER_GAP_MS = 200;

export class LanDiscovery {
  readonly identity: LanIdentity;
  private mdns: LanSocket | null = null;
  private echo: LanSocket | null = null;
  private readonly neighbours = new Map<string, LanNeighbour>();
  private readonly pending = new Map<string, (from: { address: string; id: string }) => void>();
  private readonly limiter = new EchoLimiter();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private lastQueryAnswerMs = 0;
  private running = false;
  private readonly now: () => number;
  private readonly hrNow: () => number;

  constructor(private readonly opts: LanDiscoveryOptions = {}) {
    this.identity = opts.identity ?? new LanIdentity();
    this.now = opts.now ?? Date.now;
    this.hrNow = opts.hrNow ?? (() => performance.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Bind both sockets, announce, ask who else is here. False (and stays off) when a socket cannot be opened. */
  async start(): Promise<boolean> {
    if (this.running) return true;
    const open = this.opts.sockets ?? dgramSocketFactory;
    try {
      this.echo = await open("echo");
      this.mdns = await open("mdns");
    } catch (err) {
      this.opts.log?.(`LAN discovery off: ${(err as Error).message}`);
      this.echo?.close();
      this.echo = null;
      return false;
    }
    this.echo.onMessage((msg, from) => this.onEcho(msg, from));
    this.mdns.onMessage((msg, from) => this.onMdns(msg, from));
    this.running = true;
    this.announce();
    this.query();
    if (this.opts.timers !== false) {
      this.timers.push(setInterval(() => this.announce(), LAN_ANNOUNCE_MS));
      this.timers.push(setInterval(() => void this.measure(), LAN_MEASURE_MS));
      for (const t of this.timers) t.unref?.();
      setTimeout(() => void this.measure(), 3_000).unref?.();
    }
    return true;
  }

  /** Say goodbye (TTL 0) and close the sockets. */
  stop(): void {
    if (!this.running) return;
    try {
      this.mdns?.send(encodeResponse(this.records(0)), MDNS_PORT, MDNS_GROUP);
    } catch {
      // best effort
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.mdns?.close();
    this.echo?.close();
    this.mdns = this.echo = null;
    this.running = false;
    this.neighbours.clear();
  }

  private instance(id = this.identity.current().id): string {
    return `${id}.${EDGECODER_SERVICE}`;
  }

  /** The PTR, SRV and TXT records for this agent (ttl 0: goodbye). */
  records(ttl = RECORD_TTL_S): MdnsRecord[] {
    const nowMs = this.now();
    const { id, p, w } = this.identity.proof(nowMs);
    const direct = this.opts.directPort?.() ?? null;
    const txt: Record<string, string> = { v: "1", id, p, w: String(w), e: String(this.echo?.port() ?? 0) };
    if (direct) txt.d = String(direct);
    const inst = this.instance(id);
    return [
      { name: EDGECODER_SERVICE, type: TYPE_PTR, ttl, data: inst },
      { name: inst, type: TYPE_SRV, ttl, data: { priority: 0, weight: 0, port: direct ?? 0, target: `${id}.local` } },
      { name: inst, type: TYPE_TXT, ttl, data: txt },
    ];
  }

  /** Multicast this agent's records (rotating the id first when due). */
  announce(): void {
    if (!this.mdns) return;
    const nowMs = this.now();
    this.identity.tick(nowMs);
    this.mdns.send(encodeResponse(this.records()), MDNS_PORT, MDNS_GROUP);
  }

  query(): void {
    this.mdns?.send(encodeQuery([{ name: EDGECODER_SERVICE, type: TYPE_PTR }]), MDNS_PORT, MDNS_GROUP);
  }

  private onMdns(msg: Buffer, from: { address: string; port: number }): void {
    const pkt = decodePacket(msg);
    if (!pkt) return;
    const nowMs = this.now();
    if (!pkt.response) {
      // Someone asks for EdgeCoder agents: answer (at most every QUERY_ANSWER_GAP_MS; our own query loops back too).
      if (pkt.questions.some((q) => q.name === EDGECODER_SERVICE && (q.type === TYPE_PTR || q.type === 255)) && nowMs - this.lastQueryAnswerMs >= QUERY_ANSWER_GAP_MS) {
        this.lastQueryAnswerMs = nowMs;
        this.announce();
      }
      return;
    }
    if (!isLanAddress(from.address)) return;
    const address = from.address.replace(/^::ffff:/i, "");
    const own = new Set(this.identity.ids());
    for (const rec of pkt.records) {
      if (rec.type !== TYPE_TXT || !rec.name.endsWith(`.${EDGECODER_SERVICE}`)) continue;
      const txt = rec.data as Record<string, string>;
      if (txt.v !== "1" || !isLanId(txt.id) || rec.name !== `${txt.id}.${EDGECODER_SERVICE}` || own.has(txt.id)) continue;
      if (rec.ttl === 0) {
        this.neighbours.delete(txt.id);
        continue;
      }
      const w = Number(txt.w);
      const echoPort = Number(txt.e);
      const directPort = txt.d !== undefined ? Number(txt.d) : null;
      if (!PROOF_RE.test(txt.p ?? "") || !Number.isInteger(w) || !validPort(echoPort) || (directPort !== null && !validPort(directPort))) continue;
      const prev = this.neighbours.get(txt.id);
      if (!prev && this.neighbours.size >= LAN_MAX_NEIGHBOURS) this.pruneOldest();
      this.neighbours.set(txt.id, {
        id: txt.id, p: txt.p, w, address, echoPort, directPort, seenAtMs: nowMs,
        // A neighbour that moved address is measured again.
        rttMs: prev && prev.address === address ? prev.rttMs : null,
        rttAtMs: prev && prev.address === address ? prev.rttAtMs : 0,
      });
    }
  }

  private pruneOldest(): void {
    let oldest: LanNeighbour | undefined;
    for (const n of this.neighbours.values()) if (!oldest || n.seenAtMs < oldest.seenAtMs) oldest = n;
    if (oldest) this.neighbours.delete(oldest.id);
  }

  private onEcho(msg: Buffer, from: { address: string; port: number }): void {
    if (msg.length > 96 || !isLanAddress(from.address)) return;
    const text = msg.toString("utf8");
    if (!text.startsWith(ECHO_PREFIX)) return;
    const [, verb, a, b] = text.split(" ");
    if (verb === "PING" && /^[0-9a-f]{16}$/.test(a ?? "") && b === undefined) {
      if (!this.limiter.take(from.address, this.now())) return;
      this.echo?.send(Buffer.from(`${ECHO_PREFIX}PONG ${this.identity.current().id} ${a}`), from.port, from.address);
    } else if (verb === "PONG" && isLanId(a) && /^[0-9a-f]{16}$/.test(b ?? "")) {
      this.pending.get(b)?.({ address: from.address.replace(/^::ffff:/i, ""), id: a });
    }
  }

  /** One echo round trip to `n`, or null (no answer within LAN_ECHO_TIMEOUT_MS, or someone else answered). */
  ping(n: Pick<LanNeighbour, "id" | "address" | "echoPort">, timeoutMs = LAN_ECHO_TIMEOUT_MS): Promise<number | null> {
    const sock = this.echo;
    if (!sock) return Promise.resolve(null);
    const nonce = randomBytes(8).toString("hex");
    const started = this.hrNow();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(nonce, (from) => {
        clearTimeout(timer);
        this.pending.delete(nonce);
        resolve(from.address === n.address && from.id === n.id ? Math.max(0, Math.round((this.hrNow() - started) * 10) / 10) : null);
      });
      sock.send(Buffer.from(`${ECHO_PREFIX}PING ${nonce}`), n.echoPort, n.address);
    });
  }

  /** Measure every fresh neighbour: three pings each, the fastest counted. */
  async measure(): Promise<void> {
    const nowMs = this.now();
    for (const n of [...this.neighbours.values()]) {
      if (nowMs - n.seenAtMs > LAN_NEIGHBOUR_TTL_MS) {
        this.neighbours.delete(n.id);
        continue;
      }
      let best: number | null = null;
      for (let i = 0; i < 3; i++) {
        const ms = await this.ping(n);
        if (ms !== null) best = best === null ? ms : Math.min(best, ms);
      }
      if (best !== null) {
        n.rttMs = best;
        n.rttAtMs = this.now();
      }
    }
  }

  /** Neighbours heard recently, nearest first (with their addresses: local use only). */
  list(nowMs = this.now()): LanNeighbour[] {
    return [...this.neighbours.values()]
      .filter((n) => nowMs - n.seenAtMs <= LAN_NEIGHBOUR_TTL_MS)
      .sort((a, b) => (a.rttMs ?? Infinity) - (b.rttMs ?? Infinity) || a.id.localeCompare(b.id));
  }

  /** For the heartbeat: measured neighbours, no addresses, at most LAN_REPORT_MAX. */
  report(nowMs = this.now()): LanNeighbourReport[] {
    return this.list(nowMs)
      .filter((n) => n.rttMs !== null && nowMs - n.rttAtMs <= LAN_NEIGHBOUR_TTL_MS)
      .slice(0, LAN_REPORT_MAX)
      .map((n) => ({ id: n.id, p: n.p, w: n.w, rttMs: n.rttMs as number }));
  }

  /** Where to reach a neighbour's direct listener (this computer only), or null. */
  lookup(lanId: string, nowMs = this.now()): { address: string; port: number } | null {
    const n = this.neighbours.get(lanId);
    if (!n || nowMs - n.seenAtMs > LAN_NEIGHBOUR_TTL_MS || !n.directPort) return null;
    return { address: n.address, port: n.directPort };
  }

  /** Whether any neighbour advertises direct transfer (worth asking the coordinator for a ticket). */
  anyDirectNeighbour(nowMs = this.now()): boolean {
    return this.list(nowMs).some((n) => n.directPort !== null);
  }
}

function validPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n < 65536;
}
