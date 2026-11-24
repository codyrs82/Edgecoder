import { describe, expect, it } from "vitest";
import { CODE_COMMAND_BODY_LIMIT, CODE_IMAGES_MAX, CODE_IMAGES_TOTAL_MAX_BYTES, CODE_IMAGE_MAX_BYTES, base64Bytes, codeControlRequestSchema, sniffImageType } from "../../src/common/code-relay.js";

/*
 * Images with a Code session message from the web: PNG, JPEG and WebP only (by their first bytes
 * too), at most CODE_IMAGES_MAX per message, CODE_IMAGE_MAX_BYTES each and CODE_IMAGES_TOTAL_MAX_BYTES
 * together. A message without images is what it always was.
 */
const SESSION = "6f1c3c1e-3b7a-4d38-9a41-1f0e0b6c2d11";
const head = { png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpeg: [0xff, 0xd8, 0xff, 0xe0], webp: [...Buffer.from("RIFF\0\0\0\0WEBPVP8 ")] };
const img = (kind: keyof typeof head, bytes = 64) => Buffer.concat([Buffer.from(head[kind]), Buffer.alloc(Math.max(0, bytes - head[kind].length), 1)]).toString("base64");
const msg = (attachments?: unknown) => codeControlRequestSchema.safeParse({ action: "message", args: { sessionId: SESSION, text: "look", ...(attachments === undefined ? {} : { attachments }) } });
const issue = (r: ReturnType<typeof msg>) => (r.success ? "" : r.error.issues.map((i) => i.message).join("; "));

describe("code relay: images with a message", () => {
  it("a message without images is unchanged (older pages and phones)", () => {
    expect(msg().success).toBe(true);
  });

  it("takes PNG, JPEG and WebP named by type and first bytes", () => {
    const r = msg([{ name: "a.png", mediaType: "image/png", data: img("png") }, { name: "b.jpg", mediaType: "image/jpeg", data: img("jpeg") }, { name: "c.webp", mediaType: "image/webp", data: img("webp") }]);
    expect(r.success).toBe(true);
    expect(sniffImageType(img("webp"))).toBe("image/webp");
  });

  it("refuses other types, a type that doesn't match the bytes, and anything not base64", () => {
    expect(msg([{ name: "a.gif", mediaType: "image/gif", data: Buffer.from("GIF89a....").toString("base64") }]).success).toBe(false);
    expect(issue(msg([{ name: "a.png", mediaType: "image/png", data: img("jpeg") }]))).toMatch(/PNG, JPEG and WebP/);
    expect(issue(msg([{ name: "a.svg", mediaType: "image/png", data: Buffer.from("<svg onload=alert(1)>").toString("base64") }]))).toMatch(/PNG, JPEG and WebP/);
    expect(msg([{ name: "a.png", mediaType: "image/png", data: "not base64!!" }]).success).toBe(false);
  });

  it("refuses an image over the size cap, too many images, too many bytes together, and none", () => {
    expect(issue(msg([{ name: "big.png", mediaType: "image/png", data: img("png", CODE_IMAGE_MAX_BYTES + 1) }]))).toMatch(/up to 5 MB/);
    expect(msg([{ name: "ok.png", mediaType: "image/png", data: img("png", CODE_IMAGE_MAX_BYTES) }]).success).toBe(true);
    const one = { name: "a.png", mediaType: "image/png", data: img("png") };
    expect(msg(Array.from({ length: CODE_IMAGES_MAX }, () => one)).success).toBe(true);
    expect(msg(Array.from({ length: CODE_IMAGES_MAX + 1 }, () => one)).success).toBe(false);
    const third = { name: "c.png", mediaType: "image/png", data: img("png", Math.floor(CODE_IMAGES_TOTAL_MAX_BYTES / 3) + 1024) };
    expect(issue(msg([third, third, third]))).toMatch(/per message/);
    expect(msg([]).success).toBe(false);
  });

  it("names are plain file names; unknown fields are refused", () => {
    expect(msg([{ name: "../../etc/passwd", mediaType: "image/png", data: img("png") }]).success).toBe(false);
    expect(msg([{ name: "a\u0000.png", mediaType: "image/png", data: img("png") }]).success).toBe(false);
    expect(msg([{ name: "a.png", mediaType: "image/png", data: img("png"), path: "/tmp/x" }]).success).toBe(false);
  });

  it("the body limit fits the largest valid message, and sizes are counted from base64 exactly", () => {
    expect(CODE_COMMAND_BODY_LIMIT).toBeGreaterThan(Math.ceil((CODE_IMAGES_TOTAL_MAX_BYTES * 4) / 3) + 32_000 * 4);
    for (const n of [1, 2, 3, 100, 101, 102]) expect(base64Bytes(Buffer.alloc(n).toString("base64"))).toBe(n);
  });
});
