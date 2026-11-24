// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The project's Node version versus the one the agent's shell runs (docs/permission-modes.md,
 * "Node versions"). A project that pins Node 22 (.nvmrc, .node-version, .tool-versions,
 * package.json volta.node or engines.node) on a machine whose default is Node 26 fails `npm ci`
 * when a native module (better-sqlite3, ...) compiles. Instead of a dead end, the lead is told up
 * front which version the project wants and the exact command prefix that runs under it with what
 * is installed here (nvm, fnm, volta, asdf, mise or Homebrew `node@N`), or how to install it. A
 * failed command whose output shows the mismatch gets the same diagnosis as a hint. Nothing runs
 * on its own: the model retries with the prefix, through the permission policy like any command.
 *
 * Shell commands run with a scrubbed environment (no NVM_DIR, VOLTA_HOME, ...), so every command
 * given here names absolute paths. The preferred form is `PATH="<that version's bin>:$PATH" <cmd>`:
 * it needs no version manager in the shell and works for every manager that keeps versions on disk.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { scrubShellEnv } from "./tool-executor.js";

type Ver = [number, number, number];

// ---------------------------------------------------------------------------
// Versions and ranges (a small subset of npm semver: enough for engines.node)
// ---------------------------------------------------------------------------

/** "v22.12.0", "22.12", "22" → [22, 12, 0] (missing parts 0); null when not a version. */
export function parseVersion(text: string): Ver | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

function cmp(a: Ver, b: Ver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

type Comparator = { op: ">=" | ">" | "<" | "<=" | "="; v: Ver };

/** A partial version ("22", "22.12", "22.x") as its parts; null parts are wildcards. */
function partial(text: string): Array<number | null> | null {
  if (text === "" || text === "*" || /^[xX]$/.test(text)) return [];
  const parts = text.replace(/^v/, "").replace(/[-+].*$/, "").split(".");
  if (parts.length > 3) return null;
  const out: Array<number | null> = [];
  for (const p of parts) {
    if (/^[xX*]$/.test(p)) break;
    if (!/^\d+$/.test(p)) return null;
    out.push(Number(p));
  }
  return out;
}

/** The first version after every version matching the partial (22 → 23.0.0, 22.12 → 22.13.0). */
function bumpPartial(p: number[]): Ver {
  if (p.length === 1) return [p[0] + 1, 0, 0];
  if (p.length === 2) return [p[0], p[1] + 1, 0];
  return [p[0], p[1], p[2] + 1];
}

function fill(p: number[]): Ver {
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

function comparators(token: string): Comparator[] | null {
  const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? "";
  const raw = partial(m[2]);
  if (!raw) return null;
  const p = raw as number[];
  if (!p.length) return op === "<" || op === ">" ? [{ op: "<", v: [0, 0, 0] }] : [];
  const full = p.length === 3;
  switch (op) {
    case ">=":
      return [{ op: ">=", v: fill(p) }];
    case ">":
      return full ? [{ op: ">", v: fill(p) }] : [{ op: ">=", v: bumpPartial(p) }];
    case "<":
      return [{ op: "<", v: fill(p) }];
    case "<=":
      return full ? [{ op: "<=", v: fill(p) }] : [{ op: "<", v: bumpPartial(p) }];
    case "^":
      return [{ op: ">=", v: fill(p) }, { op: "<", v: [p[0] + 1, 0, 0] }];
    case "~":
      return [{ op: ">=", v: fill(p) }, { op: "<", v: p.length === 1 ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0] }];
    default:
      return full ? [{ op: "=", v: fill(p) }] : [{ op: ">=", v: fill(p) }, { op: "<", v: bumpPartial(p) }];
  }
}

/** A range (`>=22.12 <25`, `^20 || ^22`, `20.x`, `18 - 22`) as comparator sets; null when unreadable. */
export function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alt of range.split("||")) {
    let s = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hyphen) s = `>=${hyphen[1]} <=${hyphen[2]}`;
    const set: Comparator[] = [];
    for (const token of s.split(/\s+/).filter(Boolean)) {
      const c = comparators(token);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets.length ? sets : null;
}

function inSet(v: Ver, set: Comparator[]): boolean {
  return set.every(({ op, v: w }) => {
    const c = cmp(v, w);
    return op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : op === "<=" ? c <= 0 : c === 0;
  });
}

/** True when the version satisfies the range; null when the range can't be read. */
export function satisfies(version: string | Ver, range: string): boolean | null {
  const v = typeof version === "string" ? parseVersion(version) : version;
  const sets = parseRange(range);
  if (!v || !sets) return null;
  return sets.some((s) => inSet(v, s));
}

/** True when some version of this major satisfies the range. */
function majorFits(major: number, range: string): boolean {
  const sets = parseRange(range);
  if (!sets) return false;
  return sets.some((set) => {
    const probes: Ver[] = [[major, 0, 0], [major, 999, 999]];
    for (const { v } of set) if (v[0] === major) probes.push(v, [v[0], v[1], v[2] + 1]);
    return probes.some((p) => inSet(p, set));
  });
}

// ---------------------------------------------------------------------------
// What the project wants
// ---------------------------------------------------------------------------

/** Node LTS code names (`lts/iron` in .nvmrc). */
const LTS: Record<string, number> = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

export interface WantedNode {
  /** The pinned version as written (`22`, `v22.12.0`, `lts/jod`) and where; null when nothing pins one. */
  pin: { spec: string; source: string; major: number | null } | null;
  /** package.json engines.node, when present. */
  engines: string | null;
}

export interface ToolchainFs {
  exists(path: string): boolean;
  readFile(path: string): string | null;
  readdir(path: string): string[];
  realpath?(path: string): string;
}

export const nodeFs: ToolchainFs = {
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return statSync(p).size > 256 * 1024 ? null : readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  },
  readdir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  realpath: (p) => realpathSync(p),
};

function pinMajor(spec: string): number | null {
  const s = spec.trim().toLowerCase();
  const lts = /^lts\/(\w+)$/.exec(s);
  if (lts) return LTS[lts[1]] ?? null;
  const v = /^v?(\d+)(\.|$)/.exec(s);
  return v ? Number(v[1]) : null;
}

/** The first meaningful line of a version file (comments and blank lines skipped). */
function firstLine(text: string | null): string | null {
  if (!text) return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line) return line;
  }
  return null;
}

/** The Node version the project asks for: .nvmrc, .node-version, .tool-versions, volta.node, engines.node. */
export function readWantedNode(root: string, fs: ToolchainFs = nodeFs): WantedNode {
  let pkg: { engines?: { node?: unknown }; volta?: { node?: unknown } } = {};
  try {
    pkg = JSON.parse(fs.readFile(join(root, "package.json")) ?? "{}") ?? {};
  } catch {
    pkg = {};
  }
  const engines = typeof pkg.engines?.node === "string" && pkg.engines.node.trim() ? pkg.engines.node.trim() : null;
  const candidates: Array<[string, string | null]> = [
    [".nvmrc", firstLine(fs.readFile(join(root, ".nvmrc")))],
    [".node-version", firstLine(fs.readFile(join(root, ".node-version")))],
    [
      ".tool-versions",
      (() => {
        for (const line of (fs.readFile(join(root, ".tool-versions")) ?? "").split(/\r?\n/)) {
          const m = /^\s*(?:nodejs|node)\s+(\S+)/.exec(line);
          if (m) return m[1];
        }
        return null;
      })(),
    ],
    ["package.json volta.node", typeof pkg.volta?.node === "string" ? pkg.volta.node.trim() : null],
  ];
  for (const [source, spec] of candidates) {
    if (spec && spec.length <= 40) return { pin: { spec, source, major: pinMajor(spec) }, engines };
  }
  return { pin: null, engines };
}

// ---------------------------------------------------------------------------
// What this machine has
// ---------------------------------------------------------------------------

export type ManagerName = "nvm" | "fnm" | "volta" | "asdf" | "mise" | "brew";

export interface InstalledNode {
  version: Ver;
  /** The folder holding that version's node and npm. */
  bin: string;
  via: ManagerName;
}

export interface Manager {
  name: ManagerName;
  /** Installs a version (it downloads, so it asks for approval). */
  install(target: string): string;
  /** Runs a command under a version once installed; null when the manager has no such command (then use the PATH form). */
  exec(target: string, cmd: string): string | null;
}

export interface MachineDeps {
  fs: ToolchainFs;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

function q(path: string): string {
  return `"${path}"`;
}

/** A path that can sit inside double quotes in sh as is. */
function quotable(path: string): boolean {
  return !/["$`\\\n\r]/.test(path);
}

/** A program on PATH or at one of the usual places; its path, or null. */
function findBin(name: string, d: MachineDeps, extra: string[]): string | null {
  for (const dir of (d.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (d.fs.exists(join(dir, name))) return name;
  }
  for (const p of extra) if (d.fs.exists(p)) return p;
  return null;
}

/** Versions in `dir`, one folder per version (`v22.12.0`, `22.12.0`), with their bin folder. */
function versionsIn(d: MachineDeps, dir: string, via: ManagerName, binOf: (entry: string) => string): InstalledNode[] {
  const out: InstalledNode[] = [];
  for (const entry of d.fs.readdir(dir)) {
    const v = parseVersion(entry);
    if (!v || !/^v?\d+\.\d+\.\d+$/.test(entry)) continue;
    const bin = binOf(entry);
    if (d.fs.exists(join(bin, "node")) && quotable(bin)) out.push({ version: v, bin, via });
  }
  return out;
}

/** Version managers on this machine and the Node versions they hold. */
export function detectMachine(d: MachineDeps): { managers: Manager[]; installed: InstalledNode[] } {
  const managers: Manager[] = [];
  const installed: InstalledNode[] = [];
  const { env, home } = d;

  // nvm: a shell function from nvm.sh; the shell doesn't get NVM_DIR, so the path is spelled out.
  const nvmDir = env.NVM_DIR || join(home, ".nvm");
  if (d.fs.exists(join(nvmDir, "nvm.sh")) && quotable(nvmDir)) {
    const nvmSh = q(join(nvmDir, "nvm.sh"));
    managers.push({ name: "nvm", install: (t) => `. ${nvmSh} && nvm install ${t}`, exec: (t, cmd) => `. ${nvmSh} && nvm use ${t} >/dev/null && ${cmd}` });
    installed.push(...versionsIn(d, join(nvmDir, "versions", "node"), "nvm", (e) => join(nvmDir, "versions", "node", e, "bin")));
  }

  const fnm = findBin("fnm", d, ["/opt/homebrew/bin/fnm", "/usr/local/bin/fnm", join(home, ".local", "share", "fnm", "fnm"), join(home, ".fnm", "fnm"), join(home, ".cargo", "bin", "fnm")]);
  if (fnm && quotable(fnm)) {
    const f = fnm.includes("/") ? q(fnm) : fnm;
    managers.push({ name: "fnm", install: (t) => `${f} install ${t}`, exec: (t, cmd) => `${f} exec --using=${t} ${cmd}` });
    const dirs = [env.FNM_DIR, d.platform === "darwin" ? join(home, "Library", "Application Support", "fnm") : null, join(home, ".local", "share", "fnm"), join(home, ".fnm")].filter((x): x is string => !!x);
    for (const dir of dirs) installed.push(...versionsIn(d, join(dir, "node-versions"), "fnm", (e) => join(dir, "node-versions", e, "installation", "bin")));
  }

  const voltaHome = env.VOLTA_HOME || join(home, ".volta");
  const volta = findBin("volta", d, [join(voltaHome, "bin", "volta")]);
  if (volta && quotable(volta)) {
    const v = volta.includes("/") ? q(volta) : volta;
    managers.push({ name: "volta", install: (t) => `${v} fetch node@${t}`, exec: (t, cmd) => `${v} run --node ${t} ${cmd}` });
    installed.push(...versionsIn(d, join(voltaHome, "tools", "image", "node"), "volta", (e) => join(voltaHome, "tools", "image", "node", e, "bin")));
  }

  const asdfDir = env.ASDF_DATA_DIR || join(home, ".asdf");
  const asdf = findBin("asdf", d, ["/opt/homebrew/bin/asdf", "/usr/local/bin/asdf", join(asdfDir, "bin", "asdf")]);
  if (asdf && quotable(asdf)) {
    const a = asdf.includes("/") ? q(asdf) : asdf;
    managers.push({ name: "asdf", install: (t) => `${a} install nodejs latest:${t}`, exec: () => null });
    installed.push(...versionsIn(d, join(asdfDir, "installs", "nodejs"), "asdf", (e) => join(asdfDir, "installs", "nodejs", e, "bin")));
  }

  const miseDir = env.MISE_DATA_DIR || join(home, ".local", "share", "mise");
  const mise = findBin("mise", d, [join(home, ".local", "bin", "mise"), "/opt/homebrew/bin/mise", "/usr/local/bin/mise"]);
  if (mise && quotable(mise)) {
    const m = mise.includes("/") ? q(mise) : mise;
    managers.push({ name: "mise", install: (t) => `${m} install node@${t}`, exec: (t, cmd) => `${m} exec node@${t} -- ${cmd}` });
    installed.push(...versionsIn(d, join(miseDir, "installs", "node"), "mise", (e) => join(miseDir, "installs", "node", e, "bin")));
  }

  // Homebrew's versioned kegs: /opt/homebrew/opt/node@22/bin.
  const brew = findBin("brew", d, ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"]);
  const brewPrefixes = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"].filter((p) => d.fs.exists(join(p, "bin", "brew")));
  if (brew) managers.push({ name: "brew", install: (t) => `brew install node@${pinMajor(t) ?? t}`, exec: () => null });
  for (const prefix of brewPrefixes) {
    for (const entry of d.fs.readdir(join(prefix, "opt"))) {
      const m = /^node@(\d+)$/.exec(entry);
      if (!m) continue;
      const bin = join(prefix, "opt", entry, "bin");
      if (!d.fs.exists(join(bin, "node"))) continue;
      let version: Ver = [Number(m[1]), 0, 0];
      try {
        version = parseVersion(basename(d.fs.realpath?.(join(prefix, "opt", entry)) ?? "")) ?? version;
      } catch {
        // keep the major
      }
      installed.push({ version, bin, via: "brew" });
    }
  }
  return { managers, installed };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ToolchainReport {
  wanted: WantedNode;
  /** `node --version` in the agent's shell ("v26.0.0"); null when there is no node on its PATH. */
  current: string | null;
  /** The current Node doesn't fit what the project wants. */
  mismatch: boolean;
  /** The version to use, as nvm/fnm/volta take it ("22", or the pin as written). */
  target: string | null;
  /** The best installed version that fits, if any. */
  use: InstalledNode | null;
  /** How to install the target when nothing installed fits (it asks: it downloads). */
  install: string | null;
  /** Runs a command under the target version; null when no form is known. */
  runWith(cmd: string): string | null;
  /** Names of the version managers found. */
  managers: ManagerName[];
}

function fits(v: Ver, wanted: WantedNode): boolean {
  if (wanted.pin?.major != null && v[0] !== wanted.pin.major) return false;
  if (wanted.engines && satisfies(v, wanted.engines) === false) return false;
  return true;
}

/** The major to install when nothing fits: the pin's, else the newest even (LTS) major the engines allow. */
function targetMajor(wanted: WantedNode): number | null {
  if (wanted.pin?.major != null) return wanted.pin.major;
  if (!wanted.engines || !parseRange(wanted.engines)) return null;
  let best: number | null = null;
  for (let m = 40; m >= 4; m--) {
    if (!majorFits(m, wanted.engines)) continue;
    if (m % 2 === 0) return m;
    best ??= m;
  }
  return best;
}

/** Compares what the project wants with the current Node and what is installed (pure). */
export function planToolchain(wanted: WantedNode, current: string | null, machine: { managers: Manager[]; installed: InstalledNode[] }, platform: NodeJS.Platform = process.platform): ToolchainReport {
  const none: ToolchainReport = { wanted, current, mismatch: false, target: null, use: null, install: null, runWith: () => null, managers: machine.managers.map((m) => m.name) };
  const known = wanted.pin?.major != null || (wanted.engines !== null && parseRange(wanted.engines) !== null);
  if (!known) return none;
  const cur = current ? parseVersion(current) : null;
  const mismatch = !cur || !fits(cur, wanted);
  const major = targetMajor(wanted);
  if (major === null) return { ...none, mismatch };
  // The pin as written when nvm-style ("22", "v22.12.0", "lts/jod"); otherwise the major.
  const target = wanted.pin && /^(v?\d+(\.\d+){0,2}|lts\/\w+)$/i.test(wanted.pin.spec) && pinMajor(wanted.pin.spec) === major ? wanted.pin.spec : String(major);
  const use = machine.installed.filter((i) => fits(i.version, wanted)).sort((a, b) => cmp(b.version, a.version))[0] ?? null;
  if (use) return { ...none, mismatch, target, use, runWith: (cmd) => `PATH=${q(`${use.bin}:$PATH`)} ${cmd}` };
  const mgr = machine.managers.find((m) => m.name !== "brew" && m.exec(target, "x") !== null) ?? machine.managers.find((m) => m.name !== "brew") ?? machine.managers.find((m) => m.name === "brew");
  if (mgr) {
    const brewBin = platform === "darwin" ? `/opt/homebrew/opt/node@${major}/bin` : null;
    return {
      ...none,
      mismatch,
      target,
      install: mgr.install(mgr.name === "brew" ? String(major) : target),
      runWith: (cmd) => mgr.exec(target, cmd) ?? (mgr.name === "brew" && brewBin ? `PATH=${q(`${brewBin}:$PATH`)} ${cmd}` : null),
    };
  }
  if (platform === "darwin") {
    const brewBin = `/opt/homebrew/opt/node@${major}/bin`;
    return { ...none, mismatch, target, install: `brew install node@${major}`, runWith: (cmd) => `PATH=${q(`${brewBin}:$PATH`)} ${cmd}` };
  }
  return { ...none, mismatch, target };
}

function describeWanted(w: WantedNode): string {
  const parts: string[] = [];
  if (w.pin) parts.push(`${w.pin.spec} in ${w.pin.source}`);
  if (w.engines) parts.push(`engines.node "${w.engines}" in package.json`);
  return parts.join("; ");
}

function wantedLabel(r: ToolchainReport): string {
  return r.target ? `Node ${r.target}` : "a different Node";
}

/** The diagnosis and next step, without the leading label. */
function advice(r: ToolchainReport, example: string): string {
  const now = r.current ? `the agent's shell runs Node ${r.current}` : "the agent's shell has no node on its PATH";
  const lines = [`This project wants ${wantedLabel(r)} (${describeWanted(r.wanted)}) but ${now}; native modules (better-sqlite3, node-gyp builds) fail under the wrong version.`];
  const run = r.runWith(example);
  if (r.use) {
    lines.push(`${wantedLabel(r)} is installed (${r.use.via}, v${r.use.version.join(".")}). Run Node, npm, npx and test commands under it by prefixing them, e.g. \`${run}\`.`);
  } else if (r.install) {
    lines.push(`${wantedLabel(r)} isn't installed. Install it with \`${r.install}\` (it downloads, so the user is asked to approve)${run ? `, then run commands under it, e.g. \`${run}\`` : ", then run the command again (EdgeCoder will name the exact prefix)"}.`);
  } else {
    lines.push(`No Node version manager was found on this machine. Tell the user which version to install (for example with nvm, https://github.com/nvm-sh/nvm), then run the command again.`);
  }
  lines.push("Do this yourself rather than asking the user to switch versions; if node_modules was built under the other version, reinstall it under the right one.");
  return lines.join(" ");
}

/** A short line for the lead's system prompt when the project's Node and the shell's differ; "" otherwise. */
export function toolchainNoteFor(r: ToolchainReport): string {
  if (!r.mismatch) return "";
  return `## Node version\n\n${advice(r, "npm ci")}`;
}

const ENGINE_FAILURE = /EBADENGINE|Unsupported engine|The engine "node" is incompatible|NODE_MODULE_VERSION \d+|was compiled against a different Node\.js version|ERR_DLOPEN_FAILED/;
const NATIVE_FAILURE = /gyp ERR!|node-gyp|prebuild-install|node-pre-gyp|better[-_]sqlite3|binding\.gyp|\.node: (?:undefined symbol|invalid ELF|mach-o)/i;
/** A command already under a version wrapper. */
const WRAPPED = /(^|\s)PATH=|nvm (use|exec|run)\b|fnm exec\b|volta run\b|mise (exec|x)\b|asdf exec\b/;

/**
 * Text appended to a run_shell result when its output shows a Node engine or native-module
 * failure: the diagnosis and the same command under the right version. Null when it doesn't apply.
 */
export function toolchainFailureHintFor(command: string, output: string, r: ToolchainReport): string | null {
  const engine = ENGINE_FAILURE.test(output);
  if (!engine && !NATIVE_FAILURE.test(output)) return null;
  if (WRAPPED.test(command)) return null;
  const cmd = command.trim() || "npm ci";
  if (r.mismatch) return `[EdgeCoder hint] This failure looks like a Node version mismatch. ${advice(r, cmd)}`;
  if (!engine) return null;
  // A dependency's engines (not the project's own pin): say what npm reported.
  const req = /required:\s*\{\s*node:\s*'([^']+)'/.exec(output)?.[1];
  return `[EdgeCoder hint] A package needs a different Node${req ? ` (${req})` : ""} than the shell's${r.current ? ` (${r.current})` : ""}. Check package.json engines and pick a Node version that fits; installed version managers: ${r.managers.join(", ") || "none"}.`;
}

// ---------------------------------------------------------------------------
// Per-project, cached
// ---------------------------------------------------------------------------

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; report: ToolchainReport }>();

/** `node --version` as the agent's shell would run it (same scrubbed env, project folder). */
function shellNodeVersion(root: string): string | null {
  try {
    return execFileSync("node", ["--version"], { cwd: root, env: scrubShellEnv(process.env), encoding: "utf-8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The project's toolchain report; cheap (a few file reads; `node --version` only when a version is pinned), cached a minute. */
export function detectToolchain(root: string, now = Date.now()): ToolchainReport {
  const hit = cache.get(root);
  if (hit && now - hit.at < CACHE_MS) return hit.report;
  const wanted = readWantedNode(root);
  const report = wanted.pin || wanted.engines
    ? planToolchain(wanted, shellNodeVersion(root), detectMachine({ fs: nodeFs, env: process.env, home: homedir(), platform: process.platform }))
    : planToolchain(wanted, null, { managers: [], installed: [] });
  cache.set(root, { at: now, report });
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return report;
}

/** For the lead's system prompt: the Node version note, or "" (never throws). */
export function toolchainNote(root: string): string {
  // The suggested commands are POSIX shell (PATH prefixes, nvm/fnm): not offered on Windows.
  if (process.platform === "win32") return "";
  try {
    return toolchainNoteFor(detectToolchain(root));
  } catch {
    return "";
  }
}

/** For makeToolRunner's shellHint: the hint for a run_shell result, or null (never throws). */
export function toolchainFailureHint(root: string, command: string, output: string): string | null {
  if (process.platform === "win32") return null;
  try {
    if (!ENGINE_FAILURE.test(output) && !NATIVE_FAILURE.test(output)) return null;
    return toolchainFailureHintFor(command, output, detectToolchain(root));
  } catch {
    return null;
  }
}

/** Test seam: forget cached reports. */
export function clearToolchainCache(): void {
  cache.clear();
}
