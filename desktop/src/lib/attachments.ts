// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Files attached in the composer (the + button, paste, drag and drop): images, text/code files and
 * PDFs, read in the browser and sent with the message.
 *
 * What a model gets depends on what it can take:
 *   - text/code files: always inlined into the message (fenced, with the file name);
 *   - images and PDFs: as image/document parts only for a model that can see them (a frontier lead
 *     on your own Anthropic key; images also on an OpenAI key). Any other model gets a note with
 *     the file name (and, for a bot, the path in its folder where the app saved it), never a
 *     silent drop. The composer says so before you send.
 */

export type AttachmentKind = "image" | "text" | "pdf";

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
}

/** What goes over the wire with a message (no preview URL). */
export type AttachmentPayload = Omit<Attachment, "id" | "previewUrl">;

export const MAX_ATTACHMENTS = 5;
/** Per text/code file: more than this is a file for the agent to read, not to paste in. */
export const TEXT_MAX_BYTES = 200 * 1024;
/** Per image as sent (Anthropic's API takes up to 5 MB of base64, about 3.75 MB of image). */
export const IMAGE_MAX_BYTES = 3_700_000;
/** An image file larger than this isn't even scaled down. */
export const IMAGE_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** Images are scaled so their long edge is at most this (what vision models use anyway). */
export const IMAGE_MAX_EDGE = 2000;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "env.example", "xml", "html", "htm", "css", "scss",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "svelte", "vue", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "proto", "lua", "pl", "r", "dart", "scala", "ex", "exs", "erl", "hs", "ml", "tf", "hcl",
  "log", "diff", "patch", "gitignore", "dockerfile", "makefile", "lock",
]);

/** The file picker's accept list. */
export const ACCEPT = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/*", ...[...TEXT_EXT].map((e) => `.${e}`)].join(",");

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
  if (file.type.startsWith("text/") || TEXT_EXT.has(ext(file.name)) || file.type === "application/json" || file.type === "application/xml") return "text";
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
    } else if ((a.kind === "image" && !vision.images) || (a.kind === "pdf" && !vision.pdf)) {
      parts.push(`[Attached ${a.kind === "image" ? "image" : "PDF"} ${a.name}, ${formatBytes(a.size)}${saved}. You can't see its contents; say so if the request depends on them.]`);
    }
  }
  return parts.join("\n\n");
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
  if (!kind) return { error: `${name}: only images (PNG, JPEG, GIF, WebP), text or code files and PDFs can be attached.` };
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
  const { id: _id, previewUrl: _p, ...rest } = a;
  return rest;
}
