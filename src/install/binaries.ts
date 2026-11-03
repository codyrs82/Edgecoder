// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * The binaries a service runs must not be replaceable by anyone but root. On Linux and macOS
 * `edgecoder-install` checks the node and ollama binaries (every path component up to /, and on
 * macOS the dylibs and rpaths they load) and the app dir. A binary that fails the check (Homebrew
 * under /opt/homebrew, nvm under $HOME, /Applications which admin users can write) is copied into
 * a root-owned stage dir (<stageDir>/node, <stageDir>/ollama) and checked again; the services run
 * the copy. If the copy still loads libraries a user can replace (Homebrew's node links
 * /opt/homebrew/opt/* dylibs), apply stops and says which.
 * File access goes through an injected `BinFs` so the checks are unit-tested.
 */
import { posix } from "node:path";

export interface FileStat {
  uid: number;
  mode: number;
  isDirectory: boolean;
}

export interface BinFs {
  /** stat (follows symlinks); null when the path does not exist. */
  stat(path: string): FileStat | null;
  realpath(path: string): string;
  /** Up to `length` bytes at `offset`; shorter (or empty) at end of file. */
  read(path: string, offset: number, length: number): Buffer;
  /** Recursive copy that dereferences symlinks, replacing `dest`. */
  copy(src: string, dest: string): void;
  /** chown -R root, chmod -R go-w. */
  secure(path: string): void;
}

/** Why `path` (or a directory above it) could be replaced by a non-root user; null if it cannot. */
export function nonRootWritable(fs: BinFs, path: string): string | null {
  let p = posix.normalize(path);
  for (;;) {
    const st = fs.stat(p);
    // A missing component is fine as long as the nearest existing ancestor is root-only.
    if (st) {
      if (st.uid !== 0) return `${p} is owned by uid ${st.uid}`;
      if (st.mode & 0o022) return `${p} is writable by group or others (mode ${(st.mode & 0o7777).toString(8)})`;
    }
    if (p === "/") return null;
    p = posix.dirname(p);
  }
}

// ───────────────────────────── Mach-O load commands ─────────────────────────────
// Unsigned values as readUInt32LE returns them (0x80000000 is LC_REQ_DYLD).
const DYLIB_CMDS = new Set([0xc /* LOAD_DYLIB */, 0x80000018 /* LOAD_WEAK_DYLIB */, 0x8000001f /* REEXPORT_DYLIB */, 0x20 /* LAZY_LOAD_DYLIB */, 0x80000023 /* LOAD_UPWARD_DYLIB */]);
export const LC_RPATH = 0x8000001c;

export interface MachoDeps {
  dylibs: string[];
  rpaths: string[];
}

function cstr(buf: Buffer, start: number, end: number): string {
  const nul = buf.indexOf(0, start);
  return buf.toString("utf8", start, nul === -1 || nul > end ? end : nul);
}

/** Dylibs and rpaths of every slice of a Mach-O (thin or fat); null when the file is not Mach-O. */
export function machoDeps(fs: BinFs, path: string): MachoDeps | null {
  const head = fs.read(path, 0, 4096);
  if (head.length < 8) return null;
  const magicBE = head.readUInt32BE(0);
  const slices: number[] = [];
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const n = head.readUInt32BE(4);
    const wide = magicBE === 0xcafebabf;
    const size = wide ? 32 : 20;
    for (let i = 0; i < n && 8 + (i + 1) * size <= head.length; i++) {
      const at = 8 + i * size;
      slices.push(wide ? Number(head.readBigUInt64BE(at + 8)) : head.readUInt32BE(at + 8));
    }
  } else {
    slices.push(0);
  }
  const out: MachoDeps = { dylibs: [], rpaths: [] };
  let any = false;
  for (const off of slices) {
    const hdr = fs.read(path, off, 32);
    if (hdr.length < 28) continue;
    const magic = hdr.readUInt32LE(0);
    if (magic !== 0xfeedface && magic !== 0xfeedfacf) continue;
    any = true;
    const ncmds = hdr.readUInt32LE(16);
    const sizeofcmds = hdr.readUInt32LE(20);
    const cmds = fs.read(path, off + (magic === 0xfeedfacf ? 32 : 28), sizeofcmds);
    let at = 0;
    for (let i = 0; i < ncmds && at + 8 <= cmds.length; i++) {
      const cmd = cmds.readUInt32LE(at);
      const size = cmds.readUInt32LE(at + 4);
      if (size < 8) break;
      if ((DYLIB_CMDS.has(cmd) || cmd === LC_RPATH) && at + 12 <= cmds.length) {
        const s = cstr(cmds, at + cmds.readUInt32LE(at + 8), Math.min(at + size, cmds.length));
        (cmd === LC_RPATH ? out.rpaths : out.dylibs).push(s);
      }
      at += size;
    }
  }
  if (!any) return null;
  out.dylibs = [...new Set(out.dylibs)];
  out.rpaths = [...new Set(out.rpaths)];
  return out;
}

const SYSTEM_PREFIXES = ["/usr/lib/", "/System/"];

/** Libraries a Mach-O loads from places a non-root user could write. */
export function machoProblems(fs: BinFs, binary: string): string[] {
  const deps = machoDeps(fs, binary);
  if (!deps) return [];
  const here = posix.dirname(binary);
  const expand = (p: string) => p.replace(/^@(loader_path|executable_path)(?=\/|$)/, here);
  const rpaths = deps.rpaths.map(expand);
  const problems: string[] = [];
  const check = (lib: string, via: string) => {
    if (lib.startsWith("@")) return problems.push(`${binary} loads ${via} through an unresolvable ${lib}`);
    const p = posix.normalize(lib);
    // System libraries live in the dyld shared cache (not on disk) under SIP-protected paths.
    if (SYSTEM_PREFIXES.some((s) => p.startsWith(s))) return;
    const why = nonRootWritable(fs, p);
    if (why) problems.push(`${binary} loads ${via}: ${why}`);
  };
  for (const lib of deps.dylibs) {
    if (lib.startsWith("@rpath/")) {
      // dyld tries each rpath in turn: a writable one lets a user plant the library.
      if (rpaths.length === 0) problems.push(`${binary} loads ${lib} with no LC_RPATH`);
      for (const r of rpaths) check(`${r}/${lib.slice("@rpath/".length)}`, lib);
    } else {
      check(expand(lib), lib);
    }
  }
  return [...new Set(problems)];
}

// ───────────────────────────── staging ─────────────────────────────
export type BinaryKind = "node" | "ollama";

export interface StagePlan {
  kind: BinaryKind;
  /** The binary the services run. */
  path: string;
  /** Set when the source fails the check and is copied first. */
  copy?: { from: string; to: string; extra: Array<{ from: string; to: string }> };
  /** Why the source was not used in place. */
  reason?: string;
}

/**
 * Keep an Ollama install's runner libraries where the copied binary looks for them: a prefix
 * install (<prefix>/bin/ollama with <prefix>/lib/ollama, the Linux tarball) copies those two; a
 * dedicated directory (Homebrew's keg libexec, Ollama.app's Resources, anything with lib/ollama
 * beside the binary) is copied whole; otherwise the binary alone.
 */
function ollamaLayout(fs: BinFs, real: string, dest: string): { binary: string; from: string; to: string; extra: Array<{ from: string; to: string }> } {
  const dir = posix.dirname(real);
  if (posix.basename(dir) === "bin") {
    const prefix = posix.dirname(dir);
    return { binary: `${dest}/bin/ollama`, from: real, to: `${dest}/bin/ollama`, extra: [{ from: `${prefix}/lib/ollama`, to: `${dest}/lib/ollama` }] };
  }
  if (/\/Cellar\/ollama\/|\/Ollama\.app\//.test(dir) || fs.stat(`${dir}/lib/ollama`)?.isDirectory) {
    return { binary: `${dest}/${posix.basename(real)}`, from: dir, to: dest, extra: [] };
  }
  return { binary: `${dest}/ollama`, from: real, to: `${dest}/ollama`, extra: [] };
}

export function planBinary(fs: BinFs, platform: NodeJS.Platform, kind: BinaryKind, src: string, stageDir: string): StagePlan {
  const real = fs.realpath(src);
  const reason = nonRootWritable(fs, real) ?? (platform === "darwin" ? machoProblems(fs, real)[0] ?? null : null);
  if (!reason) return { kind, path: real };
  const dest = `${stageDir}/${kind}`;
  if (kind === "node") return { kind, path: `${dest}/bin/node`, copy: { from: real, to: `${dest}/bin/node`, extra: [] }, reason };
  const l = ollamaLayout(fs, real, dest);
  return { kind, path: l.binary, copy: { from: l.from, to: l.to, extra: l.extra.filter((e) => fs.stat(e.from)) }, reason };
}

/** Copy (if planned), lock down, and re-check. Returns the problems left; empty means safe. */
export function stageBinary(fs: BinFs, platform: NodeJS.Platform, plan: StagePlan, stageDir: string): string[] {
  if (plan.copy) {
    for (const c of [plan.copy, ...plan.copy.extra]) fs.copy(c.from, c.to);
    fs.secure(`${stageDir}/${plan.kind}`);
  }
  const why = nonRootWritable(fs, plan.path);
  if (why) return [`${plan.kind} at ${plan.path}: ${why}`];
  if (platform === "darwin") {
    const libs = machoProblems(fs, plan.path);
    if (libs.length) return [...libs, `${plan.kind} at ${plan.path} links libraries outside root-owned paths${plan.kind === "node" ? "; install the official Node.js build from nodejs.org (deploy/install.sh does this) and pass --node-bin" : ""}`];
  }
  return [];
}

/** The app dir the agent runs from (and its code and dependencies) must be root-only too. */
export function appDirProblems(fs: BinFs, appDir: string): string[] {
  const out: string[] = [];
  for (const p of [`${appDir}/dist/swarm/worker-runner.js`, `${appDir}/dist`, `${appDir}/node_modules`, `${appDir}/package.json`]) {
    if (!fs.stat(p)) continue;
    const why = nonRootWritable(fs, fs.realpath(p));
    if (why) out.push(`app dir: ${why}`);
  }
  return [...new Set(out)];
}
