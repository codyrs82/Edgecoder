// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Signing in to GitHub from the app or the terminal: the GitHub CLI's device flow
 * (`gh auth login --web`), with the one-time code read from gh's output so the app can show it next
 * to an "Open github.com/login/device" button, and the sign-in polled until gh finishes.
 *
 * The token stays where gh keeps it (the system keychain); nothing here reads, stores or logs it.
 * Only the code, the device URL and the signed-in login leave this module.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { findGh, githubStatus, type GitHubStatus } from "./git-setup.js";

export const DEVICE_URL = "https://github.com/login/device";

export interface DeviceLogin {
  id: string;
  state: "starting" | "waiting" | "done" | "error" | "cancelled";
  /** The one-time code to enter at `url`. */
  code: string | null;
  url: string;
  login: string | null;
  message: string | null;
  startedAt: number;
}

/** gh's one-time code in its output ("First copy your one-time code: ABCD-1234", "One-time code (ABCD-1234) copied"). */
export function parseDeviceCode(output: string): string | null {
  return /one-time code[^A-Z0-9]*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1]?.toUpperCase() ?? null;
}

/** A line of gh's output safe to show: anything token-like is removed. */
export function safeMessage(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.replace(/\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]").replace(/^[!✓X]\s*/, "").slice(0, 300);
}

interface Deps {
  gh?: () => string | null;
  spawn?: typeof nodeSpawn;
  status?: () => Promise<GitHubStatus>;
  /** How long a sign-in may wait for the user (GitHub's codes last 15 minutes). */
  timeoutMs?: number;
}

export class GitHubDeviceLogins {
  private readonly logins = new Map<string, DeviceLogin & { child?: ChildProcess; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly deps: Deps = {}) {}

  /** Start a sign-in (or return the one already waiting); resolves once the code is known or it failed. */
  async start(): Promise<DeviceLogin> {
    for (const l of this.logins.values()) if (l.state === "waiting" || l.state === "starting") return this.view(l);
    const gh = (this.deps.gh ?? findGh)();
    const id = randomUUID();
    const login: DeviceLogin & { child?: ChildProcess; timer?: ReturnType<typeof setTimeout> } = {
      id, state: "starting", code: null, url: DEVICE_URL, login: null, message: null, startedAt: Date.now(),
    };
    this.logins.set(id, login);
    if (!gh) {
      login.state = "error";
      login.message = "The GitHub CLI isn't installed. Install it (brew install gh, or see cli.github.com), then try again.";
      return this.view(login);
    }
    const child = (this.deps.spawn ?? nodeSpawn)(gh, ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https", "--skip-ssh-key"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    });
    login.child = child;
    let output = "";
    let resolveCode: () => void = () => undefined;
    const codeKnown = new Promise<void>((r) => (resolveCode = r));
    const onData = (buf: Buffer) => {
      output = (output + buf.toString("utf8")).slice(-8000);
      const code = parseDeviceCode(output);
      if (code && !login.code) {
        login.code = code;
        login.state = "waiting";
        resolveCode();
      }
      // In a terminal gh waits for Enter before polling; answer it.
      if (/press enter/i.test(output)) child.stdin?.write("\n");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => undefined);
    child.stdin?.write("\n");
    child.on("error", (err) => {
      login.state = "error";
      login.message = `Couldn't run the GitHub CLI: ${err.message}`;
      resolveCode();
    });
    child.on("close", (code) => {
      if (login.timer) clearTimeout(login.timer);
      if (login.state === "cancelled") return resolveCode();
      if (code === 0) {
        void (this.deps.status ?? githubStatus)()
          .then((s) => {
            login.login = s.login;
            login.state = s.loggedIn ? "done" : "error";
            if (!s.loggedIn) login.message = "GitHub sign-in didn't complete.";
          })
          .catch(() => {
            login.state = "done";
          })
          .finally(resolveCode);
      } else {
        login.state = "error";
        login.message = safeMessage(output) || `gh exited with code ${code}`;
        resolveCode();
      }
    });
    login.timer = setTimeout(() => {
      if (login.state !== "waiting" && login.state !== "starting") return;
      login.state = "error";
      login.message = "The sign-in code expired. Start again.";
      child.kill();
    }, this.deps.timeoutMs ?? 15 * 60_000);
    // gh prints the code within a second; don't hang the request if it never does.
    await Promise.race([codeKnown, new Promise((r) => setTimeout(r, 20_000))]);
    if (login.state === "starting") {
      login.state = "error";
      login.message = safeMessage(output) || "The GitHub CLI didn't show a sign-in code.";
      child.kill();
    }
    return this.view(login);
  }

  get(id: string): DeviceLogin | null {
    const l = this.logins.get(id);
    return l ? this.view(l) : null;
  }

  cancel(id: string): DeviceLogin | null {
    const l = this.logins.get(id);
    if (!l) return null;
    if (l.state === "waiting" || l.state === "starting") {
      l.state = "cancelled";
      l.child?.kill();
      if (l.timer) clearTimeout(l.timer);
    }
    return this.view(l);
  }

  private view(l: DeviceLogin): DeviceLogin {
    return { id: l.id, state: l.state, code: l.code, url: l.url, login: l.login, message: l.message, startedAt: l.startedAt };
  }
}
