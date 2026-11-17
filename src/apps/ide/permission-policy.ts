// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What a tool call does in each permission mode: run without asking, ask the user, or be refused.
 * One function (decideToolCall) answers it for chat turns, shared sessions and bots, so the four
 * modes mean the same thing everywhere (docs/permission-modes.md):
 *
 *   ask (Manual)          edits and commands ask; read-only tools and commands never do
 *   auto-edits (Accept)   edits inside the project apply (each turn's checkpoint keeps them undoable); commands ask
 *   auto                  safe commands run, risky ones ask, dangerous ones are refused (classifyCommand)
 *   plan                  read-only tools only; everything else is refused until the user approves the plan
 *
 * In every mode a project's "always allow" rules (`npm test:*`) let a matching command run, but a
 * rule never covers a refused command or a class that must always ask (network, push, deletes,
 * paths outside the project): see rememberable().
 */

import { basename } from "node:path";
import { scrubText } from "../../common/redaction.js";
import { isReadOnlyCommand, splitCommand, type PermissionMode } from "./permissions.js";
import { classifyRelativePath, isWithin, parseArgv, protectedToolPath, realPathEscape } from "./tool-executor.js";
import { READ_TOOLS, TENTACLE_TOOLS, WEB_TOOLS, type ToolName } from "./tool-types.js";
import { resolve } from "node:path";

export type Action = "run" | "ask" | "refuse";

/** Why a command is in its class; the classes after "unlisted" can never be allow-listed. */
export type Category =
  | "read"
  | "dev" // tests, lint, typecheck, build, format
  | "git-local" // git add / commit on a work branch
  | "build-clean" // deleting build output inside the project
  | "install"
  | "docker"
  | "script" // a package.json script that isn't a test/lint/build one
  | "git" // other local git commands (checkout, merge, ...)
  | "unlisted" // a program Auto doesn't know
  | "network"
  | "push"
  | "delete"
  | "outside"
  | "protected"
  | "inline" // sh -c, python -c, node -e
  | "syntax" // shell syntax that can't be checked
  | "privilege"
  | "secret"
  | "destructive";

export interface CommandClass {
  action: Action;
  category: Category;
  reason: string;
}

/** Classes an "always allow" rule may cover. */
const REMEMBERABLE = new Set<Category>(["read", "dev", "git-local", "build-clean", "install", "docker", "script", "git", "unlisted"]);

export function rememberable(c: CommandClass): boolean {
  return c.action !== "refuse" && REMEMBERABLE.has(c.category);
}

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "default", "production", "release"]);

/** Directories of generated output that Auto may delete inside the project. */
const BUILD_DIRS = new Set(["dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", "node_modules", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", "tmp", ".tmp"]);

/** Script names (npm run X, make X) that test, lint, typecheck, build or format. */
const DEV_SCRIPT = /^(test|tests|t|unit|e2e|lint|lint:[\w:.-]+|test:[\w:.-]+|build|build:[\w:.-]+|typecheck|type-check|types|check|check:[\w:.-]+|tsc|svelte-check|format|fmt|format:check|prettier|eslint|compile|ci|verify|coverage|all)$/;

/** Test runners, linters, type checkers and formatters that run without asking in Auto. */
const DEV_TOOLS = new Set([
  "vitest", "jest", "mocha", "ava", "tap", "playwright", "pytest", "tsc", "eslint", "prettier", "svelte-check", "biome", "oxlint",
  "ruff", "mypy", "pyright", "flake8", "pylint", "black", "isort", "rubocop", "rspec", "phpunit", "golangci-lint", "gofmt", "rustfmt",
  "shellcheck", "stylelint", "tsx", "ts-node", "vite", "webpack", "rollup", "esbuild", "turbo", "nx",
]);

/** `cargo X`, `go X`, ... subcommands that build, test, lint or format. */
const DEV_SUBCOMMANDS: Record<string, RegExp> = {
  cargo: /^(test|build|check|clippy|fmt|bench|doc|run)$/,
  go: /^(test|build|vet|fmt|run)$/,
  deno: /^(test|lint|check|fmt|bench)$/,
  swift: /^(build|test)$/,
  dotnet: /^(build|test|format)$/,
  mvn: /^(test|compile|verify|package)$/,
  gradle: /^(test|build|check|assemble)$/,
  "./gradlew": /^(test|build|check|assemble)$/,
  bundle: /^exec$/,
};

/** Package managers whose `X` or `run X` is a project script. */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Package-manager subcommands that install or fetch other people's code. */
const INSTALL_SUBCOMMANDS: Record<string, RegExp> = {
  npm: /^(i|install|add|ci|update|upgrade|link|exec|x|publish|uninstall|remove|rm)$/,
  pnpm: /^(i|install|add|update|up|dlx|exec|link|publish|remove|rm)$/,
  yarn: /^(add|install|upgrade|dlx|link|publish|global|remove)$/,
  bun: /^(add|install|i|update|x|link|publish|remove)$/,
  pip: /^(install|download|uninstall)$/,
  pip3: /^(install|download|uninstall)$/,
  pipx: /^(install|run|inject)$/,
  uv: /^(add|pip|tool|sync)$/,
  poetry: /^(add|install|update)$/,
  brew: /.*/,
  apt: /.*/,
  "apt-get": /.*/,
  yum: /.*/,
  dnf: /.*/,
  pacman: /.*/,
  port: /.*/,
  gem: /^(install|update|uninstall)$/,
  cargo: /^(install|add|uninstall|publish)$/,
  go: /^(install|get)$/,
  composer: /^(require|install|update)$/,
};
const NETWORK_BINS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "http", "https", "aria2c", "gh", "httpie", "xh"]);
const DOCKER_BINS = new Set(["docker", "docker-compose", "podman", "kubectl", "helm", "minikube", "kind", "colima", "nerdctl"]);
const PRIVILEGE_BINS = new Set(["sudo", "su", "doas", "pkexec", "runas"]);
/** Programs that change or remove things a checkpoint can't restore. */
const DESTRUCTIVE_BINS = new Set(["shred", "dd", "mkfs", "fdisk", "diskutil", "format", "chown", "chgrp", "chmod", "kill", "killall", "pkill", "shutdown", "reboot", "halt", "launchctl", "systemctl", "crontab", "mv"]);
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** Shells, by name (kept as a list so no source line reads like a pipe into a shell). */
const SHELL_NAMES = ["sh", "bash", "zsh", "dash", "ksh", "fish"];
const INTERPRETERS = new RegExp(`^(node|python\\d*(\\.\\d+)?|deno|bun|ruby|perl|php|${SHELL_NAMES.join("|")})$`);
/** A download piped into a shell or an interpreter (`curl URL`, a pipe, then `sh`, `bash`, `python`, ...). */
const DOWNLOAD_PIPED_TO = new RegExp(`\\b(curl|wget|fetch)\\b[^|]*\\|\\s*(sudo\\s+)?(env\\s+)?(${[...SHELL_NAMES, "python\\d*", "node", "ruby", "perl"].join("|")})\\b`);
const INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep"]);

/** `rm` targets that wipe a disk, a home folder or the whole project. */
const WIPE_TARGET = /^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?|\$\{HOME\}\/?|\.|\.\/|\.\/\*|\*|\.\.|\.\.\/|\.\.\/\*)$/;

/** Files that hold credentials: Auto refuses to write them; other modes ask (never auto-apply). */
export function isSecretPath(path: unknown): boolean {
  if (typeof path !== "string" || !path.trim()) return false;
  const p = path.replace(/\\/g, "/");
  const name = basename(p).toLowerCase();
  if (/^\.env(\.|$)/.test(name) && !/\.(example|sample|template|dist|defaults?)$/.test(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)) return true;
  if ([".npmrc", ".pypirc", ".netrc", ".git-credentials", ".dockercfg", "credentials", "credentials.json", "secrets.json", "secrets.yaml", "secrets.yml", "service-account.json", ".htpasswd"].includes(name)) return true;
  return /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker)\//.test(p);
}

const EXTRA_SECRET_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eck_[A-Za-z0-9_-]{20,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Text that contains what looks like a credential (API key, token, private key). */
export function containsSecret(text: unknown): boolean {
  if (typeof text !== "string" || text.length < 8) return false;
  return scrubText(text) !== text || EXTRA_SECRET_RE.test(text);
}

function escapes(arg: string, root: string): boolean {
  const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
  if (!value || (value.startsWith("-") && !value.includes("/"))) return false;
  if (value.startsWith("~") || value.startsWith("$")) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // a URL is not a path
  const abs = resolve(root, value);
  if (!isWithin(root, abs)) return true;
  return realPathEscape(root, abs) !== null;
}

function protectedArg(arg: string, root: string): boolean {
  if (arg.startsWith("-")) return false;
  try {
    const abs = resolve(root, arg);
    if (!isWithin(root, abs)) return false;
    return classifyRelativePath(abs.slice(root.length + 1)) !== null;
  } catch {
    return false;
  }
}

/** Splits redirections (`> file`, `2>>log`) out of a segment; null when unreadable. */
function redirections(segment: string): { rest: string; targets: string[]; inputs: string[] } | null {
  const targets: string[] = [];
  const inputs: string[] = [];
  let rest = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      rest += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      rest += ch;
      continue;
    }
    if (ch === ">" || ch === "<") {
      let j = i + 1;
      if (segment[j] === ">" || segment[j] === "&") j++;
      while (segment[j] === " ") j++;
      let k = j;
      while (k < segment.length && !/\s/.test(segment[k])) k++;
      const target = segment.slice(j, k);
      if (!target) return null;
      rest = rest.replace(/\d$/, "");
      if (ch === ">") {
        if (!/^\d$/.test(target) && target !== "-" && target !== "/dev/null") targets.push(target);
      } else inputs.push(target);
      i = k - 1;
      continue;
    }
    rest += ch;
  }
  return { rest: rest.trim(), targets, inputs };
}

const RANK: Record<Action, number> = { run: 0, ask: 1, refuse: 2 };
const run = (category: Category, reason: string): CommandClass => ({ action: "run", category, reason });
const ask = (category: Category, reason: string): CommandClass => ({ action: "ask", category, reason });
const refuse = (category: Category, reason: string): CommandClass => ({ action: "refuse", category, reason });

export interface CommandContext {
  /** The project folder: paths outside it ask. */
  root: string;
  /** The branch the session works on (HEAD); git commit runs in Auto only on a non-default branch. */
  branch?: string | null;
}

/** One command segment (no pipes or `&&`), already without its redirections. */
function classifySegment(argvIn: string[], ctx: CommandContext): CommandClass {
  let argv = [...argvIn];
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
  if (!argv.length) return run("read", "sets variables");
  // Wrappers: look at what they run.
  while (argv.length && ["env", "command", "exec", "nohup", "time", "nice", "timeout"].includes(argv[0])) {
    const w = argv.shift()!;
    argv = argv.filter((a, i) => !(i === 0 && w === "timeout" && /^\d/.test(a)));
    while (argv.length && (argv[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) || (w === "nice" && /^\d+$/.test(argv[0])))) argv.shift();
  }
  if (!argv.length) return ask("unlisted", "prints the environment");
  const [bin, ...args] = argv;
  const name = bin.split("/").pop()!;
  const sub = args.find((a) => !a.startsWith("-")) ?? "";

  if (PRIVILEGE_BINS.has(name)) return refuse("privilege", `${name} runs commands as another user`);
  if (name === "xargs") return ask("inline", "xargs runs commands from its input");
  if (name === "rm" || name === "rmdir" || name === "unlink") {
    const targets = args.filter((a) => !a.startsWith("-"));
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    if (args.includes("--no-preserve-root") || targets.some((t) => WIPE_TARGET.test(t))) return refuse("destructive", "deletes a disk, a home folder or the whole project");
    if (!targets.length) return ask("delete", `${name} with nothing to delete`);
    if (targets.some((t) => escapes(t, ctx.root))) return ask("outside", `${name} deletes outside the project`);
    const inBuild = targets.every((t) => {
      const rel = resolve(ctx.root, t).slice(ctx.root.length + 1).split(/[\\/]+/);
      return rel.length >= 1 && rel[0] !== "" && BUILD_DIRS.has(rel[0]) && !/[*?]/.test(rel[0]);
    });
    if (inBuild) return run("build-clean", "deletes build output inside the project");
    return ask("delete", `${name}${recursive ? " -r" : ""} deletes project files a checkpoint can't restore`);
  }
  if (bin.includes("/") && escapes(bin, ctx.root)) return ask("outside", `runs a program outside the project (${bin})`);
  if (DESTRUCTIVE_BINS.has(name)) {
    if (name === "mv" && args.filter((a) => !a.startsWith("-")).every((a) => !escapes(a, ctx.root) && !protectedArg(a, ctx.root))) return ask("unlisted", "mv moves files a checkpoint can't restore");
    return ask("destructive", `${name} changes things a checkpoint can't restore`);
  }
  if (NETWORK_BINS.has(name)) return ask("network", `${name} reaches the network`);
  if (DOCKER_BINS.has(name)) return ask("docker", `${name} runs containers`);
  if (INTERPRETERS.test(name) && args.some((a) => INLINE_FLAGS.has(a) || /^-[a-zA-Z]*c$/.test(a))) return ask("inline", `${name} runs code given inline`);
  if (name === "python" || name === "python3") {
    // python -m pytest / unittest / mypy / ruff
    const m = args[0] === "-m" ? args[1] ?? "" : "";
    if (/^(pytest|unittest|mypy|ruff|black|flake8|pylint|pyright|isort|compileall)$/.test(m)) return run("dev", `python -m ${m}`);
    if (m === "pip") return ask("install", "pip installs packages");
    if (m) return ask("unlisted", `python -m ${m} isn't on Auto's list`);
  }
  if (RUNNERS.has(name)) {
    const at = args.findIndex((a) => !a.startsWith("-"));
    const tool = at >= 0 ? args[at] : "";
    // Flags before the tool name belong to npx (--package / -y fetch something else).
    if (DEV_TOOLS.has(tool) && !args.slice(0, at).some((a) => a === "-y" || a === "--yes" || a.startsWith("--package") || a === "-p")) return run("dev", `${name} ${tool} (a test, lint, typecheck or build tool)`);
    return ask("install", `${name} downloads and runs a package`);
  }
  if (INSTALL_SUBCOMMANDS[name]?.test(sub)) return ask("install", `${name} ${sub} installs packages`.replace(/\s+/g, " "));
  if (name === "git") {
    if (args.includes("-c") || args.some((a) => a.startsWith("--config") || a.startsWith("--exec-path") || a.startsWith("--git-dir") || a.startsWith("--work-tree"))) return ask("git", "changes git configuration");
    if (sub === "push") return ask("push", "git push publishes commits");
    if (["fetch", "pull", "clone", "submodule", "ls-remote"].includes(sub)) return ask("network", `git ${sub} reaches the network`);
    if (GIT_READ.has(sub)) return run("read", `git ${sub} only reads`);
    if (sub === "add") return run("git-local", "git add stages changes");
    if (sub === "commit") {
      if (args.includes("--amend")) return ask("git", "git commit --amend rewrites the last commit");
      const b = ctx.branch ?? null;
      if (b && !DEFAULT_BRANCHES.has(b)) return run("git-local", `git commit on the work branch ${b}`);
      return ask("git", b ? `git commit on the default branch (${b})` : "git commit outside a named branch");
    }
    if (sub === "reset" && args.includes("--hard")) return ask("destructive", "git reset --hard discards changes");
    if (sub === "clean") return ask("delete", "git clean deletes untracked files");
    if (["rebase", "filter-branch", "filter-repo"].includes(sub)) return ask("destructive", `git ${sub} rewrites history`);
    if (sub === "config") return ask("git", "changes git configuration");
    return ask("git", `git ${sub} isn't on Auto's list`);
  }
  if (SCRIPT_RUNNERS.has(name)) {
    if (/^(test|t)$/.test(sub)) return run("dev", `${name} test`);
    if (sub === "run" || sub === "run-script") {
      const script = args.filter((a) => !a.startsWith("-"))[1] ?? "";
      if (DEV_SCRIPT.test(script)) return run("dev", `${name} run ${script}`);
      return ask("script", `${name} run ${script || "(no script)"} isn't a test, lint or build script`);
    }
    if ((name === "yarn" || name === "pnpm" || name === "bun") && DEV_SCRIPT.test(sub)) return run("dev", `${name} ${sub}`);
    if (name === "bun" && sub && /\.(ts|js|mjs|cjs|tsx)$/.test(sub)) return ask("unlisted", `bun runs ${sub}`);
    return ask("script", `${name} ${sub} isn't on Auto's list`);
  }
  if (name === "make" || name === "just" || name === "task") {
    const target = args.find((a) => !a.startsWith("-") && !a.includes("="));
    if (!target || DEV_SCRIPT.test(target)) return run("dev", `${name}${target ? ` ${target}` : ""}`);
    return ask("script", `${name} ${target} isn't a test, lint or build target`);
  }
  if (DEV_SUBCOMMANDS[bin] || DEV_SUBCOMMANDS[name]) {
    const re = DEV_SUBCOMMANDS[bin] ?? DEV_SUBCOMMANDS[name];
    if (re.test(sub)) return run("dev", `${name} ${sub}`);
    return ask("unlisted", `${name} ${sub} isn't on Auto's list`);
  }
  if (DEV_TOOLS.has(name)) return run("dev", `${name} (a test, lint, typecheck or build tool)`);
  if (name === "node" && args.includes("--test")) return run("dev", "node --test");
  if (isReadOnlyCommand(argv.map((a) => (/[\s'"]/.test(a) ? `'${a.replace(/'/g, "")}'` : a)).join(" "), ctx.root)) return run("read", "only reads");
  if (["mkdir", "touch", "cp", "ln", "tee", "sed", "awk", "patch", "tar", "unzip", "zip", "gzip"].includes(name)) return ask("unlisted", `${name} changes files outside the edit tools`);
  return ask("unlisted", `${name} isn't on Auto's list of safe commands`);
}

/**
 * Auto mode's verdict on a shell command: run (reads; tests, lint, typecheck, build; git status,
 * diff, add, commit on a work branch; deleting build output), ask (installs, network, git push,
 * deletes, paths outside the project, Docker, unknown programs) or refuse (sudo, wiping a disk or
 * home folder, a download piped into a shell, writing secrets).
 */
export function classifyCommand(command: unknown, ctx: CommandContext): CommandClass {
  if (typeof command !== "string" || !command.trim()) return ask("syntax", "an empty or malformed command");
  const c = command.trim();
  if (DOWNLOAD_PIPED_TO.test(c)) return refuse("destructive", "downloads a script and pipes it into a shell");
  if (/(^|[\s;&|])(sudo|doas|su)\s/.test(c)) return refuse("privilege", "runs commands as another user (sudo)");
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(c)) return refuse("destructive", "a fork bomb");
  if (/\bmkfs(\.\w+)?\b|\bdd\b[^|]*\bof=\/dev\//.test(c)) return refuse("destructive", "writes a raw disk");
  if (containsSecret(c)) return refuse("secret", "contains what looks like an API key or token");
  if (isReadOnlyCommand(c, ctx.root)) return run("read", "only reads inside the project");
  const parts = splitCommand(c);
  if (!parts) {
    // A plain `rm -rf /`-style wipe is still refused even inside syntax we don't read.
    if (/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(\/|~|\$HOME)(\s|$|\/\*)/.test(c)) return refuse("destructive", "deletes a disk or a home folder");
    return ask("syntax", "uses shell syntax that can't be checked (command substitution, subshells or here-docs)");
  }
  let worst: CommandClass = run("read", "only reads");
  const take = (k: CommandClass) => {
    // Same verdict: the reason that can't be allow-listed wins (so a rule never covers it).
    if (RANK[k.action] > RANK[worst.action] || (RANK[k.action] === RANK[worst.action] && ((worst.category === "read" && k.category !== "read") || (REMEMBERABLE.has(worst.category) && !REMEMBERABLE.has(k.category))))) worst = k;
  };
  for (const p of parts) {
    if (p.op === "&") take(ask("syntax", "runs something in the background"));
    const r = redirections(p.text);
    if (!r) return ask("syntax", "has a redirection that can't be checked");
    for (const t of r.targets) {
      if (isSecretPath(t)) return refuse("secret", `writes a secrets file (${t})`);
      if (escapes(t, ctx.root)) take(ask("outside", `writes outside the project (${t})`));
      else if (protectedArg(t, ctx.root)) take(ask("protected", `writes a protected path (${t})`));
      else take(ask("unlisted", `writes ${t} outside the edit tools`));
    }
    for (const t of r.inputs) if (escapes(t, ctx.root)) take(ask("outside", `reads outside the project (${t})`));
    let argv: string[];
    try {
      argv = parseArgv(r.rest);
    } catch {
      return ask("syntax", "has an unterminated quote");
    }
    const k = classifySegment(argv, ctx);
    if (k.action === "refuse") return k;
    take(k);
    // Arguments that reach outside the project or into protected paths ask, whatever the program.
    if (k.category !== "outside" && k.category !== "network" && k.category !== "build-clean") {
      for (const a of argv.slice(1)) {
        if (isSecretPath(a) && /^(cp|mv|tee|ln|install|sed|truncate)$/.test(argv[0])) return refuse("secret", `writes a secrets file (${a})`);
        if (escapes(a, ctx.root)) {
          take(ask("outside", `touches a path outside the project (${a})`));
          break;
        }
        if (protectedArg(a, ctx.root)) {
          take(ask("protected", `touches a protected path (${a})`));
          break;
        }
      }
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------
// "Always allow" rules: `npm test:*` (prefix) or `npm test` (exact)
// ---------------------------------------------------------------------------

const RULE_TOKEN = /^[A-Za-z0-9._\-/:=@+,%]+$/;
const SHELL_META = /[;&|`$<>(){}\\\n\r]/;

/** A rule as tokens; null when it isn't one. A single word ("npm", older entries) is a prefix. */
export function parseRule(rule: unknown): { tokens: string[]; prefix: boolean } | null {
  if (typeof rule !== "string") return null;
  const r = rule.trim();
  if (!r || r.length > 200) return null;
  const prefix = r.endsWith(":*");
  const body = prefix ? r.slice(0, -2).trim() : r;
  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 8 || !tokens.every((t) => RULE_TOKEN.test(t))) return null;
  if (tokens[0].includes("/") && !tokens[0].startsWith("./")) return null;
  return { tokens, prefix: prefix || tokens.length === 1 };
}

export function isValidRule(rule: unknown): rule is string {
  return parseRule(rule) !== null;
}

/** True when the rule covers this exact command: a plain command (no shell syntax) starting with the rule's words. */
export function ruleMatches(rule: string, command: unknown): boolean {
  const r = parseRule(rule);
  if (!r || typeof command !== "string") return false;
  const c = command.trim();
  if (!c || SHELL_META.test(c)) return false;
  let argv: string[];
  try {
    argv = parseArgv(c);
  } catch {
    return false;
  }
  if (argv.length < r.tokens.length || (!r.prefix && argv.length !== r.tokens.length)) return false;
  return r.tokens.every((t, i) => argv[i] === t);
}

/** The rule "Always allow" offers for a command (`npm test:*`, `npm run lint:*`), or null when none may be kept. */
export function suggestRule(command: unknown, ctx: CommandContext): string | null {
  if (typeof command !== "string") return null;
  const c = command.trim();
  if (!c || SHELL_META.test(c)) return null;
  if (!rememberable(classifyCommand(c, ctx))) return null;
  let argv: string[];
  try {
    argv = parseArgv(c);
  } catch {
    return null;
  }
  const word = (s: string | undefined) => !!s && /^[A-Za-z][A-Za-z0-9:_.-]*$/.test(s) && s.length <= 40;
  const [a, b, d] = argv;
  if (!a || !RULE_TOKEN.test(a) || (a.includes("/") && !a.startsWith("./"))) return null;
  let tokens = [a];
  if (word(b)) tokens = ["run", "run-script", "exec", "x", "-m"].includes(b) && word(d) ? [a, b, d] : [a, b];
  else if (b === "-m" && word(d)) tokens = [a, b, d];
  const rule = `${tokens.join(" ")}:*`;
  return parseRule(rule) ? rule : null;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface Decision {
  action: Action;
  reason: string;
  /** The "Always allow" rule the approval card may offer (asks only). */
  rule?: string;
}

export interface DecideContext {
  mode: PermissionMode;
  root: string;
  /** "Always allow" rules for this project (and session). */
  rules?: readonly string[];
  /** Older "always" entries: a program name, covering only commands riskOf finds safe. */
  legacyNames?: readonly string[];
  /** The current branch (asked lazily: only git commits need it). */
  branch?: () => string | null;
  /** Older "always" answer for edits in this project. */
  editsAlways?: boolean;
}

/** Tools that ask in every mode (they publish or reach other people). */
export const ALWAYS_ASK: ReadonlySet<ToolName> = new Set<ToolName>(["git_push", "open_pull_request", "github_create_pr"]);

export const PLAN_REFUSAL = "Plan mode: only read-only tools until the user approves the plan. Finish your investigation and reply with the plan.";

/** True for a call that only reads (plan mode allows it). */
export function isReadOnlyCall(tool: ToolName, args: Record<string, unknown>, root: string): boolean {
  if (READ_TOOLS.has(tool) && !TENTACLE_TOOLS.has(tool)) return true;
  return tool === "run_shell" && isReadOnlyCommand(args.command, root);
}

function ruleCovers(ctx: DecideContext, command: unknown, cls: CommandClass, legacySafe: () => boolean): boolean {
  if (!rememberable(cls)) return false;
  if ((ctx.rules ?? []).some((r) => ruleMatches(r, command))) return true;
  // Older program-name entries keep their old meaning: only commands that aren't risky.
  if ((ctx.legacyNames ?? []).some((n) => ruleMatches(n, command))) return legacySafe();
  return false;
}

/**
 * What a tool call does in this mode: run, ask or refuse. Read-only tools always run; Plan refuses
 * anything else; Auto refuses dangerous commands and secret writes.
 */
export function decideToolCall(tool: ToolName, args: Record<string, unknown>, ctx: DecideContext, legacyRisk?: (command: unknown) => string | null): Decision {
  if (READ_TOOLS.has(tool)) return { action: "run", reason: "reads only" };
  // The web tool is offered only when the chat's Web toggle or the bot's "Search the web" permission
  // is on: that is the allowance. Manual mode still asks for each call (it costs cSats and sends the
  // query off this machine); Plan may use it (it changes nothing).
  if (WEB_TOOLS.has(tool)) return ctx.mode === "ask" ? { action: "ask", reason: "web access asks in Manual mode" } : { action: "run", reason: "web access is on" };
  if (ctx.mode === "plan") {
    if (tool === "run_shell" && isReadOnlyCommand(args.command, ctx.root)) return { action: "run", reason: "a read-only command" };
    return { action: "refuse", reason: PLAN_REFUSAL };
  }
  if (ALWAYS_ASK.has(tool)) return { action: "ask", reason: `${tool.replace(/_/g, " ")} always asks` };
  if (tool === "run_shell") {
    const cls = classifyCommand(args.command, { root: ctx.root, branch: ctx.branch?.() ?? null });
    if (cls.action === "refuse") return ctx.mode === "auto" ? { action: "refuse", reason: `Auto mode refuses this: ${cls.reason}.` } : { action: "ask", reason: cls.reason };
    if (cls.category === "read") return { action: "run", reason: cls.reason };
    if (ruleCovers(ctx, args.command, cls, () => !legacyRisk || legacyRisk(args.command) === null)) return { action: "run", reason: "an always-allow rule for this project" };
    if (ctx.mode === "auto" && cls.action === "run") return { action: "run", reason: cls.reason };
    const rule = suggestRule(args.command, { root: ctx.root, branch: null });
    return { action: "ask", reason: cls.reason, ...(rule ? { rule } : {}) };
  }
  if (tool === "write_file" || tool === "edit_file") {
    const path = args.path;
    const content = tool === "write_file" ? args.content : args.new_string;
    if (isSecretPath(path) || containsSecret(content)) {
      const why = isSecretPath(path) ? `writes a secrets file (${String(path)})` : "writes what looks like an API key or token";
      return ctx.mode === "auto" ? { action: "refuse", reason: `Auto mode refuses this: it ${why}.` } : { action: "ask", reason: why };
    }
    if (protectedToolPath(path) !== null) return { action: "ask", reason: "a protected path (git, hooks, files tooling runs)" };
    if (typeof path === "string" && (path.startsWith("~") || !isWithin(ctx.root, resolve(ctx.root, path)))) return { action: "ask", reason: "a file outside the project" };
    if (ctx.mode === "auto" || ctx.mode === "auto-edits" || ctx.editsAlways) return { action: "run", reason: "edits apply in this mode (undoable)" };
    return { action: "ask", reason: "edits ask in Manual mode" };
  }
  if (tool === "git_commit") {
    if (ctx.mode === "auto") {
      const b = ctx.branch?.() ?? null;
      if (b && !DEFAULT_BRANCHES.has(b)) return { action: "run", reason: `commits on the work branch ${b}` };
      return { action: "ask", reason: b ? `commits on the default branch (${b})` : "commits outside a named branch" };
    }
    return { action: "ask", reason: "commits ask" };
  }
  if (tool === "git_branch" && ctx.mode === "auto") return { action: "run", reason: "a local branch" };
  return { action: "ask", reason: `${tool.replace(/_/g, " ")} asks` };
}
