import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCodeRemoteRoutes, type RemoteSessionSnapshot } from "../../src/apps/ide/code-remote.js";
import { projectIdOf, setProjectTrusted } from "../../src/apps/ide/workspace-trust.js";
import { makeHub } from "../helpers/sessions.js";

/*
 * Images sent with a message from the web: the Mac saves them in the project's
 * .edgecoder/attachments/ (ignored by git) like the desktop app's attachments, and the message
 * names each with where it was saved. The session summary says the Mac takes images.
 */
const ACCOUNT = "acct_owner";
const SALT = "test-salt";
let tmp: string;
let root: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "code-remote-img-"));
  process.env.EDGECODER_TRUST_FILE = join(tmp, "trusted.json");
  root = join(tmp, "work", "my-app");
  mkdirSync(root, { recursive: true });
  setProjectTrusted(root, true);
});
afterEach(() => {
  delete process.env.EDGECODER_TRUST_FILE;
  rmSync(tmp, { recursive: true, force: true });
});

async function server() {
  const { hub, checkpoints } = makeHub([{ content: "Looked.", toolCalls: [] }]);
  const app = Fastify();
  registerCodeRemoteRoutes(app, hub, { account: async () => ACCOUNT, checkpoints, machineSalt: () => SALT, branch: () => "main" });
  await app.ready();
  const command = async (body: Record<string, unknown>) => {
    const r = await app.inject({ method: "POST", url: "/v1/ide/code/remote/command", payload: { requestedBy: ACCOUNT, ...body } });
    return { code: r.statusCode, body: r.json() as { status: string; error?: string; data?: any } };
  };
  return { hub, command };
}
const png = (bytes: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8, 3)]);

describe("code-remote: images with a message", () => {
  it("saves them in .edgecoder/attachments and names them in the message; the summary says images: true", async () => {
    const { hub, command } = await server();
    const id = (await command({ action: "create", projectId: projectIdOf(root, SALT) })).body.data.sessionId as string;
    const bytes = png(2 * 1024 * 1024);
    const r = await command({ action: "message", sessionId: id, text: "What's wrong here?", attachments: [{ name: "shot.png", mediaType: "image/png", data: bytes.toString("base64") }] });
    expect(r.code).toBe(200);
    expect(r.body.status).toBe("done");
    await hub.idle(id);
    const dir = join(root, ".edgecoder", "attachments");
    const files = readdirSync(dir).filter((f) => f.endsWith("shot.png"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0])).equals(bytes)).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
    const snap = (await command({ action: "snapshot", sessionId: id })).body.data as RemoteSessionSnapshot;
    const sent = snap.tail.find((m) => m.role === "user")!;
    expect(sent.content).toMatch(/^What's wrong here\?\n\n\[Attached: shot\.png\]\n\[Attached image shot\.png: saved at \.edgecoder\/attachments\/[^\]]*shot\.png\./);
    expect(sent.content).not.toContain(tmp);
    expect(snap.session.images).toBe(true);
  });

  it("refuses a mislabelled or oversized image, too many, and a name with a path, and saves nothing", async () => {
    const { command } = await server();
    const id = (await command({ action: "create", projectId: projectIdOf(root, SALT) })).body.data.sessionId as string;
    const ok = { name: "a.png", mediaType: "image/png", data: png(64).toString("base64") };
    for (const attachments of [
      [{ ...ok, mediaType: "image/jpeg" }],
      [{ ...ok, data: png(5 * 1024 * 1024 + 1).toString("base64") }],
      [ok, ok, ok, ok, ok],
      [{ ...ok, name: "../../evil.png" }],
      [{ ...ok, mediaType: "image/svg+xml" }],
    ]) {
      const r = await command({ action: "message", sessionId: id, text: "x", attachments });
      expect(r.code).toBe(400);
      expect(r.body).toMatchObject({ status: "refused", error: "invalid_request" });
    }
    expect(() => readdirSync(join(root, ".edgecoder", "attachments"))).toThrow();
  });
});
