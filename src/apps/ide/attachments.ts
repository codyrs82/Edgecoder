// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Files attached to a message in the desktop composer (desktop/src/lib/attachments.ts): images,
 * text/code files (CSV, Markdown, JSON, XML, HTML, logs and the like), PDFs, .zip archives and
 * Office documents (.docx/.xlsx/.pptx read as text; old .doc/.xls only by name).
 *
 * - Archives are opened here (Node), never in the webview, with the defensive reader in
 *   src/common/zip.ts (zip-slip, symlinks, zip bombs, encryption, ZIP64 all refused or left out).
 *   A bot gets the zip extracted into `.edgecoder/attachments/<name>/` plus a listing; the chat
 *   gets the files inside as attachments of their own, within the same limits, plus a listing that
 *   says which were left out and why.
 * - Office files: text from src/common/office-text.ts; a bot also gets a `.txt` beside the original.
 *
 * - A bot saves them into its folder (`.edgecoder/attachments/`, ignored by git) so it can read
 *   or use them with its tools, and the model gets text files inline plus the saved path of each.
 *   Bots never use a frontier key, so no bot model sees images or PDFs: it gets the name and path.
 * - The chat (/v1/ide/chat) passes images and PDFs as message parts only to a frontier model that
 *   takes them (frontier.ts); every other backend gets a note instead (see `withoutMedia`).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { ZipError, ZIP_LIMITS, extractZip, formatSize, openZip, type OpenedZip, type ZipSkip } from "../../common/zip.js";
import { isLegacyOffice, officeKind, officeText } from "../../common/office-text.js";
import { realPathEscape } from "./tool-executor.js";
import type { ChatMedia, ChatMessage } from "../../inference-api/types.js";

export const MAX_ATTACHMENTS = 5;
export const TEXT_MAX_BYTES = 200 * 1024;
export const IMAGE_MAX_BYTES = 3_700_000;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** A .zip as attached (what's inside has its own caps: ZIP_LIMITS). */
export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
/** A Word/Excel/PowerPoint file. */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
/** All attachments of one message together. */
export const MESSAGE_MAX_BYTES = 60 * 1024 * 1024;
/** Request body limit for routes that take attachments (base64 adds a third). */
export const ATTACHMENT_BODY_LIMIT = Math.ceil((MESSAGE_MAX_BYTES * 4) / 3) + 2 * 1024 * 1024;
/** From one archive, the chat inlines at most this much text in all (each file still TEXT_MAX_BYTES). */
export const ARCHIVE_INLINE_TEXT_BYTES = 400 * 1024;
/** Images/PDFs a frontier model gets from all of a message's archives, and their bytes. */
export const ARCHIVE_MEDIA_MAX = 5;
export const ARCHIVE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** Lines of an archive's listing a model reads (the rest: "and N more"). */
export const LISTING_MAX_LINES = 150;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const b64 = (max: number) => z.string().max(Math.ceil((max * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, "not base64");

export const attachmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), name: z.string().min(1).max(200), mediaType: z.string().max(100), size: z.number().int().min(0), text: z.string().max(TEXT_MAX_BYTES) }),
  z.object({ kind: z.literal("image"), name: z.string().min(1).max(200), mediaType: z.enum(IMAGE_TYPES), size: z.number().int().min(0), data: b64(IMAGE_MAX_BYTES) }),
  z.object({ kind: z.literal("pdf"), name: z.string().min(1).max(200), mediaType: z.literal("application/pdf"), size: z.number().int().min(0), data: b64(PDF_MAX_BYTES) }),
  z.object({ kind: z.literal("archive"), name: z.string().min(1).max(200), mediaType: z.string().max(100), size: z.number().int().min(0), data: b64(ARCHIVE_MAX_BYTES) }),
  z.object({ kind: z.literal("document"), name: z.string().min(1).max(200), mediaType: z.string().max(100), size: z.number().int().min(0), data: b64(DOCUMENT_MAX_BYTES) }),
]);
export const attachmentsSchema = z
  .array(attachmentSchema)
  .max(MAX_ATTACHMENTS)
  .refine((list) => list.reduce((n, a) => n + (a.kind === "text" ? a.text.length : (a.data.length * 3) / 4), 0) <= MESSAGE_MAX_BYTES, {
    message: `Attachments can be up to ${MESSAGE_MAX_BYTES / (1024 * 1024)} MB per message`,
  });
export type AttachmentInput = z.infer<typeof attachmentSchema>;

/** What a bot's conversation keeps for an attachment: where it was saved (project-relative). */
export interface SavedAttachment {
  name: string;
  kind: AttachmentInput["kind"];
  size: number;
  /** Project-relative, `/` separators. */
  path: string;
  /** archive: the folder it was extracted into (project-relative). */
  folder?: string;
  /** archive: files extracted (paths inside `folder`; the first LISTING_MAX_LINES are kept). */
  files?: Array<{ path: string; size: number }>;
  /** archive: how many files were extracted in all. */
  fileCount?: number;
  /** archive: entries left out, and why. */
  skipped?: ZipSkip[];
  /** document (and Office files in an archive): the extracted text, saved beside the original. */
  textPath?: string;
  /** document: why there's no text (an old binary format, or it couldn't be read). */
  note?: string;
}

/** An attachment that can't be taken as sent; the message is for the person who attached it. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Open an attached archive, or say (naming it) why it can't be. */
function openArchive(a: { name: string; data: string }): OpenedZip {
  try {
    return openZip(Buffer.from(a.data, "base64"), ZIP_LIMITS);
  } catch (err) {
    if (err instanceof ZipError) throw new AttachmentError(`${a.name}: ${err.message}`);
    throw err;
  }
}

/** A folder name for an extracted archive: the zip's name without `.zip`. */
function archiveFolderName(name: string): string {
  return safeFileName(name).replace(/\.zip$/i, "") || "archive";
}

/** Write the text of an Office file beside it (`report.docx.txt`); its project-relative path, or null. */
function saveOfficeText(root: string, file: string, name: string, bytes: Buffer): { textPath?: string; note?: string } {
  const kind = officeKind(name);
  if (!kind) return isLegacyOffice(name) ? { note: "an old binary Office format, which can't be read as text; save it as .docx/.xlsx/.pptx to have it read" } : {};
  try {
    const text = officeText(kind, bytes);
    const txt = `${file}.txt`;
    writeFileSync(txt, text, { flag: "wx" });
    return { textPath: relative(root, txt).split(sep).join("/") };
  } catch {
    return { note: "its text couldn't be read" };
  }
}

export const ATTACHMENTS_DIR = ".edgecoder/attachments";

/** A file name safe to write: no separators, control characters or leading dots; at most 100 chars. */
export function safeFileName(name: string): string {
  const base = name.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_").replace(/^[.\s]+/, "").trim();
  const s = cleaned || "attachment";
  if (s.length <= 100) return s;
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
  return s.slice(0, 100 - ext.length) + ext;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Save attachments into `root/.edgecoder/attachments/` (never overwriting; refusing a folder that
 * is a symlink out of the root). A .zip is saved and extracted into a folder beside it named after
 * it; an Office file gets its text in a `.txt` beside it. Returns where each went. Archives are
 * checked before anything is written: one that can't be opened throws an AttachmentError.
 */
export function saveAttachments(root: string, list: AttachmentInput[], nowMs = Date.now()): SavedAttachment[] {
  if (list.length === 0) return [];
  const opened = new Map<AttachmentInput, OpenedZip>();
  for (const a of list) if (a.kind === "archive") opened.set(a, openArchive(a));
  const dir = join(root, ...ATTACHMENTS_DIR.split("/"));
  if (realPathEscape(root, dir)) throw new Error("The attachments folder points outside the bot's folder.");
  mkdirSync(dir, { recursive: true });
  if (realPathEscape(root, dir)) throw new Error("The attachments folder points outside the bot's folder.");
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const rel = (abs: string) => relative(root, abs).split(sep).join("/");
  return list.map((a): SavedAttachment => {
    let file = join(dir, `${stamp(nowMs)}-${safeFileName(a.name)}`);
    if (existsSync(file)) file = join(dir, `${stamp(nowMs)}-${randomUUID().slice(0, 4)}-${safeFileName(a.name)}`);
    const bytes = a.kind === "text" ? Buffer.from(a.text, "utf8") : Buffer.from(a.data, "base64");
    writeFileSync(file, bytes, { flag: "wx" });
    const saved: SavedAttachment = { name: a.name, kind: a.kind, size: bytes.length, path: rel(file) };
    if (a.kind === "document") return { ...saved, ...saveOfficeText(root, file, a.name, bytes) };
    if (a.kind !== "archive") return saved;
    // .edgecoder/attachments/<name>/, or <name>-2/ and so on when that is taken.
    const base = archiveFolderName(a.name);
    let folder = join(dir, base);
    for (let n = 2; existsSync(folder); n++) folder = join(dir, `${base}-${n}`);
    mkdirSync(folder);
    writeFileSync(join(folder, ".gitignore"), "*\n", { flag: "wx" });
    const out = extractZip(opened.get(a)!, folder, [".gitignore"]);
    // Office files inside get their text beside them too.
    for (const f of out.files) {
      if (officeKind(f.path)) {
        try {
          saveOfficeText(root, join(folder, ...f.path.split("/")), f.path, readFileSync(join(folder, ...f.path.split("/"))));
        } catch {
          // best effort
        }
      }
    }
    return { ...saved, folder: rel(folder), files: out.files.slice(0, LISTING_MAX_LINES), fileCount: out.files.length, skipped: out.skipped.slice(0, LISTING_MAX_LINES) };
  });
}

/** The line the conversation shows (and keeps) for a message's attachments. */
export function attachedLine(list: Array<{ name: string; fileCount?: number; skipped?: unknown[] }>): string {
  const label = (a: { name: string; fileCount?: number; skipped?: unknown[] }) => {
    if (a.fileCount === undefined) return a.name;
    const left = a.skipped?.length ? `; ${a.skipped.length} left out` : "";
    return `${a.name} (${a.fileCount} file${a.fileCount === 1 ? "" : "s"}${left})`;
  };
  return list.length ? `[Attached: ${list.map(label).join(", ")}]` : "";
}

function fence(text: string): string {
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return ticks;
}

/** A fenced block of a file's text, capped at TEXT_MAX_BYTES (saying so when cut). */
function fenced(label: string, text: string): string {
  const cut = Buffer.byteLength(text, "utf8") > TEXT_MAX_BYTES;
  const body = cut ? Buffer.from(text, "utf8").subarray(0, TEXT_MAX_BYTES).toString("utf8").replace(/�$/, "") : text;
  const f = fence(body);
  return `${label}:\n${f}\n${body}\n${f}${cut ? `\n[Cut at ${formatSize(TEXT_MAX_BYTES)}; the rest isn't shown.]` : ""}`;
}

function readSaved(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, ...path.split("/")), "utf8");
  } catch {
    return null; // moved or deleted since
  }
}

function listing(files: Array<{ path: string; size: number }>, total: number, more: string): string {
  const lines = files.slice(0, LISTING_MAX_LINES).map((f) => `- ${f.path} (${formatSize(f.size)})`);
  if (total > lines.length) lines.push(`- … and ${total - lines.length} more (${more})`);
  return lines.join("\n");
}

function skippedLines(skipped: ZipSkip[]): string {
  return skipped.length ? `\nLeft out:\n${skipped.map((s) => `- ${s.path}: ${s.reason}`).join("\n")}` : "";
}

/**
 * What a model that can't see images or PDFs reads about a bot message's attachments. Text files
 * (and the text of Office files) are inlined (read back from where they were saved) when `inline`
 * is true, i.e. for messages the bot hasn't answered yet; older ones get only the path, to keep
 * each run's context small. An archive is its folder and a listing of what's in it.
 */
export function savedAttachmentsText(root: string, list: SavedAttachment[], inline: boolean): string {
  return list
    .map((a) => {
      if (a.kind === "text" && inline) {
        const text = readSaved(root, a.path);
        if (text !== null) return fenced(`Attached file ${a.name} (saved at ${a.path})`, text);
      }
      if (a.kind === "text") return `[Attached file ${a.name}: saved at ${a.path}; read it with read_file.]`;
      if (a.kind === "archive") {
        const n = a.fileCount ?? a.files?.length ?? 0;
        const head = `[Attached zip ${a.name}: saved at ${a.path} and extracted into ${a.folder}/ (${n} file${n === 1 ? "" : "s"}). Read the files with read_file at ${a.folder}/<path>; Word, Excel and PowerPoint files have their text in a .txt beside them. You can't see images or PDFs.]`;
        return `${head}\n${listing(a.files ?? [], n, `list them with list_directory`)}${skippedLines(a.skipped ?? [])}`;
      }
      if (a.kind === "document") {
        if (a.textPath && inline) {
          const text = readSaved(root, a.textPath);
          if (text !== null) return fenced(`Attached document ${a.name} (saved at ${a.path}; its text, below, at ${a.textPath})`, text);
        }
        if (a.textPath) return `[Attached document ${a.name}: saved at ${a.path}; its text is at ${a.textPath}, read it with read_file.]`;
        return `[Attached document ${a.name}: saved at ${a.path}. ${a.note ? `It is ${a.note}.` : "Its text couldn't be read."}]`;
      }
      const what = a.kind === "image" ? "image" : "PDF";
      return `[Attached ${what} ${a.name}: saved at ${a.path}. You can't see ${what === "image" ? "images" : "PDFs"}; say so if the request depends on its contents.]`;
    })
    .join("\n\n");
}

// --- the chat ---

/** Extensions read as text (keep in step with TEXT_EXT in desktop/src/lib/attachments.ts). */
export const TEXT_EXT = new Set([
  "txt", "text", "md", "markdown", "rst", "adoc", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "xml", "html", "htm", "xhtml", "svg", "css", "scss", "less", "rtf", "tex", "bib", "srt", "vtt", "ics", "vcf", "eml",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "svelte", "vue", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "proto", "lua", "pl", "r", "dart", "scala", "ex", "exs", "erl", "hs", "ml", "tf", "hcl",
  "log", "out", "diff", "patch", "gitignore", "dockerfile", "makefile", "lock",
]);

const IMAGE_EXT: Record<string, (typeof IMAGE_TYPES)[number]> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

function extOf(path: string): string {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (base === "dockerfile" || base === "makefile") return base;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1) : "";
}

/** What the chat sends for a message's attachments: text to add, and media for a model that sees it. */
export interface ChatAttachments {
  text: string;
  media: ChatMedia[];
}

/** A note for a document the chat can't read, and the text of one it can. */
function documentForChat(name: string, bytes: Buffer): string {
  const kind = officeKind(name);
  if (!kind) {
    return isLegacyOffice(name)
      ? `[Attached document ${name}: an old binary Office format, which can't be read here. Say so, and suggest saving it as .docx/.xlsx/.pptx and attaching that.]`
      : `[Attached document ${name}. Its contents can't be read here.]`;
  }
  try {
    return fenced(`Attached document ${name} (its text)`, officeText(kind, bytes));
  } catch {
    return `[Attached document ${name}. Its text couldn't be read; say so if the request depends on it.]`;
  }
}

/**
 * The files inside an archive as the chat's attachments: text, code and Office text inlined (each
 * up to TEXT_MAX_BYTES, ARCHIVE_INLINE_TEXT_BYTES in all), images and PDFs as media for a model that
 * sees them (within the image/PDF limits), everything else listed. Always starts with a listing
 * that says which files were included and which were left out, and why.
 */
function archiveForChat(a: { name: string; data: string }, sees: { images: boolean; pdf: boolean }, media: ChatMedia[], mediaBytes: { n: number }): string {
  let zip: OpenedZip;
  try {
    zip = openArchive(a);
  } catch (err) {
    return `[Attached zip ${(err as Error).message} Tell the user.]`;
  }
  const files = [...zip.files].sort((x, y) => x.path.localeCompare(y.path, "en", { numeric: true }));
  const rows: string[] = [];
  const blocks: string[] = [];
  let textBytes = 0;
  const leftOut: ZipSkip[] = [...zip.skipped];
  for (const f of files) {
    const ext = extOf(f.path);
    const label = `${a.name}/${f.path}`;
    const row = (what: string) => rows.push(`- ${f.path} (${formatSize(f.size)})${what ? ` — ${what}` : ""}`);
    const skip = (reason: string) => {
      row(`left out: ${reason}`);
      leftOut.push({ path: f.path, reason });
    };
    const textBudget = () => textBytes + f.size <= ARCHIVE_INLINE_TEXT_BYTES;
    try {
      if (TEXT_EXT.has(ext)) {
        if (f.size > TEXT_MAX_BYTES) skip(`over ${formatSize(TEXT_MAX_BYTES)}`);
        else if (!textBudget()) skip(`past the ${formatSize(ARCHIVE_INLINE_TEXT_BYTES)} of text shown from one archive`);
        else {
          const text = f.read().toString("utf8");
          if (text.includes("\u0000")) skip("binary, not text");
          else {
            textBytes += f.size;
            blocks.push(fenced(`File ${label}`, text));
            row("below");
          }
        }
      } else if (officeKind(f.path)) {
        if (textBytes >= ARCHIVE_INLINE_TEXT_BYTES) skip(`past the ${formatSize(ARCHIVE_INLINE_TEXT_BYTES)} of text shown from one archive`);
        else {
          const block = documentForChat(label, f.read());
          textBytes += Math.min(Buffer.byteLength(block, "utf8"), TEXT_MAX_BYTES);
          blocks.push(block);
          row("its text below");
        }
      } else if (IMAGE_EXT[ext] || ext === "pdf") {
        const isImage = !!IMAGE_EXT[ext];
        const max = isImage ? IMAGE_MAX_BYTES : PDF_MAX_BYTES;
        if (!(isImage ? sees.images : sees.pdf)) row(`this model can't see ${isImage ? "images" : "PDFs"}`);
        else if (f.size > max) skip(`over ${formatSize(max)} for ${isImage ? "an image" : "a PDF"}`);
        else if (media.length >= ARCHIVE_MEDIA_MAX || mediaBytes.n + f.size > ARCHIVE_MEDIA_MAX_BYTES) skip(`past the ${ARCHIVE_MEDIA_MAX} images/PDFs per message`);
        else {
          media.push({ kind: isImage ? "image" : "pdf", mediaType: isImage ? IMAGE_EXT[ext] : "application/pdf", data: f.read().toString("base64") });
          mediaBytes.n += f.size;
          row(`attached as ${isImage ? "an image" : "a PDF"}`);
        }
      } else if (ext === "zip") row("a zip inside the zip; not opened");
      else if (isLegacyOffice(f.path)) row("an old binary Office format; can't be read here (save it as .docx/.xlsx/.pptx)");
      else row("can't be shown here");
    } catch (err) {
      if (err instanceof ZipError) skip(err.message.replace(/^.*? is damaged/, "damaged"));
      else throw err;
    }
  }
  const shown = rows.slice(0, LISTING_MAX_LINES);
  if (rows.length > shown.length) shown.push(`- … and ${rows.length - shown.length} more`);
  const skippedOnly = zip.skipped.map((s) => `- ${s.path} — left out: ${s.reason}`);
  const left = leftOut.length ? ` ${leftOut.length} left out (see below).` : "";
  const head = `[Attached zip ${a.name}: ${files.length} file${files.length === 1 ? "" : "s"}, ${formatSize(zip.totalBytes)} uncompressed.${left} Contents:]`;
  return [[head, ...shown, ...skippedOnly].join("\n"), ...blocks].join("\n\n");
}

/** The chat's text and media for attachments: text inline, media only for what the model sees, a note for the rest. */
export function chatAttachments(list: AttachmentInput[], sees: { images: boolean; pdf: boolean }): ChatAttachments {
  const media: ChatMedia[] = [];
  const parts: string[] = [];
  const mediaBytes = { n: 0 };
  for (const a of list) {
    if (a.kind === "text") parts.push(fenced(`Attached file ${a.name}`, a.text));
    else if (a.kind === "archive") parts.push(archiveForChat(a, sees, media, mediaBytes));
    else if (a.kind === "document") parts.push(documentForChat(a.name, Buffer.from(a.data, "base64")));
    else if ((a.kind === "image" && sees.images) || (a.kind === "pdf" && sees.pdf)) media.push({ kind: a.kind, mediaType: a.mediaType, data: a.data });
    else parts.push(`[Attached ${a.kind === "image" ? "image" : "PDF"} ${a.name}. This model can't see it; say so if the request depends on its contents.]`);
  }
  return { text: parts.join("\n\n"), media };
}

/** What a frontier model id can take besides text (Anthropic: images and PDFs; OpenAI: images). */
export function frontierSees(modelId: string): { images: boolean; pdf: boolean } {
  const provider = modelId.startsWith("frontier/") ? modelId.split("/")[1] : "";
  if (provider === "anthropic") return { images: true, pdf: true };
  if (provider === "openai") return { images: true, pdf: false };
  return { images: false, pdf: false };
}

/** The messages without media parts (for any backend that doesn't take them). */
export function withoutMedia<M extends Pick<ChatMessage, "media">>(messages: M[]): M[] {
  return messages.some((m) => m.media?.length) ? messages.map((m) => (m.media ? (({ media: _m, ...rest }) => rest as M)(m) : m)) : messages;
}

/**
 * The chat's messages with the composer's attachments on the last user message: text files (and
 * the text of Office files and of text files in archives) inline; images and PDFs as media parts
 * only for a frontier model that takes them (no other backend ever gets media), else a note naming
 * each one.
 */
export function withAttachments(messages: Array<{ role: string; content: string }>, attachments: AttachmentInput[], model: string): Array<{ role: string; content: string; media?: ChatMedia[] }> {
  if (!attachments.length) return messages;
  const i = messages.map((m) => m.role).lastIndexOf("user");
  if (i < 0) return messages;
  const { text, media } = chatAttachments(attachments, frontierSees(model));
  const out: Array<{ role: string; content: string; media?: ChatMedia[] }> = [...messages];
  out[i] = { ...messages[i], content: [messages[i].content, text].filter((t) => t.trim()).join("\n\n"), ...(media.length ? { media } : {}) };
  return out;
}
