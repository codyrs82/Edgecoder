// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A small, defensive ZIP reader for attached archives and Office files (no dependencies).
 *
 * - Reads the central directory; entries stored (method 0) or deflated (method 8, `inflateRawSync`).
 * - Refuses: ZIP64 and multi-disk archives, encrypted entries, entry paths that would leave the
 *   target folder (zip-slip: absolute paths, `..`, drive letters, backslash tricks, NUL), and zip
 *   bombs (too many entries, too much in total, an extreme compression ratio). Sizes are checked
 *   against what the directory declares and again while inflating (`maxOutputLength`), and every
 *   entry's CRC-32 is verified.
 * - Leaves out (with a reason): symbolic links, entries over the per-file cap or past the total
 *   cap, unsupported compression methods. Skips `__MACOSX/` and `.DS_Store` silently. Never opens
 *   zips inside the zip; they are files like any other.
 *
 * Used by the IDE's attachments (src/apps/ide/attachments.ts) and the Office text extraction
 * (office-text.ts); shared so any server that takes attachments handles them the same way.
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipLimits {
  /** Entries in the archive (files and folders, before skipping). */
  maxEntries: number;
  /** Uncompressed bytes of everything extracted. */
  maxTotalBytes: number;
  /** Uncompressed bytes of one file. */
  maxFileBytes: number;
  /** Uncompressed : compressed, for an entry over 1 MB or for the archive as a whole. */
  maxRatio: number;
}

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxRatio: 100,
};

/** A ratio is only judged once there is this much uncompressed data (tiny files compress wildly). */
const RATIO_FLOOR = 1024 * 1024;

/** Why an archive can't be opened at all; the message is meant for the person who attached it. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipFileEntry {
  /** Safe relative path, `/` separators, no `.`/`..` segments. */
  path: string;
  /** Uncompressed size as declared (verified on read). */
  size: number;
  compressedSize: number;
  /** The bytes (inflated, size- and CRC-checked). Throws ZipError when they don't match. */
  read(): Buffer;
}

export interface ZipSkip {
  path: string;
  reason: string;
}

export interface OpenedZip {
  files: ZipFileEntry[];
  /** Folders named in the archive (safe relative paths). */
  dirs: string[];
  /** Entries left out, with why. */
  skipped: ZipSkip[];
  /** Sum of `files[].size`. */
  totalBytes: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// CP437, the default name encoding when the UTF-8 flag is off (bytes 0x80-0xFF).
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

let crcTable: Uint32Array | null = null;
export function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodeName(raw: Buffer, utf8Flag: boolean, extra: Buffer): string {
  if (utf8Flag) return raw.toString("utf8");
  // Info-ZIP Unicode Path extra field (0x7075): version 1, CRC of the raw name, then UTF-8.
  for (let i = 0; i + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    if (id === 0x7075 && len >= 5 && i + 4 + len <= extra.length && extra[i + 4] === 1 && extra.readUInt32LE(i + 5) === crc32(raw)) {
      return extra.subarray(i + 9, i + 4 + len).toString("utf8");
    }
    i += 4 + len;
  }
  if (raw.every((b) => b < 0x80)) return raw.toString("latin1");
  // Many tools write UTF-8 without setting the flag; use it when it decodes cleanly.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return [...raw].map((b) => (b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80])).join("");
  }
}

/**
 * The entry name as a safe relative path, or a ZipError when it would leave the folder it's
 * extracted into. Backslashes count as separators (zips made on Windows), so `..\x` is caught too.
 */
export function safeEntryPath(name: string): string {
  const shown = JSON.stringify(name.length > 120 ? `${name.slice(0, 120)}…` : name);
  const unsafe = () => new ZipError(`It contains a file path that would land outside its folder (${shown}), so it wasn't opened.`);
  if (name.includes("\u0000")) throw unsafe();
  const s = name.normalize("NFC").replace(/\\/g, "/");
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s) || isAbsolute(s)) throw unsafe();
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." || /^\.{2,}$/.test(seg.trim())) throw unsafe();
    // Characters a file name can't (portably) hold; control characters too.
    const clean = seg.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_");
    parts.push(clean.length > 200 ? clean.slice(0, 200) : clean);
  }
  return parts.join("/");
}

function isJunk(path: string): boolean {
  const parts = path.split("/");
  return parts[0] === "__MACOSX" || parts[parts.length - 1] === ".DS_Store";
}

/**
 * Read an archive's directory and check it against `limits`. Throws ZipError when it can't (or
 * shouldn't) be opened; otherwise returns its files, ready to read one at a time.
 */
export function openZip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS): OpenedZip {
  if (buf.length < 22) throw new ZipError("It isn't a zip file (too short).");
  // End of central directory: the last 22 bytes plus up to a 64 KB comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("It isn't a zip file, or it is damaged (no central directory).");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const zip64 = (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR) || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (zip64) throw new ZipError("It is a ZIP64 archive (over 4 GB or 65,535 entries), which isn't supported. Split it into smaller zips.");
  if (disk !== 0 || cdDisk !== 0) throw new ZipError("It is a multi-part (spanned) archive, which isn't supported.");
  if (count > limits.maxEntries) throw new ZipError(`It has ${count.toLocaleString("en-US")} entries; archives can have up to ${limits.maxEntries.toLocaleString("en-US")}.`);
  if (cdOffset + cdSize > eocd) throw new ZipError("It is damaged (the central directory is out of bounds).");

  const files: ZipFileEntry[] = [];
  const dirs: string[] = [];
  const skipped: ZipSkip[] = [];
  const seen = new Set<string>();
  let total = 0;
  let declaredTotal = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError("It is damaged (a bad central directory entry).");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) throw new ZipError("It is damaged (a central directory entry runs past its end).");
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    p = next;

    const name = decodeName(rawName, (flags & 0x800) !== 0, extra);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("It is a ZIP64 archive (an entry over 4 GB), which isn't supported. Split it into smaller zips.");
    }
    if (flags & 0x1) throw new ZipError("It is password-protected (encrypted), and EdgeCoder can't open encrypted zips. Unzip it yourself and attach the files, or zip them again without a password.");
    const path = safeEntryPath(name);
    if (!path || isJunk(path)) continue;
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    const isDir = name.endsWith("/") || name.endsWith("\\") || (unixMode & 0o170000) === 0o040000 || (madeBy >> 8 === 0 && (external & 0x10) !== 0);
    if ((unixMode & 0o170000) === 0o120000) {
      skipped.push({ path, reason: "a symbolic link; links aren't extracted" });
      continue;
    }
    if (isDir) {
      dirs.push(path);
      continue;
    }
    const key = path.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ path, reason: "a second file with the same name" });
      continue;
    }
    seen.add(key);
    declaredTotal += usize;
    if (method !== 0 && method !== 8) {
      skipped.push({ path, reason: `compressed with a method EdgeCoder can't read (${method})` });
      continue;
    }
    if (method === 0 && csize !== usize) throw new ZipError("It is damaged (a stored entry's sizes don't match).");
    if (usize > RATIO_FLOOR && usize / Math.max(csize, 1) > limits.maxRatio) {
      throw new ZipError(`It looks like a zip bomb (${path} expands more than ${limits.maxRatio}:1), so it wasn't opened.`);
    }
    if (usize > limits.maxFileBytes) {
      skipped.push({ path, reason: `${formatSize(usize)} uncompressed; files can be up to ${formatSize(limits.maxFileBytes)}` });
      continue;
    }
    if (total + usize > limits.maxTotalBytes) {
      skipped.push({ path, reason: `past the ${formatSize(limits.maxTotalBytes)} total for one archive` });
      continue;
    }
    total += usize;
    files.push({ path, size: usize, compressedSize: csize, read: () => readEntry(buf, localOffset, method, csize, usize, crc, path, cdOffset) });
  }
  if (declaredTotal > RATIO_FLOOR && declaredTotal / buf.length > limits.maxRatio) {
    throw new ZipError(`It looks like a zip bomb (it expands more than ${limits.maxRatio}:1), so it wasn't opened.`);
  }
  return { files, dirs, skipped, totalBytes: total };
}

function readEntry(buf: Buffer, offset: number, method: number, csize: number, usize: number, crc: number, path: string, cdOffset: number): Buffer {
  if (offset + 30 > cdOffset || buf.readUInt32LE(offset) !== SIG_LOCAL) throw new ZipError(`${path} is damaged (bad local header).`);
  const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
  if (start + csize > cdOffset) throw new ZipError(`${path} is damaged (its data runs past the end).`);
  const data = buf.subarray(start, start + csize);
  let out: Buffer;
  if (method === 0) out = Buffer.from(data);
  else {
    try {
      // Never inflate past what the directory declared: a lying header can't blow up memory.
      out = inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new ZipError(code === "ERR_BUFFER_TOO_LARGE" ? `${path} expands past its declared size, so it wasn't read.` : `${path} is damaged (it doesn't inflate).`);
    }
  }
  if (out.length !== usize) throw new ZipError(`${path} is damaged (its size doesn't match).`);
  if (crc32(out) !== crc) throw new ZipError(`${path} is damaged (checksum mismatch).`);
  return out;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface Extracted {
  /** Written files, relative to the target folder. */
  files: Array<{ path: string; size: number }>;
  skipped: ZipSkip[];
}

/**
 * Extract an opened archive into `target` (which must not exist yet, or be empty). Every output
 * path is resolved and checked to stay inside `target`, files are created exclusively (never
 * overwriting, never through a symlink), and a file that can't be written is left out with why.
 * `reserved` paths (e.g. EdgeCoder's own `.gitignore`) are left out too.
 */
export function extractZip(zip: OpenedZip, target: string, reserved: string[] = []): Extracted {
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  const inside = (p: string) => {
    const abs = resolve(root, ...p.split("/"));
    const rel = relative(root, abs);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ZipError(`It contains a file path that would land outside its folder (${JSON.stringify(p)}), so it wasn't opened.`);
    return abs;
  };
  // A parent that exists must be a real folder inside root (never a symlink; we create none).
  const ensureDir = (abs: string) => {
    const rel = relative(root, abs);
    let cur = root;
    for (const seg of rel ? rel.split(sep) : []) {
      cur = resolve(cur, seg);
      if (existsSync(cur)) {
        const st = lstatSync(cur);
        if (!st.isDirectory() || st.isSymbolicLink()) return false;
      } else mkdirSync(cur);
    }
    return true;
  };
  const out: Extracted = { files: [], skipped: [...zip.skipped] };
  const reservedSet = new Set(reserved.map((r) => r.toLowerCase()));
  for (const d of zip.dirs) {
    try {
      ensureDir(inside(d));
    } catch (err) {
      if (err instanceof ZipError) throw err;
    }
  }
  for (const f of zip.files) {
    const abs = inside(f.path);
    if (reservedSet.has(f.path.toLowerCase())) {
      out.skipped.push({ path: f.path, reason: "kept EdgeCoder's own file of that name" });
      continue;
    }
    let ok = false;
    try {
      ok = ensureDir(dirname(abs));
    } catch {
      ok = false;
    }
    if (!ok) {
      out.skipped.push({ path: f.path, reason: "its folder clashes with a file of the same name" });
      continue;
    }
    const data = f.read();
    try {
      writeFileSync(abs, data, { flag: "wx" });
    } catch {
      out.skipped.push({ path: f.path, reason: "a file with the same name was already extracted" });
      continue;
    }
    out.files.push({ path: f.path, size: data.length });
  }
  return out;
}
