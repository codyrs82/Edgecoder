import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubDeviceLogins, parseDeviceCode, safeMessage } from "../../src/apps/ide/github-device.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake `gh` that prints a device code like gh does, then exits with `code` after `waitMs`. */
function fakeGh(lines: string, code: number, waitMs = 100): string {
  const p = join(dir, "gh");
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(lines)} >&2\nsleep ${waitMs / 1000}\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return p;
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("GitHub device sign-in", () => {
  it("reads gh's one-time code in both of its wordings, and keeps tokens out of messages", () => {
    expect(parseDeviceCode("! First copy your one-time code: 7642-9A80\nPress Enter to open github.com")).toBe("7642-9A80");
    expect(parseDeviceCode("! One-time code (ab12-cd34) copied to clipboard")).toBe("AB12-CD34");
    expect(parseDeviceCode("nothing here")).toBeNull();
    expect(safeMessage("error\nX failed with gho_abcdefABCDEF123456")).toBe("failed with [redacted]");
  });

  it("shows the code, then reports the signed-in login when gh finishes", async () => {
    const logins = new GitHubDeviceLogins({ gh: () => fakeGh("! One-time code (7642-9A80) copied to clipboard", 0, 300), status: async () => ({ ghInstalled: true, loggedIn: true, login: "octocat" }) });
    const l = await logins.start();
    expect(l).toMatchObject({ state: "waiting", code: "7642-9A80", url: "https://github.com/login/device" });
    // A second start while one waits returns the same sign-in.
    expect((await logins.start()).id).toBe(l.id);
    await until(() => logins.get(l.id)?.state === "done");
    expect(logins.get(l.id)).toMatchObject({ state: "done", login: "octocat" });
  });

  it("reports gh failing, a missing gh, and cancelling", async () => {
    const failing = new GitHubDeviceLogins({ gh: () => fakeGh("error connecting to github.com", 1, 0) });
    expect(await failing.start()).toMatchObject({ state: "error", message: expect.stringContaining("error connecting") });
    expect(await new GitHubDeviceLogins({ gh: () => null }).start()).toMatchObject({ state: "error", message: expect.stringContaining("isn't installed") });
    const slow = new GitHubDeviceLogins({ gh: () => fakeGh("! First copy your one-time code: AAAA-BBBB", 0, 5000) });
    const l = await slow.start();
    expect(slow.cancel(l.id)?.state).toBe("cancelled");
  });
});
