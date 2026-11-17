import { describe, expect, it } from "vitest";
import { ACCEPT, attachmentLabel, attachmentsText, chipLabel, classify, scanZip, visionFor, visionNote } from "../src/lib/attachments";
import { makeZip } from "../../tests/helpers/make-zip";
import { botPlacement } from "../src/lib/bots";
import type { IdeStreamEvent } from "../src/lib/api";

describe("attachments", () => {
  it("classifies images, PDFs and text/code by type or extension", () => {
    expect(classify({ name: "a.png", type: "image/png" })).toBe("image");
    expect(classify({ name: "r.pdf", type: "" })).toBe("pdf");
    expect(classify({ name: "main.rs", type: "" })).toBe("text");
    expect(classify({ name: "Dockerfile", type: "" })).toBe("text");
    expect(classify({ name: "a.exe", type: "application/octet-stream" })).toBeNull();
    expect(classify({ name: "a.svg", type: "image/svg+xml" })).toBeNull();
  });

  it("classifies zips, Office documents and business text files", () => {
    expect(classify({ name: "Ozarks_Leases_and_ESAs.zip", type: "application/zip" })).toBe("archive");
    expect(classify({ name: "x.ZIP", type: "" })).toBe("archive");
    expect(classify({ name: "a", type: "application/x-zip-compressed" })).toBe("archive");
    for (const n of ["Lease.docx", "Rent.xlsx", "Deck.pptx", "Old.doc", "Old.xls"]) expect(classify({ name: n, type: "" })).toBe("document");
    for (const n of ["a.csv", "a.tsv", "a.md", "a.json", "a.xml", "a.rtf", "a.html", "a.log"]) expect(classify({ name: n, type: "" })).toBe("text");
    expect(classify({ name: "letter", type: "application/rtf" })).toBe("text");
    for (const e of [".zip", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".csv", ".rtf", "application/pdf"]) expect(ACCEPT.split(",")).toContain(e);
  });

  it("reads a zip's directory: file count, left-out entries, and refusals", () => {
    const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const zip = makeZip([
      { name: "Ozarks/" },
      { name: "Ozarks/a.pdf", data: "x" },
      { name: "Ozarks/b.docx", data: "x" },
      { name: "Ozarks/link", data: "/etc", symlink: true },
      { name: "__MACOSX/Ozarks/._a.pdf", data: "x" },
      { name: "Ozarks/.DS_Store", data: "x" },
    ]);
    expect(scanZip(ab(zip))).toEqual({ fileCount: 2, notes: ["Ozarks/link: a symbolic link, left out"] });
    expect(scanZip(ab(makeZip([{ name: "s", data: "x", encrypted: true }])))).toEqual({ error: expect.stringMatching(/password-protected/) });
    expect(scanZip(ab(makeZip([{ name: "s", data: "x" }], { zip64Locator: true })))).toEqual({ error: expect.stringMatching(/ZIP64/) });
    expect(scanZip(ab(Buffer.from("hello")))).toEqual({ error: expect.stringMatching(/isn't a zip/) });
    expect(chipLabel({ name: "Ozarks_Leases_and_ESAs.zip", fileCount: 14 })).toBe("Ozarks_Leases_and_ESAs.zip · 14 files");
    expect(chipLabel({ name: "a.txt" })).toBe("a.txt");
  });

  it("without the provider (portal chat), a zip or document is a plain note", () => {
    const t = attachmentsText([{ name: "O.zip", kind: "archive", mediaType: "application/zip", size: 9, data: "", fileCount: 3 }, { name: "L.docx", kind: "document", mediaType: "", size: 9, data: "" }], visionFor(undefined));
    expect(t).toContain("[Attached zip O.zip (3 files). Its contents can't be opened in this chat");
    expect(t).toContain("[Attached document L.docx. It can't be read in this chat");
  });

  it("only a frontier lead sees images (Anthropic also PDFs); Auto and network models don't", () => {
    expect(visionFor("frontier/anthropic/claude-opus-5-5")).toEqual({ images: true, pdf: true });
    expect(visionFor("frontier/openai/gpt-5")).toEqual({ images: true, pdf: false });
    expect(visionFor("network/qwen3-coder:30b@gpu")).toEqual({ images: false, pdf: false });
    expect(visionFor("auto")).toEqual({ images: false, pdf: false });
    expect(visionFor(undefined)).toEqual({ images: false, pdf: false });
  });

  it("says plainly what a model can't see", () => {
    expect(visionNote([{ kind: "text" }], visionFor(undefined))).toBeNull();
    expect(visionNote([{ kind: "image" }], visionFor(undefined))).toBe("This model can't see images; it gets the file name instead.");
    expect(visionNote([{ kind: "image" }, { kind: "pdf" }], visionFor("frontier/openai/gpt-5"))).toBe("This model can't see PDFs; it gets the file name instead.");
    expect(visionNote([{ kind: "image" }], visionFor("frontier/anthropic/claude-opus-5-5"))).toBeNull();
  });

  it("inlines text files and names images it can't see", () => {
    const text = attachmentsText(
      [
        { name: "a.md", kind: "text", mediaType: "text/markdown", size: 9, text: "has ``` in it" },
        { name: "s.png", kind: "image", mediaType: "image/png", size: 2048, data: "AAAA" },
      ],
      visionFor(undefined),
    );
    expect(text).toContain("Attached file a.md:\n````\nhas ``` in it\n````");
    expect(text).toContain("[Attached image s.png, 2 KB. You can't see its contents");
    expect(attachmentLabel([{ name: "a.md", kind: "text" }, { name: "s.png", kind: "image" }])).toBe("[Attached: a.md, s.png]");
  });
});

describe("botPlacement: where a bot's step runs", () => {
  const usage = (served: Record<string, unknown>, model?: string) => ({ type: "usage", cSats: 0, where: "x", ...(model ? { model } : {}), served }) as unknown as IdeStreamEvent;
  const base = { tier: null, region: null, country: null };

  it("before a call answers: the route Auto picked", () => {
    expect(botPlacement([{ type: "status", message: "Compute: this computer · qwen3.5:9b · ran on a smaller local model (no cSats)" } as IdeStreamEvent])).toBe("This computer · qwen3.5:9b");
  });

  it("this computer and your own machines are free; the network shows cSats; your key shows the model", () => {
    expect(botPlacement([usage({ ...base, label: "This computer", own: true, computeClass: "local", hardware: "This computer (Apple M1 Max)" }, "qwen3-coder:30b")])).toBe("This computer (Apple M1 Max) · qwen3-coder:30b · free");
    expect(botPlacement([usage({ ...base, label: "your machine (Mac)", own: true, computeClass: "apple", hardware: "Apple Silicon" }, "mine/qwen3-coder:30b")])).toBe("Your machine (Mac) · Apple Silicon · qwen3-coder:30b · free");
    expect(botPlacement([usage({ ...base, label: "lin-•••3f2a", own: false, computeClass: "gpu.dc", hardware: "Datacenter GPU (gpu.dc40)", gpu: "2× NVIDIA A16" }, "network/qwen3-coder:30b@gpu.dc")], 3.4)).toBe("Network · Datacenter GPU 2×A16 · qwen3-coder:30b · 3.4 cSats");
    expect(botPlacement([usage({ ...base, label: "Anthropic", own: true, computeClass: "frontier", hardware: "Anthropic · your key" }, "frontier/anthropic/claude-opus-5-5")])).toBe("Claude Opus 5.5 · your key");
  });

  it("nothing yet: null", () => {
    expect(botPlacement([])).toBeNull();
  });
});
