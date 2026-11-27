// Writes the Bits logo files from desktop/src/lib/bit-avatars.ts (the one source of the designs):
// - src/portal/assets/bits/<id>.svg, bits-mark.svg, bits-wordmark.svg (served at /assets/bits/)
// - ios/EdgeCoderIOS/EdgeCoderIOS/Assets.xcassets/Bits/bit-<id>.imageset (vector, any size)
// - with --sheet <file.svg>: a contact sheet of the set on light and dark, at 96, 48 and 24 px.
// Usage: npx tsx scripts/gen-bits-assets.ts [--sheet out.svg]
// tests/portal/bits-assets.test.ts fails when the committed files drift from the module.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BIT_AVATARS, bitAvatarSvg, bitsMarkSvg, bitsWordmarkSvg, idleFace } from "../desktop/src/lib/bit-avatars";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PORTAL_BITS_DIR = join(root, "src/portal/assets/bits");
export const IOS_BITS_DIR = join(root, "ios/EdgeCoderIOS/EdgeCoderIOS/Assets.xcassets/Bits");

export function bitsAssetFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const a of BIT_AVATARS) {
    const svg = bitAvatarSvg(a);
    files[join(PORTAL_BITS_DIR, `${a.id}.svg`)] = svg;
    const set = join(IOS_BITS_DIR, `bit-${a.id}.imageset`);
    files[join(set, `bit-${a.id}.svg`)] = svg;
    files[join(set, "Contents.json")] =
      JSON.stringify({ images: [{ filename: `bit-${a.id}.svg`, idiom: "universal" }], info: { author: "xcode", version: 1 }, properties: { "preserves-vector-representation": true } }, null, 2) + "\n";
  }
  files[join(IOS_BITS_DIR, "Contents.json")] = JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n";
  files[join(PORTAL_BITS_DIR, "bits-mark.svg")] = bitsMarkSvg();
  files[join(PORTAL_BITS_DIR, "bits-wordmark.svg")] = bitsWordmarkSvg();
  return files;
}

function sheet(): string {
  const cols = 6;
  const cell = 170;
  const w = cols * cell + 40;
  const inner = (s: string) => s.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>[^<]*<\/title>/, "");
  const panel = (y: number, bg: string, fg: string, title: string) => {
    let out = `<rect x="0" y="${y}" width="${w}" height="420" fill="${bg}"/><text x="20" y="${y + 30}" font-size="16" font-weight="600" fill="${fg}">${title}</text>`;
    BIT_AVATARS.forEach((a, i) => {
      const cx = 30 + (i % cols) * cell, cy = y + 50 + Math.floor(i / cols) * 180;
      out += `<g transform="translate(${cx + 27} ${cy}) scale(2)">${a.body}${idleFace(a.base)}</g>`;
      out += `<g transform="translate(${cx + 30} ${cy + 104})">${a.body}${idleFace(a.base)}</g>`;
      out += `<g transform="translate(${cx + 86} ${cy + 116}) scale(0.5)">${a.body}${idleFace(a.base)}</g>`;
      out += `<text x="${cx + 75}" y="${cy + 172}" text-anchor="middle" font-size="13" fill="${fg}">${a.label} · ${a.id}</text>`;
    });
    return out;
  };
  const markY = 860;
  const wm = bitsWordmarkSvg();
  const brand = (bg: string, x: number, ink: string) =>
    `<rect x="${x}" y="${markY}" width="${w / 2}" height="${w - markY}" fill="${bg}"/>` +
    `<g transform="translate(${x + 30} ${markY + 35}) scale(2)">${inner(bitsMarkSvg())}</g>` +
    `<g transform="translate(${x + 150} ${markY + 35}) scale(2)">${inner(wm).replace(/<style>[^<]*<\/style>/, "").replace(/stroke="#1d1d1f" stroke-width="5.2"/, `stroke="${ink}" stroke-width="5.2"`)}</g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" font-family="-apple-system, Helvetica, Arial, sans-serif">` +
    panel(0, "#ffffff", "#1d1d1f", "Bits avatars · light") +
    panel(430, "#161618", "#f5f5f7", "Bits avatars · dark") +
    brand("#ffffff", 0, "#1d1d1f") +
    brand("#161618", w / 2, "#f5f5f7") +
    `</svg>\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [path, body] of Object.entries(bitsAssetFiles())) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  console.log(`gen-bits-assets: ${BIT_AVATARS.length} avatars, the mark and the wordmark written`);
  const i = process.argv.indexOf("--sheet");
  if (i > 0 && process.argv[i + 1]) {
    writeFileSync(resolve(process.argv[i + 1]), sheet());
    console.log(`gen-bits-assets: contact sheet -> ${process.argv[i + 1]}`);
  }
}
