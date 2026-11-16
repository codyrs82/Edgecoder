import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { portalAuthedPageHtml } from "../../src/portal/pages/layout.js";

/*
 * The portal's Create account button (pages/home.ts) and the shell's "Verify your email" banner
 * (pages/layout.ts), run in node against a minimal DOM: elements by id, listeners that can be
 * fired, and a scripted fetch.
 */

type Listener = (e: { preventDefault(): void; currentTarget: El }) => unknown;
class El {
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  innerHTML = "";
  textContent = "";
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  focused = false;
  private classes = new Set<string>();
  private listeners: Record<string, Listener[]> = {};
  constructor(readonly id: string, cls = "") {
    for (const c of cls.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classes.has(c);
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    }
  };
  setAttribute(k: string, v: unknown) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  focus() {
    this.focused = true;
  }
  async fire(type = "click") {
    const e = { preventDefault() {}, currentTarget: this };
    await Promise.all((this.listeners[type] ?? []).map((fn) => fn(e)));
  }
  click() {
    return this.fire("click");
  }
}

/** Element ids and their initial classes, read from the served HTML. */
function domFrom(html: string) {
  const els = new Map<string, El>();
  for (const m of html.matchAll(/<(\w+)([^>]*?)\sid="([^"]+)"([^>]*)>/g)) {
    const rest = `${m[2]} ${m[4]}`;
    const cls = /class="([^"]*)"/.exec(rest)?.[1] ?? "";
    const el = new El(m[3], cls);
    el.hidden = /\shidden(\s|\/|$)/.test(` ${rest.replace(/class="[^"]*"/, "")} `);
    if (/\sdisabled(\s|$)/.test(` ${rest} `)) el.disabled = true;
    els.set(m[3], el);
  }
  const document = {
    getElementById: (id: string) => els.get(id) ?? null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    hidden: false
  };
  return { els, document };
}

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

type Route = (body: Record<string, unknown>) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
function run(script: string, document: unknown, routes: Record<string, Route>, extra: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const location = { href: "/portal", hash: "", search: "", pathname: "/portal" };
  const store = new Map<string, string>();
  const sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const fetch = async (path: string, init: { body?: string } = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, body });
    const route = routes[path];
    const r = route ? await route(body) : { status: 404, body: { error: "not_found" } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  const window = { location, PublicKeyCredential: undefined };
  const timers = { setTimeout: (fn: () => void) => (fn, 0), clearTimeout: () => undefined, setInterval: () => 0 };
  const names = ["document", "window", "location", "sessionStorage", "fetch", "setTimeout", "clearTimeout", "setInterval", "history", "navigator", ...Object.keys(extra)];
  const values = [document, window, location, sessionStorage, fetch, timers.setTimeout, timers.clearTimeout, timers.setInterval, { replaceState() {} }, {}, ...Object.values(extra)];
  new Function(...names, script)(...values);
  return { calls, location, sessionStorage: store };
}

async function homePage() {
  const app = Fastify();
  registerPortalPages(app);
  const html = (await app.inject({ url: "/portal" })).body;
  await app.close();
  return html;
}

const tick = () => new Promise((r) => setImmediate(r));

async function signupPage(routes: Record<string, Route>) {
  const html = await homePage();
  const { els, document } = domFrom(html);
  const env = run(scriptsOf(html).at(-1)!, document, { "/me": () => ({ status: 401, body: { error: "not_authenticated" } }), ...routes });
  const el = (id: string) => els.get(id)!;
  el("signupEmail").value = "cody@proton.me";
  el("signupPassword").value = "correct-horse-1";
  el("signupAcceptTerms").checked = true;
  await el("signupAcceptTerms").fire("change");
  return { el, ...env };
}

describe("portal Create account", () => {
  it("signs in and opens Getting started for a new account", async () => {
    const { el, calls, location, sessionStorage } = await signupPage({
      "/auth/signup": () => ({ status: 200, body: { ok: true, userId: "u1", emailVerification: "sent" } }),
      "/portal/api/onboarding": () => ({ status: 200, body: { show: true, state: { current: "connect" } } })
    });
    await el("signupBtn").click();
    expect(calls.map((c) => c.path)).toContain("/auth/signup");
    expect(location.href).toBe("/portal/welcome/connect");
    expect(sessionStorage.get("edgecoder-welcome-offered")).toBe("1");
    expect(el("signupError").classList.contains("hidden")).toBe(true);
  });

  it("goes to the dashboard when Getting started has nothing to show", async () => {
    const { el, location } = await signupPage({
      "/auth/signup": () => ({ status: 200, body: { ok: true, alreadySignedIn: true, userId: "u1" } }),
      "/portal/api/onboarding": () => ({ status: 200, body: { show: false } })
    });
    await el("signupBtn").click();
    expect(location.href).toBe("/portal/dashboard");
  });

  it("disables the button while the request is in flight and sends only one request", async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const { el, calls } = await signupPage({
      "/auth/signup": async () => {
        await pending;
        return { status: 409, body: { error: "email_already_registered" } };
      }
    });
    const first = el("signupBtn").click();
    await tick();
    expect(el("signupBtn").disabled).toBe(true);
    expect(el("signupBtn").innerHTML).toContain("Creating account");
    expect(el("signupBtn").innerHTML).toContain("loading-spinner");
    await el("signupBtn").click();
    await el("signupBtn").click();
    release();
    await first;
    expect(calls.filter((c) => c.path === "/auth/signup")).toHaveLength(1);
    // Ready again after a failure.
    expect(el("signupBtn").disabled).toBe(false);
    expect(el("signupBtn").textContent).toBe("Create account");
  });

  it("an existing account offers Sign in (switching tabs with the email filled in) and Forgot password", async () => {
    const { el, location } = await signupPage({ "/auth/signup": () => ({ status: 409, body: { error: "email_already_registered" } }) });
    await el("signupBtn").click();
    expect(location.href).toBe("/portal");
    expect(el("signupError").classList.contains("hidden")).toBe(false);
    expect(el("signupErrorText").textContent).toBe("An account with this email already exists.");
    expect(el("signupExistsActions").classList.contains("hidden")).toBe(false);

    await el("signupForgot").click();
    expect(el("signupForgot").getAttribute("href")).toBe("/portal/reset-password?email=cody%40proton.me");

    await el("signupGoSignin").click();
    expect(el("tabSignin").classList.contains("active")).toBe(true);
    expect(el("paneSignin").classList.contains("active")).toBe(true);
    expect(el("paneSignup").classList.contains("active")).toBe(false);
    expect(el("loginEmail").value).toBe("cody@proton.me");
    expect(el("loginPassword").focused).toBe(true);
  });

  it("other errors show without the account actions", async () => {
    const { el } = await signupPage({ "/auth/signup": () => ({ status: 403, body: { error: "invite_invalid" } }) });
    await el("signupBtn").click();
    expect(el("signupErrorText").textContent).toContain("invite code is not valid");
    expect(el("signupExistsActions").classList.contains("hidden")).toBe(true);
  });
});

describe("Verify your email banner (every signed-in page)", () => {
  async function shell(user: Record<string, unknown>) {
    const html = portalAuthedPageHtml({ title: "t", activeTab: "dashboard", heading: "h", subtitle: "s", content: "", script: "" });
    const { els, document } = domFrom(html);
    const routes: Record<string, Route> = {
      "/me": () => ({ status: 200, body: { user } }),
      "/auth/resend-verification": () => ({ status: 200, body: { ok: true } })
    };
    const env = run(scriptsOf(html)[0], document, routes);
    for (let i = 0; i < 5; i++) await tick();
    return { el: (id: string) => els.get(id)!, ...env };
  }

  it("shows the masked address with Resend for an unverified account, and can be dismissed", async () => {
    const { el, calls, sessionStorage } = await shell({ email: "cody@proton.me", emailVerified: false });
    expect(el("verifyEmailBanner").hidden).toBe(false);
    expect(el("verifyEmailMasked").textContent).toBe("c…@proton.me");
    await el("verifyEmailResend").click();
    expect(calls.find((c) => c.path === "/auth/resend-verification")?.body).toEqual({ email: "cody@proton.me" });
    await el("verifyEmailDismiss").click();
    expect(el("verifyEmailBanner").hidden).toBe(true);
    expect(sessionStorage.get("edgecoder-verify-banner-dismissed")).toBe("1");
  });

  it("is not shown for a verified account or an agent account", async () => {
    expect((await shell({ email: "cody@proton.me", emailVerified: true })).el("verifyEmailBanner").hidden).toBe(true);
    expect((await shell({ email: "agent-1@agents.invalid", emailVerified: false })).el("verifyEmailBanner").hidden).toBe(true);
  });
});
