import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliStatus, dirOnPath, installCli, launcherContent, launcherPath } from "../../src/apps/ide/cli-install.js";

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
  // A POSIX launcher with 0755 permissions: Windows has no mode bits, so the "unchanged" re-run check differs there.
  it.skipIf(process.platform === "win32")("writes ~/.local/bin/edgecoder (0755) running the app's Node and dist/cli/edgecoder.js, and says whether it is on PATH", () => {
    const r = installCli({ platform: "darwin", home, env: { PATH: "/usr/bin:/bin" }, agentDir: agent });
    expect(r).toMatchObject({ ok: true, state: "installed", path: join(home, ".local", "bin", "edgecoder"), onPath: false });
    expect(r.message).toContain("is not on your PATH yet");
    const text = readFileSync(r.path, "utf8");
    expect(text).toBe(
      [
        "#!/bin/sh",
        "# EdgeCoder CLI launcher: runs the agent bundled inside the desktop app with the app's own Node.",
        // The shell-quoted path (a Windows temp dir has backslashes, escaped for sh).
        `APP="${agent.replace(/(["\\$`])/g, "\\$1")}"`,
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

  it("Windows: %LOCALAPPDATA%\\EdgeCoder\\bin\\edgecoder.cmd, and whether that folder is on Path", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", Path: "C:\\Windows;C:\\Users\\me\\AppData\\Local\\EdgeCoder\\bin\\" };
    expect(launcherPath("win32", "C:\\Users\\me", env)).toEqual({ dir: "C:\\Users\\me\\AppData\\Local\\EdgeCoder\\bin", file: "C:\\Users\\me\\AppData\\Local\\EdgeCoder\\bin\\edgecoder.cmd" });
    expect(dirOnPath("c:\\users\\me\\appdata\\local\\edgecoder\\bin", env, "win32")).toBe(true);
    expect(launcherContent("win32", "C:\\Program Files\\EdgeCoder\\resources\\agent")).toContain('"%APP%\\node\\node.exe" "%APP%\\dist\\cli\\edgecoder.js" %*');
  });

  it("no bundled agent: nothing written", () => {
    const r = installCli({ platform: "linux", home, env: {}, agentDir: join(home, "nope") });
    expect(r).toMatchObject({ ok: false, state: "no_agent" });
    expect(cliStatus({ platform: "linux", home, env: {} }).installed).toBe(false);
  });
});
