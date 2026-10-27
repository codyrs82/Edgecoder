// #12: fail if a package.json script references a src/, tests/, scripts/ or bin/
// file (or directory) that does not exist.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATH_RE = /(?:^|[\s"'=])((?:\.\/)?(?:src|tests|scripts|bin)\/[\w./@-]+)/g;

export function findMissingScriptPaths(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(PATH_RE)) {
      const rel = m[1].replace(/[.,;:]+$/, "");
      if (!existsSync(resolve(root, rel))) missing.push({ script: name, path: rel });
    }
  }
  return missing;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const missing = findMissingScriptPaths(root);
  if (missing.length) {
    for (const { script, path } of missing) console.error(`package.json script "${script}" references missing ${path}`);
    process.exit(1);
  }
  console.log("check:scripts: all script paths exist");
}
