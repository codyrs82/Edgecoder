import { afterEach, describe, expect, it } from "vitest";
import { inheritConfig, installArgsFromEnvFile, parseInstallArgs, renderInstallArgs } from "../../src/install/options.js";
import { planInstall } from "../../src/install/plan.js";
import { keptEnvLines } from "../../src/install/cli.js";
import type { HostHardware } from "../../src/install/hardware.js";
import { defaultPaths, type Host } from "../../src/install/services.js";
import { applyUpdateSchedule, autoUpdateSetting, launchdUpdatePlist, removeUpdateSchedule, systemdUpdatePath, systemdUpdateService, systemdUpdateTimer, updateRequestPaths } from "../../src/install/update-schedule.js";
import { startUpdateDrain, UPDATE_DRAIN_MS } from "../../src/swarm/update-drain.js";
import { releaseTagVersion } from "../../src/common/app-version.js";
import { agentUpdateAvailable, createLatestAgentVersion } from "../../src/portal/agent-release.js";
import { HttpStatusError } from "../../src/install/update.js";
import { agentUpdateHint, setLatestAgentReleaseSource } from "../../src/swarm/coordinator/agent-update-hint.js";
import { acceptableHint, createUpdateNudge, NUDGE_MAX_DELAY_MS, NUDGE_MIN_INTERVAL_MS } from "../../src/swarm/update-nudge.js";

function fakeHost(platform: NodeJS.Platform, files: Record<string, string> = {}): Host & { files: Record<string, string>; cmds: string[]; modes: Record<string, number | undefined> } {
  const h = {
    platform,
    files,
    cmds: [] as string[],
    modes: {} as Record<string, number | undefined>,
    writeFile(path: string, content: string, mode?: number) {
      files[path] = content;
      h.modes[path] = mode;
    },
    removeFile(path: string) {
      delete files[path];
      h.cmds.push(`rm ${path}`);
    },
    run(cmd: string, args: string[]) {
      h.cmds.push([cmd, ...args].join(" "));
      return { code: 0, stdout: "", stderr: "" };
    },
    exists: (path: string) => path in files
  };
  return h;
}

const linuxPaths = () => defaultPaths("linux", { appDir: "/opt/edgecoder/app", nodeBin: "/opt/edgecoder/node/bin/node" });
const macPaths = () => defaultPaths("darwin", { appDir: "/opt/edgecoder/app", nodeBin: "/opt/edgecoder/node/bin/node" });

describe("update schedule units", () => {
  it("Linux: a root oneshot and an hourly timer with a 10-minute random delay and catch-up", () => {
    const svc = systemdUpdateService(linuxPaths());
    expect(svc).toContain("Type=oneshot");
    expect(svc).toContain("ExecStart=/opt/edgecoder/node/bin/node /opt/edgecoder/app/dist/install/cli.js update --scheduled --config-dir /etc/edgecoder");
    expect(svc).not.toMatch(/^User=/m);
    expect(svc).toContain("TimeoutStartSec=45min");
    const timer = systemdUpdateTimer();
    expect(timer).toContain("OnCalendar=hourly");
    expect(timer).toContain("RandomizedDelaySec=10min");
    expect(timer).not.toContain("00/6");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=edgecoder-update.service");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("Linux: a path unit on each agent's update-request starts the same service", () => {
    const unit = systemdUpdatePath(updateRequestPaths(linuxPaths(), [1, 0, 1]));
    expect(unit).toContain("PathModified=/var/lib/edgecoder/agent-0/update-request\nPathModified=/var/lib/edgecoder/agent-1/update-request\n");
    expect(unit).toContain("Unit=edgecoder-update.service");
    expect(unit).toContain("WantedBy=paths.target");
    // Only a trigger: no command of its own, nothing read from the agent's directory.
    expect(unit).not.toMatch(/ExecStart|PathExists/);
  });

  it("macOS: a root LaunchDaemon every hour with up to 10 minutes of in-run jitter", () => {
    const plist = launchdUpdatePlist(macPaths());
    expect(plist).toContain("<string>io.edgecoder.update</string>");
    expect(plist).toContain("<key>StartInterval</key>\n    <integer>3600</integer>");
    expect(plist).toContain("<string>update</string>\n      <string>--scheduled</string>");
    expect(plist).toContain("<string>--jitter</string>\n      <string>600</string>");
    expect(plist).not.toContain("WatchPaths");
    const watched = launchdUpdatePlist(macPaths(), updateRequestPaths(macPaths(), [0, 2]));
    expect(watched).toContain("<key>WatchPaths</key>\n    <array>\n      <string>/var/lib/edgecoder/agent-0/update-request</string>\n      <string>/var/lib/edgecoder/agent-2/update-request</string>\n    </array>");
    expect(plist).not.toContain("<key>UserName</key>");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <false/>");
  });

  it("apply installs and enables the Linux timer on a release install", () => {
    const h = fakeHost("linux");
    const r = applyUpdateSchedule(h, linuxPaths(), { releaseInstall: true, dryRun: false, read: (p) => h.files[p], listDir: () => [] });
    expect(Object.keys(h.files).sort()).toEqual(["/etc/systemd/system/edgecoder-update.service", "/etc/systemd/system/edgecoder-update.timer"]);
    expect(h.cmds).toEqual(["systemctl daemon-reload", "systemctl enable --now edgecoder-update.timer"]);
    expect(r.summary).toMatch(/^Automatic updates: on, every hour/);
  });

  it("apply with agents also installs and (re)starts the nudge path unit; off disables it", () => {
    const h = fakeHost("linux");
    const read = (p: string) => h.files[p];
    applyUpdateSchedule(h, linuxPaths(), { releaseInstall: true, dryRun: false, read, listDir: () => [], instances: [0, 1] });
    expect(h.files["/etc/systemd/system/edgecoder-update.path"]).toContain("PathModified=/var/lib/edgecoder/agent-1/update-request");
    expect(h.cmds).toEqual(["systemctl daemon-reload", "systemctl enable --now edgecoder-update.timer", "systemctl enable edgecoder-update.path", "systemctl restart edgecoder-update.path"]);
    h.cmds.length = 0;
    applyUpdateSchedule(h, linuxPaths(), { flag: false, releaseInstall: true, dryRun: false, read, listDir: () => ["auto-update.env"], instances: [0, 1] });
    expect(h.cmds).toContain("systemctl disable --now edgecoder-update.timer");
    expect(h.cmds).toContain("systemctl disable --now edgecoder-update.path");
    expect(h.cmds.some((c) => c.includes("enable edgecoder-update.path") || c.includes("restart"))).toBe(false);
  });

  it("macOS: apply watches the agents' request files; off removes the job", () => {
    const h = fakeHost("darwin");
    const read = (p: string) => h.files[p];
    applyUpdateSchedule(h, macPaths(), { releaseInstall: true, dryRun: false, read, listDir: () => [], instances: [0] });
    expect(h.files["/Library/LaunchDaemons/io.edgecoder.update.plist"]).toContain("<string>/var/lib/edgecoder/agent-0/update-request</string>");
    applyUpdateSchedule(h, macPaths(), { flag: false, releaseInstall: true, dryRun: false, read, listDir: () => ["auto-update.env"], instances: [0] });
    expect(h.files["/Library/LaunchDaemons/io.edgecoder.update.plist"]).toBeUndefined();
    expect(h.cmds).toContain("launchctl bootout system /Library/LaunchDaemons/io.edgecoder.update.plist");
  });

  it("--auto-update off writes auto-update.env and disables the timer; a later apply keeps it", () => {
    const h = fakeHost("linux");
    const read = (p: string) => h.files[p];
    applyUpdateSchedule(h, linuxPaths(), { flag: false, releaseInstall: true, dryRun: false, read, listDir: () => ["auto-update.env"] });
    expect(h.files["/etc/edgecoder/auto-update.env"]).toContain("EDGECODER_AUTO_UPDATE=off");
    expect(h.cmds).toContain("systemctl disable --now edgecoder-update.timer");
    h.cmds.length = 0;
    const r = applyUpdateSchedule(h, linuxPaths(), { releaseInstall: true, dryRun: false, read, listDir: () => ["auto-update.env"] });
    expect(h.cmds).toContain("systemctl disable --now edgecoder-update.timer");
    expect(r.summary).toMatch(/^Automatic updates: off \(EDGECODER_AUTO_UPDATE=off/);
    applyUpdateSchedule(h, linuxPaths(), { flag: true, releaseInstall: true, dryRun: false, read, listDir: () => ["auto-update.env"] });
    expect(h.cmds.at(-1)).toBe("systemctl enable --now edgecoder-update.timer");
  });

  it("EDGECODER_AUTO_UPDATE=off in any /etc/edgecoder/*.env turns it off; default on", () => {
    const files: Record<string, string> = { "/etc/edgecoder/agent-0.env": "AGENT_ID=a\nEDGECODER_AUTO_UPDATE=off\n" };
    expect(autoUpdateSetting((p) => files[p], () => ["agent-0.env"], "/etc/edgecoder")).toMatchObject({ enabled: false });
    expect(autoUpdateSetting(() => undefined, () => [], "/etc/edgecoder").enabled).toBe(true);
    expect(autoUpdateSetting(() => "EDGECODER_AUTO_UPDATE=on\n", () => ["auto-update.env"], "/etc/edgecoder").enabled).toBe(true);
  });

  it("no schedule for a package or source install", () => {
    const h = fakeHost("linux");
    const r = applyUpdateSchedule(h, linuxPaths(), { releaseInstall: false, dryRun: false, read: () => undefined, listDir: () => [] });
    expect(h.files).toEqual({});
    expect(r.summary).toMatch(/not a signed release install/);
  });

  it("macOS: loads the plist, but never boots out the job an update runs in", () => {
    const h = fakeHost("darwin");
    applyUpdateSchedule(h, macPaths(), { releaseInstall: true, dryRun: false, read: (p) => h.files[p], listDir: () => [] });
    expect(h.files["/Library/LaunchDaemons/io.edgecoder.update.plist"]).toBeDefined();
    expect(h.modes["/Library/LaunchDaemons/io.edgecoder.update.plist"]).toBe(0o644);
    expect(h.cmds).toContain("launchctl bootstrap system /Library/LaunchDaemons/io.edgecoder.update.plist");
    h.cmds.length = 0;
    h.files["/Library/LaunchDaemons/io.edgecoder.update.plist"] = "older";
    applyUpdateSchedule(h, macPaths(), { releaseInstall: true, dryRun: false, insideUpdate: true, read: (p) => h.files[p], listDir: () => [] });
    expect(h.cmds.filter((c) => c.startsWith("launchctl"))).toEqual([]);
    expect(h.files["/Library/LaunchDaemons/io.edgecoder.update.plist"]).toContain("io.edgecoder.update");
  });

  it("Windows: not yet (no task, no files, no nudge watch)", () => {
    const h = fakeHost("win32");
    const r = applyUpdateSchedule(h, defaultPaths("win32"), { releaseInstall: true, dryRun: false, read: () => undefined, listDir: () => [], instances: [0] });
    expect(r.summary).toMatch(/not supported on Windows yet/);
    expect(h.files).toEqual({});
    expect(h.cmds).toEqual([]);
  });

  it("remove takes the schedule away", () => {
    const h = fakeHost("linux", { "/etc/systemd/system/edgecoder-update.timer": "x", "/etc/systemd/system/edgecoder-update.service": "y", "/etc/systemd/system/edgecoder-update.path": "z" });
    expect(removeUpdateSchedule(h)).toEqual(["edgecoder-update.timer", "edgecoder-update.path", "edgecoder-update.service"]);
    expect(h.files).toEqual({});
  });
});

// ───────────────────────────── --keep-config ─────────────────────────────
const hw: HostHardware = {
  hostname: "box",
  platform: "linux",
  arch: "x64",
  cpuCores: 32,
  cpuModel: "x",
  ramGb: 256,
  unifiedMemory: false,
  gpus: [0, 1, 2, 3].map((index) => ({ index, model: "NVIDIA RTX 6000 Ada", vramGb: 48, vendor: "nvidia" as const, datacenter: true }))
} as HostHardware;

describe("apply --keep-config (what update runs)", () => {
  it("records the plan flags and inherits them, the URLs and the mesh token", () => {
    const first = parseInstallArgs(["apply", "--layout", "single", "--model", "qwen3-coder:30b", "--coordinator-url", "https://c.example", "--mesh-token", "mesh_1", "--agent-id-prefix", "rig"]);
    const env0 = planInstall(hw, first, true).instances[0].env;
    expect(env0.EDGECODER_INSTALL_ARGS).toBe("model:qwen3-coder:30b,layout:single,agent-id-prefix:rig");
    const envText = Object.entries(env0).map(([k, v]) => `${k}=${v}`).join("\n");
    const again = inheritConfig(parseInstallArgs(["apply", "--from-package", "--keep-config"]), envText);
    expect(again).toMatchObject({ coordinatorUrl: "https://c.example", meshToken: "mesh_1", layout: "single", perGpu: false, model: "qwen3-coder:30b", agentIdPrefix: "rig" });
    const plan = planInstall(hw, again, true);
    expect(plan.instances.map((i) => i.agentId)).toEqual(["rig-gpu0-3"]);
    expect(plan.instances[0].env.MESH_AUTH_TOKEN).toBe("mesh_1");
    // A flag given now wins; without --keep-config nothing is inherited.
    expect(inheritConfig(parseInstallArgs(["apply", "--keep-config", "--layout", "per-gpu"]), envText).layout).toBe("per-gpu");
    expect(inheritConfig(parseInstallArgs(["apply"]), envText).meshToken).toBeUndefined();
  });

  it("drops tampered recorded values", () => {
    expect(installArgsFromEnvFile("EDGECODER_INSTALL_ARGS=layout:weird,instances:-1,ollama-bin:relative,model:ok:1\n")).toEqual({ model: "ok:1" });
    expect(renderInstallArgs(parseInstallArgs(["apply"]))).toBeUndefined();
  });

  it("keeps each instance's model, MAX_CONCURRENT_TASKS and the host controls", () => {
    const p = defaultPaths("linux", { appDir: "/opt/edgecoder/app" });
    const opts = parseInstallArgs(["apply", "--from-package", "--keep-config"]);
    const plan = planInstall(hw, opts, true);
    const files: Record<string, string> = {
      "/etc/edgecoder/agent-0.env": `AGENT_ID=${plan.instances[0].agentId}\nOLLAMA_MODEL=qwen3.5:9b\nMAX_CONCURRENT_TASKS=2\nAGENT_REMOTE_CONTROL=off\nAGENT_MODEL_ALLOWLIST=qwen3.5:9b,catalog\n`,
      "/etc/edgecoder/agent-1.env": "AGENT_ID=some-other-id\nAGENT_REMOTE_CONTROL=off\n"
    };
    keptEnvLines(opts, plan, p, (f) => files[f]);
    const after = planInstall(hw, opts, true);
    expect(after.instances[0].model).toBe("qwen3.5:9b");
    expect(after.instances[0].env).toMatchObject({ OLLAMA_MODEL: "qwen3.5:9b", MAX_CONCURRENT_TASKS: "2", AGENT_REMOTE_CONTROL: "off", AGENT_MODEL_ALLOWLIST: "qwen3.5:9b,catalog" });
    // Another agent id's file is not this instance's config.
    expect(after.instances[1].env.AGENT_REMOTE_CONTROL).toBeUndefined();
    // Without --keep-config only the host controls are kept.
    const plain = parseInstallArgs(["apply"]);
    keptEnvLines(plain, plan, p, (f) => files[f]);
    const plainPlan = planInstall(hw, plain, true);
    expect(plainPlan.instances[0].env.AGENT_REMOTE_CONTROL).toBe("off");
    expect(plainPlan.instances[0].env.MAX_CONCURRENT_TASKS).toBe("1");
  });
});

// ───────────────────────────── the agent side ─────────────────────────────
describe("agent update drain", () => {
  it("writes its status, drains on SIGUSR2 and resumes on SIGHUP", () => {
    const handlers: Record<string, () => void> = {};
    const writes: string[] = [];
    let draining = false;
    let drainMs = 0;
    const d = startUpdateDrain({
      home: "/var/lib/edgecoder/agent-0",
      version: "1.3.0",
      status: () => ({ registered: true, draining, busy: 2 }),
      startDrain: (ms) => {
        draining = true;
        drainMs = ms;
      },
      endDrain: () => {
        draining = false;
      },
      log: () => undefined,
      now: () => 5,
      on: (sig, fn) => {
        handlers[sig] = fn;
      },
      write: (path, text) => writes.push(`${path} ${text}`)
    });
    d.stop();
    expect(writes[0]).toMatch(/^\/var\/lib\/edgecoder\/agent-0\/agent-status\.json /);
    expect(JSON.parse(writes[0].split(" ").slice(1).join(" "))).toMatchObject({ v: 1, version: "1.3.0", registered: true, draining: false, busy: 2, drainSignal: "SIGUSR2", startedAtMs: 5 });
    handlers.SIGUSR2();
    expect(drainMs).toBe(UPDATE_DRAIN_MS);
    expect(JSON.parse(writes.at(-1)!.split(" ").slice(1).join(" ")).draining).toBe(true);
    handlers.SIGHUP();
    expect(draining).toBe(false);
  });

  it("reports the release tag as its version", () => {
    expect(releaseTagVersion('{"tag":"agent-v1.3.0","target":"linux-x64"}')).toBe("1.3.0");
    expect(releaseTagVersion('{"tag":"desktop-v2"}')).toBeUndefined();
    expect(releaseTagVersion(undefined)).toBeUndefined();
  });
});

describe("portal: update available", () => {
  it("compares release versions only", () => {
    expect(agentUpdateAvailable("1.2.0", "1.3.0")).toBe(true);
    expect(agentUpdateAvailable("1.3.0", "1.3.0")).toBe(false);
    expect(agentUpdateAvailable("1.4.0", "1.3.0")).toBe(false);
    expect(agentUpdateAvailable("unknown", "1.3.0")).toBe(false);
    expect(agentUpdateAvailable("1.2.0", null)).toBe(false);
  });
  it("caches the newest release and never waits for GitHub", async () => {
    let calls = 0;
    let now = 0;
    const latest = createLatestAgentVersion(async () => {
      calls++;
      return [{ tag_name: "agent-v1.3.0" }, { tag_name: "agent-v1.4.0", prerelease: true }];
    }, () => now);
    expect(latest()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(latest()).toBe("1.3.0");
    now += 30 * 60_000;
    expect(latest()).toBe("1.3.0");
    expect(calls).toBe(1);
    now += 31 * 60_000;
    latest();
    expect(calls).toBe(2);
  });
  it("backs off on a failure, and until GitHub's reset on a rate limit", async () => {
    let calls = 0;
    let now = 0;
    let fail: Error | null = null;
    const latest = createLatestAgentVersion(async () => {
      calls++;
      if (fail) throw fail;
      return [{ tag_name: "agent-v1.3.0" }];
    }, () => now, "https://api.example/releases", { okMs: 10 * 60_000, failMs: 10 * 60_000 });
    latest();
    await new Promise((r) => setTimeout(r, 0));
    expect(latest()).toBe("1.3.0");
    // 10-minute TTL (the coordinator's poll).
    now += 10 * 60_000;
    fail = new Error("network");
    expect(latest()).toBe("1.3.0");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    // A failure keeps the last known release and retries after the failure TTL, not sooner.
    now += 5 * 60_000;
    expect(latest()).toBe("1.3.0");
    expect(calls).toBe(2);
    now += 5 * 60_000;
    fail = new HttpStatusError("HTTP 403", 403, now + 45 * 60_000);
    latest();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(3);
    // Rate-limited: nothing before the reset, even though the failure TTL has passed.
    now += 30 * 60_000;
    latest();
    expect(calls).toBe(3);
    now += 16 * 60_000;
    fail = null;
    latest();
    expect(calls).toBe(4);
  });
});

describe("coordinator: update hint", () => {
  afterEach(() => setLatestAgentReleaseSource(undefined));
  it("names the newest release only to an agent reporting an older release version", () => {
    setLatestAgentReleaseSource(() => "1.3.0");
    expect(agentUpdateHint("1.2.9")).toEqual({ updateAvailable: "agent-v1.3.0" });
    expect(agentUpdateHint("1.3.0")).toEqual({});
    expect(agentUpdateHint("1.4.0")).toEqual({});
    expect(agentUpdateHint("unknown")).toEqual({});
    expect(agentUpdateHint(undefined)).toEqual({});
    setLatestAgentReleaseSource(() => null);
    expect(agentUpdateHint("1.2.9")).toEqual({});
  });
  it("makes no GitHub call under test (NODE_ENV=test)", () => {
    expect(agentUpdateHint("0.0.1")).toEqual({});
  });
});

describe("agent: update nudge", () => {
  const setup = (over: { enabled?: () => boolean; random?: number; installed?: string } = {}) => {
    const t = { now: 0, timers: [] as Array<{ fn: () => void; ms: number }>, writes: [] as Array<{ path: string; text: string }>, logs: [] as string[] };
    const nudge = createUpdateNudge({
      home: "/var/lib/edgecoder/agent-0",
      installedVersion: over.installed ?? "1.2.0",
      enabled: over.enabled ?? (() => true),
      log: (l) => t.logs.push(l),
      now: () => t.now,
      random: () => over.random ?? 0.5,
      setTimer: (fn, ms) => void t.timers.push({ fn, ms }),
      write: (path, text) => void t.writes.push({ path, text })
    });
    const fire = () => {
      const timers = t.timers.splice(0);
      for (const x of timers) {
        t.now += x.ms;
        x.fn();
      }
    };
    return { t, nudge, fire };
  };

  it("asks the updater once, after a random delay of up to 10 minutes, by writing update-request in its HOME", () => {
    const { t, nudge, fire } = setup({ random: 0.5 });
    nudge.onHint("agent-v1.3.0");
    nudge.onHint("agent-v1.3.0");
    expect(t.timers.map((x) => x.ms)).toEqual([NUDGE_MAX_DELAY_MS / 2]);
    expect(t.writes).toEqual([]);
    fire();
    expect(t.writes.map((w) => w.path)).toEqual(["/var/lib/edgecoder/agent-0/update-request"]);
    expect(JSON.parse(t.writes[0].text)).toMatchObject({ hint: "agent-v1.3.0", installed: "1.2.0" });
    const max = setup({ random: 0.999999 });
    max.nudge.onHint("agent-v1.3.0");
    expect(max.t.timers[0].ms).toBeLessThan(NUDGE_MAX_DELAY_MS);
    expect(max.t.timers[0].ms).toBeGreaterThanOrEqual(0);
  });

  it("at most once every 30 minutes, whatever the coordinator says", () => {
    const { t, nudge, fire } = setup({ random: 0 });
    nudge.onHint("agent-v1.3.0");
    fire();
    nudge.onHint("agent-v1.3.0");
    nudge.onHint("agent-v9.9.9");
    expect(t.timers).toEqual([]);
    t.now += NUDGE_MIN_INTERVAL_MS;
    nudge.onHint("agent-v1.3.0");
    fire();
    expect(t.writes).toHaveLength(2);
  });

  it("ignores hints that are not a newer plain release tag", () => {
    const { t, nudge } = setup({ installed: "1.3.0" });
    for (const hint of ["agent-v1.3.0", "agent-v1.2.9", "agent-v0.9.0", "1.4.0", "agent-v1.4.0-rc.1", "agent-v1.4.0; rm -rf /", "../../etc/passwd", 140, null, undefined, { tag: "agent-v2.0.0" }, "agent-v" + "9".repeat(40) + ".0.0"]) nudge.onHint(hint);
    expect(t.timers).toEqual([]);
    expect(acceptableHint("agent-v1.3.1", "1.3.0")).toBe("agent-v1.3.1");
    expect(acceptableHint("agent-v1.3.1", "unknown")).toBeNull();
  });

  it("does nothing with automatic updates off, also when turned off during the delay", () => {
    const off = setup({ enabled: () => false });
    off.nudge.onHint("agent-v1.3.0");
    expect(off.t.timers).toEqual([]);
    let on = true;
    const later = setup({ enabled: () => on });
    later.nudge.onHint("agent-v1.3.0");
    on = false;
    later.fire();
    expect(later.t.writes).toEqual([]);
  });

  it("a failed write is logged, not thrown", () => {
    const logs: string[] = [];
    let fn: () => void = () => undefined;
    const nudge = createUpdateNudge({ home: "/nonexistent", installedVersion: "1.2.0", enabled: () => true, log: (l) => logs.push(l), random: () => 0, setTimer: (f) => void (fn = f), write: () => { throw new Error("EACCES"); } });
    nudge.onHint("agent-v1.3.0");
    expect(() => fn()).not.toThrow();
    expect(logs.at(-1)).toMatch(/could not write update-request: EACCES/);
  });
});
