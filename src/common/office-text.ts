// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Plain text from Word, Excel and PowerPoint files (.docx, .xlsx, .pptx), best effort. They are
 * zips of XML, read with the same defensive reader as attached archives (zip.ts):
 *   - .docx: the paragraphs of word/document.xml (tabs and line breaks kept);
 *   - .xlsx: each sheet as comma-separated rows (shared strings, inline strings and values);
 *   - .pptx: each slide's text, in slide order.
 * Throws when the file can't be read; the caller then attaches it by name or path instead.
 */

import { ZIP_LIMITS, openZip, type OpenedZip, type ZipFileEntry } from "./zip.js";

export type OfficeKind = "docx" | "xlsx" | "pptx";

/** The Office kind of a file name we can read as text, or null. */
export function officeKind(name: string): OfficeKind | null {
  const m = /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i.exec(name);
  if (!m) return null;
  return `${m[1].toLowerCase().slice(0, 3)}x` as OfficeKind;
}

/** Old binary Office formats (Word 97-2003 and the like): saved, but not readable here. */
export function isLegacyOffice(name: string): boolean {
  return /\.(doc|xls|ppt)$/i.test(name);
}

/** XML of one part, capped (Office parts can be large; text is what we want). */
const XML_MAX = 20 * 1024 * 1024;

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  });
}

/**
 * Text of the runs in a WordprocessingML / DrawingML part: `<x:t>` content, with `<x:p>` ending a
 * paragraph and tabs/breaks kept. `ns` is the prefix ("w" for Word, "a" for slides).
 */
function runsText(xml: string, ns: string): string {
  const out: string[] = [];
  let para = "";
  const re = new RegExp(`<(/?)${ns}:(t|p|tab|br|cr)\\b([^>]*)>`, "g");
  let m: RegExpExecArray | null;
  let inText = false;
  let textStart = 0;
  while ((m = re.exec(xml))) {
    const [, close, tag, rest] = m;
    const selfClosing = rest.endsWith("/");
    if (tag === "t") {
      if (!close && !selfClosing) {
        inText = true;
        textStart = re.lastIndex;
      } else if (close && inText) {
        para += decodeXml(xml.slice(textStart, m.index));
        inText = false;
      }
    } else if (tag === "p" && (close || selfClosing)) {
      out.push(para);
      para = "";
    } else if (tag === "tab" && !close) para += "\t";
    else if ((tag === "br" || tag === "cr") && !close) para += "\n";
  }
  if (para) out.push(para);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function part(zip: OpenedZip, path: string): ZipFileEntry | undefined {
  return zip.files.find((f) => f.path === path);
}

function xmlOf(f: ZipFileEntry | undefined): string | null {
  if (!f || f.size > XML_MAX) return null;
  return f.read().toString("utf8");
}

function docxText(zip: OpenedZip): string {
  const xml = xmlOf(part(zip, "word/document.xml"));
  if (xml === null) throw new Error("no word/document.xml");
  return runsText(xml, "w");
}

const naturalOrder = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function pptxText(zip: OpenedZip): string {
  const slides = zip.files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.path)).sort((a, b) => naturalOrder(a.path, b.path));
  if (!slides.length) throw new Error("no slides");
  return slides.map((s, i) => `--- Slide ${i + 1} ---\n${runsText(xmlOf(s) ?? "", "a")}`).join("\n\n");
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** All `<t>` text inside a fragment (shared strings and inline strings may have several runs). */
function tText(fragment: string): string {
  let s = "";
  for (const m of fragment.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) s += decodeXml(m[1] ?? "");
  return s;
}

function xlsxText(zip: OpenedZip): string {
  const shared: string[] = [];
  const ss = xmlOf(part(zip, "xl/sharedStrings.xml"));
  if (ss) for (const m of ss.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(tText(m[1]));

  // Sheet names and files, in workbook order (falling back to sheetN.xml order).
  const sheets: Array<{ name: string; path: string }> = [];
  const wb = xmlOf(part(zip, "xl/workbook.xml"));
  const rels = xmlOf(part(zip, "xl/_rels/workbook.xml.rels"));
  if (wb && rels) {
    const targets = new Map<string, string>();
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
      const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
      if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
    for (const m of wb.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
      const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? "");
      const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1] ?? /\bid="([^"]*)"/.exec(m[1])?.[1];
      const path = rid ? targets.get(rid) : undefined;
      if (path && part(zip, path)) sheets.push({ name: name || path, path });
    }
  }
  if (!sheets.length) {
    for (const f of zip.files.filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f.path)).sort((a, b) => naturalOrder(a.path, b.path))) {
      sheets.push({ name: f.path.replace(/^.*\/|\.xml$/g, ""), path: f.path });
    }
  }
  if (!sheets.length) throw new Error("no sheets");

  return sheets
    .map(({ name, path }) => {
      const xml = xmlOf(part(zip, path)) ?? "";
      const lines: string[] = [];
      for (const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
        const cells: string[] = [];
        for (const c of (row[1] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
          const attrs = c[1];
          const body = c[2] ?? "";
          const ref = /\br="([A-Z]+)\d*"/.exec(attrs)?.[1];
          const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
          const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
          let value = "";
          if (type === "s") value = shared[Number(v)] ?? "";
          else if (type === "inlineStr") value = tText(body);
          else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
          else value = v !== undefined ? decodeXml(v) : "";
          const at = ref ? colIndex(ref) : cells.length;
          while (cells.length < at) cells.push("");
          cells[at] = csvCell(value);
        }
        while (cells.length && cells[cells.length - 1] === "") cells.pop();
        lines.push(cells.join(","));
      }
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      return `--- Sheet: ${name} ---\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** Plain text of a .docx/.xlsx/.pptx (from its bytes, or an already opened zip). Throws when it can't. */
export function officeText(kind: OfficeKind, file: Buffer | OpenedZip): string {
  const zip = Buffer.isBuffer(file) ? openZip(file, ZIP_LIMITS) : file;
  if (kind === "docx") return docxText(zip);
  if (kind === "xlsx") return xlsxText(zip);
  return pptxText(zip);
}
