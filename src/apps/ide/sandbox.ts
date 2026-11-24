// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The OS sandbox Auto mode runs unverified commands in (docs/permission-modes.md, "Sandboxed
 * commands"): an inline script (`python3 - <<'EOF'`, `node -e`), a project script (`python3
 * tools/x.py`, `./scripts/x.sh`) or another command Auto can't check statically runs without asking,
 * but inside a sandbox that
 *
 *   - writes only inside the project folder (never its .git directory or the files tooling runs:
 *     hooks, .husky/, .vscode/, node_modules/ other than its caches) and a private temp folder;
 *   - has no network (no TCP/UDP, no DNS, no Unix sockets such as an ssh agent or Docker);
 *   - reads everything else except credentials: ~/.ssh, ~/.aws, ~/.config/gh, keychains,
 *     ~/.edgecoder (the IDE token), browser profiles, wallets, and .env files outside the project.
 *
 * macOS: sandbox-exec with the SBPL profile from macProfile() (deny by default; only the mach
 * services a command-line program needs, so it can't reach other apps through Apple Events or
 * LaunchServices). Linux: bubblewrap (bwrapArgs()): / read-only, the project and temp folder
 * writable, no network namespace, secret folders hidden. Windows, or Linux without a working
 * bwrap: no sandbox, so those commands ask as before.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
// POSIX paths: the sandbox exists only on macOS and Linux (and tests build profiles on any OS).
import { posix } from "node:path";

const { join, resolve, sep } = posix;

export type SandboxKind = "sandbox-exec" | "bwrap";

export interface SandboxSupport {
  kind: SandboxKind | null;
  /** Why there is none (shown in Settings), or what is used. */
  why: string;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** bwrap only from system folders: a PATH lookup could find one a project put on PATH. */
const BWRAP_PATHS = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];

let cached: SandboxSupport | null = null;

/** What sandbox this computer has (probed once). */
export function sandboxSupport(platform: NodeJS.Platform = process.platform): SandboxSupport {
  if (cached && platform === process.platform) return cached;
  const found = probe(platform);
  if (platform === process.platform) cached = found;
  return found;
}

function probe(platform: NodeJS.Platform): SandboxSupport {
  if (platform === "darwin") return existsSync(SANDBOX_EXEC) ? { kind: "sandbox-exec", why: "macOS sandbox (sandbox-exec)" } : { kind: null, why: "sandbox-exec isn't on this Mac" };
  if (platform === "linux") {
    const bwrap = BWRAP_PATHS.find((p) => existsSync(p));
    if (!bwrap) return { kind: null, why: "bubblewrap (bwrap) isn't installed" };
    // Some systems forbid the user namespaces bwrap needs (AppArmor, containers): try it once.
    const r = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "--die-with-parent", "/bin/true"], { timeout: 5_000, stdio: "ignore" });
    return r.status === 0 ? { kind: "bwrap", why: "bubblewrap (bwrap)" } : { kind: null, why: "bubblewrap can't create a sandbox here (user namespaces are off)" };
  }
  return { kind: null, why: "no sandbox on this system" };
}

/** For tests: forget the probe. */
export function resetSandboxProbe(): void {
  cached = null;
}

function real(p: string): string {
  // Windows has no sandbox; its realpath would turn POSIX paths into drive paths.
  if (process.platform === "win32") return resolve(p);
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Why this project folder can't be sandboxed, or null. The sandbox lets a command write the whole
 * project, so the project can't be the home folder, a folder above it, or the filesystem root.
 */
export function unsafeSandboxRoot(root: string, home: string = homedir()): string | null {
  const r = real(root);
  const h = real(home);
  if (r === sep || r === "/" || /^[A-Za-z]:\\?$/.test(r)) return "the project is the filesystem root";
  if (r === h || h.startsWith(r.endsWith(sep) ? r : r + sep)) return "the project is the home folder or contains it";
  const hidden = secretPaths(h).find((s) => r === s || r.startsWith(s + sep));
  if (hidden) return "the project is inside a folder the sandbox hides";
  return null;
}

/** Folders and files under the home folder that hold credentials: never readable in the sandbox. */
export function secretPaths(home: string): string[] {
  const lib = (p: string) => join(home, "Library", p);
  const sup = (p: string) => lib(join("Application Support", p));
  return [
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config/gh", ".config/gcloud", ".config/op", ".config/hub", ".password-store",
    ".edgecoder", ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".gem/credentials", ".cargo/credentials", ".cargo/credentials.toml",
    ".config/solana", ".bitcoin", ".lnd", ".electrum", ".ethereum", ".local/share/keyrings",
    ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge",
  ]
    .map((p) => join(home, p))
    .concat([
      lib("Keychains"), lib("Cookies"), lib("Safari"), lib("Ethereum"),
      sup("Google/Chrome"), sup("Chromium"), sup("Firefox"), sup("BraveSoftware"), sup("Microsoft Edge"), sup("Arc"), sup("Vivaldi"),
      sup("Bitcoin"), sup("Lnd"), sup("Electrum"), sup("Exodus"), sup("io.edgecoder.desktop"),
    ]);
}

/** Paths a command in the sandbox may never write, relative to the project (the files tooling runs). */
const PROTECTED_DIRS = [".git", ".husky", ".githooks", ".vscode", ".cargo", "node_modules"];
const PROTECTED_FILES = [".gitmodules", ".gitattributes", ".envrc", ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml", ".lefthookrc", ".npmrc", ".yarnrc", ".yarnrc.yml"];
/** Caches inside node_modules that test and build tools write. */
const NODE_MODULES_CACHES = [".cache", ".vite", ".vitest", ".vite-temp"];

/** A string literal for an SBPL profile. */
function sbStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
/** A path as a literal part of an SBPL regex. */
function sbRe(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/"]/g, (c) => (c === '"' ? '\\"' : c === "/" ? "/" : `\\${c}`));
}

export interface SandboxPaths {
  /** The project folder (writable). */
  root: string;
  /** The private temp folder (writable; TMPDIR). */
  tmp: string;
  home?: string;
  /** macOS: the per-user temp folder (getconf DARWIN_USER_TEMP_DIR), where xcrun keeps its cache. */
  userTemp?: string | null;
}

/** Mach services a command-line program needs; everything else (Apple Events, LaunchServices, the pasteboard, keychains) is out of reach. */
const MACH_SERVICES = [
  "com.apple.system.opendirectoryd.libinfo", "com.apple.system.opendirectoryd.membership", "com.apple.system.logger",
  "com.apple.system.notification_center", "com.apple.bsd.dirhelper", "com.apple.logd", "com.apple.diagnosticd",
];

/** The SBPL profile for sandbox-exec (macOS). Later rules win over earlier ones. */
export function macProfile(p: SandboxPaths): string {
  const home = real(p.home ?? homedir());
  const root = real(p.root);
  const tmp = real(p.tmp);
  const secrets = secretPaths(home);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    // Programs that act as another user or outside the sandbox.
    `(deny process-exec ${["/usr/bin/sudo", "/usr/bin/su", "/usr/bin/login", "/usr/bin/security", "/usr/bin/osascript", "/usr/bin/open"].map((x) => `(literal ${sbStr(x)})`).join(" ")})`,
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-shm ipc-posix-sem)",
    `(allow mach-lookup ${MACH_SERVICES.map((m) => `(global-name ${sbStr(m)})`).join(" ")})`,
    // Reads: everything, then not .env files (except the project's), then never credentials.
    "(allow file-read*)",
    '(deny file-read* (regex #"/\\.env(\\.[^/]*)?$"))',
    `(allow file-read* (subpath ${sbStr(root)}))`,
    `(deny file-read* ${secrets.map((s) => `(subpath ${sbStr(s)})`).join(" ")})`,
    // Writes: the project, the temp folder and the terminal devices only.
    `(allow file-write* (subpath ${sbStr(root)}) (subpath ${sbStr(tmp)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))`,
    `(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/[0-9]+$"))`,
    // Never the git directory or files tooling runs (a hook written here would run outside the sandbox).
    `(deny file-write* ${PROTECTED_DIRS.map((d) => `(subpath ${sbStr(join(root, d))})`).join(" ")} (regex #"^${sbRe(root)}/(.*/)?(${PROTECTED_FILES.map(sbRe).join("|")})$"))`,
    `(allow file-write* ${NODE_MODULES_CACHES.map((c) => `(subpath ${sbStr(join(root, "node_modules", c))})`).join(" ")})`,
  ];
  // xcrun (behind /usr/bin/python3, git, make, clang) keeps one cache file in the user temp folder.
  if (p.userTemp) lines.push(`(allow file-write* (regex #"^${sbRe(real(p.userTemp).replace(/\/$/, ""))}/xcrun_db"))`);
  return lines.join("\n") + "\n";
}

/** macOS: the per-user temp folder (for xcrun's cache), or null. */
export function darwinUserTemp(): string | null {
  const r = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 2_000 });
  const out = r.status === 0 ? String(r.stdout).trim() : "";
  return out.startsWith("/") ? out : null;
}

/** bubblewrap's arguments (Linux), up to and including `--`. Paths that don't exist are skipped. */
export function bwrapArgs(p: SandboxPaths, exists: (path: string) => boolean = existsSync): string[] {
  const home = p.home ?? homedir();
  const root = real(p.root);
  const tmp = real(p.tmp);
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  // /run holds the Docker and D-Bus sockets (a way out of the sandbox).
  if (exists("/run")) args.push("--tmpfs", "/run");
  if (exists("/var/run") && real("/var/run") === "/var/run") args.push("--tmpfs", "/var/run");
  args.push("--bind", root, root, "--bind", tmp, tmp);
  for (const d of PROTECTED_DIRS) {
    const abs = join(root, d);
    if (!exists(abs)) continue;
    args.push("--ro-bind", abs, abs);
    if (d === "node_modules") for (const c of NODE_MODULES_CACHES) if (exists(join(abs, c))) args.push("--bind", join(abs, c), join(abs, c));
  }
  for (const f of PROTECTED_FILES) if (exists(join(root, f))) args.push("--ro-bind", join(root, f), join(root, f));
  for (const s of secretPaths(home)) {
    if (!exists(s) || s === root || root.startsWith(s + "/")) continue;
    // A folder becomes an empty one; a file reads as empty.
    args.push(...(isFile(s) ? ["--ro-bind", "/dev/null", s] : ["--tmpfs", s]));
  }
  args.push("--unshare-net", "--unshare-ipc", "--unshare-pid", "--die-with-parent", "--new-session", "--setenv", "TMPDIR", tmp, "--chdir", root, "--");
  return args;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The program and arguments that run `command` with /bin/sh inside the sandbox. */
export function sandboxedSpawn(kind: SandboxKind, command: string, p: SandboxPaths): { file: string; args: string[] } {
  if (kind === "sandbox-exec") return { file: SANDBOX_EXEC, args: ["-p", macProfile(p), "/bin/sh", "-c", command] };
  const bwrap = BWRAP_PATHS.find((x) => existsSync(x)) ?? "bwrap";
  return { file: bwrap, args: [...bwrapArgs(p), "/bin/sh", "-c", command] };
}

const temps = new Map<string, string>();
let userTemp: string | null | undefined;

/** A project's private temp folder for sandboxed commands (one per project, per process), removed when the process exits. */
export function sandboxTempFor(root: string): string {
  const key = real(root);
  const have = temps.get(key);
  if (have && existsSync(have)) return have;
  const dir = real(mkdtempSync(join(tmpdir(), "edgecoder-sbx-")));
  temps.set(key, dir);
  if (temps.size === 1) process.once("exit", () => {
    for (const d of temps.values()) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
  return dir;
}

/** Prefix of the executor's error when a sandboxed run can't start (the agent loop then asks to run it outside). */
export const SANDBOX_UNAVAILABLE = "run_shell couldn't start the sandbox: ";

/** True when Auto may use the sandbox for this project: this computer has one and the project isn't the home folder. */
export function sandboxReady(root: string): boolean {
  return sandboxSupport().kind !== null && unsafeSandboxRoot(root) === null;
}

/** How the executor runs `command` sandboxed in `root`, or why it can't. */
export function sandboxInvocation(command: string, root: string): { file: string; args: string[]; tmp: string } | { error: string } {
  const sup = sandboxSupport();
  if (!sup.kind) return { error: sup.why };
  const unsafe = unsafeSandboxRoot(root);
  if (unsafe) return { error: unsafe };
  try {
    const tmp = sandboxTempFor(root);
    if (sup.kind === "sandbox-exec" && userTemp === undefined) userTemp = darwinUserTemp();
    return { ...sandboxedSpawn(sup.kind, command, { root, tmp, userTemp: userTemp ?? null }), tmp };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const DENIAL_PATTERNS: Array<[RegExp, string]> = [
  [/Operation not permitted|EPERM\b|Read-only file system|EROFS\b|PermissionError|Permission denied/i, "a write or read outside what the sandbox allows (it writes only inside the project and its temp folder)"],
  [/Could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|Temporary failure in name resolution|nodename nor servname|Network is unreachable|ENETUNREACH|Name or service not known|urlopen error|Failed to establish a new connection|fetch failed|ECONNREFUSED/i, "the network (the sandbox has none)"],
];

/** What the sandbox most likely blocked, from a failed command's output; null when nothing points to it. */
export function sandboxDenial(stdout: string, stderr: string, exitCode: number): string | null {
  if (exitCode === 0) return null;
  const text = `${stderr}\n${stdout}`.slice(-20_000);
  for (const [re, what] of DENIAL_PATTERNS) if (re.test(text)) return what;
  return null;
}

/**
 * The command with its here-documents taken out (`python3 - <<'EOF' … EOF` becomes `python3 - <
 * HEREDOC`), so the line can be judged like any other: the body is the command's input. Null when
 * there is none, or when a body could run code of its own (an unquoted delimiter with `$(…)` or
 * backticks in the body) or the line can't be read.
 */
export function stripHeredocs(command: string): string | null {
  const lines = command.split("\n");
  const out: string[] = [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const docs: Array<{ tag: string; quoted: boolean; dash: boolean }> = [];
    const re = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) docs.push({ tag: m[3], quoted: m[2] !== "", dash: m[1] === "-" });
    if (!docs.length) {
      if (line.includes("<<")) return null; // `<<<` here-strings and the like
      out.push(line);
      continue;
    }
    found = true;
    out.push(line.replace(re, "< HEREDOC"));
    for (const d of docs) {
      let closed = false;
      for (i = i + 1; i < lines.length; i++) {
        const body = d.dash ? lines[i].replace(/^\t+/, "") : lines[i];
        if (body === d.tag) {
          closed = true;
          break;
        }
        if (!d.quoted && /\$\(|`/.test(lines[i])) return null;
      }
      if (!closed) return null;
    }
  }
  if (!found) return null;
  const rest = out.join("\n").trim();
  return rest && !rest.includes("\n") ? rest : null;
}
