/**
 * Helpers for read_file / list_directory when a path doesn't open as written: find the entry the
 * model meant (a different Unicode normalization or letter case of a real name), or say what is
 * there instead so the next call can use a real name.
 *
 * Seen with a bot on a Dropbox folder (Nov 2026): the model listed `work`, then read
 * `work/security/INDEX.md` and `work/oneleet/README.md` without listing those folders. Neither
 * file exists; the bare ENOENT (with the absolute path) gave it nothing to go on.
 */
import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

function entries(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/** Comparison key: NFC, lower case. */
const key = (s: string) => s.normalize("NFC").toLowerCase();

/**
 * The existing path that `abs` (under `root`) names when compared segment by segment ignoring
 * Unicode normalization (NFC/NFD, as macOS and cloud providers differ) and then letter case, or
 * null. A case-insensitive match is taken only when it is the only one in that directory.
 * A leading segment equal to the root's own folder name (`proj/src/a.ts` for root `proj`) is
 * dropped when nothing in the root has that name.
 */
export function findPathVariant(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..")) return null;
  let segs = rel.split(sep).filter(Boolean);
  const top = entries(root);
  if (top && segs.length > 1 && key(segs[0]) === key(basename(root)) && !top.some((n) => key(n) === key(segs[0]))) {
    segs = segs.slice(1);
  }
  let cur = root;
  let changed = false;
  for (const seg of segs) {
    const names = entries(cur);
    if (!names) return null;
    let hit = names.find((n) => n === seg);
    if (!hit) {
      const nfc = seg.normalize("NFC");
      hit = names.find((n) => n.normalize("NFC") === nfc);
    }
    if (!hit) {
      const ci = names.filter((n) => key(n) === key(seg));
      if (ci.length === 1) hit = ci[0];
    }
    if (!hit) return null;
    if (hit !== seg) changed = true;
    cur = join(cur, hit);
  }
  return changed || segs.length !== rel.split(sep).filter(Boolean).length ? cur : null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Up to `max` names from `names` closest to `want` (shared stem, substring, then edit distance). */
export function closestNames(want: string, names: string[], max = 5): string[] {
  const w = key(want);
  const stem = w.replace(/\.[^.]+$/, "");
  const scored = names.map((n) => {
    const k = key(n);
    const ks = k.replace(/\.[^.]+$/, "");
    let score = editDistance(w, k) / Math.max(w.length, k.length, 1);
    if (stem && (ks.includes(stem) || (ks.length >= 3 && stem.includes(ks)))) score -= 0.5;
    return { n, score };
  });
  scored.sort((a, b) => a.score - b.score || a.n.localeCompare(b.n));
  return scored.filter((s) => s.score < 0.6).slice(0, max).map((s) => s.n);
}

/** Project-relative display form, with `/` separators ("." for the root). */
export function displayPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/") || ".";
}

/**
 * The error for a path that doesn't exist. Its first line is short (it is the step's header in the
 * app); the rest names the deepest folder that does exist and the closest names in it, so the
 * model can retry with a real name instead of guessing again.
 */
export function notFoundMessage(root: string, abs: string, what: "File" | "Folder" = "File"): string {
  const shown = displayPath(root, abs);
  // Deepest existing ancestor, and the first missing segment under it.
  let missing = abs;
  let parent = dirname(abs);
  while (entries(parent) === null && parent !== root && parent.startsWith(root)) {
    missing = parent;
    parent = dirname(parent);
  }
  const names = (entries(parent) ?? []).filter((n) => !n.startsWith("."));
  const where = displayPath(root, parent);
  const lines = [`${what} not found: ${shown}`];
  const gone = basename(missing);
  if (missing !== abs) lines.push(`There is no folder ${displayPath(root, missing)}.`);
  const near = closestNames(gone, names);
  if (near.length) {
    lines.push(`Did you mean: ${near.map((n) => (where === "." ? n : `${where}/${n}`)).join(", ")}?`);
  } else if (names.length) {
    lines.push(`${where === "." ? "The project root" : where} has ${names.length} entr${names.length === 1 ? "y" : "ies"}, none named like ${gone}.`);
  } else {
    lines.push(`${where === "." ? "The project root" : where} is empty.`);
  }
  lines.push(`Call list_directory on ${where} to see what is there; use names exactly as listed and don't guess file names.`);
  return lines.join("\n");
}

/**
 * Errors a cloud provider's file (Dropbox, iCloud, OneDrive via macOS File Provider) gives when it
 * is online-only and couldn't be downloaded on open.
 */
const CLOUD_FETCH_CODES = new Set(["EDEADLK", "ETIMEDOUT", "ECANCELED", "EAGAIN"]);

export function isCloudFetchError(code: string | undefined): boolean {
  return code !== undefined && CLOUD_FETCH_CODES.has(code);
}

export function cloudFetchMessage(shown: string, code: string): string {
  return [
    `Couldn't open ${shown} (${code}): it looks like an online-only cloud file that wasn't downloaded.`,
    "Ask the user to make the folder available offline in Dropbox / iCloud / OneDrive, then try again. Other files can still be read.",
  ].join("\n");
}
