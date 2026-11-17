// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Files attached in the composer (the + button, paste, drag and drop): images, text/code/data files
 * (CSV, Markdown, JSON, XML, HTML, logs…), PDFs, Word/Excel/PowerPoint documents and .zip archives,
 * read in the browser and sent with the message.
 *
 * Archives and Office files are opened by the local provider (src/apps/ide/attachments.ts, with
 * the defensive reader in src/common/zip.ts), never here: the composer only reads a zip's directory
 * to show how many files it holds and to refuse an encrypted or ZIP64 one before sending.
 *
 * What a model gets depends on what it can take:
 *   - text/code files: always inlined into the message (fenced, with the file name);
 *   - images and PDFs: as image/document parts only for a model that can see them (a frontier lead
 *     on your own Anthropic key; images also on an OpenAI key). Any other model gets a note with
 *     the file name (and, for a bot, the path in its folder where the app saved it), never a
 *     silent drop. The composer says so before you send.
 */

export type AttachmentKind = "image" | "text" | "pdf" | "archive" | "document";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mediaType: string;
  /** Bytes of what will be sent (after an image is scaled down). */
  size: number;
  /** Base64 (no data: prefix) for images and PDFs. */
  data?: string;
  /** The file's text, for text/code files. */
  text?: string;
  /** An object URL for an image's thumbnail (revoke when removed). */
  previewUrl?: string;
  /** A zip: how many files it holds (folders and macOS junk not counted). */
  fileCount?: number;
  /** A zip: entries that will be left out, and why (e.g. "link: a symbolic link"). */
  notes?: string[];
}

/** What goes over the wire with a message (no preview URL). */
export type AttachmentPayload = Omit<Attachment, "id" | "previewUrl" | "notes">;

export const MAX_ATTACHMENTS = 5;
/** Per text/code file: more than this is a file for the agent to read, not to paste in. */
export const TEXT_MAX_BYTES = 200 * 1024;
/** Per image as sent (Anthropic's API takes up to 5 MB of base64, about 3.75 MB of image). */
export const IMAGE_MAX_BYTES = 3_700_000;
/** An image file larger than this isn't even scaled down. */
export const IMAGE_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** A .zip (what's inside: up to 2,000 files, 25 MB each, 100 MB in all; checked by the provider). */
export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
/** A Word/Excel/PowerPoint file. */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
/** All of one message's attachments together. */
export const MESSAGE_MAX_BYTES = 60 * 1024 * 1024;
/** Images are scaled so their long edge is at most this (what vision models use anyway). */
export const IMAGE_MAX_EDGE = 2000;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Read as text (keep in step with TEXT_EXT in src/apps/ide/attachments.ts). */
const TEXT_EXT = new Set([
  "txt", "text", "md", "markdown", "rst", "adoc", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "xml", "html", "htm", "xhtml", "css", "scss", "less", "rtf", "tex", "bib", "srt", "vtt", "ics", "vcf", "eml",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "svelte", "vue", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "proto", "lua", "pl", "r", "dart", "scala", "ex", "exs", "erl", "hs", "ml", "tf", "hcl",
  "log", "out", "diff", "patch", "gitignore", "dockerfile", "makefile", "lock",
]);
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/rtf", "text/rtf", "application/x-ndjson", "application/xhtml+xml", "application/yaml", "application/x-yaml", "application/sql"]);
/** Word, Excel and PowerPoint (the new formats are read as text; the old binary ones only saved). */
const DOCUMENT_EXT = new Set(["docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "doc", "xls", "ppt"]);
const DOCUMENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);
const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip"]);

/** The file picker's accept list. */
export const ACCEPT = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/*", ...TEXT_TYPES, ...DOCUMENT_TYPES, ...ZIP_TYPES,
  ...[...TEXT_EXT, ...DOCUMENT_EXT, "zip"].map((e) => `.${e}`),
].join(",");

/** What the composer takes, for the message when a file isn't one of them. */
export const SUPPORTED_TYPES = "images (PNG, JPEG, GIF, WebP), PDFs, text, code and data files (CSV, Markdown, JSON, XML, HTML, logs…), Word, Excel and PowerPoint files, and .zip archives";

function ext(name: string): string {
  const lower = name.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (base === "dockerfile" || base === "makefile") return base;
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1) : "";
}

/** The kind of a picked/pasted/dropped file, or null when it isn't one the composer takes. */
export function classify(file: { name: string; type: string }): AttachmentKind | null {
  if (IMAGE_TYPES.has(file.type)) return "image";
  if (file.type === "application/pdf" || ext(file.name) === "pdf") return "pdf";
  if (ZIP_TYPES.has(file.type) || ext(file.name) === "zip") return "archive";
  if (DOCUMENT_TYPES.has(file.type) || DOCUMENT_EXT.has(ext(file.name))) return "document";
  if (file.type.startsWith("text/") || TEXT_EXT.has(ext(file.name)) || TEXT_TYPES.has(file.type)) return "text";
  if (!file.type && /\.(png|jpe?g|gif|webp)$/i.test(file.name)) return "image";
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a model can take besides text. */
export interface Vision {
  images: boolean;
  pdf: boolean;
}

export const NO_VISION: Vision = { images: false, pdf: false };

/**
 * For the chat's compute choice: a frontier lead on your Anthropic key sees images and PDFs, one on
 * an OpenAI key sees images; Auto, this computer and network models (qwen3-coder and the like)
 * see neither.
 */
export function visionFor(modelId: string | undefined): Vision {
  if (!modelId?.startsWith("frontier/")) return NO_VISION;
  const provider = modelId.split("/")[1];
  if (provider === "anthropic") return { images: true, pdf: true };
  if (provider === "openai") return { images: true, pdf: false };
  return NO_VISION;
}

/** The composer's note on attachments the model can't see, or null when it sees them all. */
export function visionNote(list: Pick<Attachment, "kind">[], vision: Vision, who = "This model", savedToFolder = false): string | null {
  const images = list.some((a) => a.kind === "image") && !vision.images;
  const pdfs = list.some((a) => a.kind === "pdf") && !vision.pdf;
  if (!images && !pdfs) return null;
  const what = images && pdfs ? "images or PDFs" : images ? "images" : "PDFs";
  return `${who} can't see ${what}; it gets the file name${savedToFolder ? " and the path where it's saved in its folder" : ""} instead.`;
}

function fence(text: string): string {
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return ticks;
}

/**
 * The text a model reads for the attachments: text files inlined, and a line for each image/PDF it
 * can't see (with `savedPaths[name]` when the app saved it into a bot's folder).
 */
export function attachmentsText(list: AttachmentPayload[], vision: Vision, savedPaths: Record<string, string> = {}): string {
  const parts: string[] = [];
  for (const a of list) {
    const saved = savedPaths[a.name] ? ` (saved at ${savedPaths[a.name]})` : "";
    if (a.kind === "text") {
      const f = fence(a.text ?? "");
      parts.push(`Attached file ${a.name}${saved}:\n${f}\n${a.text ?? ""}\n${f}`);
    } else if (a.kind === "archive") {
      parts.push(`[Attached zip ${a.name}${a.fileCount !== undefined ? ` (${a.fileCount} files)` : ""}${saved}. Its contents can't be opened in this chat; say so if the request depends on them, and suggest opening a project or messaging a bot instead.]`);
    } else if (a.kind === "document") {
      parts.push(`[Attached document ${a.name}${saved}. It can't be read in this chat; say so if the request depends on it, and suggest opening a project or pasting the text.]`);
    } else if ((a.kind === "image" && !vision.images) || (a.kind === "pdf" && !vision.pdf)) {
      parts.push(`[Attached ${a.kind === "image" ? "image" : "PDF"} ${a.name}, ${formatBytes(a.size)}${saved}. You can't see its contents; say so if the request depends on them.]`);
    }
  }
  return parts.join("\n\n");
}

/**
 * What's in a zip, from its central directory only (no inflating; the provider extracts it): the
 * number of files (folders, `__MACOSX/` and `.DS_Store` not counted) and notes on entries that will
 * be left out, or an error when it can't be opened at all (encrypted, ZIP64, not a zip).
 */
export function scanZip(buf: ArrayBuffer): { fileCount: number; notes: string[] } | { error: string } {
  const v = new DataView(buf);
  const len = buf.byteLength;
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { error: "it isn't a zip file, or it is damaged" };
  const count = v.getUint16(eocd + 10, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if ((eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50) || count === 0xffff || cdOffset === 0xffffffff) {
    return { error: "it is a ZIP64 archive (over 4 GB or 65,535 entries), which isn't supported; split it into smaller zips" };
  }
  if (count > 2000) return { error: `it has ${count.toLocaleString("en-US")} entries; archives can have up to 2,000` };
  const bytes = new Uint8Array(buf);
  const notes: string[] = [];
  let fileCount = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) return { error: "it is damaged (a bad central directory)" };
    const madeBy = v.getUint16(p + 4, true);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const nameLen = v.getUint16(p + 28, true);
    const external = v.getUint32(p + 38, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/");
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (flags & 1) return { error: "it is password-protected (encrypted); unzip it yourself and attach the files, or zip them again without a password" };
    const parts = name.split("/").filter(Boolean);
    if (!parts.length || parts[0] === "__MACOSX" || parts[parts.length - 1] === ".DS_Store") continue;
    const mode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    if ((mode & 0o170000) === 0o120000) notes.push(`${name}: a symbolic link, left out`);
    else if (name.endsWith("/") || (mode & 0o170000) === 0o040000) continue;
    else if (method !== 0 && method !== 8) notes.push(`${name}: compressed in a way EdgeCoder can't read, left out`);
    else fileCount++;
  }
  return { fileCount, notes };
}

/** The name on an attachment's chip: a zip also says how many files it holds. */
export function chipLabel(a: Pick<Attachment, "name" | "fileCount">): string {
  return a.fileCount === undefined ? a.name : `${a.name} · ${a.fileCount} file${a.fileCount === 1 ? "" : "s"}`;
}

/** The short line the conversation keeps for a sent attachment (the chat history stores text only). */
export function attachmentLabel(list: Pick<Attachment, "name" | "kind">[]): string {
  return list.length ? `[Attached: ${list.map((a) => a.name).join(", ")}]` : "";
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Scale an image down (long edge IMAGE_MAX_EDGE, then JPEG if still too large), in the browser.
 * Returns null when it can't (no canvas, a decode error); the caller then uses the original.
 */
async function shrinkImage(file: Blob): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const asType = (type: string, q?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
    const png = file.type === "image/png" ? await asType("image/png") : null;
    if (png && png.size <= IMAGE_MAX_BYTES) return png;
    return await asType("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

/** Blob.text()/arrayBuffer(), with FileReader where they're missing (older WebViews, jsdom). */
function readBlob(blob: Blob, as: "text"): Promise<string>;
function readBlob(blob: Blob, as: "buffer"): Promise<ArrayBuffer>;
function readBlob(blob: Blob, as: "text" | "buffer"): Promise<string | ArrayBuffer> {
  if (as === "text" && typeof blob.text === "function") return blob.text();
  if (as === "buffer" && typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string | ArrayBuffer);
    r.onerror = () => reject(r.error);
    if (as === "text") r.readAsText(blob);
    else r.readAsArrayBuffer(blob);
  });
}

let seq = 0;

/** Read a picked/pasted/dropped file into an attachment, or say why it can't be attached. */
export async function readAttachment(file: File): Promise<Attachment | { error: string }> {
  const kind = classify(file);
  const name = file.name || (kind === "image" ? `pasted-image.${(file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}` : "attachment");
  const id = `att${++seq}`;
  if (!kind) return { error: `${name} can't be attached. You can attach ${SUPPORTED_TYPES}.` };
  if (kind === "archive") {
    if (file.size > ARCHIVE_MAX_BYTES) return { error: `${name} is ${formatBytes(file.size)}; zips can be up to ${formatBytes(ARCHIVE_MAX_BYTES)}.` };
    const buf = await readBlob(file, "buffer");
    const scan = scanZip(buf);
    if ("error" in scan) return { error: `${name} can't be attached: ${scan.error}.` };
    return { id, name, kind, mediaType: file.type || "application/zip", size: file.size, data: toBase64(buf), fileCount: scan.fileCount, ...(scan.notes.length ? { notes: scan.notes } : {}) };
  }
  if (kind === "document") {
    if (file.size > DOCUMENT_MAX_BYTES) return { error: `${name} is ${formatBytes(file.size)}; documents can be up to ${formatBytes(DOCUMENT_MAX_BYTES)}.` };
    return { id, name, kind, mediaType: file.type, size: file.size, data: toBase64(await readBlob(file, "buffer")) };
  }
  if (kind === "text") {
    if (file.size > TEXT_MAX_BYTES) return { error: `${name} is ${formatBytes(file.size)}; text files can be up to ${formatBytes(TEXT_MAX_BYTES)}. Put it in the project and mention it with @ instead.` };
    const text = await readBlob(file, "text");
    if (text.includes("\u0000")) return { error: `${name} looks like a binary file, not text.` };
    return { id, name, kind, mediaType: file.type || "text/plain", size: file.size, text };
  }
  if (kind === "pdf") {
    if (file.size > PDF_MAX_BYTES) return { error: `${name} is ${formatBytes(file.size)}; PDFs can be up to ${formatBytes(PDF_MAX_BYTES)}.` };
    return { id, name, kind, mediaType: "application/pdf", size: file.size, data: toBase64(await readBlob(file, "buffer")) };
  }
  if (file.size > IMAGE_SOURCE_MAX_BYTES) return { error: `${name} is ${formatBytes(file.size)}; images can be up to ${formatBytes(IMAGE_SOURCE_MAX_BYTES)}.` };
  let blob: Blob = file;
  let mediaType = file.type || "image/png";
  // GIFs stay as they are (scaling would drop the animation); others are scaled when large.
  if (mediaType !== "image/gif" && file.size > IMAGE_MAX_BYTES) {
    const small = await shrinkImage(file);
    if (small) {
      blob = small;
      mediaType = small.type || mediaType;
    }
  }
  if (blob.size > IMAGE_MAX_BYTES) return { error: `${name} is ${formatBytes(blob.size)}; images can be up to ${formatBytes(IMAGE_MAX_BYTES)}.` };
  const previewUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : undefined;
  return { id, name, kind, mediaType, size: blob.size, data: toBase64(await readBlob(blob, "buffer")), ...(previewUrl ? { previewUrl } : {}) };
}

export function toPayload(a: Attachment): AttachmentPayload {
  const { id: _id, previewUrl: _p, notes: _n, ...rest } = a;
  return rest;
}
