// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * ec-fleet approval policy: what the supervising session may approve on a fleet session's behalf.
 *
 * classifyApproval({ tool, args }, ctx) -> { decision, reason }
 *   decision "approve"  read-only commands, the repo's targeted test / lint commands, edits and
 *                       commits inside the worktree, pushing the session's own ec/* branch, a draft PR
 *   decision "refuse"   push to main, a force push to a non-ec/ branch, rm -rf outside the worktree,
 *                       deploy / fly commands, anything that writes a protected path
 *   decision "pending"  everything else: left for a human (or the supervising session) to answer
 *
 * ctx: { worktree: absolute path, branch: "ec/<slug>", currentBranch?: the worktree's HEAD branch }
 *
 * The provider applies its own rules too (src/apps/ide/permissions.ts); this policy only decides
 * what the orchestrator answers, and it is deliberately narrower: unknown means pending.
 */

import { posix, win32 } from "node:path";

/** Path rules follow the worktree's own form (POSIX "/…" or Windows "C:\\…"), not the OS running the policy. */
const flavor = (worktree) => (String(worktree).startsWith("/") ? posix : win32);

export const DEFAULT_BRANCHES = new Set(["main", "master"]);

const READ_TOOLS = new Set(["read_file", "list_directory", "search_files", "search_codebase", "git_status", "git_diff", "git_log", "git_fetch", "github_list_prs", "github_list_issues", "delegate", "await_tentacles", "cancel_tentacle"]);

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "cargo.lock", "gemfile.lock", "poetry.lock", "pipfile.lock", "composer.lock", "go.sum", "uv.lock"]);

/** Why a repo-relative path is protected, or null. */
export function protectedPathReason(rel) {
  if (typeof rel !== "string" || !rel) return null;
  const segs = posix.normalize(rel.replace(/\\/g, "/")).split(/[\\/]+/).filter((s) => s && s !== ".");
  if (!segs.length) return null;
  const lower = segs.map((s) => s.toLowerCase());
  const name = lower[lower.length - 1];
  if (lower.includes(".git")) return "the git directory";
  for (let i = 0; i < lower.length - 1; i++) if (lower[i] === ".github" && lower[i + 1] === "workflows") return "a CI workflow (.github/workflows)";
  if (lower.includes("deploy")) return "deploy configuration (deploy/)";
  if (lower.includes("migrations")) return "a database migration";
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "a Dockerfile";
  if (/^fly.*\.toml$/.test(name)) return "a Fly config (fly*.toml)";
  if (LOCKFILES.has(name)) return "a lockfile";
  if (name.startsWith(".env")) return "an env file (.env*)";
  if (lower[0] === ".claude" && (name === "settings.json" || name === "harness.json" || lower[1] === "hooks")) return "the Claude Code harness (.claude)";
  return null;
}

/** The path relative to the worktree, or null when it is outside it (or can't be read: ~, $VAR). */
export function inWorktree(path, worktree, cwd = worktree) {
  if (typeof path !== "string" || !path) return null;
  if (path.startsWith("~") || path.includes("$")) return null;
  const P = flavor(worktree);
  const abs = P.isAbsolute(path) ? P.normalize(path) : P.resolve(cwd, path);
  const root = P.normalize(worktree).replace(/[\\/]+$/, "");
  if (abs === root) return ".";
  if (!abs.startsWith(root + P.sep)) return null;
  // Repo-relative paths always use "/".
  return abs.slice(root.length + 1).split(P.sep).join("/");
}

const approve = (reason) => ({ decision: "approve", reason });
const refuse = (reason) => ({ decision: "refuse", reason });
const pending = (reason) => ({ decision: "pending", reason });

/** Most restrictive of several verdicts: refuse > pending > approve. */
export function combine(verdicts) {
  return verdicts.find((v) => v.decision === "refuse") ?? verdicts.find((v) => v.decision === "pending") ?? verdicts[0] ?? pending("nothing to check");
}

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

/** Split at |, ||, &&, ; and & outside quotes; null for syntax we don't read (substitution, subshells, here-docs, newlines). */
export function splitShell(command) {
  if (/[`\n\r]|\$\(|<\(|>\(|<</.test(command)) return null;
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        cur += ch + command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += ch + command[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    // 2>&1 / >&2 are redirections, not a background &.
    if (ch === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
      cur += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") return null;
    cur += ch;
  }
  if (quote) return null;
  out.push(cur.trim());
  return out.every(Boolean) ? out : null;
}

/** Shell words of one segment (quotes removed); redirections split out. null when unreadable. */
export function words(segment) {
  const argv = [];
  const redirects = [];
  let cur = "";
  let has = false;
  let quote = null;
  const push = () => {
    if (has) argv.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === ">" || ch === "<") {
      // An fd number right before the operator (2>) belongs to it.
      if (has && /^\d$/.test(cur)) {
        cur = "";
        has = false;
      }
      push();
      let j = i + 1;
      if (segment[j] === ">") j++;
      let dup = false;
      if (segment[j] === "&") {
        dup = true;
        j++;
      }
      while (segment[j] === " ") j++;
      let target = "";
      while (j < segment.length && !/\s/.test(segment[j])) target += segment[j++];
      if (!target) return null;
      if (!dup) redirects.push({ op: ch, target: target.replace(/^['"]|['"]$/g, "") });
      i = j - 1;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) return null;
  push();
  return { argv, redirects };
}

/** Strip wrappers that don't change what runs: VAR=x, nice [-n N], time, env, command. */
export function unwrap(argv) {
  let a = [...argv];
  for (;;) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift();
    if (a[0] === "nice") {
      a.shift();
      if (a[0] === "-n") a.splice(0, 2);
      else if (/^-n?-?\d+$/.test(a[0] ?? "") || /^--adjustment=/.test(a[0] ?? "")) a.shift();
      continue;
    }
    if (a[0] === "time" || a[0] === "command") {
      a.shift();
      continue;
    }
    if (a[0] === "env") {
      a.shift();
      while (a.length && (a[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]))) a.shift();
      continue;
    }
    return a;
  }
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

const READ_BINS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "pwd", "echo", "printf", "tree", "stat", "file", "du", "df", "which", "whoami", "date", "uname", "basename", "dirname", "realpath", "sort", "uniq", "cut", "tr", "nl", "diff", "cmp", "true", "false", "jq", "less", "column", "test", "["]);
const DEPLOY_BINS = new Set(["fly", "flyctl", "wrangler", "kubectl", "helm", "terraform", "tofu", "pulumi", "vercel", "netlify", "heroku", "railway", "eb", "gcloud", "aws", "az", "doctl", "ansible-playbook"]);
const NEVER_BINS = new Set(["sudo", "su", "doas", "shutdown", "reboot", "launchctl", "systemctl", "crontab", "diskutil", "mkfs", "dd", "shred"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep", "rev-list", "merge-base", "cat-file", "ls-tree", "fetch"]);
const DEPLOY_WORDS = /(^|[/:._-])(deploy|fly)([/:._-]|$)|fly-bootstrap|fly-post-deploy|fly-teardown|infra-bootstrap|cloudflare-bootstrap/i;

/** Verdict for paths a command writes (or deletes): inside the worktree and not protected. */
function writesOk(paths, ctx, cwd, what) {
  const vs = [];
  for (const p of paths) {
    const rel = inWorktree(p, ctx.worktree, cwd);
    if (rel === null) vs.push(refuse(`${what} outside the worktree (${p})`));
    else {
      const why = protectedPathReason(rel);
      if (why) vs.push(refuse(`${what} ${why} (${rel})`));
      else vs.push(approve(`${what} inside the worktree`));
    }
  }
  return vs.length ? combine(vs) : approve(`${what} (no paths)`);
}

/** Verdict for paths a command only reads: outside or protected means a human looks. */
function readsOk(paths, ctx, cwd) {
  for (const p of paths) {
    if (/^-/.test(p)) continue;
    const rel = inWorktree(p, ctx.worktree, cwd);
    if (rel === null) {
      if (p === "/dev/null") continue;
      return pending(`reads outside the worktree (${p})`);
    }
    const why = protectedPathReason(rel);
    if (why) return why.startsWith("an env file") ? refuse(`reads ${why} (${rel})`) : pending(`reads ${why} (${rel})`);
  }
  return approve("read-only command");
}

/** A test file or directory argument (targeted tests). */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/;

function vitestVerdict(args, ctx, cwd) {
  const rest = args.filter((a) => a !== "run" && a !== "--run");
  if (args.some((a) => a === "--watch" || a === "-w" || a === "watch" || a === "dev" || a === "--ui" || a === "-u" || a === "--update")) return pending("vitest in watch / update mode");
  const paths = rest.filter((a) => !a.startsWith("-"));
  // Flag values like `--maxWorkers 2` show up as bare words; only paths count as targets.
  const targets = paths.filter((p) => TEST_PATH.test(p) || /[/.]/.test(p));
  if (!targets.length) return pending("runs the whole test suite (only targeted tests are auto-approved)");
  const r = readsOk(targets, ctx, cwd);
  return r.decision === "approve" ? approve(`targeted tests (${targets.join(" ")})`) : r;
}

function tscVerdict(args) {
  if (!args.includes("--noEmit")) return pending("tsc that emits files");
  return approve("type check (tsc --noEmit)");
}

/** git push: only the session's own ec/* branch on origin. */
export function gitPushVerdict(args, ctx) {
  const flags = args.filter((a) => a.startsWith("-"));
  const pos = args.filter((a) => !a.startsWith("-"));
  if (flags.some((f) => f === "--all" || f === "--mirror" || f === "--tags" || f === "--prune")) return refuse(`git push ${flags.join(" ")} can push the default branch`);
  if (flags.some((f) => f === "--delete" || f === "-d")) return pending("git push --delete");
  let force = flags.some((f) => f === "-f" || f === "--force" || f.startsWith("--force-with-lease") || f === "--force-if-includes" || (/^-[a-z]+$/.test(f) && f.includes("f")));
  const remote = pos[0] ?? "origin";
  const refspecs = pos.slice(1);
  const current = ctx.currentBranch ?? ctx.branch;
  const dsts = refspecs.length ? refspecs : [current];
  const vs = [];
  for (let spec of dsts) {
    if (spec.startsWith("+")) {
      force = true;
      spec = spec.slice(1);
    }
    let dst = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
    if (spec.startsWith(":")) {
      vs.push(DEFAULT_BRANCHES.has(dst.replace(/^refs\/heads\//, "")) ? refuse("deletes the default branch") : pending(`deletes remote branch ${dst}`));
      continue;
    }
    dst = dst.replace(/^refs\/heads\//, "");
    if (dst === "HEAD" || dst === "@") dst = current;
    if (!dst || DEFAULT_BRANCHES.has(dst)) {
      vs.push(refuse(`pushes to ${dst || "an unknown branch"} (never the default branch)`));
      continue;
    }
    if (force && !dst.startsWith("ec/")) {
      vs.push(refuse(`force push to ${dst} (only ec/* branches)`));
      continue;
    }
    if (remote !== "origin") {
      vs.push(pending(`push to remote ${remote}`));
      continue;
    }
    if (dst === ctx.branch && (current === ctx.branch || refspecs.length)) vs.push(approve(`pushes the session's branch ${dst}${force ? " (force, ec/* only)" : ""}`));
    else vs.push(pending(`pushes ${dst}, not the session's branch ${ctx.branch}`));
  }
  return combine(vs);
}

function gitVerdict(args, ctx, cwd) {
  // git -C <dir> ...: the dir must be the worktree.
  const a = [...args];
  while (a[0] && a[0].startsWith("-")) {
    if (a[0] === "-C") {
      if (inWorktree(a[1], ctx.worktree, cwd) === null) return pending(`git -C outside the worktree (${a[1]})`);
      a.splice(0, 2);
      continue;
    }
    if (a[0] === "-c" || a[0].startsWith("--exec-path") || a[0].startsWith("--git-dir") || a[0].startsWith("--work-tree")) return pending(`git ${a[0]} changes how git runs`);
    a.shift();
  }
  const [sub, ...rest] = a;
  if (!sub) return approve("git");
  if (GIT_READ.has(sub)) {
    if (rest.some((x) => x === "--output" || x.startsWith("--output=") || x === "--ext-diff" || x.startsWith("--exec"))) return pending(`git ${sub} with an option that writes or runs`);
    return approve(`read-only git ${sub}`);
  }
  if (sub === "branch") {
    if (rest.some((x) => x === "-D" || x === "-d" || x === "--delete" || x === "-m" || x === "-M" || x === "-f")) return pending(`git branch ${rest.join(" ")}`);
    const names = rest.filter((x) => !x.startsWith("-"));
    if (!names.length || rest.some((x) => ["--list", "-a", "-r", "-v", "-vv", "--show-current", "--all"].includes(x))) return approve("lists branches");
    return names.every((n) => n.startsWith("ec/")) ? approve("creates an ec/* branch") : pending(`creates branch ${names.join(" ")}`);
  }
  if (sub === "remote") return rest.length === 0 || (rest.length === 1 && ["-v", "--verbose"].includes(rest[0])) ? approve("lists remotes") : pending(`git remote ${rest.join(" ")}`);
  if (sub === "add") {
    if (rest.includes("-f") || rest.includes("--force")) return pending("git add --force (may add ignored files such as node_modules)");
    const paths = rest.filter((x) => !x.startsWith("-") && x !== "--");
    return writesOk(paths, ctx, cwd, "stages");
  }
  if (sub === "commit") {
    if (rest.includes("--no-verify") || rest.includes("-n")) return pending("git commit --no-verify skips hooks");
    const paths = rest.filter((x, i) => !x.startsWith("-") && !["-m", "--message", "-F", "--file", "--author", "--date", "-C", "-c", "--trailer"].includes(rest[i - 1]) && x !== "--");
    if (ctx.currentBranch && DEFAULT_BRANCHES.has(ctx.currentBranch)) return refuse("commits on the default branch");
    return paths.length ? writesOk(paths, ctx, cwd, "commits") : approve("commits on the session's branch");
  }
  if (sub === "switch" || sub === "checkout") {
    if (rest.includes("--") || rest.includes(".") || rest.includes("-f") || rest.includes("--force")) return pending(`git ${sub} that discards changes`);
    const names = rest.filter((x) => !x.startsWith("-"));
    const target = names[0];
    if (target === ctx.branch || (target?.startsWith("ec/") && rest.some((x) => x === "-b" || x === "-c" || x === "-B" || x === "-C"))) return approve(`switches to ${target}`);
    return pending(`git ${sub} ${rest.join(" ")}`);
  }
  if (sub === "push") return gitPushVerdict(rest, ctx);
  if (sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree")) return approve("unstages files");
  if (sub === "stash" && (rest.length === 0 || ["list", "show"].includes(rest[0]))) return approve(`git stash ${rest[0] ?? ""}`.trim());
  return pending(`git ${sub} isn't auto-approved`);
}

function ghVerdict(args, ctx) {
  const [group, sub, ...rest] = args;
  if (group === "auth") return pending("gh auth");
  if (group === "pr") {
    if (["view", "list", "status", "diff", "checks"].includes(sub)) return approve(`read-only gh pr ${sub}`);
    if (sub === "merge" || sub === "close") return refuse(`gh pr ${sub} (the supervisor merges)`);
    if (sub === "create") {
      const opt = (name, short) => {
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === name || (short && rest[i] === short)) return rest[i + 1];
          if (rest[i].startsWith(`${name}=`)) return rest[i].slice(name.length + 1);
        }
        return undefined;
      };
      if (!rest.some((x) => x === "--draft" || x === "-d")) return pending("gh pr create without --draft (fleet PRs are drafts)");
      const base = opt("--base", "-B");
      const head = opt("--head", "-H");
      if (base && !DEFAULT_BRANCHES.has(base)) return pending(`draft PR into ${base}`);
      if (head && head !== ctx.branch) return pending(`draft PR from ${head}, not ${ctx.branch}`);
      if (!head && ctx.currentBranch && ctx.currentBranch !== ctx.branch) return pending(`the worktree is on ${ctx.currentBranch}, not ${ctx.branch}`);
      return approve(`opens a draft PR from ${ctx.branch}`);
    }
    if (sub === "edit" || sub === "comment") return pending(`gh pr ${sub}`);
    return pending(`gh pr ${sub ?? ""}`.trim());
  }
  if (group === "repo" && sub === "view") return approve("read-only gh repo view");
  if (group === "issue" && ["view", "list"].includes(sub)) return approve(`read-only gh issue ${sub}`);
  if (group === "workflow" || group === "run" || group === "release" || group === "secret" || group === "variable") return refuse(`gh ${group} ${sub ?? ""} (CI, releases and secrets are off limits)`.trim());
  return pending(`gh ${group ?? ""} ${sub ?? ""}`.trim());
}

function npmVerdict(bin, args, ctx, cwd) {
  const a = args.filter((x) => x !== "--silent" && x !== "-s" && x !== "--no-install" && x !== "--yes" && x !== "-y" && x !== "--offline");
  if (bin === "npx") {
    const [tool, ...rest] = a;
    if (tool === "vitest") return vitestVerdict(rest, ctx, cwd);
    if (tool === "tsc") return tscVerdict(rest);
    if (tool === "eslint" || tool === "prettier") return rest.some((x) => x === "--fix" || x === "--write" || x === "-w") ? pending(`${tool} that rewrites files`) : approve(`lint (${tool})`);
    return pending(`npx ${tool ?? ""} (downloads and runs a package)`.trim());
  }
  const [cmd, ...rest] = a;
  if (cmd === "test" || cmd === "t" || (cmd === "run" && (rest[0] === "test" || rest[0] === "test:unit"))) {
    const after = cmd === "run" ? rest.slice(1) : rest;
    const dd = after.indexOf("--");
    return vitestVerdict(dd >= 0 ? after.slice(dd + 1) : after, ctx, cwd);
  }
  if (cmd === "run") {
    const script = rest[0] ?? "";
    if (DEPLOY_WORDS.test(script)) return refuse(`npm run ${script} (deploy)`);
    if (["check:scripts", "check:fly-configs", "lint", "typecheck", "check"].includes(script)) return approve(`npm run ${script}`);
    return pending(`npm run ${script}`);
  }
  return pending(`${bin} ${cmd ?? ""} isn't auto-approved (installs, publishes and the rest ask)`.trim());
}

/** One simple command (after splitting). `state.cwd` follows approved `cd`s. */
function segmentVerdict(segment, ctx, state) {
  const w = words(segment);
  if (!w) return pending(`can't read: ${segment}`);
  const argv = unwrap(w.argv);
  const redirectVerdicts = [];
  for (const r of w.redirects) {
    if (r.op === ">") {
      if (r.target === "/dev/null" || r.target === "/dev/stderr" || r.target === "/dev/stdout") continue;
      redirectVerdicts.push(writesOk([r.target], ctx, state.cwd, "writes"));
    } else redirectVerdicts.push(readsOk([r.target], ctx, state.cwd));
  }
  if (!argv.length) return redirectVerdicts.length ? combine(redirectVerdicts) : approve("assignment");
  const [bin0, ...args] = argv;
  const bin = bin0.split("/").pop();
  // Hard refusals first, wherever they hide.
  if (DEPLOY_BINS.has(bin)) return refuse(`${bin} (deploy / infrastructure commands are never auto-approved)`);
  if (NEVER_BINS.has(bin)) return refuse(`${bin} (system-level)`);
  if (bin === "docker" && ["push", "login", "buildx", "compose"].includes(args[0])) return refuse(`docker ${args[0]}`);
  if ((bin === "bash" || bin === "sh" || bin === "zsh" || bin === "node" || bin === "tsx") && args.some((a) => DEPLOY_WORDS.test(a) && /\.(sh|mjs|js|ts)$/.test(a))) return refuse(`runs a deploy script (${args.find((a) => DEPLOY_WORDS.test(a))})`);
  if (bin0.includes("/") && DEPLOY_WORDS.test(bin0)) return refuse(`runs a deploy script (${bin0})`);
  for (const a of args) {
    if (a.startsWith("-")) continue;
    const rel = inWorktree(a, ctx.worktree, state.cwd);
    const why = rel !== null && rel !== "." ? protectedPathReason(rel) : null;
    if (why && !READ_BINS.has(bin) && !(bin === "git" && GIT_READ.has(args[0]))) return refuse(`touches ${why} (${rel})`);
  }
  let v;
  if (bin === "cd") {
    const target = args[0] ?? "~";
    const rel = inWorktree(target, ctx.worktree, state.cwd);
    if (rel === null) v = pending(`cd outside the worktree (${target})`);
    else {
      state.cwd = flavor(ctx.worktree).resolve(state.cwd, target);
      v = approve("cd inside the worktree");
    }
  } else if (READ_BINS.has(bin)) {
    if (bin === "find" && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) v = pending("find that runs or deletes");
    else if (bin === "sort" && args.some((a) => a.startsWith("-o") || a.startsWith("--output"))) v = pending("sort -o writes a file");
    else if (bin === "rg" && args.some((a) => a.startsWith("--pre"))) v = pending("rg --pre runs a program");
    else v = readsOk(args, ctx, state.cwd);
  } else if (bin === "sed" || bin === "awk" || bin === "perl") {
    const inPlace = args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place="));
    if (bin === "awk" && /system\s*\(|\|\s*getline|print\s*>/.test(args.join(" "))) v = pending("awk that runs commands or writes files");
    else if (bin === "perl" && !inPlace) v = pending("perl");
    else if (inPlace) {
      const files = args.filter((a) => !a.startsWith("-")).slice(1);
      v = writesOk(files, ctx, state.cwd, "edits");
    } else v = /\bw\s|\be\b/.test(args.find((a) => !a.startsWith("-")) ?? "") && bin === "sed" ? pending("sed script that writes or runs") : readsOk(args.filter((a) => !a.startsWith("-")).slice(1), ctx, state.cwd);
  } else if (bin === "rm" || bin === "rmdir" || bin === "unlink") {
    const paths = args.filter((a) => !a.startsWith("-"));
    if (!paths.length) v = pending("rm without paths");
    else if (paths.some((p) => inWorktree(p, ctx.worktree, state.cwd) === ".")) v = refuse("deletes the whole worktree");
    else if (paths.some((p) => /^\*+$/.test(p) || p === "/" || p === "..")) v = refuse(`rm ${paths.join(" ")}`);
    else v = writesOk(paths, ctx, state.cwd, "deletes");
  } else if (bin === "mkdir" || bin === "touch" || bin === "cp" || bin === "mv" || bin === "ln") {
    const paths = args.filter((a) => !a.startsWith("-"));
    if (bin === "cp" || bin === "mv" || bin === "ln") {
      const dest = paths[paths.length - 1];
      const srcs = paths.slice(0, -1);
      const r = readsOk(srcs, ctx, state.cwd);
      v = combine([bin === "mv" ? writesOk(srcs, ctx, state.cwd, "moves") : r, writesOk(dest ? [dest] : [], ctx, state.cwd, "writes")]);
    } else v = writesOk(paths, ctx, state.cwd, bin === "mkdir" ? "creates" : "touches");
  } else if (bin === "git") v = gitVerdict(args, ctx, state.cwd);
  else if (bin === "gh") v = ghVerdict(args, ctx);
  else if (bin === "npm" || bin === "npx" || bin === "pnpm" || bin === "yarn") v = npmVerdict(bin === "npx" ? "npx" : "npm", args, ctx, state.cwd);
  else if (bin === "vitest") v = vitestVerdict(args, ctx, state.cwd);
  else if (bin === "tsc") v = tscVerdict(args);
  else if (bin === "node") {
    if (args[0] === "--check" || args[0] === "-c") v = readsOk(args.slice(1), ctx, state.cwd);
    else if (args[0] === "--test") v = vitestVerdict(["run", ...args.slice(1)], ctx, state.cwd);
    else if (args[0] === "scripts/check-scripts.mjs" || args[0] === "scripts/check-fly-configs.mjs") v = approve(`repo check ${args[0]}`);
    else v = pending("node runs a script");
  } else if (["curl", "wget", "ssh", "scp", "rsync", "nc"].includes(bin)) v = pending(`${bin} reaches the network`);
  else if (bin === "kill" || bin === "pkill" || bin === "killall" || bin === "chmod" || bin === "chown") v = pending(`${bin}`);
  else v = pending(`${bin} isn't on the auto-approve list`);
  return combine([v, ...redirectVerdicts]);
}

/** Verdict for a shell command line. */
export function shellVerdict(command, ctx) {
  if (typeof command !== "string" || !command.trim()) return pending("empty command");
  const c = command.trim();
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(c)) return refuse("downloads and runs a script");
  const parts = splitShell(c);
  if (!parts) {
    // Unreadable syntax: still refuse what we can see, otherwise a human answers.
    const flat = c.replace(/[`$()<>{}]/g, " ");
    const sub = splitShell(flat.replace(/\n/g, ";"));
    if (sub) {
      const r = sub.map((s) => segmentVerdict(s, ctx, { cwd: ctx.worktree })).find((v) => v.decision === "refuse");
      if (r) return r;
    }
    return pending("uses shell syntax the policy doesn't read (substitution, subshell, here-doc or a newline)");
  }
  const state = { cwd: ctx.worktree };
  return combine(parts.map((p) => segmentVerdict(p, ctx, state)));
}

/** The verdict for one pending approval ({ tool, args }). */
export function classifyApproval(call, ctx) {
  const tool = call?.tool;
  const args = call?.args ?? {};
  if (!ctx?.worktree || !ctx?.branch) return pending("no session context");
  if (READ_TOOLS.has(tool)) return approve(`read-only tool ${tool}`);
  if (tool === "write_file" || tool === "edit_file") {
    const rel = inWorktree(String(args.path ?? ""), ctx.worktree);
    if (rel === null || rel === ".") return refuse(`${tool} outside the worktree (${args.path})`);
    const why = protectedPathReason(rel);
    if (why) return refuse(`${tool} on ${why} (${rel})`);
    if (rel === "node_modules" || rel.startsWith("node_modules/")) return refuse(`${tool} inside node_modules (shared install)`);
    return approve(`${tool} ${rel}`);
  }
  if (tool === "run_shell") return shellVerdict(args.command, ctx);
  if (tool === "git_commit") {
    if (ctx.currentBranch && ctx.currentBranch !== ctx.branch) return DEFAULT_BRANCHES.has(ctx.currentBranch) ? refuse("commits on the default branch") : pending(`commits on ${ctx.currentBranch}, not ${ctx.branch}`);
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    return files.length ? writesOk(files, ctx, ctx.worktree, "commits") : approve("commits on the session's branch");
  }
  if (tool === "git_branch") {
    const name = String(args.name ?? "");
    if (!name) return approve("lists branches");
    return name === ctx.branch || name.startsWith("ec/") ? approve(`git_branch ${name}`) : pending(`git_branch ${name}`);
  }
  if (tool === "git_push") {
    const argv = [];
    if (args.setUpstream === true) argv.push("--set-upstream");
    argv.push(typeof args.remote === "string" && args.remote ? args.remote : "origin");
    if (typeof args.branch === "string" && args.branch) argv.push(args.branch);
    return gitPushVerdict(argv, ctx);
  }
  if (tool === "git_pull") return pending("git_pull");
  if (tool === "open_pull_request" || tool === "github_create_pr") {
    const branch = String((tool === "open_pull_request" ? args.branch : args.head) ?? ctx.currentBranch ?? "");
    const base = String(args.base ?? "main");
    if (!branch || DEFAULT_BRANCHES.has(branch)) return refuse(`${tool} would push ${branch || "the current branch"}`);
    if (branch !== ctx.branch) return pending(`${tool} from ${branch}, not ${ctx.branch}`);
    if (!DEFAULT_BRANCHES.has(base)) return pending(`${tool} into ${base}`);
    return approve(`${tool} from ${branch} (ec-fleet marks it a draft)`);
  }
  return pending(`${tool ?? "unknown tool"} isn't auto-approved`);
}

/** Short one-line description of a pending call, for reports. */
export function describeCall(call) {
  const a = call?.args ?? {};
  if (call?.tool === "run_shell") return `$ ${String(a.command ?? "").slice(0, 200)}`;
  if (call?.tool === "write_file" || call?.tool === "edit_file") return `${call.tool} ${a.path}`;
  if (call?.tool === "git_commit") return `git_commit "${String(a.message ?? "").split("\n")[0].slice(0, 100)}"`;
  if (call?.tool === "git_push") return `git_push ${a.remote ?? "origin"} ${a.branch ?? "(current)"}`;
  if (call?.tool === "open_pull_request" || call?.tool === "github_create_pr") return `${call.tool} "${a.title ?? ""}" ${a.branch ?? a.head ?? ""} -> ${a.base ?? "main"}`;
  return `${call?.tool} ${JSON.stringify(a).slice(0, 160)}`;
}

