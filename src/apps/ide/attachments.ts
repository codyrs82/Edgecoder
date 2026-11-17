// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Files attached to a message in the desktop composer (desktop/src/lib/attachments.ts): images,
 * text/code files and PDFs.
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
import { realPathEscape } from "./tool-executor.js";
import type { ChatMedia, ChatMessage } from "../../inference-api/types.js";

export const MAX_ATTACHMENTS = 5;
export const TEXT_MAX_BYTES = 200 * 1024;
export const IMAGE_MAX_BYTES = 3_700_000;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** Request body limit for routes that take attachments (base64 adds a third). */
export const ATTACHMENT_BODY_LIMIT = 48 * 1024 * 1024;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const b64 = (max: number) => z.string().max(Math.ceil((max * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, "not base64");

export const attachmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), name: z.string().min(1).max(200), mediaType: z.string().max(100), size: z.number().int().min(0), text: z.string().max(TEXT_MAX_BYTES) }),
  z.object({ kind: z.literal("image"), name: z.string().min(1).max(200), mediaType: z.enum(IMAGE_TYPES), size: z.number().int().min(0), data: b64(IMAGE_MAX_BYTES) }),
  z.object({ kind: z.literal("pdf"), name: z.string().min(1).max(200), mediaType: z.literal("application/pdf"), size: z.number().int().min(0), data: b64(PDF_MAX_BYTES) }),
]);
export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS);
export type AttachmentInput = z.infer<typeof attachmentSchema>;

/** What a bot's conversation keeps for an attachment: where it was saved (project-relative). */
export interface SavedAttachment {
  name: string;
  kind: AttachmentInput["kind"];
  size: number;
  /** Project-relative, `/` separators. */
  path: string;
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
 * is a symlink out of the root). Returns where each went.
 */
export function saveAttachments(root: string, list: AttachmentInput[], nowMs = Date.now()): SavedAttachment[] {
  if (list.length === 0) return [];
  const dir = join(root, ...ATTACHMENTS_DIR.split("/"));
  if (realPathEscape(root, dir)) throw new Error("The attachments folder points outside the bot's folder.");
  mkdirSync(dir, { recursive: true });
  if (realPathEscape(root, dir)) throw new Error("The attachments folder points outside the bot's folder.");
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return list.map((a) => {
    let file = join(dir, `${stamp(nowMs)}-${safeFileName(a.name)}`);
    if (existsSync(file)) file = join(dir, `${stamp(nowMs)}-${randomUUID().slice(0, 4)}-${safeFileName(a.name)}`);
    const bytes = a.kind === "text" ? Buffer.from(a.text, "utf8") : Buffer.from(a.data, "base64");
    writeFileSync(file, bytes, { flag: "wx" });
    return { name: a.name, kind: a.kind, size: bytes.length, path: relative(root, file).split(sep).join("/") };
  });
}

/** The line the conversation shows (and keeps) for a message's attachments. */
export function attachedLine(list: Array<{ name: string }>): string {
  return list.length ? `[Attached: ${list.map((a) => a.name).join(", ")}]` : "";
}

function fence(text: string): string {
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return ticks;
}

/**
 * What a model that can't see images or PDFs reads about a bot message's attachments. Text files
 * are inlined (read back from where they were saved) when `inline` is true, i.e. for messages the
 * bot hasn't answered yet; older ones get only the path, to keep each run's context small.
 */
export function savedAttachmentsText(root: string, list: SavedAttachment[], inline: boolean): string {
  return list
    .map((a) => {
      if (a.kind === "text" && inline) {
        let text: string | null = null;
        try {
          text = readFileSync(join(root, ...a.path.split("/")), "utf8").slice(0, TEXT_MAX_BYTES);
        } catch {
          // moved or deleted since: the path line below
        }
        if (text !== null) {
          const f = fence(text);
          return `Attached file ${a.name} (saved at ${a.path}):\n${f}\n${text}\n${f}`;
        }
      }
      if (a.kind === "text") return `[Attached file ${a.name}: saved at ${a.path}; read it with read_file.]`;
      const what = a.kind === "image" ? "image" : "PDF";
      return `[Attached ${what} ${a.name}: saved at ${a.path}. You can't see ${what === "image" ? "images" : "PDFs"}; say so if the request depends on its contents.]`;
    })
    .join("\n\n");
}

/** Images and PDFs as message parts, for a model that takes them. */
export function mediaParts(list: AttachmentInput[]): ChatMedia[] {
  return list.flatMap((a): ChatMedia[] => (a.kind === "text" ? [] : [{ kind: a.kind, mediaType: a.mediaType, data: a.data }]));
}

/** The chat's text for attachments: text files inline, and a note for each part the model won't see. */
export function chatAttachmentsText(list: AttachmentInput[], sees: { images: boolean; pdf: boolean }): string {
  return list
    .flatMap((a) => {
      if (a.kind === "text") {
        const f = fence(a.text);
        return [`Attached file ${a.name}:\n${f}\n${a.text}\n${f}`];
      }
      if ((a.kind === "image" && sees.images) || (a.kind === "pdf" && sees.pdf)) return [];
      return [`[Attached ${a.kind === "image" ? "image" : "PDF"} ${a.name}. This model can't see it; say so if the request depends on its contents.]`];
    })
    .join("\n\n");
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
 * The chat's messages with the composer's attachments on the last user message: text files inline;
 * images and PDFs as media parts only for a frontier model that takes them (no other backend ever
 * gets media), else a note naming each one.
 */
export function withAttachments(messages: Array<{ role: string; content: string }>, attachments: AttachmentInput[], model: string): Array<{ role: string; content: string; media?: ChatMedia[] }> {
  if (!attachments.length) return messages;
  const i = messages.map((m) => m.role).lastIndexOf("user");
  if (i < 0) return messages;
  const sees = frontierSees(model);
  const media = mediaParts(attachments).filter((m) => (m.kind === "image" ? sees.images : sees.pdf));
  const extra = chatAttachmentsText(attachments, sees);
  const out: Array<{ role: string; content: string; media?: ChatMedia[] }> = [...messages];
  out[i] = { ...messages[i], content: [messages[i].content, extra].filter((t) => t.trim()).join("\n\n"), ...(media.length ? { media } : {}) };
  return out;
}
