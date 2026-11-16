import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliStatus, installCli, launcherContent } from "../../src/apps/ide/cli-install.js";

let home: string;
let agent: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cli-home-"));
  agent = mkdtempSync(join(tmpdir(), "cli-agent-"));
  mkdirSync(join(agent, "node"));
  mkdirSync(join(agent, "dist", "cli"), { recursive: true });
  writeFileSync(join(agent, "node", "node"), "");
  writeFileSync(join(agent, "node", "node.exe"), "");
  writeFileSync(join(agent, "dist", "cli", "edgecoder.js"), "");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(agent, { recursive: true, force: true });
});

describe("Install command-line tool", () => {
  it("writes ~/.local/bin/edgecoder (0755) running the app's Node and dist/cli/edgecoder.js, and says whether it is on PATH", () => {
    const r = installCli({ platform: "darwin", home, env: { PATH: "/usr/bin:/bin" }, agentDir: agent });
    expect(r).toMatchObject({ ok: true, state: "installed", path: join(home, ".local", "bin", "edgecoder"), onPath: false });
    expect(r.message).toContain("is not on your PATH yet");
    const text = readFileSync(r.path, "utf8");
    expect(text).toBe(
      [
        "#!/bin/sh",
        "# EdgeCoder CLI launcher: runs the agent bundled inside the desktop app with the app's own Node.",
        `APP="${agent}"`,
        `[ -x "$APP/node/node" ] || { echo "EdgeCoder app not found at ${agent}" >&2; exit 1; }`,
        'exec "$APP/node/node" "$APP/dist/cli/edgecoder.js" "$@"',
        "",
      ].join("\n"),
    );
    if (process.platform !== "win32") expect(statSync(r.path).mode & 0o777).toBe(0o755);
    const again = installCli({ platform: "darwin", home, env: { PATH: `/usr/bin:${join(home, ".local", "bin")}` }, agentDir: agent });
    expect(again).toMatchObject({ ok: true, state: "unchanged", onPath: true });
    expect(again.message).toContain("is on your PATH");
  });

  it("the app in /Applications gives exactly the hand-made launcher, which is replaced (same shape), but another program is left alone", () => {
    const appAgent = "/Applications/EdgeCoder.app/Contents/Resources/agent";
    const handMade = `#!/bin/sh
# EdgeCoder CLI launcher: runs the agent bundled inside the desktop app with the app's own Node.
APP="/Applications/EdgeCoder.app/Contents/Resources/agent"
[ -x "$APP/node/node" ] || { echo "EdgeCoder app not found in /Applications" >&2; exit 1; }
exec "$APP/node/node" "$APP/dist/cli/edgecoder.js" "$@"
`;
    expect(launcherContent("darwin", appAgent)).toBe(handMade);
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "edgecoder"), handMade);
    expect(cliStatus({ platform: "darwin", home, env: {} })).toMatchObject({ installed: true, ours: true });
    expect(installCli({ platform: "darwin", home, env: {}, agentDir: agent })).toMatchObject({ ok: true, state: "updated" });
    writeFileSync(join(bin, "edgecoder"), "#!/bin/sh\necho something else\n");
    expect(installCli({ platform: "darwin", home, env: {}, agentDir: agent })).toMatchObject({ ok: false, state: "exists_other" });
    expect(readFileSync(join(bin, "edgecoder"), "utf8")).toBe("#!/bin/sh\necho something else\n");
  });

  it("Windows: %LOCALAPPDATA%\\EdgeCoder\\bin\\edgecoder.cmd", () => {
    const local = join(home, "AppData", "Local");
    const r = installCli({ platform: "win32", home, env: { LOCALAPPDATA: local, Path: "C:\\Windows" }, agentDir: agent });
    expect(r.ok).toBe(true);
    expect(r.path.endsWith("EdgeCoder\\bin\\edgecoder.cmd")).toBe(true);
    expect(r.onPath).toBe(false);
    expect(launcherContent("win32", "C:\\Program Files\\EdgeCoder\\resources\\agent")).toContain('"%APP%\\node\\node.exe" "%APP%\\dist\\cli\\edgecoder.js" %*');
  });

  it("no bundled agent: nothing written", () => {
    const r = installCli({ platform: "linux", home, env: {}, agentDir: join(home, "nope") });
    expect(r).toMatchObject({ ok: false, state: "no_agent" });
    expect(cliStatus({ platform: "linux", home, env: {} }).installed).toBe(false);
  });
});
