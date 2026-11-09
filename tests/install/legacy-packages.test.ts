/*
 * The legacy .pkg / .deb / .msi scripts (scripts/{macos,linux,windows}) run as root or SYSTEM.
 * Static checks for the PowerShell (no pwsh here) and behavioural checks for the shell helpers,
 * run with bash against temp files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const fn = (src: string, name: string) => {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[0];
};
const posix = process.platform !== "win32" && existsSync("/bin/bash");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const CONFIGURE = ["scripts/linux/payload/bin/edgecoder-configure.sh", "scripts/macos/payload/bin/edgecoder-configure.sh"];

describe("legacy configure scripts: tokens never become sed programs or shell code", () => {
  for (const file of CONFIGURE) {
    it.runIf(posix)(`${file}: write_or_update_env refuses unsafe values and never runs them`, () => {
      const src = read(file);
      expect(src).not.toMatch(/sed -i[^\n]*\$\{value\}/);
      expect(src).toMatch(/^umask 077$/m);
      const d = mkdtempSync(join(tmpdir(), "ec-cfg-"));
      dirs.push(d);
      const env = join(d, "edgecoder.env");
      const marker = join(d, "pwned");
      writeFileSync(env, "#AGENT_REGISTRATION_TOKEN=\nOTHER=1\n");
      const script = `${fn(src, "safe_env_value")}${fn(src, "write_or_update_env")}
write_or_update_env "$1" AGENT_REGISTRATION_TOKEN 'tok.EN_1+/='
write_or_update_env "$1" COORDINATOR_URL 'https://c.example:443'
( write_or_update_env "$1" AGENT_REGISTRATION_TOKEN "x|e touch $2" ) 2>/dev/null && echo accepted-pipe
( write_or_update_env "$1" AGENT_REGISTRATION_TOKEN "\\$(touch $2)" ) 2>/dev/null && echo accepted-subst
( write_or_update_env "$1" AGENT_REGISTRATION_TOKEN "$(printf 'a\\nNODE_OPTIONS=x')" ) 2>/dev/null && echo accepted-newline
true`;
      const out = execFileSync("/bin/bash", ["-c", script, "x", env, marker], { encoding: "utf8" });
      expect(out).toBe("");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(env, "utf8")).toBe("AGENT_REGISTRATION_TOKEN=tok.EN_1+/=\nOTHER=1\nCOORDINATOR_URL=https://c.example:443\n");
    });
  }
});

describe("legacy package scripts never run a user-replaceable node or ollama as root", () => {
  it.runIf(posix)("root_controlled accepts root-owned paths only", () => {
    const fmt = process.platform === "darwin" ? "scripts/macos/package-scripts/preinstall" : "scripts/linux/package-scripts/preinst";
    const d = mkdtempSync(join(tmpdir(), "ec-rc-"));
    dirs.push(d);
    writeFileSync(join(d, "node"), "#!/bin/sh\n");
    const script = `${fn(read(fmt), "root_controlled")}
root_controlled /bin/sh && echo sh-yes
root_controlled "$1/node" && echo tmp-yes
root_controlled /tmp && echo tmpdir-yes
true`;
    expect(execFileSync("/bin/bash", ["-c", script, "x", d], { encoding: "utf8" })).toBe("sh-yes\n");
  });

  it("the macOS .pkg scripts only run node and ollama that root alone can change", () => {
    const pre = read("scripts/macos/package-scripts/preinstall");
    const post = read("scripts/macos/package-scripts/postinstall");
    for (const s of [pre, post]) {
      expect(s).not.toContain("/opt/homebrew/bin/node");
      expect(s).not.toContain(".nvm");
      expect(s).toMatch(/root_controlled "\$candidate"/);
    }
    expect(post).not.toMatch(/command -v node/);
    const ollama = read("scripts/macos/payload/bin/edgecoder-install-ollama.sh");
    expect(ollama).toMatch(/sudo -u "\$SERVICE_USER"/);
    expect(ollama).not.toMatch(/^\s*"\$ollama_path" (serve|pull)/m);
    expect(read("scripts/macos/payload/opt/edgecoder/install/io.edgecoder.ollama.plist")).toContain("<string>/opt/edgecoder/ollama/ollama</string>");
  });

  it("the Linux .deb scripts check node and never serve ollama as root", () => {
    for (const f of ["scripts/linux/package-scripts/preinst", "scripts/linux/package-scripts/postinst"]) {
      expect(read(f)).toMatch(/root_controlled "\$candidate"/);
    }
    expect(read("scripts/linux/package-scripts/postinst")).not.toMatch(/^node /m);
    const ollama = read("scripts/linux/payload/bin/edgecoder-install-ollama.sh");
    expect(ollama).toMatch(/runuser -u ollama -- "\$ollama_path" serve/);
  });
});

describe("legacy Windows scripts (static: no PowerShell here)", () => {
  const runtime = read("scripts/windows/payload/bin/edgecoder-runtime.ps1");
  const configure = read("scripts/windows/payload/bin/edgecoder-configure.ps1");

  it("the runtime takes no NODE_BIN or loader variables from the env file and checks its owner", () => {
    expect(runtime).not.toMatch(/\$env:NODE_BIN/);
    expect(runtime).not.toMatch(/Get-Command node/);
    expect(runtime).toMatch(/\$DeniedKeys = @\('NODE_BIN', 'NODE_OPTIONS'/);
    expect(runtime).toMatch(/GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
    expect(runtime.indexOf("GetOwner")).toBeLessThan(runtime.indexOf("Get-Content -LiteralPath $EnvFile"));
  });

  it("configure locks the config dir before writing the token, opens no inbound port, and does not run as LocalSystem", () => {
    expect(configure).not.toContain("New-NetFirewallRule");
    expect(configure).not.toMatch(/\)\?\./); // PowerShell 7-only syntax; the script runs on 5.1
    expect(configure).toContain("O:BAG:SYD:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)");
    const quick = configure.slice(configure.indexOf("function Invoke-TokenQuickConnect"));
    expect(quick.indexOf("Protect-EnvDir")).toBeGreaterThan(0);
    expect(quick.indexOf("Protect-EnvDir")).toBeLessThan(quick.indexOf("Write-OrUpdateEnv"));
    expect(quick).toMatch(/\^\[A-Za-z0-9\._~\+\/=-\]\{1,1024\}\$/);
    expect(configure).toMatch(/obj= 'NT AUTHORITY\\LocalService'/);
    expect(configure).not.toMatch(/& node /);
    expect(read("scripts/windows/edgecoder.wxs")).not.toContain('Account="LocalSystem"');
  });
});
