import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  HOST_REQUESTS_PER_EMAIL,
  HOST_REQUESTS_PER_IP,
  hostApprovalPolicyFromEnv,
  isApprovedHost,
  parseFormBody,
  registerHostRequestRoutes,
  validateHostRequest,
  type HostApprovalRecord,
  type HostRequestRecord,
  type HostRequestStore
} from "../../src/portal/host-requests.js";
import { inviteCodeHash, normalizeInviteCode } from "../../src/portal/invites.js";
import { marketingHomeHtml } from "../../src/portal/pages/public.js";
import { hostPageHtml, renderHostFormResult } from "../../src/portal/pages/host.js";
import { HOST_REQUEST_RATE_LIMIT, rateLimitFor, registerPortalSecurity } from "../../src/portal/security.js";
import { staticSiteFiles } from "../../src/portal/static-site.js";
import { PortalStore } from "../../src/portal/store.js";
import { memoryInviteStore } from "./invite-store-memory.js";

function memoryHostStore(existingUsers: string[] = []) {
  const requests = new Map<string, HostRequestRecord & { ipHash: string | null }>();
  const approvals = new Map<string, HostApprovalRecord>();
  const store: HostRequestStore = {
    async createHostRequest(r) {
      requests.set(r.requestId, { ...r });
    },
    async countHostRequestsSince({ email, ipHash, sinceMs }) {
      const recent = [...requests.values()].filter((r) => r.createdAtMs > sinceMs);
      return { byEmail: recent.filter((r) => r.email === email).length, byIp: ipHash ? recent.filter((r) => r.ipHash === ipHash).length : 0 };
    },
    async listHostRequests(limit) {
      return [...requests.values()].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, limit).map(({ ipHash: _i, ...r }) => r);
    },
    async getHostRequest(id) {
      const r = requests.get(id);
      if (!r) return null;
      const { ipHash: _i, ...rest } = r;
      return rest;
    },
    async updateHostRequest(id, patch) {
      const r = requests.get(id);
      if (!r) return null;
      if (patch.status) r.status = patch.status;
      if (patch.notes !== undefined) r.notes = patch.notes;
      if (patch.inviteCodeId) r.inviteCodeId = patch.inviteCodeId;
      r.updatedAtMs = patch.updatedAtMs;
      r.updatedBy = patch.updatedBy;
      const { ipHash: _i, ...rest } = r;
      return rest;
    },
    async getHostApproval(email) {
      return approvals.get(email.toLowerCase()) ?? null;
    },
    async listHostApprovals() {
      return [...approvals.values()];
    },
    async approveHost(h) {
      approvals.set(h.email.toLowerCase(), h);
    },
    async revokeHost(email) {
      return approvals.delete(email.toLowerCase());
    }
  };
  const users = new Set(existingUsers);
  return { store, requests, approvals, getUserByEmail: async (e: string) => (users.has(e) ? { userId: `u-${e}` } : null) };
}

const valid = {
  name: "Ada Host",
  email: "Ada@Example.com",
  organisation: "Ada Compute",
  hostKinds: ["compute_agent", "bitcoin_node"],
  computeHardware: "nvidia_gpu",
  hardwareDetails: "RTX 4090 24 GB, 64 GB RAM",
  region: "Frankfurt",
  message: "Happy to help.\nTwo machines."
};

async function makeApp(opts: { isAdmin?: boolean; launchMode?: "open" | "invite"; existingUsers?: string[]; policyEnv?: NodeJS.ProcessEnv; ip?: () => string } = {}) {
  const mem = memoryHostStore(opts.existingUsers);
  const inv = memoryInviteStore();
  const notified: HostRequestRecord[] = [];
  const approvedMails: Array<{ email: string; inviteCode: string | null }> = [];
  const app = Fastify();
  await registerHostRequestRoutes(app, {
    store: { ...mem.store, ...inv.store, getUserByEmail: mem.getUserByEmail },
    policy: hostApprovalPolicyFromEnv(opts.policyEnv ?? { SYSTEM_ADMIN_EMAILS: "boss@edgecoder.io" }),
    launchMode: opts.launchMode ?? "invite",
    getCurrentUser: async (req) => (req.headers.cookie === "admin" ? { userId: "a1", email: "boss@edgecoder.io", emailVerified: true } : req.headers.cookie ? { userId: "u1", email: String(req.headers.cookie), emailVerified: true } : null),
    buildAccessContext: async () => ({ isSystemAdmin: opts.isAdmin ?? true }),
    clientIp: opts.ip ?? (() => "198.51.100.7"),
    notifyAdmins: async (r) => {
      notified.push(r);
      return true;
    },
    notifyApproved: async (m) => {
      approvedMails.push({ email: m.email, inviteCode: m.inviteCode });
      return true;
    },
    renderFormResult: renderHostFormResult,
    now: () => 1_000_000
  });
  return { app, mem, inv, notified, approvedMails };
}

const json = (payload: unknown) => ({ method: "POST" as const, url: "/host/request", payload: payload as Record<string, unknown> });

describe("public site: hosting is by request", () => {
  it("the home page has no Install-the-agent CTA or open earning promise, and links Request to host", () => {
    const html = marketingHomeHtml();
    expect(html).not.toContain("Install the agent");
    expect(html).not.toContain("Run an agent");
    expect(html).not.toContain("Run a node");
    expect(html).not.toMatch(/start earning sats/i);
    expect(html).not.toContain("Hosting a Bitcoin node for the network is paid work.");
    expect(html).not.toContain('href="/portal/settings/install"');
    expect(html).toContain('<a href="/host">Host with us</a>');
    expect(html).toContain('href="/host#request">Request to host</a>');
    expect(html).toContain("early-access hosts are paid");
    expect(html).toContain('href="/portal#signup">Create account</a>');
  });

  it("the /host page explains invite-only hosting and carries the request form with a honeypot", () => {
    const html = hostPageHtml();
    expect(html).toMatch(/invitation only/);
    expect(html).toContain('<form class="host-form" id="hostRequestForm" method="post" action="/host/request"');
    for (const name of ["name", "email", "organisation", "hostKinds", "computeHardware", "hardwareDetails", "region", "message", "website"]) {
      expect(html).toContain(`name="${name}"`);
    }
    for (const kind of ["compute_agent", "coordinator", "bitcoin_node", "lightning_node"]) expect(html).toContain(`value="${kind}"`);
    expect(html).toMatch(/class="hp" aria-hidden="true"/);
    expect(html).toContain("Request to host</button>");
  });

  it("the form result keeps typed values (escaped) and marks bad fields", () => {
    const html = renderHostFormResult({ ok: false, error: "invalid", fields: ["email"], values: { name: "<b>x</b>", email: "nope", hostKinds: ["coordinator"] } });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('value="coordinator" checked');
    expect(html).toContain("A valid email address");
    expect(renderHostFormResult({ ok: true })).toContain('id="hostRequestSent"');
  });

  it("the static mirror forwards /host to the portal", () => {
    expect(staticSiteFiles({ portalUrl: "https://edgecoder.io" })._redirects).toContain("/host https://edgecoder.io/host 302");
  });
});

describe("request validation", () => {
  it("accepts a full request and normalises the email", () => {
    const v = validateHostRequest(valid);
    expect(v.ok && v.value.email).toBe("ada@example.com");
    expect(validateHostRequest({ name: "A", email: "a@b.co", hostKinds: "coordinator" })).toMatchObject({ ok: true, value: { hostKinds: ["coordinator"] } });
  });

  it("names every bad field", () => {
    expect(validateHostRequest({})).toMatchObject({ ok: false, fields: expect.arrayContaining(["name", "email", "hostKinds"]) });
    expect(validateHostRequest({ ...valid, email: "not-an-email" })).toEqual({ ok: false, fields: ["email"] });
    expect(validateHostRequest({ ...valid, hostKinds: ["mining_rig"] })).toEqual({ ok: false, fields: ["hostKinds"] });
    expect(validateHostRequest({ ...valid, hostKinds: [] })).toEqual({ ok: false, fields: ["hostKinds"] });
    expect(validateHostRequest({ ...valid, name: "<script>" })).toEqual({ ok: false, fields: ["name"] });
    expect(validateHostRequest({ ...valid, message: "x".repeat(2001) })).toEqual({ ok: false, fields: ["message"] });
    expect(validateHostRequest({ ...valid, computeHardware: "abacus" })).toEqual({ ok: false, fields: ["computeHardware"] });
  });

  it("parses a browser form body, repeated checkboxes as a list", () => {
    expect(parseFormBody("name=A+B&hostKinds=coordinator&hostKinds=bitcoin_node&email=a%40b.co")).toEqual({ name: "A B", hostKinds: ["coordinator", "bitcoin_node"], email: "a@b.co" });
  });
});

describe("POST /host/request", () => {
  it("stores a valid request and emails the admins", async () => {
    const { app, mem, notified } = await makeApp();
    const res = await app.inject(json(valid));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const [stored] = [...mem.requests.values()];
    expect(stored).toMatchObject({ name: "Ada Host", email: "ada@example.com", hostKinds: ["compute_agent", "bitcoin_node"], status: "new" });
    expect(stored!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.ipHash).not.toContain("198.51.100.7");
    await new Promise((r) => setImmediate(r));
    expect(notified).toHaveLength(1);
  });

  it("refuses invalid input with the fields", async () => {
    const { app, mem } = await makeApp();
    const res = await app.inject(json({ ...valid, email: "x" }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_host_request", fields: ["email"] });
    expect(mem.requests.size).toBe(0);
  });

  it("honeypot: a filled hidden field looks accepted but nothing is stored or sent", async () => {
    const { app, mem, notified } = await makeApp();
    const res = await app.inject(json({ ...valid, website: "http://spam.example" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mem.requests.size).toBe(0);
    expect(notified).toHaveLength(0);
  });

  it("limits requests per email and per IP over a day", async () => {
    const { app } = await makeApp();
    for (let i = 0; i < HOST_REQUESTS_PER_EMAIL; i++) expect((await app.inject(json(valid))).statusCode).toBe(200);
    const res = await app.inject(json({ ...valid, email: "ADA@example.com" }));
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("rate_limited");

    const other = await makeApp();
    for (let i = 0; i < HOST_REQUESTS_PER_IP; i++) expect((await other.app.inject(json({ ...valid, email: `p${i}@example.com` }))).statusCode).toBe(200);
    expect((await other.app.inject(json({ ...valid, email: "fresh@example.com" }))).statusCode).toBe(429);
  });

  it("answers a browser form post with the page", async () => {
    const { app, mem } = await makeApp();
    const body = "name=Bo&email=bo%40example.com&hostKinds=lightning_node&region=&website=";
    const ok = await app.inject({ method: "POST", url: "/host/request", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: body });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/html");
    expect(ok.body).toContain('id="hostRequestSent"');
    expect([...mem.requests.values()][0]).toMatchObject({ email: "bo@example.com", hostKinds: ["lightning_node"], region: null });
    const bad = await app.inject({ method: "POST", url: "/host/request", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "name=Bo&email=bo" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("Please check the highlighted fields");
  });

  it("the route carries a per-IP rate limit", async () => {
    expect(rateLimitFor("/host/request", "POST")).toBe(HOST_REQUEST_RATE_LIMIT);
    const app = Fastify();
    await registerPortalSecurity(app, { publicOrigin: "http://127.0.0.1:4310", trustedOrigins: [] });
    app.post("/host/request", async () => ({ ok: true }));
    const codes: number[] = [];
    for (let i = 0; i <= HOST_REQUEST_RATE_LIMIT.max; i++) codes.push((await app.inject({ method: "POST", url: "/host/request", remoteAddress: "192.0.2.5", payload: {} })).statusCode);
    expect(codes.slice(0, HOST_REQUEST_RATE_LIMIT.max).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("Settings > Admin > Host requests", () => {
  const admin = { cookie: "admin" };

  it("is for system admins only", async () => {
    const { app } = await makeApp({ isAdmin: false });
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/host-requests" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/portal/api/admin/host-requests", headers: admin })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/hosts", headers: admin, payload: { email: "a@b.co" } })).statusCode).toBe(403);
  });

  it("lists requests, changes status and notes, and approving mints an emailed invite for a new person", async () => {
    const { app, mem, inv, approvedMails } = await makeApp();
    await app.inject(json(valid));
    const list = (await app.inject({ method: "GET", url: "/portal/api/admin/host-requests", headers: admin })).json();
    expect(list.required).toBe(true);
    const id = list.requests[0].requestId;
    expect(list.requests[0]).toMatchObject({ status: "new", email: "ada@example.com" });

    const contacted = await app.inject({ method: "POST", url: `/portal/api/admin/host-requests/${id}`, headers: admin, payload: { status: "contacted", notes: "Called on Monday" } });
    expect(contacted.json().request).toMatchObject({ status: "contacted", notes: "Called on Monday", updatedBy: "boss@edgecoder.io" });
    expect(contacted.json().invite).toBeUndefined();

    const approved = await app.inject({ method: "POST", url: `/portal/api/admin/host-requests/${id}`, headers: admin, payload: { status: "approved" } });
    const body = approved.json();
    expect(body.request).toMatchObject({ status: "approved", notes: "Called on Monday" });
    expect(normalizeInviteCode(body.invite.code)).toBe(body.invite.code);
    expect(body.invite.emailed).toBe(true);
    expect(body.request.inviteCodeId).toBe(body.invite.codeId);
    expect(await inv.store.inviteCodeRedeemable(inviteCodeHash(body.invite.code), 1_000_001)).toBe(true);
    expect([...inv.codes.values()][0]).toMatchObject({ maxUses: 1, label: "Host: ada@example.com" });
    expect(approvedMails).toEqual([{ email: "ada@example.com", inviteCode: body.invite.code }]);
    expect(mem.approvals.get("ada@example.com")).toMatchObject({ source: "host_request", approvedBy: "boss@edgecoder.io" });

    // Declining takes back the approval the request gave.
    await app.inject({ method: "POST", url: `/portal/api/admin/host-requests/${id}`, headers: admin, payload: { status: "declined" } });
    expect(mem.approvals.has("ada@example.com")).toBe(false);
  });

  it("approving someone who already has an account approves the host without an invite", async () => {
    const { app, inv, approvedMails } = await makeApp({ existingUsers: ["ada@example.com"] });
    await app.inject(json(valid));
    const id = (await app.inject({ method: "GET", url: "/portal/api/admin/host-requests", headers: admin })).json().requests[0].requestId;
    const res = (await app.inject({ method: "POST", url: `/portal/api/admin/host-requests/${id}`, headers: admin, payload: { status: "approved" } })).json();
    expect(res.invite).toBeUndefined();
    expect(inv.codes.size).toBe(0);
    expect(approvedMails).toEqual([{ email: "ada@example.com", inviteCode: null }]);
  });

  it("refuses bad updates", async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/host-requests/nope", headers: admin, payload: { status: "approved" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/portal/api/admin/host-requests/${"a".repeat(24)}`, headers: admin, payload: { status: "approved" } })).statusCode).toBe(404);
    await app.inject(json(valid));
    const id = (await app.inject({ method: "GET", url: "/portal/api/admin/host-requests", headers: admin })).json().requests[0].requestId;
    expect((await app.inject({ method: "POST", url: `/portal/api/admin/host-requests/${id}`, headers: admin, payload: { status: "maybe" } })).statusCode).toBe(400);
  });

  it("approves and revokes a host account directly; the account sees its status", async () => {
    const { app } = await makeApp();
    const me = { cookie: "carol@example.com" };
    expect((await app.inject({ method: "GET", url: "/portal/api/host/status", headers: me })).json()).toEqual({ required: true, approved: false });
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/hosts", headers: admin, payload: { email: "Carol@Example.com", note: "friend" } })).json().host).toMatchObject({ email: "carol@example.com", source: "admin" });
    expect((await app.inject({ method: "GET", url: "/portal/api/host/status", headers: me })).json()).toEqual({ required: true, approved: true });
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/hosts/revoke", headers: admin, payload: { email: "carol@example.com" } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "POST", url: "/portal/api/admin/hosts/revoke", headers: admin, payload: { email: "carol@example.com" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/portal/api/host/status" })).statusCode).toBe(401);
  });
});

describe("host approval policy", () => {
  it("is on by default; 0 or false turns it off", () => {
    expect(hostApprovalPolicyFromEnv({}).required).toBe(true);
    expect(hostApprovalPolicyFromEnv({ HOST_APPROVAL_REQUIRED: "1" }).required).toBe(true);
    expect(hostApprovalPolicyFromEnv({ HOST_APPROVAL_REQUIRED: "0" }).required).toBe(false);
    expect(hostApprovalPolicyFromEnv({ HOST_APPROVAL_REQUIRED: "false" }).required).toBe(false);
  });

  it("approves admins, the allowlist and stored hosts only", async () => {
    const policy = hostApprovalPolicyFromEnv({ SYSTEM_ADMIN_EMAILS: "Boss@EdgeCoder.io", HOST_APPROVED_EMAILS: "lab@example.com, ops@example.com" });
    const { store } = memoryHostStore();
    await store.approveHost({ email: "old@example.com", approvedAtMs: 1, approvedBy: "migration", source: "grandfathered", note: null });
    expect(await isApprovedHost("boss@edgecoder.io", policy, store)).toBe(true);
    expect(await isApprovedHost("ops@example.com", policy, store)).toBe(true);
    expect(await isApprovedHost("OLD@example.com", policy, store)).toBe(true);
    expect(await isApprovedHost("new@example.com", policy, store)).toBe(false);
    expect(await isApprovedHost("", policy, store)).toBe(false);
    expect(await isApprovedHost(undefined, policy, null)).toBe(false);
    expect(await isApprovedHost("new@example.com", hostApprovalPolicyFromEnv({ HOST_APPROVAL_REQUIRED: "0" }), store)).toBe(true);
  });
});

describe("grandfathering in PortalStore.migrateHostRequests", () => {
  function fakePool(tableExists: boolean) {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    return {
      queries,
      pool: {
        async query(text: string, values?: unknown[]) {
          queries.push({ text, values });
          if (text.includes("to_regclass")) return { rows: [{ present: tableExists }], rowCount: 1 };
          if (text.includes("INSERT INTO portal_host_approvals")) return { rows: [], rowCount: 2 };
          return { rows: [], rowCount: 0 };
        }
      }
    };
  }

  it("on first creation, approves the owners of every node approved at that moment", async () => {
    const f = fakePool(false);
    const n = await new PortalStore(f.pool as never).migrateHostRequests(42);
    expect(n).toBe(2);
    const insert = f.queries.find((q) => q.text.includes("INSERT INTO portal_host_approvals"));
    expect(insert?.text).toMatch(/'grandfathered'/);
    expect(insert?.text).toMatch(/WHERE n\.node_approved = TRUE/);
    expect(insert?.values).toEqual([42]);
  });

  it("never again once the table exists, so later sign-ups are not approved", async () => {
    const f = fakePool(true);
    expect(await new PortalStore(f.pool as never).migrateHostRequests(42)).toBe(0);
    expect(f.queries.some((q) => q.text.includes("INSERT INTO portal_host_approvals"))).toBe(false);
    expect(f.queries.some((q) => q.text.includes("CREATE TABLE IF NOT EXISTS portal_host_requests"))).toBe(true);
  });
});
