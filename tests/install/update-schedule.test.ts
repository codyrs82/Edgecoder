import { describe, expect, it } from "vitest";
import { inheritConfig, installArgsFromEnvFile, parseInstallArgs, renderInstallArgs } from "../../src/install/options.js";
import { planInstall } from "../../src/install/plan.js";
import { keptEnvLines } from "../../src/install/cli.js";
import type { HostHardware } from "../../src/install/hardware.js";
import { defaultPaths, type Host } from "../../src/install/services.js";
import { applyUpdateSchedule, autoUpdateSetting, launchdUpdatePlist, removeUpdateSchedule, systemdUpdateService, systemdUpdateTimer } from "../../src/install/update-schedule.js";
import { startUpdateDrain, UPDATE_DRAIN_MS } from "../../src/swarm/update-drain.js";
import { releaseTagVersion } from "../../src/common/app-version.js";
import { agentUpdateAvailable, createLatestAgentVersion } from "../../src/portal/agent-release.js";

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
  it("Linux: a root oneshot and a 6-hourly timer with a random delay and catch-up", () => {
    const svc = systemdUpdateService(linuxPaths());
    expect(svc).toContain("Type=oneshot");
    expect(svc).toContain("ExecStart=/opt/edgecoder/node/bin/node /opt/edgecoder/app/dist/install/cli.js update --scheduled --config-dir /etc/edgecoder");
    expect(svc).not.toMatch(/^User=/m);
    expect(svc).toContain("TimeoutStartSec=45min");
    const timer = systemdUpdateTimer();
    expect(timer).toContain("OnCalendar=00/6:00");
    expect(timer).toContain("RandomizedDelaySec=1h");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=edgecoder-update.service");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("macOS: a root LaunchDaemon every 6 hours with in-run jitter", () => {
    const plist = launchdUpdatePlist(macPaths());
    expect(plist).toContain("<string>io.edgecoder.update</string>");
    expect(plist).toContain("<key>StartInterval</key>\n    <integer>21600</integer>");
    expect(plist).toContain("<string>update</string>\n      <string>--scheduled</string>");
    expect(plist).toContain("<string>--jitter</string>\n      <string>3600</string>");
    expect(plist).not.toContain("<key>UserName</key>");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <false/>");
  });

  it("apply installs and enables the Linux timer on a release install", () => {
    const h = fakeHost("linux");
    const r = applyUpdateSchedule(h, linuxPaths(), { releaseInstall: true, dryRun: false, read: (p) => h.files[p], listDir: () => [] });
    expect(Object.keys(h.files).sort()).toEqual(["/etc/systemd/system/edgecoder-update.service", "/etc/systemd/system/edgecoder-update.timer"]);
    expect(h.cmds).toEqual(["systemctl daemon-reload", "systemctl enable --now edgecoder-update.timer"]);
    expect(r.summary).toMatch(/^Automatic updates: on, every 6 hours/);
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

  it("Windows: not yet", () => {
    const r = applyUpdateSchedule(fakeHost("win32"), defaultPaths("win32"), { releaseInstall: true, dryRun: false, read: () => undefined, listDir: () => [] });
    expect(r.summary).toMatch(/not supported on Windows yet/);
  });

  it("remove takes the schedule away", () => {
    const h = fakeHost("linux", { "/etc/systemd/system/edgecoder-update.timer": "x", "/etc/systemd/system/edgecoder-update.service": "y" });
    expect(removeUpdateSchedule(h)).toEqual(["edgecoder-update.timer", "edgecoder-update.service"]);
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
});
