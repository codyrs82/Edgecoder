#!/usr/bin/env node
// #89: copy the shared design tokens into the built portal, where src/portal/assets.ts serves them
// at /assets/tokens.css. Runs after `tsc` in `npm run build` (and so in the server Docker image).
// Usage: node scripts/copy-portal-assets.mjs [outDir]   (default: dist/portal/assets)
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
