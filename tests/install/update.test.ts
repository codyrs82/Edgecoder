import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs release tooling, no type declarations
import { keygen, signMinisign } from "../../scripts/release/minisign.mjs";
import { nonRootWritable, type BinFs } from "../../src/install/binaries.js";
import { HttpStatusError, MAX_TARBALL_BYTES, MIN_SCHEDULED_GAP_MS, compareVersions, rateLimitRetryAt, parseReleaseInfo, parseVersion, pickLatestTag, releaseTarget, runUpdate, updateStatusLines, waitForIdle, type AgentStatus, type UpdateDeps } from "../../src/install/update.js";
import { parseAgentStatus } from "../../src/install/update-host.js";

describe("versions", () => {
  it("parses release tags and versions only", () => {
    expect(parseVersion("agent-v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.10.0")).toEqual([1, 10, 0]);
    expect(parseVersion("1.2.3-rc.1")).toBeNull();
    expect(parseVersion("v1.2")).toBeNull();
    expect(parseVersion("1.2.3; rm -rf /")).toBeNull();
  });
  it("compares numerically", () => {
    expect(compareVersions("agent-v1.10.0", "agent-v1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "agent-v1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.3.0")).toBeLessThan(0);
  });
  it("picks the newest published, non-prerelease agent tag", () => {
    const listing = [
      { tag_name: "v2.0.0" },
      { tag_name: "agent-v1.9.0" },
      { tag_name: "agent-v1.10.0" },
      { tag_name: "agent-v2.0.0-rc.1", prerelease: true },
      { tag_name: "agent-v3.0.0", draft: true },
      { tag_name: "agent-v4.0.0", prerelease: true },
      null
    ];
    expect(pickLatestTag(listing)).toBe("agent-v1.10.0");
    expect(pickLatestTag({})).toBeNull();
  });
  it("allows agent tarballs up to 2 GiB (not a 32-bit shift that overflows negative)", () => {
    expect(MAX_TARBALL_BYTES).toBe(2147483648);
  });

  it("maps platforms to release targets", () => {
    expect(releaseTarget("linux", "x64")).toBe("linux-x64");
    expect(releaseTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(releaseTarget("win32", "arm64")).toBeNull();
    expect(releaseTarget("freebsd", "x64")).toBeNull();
  });
  it("reads edgecoder-release.json strictly", () => {
    expect(parseReleaseInfo('{"tag":"agent-v1.2.0","target":"linux-x64"}')).toEqual({ tag: "agent-v1.2.0", target: "linux-x64" });
    expect(parseReleaseInfo('{"tag":"../x","target":"linux-x64"}')).toBeNull();
    expect(parseReleaseInfo(undefined)).toBeNull();
  });
  it("never loops on a path it cannot climb (a Windows or relative path)", () => {
    expect(nonRootWritable(rootFs, "C:\\a\\opt")).toMatch(/not an absolute POSIX path/);
    expect(nonRootWritable(rootFs, "relative/dir")).toMatch(/not an absolute POSIX path/);
    expect(nonRootWritable(rootFs, "/opt/edgecoder")).toBeNull();
  });
  it("parses agent-status.json defensively", () => {
    expect(parseAgentStatus('{"pid":1,"startedAtMs":1,"updatedAtMs":2,"busy":0,"registered":true,"drainSignal":"SIGUSR2"}')?.registered).toBe(true);
    expect(parseAgentStatus('{"pid":"x"}')).toBeNull();
    expect(parseAgentStatus("not json")).toBeNull();
  });
});

// ───────────────────────────── a fake host around a real temp dir ─────────────────────────────
const OLD = "agent-v1.2.0";
const NEW = "agent-v1.3.0";
const TARGET = "linux-x64";
const API = "https://api.example/releases";
const BASE = "https://dl.example/download";

let key: { publicKey: string; secretKeyPem: string };
let other: { publicKey: string; secretKeyPem: string };
beforeAll(() => {
  key = keygen();
  other = keygen();
});

interface World {
  root: string;
  appDir: string;
  configDir: string;
  urls: Map<string, Buffer>;
  now: number;
  active: Map<number, boolean>;
  status: Map<number, AgentStatus>;
  calls: string[][];
  /** What the new version's apply does to the agents: restart and register, or not. */
  applyBehaviour: "healthy" | "crash" | "no-register" | "fail";
  planIds: string[];
  busyUntil: number;
  logs: string[];
}

function makeApp(dir: string, tag: string) {
  mkdirSync(join(dir, "dist", "install"), { recursive: true });
  writeFileSync(join(dir, "dist", "install", "cli.js"), `// ${tag}\n`);
  writeFileSync(join(dir, "edgecoder-release.json"), JSON.stringify({ tag, target: TARGET, commit: "c", node: "22" }) + "\n");
}

/** Publish `tag` at BASE, signed by `signer`, optionally tampered. */
function publish(w: World, tag: string, opts: { signer?: typeof key; tamper?: boolean; wrongTagInside?: boolean } = {}) {
  const src = join(w.root, `src-${tag}-${Math.random().toString(36).slice(2)}`);
  makeApp(join(src, "edgecoder"), opts.wrongTagInside ? "agent-v0.0.1" : tag);
  const asset = `edgecoder-agent-${tag}-${TARGET}.tar.gz`;
  const tarPath = join(w.root, asset);
  expect(spawnSync("tar", ["-czf", tarPath, "-C", src, "edgecoder"]).status).toBe(0);
  const tarball = readFileSync(tarPath);
  const sums = `${createHash("sha256").update(tarball).digest("hex")}  ${asset}\n`;
  w.urls.set(`${BASE}/${tag}/${asset}`, opts.tamper ? Buffer.concat([tarball, Buffer.from("x")]) : tarball);
  w.urls.set(`${BASE}/${tag}/SHA256SUMS`, Buffer.from(sums));
  w.urls.set(`${BASE}/${tag}/SHA256SUMS.minisig`, Buffer.from(signMinisign(Buffer.from(sums), (opts.signer ?? key).secretKeyPem, `tag:${tag} file:SHA256SUMS`)));
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "ec-update-"));
  const w: World = {
    root,
    appDir: join(root, "opt", "edgecoder", "app"),
    configDir: join(root, "etc"),
    urls: new Map(),
    now: 1_000_000,
    active: new Map([[0, true], [1, true]]),
    status: new Map(),
    calls: [],
    applyBehaviour: "healthy",
    planIds: ["0:host-gpu0", "1:host-gpu1"],
    busyUntil: 0,
    logs: []
  };
  makeApp(w.appDir, OLD);
  mkdirSync(w.configDir, { recursive: true });
  writeFileSync(join(w.configDir, "agent-0.env"), "AGENT_ID=host-gpu0\n");
  writeFileSync(join(w.configDir, "agent-1.env"), "AGENT_ID=host-gpu1\n");
  for (const n of [0, 1]) w.status.set(n, { pid: 100 + n, version: "1.2.0", startedAtMs: 0, updatedAtMs: w.now, registered: true, draining: false, busy: 0, drainSignal: "SIGUSR2" });
  w.urls.set(API, Buffer.from(JSON.stringify([{ tag_name: OLD }, { tag_name: NEW }])));
  return w;
}

const rootFs: BinFs = {
  stat: () => ({ uid: 0, mode: 0o40755, isDirectory: true }),
  realpath: (p) => p,
  read: () => Buffer.alloc(0),
  copy: () => undefined,
  secure: () => undefined
};

function deps(w: World, over: Partial<UpdateDeps> = {}): UpdateDeps {
  const get = (url: string) => {
    const b = w.urls.get(url);
    if (!b) throw new Error(`HTTP 404 ${url}`);
    return b;
  };
  const restart = (version: string, registers: boolean) => {
    for (const n of [0, 1]) {
      w.active.set(n, true);
      w.status.set(n, { pid: 200 + n, version, startedAtMs: w.now + 1, updatedAtMs: w.now + 1, registered: registers, draining: false, busy: 0, drainSignal: "SIGUSR2" });
    }
  };
  return {
    platform: "linux",
    arch: "x64",
    now: () => w.now,
    sleep: async (ms) => {
      w.now += ms;
    },
    log: (l) => w.logs.push(l),
    // Size limits enforced like update-host.ts does, so a broken limit fails here too.
    fetchBytes: async (url, maxBytes) => {
      const b = get(url);
      if (!(maxBytes > 0) || b.length > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`);
      return b;
    },
    fetchToFile: async (url, dest, maxBytes) => {
      const b = get(url);
      if (!(maxBytes > 0) || b.length > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`);
      writeFileSync(dest, b, { flag: "wx", mode: 0o600 });
    },
    run(cmd, args) {
      w.calls.push([cmd, ...args]);
      if (cmd === "tar" || cmd === "mkdir") {
        const r = spawnSync(cmd, args, { encoding: "utf8" });
        return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      }
      if (cmd === "systemctl" && args[0] === "is-active") {
        const n = Number(/edgecoder-agent-(\d+)/.exec(args[1])?.[1]);
        return { code: 0, stdout: w.active.get(n) ? "active\n" : "failed\n", stderr: "" };
      }
      if (cmd === "systemctl" && args[0] === "kill") return { code: 0, stdout: "", stderr: "" };
      if (cmd === process.execPath && args[1] === "plan") {
        return { code: 0, stdout: JSON.stringify({ plan: { instances: w.planIds.map((id) => ({ index: Number(id.split(":")[0]), agentId: id.split(":")[1] })) } }), stderr: "" };
      }
      if (cmd === process.execPath && args[1] === "apply") {
        const version = readFileSync(join(w.appDir, "dist", "install", "cli.js"), "utf8").includes(NEW) ? "1.3.0" : "1.2.0";
        if (version === "1.3.0" && w.applyBehaviour === "fail") return { code: 1, stdout: "", stderr: "boom" };
        if (version === "1.3.0" && w.applyBehaviour === "crash") {
          w.active.set(1, false);
          return { code: 0, stdout: "", stderr: "" };
        }
        restart(version, version === "1.2.0" || w.applyBehaviour !== "no-register");
        return { code: 0, stdout: "Wrote 4 files\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeText: (path, text) => writeFileSync(path, text),
    exists: (p) => existsSync(p),
    listDir: (p) => readdirSync(p),
    rename: (a, b) => renameSync(a, b),
    removeTree: (p) => rmSync(p, { recursive: true, force: true }),
    makeTempDir: (prefix) => mkdtempSync(prefix),
    readAgentStatus(n) {
      const s = w.status.get(n);
      if (!s) return null;
      // A drained agent is busy until busyUntil, and keeps its file fresh.
      return { ...s, updatedAtMs: w.now, busy: w.now < w.busyUntil ? 1 : 0 };
    },
    binFs: rootFs,
    isRoot: true,
    ...over
  };
}

const opts = (o: Record<string, unknown> = {}) => ({ check: false, scheduled: false, pubkey: key.publicKey, apiUrl: API, baseUrl: BASE, ...o });
const paths = (w: World) => ({ appDir: w.appDir, configDir: w.configDir, nodeBin: process.execPath });
const installedTag = (w: World) => parseReleaseInfo(readFileSync(join(w.appDir, "edgecoder-release.json"), "utf8"))?.tag;
const state = (w: World) => JSON.parse(readFileSync(join(w.configDir, "update-state.json"), "utf8"));

// POSIX hosts only (the updater runs on Linux and macOS): real tar, /-paths, renames over dirs.
const posixOnly = process.platform === "win32";

describe.skipIf(posixOnly)("edgecoder-install update", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });
  afterEach(() => rmSync(w.root, { recursive: true, force: true }));

  it("verifies, drains, swaps, applies with --keep-config and keeps the previous version", async () => {
    publish(w, NEW);
    const out = await runUpdate(opts(), paths(w), deps(w));
    expect(out).toMatchObject({ result: "updated", code: 0, installedTag: NEW, latestTag: NEW });
    expect(installedTag(w)).toBe(NEW);
    expect(parseReleaseInfo(readFileSync(join(`${w.appDir}.prev`, "edgecoder-release.json"), "utf8"))?.tag).toBe(OLD);
    expect(state(w)).toMatchObject({ lastResult: "updated", installedTag: NEW, previousTag: OLD });
    // Drain signals before the swap, apply with --keep-config after.
    const kills = w.calls.filter((c) => c[0] === "systemctl" && c[1] === "kill");
    expect(kills.map((c) => c.at(-2))).toEqual(["--signal=SIGUSR2", "--signal=SIGUSR2"]);
    const apply = w.calls.find((c) => c[2] === "apply")!;
    expect(apply).toEqual([process.execPath, join(w.appDir, "dist", "install", "cli.js"), "apply", "--from-package", "--keep-config", "--app-dir", w.appDir, "--config-dir", w.configDir]);
    expect(w.logs.some((l) => /^verified edgecoder-agent-agent-v1\.3\.0-linux-x64\.tar\.gz: signed by release key, tag:agent-v1\.3\.0/.test(l))).toBe(true);
    expect(w.logs.at(-1)).toMatch(/^edgecoder-update: updated: updated agent-v1\.2\.0 -> agent-v1\.3\.0/);
    // The staging dir is gone.
    expect(readdirSync(join(w.root, "opt", "edgecoder")).filter((n) => n.startsWith(".edgecoder-update-"))).toEqual([]);
  });

  it("refuses a tampered tarball and a release signed by another key, changing nothing", async () => {
    publish(w, NEW, { tamper: true });
    let out = await runUpdate(opts(), paths(w), deps(w));
    expect(out).toMatchObject({ result: "failed", code: 1 });
    expect(out.message).toMatch(/CHECKSUM MISMATCH/);
    expect(installedTag(w)).toBe(OLD);
    publish(w, NEW, { signer: other });
    out = await runUpdate(opts(), paths(w), deps(w));
    expect(out.message).toMatch(/signed by a different key/);
    expect(installedTag(w)).toBe(OLD);
    expect(w.calls.some((c) => c[0] === "tar")).toBe(false);
    expect(w.calls.some((c) => c[1] === "kill")).toBe(false);
  });

  it("refuses a missing signature", async () => {
    publish(w, NEW);
    w.urls.delete(`${BASE}/${NEW}/SHA256SUMS.minisig`);
    const out = await runUpdate(opts(), paths(w), deps(w));
    expect(out).toMatchObject({ result: "failed" });
    expect(out.message).toMatch(/download of agent-v1\.3\.0 failed: HTTP 404/);
    expect(installedTag(w)).toBe(OLD);
  });

  it("refuses a signed tarball whose contents name another release", async () => {
    publish(w, NEW, { wrongTagInside: true });
    const out = await runUpdate(opts(), paths(w), deps(w));
    expect(out.message).toMatch(/is not a usable agent-v1\.3\.0 linux-x64 release/);
    expect(installedTag(w)).toBe(OLD);
  });

  it("never downgrades, and is up to date when equal", async () => {
    w.urls.set(API, Buffer.from(JSON.stringify([{ tag_name: "agent-v1.1.9" }])));
    let out = await runUpdate(opts(), paths(w), deps(w));
    expect(out).toMatchObject({ result: "up-to-date", code: 0 });
    expect(out.message).toMatch(/not downgrading/);
    w.urls.set(API, Buffer.from(JSON.stringify([{ tag_name: OLD }])));
    out = await runUpdate(opts(), paths(w), deps(w));
    expect(out.result).toBe("up-to-date");
    expect(installedTag(w)).toBe(OLD);
  });

  it("--check only reports", async () => {
    publish(w, NEW);
    const out = await runUpdate(opts({ check: true }), paths(w), deps(w));
    expect(out).toMatchObject({ result: "available", code: 0 });
    expect(installedTag(w)).toBe(OLD);
    expect(existsSync(join(w.configDir, "update-state.json"))).toBe(false);
  });

  it("rolls back when an agent does not come back, and the timer skips that release afterwards", async () => {
    publish(w, NEW);
    w.applyBehaviour = "crash";
    const out = await runUpdate(opts({ healthTimeoutMs: 60_000 }), paths(w), deps(w));
    expect(out).toMatchObject({ result: "rolled-back", code: 1 });
    expect(out.message).toMatch(/agent 1 is not running/);
    expect(installedTag(w)).toBe(OLD);
    expect(existsSync(`${w.appDir}.failed`)).toBe(false);
    expect(state(w)).toMatchObject({ lastResult: "rolled-back", failedTag: NEW });
    // The old version was re-applied.
    expect(w.calls.filter((c) => c[2] === "apply")).toHaveLength(2);
    w.now += 60 * 60_000; // the next hourly run
    const again = await runUpdate(opts({ scheduled: true }), paths(w), deps(w));
    expect(again).toMatchObject({ result: "skipped", code: 0 });
    expect(again.message).toMatch(/failed its health check here before/);
    // By hand it is tried again.
    w.applyBehaviour = "healthy";
    expect((await runUpdate(opts(), paths(w), deps(w))).result).toBe("updated");
    expect(state(w).failedTag).toBeUndefined();
  });

  it("rolls back when a registered agent does not register again, or apply fails", async () => {
    publish(w, NEW);
    w.applyBehaviour = "no-register";
    let out = await runUpdate(opts({ healthTimeoutMs: 30_000 }), paths(w), deps(w));
    expect(out.result).toBe("rolled-back");
    expect(out.message).toMatch(/has not registered/);
    w.applyBehaviour = "fail";
    out = await runUpdate(opts(), paths(w), deps(w));
    expect(out.result).toBe("rolled-back");
    expect(out.message).toMatch(/apply failed \(exit 1\): boom/);
    expect(installedTag(w)).toBe(OLD);
  });

  it("does not require registration from an agent that was not registered before", async () => {
    publish(w, NEW);
    for (const n of [0, 1]) w.status.set(n, { ...w.status.get(n)!, registered: false });
    w.applyBehaviour = "no-register";
    expect((await runUpdate(opts({ healthTimeoutMs: 30_000 }), paths(w), deps(w))).result).toBe("updated");
  });

  it("waits for running work, then skips until the next run when it does not finish", async () => {
    publish(w, NEW);
    w.busyUntil = w.now + 60 * 60_000;
    const out = await runUpdate(opts(), paths(w), deps(w));
    expect(out).toMatchObject({ result: "skipped-busy", code: 0 });
    expect(installedTag(w)).toBe(OLD);
    const sigs = w.calls.filter((c) => c[1] === "kill").map((c) => c.at(-2));
    expect(sigs).toEqual(["--signal=SIGUSR2", "--signal=SIGUSR2", "--signal=SIGHUP", "--signal=SIGHUP"]);
    expect(w.now - 1_000_000).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("restarts once running work finishes within the wait", async () => {
    publish(w, NEW);
    w.busyUntil = w.now + 3 * 60_000;
    expect((await runUpdate(opts(), paths(w), deps(w))).result).toBe("updated");
  });

  it("stops when the new version would plan different agents", async () => {
    publish(w, NEW);
    w.planIds = ["0:host-gpu0-1"];
    const out = await runUpdate(opts(), paths(w), deps(w));
    expect(out).toMatchObject({ result: "skipped", code: 1 });
    expect(out.message).toMatch(/would change this host's agents/);
    expect(installedTag(w)).toBe(OLD);
  });

  it("scheduled runs do nothing when automatic updates are off", async () => {
    publish(w, NEW);
    writeFileSync(join(w.configDir, "auto-update.env"), "EDGECODER_AUTO_UPDATE=off\n");
    const out = await runUpdate(opts({ scheduled: true }), paths(w), deps(w));
    expect(out).toMatchObject({ result: "disabled", code: 0 });
    expect(w.urls.size).toBeGreaterThan(0);
    expect(w.calls).toEqual([]);
    // By hand it still updates.
    expect((await runUpdate(opts(), paths(w), deps(w))).result).toBe("updated");
  });

  it("an up-to-date scheduled run never drains or restarts the agents", async () => {
    w.urls.set(API, Buffer.from(JSON.stringify([{ tag_name: OLD }])));
    const out = await runUpdate(opts({ scheduled: true }), paths(w), deps(w));
    expect(out).toMatchObject({ result: "up-to-date", code: 0 });
    expect(w.calls).toEqual([]);
  });

  it("scheduled runs within 5 minutes of the last check do nothing, and do not move it", async () => {
    w.urls.set(API, Buffer.from(JSON.stringify([{ tag_name: OLD }])));
    await runUpdate(opts({ scheduled: true }), paths(w), deps(w));
    const first = state(w).lastCheckAt;
    let fetches = 0;
    const counting = deps(w, { fetchBytes: async () => { fetches++; return Buffer.from("[]"); } });
    w.now += MIN_SCHEDULED_GAP_MS - 1;
    // An agent poking nonstop: no GitHub call, state untouched.
    for (let i = 0; i < 5; i++) expect((await runUpdate(opts({ scheduled: true }), paths(w), counting)).result).toBe("skipped");
    expect(fetches).toBe(0);
    expect(state(w).lastCheckAt).toBe(first);
    w.now += 1;
    publish(w, NEW);
    w.urls.set(API, Buffer.from(JSON.stringify([{ tag_name: OLD }, { tag_name: NEW }])));
    expect((await runUpdate(opts({ scheduled: true }), paths(w), deps(w))).result).toBe("updated");
  });

  it("a GitHub rate limit holds scheduled runs until its reset; by hand still checks", async () => {
    const limited = deps(w, { fetchBytes: async () => { throw new HttpStatusError("HTTP 403 from api.github.com/repos", 403, w.now + 40 * 60_000); } });
    const out = await runUpdate(opts({ scheduled: true }), paths(w), limited);
    expect(out).toMatchObject({ result: "failed", code: 1 });
    expect(out.message).toMatch(/rate-limited/);
    expect(Date.parse(state(w).rateLimitedUntil)).toBe(w.now + 40 * 60_000);
    let fetches = 0;
    const counting = deps(w, { fetchBytes: async () => { fetches++; throw new Error("unreachable"); } });
    w.now += 30 * 60_000;
    expect((await runUpdate(opts({ scheduled: true }), paths(w), counting)).result).toBe("skipped");
    expect(fetches).toBe(0);
    // A person can always check.
    publish(w, NEW);
    w.now += 1;
    expect((await runUpdate(opts(), paths(w), deps(w))).result).toBe("updated");
    expect(state(w).rateLimitedUntil).toBeUndefined();
  });

  it("works out when to retry after a rate limit, within bounds", () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    const now = 1_700_000_000_000;
    expect(rateLimitRetryAt(404, h({}), now)).toBeUndefined();
    expect(rateLimitRetryAt(403, h({}), now)).toBe(now + 3600_000);
    expect(rateLimitRetryAt(429, h({ "retry-after": "1800" }), now)).toBe(now + 1800_000);
    expect(rateLimitRetryAt(403, h({ "x-ratelimit-reset": String(now / 1000 + 2400) }), now)).toBe(now + 2400_000);
    // A reset in the past or seconds away: still at least 15 minutes; one days away: at most 6 hours.
    expect(rateLimitRetryAt(403, h({ "retry-after": "5" }), now)).toBe(now + 15 * 60_000);
    expect(rateLimitRetryAt(403, h({ "x-ratelimit-reset": String(now / 1000 + 86_400 * 3) }), now)).toBe(now + 6 * 3600_000);
  });

  it("refuses to stage under a directory a non-root user can write", async () => {
    publish(w, NEW);
    const out = await runUpdate(opts(), paths(w), deps(w, { binFs: { ...rootFs, stat: () => ({ uid: 1000, mode: 0o40755, isDirectory: true }) } }));
    expect(out.message).toMatch(/refusing to stage an update .* owned by uid 1000/);
  });

  it("needs root, a release install, and a supported platform", async () => {
    expect((await runUpdate(opts(), paths(w), deps(w, { isRoot: false }))).message).toMatch(/run as root/);
    expect((await runUpdate(opts(), paths(w), deps(w, { platform: "win32" }))).message).toMatch(/not supported on this platform/);
    rmSync(join(w.appDir, "edgecoder-release.json"));
    expect((await runUpdate(opts(), paths(w), deps(w))).message).toMatch(/not a signed release install/);
  });

  it("finishes a swap that stopped half way before anything else", async () => {
    renameSync(w.appDir, `${w.appDir}.prev`);
    w.urls.set(API, Buffer.from(JSON.stringify([{ tag_name: OLD }])));
    const out = await runUpdate(opts(), paths(w), deps(w));
    expect(out.result).toBe("up-to-date");
    expect(installedTag(w)).toBe(OLD);
  });
});

describe.skipIf(posixOnly)("idle gate", () => {
  it("does not signal an agent without a current status file (it would exit on SIGUSR2)", async () => {
    const w = world();
    try {
      w.status.delete(1);
      w.status.set(0, { ...w.status.get(0)!, drainSignal: undefined });
      const d = deps(w);
      expect(await waitForIdle(d, [0, 1], 60_000)).toBe(true);
      expect(w.calls.some((c) => c[1] === "kill")).toBe(false);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });
  it("treats a stopped agent as idle", async () => {
    const w = world();
    try {
      w.active.set(0, false);
      w.active.set(1, false);
      expect(await waitForIdle(deps(w), [0, 1], 60_000)).toBe(true);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });
});

describe("status lines", () => {
  it("shows version, auto-update and the last check", () => {
    const files: Record<string, string> = {
      "/app/edgecoder-release.json": '{"tag":"agent-v1.3.0","target":"linux-x64"}',
      "/etc/edgecoder/update-state.json": JSON.stringify({ lastCheckAt: "2026-11-17T12:00:00.000Z", lastResult: "rolled-back", message: "agent-v1.4.0 was unhealthy", failedTag: "agent-v1.4.0" })
    };
    const lines = updateStatusLines((p) => files[p], () => [], { appDir: "/app", configDir: "/etc/edgecoder" }, "edgecoder-update.timer active, next run Tue");
    expect(lines).toEqual([
      "version: 1.3.0 (agent-v1.3.0, linux-x64)",
      expect.stringMatching(/^auto-update: on \(default; .*\), edgecoder-update\.timer active, next run Tue$/),
      "last update check: 2026-11-17T12:00:00.000Z: rolled-back: agent-v1.4.0 was unhealthy",
      expect.stringMatching(/^skipped by the timer: agent-v1\.4\.0/)
    ]);
    files["/etc/edgecoder/auto-update.env"] = "EDGECODER_AUTO_UPDATE=off\n";
    expect(updateStatusLines((p) => files[p], () => ["auto-update.env"], { appDir: "/app", configDir: "/etc/edgecoder" }, null)[1]).toBe("auto-update: off (EDGECODER_AUTO_UPDATE=off in /etc/edgecoder/auto-update.env)");
  });
  it("says when the app is not a release install", () => {
    const lines = updateStatusLines(() => undefined, () => [], { appDir: "/usr/lib/edgecoder/app", configDir: "/etc/edgecoder" }, null);
    expect(lines[0]).toMatch(/not a signed release install/);
    expect(lines[1]).toBe("auto-update: n/a");
  });
});
