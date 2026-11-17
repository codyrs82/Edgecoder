// Builds small ZIP files at test time (no binary fixtures): stored or deflated entries, folders,
// symlinks, encrypted flags, lying sizes and a ZIP64 locator, for the ZIP reader's tests.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../../src/common/zip.js";

export interface ZipSpec {
  name: string;
  data?: Buffer | string;
  /** 0 stored, 8 deflate (default), or anything else to test unsupported methods. */
  method?: number;
  /** Mark as a symbolic link (unix mode 0120777); `data` is the link target. */
  symlink?: boolean;
  /** Set the "encrypted" flag. */
  encrypted?: boolean;
  /** Leave the UTF-8 flag off (names in CP437 / raw bytes). */
  noUtf8Flag?: boolean;
  /** Raw name bytes (overrides `name`). */
  rawName?: Buffer;
  /** Declared uncompressed size (to lie). */
  declaredSize?: number;
}

export function makeZip(entries: ZipSpec[], opts: { zip64Locator?: boolean; count?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const isDir = e.name.endsWith("/");
    const method = isDir ? 0 : (e.method ?? 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = e.rawName ?? Buffer.from(e.name, "utf8");
    const flags = (e.encrypted ? 1 : 0) | (e.noUtf8Flag ? 0 : 0x800);
    const crc = crc32(data);
    const usize = e.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(name.length, 28);
    const mode = e.symlink ? 0o120777 : isDir ? 0o040755 : 0o100644;
    c.writeUInt32LE((mode << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const parts = [...locals, cd];
  if (opts.zip64Locator) {
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    parts.push(loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = opts.count ?? entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A minimal .docx with these paragraphs. */
export function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:pPr/><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`).join("");
  return makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t></w:r></w:p></w:body></w:document>` },
  ]);
}

/** A minimal .xlsx: two sheets, shared and inline strings, numbers and a gap. */
export function makeXlsx(): Buffer {
  return makeZip([
    { name: "xl/workbook.xml", data: '<workbook xmlns:r="r"><sheets><sheet name="Leases" sheetId="1" r:id="rId1"/><sheet name="ESAs &amp; Notes" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="styles.xml"/></Relationships>' },
    { name: "xl/sharedStrings.xml", data: "<sst><si><t>Tenant</t></si><si><t>Rent</t></si><si><r><t>Smith, </t></r><r><t>J.</t></r></si></sst>" },
    { name: "xl/worksheets/sheet1.xml", data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1250.5</v></c></row></sheetData></worksheet>' },
    { name: "xl/worksheets/sheet2.xml", data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Due</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>' },
  ]);
}

/** A minimal .pptx with two slides (stored out of order in the zip). */
export function makePptx(): Buffer {
  const slide = (texts: string[]) => `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${texts.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`;
  return makeZip([
    { name: "ppt/slides/slide10.xml", data: slide(["Ten"]) },
    { name: "ppt/slides/slide2.xml", data: slide(["Q3 rent roll", "Occupancy 96%"]) },
    { name: "ppt/slides/slide1.xml", data: slide(["Ozarks portfolio"]) },
  ]);
}
