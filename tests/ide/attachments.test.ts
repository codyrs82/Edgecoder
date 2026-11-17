import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, registerBotRoutes, type BotRunContext, type BotRunner } from "../../src/apps/ide/bots.js";
import { safeFileName, saveAttachments, withAttachments } from "../../src/apps/ide/attachments.js";
import { makeDocx, makeXlsx, makeZip } from "../helpers/make-zip.js";
import { toAnthropicMessages } from "../../src/inference-api/frontier.js";
import { toOpenAiMessages } from "../../src/apps/ide/hosted-backend.js";

const made: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "att-"));
  made.push(d);
  return d;
};
let managers: BotManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

describe("bot messages with attachments", () => {
  it("saves files in the bot's folder, shows their names, and gives the model text inline and the paths", async () => {
    const calls: BotRunContext[] = [];
    const runner: BotRunner = async (ctx) => {
      calls.push(ctx);
      ctx.sendEvent({ type: "text", content: "ok" });
    };
    const m = new BotManager({ runner, file: join(dir(), "bots.json"), now: () => new Date(2026, 10, 16, 17, 5, 9).getTime() });
    managers.push(m);
    const root = dir();
    const bot = m.create({ name: "Cyber SIMP", projectRoot: root });
    const app = Fastify();
    registerBotRoutes(app, m);
    const res = await app.inject({
      method: "POST",
      url: `/v1/ide/bots/${bot.id}/messages`,
      payload: {
        content: "",
        attachments: [
          { kind: "text", name: "scan.csv", mediaType: "text/csv", size: 7, text: "host,ip\n" },
          { kind: "image", name: "../../shot.png", mediaType: "image/png", size: 8, data: PNG },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await m.idle(bot.id);
    // Saved under .edgecoder/attachments, never outside it (the ../ is dropped), and git ignores them.
    const csv = join(root, ".edgecoder", "attachments", "20261116-170509-scan.csv");
    const png = join(root, ".edgecoder", "attachments", "20261116-170509-shot.png");
    expect(readFileSync(csv, "utf8")).toBe("host,ip\n");
    expect(readFileSync(png).toString("hex")).toBe("89504e470d0a1a0a");
    expect(readFileSync(join(root, ".edgecoder", "attachments", ".gitignore"), "utf8")).toBe("*\n");
    // The conversation shows the names only.
    const user = m.messages(bot.id).find((x) => x.role === "user")!;
    expect(user.content).toBe("[Attached: scan.csv, ../../shot.png]");
    // The model gets the text inline and the image's path, with a plain "can't see" note.
    const sent = calls[0].messages.at(-1)!.content;
    expect(sent).toContain("Attached file scan.csv (saved at .edgecoder/attachments/20261116-170509-scan.csv):\n```\nhost,ip\n\n```");
    expect(sent).toContain("[Attached image ../../shot.png: saved at .edgecoder/attachments/20261116-170509-shot.png. You can't see images");
    await app.close();
  });

  it("refuses an empty message, bad base64 and unsupported image types", async () => {
    const m = new BotManager({ runner: async () => {}, file: join(dir(), "bots.json") });
    managers.push(m);
    const bot = m.create({ name: "B", projectRoot: dir() });
    const app = Fastify();
    registerBotRoutes(app, m);
    const post = (payload: unknown) => app.inject({ method: "POST", url: `/v1/ide/bots/${bot.id}/messages`, payload: payload as Record<string, unknown> });
    expect((await post({ content: "  " })).statusCode).toBe(400);
    expect((await post({ content: "x", attachments: [{ kind: "image", name: "a.png", mediaType: "image/png", size: 1, data: "not base64!" }] })).statusCode).toBe(400);
    expect((await post({ content: "x", attachments: [{ kind: "image", name: "a.svg", mediaType: "image/svg+xml", size: 1, data: PNG }] })).statusCode).toBe(400);
    await app.close();
  });

  it("won't write through an attachments folder that is a symlink out of the root", () => {
    const root = dir();
    const outside = dir();
    mkdirSync(join(root, ".edgecoder"));
    symlinkSync(outside, join(root, ".edgecoder", "attachments"), "dir");
    expect(() => saveAttachments(root, [{ kind: "text", name: "a.txt", mediaType: "text/plain", size: 1, text: "a" }])).toThrow(/outside/);
    expect(existsSync(join(outside, ".gitignore"))).toBe(false);
  });

  it("safeFileName drops folders, control characters and leading dots", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName(".env")).toBe("env");
    expect(safeFileName("a\u0000b?.txt")).toBe("a_b_.txt");
    expect(safeFileName("")).toBe("attachment");
  });
});

describe("chat attachments", () => {
  const atts = [
    { kind: "text" as const, name: "a.py", mediaType: "text/x-python", size: 9, text: "print(1)\n" },
    { kind: "image" as const, name: "s.png", mediaType: "image/png" as const, size: 8, data: PNG },
    { kind: "pdf" as const, name: "r.pdf", mediaType: "application/pdf" as const, size: 8, data: PNG },
  ];
  const msgs = [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }, { role: "user", content: "what's in these?" }];

  it("a frontier Anthropic lead gets the image and PDF as parts; text is inline", () => {
    const out = withAttachments(msgs, atts, "frontier/anthropic/claude-opus-5-5");
    expect(out[2].media).toEqual([{ kind: "image", mediaType: "image/png", data: PNG }, { kind: "pdf", mediaType: "application/pdf", data: PNG }]);
    expect(out[2].content).toContain("Attached file a.py:\n```\nprint(1)\n\n```");
    expect(out[2].content).not.toContain("can't see");
    const { messages } = toAnthropicMessages(out as never);
    expect(messages.at(-1)!.content.map((b) => b.type)).toEqual(["image", "document", "text"]);
  });

  it("an OpenAI lead gets the image as an image_url part and a note for the PDF", () => {
    const out = withAttachments(msgs, atts, "frontier/openai/gpt-5");
    expect(out[2].media?.map((m) => m.kind)).toEqual(["image"]);
    expect(out[2].content).toContain("[Attached PDF r.pdf. This model can't see it");
    const last = toOpenAiMessages(out as never).at(-1) as { content: Array<{ type: string }> };
    expect(last.content.map((p) => p.type)).toEqual(["text", "image_url"]);
  });

  it("Auto, local and network models never get media, only notes", () => {
    for (const model of ["auto", "qwen3.5:9b", "network/qwen3-coder:30b@gpu"]) {
      const out = withAttachments(msgs, atts, model);
      expect(out.some((m) => "media" in m)).toBe(false);
      expect(out[2].content).toContain("[Attached image s.png. This model can't see it");
    }
    expect(withAttachments(msgs, [], "auto")).toBe(msgs);
  });
});

const b64 = (b: Buffer) => b.toString("base64");
const zipAtt = (name: string, buf: Buffer) => ({ kind: "archive" as const, name, mediaType: "application/zip", size: buf.length, data: b64(buf) });
const docAtt = (name: string, buf: Buffer) => ({ kind: "document" as const, name, mediaType: "", size: buf.length, data: b64(buf) });

const ozarks = () =>
  makeZip([
    { name: "Ozarks/" },
    { name: "Ozarks/Leases/unit-1.txt", data: "Unit 1 lease: $950/mo" },
    { name: "Ozarks/Leases/rent.csv", data: "unit,rent\n1,950\n" },
    { name: "Ozarks/ESAs/esa-letter.pdf", data: "%PDF-1.4 fake" },
    { name: "Ozarks/ESAs/photo.png", data: Buffer.from("89504e470d0a1a0a", "hex") },
    { name: "Ozarks/Summary.docx", data: makeDocx(["Portfolio summary"]) },
    { name: "Ozarks/old.doc", data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) },
    { name: "Ozarks/inner.zip", data: makeZip([{ name: "deep.txt", data: "deep" }]) },
    { name: "Ozarks/link", data: "/etc/passwd", symlink: true },
    { name: "__MACOSX/Ozarks/._unit-1.txt", data: "junk" },
    { name: "Ozarks/.DS_Store", data: "junk" },
  ]);

describe("bot archives and documents", () => {
  const bot = () => {
    const calls: BotRunContext[] = [];
    const m = new BotManager({ runner: async (ctx) => void calls.push(ctx), file: join(dir(), "bots.json"), now: () => new Date(2026, 10, 16, 17, 5, 9).getTime() });
    managers.push(m);
    const root = dir();
    return { m, root, calls, b: m.create({ name: "Harry", projectRoot: root }) };
  };

  it("saves a zip, extracts it safely into .edgecoder/attachments/<name>/ and gives the bot the folder and a listing", async () => {
    const { m, root, calls, b } = bot();
    m.message(b.id, "summarize these", [zipAtt("Ozarks_Leases_and_ESAs.zip", ozarks())]);
    await m.idle(b.id);
    const att = join(root, ".edgecoder", "attachments");
    const folder = join(att, "Ozarks_Leases_and_ESAs");
    expect(existsSync(join(att, "20261116-170509-Ozarks_Leases_and_ESAs.zip"))).toBe(true);
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(folder, "Ozarks", "Leases", "unit-1.txt"), "utf8")).toBe("Unit 1 lease: $950/mo");
    // Office text beside the original; the inner zip is a file, not opened; no symlink, no junk.
    expect(readFileSync(join(folder, "Ozarks", "Summary.docx.txt"), "utf8")).toBe("Portfolio summary\nA\tB");
    expect(existsSync(join(folder, "Ozarks", "inner.zip"))).toBe(true);
    expect(existsSync(join(folder, "Ozarks", "deep.txt"))).toBe(false);
    expect(existsSync(join(folder, "Ozarks", "link"))).toBe(false);
    expect(existsSync(join(folder, "__MACOSX"))).toBe(false);
    expect(readdirSync(join(folder, "Ozarks")).includes(".DS_Store")).toBe(false);

    const user = m.messages(b.id).find((x) => x.role === "user")!;
    expect(user.content).toBe("summarize these\n\n[Attached: Ozarks_Leases_and_ESAs.zip (7 files; 1 left out)]");
    const sent = calls[0].messages.at(-1)!.content;
    expect(sent).toContain("[Attached zip Ozarks_Leases_and_ESAs.zip: saved at .edgecoder/attachments/20261116-170509-Ozarks_Leases_and_ESAs.zip and extracted into .edgecoder/attachments/Ozarks_Leases_and_ESAs/ (7 files).");
    expect(sent).toContain("- Ozarks/Leases/rent.csv (16 B)");
    expect(sent).toContain("Left out:\n- Ozarks/link: a symbolic link; links aren't extracted");

    // A second zip of the same name gets its own folder.
    m.message(b.id, "again", [zipAtt("Ozarks_Leases_and_ESAs.zip", ozarks())]);
    await m.idle(b.id);
    expect(existsSync(join(att, "Ozarks_Leases_and_ESAs-2", "Ozarks", "Leases", "rent.csv"))).toBe(true);
  });

  it("refuses an unsafe or encrypted zip with a clear message, writing nothing", async () => {
    const { m, root, b } = bot();
    const app = Fastify();
    registerBotRoutes(app, m);
    const post = (buf: Buffer) => app.inject({ method: "POST", url: `/v1/ide/bots/${b.id}/messages`, payload: { content: "", attachments: [zipAtt("x.zip", buf)] } });
    const slip = await post(makeZip([{ name: "../../evil.txt", data: "x" }]));
    expect(slip.statusCode).toBe(400);
    expect(slip.json().error).toMatch(/^x\.zip: It contains a file path that would land outside its folder/);
    const enc = await post(makeZip([{ name: "a.txt", data: "x", encrypted: true }]));
    expect(enc.json().error).toMatch(/password-protected/);
    expect(existsSync(join(root, ".edgecoder"))).toBe(false);
    expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
    await app.close();
  });

  it("saves a .docx with its text beside it, and an old .doc with a note", async () => {
    const { m, root, calls, b } = bot();
    m.message(b.id, "", [docAtt("Lease.docx", makeDocx(["Term: 12 months"])), docAtt("Old.doc", Buffer.from([0xd0, 0xcf]))]);
    await m.idle(b.id);
    const att = join(root, ".edgecoder", "attachments");
    expect(readFileSync(join(att, "20261116-170509-Lease.docx.txt"), "utf8")).toBe("Term: 12 months\nA\tB");
    const sent = calls[0].messages.at(-1)!.content;
    expect(sent).toContain("Attached document Lease.docx (saved at .edgecoder/attachments/20261116-170509-Lease.docx; its text, below, at .edgecoder/attachments/20261116-170509-Lease.docx.txt):\n```\nTerm: 12 months");
    expect(sent).toContain("[Attached document Old.doc: saved at .edgecoder/attachments/20261116-170509-Old.doc. It is an old binary Office format");
  });
});

describe("chat archives and documents", () => {
  const msgs = [{ role: "user", content: "what's in this?" }];

  it("inlines text and Office text from a zip, lists everything, and says what was left out", () => {
    const out = withAttachments(msgs, [zipAtt("Ozarks.zip", ozarks())], "auto");
    const c = out[0].content;
    expect(c).toContain("[Attached zip Ozarks.zip: 7 files,");
    expect(c).toContain("1 left out (see below)");
    expect(c).toContain("- Ozarks/Leases/rent.csv (16 B) — below");
    expect(c).toContain("File Ozarks.zip/Ozarks/Leases/unit-1.txt:\n```\nUnit 1 lease: $950/mo\n```");
    expect(c).toContain("Attached document Ozarks.zip/Ozarks/Summary.docx (its text):\n```\nPortfolio summary");
    expect(c).toContain("- Ozarks/ESAs/esa-letter.pdf (13 B) — this model can't see PDFs");
    expect(c).toContain("- Ozarks/inner.zip");
    expect(c).toContain("a zip inside the zip; not opened");
    expect(c).toContain("old binary Office format");
    expect(c).toContain("- Ozarks/link — left out: a symbolic link");
    expect(c).not.toContain("__MACOSX");
    expect("media" in out[0]).toBe(false);
  });

  it("gives a frontier model the zip's images and PDFs as parts", () => {
    const out = withAttachments(msgs, [zipAtt("Ozarks.zip", ozarks())], "frontier/anthropic/claude-opus-5-5");
    expect(out[0].media?.map((m) => m.mediaType)).toEqual(["application/pdf", "image/png"]);
    expect(out[0].content).toContain("- Ozarks/ESAs/photo.png (8 B) — attached as an image");
  });

  it("leaves text past the per-archive budget out, by name", () => {
    const big = "x".repeat(150 * 1024);
    const zip = makeZip(Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.log`, data: big + i })));
    const c = withAttachments(msgs, [zipAtt("logs.zip", zip)], "auto")[0].content;
    expect(c.includes("2 left out (see below)")).toBe(true);
    expect(c).toMatch(/- f3\.log \(150 KB\) — left out: past the 400 KB of text shown from one archive/);
    const over = makeZip([{ name: "huge.csv", data: "y,".repeat(120 * 1024) }]);
    expect(withAttachments(msgs, [zipAtt("o.zip", over)], "auto")[0].content).toContain("huge.csv (240 KB) — left out: over 200 KB");
  });

  it("says plainly when a zip can't be opened", () => {
    const c = withAttachments(msgs, [zipAtt("s.zip", makeZip([{ name: "a.txt", data: "x", encrypted: true }]))], "auto")[0].content;
    expect(c).toContain("[Attached zip s.zip: It is password-protected (encrypted)");
  });

  it("inlines .xlsx text and says an old .xls can't be read", () => {
    const c = withAttachments(msgs, [docAtt("Rent.xlsx", makeXlsx()), docAtt("Old.xls", Buffer.from([1, 2]))], "auto")[0].content;
    expect(c).toContain("Attached document Rent.xlsx (its text):\n```\n--- Sheet: Leases ---\nTenant,Rent");
    expect(c).toContain("[Attached document Old.xls: an old binary Office format, which can't be read here. Say so, and suggest saving it as .docx/.xlsx/.pptx");
  });
});
