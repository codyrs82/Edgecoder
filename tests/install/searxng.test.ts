import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInstallArgs } from "../../src/install/options.js";
import { defaultPaths, type Host } from "../../src/install/services.js";
import {
  applySearxng,
  existingSecret,
  removeSearxng,
  SEARXNG_COMMIT,
  SEARXNG_ENGINES,
  SEARXNG_INSTALLER_DIR,
  SEARXNG_TARBALL_SHA256,
  SEARXNG_UNIT_PATH,
  SEARXNG_URL,
  searxngAgentEnv,
  searxngSettings,
  searxngSetting,
  searxngWanted,
  systemdSearxngUnit,
} from "../../src/install/searxng.js";
import { SEARXNG_INSTALL_SCRIPT, SEARXNG_REQUIREMENTS_LOCK } from "../../src/install/searxng-assets.js";
// @ts-expect-error: a plain .mjs generator without types
import { render } from "../../scripts/linux/searxng/gen-assets.mjs";

/* Local web search on Linux hosts (src/install/searxng.ts): settings, unit, apply, opt-out. */

function fakeHost(platform: NodeJS.Platform, files: Record<string, string> = {}, scriptCode = 0): Host & { files: Record<string, string>; cmds: string[]; modes: Record<string, number | undefined> } {
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
      return { code: cmd === "bash" ? scriptCode : 0, stdout: "", stderr: "" };
    },
    exists: (path: string) => path in files,
  };
  return h;
}
const p = () => defaultPaths("linux", { appDir: "/usr/lib/edgecoder/app" });
const SECRET = "ab".repeat(32);
const read = (files: Record<string, string>) => (path: string) => files[path];

describe("settings.yml", () => {
  const s = searxngSettings(SECRET);
  it("binds to 127.0.0.1, turns JSON on, keeps its own secret, no limiter or public instance", () => {
    expect(s).toContain('bind_address: "127.0.0.1"');
    expect(s).toMatch(/formats:\n\s+- html\n\s+- json/);
    expect(s).toContain(`secret_key: "${SECRET}"`);
    expect(s).not.toContain("ultrasecretkey");
    expect(s).toContain("limiter: false");
    expect(s).toContain("public_instance: false");
    expect(s).toContain("enable_metrics: false");
  });
  it("keeps only keyless engines and activates the ones upstream leaves inactive", () => {
    for (const e of SEARXNG_ENGINES) expect(s).toContain(`      - ${e}`);
    expect(s).toMatch(/- name: mojeek\n\s+inactive: false/);
    expect(s).not.toMatch(/api_key/);
  });
  it("refuses a weak secret; reads the existing one back", () => {
    expect(() => searxngSettings("short")).toThrow();
    expect(existingSecret(s)).toBe(SECRET);
    expect(existingSecret('secret_key: "ultrasecretkey"')).toBeUndefined();
  });
});

describe("edgecoder-searxng.service", () => {
  const u = systemdSearxngUnit(p());
  it("runs granian on 127.0.0.1 only, as a throwaway user, read-only system, settings as a credential", () => {
    expect(u).toContain("GRANIAN_HOST=127.0.0.1");
    expect(u).toContain("GRANIAN_PORT=18888");
    expect(u).not.toMatch(/0\.0\.0\.0|GRANIAN_HOST=::/);
    expect(u).toContain("DynamicUser=yes");
    expect(u).toContain("ProtectSystem=strict");
    expect(u).toContain("NoNewPrivileges=yes");
    expect(u).toContain("LoadCredential=settings.yml:/etc/edgecoder/searxng/settings.yml");
    expect(u).toContain('SEARXNG_SETTINGS_PATH="$CREDENTIALS_DIRECTORY/settings.yml"');
    expect(u).toContain("ExecStart=/bin/sh -c '");
    expect(u).toContain("/opt/edgecoder/searxng/venv/bin/granian searx.webapp:app");
    expect(u).not.toMatch(/^User=/m);
  });
});

describe("applySearxng", () => {
  it("Linux, default on: settings 0600, unit, installer script and lock, then the pinned install and a restart", () => {
    const h = fakeHost("linux");
    const r = applySearxng(h, p(), { dryRun: false, read: read(h.files), randomHex: () => SECRET });
    expect(r.ok).toBe(true);
    expect(h.modes["/etc/edgecoder/searxng/settings.yml"]).toBe(0o600);
    expect(h.files["/etc/edgecoder/searxng/settings.yml"]).toContain(SECRET);
    expect(h.files[SEARXNG_UNIT_PATH]).toContain("DynamicUser=yes");
    expect(h.files[`${SEARXNG_INSTALLER_DIR}/install-searxng.sh`]).toBe(SEARXNG_INSTALL_SCRIPT);
    expect(h.files[`${SEARXNG_INSTALLER_DIR}/requirements.lock`]).toBe(SEARXNG_REQUIREMENTS_LOCK);
    expect(h.cmds).toEqual([
      `bash ${SEARXNG_INSTALLER_DIR}/install-searxng.sh --commit ${SEARXNG_COMMIT} --sha256 ${SEARXNG_TARBALL_SHA256} --lock ${SEARXNG_INSTALLER_DIR}/requirements.lock`,
      "systemctl daemon-reload",
      "systemctl enable edgecoder-searxng.service",
      "systemctl restart edgecoder-searxng.service",
    ]);
    expect(r.summary).toMatch(/on \(SearXNG on http:\/\/127\.0\.0\.1:18888/);
  });

  it("keeps the secret across runs", () => {
    const h = fakeHost("linux", { "/etc/edgecoder/searxng/settings.yml": searxngSettings(SECRET) });
    applySearxng(h, p(), { dryRun: false, read: read(h.files), randomHex: () => "cd".repeat(32) });
    expect(existingSecret(h.files["/etc/edgecoder/searxng/settings.yml"])).toBe(SECRET);
  });

  it("a failed install is not an apply failure: the service stays off and the summary says so", () => {
    const h = fakeHost("linux", {}, 1);
    const r = applySearxng(h, p(), { dryRun: false, read: read(h.files), randomHex: () => SECRET });
    expect(r.ok).toBe(false);
    expect(h.cmds.at(-1)).toBe("systemctl disable --now edgecoder-searxng.service");
    expect(r.summary).toMatch(/not installed this time/);
  });

  it("--searxng off is written to searxng.env, stops and removes the unit; later runs keep it off", () => {
    const h = fakeHost("linux", { [SEARXNG_UNIT_PATH]: "x" });
    const r = applySearxng(h, p(), { flag: false, dryRun: false, read: read(h.files), randomHex: () => SECRET });
    expect(h.files["/etc/edgecoder/searxng.env"]).toContain("EDGECODER_SEARXNG=off");
    expect(h.files[SEARXNG_UNIT_PATH]).toBeUndefined();
    expect(h.cmds).toContain("systemctl disable --now edgecoder-searxng.service");
    expect(h.cmds.some((c) => c.startsWith("bash"))).toBe(false);
    expect(r.summary).toMatch(/off/);
    // An update's apply (no flag) reads the file.
    expect(searxngSetting(read(h.files), "/etc/edgecoder").enabled).toBe(false);
    expect(searxngWanted("linux", undefined, read(h.files), "/etc/edgecoder")).toBe(false);
    const again = fakeHost("linux", { ...h.files });
    applySearxng(again, p(), { dryRun: false, read: read(again.files), randomHex: () => SECRET });
    expect(again.cmds.some((c) => c.startsWith("bash"))).toBe(false);
  });

  it("dry run writes and runs nothing", () => {
    const h = fakeHost("linux");
    const r = applySearxng(h, p(), { dryRun: true, read: read(h.files), randomHex: () => SECRET });
    expect(Object.keys(h.files)).toEqual([]);
    expect(h.cmds).toEqual([]);
    expect(r.commands[0]).toMatch(/^bash .*install-searxng\.sh/);
  });

  it("macOS and Windows: nothing yet", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const h = fakeHost(platform);
      const r = applySearxng(h, defaultPaths(platform), { dryRun: false, read: read(h.files), randomHex: () => SECRET });
      expect(h.cmds).toEqual([]);
      expect(r.summary).toMatch(/not on this platform/);
      expect(searxngWanted(platform, true, read(h.files), "/etc/edgecoder")).toBe(false);
    }
  });

  it("the agents get SEARXNG_URL only while it's on; remove takes the unit away", () => {
    expect(searxngAgentEnv(true)).toEqual({ SEARXNG_URL });
    expect(searxngAgentEnv(false)).toEqual({});
    const h = fakeHost("linux", { [SEARXNG_UNIT_PATH]: "x" });
    expect(removeSearxng(h)).toEqual(["edgecoder-searxng.service"]);
    expect(removeSearxng(fakeHost("linux"))).toEqual([]);
  });
});

describe("flags", () => {
  it("--searxng on|off and --no-searxng", () => {
    expect(parseInstallArgs(["apply", "--searxng", "off"]).searxng).toBe(false);
    expect(parseInstallArgs(["apply", "--searxng", "on"]).searxng).toBe(true);
    expect(parseInstallArgs(["apply", "--no-searxng"]).searxng).toBe(false);
    expect(parseInstallArgs(["apply"]).searxng).toBeUndefined();
    expect(() => parseInstallArgs(["apply", "--searxng", "maybe"])).toThrow(/on or off/);
  });
});

describe("the pinned installer", () => {
  it("searxng-assets.ts is generated from the script and the lock (node scripts/linux/searxng/gen-assets.mjs)", () => {
    expect(readFileSync(new URL("../../src/install/searxng-assets.ts", import.meta.url), "utf8")).toBe(render());
  });

  it("pins every dependency by hash; the script verifies the archive and installs wheels only", () => {
    const pins = SEARXNG_REQUIREMENTS_LOCK.split("\n").filter((l) => /^[a-z0-9_.-]+==/i.test(l));
    expect(pins.length).toBeGreaterThan(20);
    expect(pins.every((l) => l.trimEnd().endsWith("\\"))).toBe(true);
    expect(SEARXNG_REQUIREMENTS_LOCK).toMatch(/^granian==2\.8\.5 /m);
    expect(SEARXNG_INSTALL_SCRIPT).toContain("sha256sum -c");
    expect(SEARXNG_INSTALL_SCRIPT).toContain("--require-hashes --only-binary=:all:");
    expect(SEARXNG_INSTALL_SCRIPT).toContain("--proto '=https'");
    expect(SEARXNG_INSTALL_SCRIPT).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
    expect(SEARXNG_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(SEARXNG_TARBALL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the script parses", () => {
    const r = spawnSync("bash", ["-n"], { input: SEARXNG_INSTALL_SCRIPT, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
});
