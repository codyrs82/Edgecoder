// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { schnorr } from "@noble/curves/secp256k1.js";
import { nostrEventId, publishNostrEvent, type NostrEvent, type NostrKeys, type WsConnect } from "../discovery/nostr.js";

/**
 * The brand account's Nostr cross-post: the same text as a kind-1 note, signed with
 * NOSTR_BRAND_NSEC (64 hex or nsec1 bech32) through the event id and relay code of
 * src/discovery/nostr.ts. Only kind 1 with no tags: no replies, mentions or reposts.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || (acc << (to - bits)) & maxv) return null;
  return out;
}

export function bech32Decode(s: string): { hrp: string; bytes: Uint8Array } | null {
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) return null;
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const data: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d < 0) return null;
    data.push(d);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  return bytes ? { hrp, bytes: new Uint8Array(bytes) } : null;
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits([...bytes], 8, 5, true)!;
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

/** Keys from NOSTR_BRAND_NSEC; throws (without echoing the value) when it is neither 64 hex nor a valid nsec. */
export function brandNostrKeys(secret: string): NostrKeys {
  const s = secret.trim();
  let key: Uint8Array | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = new Uint8Array(Buffer.from(s, "hex"));
  else if (/^nsec1/i.test(s)) {
    const d = bech32Decode(s);
    if (d && d.hrp === "nsec" && d.bytes.length === 32) key = d.bytes;
  }
  if (!key) throw new Error("NOSTR_BRAND_NSEC must be 64 hex characters or an nsec1 key");
  return { secretKey: key, pubkeyHex: Buffer.from(schnorr.getPublicKey(key)).toString("hex") };
}

/** A signed kind-1 note with no tags. */
export function buildNote(content: string, keys: NostrKeys, createdAtSec = Math.floor(Date.now() / 1000)): NostrEvent {
  const unsigned = { pubkey: keys.pubkeyHex, created_at: createdAtSec, kind: 1, tags: [] as string[][], content };
  const id = nostrEventId(unsigned);
  const sig = Buffer.from(schnorr.sign(new Uint8Array(Buffer.from(id, "hex")), keys.secretKey)).toString("hex");
  return { id, ...unsigned, sig };
}

export type NostrPostResult = { ok: true; eventId: string; relaysOk: number; relays: number } | { ok: false; eventId: string; error: string; relays: number };

/** Publish to every relay; ok when at least one relay accepted it. */
export async function publishNote(content: string, keys: NostrKeys, relays: string[], opts: { connect?: WsConnect; timeoutMs?: number } = {}): Promise<NostrPostResult> {
  const event = buildNote(content, keys);
  const results = await publishNostrEvent(event, { relays, timeoutMs: opts.timeoutMs ?? 8_000, connect: opts.connect });
  const okCount = results.filter((r) => r.ok).length;
  if (okCount > 0) return { ok: true, eventId: event.id, relaysOk: okCount, relays: relays.length };
  return { ok: false, eventId: event.id, relays: relays.length, error: `no relay accepted the note (${results.map((r) => `${r.relay.replace(/^wss:\/\//, "")}: ${(r.message ?? "rejected").slice(0, 60)}`).join("; ")})` };
}

export const noteBech32 = (eventIdHex: string) => bech32Encode("note", new Uint8Array(Buffer.from(eventIdHex, "hex")));
