import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZIP_LIMITS, ZipError, extractZip, openZip, safeEntryPath } from "../../src/common/zip.js";
import { officeKind, officeText } from "../../src/common/office-text.js";
import { makeDocx, makePptx, makeXlsx, makeZip } from "../helpers/make-zip.js";

const made: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "zip-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const read = (buf: Buffer) => Object.fromEntries(openZip(buf).files.map((f) => [f.path, f.read().toString("utf8")]));

describe("zip reader", () => {
  it("reads stored and deflated entries", () => {
    const text = "lease ".repeat(1000);
    const zip = makeZip([
      { name: "stored.txt", data: "plain", method: 0 },
      { name: "deflated.txt", data: text, method: 8 },
    ]);
    expect(read(zip)).toEqual({ "stored.txt": "plain", "deflated.txt": text });
    const opened = openZip(zip);
    expect(opened.files.find((f) => f.path === "deflated.txt")!.compressedSize).toBeLessThan(text.length);
    expect(opened.totalBytes).toBe(5 + text.length);
  });

  it("reads a directory tree and extracts it", () => {
    const zip = makeZip([
      { name: "Ozarks/" },
      { name: "Ozarks/Leases/" },
      { name: "Ozarks/Leases/unit-1.txt", data: "Unit 1" },
      { name: "Ozarks/ESAs/esa.md", data: "# ESA" },
      { name: "Ozarks/Empty/" },
    ]);
    const opened = openZip(zip);
    expect(opened.dirs).toEqual(["Ozarks", "Ozarks/Leases", "Ozarks/Empty"]);
    const target = join(dir(), "out");
    const out = extractZip(opened, target);
    expect(out.files.map((f) => f.path)).toEqual(["Ozarks/Leases/unit-1.txt", "Ozarks/ESAs/esa.md"]);
    expect(readFileSync(join(target, "Ozarks", "ESAs", "esa.md"), "utf8")).toBe("# ESA");
    expect(existsSync(join(target, "Ozarks", "Empty"))).toBe(true);
  });

  it("decodes unicode names: UTF-8 flag, unflagged UTF-8 and CP437", () => {
    const zip = makeZip([
      { name: "Café/Résumé — 東京.txt", data: "a" },
      { name: "x", rawName: Buffer.from("naïve.txt", "utf8"), noUtf8Flag: true, data: "b" },
      { name: "x", rawName: Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]), noUtf8Flag: true, data: "c" }, // "é.txt" in CP437
    ]);
    expect(Object.keys(read(zip))).toEqual(["Café/Résumé — 東京.txt", "naïve.txt", "é.txt"]);
  });

  it("skips __MACOSX and .DS_Store", () => {
    const zip = makeZip([
      { name: "a.txt", data: "a" },
      { name: "__MACOSX/._a.txt", data: "junk" },
      { name: "sub/.DS_Store", data: "junk" },
      { name: ".DS_Store", data: "junk" },
    ]);
    const opened = openZip(zip);
    expect(opened.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(opened.skipped).toEqual([]);
  });

  it("refuses zip-slip paths: .., absolute, drive letters, backslashes, NUL", () => {
    for (const name of ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:\\Windows\\evil.txt", "c:evil.txt", "..\\..\\evil.txt", "a\\..\\..\\evil.txt", "\\\\server\\share\\x", "a/\u0000/b", "a/.../b"]) {
      expect(() => safeEntryPath(name), name).toThrow(ZipError);
      const target = join(dir(), "out");
      expect(() => extractZip(openZip(makeZip([{ name: "ok.txt", data: "ok" }, { name, data: "x" }])), target), name).toThrow(/outside its folder/);
      // Checked before anything is written.
      expect(existsSync(target)).toBe(false);
    }
    expect(safeEntryPath("./a//b/./c.txt")).toBe("a/b/c.txt");
    // Names that merely start with dots are fine.
    const target = join(dir(), "dots");
    expect(extractZip(openZip(makeZip([{ name: "..notes.txt", data: "n" }])), target).files.map((f) => f.path)).toEqual(["..notes.txt"]);
    expect(safeEntryPath("dir\\file.txt")).toBe("dir/file.txt");
    expect(safeEntryPath('we:ird*"name.txt')).toBe("we_ird__name.txt");
  });

  it("never extracts a symlink entry", () => {
    const zip = makeZip([
      { name: "link", data: "/etc/passwd", symlink: true },
      { name: "real.txt", data: "r" },
    ]);
    const opened = openZip(zip);
    expect(opened.skipped).toEqual([{ path: "link", reason: "a symbolic link; links aren't extracted" }]);
    const target = join(dir(), "out");
    extractZip(opened, target);
    expect(readdirSync(target)).toEqual(["real.txt"]);
  });

  it("refuses a zip bomb by compression ratio, and data that inflates past its declared size", () => {
    const bomb = makeZip([{ name: "zeros.bin", data: Buffer.alloc(5 * 1024 * 1024) }]);
    expect(() => openZip(bomb)).toThrow(/zip bomb/);
    // A header that lies about the size: inflation stops at the declared size.
    const liar = makeZip([{ name: "small.txt", data: "x".repeat(5000), declaredSize: 10 }]);
    expect(() => openZip(liar).files[0].read()).toThrow(/expands past its declared size/);
  });

  it("caps files, total size and entry count", () => {
    const limits = { ...ZIP_LIMITS, maxFileBytes: 100, maxTotalBytes: 150, maxEntries: 5 };
    const rnd = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251));
    const opened = openZip(makeZip([{ name: "big.bin", data: rnd(101) }, { name: "a.bin", data: rnd(80) }, { name: "b.bin", data: rnd(80) }]), limits);
    expect(opened.files.map((f) => f.path)).toEqual(["a.bin"]);
    expect(opened.skipped.map((s) => s.path)).toEqual(["big.bin", "b.bin"]);
    expect(opened.skipped[0].reason).toMatch(/files can be up to/);
    expect(opened.skipped[1].reason).toMatch(/total for one archive/);
    const many = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: "x" })));
    expect(() => openZip(many, limits)).toThrow(/6 entries; archives can have up to 5/);
  });

  it("refuses encrypted entries and ZIP64, and isn't fooled by garbage", () => {
    expect(() => openZip(makeZip([{ name: "secret.txt", data: "x", encrypted: true }]))).toThrow(/password-protected/);
    expect(() => openZip(makeZip([{ name: "a.txt", data: "x" }], { zip64Locator: true }))).toThrow(/ZIP64/);
    expect(() => openZip(makeZip([{ name: "a.txt", data: "x" }], { count: 0xffff }))).toThrow(/ZIP64/);
    expect(() => openZip(Buffer.from("not a zip at all, just some text here"))).toThrow(/isn't a zip/);
    const unsupported = openZip(makeZip([{ name: "a.txt", data: "x", method: 12 }]));
    expect(unsupported.skipped[0].reason).toMatch(/method EdgeCoder can't read \(12\)/);
  });

  it("detects corrupted data by checksum", () => {
    const zip = makeZip([{ name: "a.txt", data: "hello", method: 0 }]);
    zip[30 + "a.txt".length] ^= 0xff; // flip the first data byte
    expect(() => openZip(zip).files[0].read()).toThrow(/checksum/);
  });

  it("never overwrites: a second file with the same name (any case) is left out", () => {
    const opened = openZip(makeZip([{ name: "Lease.txt", data: "1" }, { name: "lease.txt", data: "2" }]));
    expect(opened.skipped).toEqual([{ path: "lease.txt", reason: "a second file with the same name" }]);
  });
});

describe("Office text", () => {
  it("reads a .docx's paragraphs", () => {
    expect(officeKind("Lease.DOCX")).toBe("docx");
    expect(officeText("docx", makeDocx(["Residential Lease", "Rent: $1,250 & utilities", "Pets <none>"]))).toBe("Residential Lease\nRent: $1,250 & utilities\nPets <none>\nA\tB");
  });

  it("reads each .xlsx sheet as CSV-like rows", () => {
    expect(officeText("xlsx", makeXlsx())).toBe('--- Sheet: Leases ---\nTenant,Rent\n"Smith, J.",,1250.5\n\n--- Sheet: ESAs & Notes ---\nDue,TRUE');
  });

  it("reads a .pptx's slides in order", () => {
    expect(officeText("pptx", makePptx())).toBe("--- Slide 1 ---\nOzarks portfolio\n\n--- Slide 2 ---\nQ3 rent roll\nOccupancy 96%\n\n--- Slide 3 ---\nTen");
  });

  it("throws on a file that isn't one", () => {
    expect(() => officeText("docx", makeZip([{ name: "a.txt", data: "x" }]))).toThrow();
    expect(() => officeText("xlsx", Buffer.from("nope"))).toThrow();
  });
});
