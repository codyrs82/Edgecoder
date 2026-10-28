// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// #148: the one way src/ downloads a model file. It verifies the signed manifest (#144), then
// fetches the exact signed `source`, requiring https on every redirect hop. It streams the body
// to a temp file while hashing it, and only renames it into place when the sha256 matches.
// The local filename never comes from the URL.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent, request, type Dispatcher } from "undici";
import {
  ALLOWED_MODEL_EXTENSIONS,
  verifyModelManifest,
  type SignedModelManifest,
  type TrustConfig
} from "./manifest-verifier.js";

export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_MODEL_BYTES = 64 * 1024 ** 3; // 64 GiB

export class ModelDownloadError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ModelDownloadError";
  }
}

export interface ModelDownloadOptions {
  trust: TrustConfig;
  /** Directory the verified file is placed in (created if missing). */
  destDir: string;
  maxRedirects?: number;
  /** Hard cap on bytes read (default 64 GiB). */
  maxBytes?: number;
  /**
   * For tests (undici MockAgent) only. The https and public-address checks below still run on
   * every hop, but a custom dispatcher bypasses the connect-time address pin, so production
   * callers must leave this unset.
   */
  dispatcher?: Dispatcher;
  /** Resolve a hostname to its addresses (default: dns.lookup all). Injectable for tests. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export interface ModelDownloadResult {
  path: string;
  sha256: string;
  bytes: number;
  /** Every URL fetched, in order (the signed source first). */
  hops: string[];
}

/** Streaming sha256 (hex), so multi-GB files are never held in memory. */
export async function sha256OfStream(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function fileMatchesSha256(path: string, expectedHex: string): Promise<boolean> {
  return digestsEqual(await sha256OfStream(createReadStream(path)), expectedHex);
}

/** Constant-time compare of two hex sha256 digests. */
export function digestsEqual(actualHex: string, expectedHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actualHex) || !/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  return timingSafeEqual(Buffer.from(actualHex, "hex"), Buffer.from(expectedHex, "hex"));
}

function safePart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned || "model";
}

/** `<modelId>-<version><ext>` from the signed fields; the ext comes from the validated source path. */
export function modelFileName(m: Pick<SignedModelManifest, "modelId" | "version" | "source" | "sha256">): string {
  const path = decodeURIComponent(new URL(m.source).pathname).toLowerCase();
  const ext = ALLOWED_MODEL_EXTENSIONS.find((e) => path.endsWith(e));
  if (!ext) throw new ModelDownloadError("disallowed_file_extension");
  // The sha256 prefix keeps two models whose ids sanitize to the same string from colliding.
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) throw new ModelDownloadError("invalid_sha256");
  return `${safePart(m.modelId)}-${safePart(m.version)}-${m.sha256.slice(0, 16)}${ext}`;
}

// Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges.
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** True for addresses a model download must never reach. IPv4-mapped IPv6 is checked as IPv4. */
export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return BLOCKED.check(mapped[1], "ipv4");
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family === 6) return BLOCKED.check(address, "ipv6");
  return true; // not an IP at all
}

function defaultResolve(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true }, (err, addrs: LookupAddress[]) =>
      err ? reject(err) : resolve(addrs.map((a) => a.address))
    )
  );
}

/** Every hop: https only, and the host must not resolve to a private or loopback address. */
export async function assertPublicHttps(url: string, resolveHost = defaultResolve): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new ModelDownloadError("hop_not_https", u.protocol);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolveHost(host).catch(() => {
    throw new ModelDownloadError("dns_lookup_failed", host);
  });
  if (addrs.length === 0 || addrs.some(isBlockedAddress)) throw new ModelDownloadError("private_address_blocked", host);
}

// Default dispatcher: re-checks the address actually connected to, so DNS rebinding between
// the pre-check and the connect can't reach a private host.
const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, cb) {
      dnsLookup(hostname, { ...options, all: true }, (err, addrs: LookupAddress[]) => {
        if (err) return cb(err, "", 0);
        const ok = addrs.filter((a) => !isBlockedAddress(a.address));
        if (ok.length !== addrs.length || ok.length === 0) {
          return cb(new ModelDownloadError("private_address_blocked", hostname), "", 0);
        }
        if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, ok);
        cb(null, ok[0].address, ok[0].family);
      });
    }
  }
});

/** Next hop for a redirect: must be absolute-resolvable, https, and carry no credentials. */
export function redirectTarget(current: string, location: unknown): string {
  if (typeof location !== "string" || !location) throw new ModelDownloadError("redirect_without_location");
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new ModelDownloadError("redirect_invalid_location");
  }
  if (next.protocol !== "https:") throw new ModelDownloadError("redirect_not_https", next.protocol);
  if (next.username || next.password) throw new ModelDownloadError("redirect_has_credentials");
  return next.toString();
}

export async function downloadVerifiedModel(
  signed: SignedModelManifest,
  opts: ModelDownloadOptions
): Promise<ModelDownloadResult> {
  const check = verifyModelManifest(signed, opts.trust);
  if (!check.valid) throw new ModelDownloadError("manifest_invalid", check.reason);

  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_MODEL_BYTES;
  const finalName = modelFileName(signed);
  await mkdir(opts.destDir, { recursive: true });

  // The exact signed string, not a re-serialized URL.
  let url = signed.source;
  const hops: string[] = [];
  for (;;) {
    hops.push(url);
    await assertPublicHttps(url, opts.resolveHost);
    const res = await request(url, {
      method: "GET",
      dispatcher: opts.dispatcher ?? guardedAgent,
      headersTimeout: opts.headersTimeoutMs ?? 30_000,
      bodyTimeout: opts.bodyTimeoutMs ?? 120_000
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      await res.body.dump();
      if (hops.length > maxRedirects) throw new ModelDownloadError("too_many_redirects", String(maxRedirects));
      url = redirectTarget(url, res.headers.location);
      continue;
    }
    if (res.statusCode !== 200) {
      await res.body.dump();
      throw new ModelDownloadError("download_http_status", String(res.statusCode));
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.dump();
      throw new ModelDownloadError("model_too_large", String(declared));
    }

    const tmp = join(opts.destDir, `.download-${randomBytes(8).toString("hex")}.part`);
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new ModelDownloadError("model_too_large", String(bytes)));
        hash.update(chunk);
        cb(null, chunk);
      }
    });
    try {
      await pipeline(res.body, meter, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
      const sha256 = hash.digest("hex");
      if (!digestsEqual(sha256, signed.sha256)) throw new ModelDownloadError("sha256_mismatch");
      const path = join(opts.destDir, finalName);
      await rename(tmp, path);
      return { path, sha256, bytes, hops };
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
