import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, registerBotRoutes, type BotRunContext, type BotRunner } from "../../src/apps/ide/bots.js";
import { safeFileName, saveAttachments, withAttachments } from "../../src/apps/ide/attachments.js";
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
