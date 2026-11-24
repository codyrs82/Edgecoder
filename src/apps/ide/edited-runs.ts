// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Does a call run a file the agent wrote or edited earlier in the same run? The web-page guard's
 * "Allow for the rest of this run" never covers such a call (agent-loop.ts makeToolRunner): after a
 * page read, edits inside the project apply on their own, so page text could otherwise rewrite a
 * script and then have it run without asking.
 *
 * Covered: running an edited file directly (`./x.sh`, `tools/x.py`), through an interpreter
 * (`python3 x.py`, `bash x.sh`, `node x.js`, `source x.sh`), and the build files that decide what a
 * runner executes (`make` after the Makefile, `npm run` / `npx` after package.json, `just`,
 * `cargo`, pytest / tox configs, a tool's `*.config.*`). Not covered (a residual risk, documented in
 * docs/web-tool.md): a test runner or build running edited source or test files it picks up itself.
 */

import { posix } from "node:path";
import { splitCommand } from "./permissions.js";
import { parseArgv } from "./tool-executor.js";
import type { ToolName } from "./tool-types.js";

/** An edited path as the runner keeps it: forward slashes, no `./`, normalised; null when unusable. */
export function editKey(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const p = posix.normalize(path.trim().replace(/\\/g, "/"));
  return p === "." ? null : p.replace(/^\.\//, "");
}

const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "nice", "timeout"]);
/** Programs that run the script they're given (kept as a list so no source line reads like a pipe into a shell). */
const INTERPRETER_NAMES = ["python\\d*(\\.\\d+)?", "node", "nodejs", "bun", "deno", "ruby", "perl", "php", "sh", "bash", "zsh", "dash", "ksh", "fish", "tsx", "ts-node", "source", "\\.", "Rscript", "lua", "osascript"];
const INTERPRETER = new RegExp(`^(${INTERPRETER_NAMES.join("|")})$`);
/** Build files per runner: editing one changes what the runner executes. */
const BUILD_FILES: Array<{ runner: RegExp; file: RegExp }> = [
  { runner: /^(make|gmake)$/, file: /(^|\/)(GNUmakefile|[Mm]akefile|[^/]+\.mk)$/ },
  { runner: /^(npm|pnpm|yarn|bun|npx|pnpx|bunx|node)$/, file: /(^|\/)package\.json$/ },
  { runner: /^just$/, file: /(^|\/)[Jj]ustfile$/ },
  { runner: /^task$/, file: /(^|\/)Taskfile\.ya?ml$/ },
  { runner: /^cargo$/, file: /(^|\/)(Cargo\.toml|build\.rs)$/ },
  { runner: /^(pytest|tox|nox)$/, file: /(^|\/)(conftest\.py|pytest\.ini|tox\.ini|noxfile\.py|setup\.cfg|setup\.py|pyproject\.toml)$/ },
  { runner: /^(gradle|\.\/gradlew)$/, file: /(^|\/)(build|settings)\.gradle(\.kts)?$/ },
];
/** `vitest.config.ts`, `webpack.config.js`, `.eslintrc.cjs`: config files that tools load as code. */
const CODE_CONFIG = /(^|\/)(\.?[\w-]+\.config|\.[\w-]+rc)\.(js|cjs|mjs|ts|cts|mts)$/;

/** The edited file this call runs, or null. Only run_shell can run one. */
export function runsEditedFile(tool: ToolName, args: Record<string, unknown>, edited: ReadonlySet<string>): string | null {
  if (tool !== "run_shell" || !edited.size || typeof args.command !== "string") return null;
  const command = args.command;
  // Syntax that can't be split (substitution, subshells): judged by its words alone.
  const parts = splitCommand(command.trim())?.map((p) => p.text) ?? [command];
  for (const text of parts) {
    let argv: string[];
    try {
      argv = parseArgv(text).filter((a) => !/^\d*[<>]/.test(a));
    } catch {
      argv = text.split(/\s+/);
    }
    while (argv.length && (WRAPPERS.has(argv[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]))) {
      argv.shift();
      while (argv.length && (argv[0].startsWith("-") || /^\d+[smhd]?$/.test(argv[0]))) argv.shift();
    }
    const [bin, ...rest] = argv;
    if (!bin) continue;
    const name = bin.split("/").pop()!;
    const hit = (a: string) => {
      const k = editKey(a);
      return k && edited.has(k) ? k : null;
    };
    // `./x.sh`, `tools/x.py` run directly.
    if (bin.includes("/") && hit(bin)) return hit(bin);
    // An interpreter given an edited script (`python3 x.py`, `bash -e x.sh`, `node --test x.js`).
    if (INTERPRETER.test(name)) {
      for (const a of rest) if (hit(a)) return hit(a);
    }
    for (const b of BUILD_FILES) {
      if (!b.runner.test(bin) && !b.runner.test(name)) continue;
      for (const k of edited) if (b.file.test(k)) return k;
    }
    // A config file a tool loads as code: any runner of project tooling could load it.
    for (const k of edited) if (CODE_CONFIG.test(k) && /^(npm|pnpm|yarn|bun|npx|pnpx|bunx|vitest|jest|vite|webpack|rollup|eslint|prettier|tsc|playwright|next|nuxt|astro|svelte-kit|turbo|nx)$/.test(name)) return k;
  }
  return null;
}
