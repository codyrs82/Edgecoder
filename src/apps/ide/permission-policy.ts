// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What a tool call does in each permission mode: run without asking, ask the user, or be refused.
 * One function (decideToolCall) answers it for chat turns, shared sessions and bots, so the five
 * modes mean the same thing everywhere (docs/permission-modes.md):
 *
 *   ask (Manual)          edits and commands ask; read-only tools and commands never do
 *   auto-edits (Accept)   edits inside the project apply (each turn's checkpoint keeps them undoable); commands ask
 *   auto                  safe commands run, risky ones ask, dangerous ones are refused (classifyCommand)
 *   plan                  read-only tools only; everything else is refused until the user approves the plan
 *   full (Full access)    nothing asks: edits, commands, commits, pushes and PRs run; the hard refusals
 *                         (classifyCommand's "refuse": sudo, wiping a disk/home/the project, fork bomb,
 *                         raw disk, download-and-run, secrets) stay refused. Set by the session's owner
 *                         only (sessions.ts: this computer, or the owner's phone/web after a confirm).
 *
 * "Allow for this session" (session-allowances.ts withAllowances) is applied on top of these verdicts:
 * it can only turn an ask into a run, never touches a refusal.
 *
 * Auto with the sandbox on (sandbox.ts; Settings → General) also runs, without asking, a command it would
 * ask about only because it can't check the code it runs (`python3 - <<'EOF'`, `node -e`, `python3
 * tools/x.py`, `./scripts/x.sh`): inside an OS sandbox that writes only in the project and has no
 * network (sandboxable()).
 *
 * In every mode a project's "always allow" rules (`npm test:*`) let a matching command run, but a
 * rule never covers a refused command or a class that must always ask (network other than a plain
 * `git fetch` / `git pull`, push, deletes, paths outside the project): see rememberable().
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { scrubText } from "../../common/redaction.js";
import { isReadOnlyCommand, splitCommand, type PermissionMode } from "./permissions.js";
import { classifyRelativePath, isWithin, parseArgv, protectedToolPath, realPathEscape } from "./tool-executor.js";
import { READ_TOOLS, TENTACLE_TOOLS, WEB_TOOLS, type ToolName } from "./tool-types.js";
import { stripHeredocs } from "./sandbox.js";
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
  | "git-sync" // a plain git fetch / git pull from a named remote (asks, but may be always-allowed)
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
const REMEMBERABLE = new Set<Category>(["read", "dev", "git-local", "build-clean", "install", "docker", "script", "git", "git-sync", "unlisted"]);

export function rememberable(c: CommandClass): boolean {
  return c.action !== "refuse" && REMEMBERABLE.has(c.category);
}

export const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "trunk", "default", "production", "release"]);

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
  // Node version managers: installing a version downloads it (docs/permission-modes.md, "Node versions").
  nvm: /^(install|i|reinstall-packages|install-latest-npm|uninstall)$/,
  fnm: /^(install|i|uninstall)$/,
  volta: /^(install|fetch|pin|uninstall)$/,
  mise: /^(install|i|use|u|upgrade|up|uninstall|plugins?)$/,
  asdf: /^(install|uninstall|plugin)$/,
  pyenv: /^(install|uninstall)$/,
};

/** A Node version as nvm/fnm take it: 22, v22.12.0, lts/jod, --lts, node. */
const NODE_VERSION_ARG = /^(v?\d+(\.\d+){0,2}|lts\/[\w*-]+|--lts(=[\w-]+)?|node|--silent)$/;

/**
 * A segment that only selects the Node version for the segments after it (`. "$HOME/.nvm/nvm.sh"`,
 * `nvm use 22 >/dev/null`): it runs nothing of the project's, so it adds no class of its own and
 * the commands it wraps are judged as themselves. nvm.sh must be outside the project (a project
 * can't ship its own "nvm.sh" to be sourced).
 */
export function isNodeVersionSetup(argv: string[], root: string): boolean {
  if ((argv[0] === "source" || argv[0] === ".") && argv.length === 2) {
    const p = argv[1];
    if (!/(^|\/)nvm\.sh$/.test(p)) return false;
    if (/^(\$NVM_DIR|\$\{NVM_DIR\}|\$HOME|\$\{HOME\}|~)\/(\.nvm\/)?nvm\.sh$/.test(p)) return true;
    return p.startsWith("/") && !p.includes("$") && !isWithin(root, resolve(p));
  }
  if (argv[0] === "nvm" && argv[1] === "use") return argv.length <= 4 && argv.slice(2).every((a) => NODE_VERSION_ARG.test(a));
  return false;
}

/** `PATH=...` before a command: only absolute folders outside the project, plus the old $PATH. */
function safePathAssignment(value: string, root: string): boolean {
  return value.split(":").every((dir) => dir === "$PATH" || dir === "${PATH}" || (dir.startsWith("/") && !/[$`]/.test(dir) && !isWithin(root, resolve(dir))));
}

/** The command a version wrapper runs (`fnm exec --using=22 npm ci` is `npm ci`); null when it isn't one. */
function unwrapVersionManager(argv: string[]): { inner: string[]; mayDownload: string | null } | null {
  const [bin, sub] = argv;
  const name = (bin ?? "").split("/").pop();
  if (name === "fnm" && sub === "exec") {
    let i = 2;
    while (i < argv.length && argv[i].startsWith("-")) {
      if (argv[i] === "--") {
        i++;
        break;
      }
      if (argv[i] === "--using") i++;
      i++;
    }
    return { inner: argv.slice(i), mayDownload: null };
  }
  if (name === "nvm" && (sub === "exec" || sub === "run")) {
    let i = 2;
    while (i < argv.length && NODE_VERSION_ARG.test(argv[i])) i++;
    return { inner: sub === "run" ? ["node", ...argv.slice(i)] : argv.slice(i), mayDownload: null };
  }
  if (name === "asdf" && sub === "exec") return { inner: argv.slice(2), mayDownload: null };
  // These install a missing version before running: they ask like an install.
  if (name === "volta" && sub === "run") {
    let i = 2;
    while (i < argv.length && argv[i].startsWith("-")) i += /^--(node|npm|yarn|pnpm)$/.test(argv[i]) ? 2 : 1;
    return { inner: argv.slice(i), mayDownload: "volta run downloads a missing Node version" };
  }
  if (name === "mise" && (sub === "exec" || sub === "x")) {
    const dd = argv.indexOf("--");
    return { inner: dd >= 0 ? argv.slice(dd + 1) : [], mayDownload: "mise exec installs missing tool versions" };
  }
  return null;
}
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
const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "rev-list", "merge-base", "show-ref", "for-each-ref", "ls-tree", "name-rev", "ls-files", "blame", "describe", "shortlog", "grep"]);
/**
 * Options a plain `git fetch` / `git pull` may carry and still be always-allowed. Anything else
 * (`--upload-pack`, `--recurse-submodules`, `--set-upstream`, refspecs, URLs, paths) stays "network".
 */
const GIT_SYNC_FLAG = /^(-q|--quiet|-v|--verbose|--progress|--no-progress|-p|--prune|--prune-tags|-t|--tags|--no-tags|--all|--dry-run|--unshallow|--depth=\d{1,6}|--rebase|--rebase=(true|false|merges)|--no-rebase|--ff|--no-ff|--ff-only|--autostash|--no-autostash|--no-edit|--stat|--no-stat|-n)$/;
const GIT_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GIT_BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

/** True for `git fetch|pull [allowed options] [remote [branch...]]` naming a remote, not a URL or a path. */
function plainGitSync(args: string[], sub: string, root: string): boolean {
  if (args[0] !== sub) return false; // options before the subcommand (-C, --git-dir, ...) change where git looks
  const rest = args.slice(1);
  if (!rest.filter((a) => a.startsWith("-")).every((a) => GIT_SYNC_FLAG.test(a))) return false;
  const [remote, ...refs] = rest.filter((a) => !a.startsWith("-"));
  if (remote !== undefined) {
    if (!GIT_REMOTE_NAME.test(remote) || remote.includes("..")) return false;
    // A folder of that name would be read as a path to another repository.
    try {
      if (existsSync(resolve(root, remote))) return false;
    } catch {
      return false;
    }
  }
  if (sub === "fetch" && refs.length) return false; // refspecs can overwrite local refs
  return refs.every((r) => GIT_BRANCH_NAME.test(r) && !r.includes("..") && !r.includes("//"));
}

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
      rest = rest.replace(/[\d&]$/, ""); // the fd before `2>`, or the & of `&>`
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

/** Programs that run the command after them (classifySegment judges that command). */
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "nice", "timeout"]);

/** One command segment (no pipes or `&&`), already without its redirections. */
function classifySegment(argvIn: string[], ctx: CommandContext): CommandClass {
  let argv = [...argvIn];
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    const a = argv.shift()!;
    // PATH=/opt/homebrew/opt/node@22/bin:$PATH npm ci is the command it runs; a PATH into the
    // project (or a relative one) would swap in the project's own programs.
    if (a.startsWith("PATH=") && !safePathAssignment(a.slice(5), ctx.root)) return ask("outside", "sets PATH to a folder inside the project or a relative one");
  }
  if (!argv.length) return run("read", "sets variables");
  // Wrappers: look at what they run.
  while (argv.length && WRAPPERS.has(argv[0])) {
    const w = argv.shift()!;
    argv = argv.filter((a, i) => !(i === 0 && w === "timeout" && /^\d/.test(a)));
    while (argv.length && (argv[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) || (w === "nice" && /^\d+$/.test(argv[0])))) argv.shift();
  }
  if (!argv.length) return ask("unlisted", "prints the environment");
  // Node version wrappers (fnm exec, nvm exec, volta run, mise exec): judged by what they run.
  const wrapped = unwrapVersionManager(argv);
  if (wrapped) {
    if (!wrapped.inner.length) return ask("unlisted", `${argv[0]} ${argv[1]} with no command`);
    const inner = classifySegment(wrapped.inner, ctx);
    if (!wrapped.mayDownload || inner.action === "refuse" || !REMEMBERABLE.has(inner.category)) return inner;
    return ask("install", wrapped.mayDownload);
  }
  const [bin, ...args] = argv;
  const name = bin.split("/").pop()!;
  const sub = args.find((a) => !a.startsWith("-")) ?? "";

  if (PRIVILEGE_BINS.has(name)) return refuse("privilege", `${name} runs commands as another user`);
  if (name === "xargs") return ask("inline", "xargs runs commands from its input");
  if (name === "eval" || name === "source" || name === "." || name === "trap") return ask("inline", `${name} runs shell code it is given`);
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
    if ((sub === "fetch" || sub === "pull") && plainGitSync(args, sub, ctx.root)) return ask("git-sync", `git ${sub} reaches the network`);
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
  const judged = judgeParts(parts, ctx);
  if (!judged.ok) return judged.cls;
  let worst: CommandClass = run("read", "only reads");
  for (const p of judged.parts) {
    const k = p.cls;
    // Same verdict: the reason that can't be allow-listed wins (so a rule never covers it).
    if (RANK[k.action] > RANK[worst.action] || (RANK[k.action] === RANK[worst.action] && ((worst.category === "read" && k.category !== "read") || (REMEMBERABLE.has(worst.category) && !REMEMBERABLE.has(k.category))))) worst = k;
  }
  if (!judged.parts.length) return ask("unlisted", "only selects a Node version");
  return worst;
}

/** One part of a command line (between `|`, `;`, `&&`, `||`), judged on its own. */
export interface CommandPart {
  /** The part without its redirections (`python3 tools/x.py SPY` for `python3 tools/x.py SPY 2>&1`). */
  text: string;
  cls: CommandClass;
  /** Files it writes through `>` / `>>` (not `2>&1` or /dev/null). */
  writes: string[];
}

/**
 * A shell or interpreter fed its code on stdin (piped into `sh` or `python3 -`, or `bash < x.sh`): it runs
 * whatever the pipe or file carries, so no rule may cover it.
 */
function runsStdin(argvIn: string[], stdinFed: boolean): boolean {
  if (!stdinFed) return false;
  // Past wrappers and their options (`env FOO=1 sh`, `nice -n 5 bash`, `timeout 5 python3`).
  let i = 0;
  while (i < argvIn.length && (WRAPPERS.has(argvIn[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argvIn[i]) || (i > 0 && (argvIn[i].startsWith("-") || /^\d+[smhd]?$/.test(argvIn[i]))))) i++;
  const argv = argvIn.slice(i);
  const name = (argv[0] ?? "").split("/").pop() ?? "";
  if (!INTERPRETERS.test(name)) return false;
  const operands = argv.slice(1).filter((a) => !a.startsWith("-") || a === "-");
  return operands.length === 0 || operands[0] === "-" || /^\/dev\/(stdin|fd\/0)$/.test(operands[0]);
}

/**
 * Each part of a split command with its class, or the verdict for the whole command when a part
 * is refused or can't be read. Node version setup parts (`. ~/.nvm/nvm.sh &&`) are left out.
 */
function judgeParts(parts: Array<{ text: string; op: string }>, ctx: CommandContext): { ok: true; parts: CommandPart[] } | { ok: false; cls: CommandClass } {
  const out: CommandPart[] = [];
  let prevOp = "";
  for (const p of parts) {
    const pipedInto = prevOp === "|";
    prevOp = p.op;
    const r = redirections(p.text);
    if (!r) return { ok: false, cls: ask("syntax", "has a redirection that can't be checked") };
    // `. ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm test` is judged as `npm test`.
    if (!r.targets.length && !r.inputs.length && p.op === "&&") {
      try {
        if (isNodeVersionSetup(parseArgv(r.rest), ctx.root)) continue;
      } catch {
        // judged below
      }
    }
    let worst: CommandClass | null = null;
    const take = (k: CommandClass) => {
      if (!worst || RANK[k.action] > RANK[worst.action] || (RANK[k.action] === RANK[worst.action] && ((worst.category === "read" && k.category !== "read") || (REMEMBERABLE.has(worst.category) && !REMEMBERABLE.has(k.category))))) worst = k;
    };
    if (p.op === "&") take(ask("syntax", "runs something in the background"));
    for (const t of r.targets) {
      if (isSecretPath(t)) return { ok: false, cls: refuse("secret", `writes a secrets file (${t})`) };
      if (escapes(t, ctx.root)) take(ask("outside", `writes outside the project (${t})`));
      else if (protectedArg(t, ctx.root)) take(ask("protected", `writes a protected path (${t})`));
      else take(ask("unlisted", `writes ${t} outside the edit tools`));
    }
    for (const t of r.inputs) if (escapes(t, ctx.root)) take(ask("outside", `reads outside the project (${t})`));
    let argv: string[];
    try {
      argv = parseArgv(r.rest);
    } catch {
      return { ok: false, cls: ask("syntax", "has an unterminated quote") };
    }
    if (runsStdin(argv, pipedInto || r.inputs.length > 0)) take(ask("inline", `${argv[0]} runs code from its input`));
    const k = classifySegment(argv, ctx);
    if (k.action === "refuse") return { ok: false, cls: k };
    take(k);
    // Arguments that reach outside the project or into protected paths ask, whatever the program.
    if (k.category !== "outside" && k.category !== "network" && k.category !== "build-clean") {
      for (const a of argv.slice(1)) {
        if (isSecretPath(a) && /^(cp|mv|tee|ln|install|sed|truncate)$/.test(argv[0])) return { ok: false, cls: refuse("secret", `writes a secrets file (${a})`) };
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
    out.push({ text: r.rest, cls: worst ?? k, writes: r.targets });
  }
  return { ok: true, parts: out };
}

/** The parts of a command line, judged one by one; null when it can't be split (substitution, subshells, here-docs) or a part is refused. */
export function commandParts(command: unknown, ctx: CommandContext): CommandPart[] | null {
  if (typeof command !== "string" || !command.trim()) return null;
  const c = command.trim();
  if (classifyCommand(c, ctx).action === "refuse") return null;
  const parts = splitCommand(c);
  if (!parts) return null;
  const judged = judgeParts(parts, ctx);
  return judged.ok ? judged.parts : null;
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
  // `python3 tools/watchlist.py --md` keeps `python3 tools/watchlist.py:*`, not every python3 script.
  else if (INTERPRETERS.test(a) && b && isScriptPath(b)) tokens = [a, b];
  const rule = `${tokens.join(" ")}:*`;
  return parseRule(rule) ? rule : null;
}

/** A script inside the project, as an interpreter's first argument (`tools/watchlist.py`, `./scripts/x.sh`). */
const SCRIPT_PATH = /^(\.\/)?[A-Za-z0-9_][\w.-]*(\/[\w.-]+){0,6}\.(?<ext>[a-z]{1,4})$/;
const SCRIPT_EXTENSIONS = new Set(["py", "js", "mjs", "cjs", "ts", "mts", "rb", "pl", "php", "sh", "bash", "zsh"]);
const isScriptPath = (p: string) => SCRIPT_EXTENSIONS.has(SCRIPT_PATH.exec(p)?.groups?.ext ?? "") && !p.split("/").includes("..");

/**
 * The rules "Always allow" keeps for a command, or null when none may be kept. A plain command gets
 * suggestRule's one rule. A command line (`python3 tools/x.py SPY 2>&1 | head -20; echo "exit=$?"`)
 * gets one plain rule per part that isn't read-only (`python3 tools/x.py:*`); read-only parts (head,
 * tail, echo, grep, wc, sort, cat of project files) need none. None at all when a part can't have
 * one: it writes a file (`>`), pipes into a shell that runs its input, reaches the network or outside the
 * project, or the line uses syntax that can't be checked (`$(...)`, backticks).
 */
export function suggestRules(command: unknown, ctx: CommandContext): string[] | null {
  if (typeof command !== "string" || !command.trim()) return null;
  if (!SHELL_META.test(command.trim())) {
    const one = suggestRule(command, ctx);
    return one ? [one] : null;
  }
  const parts = commandParts(command, ctx);
  if (!parts) return null;
  const rules: string[] = [];
  for (const p of parts) {
    if (p.cls.category === "read" && !p.writes.length) continue;
    if (!rememberable(p.cls) || p.writes.length) return null;
    const rule = suggestRule(p.text, ctx);
    if (!rule) return null;
    if (!rules.includes(rule)) rules.push(rule);
  }
  return rules.length ? rules : null;
}

/**
 * True when every part of a command line runs without asking on its own: it only reads, Auto runs
 * it (Auto mode only), or one of the rules covers it. A part that writes a file through `>`, runs
 * code from its input or can't be read is never covered.
 */
function partsCovered(command: unknown, ctx: CommandContext, rules: readonly string[], auto: boolean): boolean {
  if (typeof command !== "string" || !SHELL_META.test(command.trim()) || !rules.length) return false;
  const parts = commandParts(command, ctx);
  if (!parts?.length) return false;
  return parts.every((p) => {
    if (p.writes.length || !rememberable(p.cls)) return false;
    if (p.cls.category === "read" || (auto && p.cls.action === "run")) return true;
    return rules.some((r) => ruleMatches(r, p.text));
  });
}

/** The command a git tool runs, for matching "always allow" rules (`git pull:*`). */
const GIT_TOOL_COMMAND: Partial<Record<ToolName, string>> = { git_pull: "git pull", git_fetch: "git fetch" };

/**
 * The rules "Always allow" keeps for a tool call (empty when none may be kept): a shell command's
 * suggestRules, or `git pull:*` / `git fetch:*` for the git tools (they take only a configured
 * remote's name and a branch, checked by the executor).
 */
export function suggestToolRules(tool: ToolName, args: Record<string, unknown>, ctx: CommandContext): string[] {
  if (tool === "run_shell") return suggestRules(args.command, ctx) ?? [];
  const cmd = GIT_TOOL_COMMAND[tool];
  return cmd ? [`${cmd}:*`] : [];
}

// ---------------------------------------------------------------------------
// Sandboxed commands (Auto): code Auto can't check runs in the OS sandbox instead of asking
// ---------------------------------------------------------------------------

export const SANDBOX_REASON = "runs in the sandbox: writes only inside the project, no network";
/** Classes Auto asks about only because it can't check the code they run. */
const SANDBOXABLE = new Set<Category>(["inline", "unlisted", "script"]);
/** Programs that act outside the process (other apps, the keychain, a terminal session) or need a person: they keep asking. */
const NOT_SANDBOXED = /^(open|xdg-open|osascript|security|pbcopy|pbpaste|screen|tmux|vi|vim|nvim|nano|emacs|less|more|man|top|htop|watch|ssh-agent|ssh-add|gpg|gpg-agent|at|batch|systemd-run|flatpak|snap|code|cursor|zed|subl|say|caffeinate)$/;

/**
 * True when Auto may run this command in the sandbox instead of asking: every part either runs in
 * Auto anyway or asks only because it runs code Auto can't check (an interpreter given code inline or
 * on stdin, a project script, a program not on Auto's list), and at least one part is such. Never for
 * a part that installs, reaches the network, pushes, deletes, touches a path outside the project or a
 * protected one, runs Docker or git commands that change history, or uses syntax that can't be read
 * (substitution, subshells, background jobs). A here-document is the command's input
 * (stripHeredocs), so `cd src && python3 - <<'EOF' … EOF` is judged as `cd src && python3 -` fed code.
 */
export function sandboxable(command: unknown, ctx: CommandContext): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  let line = command.trim();
  if (classifyCommand(line, ctx).action === "refuse") return false;
  if (!splitCommand(line)) {
    const stripped = stripHeredocs(line);
    if (!stripped) return false;
    line = stripped;
  }
  if (/(^|[\s;&|])(sudo|doas|su|pkexec|runas)(\s|$)/.test(line)) return false;
  if (classifyCommand(line, ctx).action !== "ask") return false;
  const parts = commandParts(line, ctx);
  if (!parts?.length) return false;
  let needs = false;
  for (const p of parts) {
    if (p.cls.action === "run") continue;
    if (p.cls.action !== "ask" || !SANDBOXABLE.has(p.cls.category)) return false;
    let argv: string[];
    try {
      argv = parseArgv(p.text);
    } catch {
      return false;
    }
    while (argv.length && (WRAPPERS.has(argv[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]))) argv.shift();
    if (NOT_SANDBOXED.test((argv[0] ?? "").split("/").pop() ?? "")) return false;
    needs = true;
  }
  return needs;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface Decision {
  action: Action;
  reason: string;
  /** The "Always allow" rule the approval card may offer (asks only); the first of `rules` for a command line. */
  rule?: string;
  /** A command line's rules, one per part that needs one (`python3 tools/x.py:*`), when there are several. */
  rules?: string[];
  /**
   * A run that counts as the user's approval for the executor's own checks (Full access: the user
   * chose to approve everything). The executor still refuses what it always refuses (.git internals).
   */
  approved?: boolean;
  /** Run in the OS sandbox (Auto, sandboxable()): project-only writes, no network. */
  sandbox?: boolean;
  /** An ask "Allow for this session" may answer: what it would cover (session-allowances.ts). */
  session?: string;
  /** A run because the session allowed this kind of call (session-allowances.ts): what was allowed. */
  sessionAllowed?: string;
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
  /** This computer has an OS sandbox and the setting is on (sandbox-settings.ts): Auto runs sandboxable commands in it. */
  sandbox?: boolean;
}

/** Tools that ask in every mode but Full access (they publish or reach other people). */
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
  if (ctx.mode === "full") return decideFull(tool, args, ctx);
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
    // A command line runs when each part only reads, Auto runs it, or a rule covers it.
    if (partsCovered(args.command, { root: ctx.root, branch: ctx.branch?.() ?? null }, ctx.rules ?? [], ctx.mode === "auto")) return { action: "run", reason: "always-allow rules cover every part" };
    const rules = suggestRules(args.command, { root: ctx.root, branch: null });
    const offer = rules ? { rule: rules[0], ...(rules.length > 1 ? { rules } : {}) } : {};
    // The rules stay on a sandboxed run: they are offered if the sandbox blocks it and it asks to re-run outside.
    if (ctx.mode === "auto" && ctx.sandbox === true && sandboxable(args.command, { root: ctx.root, branch: ctx.branch?.() ?? null })) return { action: "run", reason: SANDBOX_REASON, sandbox: true, ...offer };
    return { action: "ask", reason: cls.reason, ...offer };
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
  const gitCmd = GIT_TOOL_COMMAND[tool];
  if (gitCmd) {
    if ((ctx.rules ?? []).some((r) => ruleMatches(r, gitCmd))) return { action: "run", reason: "an always-allow rule for this project" };
    return { action: "ask", reason: `${tool.replace(/_/g, " ")} asks`, rule: `${gitCmd}:*` };
  }
  return { action: "ask", reason: `${tool.replace(/_/g, " ")} asks` };
}

/**
 * Full access: everything runs without asking, as if the user approved it, except the hard
 * refusals (the same ones Auto refuses). Nothing new is refused here.
 */
function decideFull(tool: ToolName, args: Record<string, unknown>, ctx: DecideContext): Decision {
  if (tool === "run_shell") {
    const cls = classifyCommand(args.command, { root: ctx.root, branch: ctx.branch?.() ?? null });
    if (cls.action === "refuse") return { action: "refuse", reason: `Full access still refuses this: ${cls.reason}.` };
    return { action: "run", reason: "Full access", approved: true };
  }
  if (tool === "write_file" || tool === "edit_file") {
    if (isSecretPath(args.path)) return { action: "refuse", reason: `Full access still refuses this: it writes a secrets file (${String(args.path)}).` };
    if (containsSecret(tool === "write_file" ? args.content : args.new_string)) return { action: "refuse", reason: "Full access still refuses this: it writes what looks like an API key or token." };
  }
  return { action: "run", reason: "Full access", approved: true };
}
