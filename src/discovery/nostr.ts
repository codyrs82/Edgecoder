// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Nostr transport for coordinator announcements (NIP-01 websockets, NIP-33 parameterized
// replaceable event kind 30078, d-tag "edgecoder-coordinator"). The announcement inside
// `content` is signed with the coordinator's Ed25519 identity; the Nostr event wrapper is
// signed with a secp256k1 Schnorr key (BIP340) derived from NOSTR_SECRET_KEY_HEX.

import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { CoordinatorAnnouncement } from "./types.js";
import { parseAnnouncement, verifyAnnouncement, type VerifyOptions } from "./types.js";

export const NOSTR_ANNOUNCEMENT_KIND = 30078;
export const NOSTR_ANNOUNCEMENT_DTAG = "edgecoder-coordinator";
export const DEFAULT_NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrKeys {
  secretKey: Uint8Array;
  /** 32-byte x-only public key, lowercase hex. */
  pubkeyHex: string;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

/** Load a 32-byte secret from hex; when absent, derive one deterministically from `fallbackSeed`. */
export function nostrKeysFromSecret(secretHex: string | undefined, fallbackSeed?: string): NostrKeys | null {
  let secret: Uint8Array | null = null;
  const cleaned = (secretHex ?? "").trim().toLowerCase();
  if (cleaned) {
    if (!/^[0-9a-f]{64}$/.test(cleaned)) throw new Error("NOSTR_SECRET_KEY_HEX must be 64 hex characters");
    secret = fromHex(cleaned);
  } else if (fallbackSeed) {
    secret = new Uint8Array(createHash("sha256").update(`edgecoder-nostr-v1\n${fallbackSeed}`).digest());
  }
  if (!secret) return null;
  return { secretKey: secret, pubkeyHex: hex(schnorr.getPublicKey(secret)) };
}

export function nostrRelaysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.EDGECODER_NOSTR_RELAYS ?? "").trim();
  const list = (raw ? raw.split(",") : DEFAULT_NOSTR_RELAYS).map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)].filter((u) => /^wss?:\/\//i.test(u));
}

/** NIP-01 event id: sha256 of the canonical serialization. */
export function nostrEventId(e: Omit<NostrEvent, "id" | "sig">): string {
  const serialized = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export interface BuildEventOptions {
  createdAtSec?: number;
  dTag?: string;
}

/** Wrap a signed announcement in a replaceable Nostr event and sign it with the Nostr key. */
export function buildAnnouncementEvent(announcement: CoordinatorAnnouncement, keys: NostrKeys, opts: BuildEventOptions = {}): NostrEvent {
  const unsigned = {
    pubkey: keys.pubkeyHex,
    created_at: opts.createdAtSec ?? Math.floor(announcement.announcedAtMs / 1000),
    kind: NOSTR_ANNOUNCEMENT_KIND,
    tags: [
      ["d", opts.dTag ?? NOSTR_ANNOUNCEMENT_DTAG],
      ["url", announcement.url],
      ["region", announcement.region],
      ["peer", announcement.peerId],
      ["t", "edgecoder"]
    ],
    content: JSON.stringify(announcement)
  };
  const id = nostrEventId(unsigned);
  const sig = hex(schnorr.sign(fromHex(id), keys.secretKey));
  return { id, ...unsigned, sig };
}

export function isNostrEventShape(input: unknown): input is NostrEvent {
  if (!input || typeof input !== "object") return false;
  const e = input as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    /^[0-9a-f]{64}$/.test(e.id) &&
    typeof e.pubkey === "string" &&
    /^[0-9a-f]{64}$/.test(e.pubkey) &&
    typeof e.created_at === "number" &&
    typeof e.kind === "number" &&
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string")) &&
    typeof e.content === "string" &&
    typeof e.sig === "string" &&
    /^[0-9a-f]{128}$/.test(e.sig)
  );
}

/** True when the id matches the serialization and the Schnorr signature verifies. */
export function verifyNostrEvent(event: unknown): event is NostrEvent {
  if (!isNostrEventShape(event)) return false;
  const { id, sig, ...rest } = event;
  if (nostrEventId(rest) !== id) return false;
  try {
    return schnorr.verify(fromHex(sig), fromHex(id), fromHex(event.pubkey));
  } catch {
    return false;
  }
}

/**
 * Extract and verify the announcement from an event: the outer Nostr signature, the kind/d-tag,
 * and the inner Ed25519 signature must all check out. Returns null otherwise.
 */
export function announcementFromEvent(event: unknown, opts: VerifyOptions & { dTag?: string } = {}): CoordinatorAnnouncement | null {
  if (!verifyNostrEvent(event)) return null;
  if (event.kind !== NOSTR_ANNOUNCEMENT_KIND) return null;
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  if (d !== (opts.dTag ?? NOSTR_ANNOUNCEMENT_DTAG)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  const announcement = parseAnnouncement(parsed);
  if (!announcement) return null;
  return verifyAnnouncement(announcement, opts).ok ? announcement : null;
}

// ── Relay I/O ───────────────────────────────────────────────────────────────

/** Minimal websocket surface shared by the `ws` package and Node's global WebSocket. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export type WsConnect = (url: string) => WsLike;

let defaultConnectPromise: Promise<WsConnect> | null = null;

/** Prefer the `ws` package when installed (it is a transitive dependency); else Node 22's global WebSocket. */
export function defaultWsConnect(): Promise<WsConnect> {
  if (!defaultConnectPromise) {
    defaultConnectPromise = import("ws")
      .then((mod) => {
        const Ctor = (mod.default ?? (mod as unknown as { WebSocket: unknown }).WebSocket) as new (url: string) => WsLike;
        return (url: string) => new Ctor(url);
      })
      .catch(() => {
        const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WsLike }).WebSocket;
        if (!Ctor) throw new Error("no WebSocket implementation available");
        return (url: string) => new Ctor(url);
      });
  }
  return defaultConnectPromise;
}

async function messageText(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => Buffer.from(d as Uint8Array))).toString("utf8");
  if (data && typeof (data as { text?: unknown }).text === "function") {
    try {
      return await (data as { text: () => Promise<string> }).text();
    } catch {
      return null;
    }
  }
  return null;
}

export interface RelayIoOptions {
  relays?: string[];
  /** Total per-relay budget including connect (default 5 s). */
  timeoutMs?: number;
  connect?: WsConnect;
}

export interface PublishResult {
  relay: string;
  ok: boolean;
  message?: string;
}

/**
 * Publish an event to every relay in parallel. Each relay gets its own timeout; failures are
 * reported, never thrown, so an announcer loop can run without supervision.
 */
export async function publishNostrEvent(event: NostrEvent, opts: RelayIoOptions = {}): Promise<PublishResult[]> {
  const relays = opts.relays ?? DEFAULT_NOSTR_RELAYS;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const connect = opts.connect ?? (await defaultWsConnect());
  return Promise.all(
    relays.map(
      (relay) =>
        new Promise<PublishResult>((resolve) => {
          let done = false;
          let ws: WsLike | null = null;
          const finish = (r: PublishResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
              ws?.close();
            } catch {
              /* ignore */
            }
            resolve(r);
          };
          const timer = setTimeout(() => finish({ relay, ok: false, message: "timeout" }), timeoutMs);
          try {
            ws = connect(relay);
          } catch (err) {
            finish({ relay, ok: false, message: String(err) });
            return;
          }
          ws.onopen = () => {
            try {
              ws?.send(JSON.stringify(["EVENT", event]));
            } catch (err) {
              finish({ relay, ok: false, message: String(err) });
            }
          };
          ws.onmessage = (ev) => {
            void messageText(ev.data).then((text) => {
              if (!text) return;
              let msg: unknown;
              try {
                msg = JSON.parse(text);
              } catch {
                return;
              }
              if (!Array.isArray(msg)) return;
              if (msg[0] === "OK" && msg[1] === event.id) {
                finish({ relay, ok: Boolean(msg[2]), message: typeof msg[3] === "string" ? msg[3] : undefined });
              } else if (msg[0] === "NOTICE" && typeof msg[1] === "string" && /error|invalid|blocked/i.test(msg[1])) {
                finish({ relay, ok: false, message: msg[1] });
              }
            });
          };
          ws.onerror = (err) => finish({ relay, ok: false, message: errorMessage(err) });
          ws.onclose = () => finish({ relay, ok: false, message: "closed before OK" });
        })
    )
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof e.message === "string" && e.message) return e.message;
    if (e.error && typeof e.error.message === "string") return e.error.message;
  }
  return "websocket error";
}

export interface FetchAnnouncementsOptions extends RelayIoOptions {
  /** Only accept events from these Nostr pubkeys (hex). Default: any author. */
  authors?: string[];
  limit?: number;
  dTag?: string;
  verify?: VerifyOptions;
}

/**
 * Query every relay for coordinator announcements and return the verified, de-duplicated set
 * (newest per peerId). Relays that fail or time out contribute nothing.
 */
export async function fetchNostrAnnouncements(opts: FetchAnnouncementsOptions = {}): Promise<CoordinatorAnnouncement[]> {
  const relays = opts.relays ?? DEFAULT_NOSTR_RELAYS;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const connect = opts.connect ?? (await defaultWsConnect());
  const dTag = opts.dTag ?? NOSTR_ANNOUNCEMENT_DTAG;
  const filter: Record<string, unknown> = { kinds: [NOSTR_ANNOUNCEMENT_KIND], "#d": [dTag], limit: opts.limit ?? 200 };
  if (opts.authors && opts.authors.length > 0) filter.authors = opts.authors;
  const perRelay = await Promise.all(
    relays.map(
      (relay) =>
        new Promise<NostrEvent[]>((resolve) => {
          const events: NostrEvent[] = [];
          let done = false;
          let ws: WsLike | null = null;
          const subId = `ec-${Math.random().toString(36).slice(2, 10)}`;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
              ws?.send(JSON.stringify(["CLOSE", subId]));
            } catch {
              /* ignore */
            }
            try {
              ws?.close();
            } catch {
              /* ignore */
            }
            resolve(events);
          };
          const timer = setTimeout(finish, timeoutMs);
          try {
            ws = connect(relay);
          } catch {
            finish();
            return;
          }
          ws.onopen = () => {
            try {
              ws?.send(JSON.stringify(["REQ", subId, filter]));
            } catch {
              finish();
            }
          };
          ws.onmessage = (ev) => {
            void messageText(ev.data).then((text) => {
              if (!text || done) return;
              let msg: unknown;
              try {
                msg = JSON.parse(text);
              } catch {
                return;
              }
              if (!Array.isArray(msg)) return;
              if (msg[0] === "EVENT" && msg[1] === subId && isNostrEventShape(msg[2])) events.push(msg[2]);
              else if (msg[0] === "EOSE" && msg[1] === subId) finish();
              else if (msg[0] === "CLOSED" && msg[1] === subId) finish();
            });
          };
          ws.onerror = () => finish();
          ws.onclose = () => finish();
        })
    )
  );
  const newest = new Map<string, CoordinatorAnnouncement>();
  for (const events of perRelay) {
    for (const event of events) {
      if (opts.authors && opts.authors.length > 0 && !opts.authors.includes(event.pubkey)) continue;
      const a = announcementFromEvent(event, { ...opts.verify, dTag });
      if (!a) continue;
      const prev = newest.get(a.peerId);
      if (!prev || a.announcedAtMs > prev.announcedAtMs) newest.set(a.peerId, a);
    }
  }
  return [...newest.values()];
}
