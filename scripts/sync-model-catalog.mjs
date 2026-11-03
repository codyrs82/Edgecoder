// Regenerate desktop/src/lib/models.ts from src/model/catalog.ts (the single source of truth).
// The desktop app bundles the catalog as an offline fallback for the Model Manager; the
// inference service serves the same data at GET /model/catalog.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = resolve(root, "src/model/catalog.ts");
const DEST = resolve(root, "desktop/src/lib/models.ts");

export function renderDesktopCatalog(sharedSource) {
  const start = sharedSource.indexOf("export const MODEL_CATALOG_VERSION");
  const end = sharedSource.indexOf("/** Default model for a host");
  if (start < 0 || end < 0) throw new Error("src/model/catalog.ts: expected markers not found");
  const header = `// Curated model catalog for the EdgeCoder Model Manager (offline fallback).
//
// GENERATED COPY of src/model/catalog.ts. Do not edit here: edit the shared file and run
//   node scripts/sync-model-catalog.mjs
// tests/model/catalog-sync.test.ts fails when the two drift. At runtime the Model Manager
// prefers GET /model/catalog from the inference service and falls back to this list.

`;
  return header + sharedSource.slice(start, end).trimEnd() + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = renderDesktopCatalog(readFileSync(SRC, "utf8"));
  if (process.argv.includes("--check")) {
    if (readFileSync(DEST, "utf8") !== out) {
      console.error("desktop/src/lib/models.ts is out of date: run node scripts/sync-model-catalog.mjs");
      process.exit(1);
    }
    console.log("sync-model-catalog: up to date");
  } else {
    writeFileSync(DEST, out);
    console.log(`sync-model-catalog: wrote ${DEST}`);
  }
}
