// #33: every `--config` / `config:` referenced by a workflow exists, and every
// deploy/fly/*.toml is deployed by some workflow (or listed in IGNORED).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IGNORED = new Set([]);
const REF_RE = /(?:--config[ =]|config:\s*)["']?(deploy\/fly\/[\w.-]+\.toml)/g;

export function checkFlyConfigs(root) {
  const wfDir = join(root, ".github", "workflows");
  const referenced = new Map();
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const m of readFileSync(join(wfDir, f), "utf8").matchAll(REF_RE)) referenced.set(m[1], f);
  }
  const missing = [...referenced].filter(([p]) => !existsSync(resolve(root, p))).map(([path, workflow]) => ({ path, workflow }));
  const flyDir = join(root, "deploy", "fly");
  const unreferenced = readdirSync(flyDir)
    .filter((n) => n.endsWith(".toml"))
    .map((n) => `deploy/fly/${n}`)
    .filter((p) => !referenced.has(p) && !IGNORED.has(p));
  return { referenced: [...referenced.keys()].sort(), missing, unreferenced };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { missing, unreferenced } = checkFlyConfigs(resolve(fileURLToPath(new URL("..", import.meta.url))));
  for (const m of missing) console.error(`${m.workflow} references missing ${m.path}`);
  for (const p of unreferenced) console.error(`${p} is not deployed by any workflow (add it or list it in IGNORED)`);
  if (missing.length || unreferenced.length) process.exit(1);
  console.log("check:fly-configs: ok");
}
