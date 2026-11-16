// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * The chart library on the market page (TradingView Lightweight Charts), served from
 * node_modules at /portal/vendor/lightweight-charts.js so the page stays within script-src 'self'.
 *
 * The library adds one <style> element at run time, for the attribution logo its license asks
 * for. The portal's style-src has no 'unsafe-inline', so that one stylesheet is allowed by its
 * hash, taken from the copy of the library that is actually served. If an upgrade changes how the
 * logo is styled the list is empty, the browser drops the rule (the logo loses its position), and
 * tests/portal/chart-lib.test.ts fails.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REL = "lightweight-charts/dist/lightweight-charts.standalone.production.js";

function candidates(): string[] {
  const require = createRequire(import.meta.url);
  const out: string[] = [];
  try {
    out.push(require.resolve(REL));
  } catch {
    // the package's "exports" map doesn't list dist/, so resolve the package root instead
  }
  try {
    out.push(resolve(dirname(require.resolve("lightweight-charts")), "dist", "lightweight-charts.standalone.production.js"));
  } catch {
    // not installed via the main entry either
  }
  out.push(resolve(fileURLToPath(new URL("../../node_modules/" + REL, import.meta.url))));
  out.push(resolve(process.cwd(), "node_modules", REL));
  return out;
}

let source: string | null = null;

/** The library's source, or "" when the package is not installed. Read once. */
export function chartLibSource(): string {
  if (source === null) {
    source = "";
    for (const candidate of candidates()) {
      try {
        source = readFileSync(candidate, "utf8");
        break;
      } catch {
        // try the next location
      }
    }
  }
  return source;
}

/** CSP hash sources ('sha256-...') for the style text the library injects. */
export function inlineStyleHashes(lib: string): string[] {
  // The text is one string literal: `<style>.innerText = "a#tv-attr-logo{...}"`.
  const out: string[] = [];
  for (const m of lib.matchAll(/(["'`])(a#tv-attr-logo\{(?:(?!\1)[^\\\n])*)\1/g)) {
    const hash = `'sha256-${createHash("sha256").update(m[2]!, "utf8").digest("base64")}'`;
    if (!out.includes(hash)) out.push(hash);
  }
  return out;
}

let hashes: string[] | null = null;

/** `inlineStyleHashes` of the served library. Read once. */
export function chartLibStyleHashes(): string[] {
  hashes ??= inlineStyleHashes(chartLibSource());
  return hashes;
}
