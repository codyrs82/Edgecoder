import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ALL_AVATAR_SHAPES, BIT_AVATAR_IDS, CLASSIC_AVATAR_SHAPES, randomBitAvatarId } from "../../src/common/bit-avatars.js";
import { BITS_DIR, registerPortalAssets } from "../../src/portal/assets.js";
import { BOT_AVATAR_SHAPES } from "../../src/apps/ide/bots.js";
import { BIT_AVATARS, BIT_AVATAR_IDS as DESKTOP_BIT_IDS, bitAvatarSvg } from "../../desktop/src/lib/bit-avatars.js";
import { bitsAssetFiles, IOS_BITS_DIR } from "../../scripts/gen-bits-assets.js";

/** A strict little XML check: every tag closes in order, attributes are quoted, nothing is left open. */
function parseSvg(xml: string): { root: string; attrs: Record<string, string> } {
  const stack: string[] = [];
  let root = "";
  let rootAttrs: Record<string, string> = {};
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|<!--[\s\S]*?-->|<\?xml[^>]*\?>/g;
  let at = 0;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const between = xml.slice(at, m.index);
    expect(between, `stray markup before ${m[0].slice(0, 40)}`).not.toMatch(/[<>]/);
    at = m.index + m[0].length;
    if (!m[2]) continue;
    const [, close, name, attrText, selfClose] = m;
    if (close) {
      expect(stack.pop(), `</${name}> closes the wrong element`).toBe(name);
      continue;
    }
    const attrs = Object.fromEntries([...attrText.matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (!root) {
      root = name;
      rootAttrs = attrs;
    } else expect(stack.length, "a second root element").toBeGreaterThan(0);
    if (!selfClose) stack.push(name);
  }
  expect(xml.slice(at).trim()).toBe("");
  expect(stack).toEqual([]);
  return { root, attrs: rootAttrs };
}

const svgFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".svg"));

describe("Bits avatars and mark", () => {
  it("every avatar SVG parses and has a square viewBox", () => {
    for (const a of BIT_AVATARS) {
      const { root, attrs } = parseSvg(bitAvatarSvg(a));
      expect(root).toBe("svg");
      expect(attrs.viewBox).toBe("0 0 48 48");
      expect(attrs.xmlns).toBe("http://www.w3.org/2000/svg");
    }
  });

  it("every committed SVG (portal and iOS asset catalog) parses and has a viewBox", () => {
    const files = [
      ...svgFiles(BITS_DIR).map((f) => join(BITS_DIR, f)),
      ...readdirSync(IOS_BITS_DIR)
        .filter((d) => d.endsWith(".imageset"))
        .flatMap((d) => svgFiles(join(IOS_BITS_DIR, d)).map((f) => join(IOS_BITS_DIR, d, f))),
    ];
    expect(files.length).toBe(BIT_AVATARS.length * 2 + 2);
    for (const f of files) {
      const { root, attrs } = parseSvg(readFileSync(f, "utf8"));
      expect(root, f).toBe("svg");
      expect(attrs.viewBox, f).toMatch(/^0 0 \d+ \d+$/);
    }
  });

  it("the committed files match desktop/src/lib/bit-avatars.ts (run: npx tsx scripts/gen-bits-assets.ts)", () => {
    for (const [path, body] of Object.entries(bitsAssetFiles())) expect(readFileSync(path, "utf8"), path).toBe(body);
  });

  it("the server, portal and desktop agree on the ids, and new bits draw from the Bits set", () => {
    expect([...DESKTOP_BIT_IDS]).toEqual([...BIT_AVATAR_IDS]);
    expect([...BOT_AVATAR_SHAPES]).toEqual([...ALL_AVATAR_SHAPES]);
    expect(ALL_AVATAR_SHAPES).toEqual([...BIT_AVATAR_IDS, ...CLASSIC_AVATAR_SHAPES]);
    // The relay's enum check (src/common/bot-relay.ts) takes lowercase letters and underscores.
    for (const id of ALL_AVATAR_SHAPES) expect(id).toMatch(/^[a-z_]+$/);
    for (let i = 0; i < 50; i++) expect(BIT_AVATAR_IDS).toContain(randomBitAvatarId());
    // The iOS app's list is the same.
    const swift = readFileSync(join(__dirname, "../../ios/EdgeCoderIOS/EdgeCoderIOS/Bots/BotsModels.swift"), "utf8");
    const ios = /bitAvatarIds: Set<String> = \[([^\]]*)\]/.exec(swift)?.[1].match(/"([a-z_]+)"/g)?.map((s) => s.slice(1, -1));
    expect(ios).toEqual([...BIT_AVATAR_IDS]);
  });

  it("serves the files at /assets/bits/ and nothing else there", async () => {
    const app = Fastify();
    registerPortalAssets(app);
    const ok = await app.inject({ method: "GET", url: "/assets/bits/coin.svg" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/svg+xml");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.body).toContain('viewBox="0 0 48 48"');
    expect((await app.inject({ method: "GET", url: "/assets/bits/bits-wordmark.svg" })).statusCode).toBe(200);
    for (const bad of ["nope.svg", "..%2Fassets.ts", "COIN.svg", "coin.png"]) {
      expect((await app.inject({ method: "GET", url: `/assets/bits/${bad}` })).statusCode, bad).toBe(404);
    }
    await app.close();
  });
});
