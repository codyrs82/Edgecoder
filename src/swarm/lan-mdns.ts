// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * A minimal mDNS / DNS-SD codec (RFC 6762, RFC 6763) for EdgeCoder's LAN discovery
 * (src/swarm/lan-discovery.ts, docs/security/lan-proximity.md). Pure: no sockets.
 *
 * Only what the service needs: questions, and PTR / SRV / TXT / A answers. Names are written
 * without compression and read with it (other responders on the LAN compress). Every length and
 * pointer is checked, so a malformed packet from the LAN is rejected, never thrown on.
 */

export const MDNS_GROUP = "224.0.0.251";
export const MDNS_PORT = 5353;
/** The DNS-SD service type EdgeCoder agents announce. */
export const EDGECODER_SERVICE = "_edgecoder._tcp.local";

export const TYPE_A = 1;
export const TYPE_PTR = 12;
export const TYPE_TXT = 16;
export const TYPE_SRV = 33;
export const TYPE_ANY = 255;
const CLASS_IN = 1;
/** Cache-flush bit on unique records (SRV, TXT). */
const CACHE_FLUSH = 0x8000;

/** Anything bigger is not an mDNS packet we read. */
export const MDNS_MAX_PACKET = 9000;

export interface MdnsQuestion {
  name: string;
  type: number;
}

export type MdnsRecord =
  | { name: string; type: typeof TYPE_PTR; ttl: number; data: string }
  | { name: string; type: typeof TYPE_SRV; ttl: number; data: { priority: number; weight: number; port: number; target: string } }
  | { name: string; type: typeof TYPE_TXT; ttl: number; data: Record<string, string> }
  | { name: string; type: typeof TYPE_A; ttl: number; data: string }
  | { name: string; type: number; ttl: number; data: null };

export interface MdnsPacket {
  id: number;
  /** QR bit: a response. */
  response: boolean;
  questions: MdnsQuestion[];
  /** Answers, authority and additional records together. */
  records: MdnsRecord[];
}

// ── Encoding ──

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.replace(/\.$/, "").split(".")) {
    const b = Buffer.from(label, "utf8");
    if (b.length === 0 || b.length > 63) throw new Error(`bad dns label: ${label}`);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function encodeTxt(data: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(data)) {
    const s = Buffer.from(`${k}=${v}`, "utf8");
    if (s.length > 255) throw new Error("txt entry too long");
    parts.push(Buffer.from([s.length]), s);
  }
  return parts.length ? Buffer.concat(parts) : Buffer.from([0]);
}

function encodeRdata(r: MdnsRecord): Buffer {
  switch (r.type) {
    case TYPE_PTR:
      return encodeName(r.data as string);
    case TYPE_SRV: {
      const d = r.data as { priority: number; weight: number; port: number; target: string };
      return Buffer.concat([u16(d.priority), u16(d.weight), u16(d.port), encodeName(d.target)]);
    }
    case TYPE_TXT:
      return encodeTxt(r.data as Record<string, string>);
    case TYPE_A:
      return Buffer.from((r.data as string).split(".").map(Number));
    default:
      return Buffer.alloc(0);
  }
}

/** A query (QR=0) for `questions`. */
export function encodeQuery(questions: readonly MdnsQuestion[]): Buffer {
  const head = Buffer.concat([u16(0), u16(0), u16(questions.length), u16(0), u16(0), u16(0)]);
  return Buffer.concat([head, ...questions.map((q) => Buffer.concat([encodeName(q.name), u16(q.type), u16(CLASS_IN)]))]);
}

/** An authoritative response (QR=1, AA=1) carrying `answers`. */
export function encodeResponse(answers: readonly MdnsRecord[]): Buffer {
  const head = Buffer.concat([u16(0), u16(0x8400), u16(0), u16(answers.length), u16(0), u16(0)]);
  const body = answers.map((r) => {
    const rdata = encodeRdata(r);
    const unique = r.type === TYPE_SRV || r.type === TYPE_TXT || r.type === TYPE_A;
    return Buffer.concat([encodeName(r.name), u16(r.type), u16(CLASS_IN | (unique ? CACHE_FLUSH : 0)), u32(r.ttl), u16(rdata.length), rdata]);
  });
  return Buffer.concat([head, ...body]);
}

// ── Decoding ──

class Reader {
  constructor(readonly buf: Buffer) {}
  u8(o: number): number {
    if (o + 1 > this.buf.length) throw new RangeError("short");
    return this.buf[o];
  }
  u16(o: number): number {
    if (o + 2 > this.buf.length) throw new RangeError("short");
    return this.buf.readUInt16BE(o);
  }
  u32(o: number): number {
    if (o + 4 > this.buf.length) throw new RangeError("short");
    return this.buf.readUInt32BE(o);
  }
  /** A name at `o`, following compression pointers (backwards only, bounded); returns it and the offset after it. */
  name(o: number): { name: string; next: number } {
    const labels: string[] = [];
    let next = -1;
    let at = o;
    let jumps = 0;
    let total = 0;
    for (;;) {
      const len = this.u8(at);
      if (len === 0) {
        if (next < 0) next = at + 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        const ptr = ((len & 0x3f) << 8) | this.u8(at + 1);
        if (next < 0) next = at + 2;
        if (ptr >= at || ++jumps > 16) throw new RangeError("bad pointer");
        at = ptr;
        continue;
      }
      if (len > 63 || at + 1 + len > this.buf.length) throw new RangeError("bad label");
      labels.push(this.buf.toString("utf8", at + 1, at + 1 + len));
      total += len + 1;
      if (total > 255) throw new RangeError("name too long");
      at += 1 + len;
    }
    return { name: labels.join("."), next };
  }
}

function decodeTxt(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (o < buf.length) {
    const len = buf[o];
    if (o + 1 + len > buf.length) throw new RangeError("bad txt");
    const s = buf.toString("utf8", o + 1, o + 1 + len);
    o += 1 + len;
    if (!s) continue;
    const eq = s.indexOf("=");
    const k = (eq < 0 ? s : s.slice(0, eq)).toLowerCase();
    // RFC 6763: the first occurrence of a key wins.
    if (k && !(k in out)) out[k] = eq < 0 ? "" : s.slice(eq + 1);
  }
  return out;
}

/** Parse a packet; null when it is not a well-formed DNS message (never throws). */
export function decodePacket(buf: Buffer): MdnsPacket | null {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > MDNS_MAX_PACKET) return null;
  try {
    const r = new Reader(buf);
    const id = r.u16(0);
    const flags = r.u16(2);
    const qd = r.u16(4);
    const rrCount = r.u16(6) + r.u16(8) + r.u16(10);
    if (qd > 64 || rrCount > 128) return null;
    let o = 12;
    const questions: MdnsQuestion[] = [];
    for (let i = 0; i < qd; i++) {
      const n = r.name(o);
      questions.push({ name: n.name.toLowerCase(), type: r.u16(n.next) });
      o = n.next + 4;
    }
    const records: MdnsRecord[] = [];
    for (let i = 0; i < rrCount; i++) {
      const n = r.name(o);
      const type = r.u16(n.next);
      const ttl = r.u32(n.next + 4);
      const len = r.u16(n.next + 8);
      const start = n.next + 10;
      if (start + len > buf.length) return null;
      const name = n.name.toLowerCase();
      if (type === TYPE_PTR) records.push({ name, type, ttl, data: r.name(start).name.toLowerCase() });
      else if (type === TYPE_SRV) {
        if (len < 7) return null;
        records.push({ name, type, ttl, data: { priority: r.u16(start), weight: r.u16(start + 2), port: r.u16(start + 4), target: r.name(start + 6).name.toLowerCase() } });
      } else if (type === TYPE_TXT) records.push({ name, type, ttl, data: decodeTxt(buf.subarray(start, start + len)) });
      else if (type === TYPE_A && len === 4) records.push({ name, type, ttl, data: [...buf.subarray(start, start + 4)].join(".") });
      else records.push({ name, type, ttl, data: null });
      o = start + len;
    }
    return { id, response: (flags & 0x8000) !== 0, questions, records };
  } catch {
    return null;
  }
}
