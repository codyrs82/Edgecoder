#!/usr/bin/env node
// #89: copy the shared design tokens into the built portal, where src/portal/assets.ts serves them
// at /assets/tokens.css, and the Getting started explainer videos (src/portal/assets/videos, served
// at /assets/videos/), and the Bits avatars (src/portal/assets/bits, served at /assets/bits/). Runs after `tsc` in `npm run build` (and so in the server Docker image).
// Usage: node scripts/copy-portal-assets.mjs [outDir]   (default: dist/portal/assets)
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/tokens/dist/tokens.css");
const outDir = resolve(process.argv[2] ?? join(root, "dist/portal/assets"));

if (!existsSync(src)) {
  console.error(`copy-portal-assets: ${src} is missing (run: npm --prefix packages/tokens run build)`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
copyFileSync(src, join(outDir, "tokens.css"));
console.log(`copy-portal-assets: tokens.css -> ${join(outDir, "tokens.css")}`);

const videos = join(root, "src/portal/assets/videos");
if (existsSync(videos)) {
  const files = readdirSync(videos).filter((f) => /\.(mp4|webm|vtt|jpg)$/.test(f));
  mkdirSync(join(outDir, "videos"), { recursive: true });
  for (const f of files) copyFileSync(join(videos, f), join(outDir, "videos", f));
  console.log(`copy-portal-assets: ${files.length} video files -> ${join(outDir, "videos")}`);
}

// The Bits avatars and mark (src/portal/assets/bits, served at /assets/bits/).
const bits = join(root, "src/portal/assets/bits");
if (existsSync(bits)) {
  const files = readdirSync(bits).filter((f) => /\.svg$/.test(f));
  mkdirSync(join(outDir, "bits"), { recursive: true });
  for (const f of files) copyFileSync(join(bits, f), join(outDir, "bits", f));
  console.log(`copy-portal-assets: ${files.length} Bits files -> ${join(outDir, "bits")}`);
}
