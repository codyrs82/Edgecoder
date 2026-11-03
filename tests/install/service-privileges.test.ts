import { describe, expect, it } from "vitest";
import { appDirProblems, LC_RPATH, machoDeps, machoProblems, nonRootWritable, planBinary, stageBinary, type BinFs, type FileStat } from "../../src/install/binaries.js";
import { secureBinaries } from "../../src/install/cli.js";
import { detectHardware, type Probe } from "../../src/install/hardware.js";
import { parseInstallArgs } from "../../src/install/options.js";
import { planInstall } from "../../src/install/plan.js";
import { applyPlan, defaultPaths, launchdAgentPlist, launchdOllamaPlist, MAC_SERVICE_USER, pickMacServiceId, systemdAgentUnit, systemdOllamaUnit, type Host } from "../../src/install/services.js";

const TWO_GPUS: Probe = (cmd) => (cmd === "nvidia-smi" ? "0, NVIDIA RTX 6000 Ada Generation, 49140\n1, NVIDIA RTX 6000 Ada Generation, 49140\n" : null);
const opts = parseInstallArgs(["apply", "--token", "t"]);

function host(platform: NodeJS.Platform, run?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string }) {
  const files = new Map<string, { content: string; mode?: number }>();
  const commands: string[] = [];
  const h: Host = {
    platform,
    writeFile: (p, content, mode) => { files.set(p, { content, mode }); },
    removeFile: (p) => { files.delete(p); },
    run: (cmd, args) => { commands.push([cmd, ...args].join(" ")); return run?.(cmd, args) ?? { code: 0, stdout: "", stderr: "" }; },
    exists: (p) => files.has(p)
  };
  return { h, files, commands };
}

/** In-memory file tree: path -> stat (+ content). Directories implied by `dirs`. */
function memFs(entries: Record<string, Partial<FileStat> & { data?: Buffer; link?: string }>) {
  const map = new Map(Object.entries(entries));
  const copies: Array<[string, string]> = [];
  const secured: string[] = [];
  const fs: BinFs = {
    stat: (p) => {
      const e = map.get(p);
      return e ? { uid: e.uid ?? 0, mode: e.mode ?? 0o755, isDirectory: e.isDirectory ?? !e.data } : null;
    },
    realpath: (p) => map.get(p)?.link ?? p,
    read: (p, off, len) => (map.get(p)?.data ?? Buffer.alloc(0)).subarray(off, off + len),
    copy: (from, to) => {
      copies.push([from, to]);
      const src = map.get(from);
      map.set(to, { ...src, uid: 0, mode: 0o755 });
    },
    secure: (p) => { secured.push(p); }
  };
  return { fs, map, copies, secured };
}

const rootDirs = (...paths: string[]) => Object.fromEntries(paths.map((p) => [p, { uid: 0, mode: 0o755, isDirectory: true }]));

/** A thin 64-bit Mach-O with the given LC_LOAD_DYLIB and LC_RPATH entries. */
function macho(dylibs: string[], rpaths: string[] = []): Buffer {
  const cmd = (type: number, nameOffset: number, s: string) => {
    const body = Buffer.from(s + "\0");
    const size = Math.ceil((nameOffset + body.length) / 8) * 8;
    const b = Buffer.alloc(size);
    b.writeUInt32LE(type, 0);
    b.writeUInt32LE(size, 4);
    b.writeUInt32LE(nameOffset, 8);
    body.copy(b, nameOffset);
    return b;
  };
  const cmds = [...dylibs.map((d) => cmd(0xc, 24, d)), ...rpaths.map((r) => cmd(LC_RPATH, 12, r))];
  const all = Buffer.concat(cmds);
  const hdr = Buffer.alloc(32);
  hdr.writeUInt32LE(0xfeedfacf, 0);
  hdr.writeUInt32LE(cmds.length, 16);
  hdr.writeUInt32LE(all.length, 20);
  return Buffer.concat([hdr, all]);
}

describe("macOS: LaunchDaemons run as _edgecoder", () => {
  const hw = detectHardware({ probe: () => null, platform: "darwin", arch: "arm64", ramGb: 64, cpuModel: "Apple M2 Ultra", cpuCores: 24, hostname: "studio" });
  const plan = planInstall(hw, opts, true);
  const p = defaultPaths("darwin", { nodeBin: "/opt/edgecoder/node/bin/node", ollamaBin: "/opt/edgecoder/libexec/ollama/bin/ollama" });

  it("sets UserName/GroupName, a per-instance HOME and a PATH without Homebrew", () => {
    expect(p.user).toBe(MAC_SERVICE_USER);
    for (const xml of [launchdAgentPlist(p, plan.instances[0]), launchdOllamaPlist(p, plan.instances[0])]) {
      expect(xml).toContain("<key>UserName</key>\n    <string>_edgecoder</string>");
      expect(xml).toContain("<key>GroupName</key>\n    <string>_edgecoder</string>");
      expect(xml).not.toContain("/opt/homebrew");
      expect(xml).toMatch(/<key>PATH<\/key>\n\s*<string>\/usr\/bin:\/bin:\/usr\/sbin:\/sbin:\/usr\/local\/bin<\/string>/);
    }
    const agent = launchdAgentPlist(p, plan.instances[0]);
    expect(agent).toContain("<string>/opt/edgecoder/node/bin/node</string>");
    expect(agent).toMatch(/<key>HOME<\/key>\n\s*<string>\/var\/lib\/edgecoder\/agent-0<\/string>/);
    expect(launchdOllamaPlist(p, plan.instances[0])).toContain("<string>/opt/edgecoder/libexec/ollama/bin/ollama</string>");
  });

  it("creates the role account when missing, then hands it only its own dirs", () => {
    const { h, commands } = host("darwin", (cmd, args) => {
      if (cmd === "dscl" && args[1] === "-read") return { code: 1, stdout: "", stderr: "" };
      if (cmd === "dscl" && args[2] === "/Users") return { code: 0, stdout: "root 0\n_www 70\nfoo 300\n", stderr: "" };
      if (cmd === "dscl" && args[2] === "/Groups") return { code: 0, stdout: "wheel 0\nbar 301\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = applyPlan(plan, h, p, false);
    expect(commands).toContain("dscl . -create /Users/_edgecoder UniqueID 302");
    expect(commands).toContain("dscl . -create /Groups/_edgecoder PrimaryGroupID 302");
    expect(commands).toContain("dscl . -create /Users/_edgecoder UserShell /usr/bin/false");
    expect(commands).toContain("dscl . -create /Users/_edgecoder IsHidden 1");
    expect(commands).toContain("chown -R _edgecoder:_edgecoder /var/lib/edgecoder/ollama /var/log/edgecoder");
    expect(commands).toContain("install -d -o _edgecoder -g _edgecoder -m 0750 /var/lib/edgecoder/agent-0");
    // Env files (tokens) stay root's.
    expect(commands).toContain("chown -R root:wheel /etc/edgecoder");
    expect(commands.some((c) => c.startsWith("chown") && c.includes("_edgecoder") && c.includes("/etc/edgecoder"))).toBe(false);
    // Account setup happens before any daemon is loaded.
    expect(commands.findIndex((c) => c.startsWith("dscl . -create /Users/_edgecoder UniqueID"))).toBeLessThan(commands.findIndex((c) => c.startsWith("launchctl bootstrap")));
    expect(r.services).toEqual(["io.edgecoder.ollama.0", "io.edgecoder.agent.0"]);
  });

  it("leaves an existing account alone", () => {
    const { h, commands } = host("darwin");
    applyPlan(plan, h, p, false);
    expect(commands.some((c) => c.startsWith("dscl . -create"))).toBe(false);
  });

  it("picks a uid/gid free in both tables", () => {
    expect(pickMacServiceId(new Set([300, 301]), new Set([302]))).toBe(303);
    expect(() => pickMacServiceId(new Set([300]), new Set(), 300, 300)).toThrow(/no free/);
  });

  it("warns that Docker Desktop's socket is out of reach", () => {
    expect(plan.warnings.some((w) => w.includes("_edgecoder") && w.includes("Docker"))).toBe(true);
  });
});

describe("linux: systemd units are unprivileged and sandboxed", () => {
  const hw = detectHardware({ probe: TWO_GPUS, platform: "linux", arch: "x64", ramGb: 256, cpuModel: "x", cpuCores: 32, hostname: "box" });
  const plan = planInstall(hw, opts, true);
  const p = defaultPaths("linux", { nodeBin: "/usr/bin/node", ollamaBin: "/usr/local/bin/ollama", appDir: "/opt/edgecoder/app" });

  it("runs both units as the edgecoder user with hardening", () => {
    for (const unit of [systemdAgentUnit(p, plan.instances[1]), systemdOllamaUnit(p, plan.instances[1])]) {
      expect(unit).toContain("User=edgecoder\nGroup=edgecoder\n");
      expect(unit).not.toMatch(/^User=root/m);
      expect(unit).not.toMatch(/DynamicUser/);
      for (const flag of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "ProtectKernelModules=yes", "RestrictSUIDSGID=yes"]) expect(unit).toContain(`${flag}\n`);
      // GPUs must stay visible.
      expect(unit).not.toContain("PrivateDevices");
    }
    expect(systemdOllamaUnit(p, plan.instances[1])).toContain("ReadWritePaths=/var/lib/edgecoder/ollama\n");
    expect(systemdOllamaUnit(p, plan.instances[1])).toContain("ExecStart=/usr/local/bin/ollama serve\n");
    // The agent writes only its StateDirectory.
    expect(systemdAgentUnit(p, plan.instances[1])).not.toContain("ReadWritePaths");
    expect(systemdAgentUnit(p, plan.instances[1])).toContain("StateDirectory=edgecoder/agent-1\n");
  });

  it("keeps /etc/edgecoder root-owned and adds docker only for the docker sandbox", () => {
    const { h, commands, files } = host("linux", (cmd) => ({ code: cmd === "id" ? 1 : 0, stdout: "", stderr: "" }));
    applyPlan(plan, h, p, false);
    expect(commands).toContain("useradd --system --create-home --home-dir /var/lib/edgecoder --shell /usr/sbin/nologin edgecoder");
    expect(commands).toContain("chown -R edgecoder:edgecoder /var/lib/edgecoder/ollama /var/log/edgecoder");
    expect(commands).toContain("chown -R root:root /etc/edgecoder");
    expect(commands).toContain("usermod -aG docker edgecoder");
    expect(files.get("/etc/edgecoder/agent-0.env")?.mode).toBe(0o600);
    // root takes the env files back after (re)writing them.
    expect(commands.indexOf("chown -R root:root /etc/edgecoder")).toBeLessThan(commands.indexOf("systemctl daemon-reload"));
    const none = host("linux");
    applyPlan(planInstall(hw, { ...opts, sandbox: "none" }, false), none.h, p, false);
    expect(none.commands.some((c) => c.startsWith("usermod"))).toBe(false);
  });
});

describe("windows: tasks run as the installing user, never SYSTEM", () => {
  const hw = detectHardware({ probe: TWO_GPUS, platform: "win32", arch: "x64", ramGb: 128, cpuModel: "x", cpuCores: 16, hostname: "WINBOX" });
  const plan = planInstall(hw, opts, true);
  const p = defaultPaths("win32", { configDir: "C:\\ProgramData\\EdgeCoder", modelsDir: "C:\\ProgramData\\EdgeCoder\\ollama", logDir: "C:\\ProgramData\\EdgeCoder\\logs", stateDir: "C:\\ProgramData\\EdgeCoder\\state", user: "WINBOX\\alice" });

  it("creates logon tasks with a limited token and locks the config dir", () => {
    const { h, commands } = host("win32");
    applyPlan(plan, h, p, false);
    const creates = commands.filter((c) => c.startsWith("schtasks /Create"));
    expect(creates).toHaveLength(4);
    for (const c of creates) {
      expect(c).toContain('/SC ONLOGON /RU "WINBOX\\alice" /IT /RL LIMITED');
      expect(c).not.toMatch(/SYSTEM|HIGHEST/);
    }
    expect(commands).toContain('icacls "C:\\ProgramData\\EdgeCoder" /inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F *S-1-5-18:(OI)(CI)F "WINBOX\\alice:(OI)(CI)RX"');
    expect(commands).toContain('icacls "C:\\ProgramData\\EdgeCoder\\ollama" /grant "WINBOX\\alice:(OI)(CI)M"');
  });
});

describe("binaries: services never run code a non-root user can replace", () => {
  it("walks every path component", () => {
    const { fs } = memFs({ ...rootDirs("/", "/usr", "/usr/bin"), "/usr/bin/node": { data: Buffer.from("x") }, "/opt": { uid: 0, mode: 0o775 }, "/opt/x": { data: Buffer.from("x") }, "/home": {}, "/home/u": { uid: 1000 }, "/home/u/node": { uid: 1000, data: Buffer.from("x") } });
    expect(nonRootWritable(fs, "/usr/bin/node")).toBeNull();
    expect(nonRootWritable(fs, "/opt/x")).toMatch(/\/opt is writable by group or others/);
    expect(nonRootWritable(fs, "/home/u/node")).toMatch(/owned by uid 1000/);
    // Missing components are judged by the nearest existing ancestor.
    expect(nonRootWritable(fs, "/usr/bin/missing/lib.dylib")).toBeNull();
    expect(nonRootWritable(fs, "/home/u/missing/lib.dylib")).toMatch(/uid 1000/);
  });

  it("reads dylibs and rpaths from a Mach-O and flags user-writable ones", () => {
    const bin = macho(["/usr/lib/libSystem.B.dylib", "/opt/homebrew/opt/libuv/lib/libuv.1.dylib", "@rpath/libnode.dylib"], ["@loader_path/../lib"]);
    const { fs } = memFs({ ...rootDirs("/", "/opt", "/opt/edgecoder", "/opt/edgecoder/node", "/opt/edgecoder/node/bin"), "/opt/edgecoder/node/bin/node": { data: bin }, "/opt/homebrew": { uid: 501 } });
    expect(machoDeps(fs, "/opt/edgecoder/node/bin/node")).toEqual({ dylibs: ["/usr/lib/libSystem.B.dylib", "/opt/homebrew/opt/libuv/lib/libuv.1.dylib", "@rpath/libnode.dylib"], rpaths: ["@loader_path/../lib"] });
    const problems = machoProblems(fs, "/opt/edgecoder/node/bin/node");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/libuv.*\/opt\/homebrew is owned by uid 501/);
    expect(machoDeps(fs, "/opt/edgecoder/node/bin")).toBeNull();
  });

  it("uses a root-owned binary in place", () => {
    const { fs, copies } = memFs({ ...rootDirs("/", "/usr", "/usr/bin"), "/usr/bin/node": { data: macho(["/usr/lib/libSystem.B.dylib"]) } });
    const plan = planBinary(fs, "darwin", "node", "/usr/bin/node", "/opt/edgecoder/libexec");
    expect(plan).toEqual({ kind: "node", path: "/usr/bin/node" });
    expect(stageBinary(fs, "darwin", plan, "/opt/edgecoder/libexec")).toEqual([]);
    expect(copies).toEqual([]);
  });

  it("copies a user-owned binary to the root-owned stage dir and runs the copy", () => {
    const { fs, copies, secured } = memFs({
      ...rootDirs("/", "/opt", "/opt/edgecoder"),
      "/opt/homebrew": { uid: 501 },
      "/opt/homebrew/bin/ollama": { uid: 501, link: "/opt/homebrew/Cellar/ollama/1.0/libexec/ollama" },
      "/opt/homebrew/Cellar/ollama/1.0/libexec/ollama": { uid: 501, data: macho(["/usr/lib/libc++.1.dylib"], ["@loader_path/../../../../opt/mlx-c/lib"]) }
    });
    const plan = planBinary(fs, "darwin", "ollama", "/opt/homebrew/bin/ollama", "/opt/edgecoder/libexec");
    expect(plan.path).toBe("/opt/edgecoder/libexec/ollama/ollama");
    expect(plan.copy).toMatchObject({ from: "/opt/homebrew/Cellar/ollama/1.0/libexec", to: "/opt/edgecoder/libexec/ollama" });
    // Copy the keg dir whole (runners live beside the binary); the copied binary is what gets checked.
    fs.copy = (from, to) => { copies.push([from, to]); };
    const real = memFs({ ...rootDirs("/", "/opt", "/opt/edgecoder", "/opt/edgecoder/libexec", "/opt/edgecoder/libexec/ollama"), "/opt/edgecoder/libexec/ollama/ollama": { data: macho(["/usr/lib/libc++.1.dylib"], ["@loader_path/../../../../opt/mlx-c/lib"]) } });
    expect(stageBinary({ ...real.fs, copy: fs.copy, secure: fs.secure }, "darwin", plan, "/opt/edgecoder/libexec")).toEqual([]);
    expect(copies).toEqual([["/opt/homebrew/Cellar/ollama/1.0/libexec", "/opt/edgecoder/libexec/ollama"]]);
    expect(secured).toEqual(["/opt/edgecoder/libexec/ollama"]);
  });

  it("copies a Linux prefix install's binary and lib/ollama", () => {
    const { fs } = memFs({ ...rootDirs("/", "/home"), "/home/u": { uid: 1000 }, "/home/u/ollama/bin/ollama": { uid: 1000, data: Buffer.from("\x7fELF") }, "/home/u/ollama/lib/ollama": { uid: 1000, isDirectory: true } });
    const plan = planBinary(fs, "linux", "ollama", "/home/u/ollama/bin/ollama", "/opt/edgecoder/libexec");
    expect(plan.path).toBe("/opt/edgecoder/libexec/ollama/bin/ollama");
    expect(plan.copy?.extra).toEqual([{ from: "/home/u/ollama/lib/ollama", to: "/opt/edgecoder/libexec/ollama/lib/ollama" }]);
  });

  it("refuses a copy that still links user-writable libraries (Homebrew node)", () => {
    const brewNode = macho(["/opt/homebrew/opt/libuv/lib/libuv.1.dylib"]);
    const { fs } = memFs({ ...rootDirs("/", "/opt", "/opt/edgecoder"), "/opt/homebrew": { uid: 501 }, "/opt/homebrew/bin/node": { uid: 501, data: brewNode } });
    const plan = planBinary(fs, "darwin", "node", "/opt/homebrew/bin/node", "/opt/edgecoder/libexec");
    expect(plan.path).toBe("/opt/edgecoder/libexec/node/bin/node");
    const problems = stageBinary(fs, "darwin", plan, "/opt/edgecoder/libexec");
    expect(problems.join("\n")).toMatch(/libuv/);
    expect(problems.join("\n")).toMatch(/official Node\.js build/);
  });

  it("flags a user-writable app dir", () => {
    const { fs } = memFs({ ...rootDirs("/", "/opt", "/opt/edgecoder", "/opt/edgecoder/app"), "/opt/edgecoder/app/dist": { uid: 501 }, "/opt/edgecoder/app/dist/swarm/worker-runner.js": { data: Buffer.from("") } });
    expect(appDirProblems(fs, "/opt/edgecoder/app")[0]).toMatch(/dist is owned by uid 501/);
  });

  it("secureBinaries points the services at the staged copies and skips Windows", () => {
    const { fs } = memFs({ ...rootDirs("/", "/usr", "/usr/bin", "/opt", "/opt/edgecoder", "/opt/edgecoder/app"), "/usr/bin/node": { data: Buffer.from("\x7fELF") }, "/home/u/.nvm/node": { uid: 1000, data: Buffer.from("\x7fELF") }, "/home": {}, "/home/u": { uid: 1000 } });
    const p = defaultPaths("linux", { nodeBin: "/home/u/.nvm/node", ollamaBin: "/usr/bin/node", appDir: "/opt/edgecoder/app" });
    const r = secureBinaries(fs, "linux", p, { dryRun: true, ollama: true });
    expect(p.nodeBin).toBe("/opt/edgecoder/libexec/node/bin/node");
    expect(r.plans[0].copy?.from).toBe("/home/u/.nvm/node");
    expect(r.problems).toEqual([]);
    const w = defaultPaths("win32", { nodeBin: "C:\\node.exe" });
    expect(secureBinaries(fs, "win32", w, { dryRun: false, ollama: true })).toEqual({ plans: [], problems: [] });
  });
});
