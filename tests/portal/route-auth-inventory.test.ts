import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * #17: route inventory for the real portal server.
 *
 * Every route the portal registers is enumerated (an onRoute hook added when server.ts creates
 * its Fastify app). A route is either on the explicit PUBLIC list below, with the reason it is
 * public, or it must refuse every request that does not carry a valid credential. A route added
 * later is covered without touching this file: if it is not added to PUBLIC, it has to reject.
 *
 * The store is an in-memory fake (PortalStore.fromEnv is replaced) and outbound HTTP is disabled,
 * so the test needs no database and no network.
 */

type RouteOpts = { config?: { rateLimit?: { max?: number; timeWindow?: string } } };
const h = vi.hoisted(() => ({
  routes: [] as Array<{ method: string; url: string; opts: RouteOpts }>,
  outbound: [] as string[]
}));

vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const wrapped = ((opts: never) => {
    const app = mod.default(opts);
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        h.routes.push({ method: String(method).toUpperCase(), url: route.url, opts: route as RouteOpts });
      }
    });
    return app;
  }) as unknown as typeof mod.default;
  return { ...mod, default: wrapped, fastify: wrapped };
});

vi.mock("undici", async (importOriginal) => {
  const mod = await importOriginal<typeof import("undici")>();
  return {
    ...mod,
    request: async (url: unknown) => {
      h.outbound.push(String(url));
      throw new Error("network disabled in tests");
    }
  };
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const SERVICE_TOKEN = "s".repeat(40);
const ADMIN_TOKEN = "a".repeat(40);
const METRICS_TOKEN = "m".repeat(40);
const PUBLIC_ORIGIN = "http://127.0.0.1:4310";

/** Routes that answer without a credential, each with the reason. Anything else must reject. */
const PUBLIC: Record<string, string> = {
  "GET /health": "liveness probe",
  "GET /.well-known/apple-app-site-association": "Apple fetches it anonymously",
  "GET /": "marketing page",
  "GET /privacy": "static page",
  "GET /terms": "static page",
  "GET /host": "Host with us page and its request form",
  "POST /host/request": "public Request to host form (honeypot, rate limited per IP and per email)",
  "GET /acceptable-use": "static page",
  "GET /host-agreement": "static page",
  "GET /bluetooth": "static page",
  "GET /install.sh": "installer script",
  "GET /install.ps1": "installer script",
  "GET /assets/tokens.css": "static asset",
  "GET /assets/theme.js": "static asset",
  "GET /portal/vendor/lightweight-charts.js": "static asset",
  // Page shells: static HTML with no user data; the page's script calls the protected APIs.
  "GET /portal": "sign-in page shell",
  "GET /portal-legacy": "page shell",
  "GET /portal/reset-password": "password reset page shell",
  "GET /portal/chat": "page shell",
  "GET /portal/dashboard": "page shell",
  "GET /portal/reviews": "page shell",
  "GET /portal/settings": "page shell",
  "GET /portal/settings/plan": "page shell",
  "GET /portal/settings/install": "page shell",
  "GET /portal/settings/compute": "page shell",
  "GET /portal/settings/nodes": "page shell",
  "GET /portal/settings/admin": "page shell",
  "GET /portal/settings/revenue": "page shell (the revenue APIs it calls are system-admin only)",
  "GET /portal/settings/network": "page shell (the network API it calls is system-admin only)",
  "GET /portal/settings/world": "page shell (the world view API it calls needs a session)",
  "GET /portal/wallet": "legacy redirect",
  "GET /portal/market": "legacy redirect",
  "GET /portal/download": "legacy redirect",
  "GET /portal/nodes": "legacy redirect",
  "GET /portal/coordinator-ops": "legacy redirect",
  // Signing in, signing up and recovering an account happen before there is a session.
  "GET /auth/capabilities": "which sign-in methods are enabled",
  "POST /auth/signup": "creates the account",
  "POST /auth/login": "creates the session",
  "POST /auth/logout": "clears the cookie; a no-op without a session",
  "POST /auth/resend-verification": "pre-session",
  "GET /auth/verify-email": "emailed link",
  "POST /auth/verify-email": "emailed link",
  "POST /auth/password/forgot": "pre-session",
  "POST /auth/password/reset": "emailed link",
  "GET /auth/oauth/:provider/start": "starts sign-in",
  "GET /auth/oauth/:provider/callback": "provider redirect; proven by the state value",
  "POST /auth/oauth/:provider/callback": "provider form post; proven by the state value",
  "GET /auth/oauth/apple/start": "starts sign-in",
  "GET /auth/oauth/apple/callback": "provider redirect",
  "POST /auth/oauth/apple/callback": "provider form post",
  "POST /auth/oauth/mobile/complete": "exchanges a one-time code for the session",
  "POST /auth/passkey/login/options": "starts passkey sign-in",
  "POST /auth/passkey/login/verify": "finishes passkey sign-in",
  "POST /agents/challenge": "agent signup, proven by a key signature",
  "POST /agents/signup": "agent signup, proven by a key signature",
  // Signed, public by design (coordinators and nodes verify the signature).
  "GET /network/registry": "signed public registry",
  "GET /network/registry/public-key": "registry verification key"
};

/** Which credential a protected route takes; everything not matched here takes a portal session. */
type Credential = "session" | "apiKey" | "serviceToken" | "registrationToken" | "metricsToken";
function credentialFor(route: { method: string; url: string }): Credential {
  if (route.url.startsWith("/v1/")) return "apiKey";
  if (route.url.startsWith("/internal/")) return "serviceToken";
  if (route.url === "/nodes/discover-coordinator") return "registrationToken";
  if (route.url === "/metrics") return "metricsToken";
  return "session";
}

/** Route prefixes only an operator may use: a signed-in ordinary user gets 403. */
const OPERATOR_ONLY = ["/portal/api/admin/", "/coordinator/ops/", "/admin/", "/portal/api/escalations", "/portal/api/reviews"];

/** Public state-changing routes that deliberately carry no rate limit. */
const NO_RATE_LIMIT: Record<string, string> = {};

const PARAMS: Record<string, string> = { provider: "google" };
const concrete = (url: string) => url.replace(/:([A-Za-z]+)/g, (_m, name: string) => PARAMS[name] ?? `x-${name}`);
const key = (route: { method: string; url: string }) => `${route.method} ${route.url}`;
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type User = { userId: string; email: string; emailVerified: boolean; uiTheme: "warm"; role: "user" | "admin"; createdAtMs: number };

function makeStore() {
  const calls: string[] = [];
  const sessions = new Map<string, { sessionId: string; userId: string; expiresAtMs: number }>();
  const users = new Map<string, User>();
  const apiKeys = new Map<string, string>();
  const registrationTokens = new Set<string>();
  const overrides: Record<string, (...args: never[]) => unknown> = {
    // Mirrors the SQL (`expires_at_ms > now`), which the last test in this file pins.
    getSessionByTokenHash: (hash: string) => {
      const session = sessions.get(hash);
      return session && session.expiresAtMs > Date.now() ? session : null;
    },
    getUserById: (userId: string) => users.get(userId) ?? null,
    // u-owner enrolled a coordinator node: that grants the view of coordinator operations, nothing more.
    listNodesByOwner: (userId: string) => (userId === "u-owner" ? [{ nodeId: "coord-1", nodeKind: "coordinator", ownerUserId: "u-owner", active: true }] : []),
    userForApiKeyHash: (hash: string) => apiKeys.get(hash) ?? null,
    getNodeEnrollmentByRegistrationTokenHash: (hash: string) =>
      registrationTokens.has(hash) ? { nodeId: "node-1", nodeKind: "agent", ownerUserId: "u-user", active: true } : null
  };
  const store = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then" || prop === "pool") return undefined;
        return async (...args: never[]) => {
          calls.push(prop);
          if (overrides[prop]) return overrides[prop](...args);
          if (/^(list|search|recent)/.test(prop)) return [];
          if (/^(count|sum)/.test(prop)) return 0;
          return null;
        };
      }
    }
  );
  return {
    store,
    calls,
    addUser(user: Pick<User, "userId" | "email"> & Partial<User>) {
      users.set(user.userId, { emailVerified: true, uiTheme: "warm", role: "user", createdAtMs: 1, ...user });
    },
    addSession(token: string, userId: string, expiresAtMs = Date.now() + 3_600_000) {
      sessions.set(sha256(token), { sessionId: `sess-${token}`, userId, expiresAtMs });
    },
    addApiKey: (apiKey: string, userId: string) => apiKeys.set(sha256(apiKey), userId),
    addRegistrationToken: (token: string) => registrationTokens.add(sha256(token))
  };
}

const fake = makeStore();
let app: FastifyInstance;
let PortalStoreClass: typeof import("../../src/portal/store.js").PortalStore;
let security: typeof import("../../src/portal/security.js");
let ipCounter = 0;

/** A fresh client address per request, so the per-IP rate limits never interfere. */
const freshIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

async function call(route: { method: string; url: string }, headers: Record<string, string> = {}, remoteAddress = freshIp()) {
  const hasBody = STATE_CHANGING.has(route.method);
  return app.inject({
    method: route.method as "GET",
    url: concrete(route.url),
    remoteAddress,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...headers },
    ...(hasBody ? { payload: "{}" } : {})
  });
}

const cookie = (token: string) => ({ cookie: `edgecoder_portal_session=${token}` });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The header set that should let a request through the route's own credential check. */
function validCredential(route: { method: string; url: string }): Record<string, string> {
  switch (credentialFor(route)) {
    case "apiKey":
      return bearer("eck_valid_key");
    case "serviceToken":
      return { "x-portal-service-token": SERVICE_TOKEN, "x-admin-token": ADMIN_TOKEN };
    case "registrationToken":
      return bearer("valid-registration-token");
    case "metricsToken":
      return bearer(METRICS_TOKEN);
    default:
      return cookie("admin-session");
  }
}

let routes: Array<{ method: string; url: string; opts: RouteOpts }> = [];
/** Fastify answers HEAD for every GET route with the same handler, so HEAD is public where GET is. */
const isPublic = (route: { method: string; url: string }) => key(route.method === "HEAD" ? { method: "GET", url: route.url } : route) in PUBLIC;
const protectedRoutes = () => routes.filter((route) => !isPublic(route));

// Importing and booting the whole portal takes ~6 s alone; under a full parallel run it can pass the
// default 10 s hook timeout, so this hook gets 60 s.
beforeAll(async () => {
  for (const name of [
    "PORTAL_DATABASE_URL", "DATABASE_URL", "PORTAL_ALLOW_OPEN_INTERNAL", "PORTAL_ORIGIN_LOCK_TOKEN", "PORTAL_EDGE",
    "PORTAL_PUBLIC_URL", "PORTAL_TRUSTED_ORIGINS", "PORTAL_TRUST_FLY_CLIENT_IP", "PORTAL_COORDINATOR_TOKEN",
    "RESEND_API_KEY", "RESEND_FROM_EMAIL", "COORDINATOR_ADMIN_EMAILS", "COORDINATOR_OPERATIONS_OWNER_EMAILS"
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("LOG_LEVEL", "silent");
  vi.stubEnv("PORTAL_SERVICE_TOKEN", SERVICE_TOKEN);
  vi.stubEnv("CONTROL_PLANE_ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("METRICS_TOKEN", METRICS_TOKEN);
  vi.stubEnv("SYSTEM_ADMIN_EMAILS", "ops@example.com,claimed@example.com");
  vi.stubGlobal("fetch", async (url: unknown) => {
    h.outbound.push(String(url));
    throw new Error("network disabled in tests");
  });

  fake.addUser({ userId: "u-user", email: "user@example.com" });
  fake.addUser({ userId: "u-unverified", email: "new@example.com", emailVerified: false });
  fake.addUser({ userId: "u-admin", email: "root@example.com", role: "admin" });
  fake.addUser({ userId: "u-ops", email: "ops@example.com" });
  fake.addUser({ userId: "u-claimed", email: "claimed@example.com", emailVerified: false });
  fake.addSession("user-session", "u-user");
  fake.addSession("unverified-session", "u-unverified");
  fake.addSession("admin-session", "u-admin");
  fake.addSession("ops-session", "u-ops");
  fake.addSession("claimed-session", "u-claimed");
  fake.addUser({ userId: "u-owner", email: "owner@example.com" });
  fake.addSession("owner-session", "u-owner");
  fake.addSession("expired-session", "u-admin", Date.now() - 1);
  fake.addSession("orphan-session", "u-deleted");
  fake.addApiKey("eck_valid_key", "u-user");
  fake.addRegistrationToken("valid-registration-token");

  ({ PortalStore: PortalStoreClass } = await import("../../src/portal/store.js"));
  vi.spyOn(PortalStoreClass, "fromEnv").mockReturnValue(fake.store as never);
  security = await import("../../src/portal/security.js");
  ({ portalServer: app } = await import("../../src/portal/server.js"));
  await app.ready();
  routes = h.routes.filter((route) => route.method !== "OPTIONS");
}, 60_000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});


/** Session routes that also take a portal API key (`edgecoder-install --enroll eck_...`). Only enrolment does. */
const API_KEY_ALSO_ACCEPTED = new Set(["POST /nodes/enroll"]);
const API_KEY_VARIANT = "API key instead of a session";

/** Lookups that resolve a credential. A rejected request may make these and nothing else. */
const CREDENTIAL_LOOKUPS = new Set(["getSessionByTokenHash", "getUserById", "userForApiKeyHash", "getNodeEnrollmentByRegistrationTokenHash"]);

/** Requests that must be refused, per credential type: missing, unknown, expired, or the wrong kind. */
const REJECTED: Record<Credential, Array<[string, Record<string, string>]>> = {
  session: [
    ["no credentials", {}],
    ["unknown session cookie", cookie("no-such-session")],
    ["unknown bearer token", bearer("no-such-session")],
    ["empty session cookie", cookie("")],
    ["expired session cookie", cookie("expired-session")],
    ["expired session as bearer", bearer("expired-session")],
    ["session of a deleted user", cookie("orphan-session")],
    [API_KEY_VARIANT, bearer("eck_valid_key")],
    ["unknown API key instead of a session", bearer("eck_unknown_key")],
    ["service token instead of a session", { "x-portal-service-token": SERVICE_TOKEN, "x-admin-token": ADMIN_TOKEN }]
  ],
  apiKey: [
    ["no credentials", {}],
    ["unknown API key (bearer)", bearer("eck_unknown_key")],
    ["unknown API key (x-api-key)", { "x-api-key": "eck_unknown_key" }],
    ["session token instead of an API key", bearer("admin-session")],
    ["session cookie instead of an API key", cookie("admin-session")]
  ],
  serviceToken: [
    ["no credentials", {}],
    ["wrong service token", { "x-portal-service-token": "w".repeat(40) }],
    ["admin token without the service token", { "x-admin-token": ADMIN_TOKEN }],
    ["service token in the wrong header", bearer(SERVICE_TOKEN)],
    ["admin session instead of a service token", cookie("admin-session")]
  ],
  registrationToken: [
    ["no credentials", {}],
    ["unknown registration token", bearer("no-such-token")],
    ["session token instead of a registration token", bearer("admin-session")]
  ],
  metricsToken: [
    ["no credentials", {}],
    ["wrong metrics token", bearer("w".repeat(40))],
    ["admin session instead of the metrics token", cookie("admin-session")]
  ]
};

describe("portal route inventory (#17)", () => {
  it("captures the real server's routes", () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((route) => route.url === "/wallet/send/mfa/confirm" && route.method === "POST")).toBe(true);
  });

  it("the public list names only routes that exist", () => {
    const registered = new Set(routes.map(key));
    expect(Object.keys(PUBLIC).filter((entry) => !registered.has(entry))).toEqual([]);
    expect(Object.keys(NO_RATE_LIMIT).filter((entry) => !(entry in PUBLIC))).toEqual([]);
    expect([...API_KEY_ALSO_ACCEPTED].filter((entry) => !registered.has(entry))).toEqual([]);
    for (const prefix of OPERATOR_ONLY) expect(routes.some((route) => route.url.startsWith(prefix)), prefix).toBe(true);
  });

  it("every route off the public list refuses a request without a valid credential", async () => {
    const failures: string[] = [];
    let requests = 0;
    for (const route of protectedRoutes()) {
      for (const [label, headers] of REJECTED[credentialFor(route)]) {
        if (label === API_KEY_VARIANT && API_KEY_ALSO_ACCEPTED.has(key(route))) continue;
        const callsBefore = fake.calls.length;
        const outboundBefore = h.outbound.length;
        const res = await call(route, headers);
        requests += 1;
        if (res.statusCode !== 401 && res.statusCode !== 403) failures.push(`${key(route)} with ${label}: ${res.statusCode}`);
        const touched = fake.calls.slice(callsBefore).filter((name) => !CREDENTIAL_LOOKUPS.has(name));
        if (touched.length > 0) failures.push(`${key(route)} with ${label}: used the store before rejecting (${touched.join(", ")})`);
        if (h.outbound.length !== outboundBefore) failures.push(`${key(route)} with ${label}: made an outbound request before rejecting`);
      }
    }
    // A new route that is meant to be public belongs on PUBLIC, with the reason.
    expect(failures).toEqual([]);
    expect(requests).toBeGreaterThan(500);
  });

  it("the same routes accept the right credential, so the refusals above are about the credential", async () => {
    const failures: string[] = [];
    for (const route of protectedRoutes()) {
      const res = await call(route, validCredential(route));
      if (res.statusCode === 401 || res.statusCode === 403) failures.push(`${key(route)}: ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(failures).toEqual([]);
  });

  it("operator-only routes refuse a signed-in ordinary user", async () => {
    const operatorRoutes = protectedRoutes().filter((route) => OPERATOR_ONLY.some((prefix) => route.url.startsWith(prefix)));
    expect(operatorRoutes.length).toBeGreaterThan(15);
    const failures: string[] = [];
    for (const route of operatorRoutes) {
      // An ordinary user; and an account whose address is on SYSTEM_ADMIN_EMAILS but was never verified.
      for (const session of ["user-session", "unverified-session", "claimed-session"]) {
        const callsBefore = fake.calls.length;
        const res = await call(route, cookie(session));
        if (res.statusCode !== 403) failures.push(`${key(route)} as ${session}: ${res.statusCode}`);
        const touched = fake.calls.slice(callsBefore).filter((name) => !CREDENTIAL_LOOKUPS.has(name) && name !== "listNodesByOwner");
        if (touched.length > 0) failures.push(`${key(route)} as ${session}: used the store before rejecting (${touched.join(", ")})`);
      }
      // The verified owner of an allowlisted address, and a database admin, get through.
      for (const session of ["ops-session", "admin-session"]) {
        const res = await call(route, cookie(session));
        if (res.statusCode === 401 || res.statusCode === 403) failures.push(`${key(route)} as ${session}: ${res.statusCode}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("the owner of a coordinator node may view coordinator operations but not manage them, nor reach any other operator route", async () => {
    // What the view tier (requireCoordinatorOperationsUser) opens to a coordinator owner. Everything else
    // under OPERATOR_ONLY needs a coordinator or system admin.
    const VIEW_TIER = new Set(["GET /coordinator/ops/summary", "HEAD /coordinator/ops/summary", "GET /coordinator/ops/agent-diagnostics", "HEAD /coordinator/ops/agent-diagnostics"]);
    const summary = await call({ method: "GET", url: "/coordinator/ops/summary" }, cookie("owner-session"));
    expect([401, 403], "the owner is in the view tier").not.toContain(summary.statusCode);

    const operatorRoutes = protectedRoutes().filter((route) => OPERATOR_ONLY.some((prefix) => route.url.startsWith(prefix)));
    const manageRoutes = operatorRoutes.filter((route) => !VIEW_TIER.has(key(route)));
    for (const url of ["/coordinator/ops/node-approval", "/coordinator/ops/coordinator-ollama", "/coordinator/ops/agents-model"]) {
      expect(manageRoutes.some((route) => route.method === "POST" && route.url === url), url).toBe(true);
    }
    const failures: string[] = [];
    for (const route of manageRoutes) {
      const outboundBefore = h.outbound.length;
      const res = await call(route, cookie("owner-session"));
      if (res.statusCode !== 403) failures.push(`${key(route)}: ${res.statusCode} ${res.body.slice(0, 80)}`);
      if (h.outbound.length !== outboundBefore) failures.push(`${key(route)}: made an outbound call before rejecting`);
    }
    expect(failures).toEqual([]);
  });

  it("routes that need a verified email refuse an unverified account", async () => {
    for (const url of ["/auth/passkey/register/options", "/auth/passkey/register/verify", "/portal/api/keys"]) {
      const route = { method: "POST", url };
      const unverified = await call(route, cookie("unverified-session"));
      expect(unverified.statusCode, url).toBe(403);
      expect(unverified.json(), url).toMatchObject({ error: "email_not_verified" });
      const verified = await call(route, cookie("user-session"));
      expect(verified.statusCode, url).not.toBe(403);
    }
  });

  it("/internal mutations need the control-plane admin credential on top of the service token", async () => {
    const approval = { method: "POST", url: "/internal/nodes/:nodeId/approval" };
    for (const headers of [
      { "x-portal-service-token": SERVICE_TOKEN },
      { "x-portal-service-token": SERVICE_TOKEN, "x-admin-token": "w".repeat(40) },
      { "x-portal-service-token": SERVICE_TOKEN, authorization: `Bearer ${SERVICE_TOKEN}` }
    ]) {
      const res = await call(approval, headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "control_plane_admin_required" });
    }
  });
});

describe("portal CSRF inventory (#17)", () => {
  const checked = () => routes.filter((route) => STATE_CHANGING.has(route.method) && !security.CSRF_EXEMPT_ROUTES.has(route.url));

  it("every state-changing route refuses a cross-site request, even with a valid credential", async () => {
    expect(checked().length).toBeGreaterThan(40);
    const failures: string[] = [];
    for (const route of checked()) {
      for (const [label, headers] of [
        ["a foreign Origin", { origin: "https://evil.example" }],
        ["an opaque Origin", { origin: "null" }],
        ["a look-alike Origin", { origin: `${PUBLIC_ORIGIN}.evil.example` }],
        ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }]
      ] as Array<[string, Record<string, string>]>) {
        const callsBefore = fake.calls.length;
        const res = await call(route, { ...validCredential(route), ...headers });
        const error = res.statusCode === 403 ? (res.json() as { error?: string }).error : undefined;
        if (error !== "cross_site_request_forbidden") failures.push(`${key(route)} with ${label}: ${res.statusCode}`);
        const touched = fake.calls.slice(callsBefore).filter((name) => !CREDENTIAL_LOOKUPS.has(name));
        if (touched.length > 0) failures.push(`${key(route)} with ${label}: reached the handler (${touched.join(", ")})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("the portal's own origin and callers that send no Origin are let through to the route", async () => {
    const failures: string[] = [];
    for (const route of checked()) {
      for (const headers of [{ origin: PUBLIC_ORIGIN }, { origin: "tauri://localhost" }, { "sec-fetch-site": "same-origin" }]) {
        const res = await call(route, { ...validCredential(route), ...headers });
        if (res.statusCode === 403 && res.body.includes("cross_site_request_forbidden")) failures.push(`${key(route)} with ${JSON.stringify(headers)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("only the Apple form-post callback is exempt, and it is a registered public route", async () => {
    expect([...security.CSRF_EXEMPT_ROUTES]).toEqual(["/auth/oauth/apple/callback"]);
    const res = await call({ method: "POST", url: "/auth/oauth/apple/callback" }, { origin: "https://appleid.apple.com" });
    expect(res.body).not.toContain("cross_site_request_forbidden");
    expect("POST /auth/oauth/apple/callback" in PUBLIC).toBe(true);
  });
});

describe("portal rate-limit inventory (#17)", () => {
  const limitOf = (route: { opts: RouteOpts }) => route.opts.config?.rateLimit;

  it("every public state-changing route carries a rate limit", () => {
    const unlimited = routes
      .filter((route) => isPublic(route) && STATE_CHANGING.has(route.method) && !(key(route) in NO_RATE_LIMIT))
      .filter((route) => !limitOf(route))
      .map(key);
    expect(unlimited).toEqual([]);
    for (const entry of Object.keys(NO_RATE_LIMIT)) {
      expect(limitOf(routes.find((route) => key(route) === entry)!), `${entry} now has a limit: drop it from NO_RATE_LIMIT`).toBeUndefined();
    }
  });

  it("every sign-in route, including the emailed-link and OAuth GETs, carries the auth limit or a stricter one", () => {
    const signIn = routes.filter((route) => isPublic(route) && route.method !== "HEAD" && /^\/(auth|agents)\//.test(route.url) && !["/auth/logout", "/auth/capabilities"].includes(route.url));
    expect(signIn.length).toBeGreaterThan(15);
    const loose = signIn.filter((route) => !(Number(limitOf(route)?.max) <= security.AUTH_RATE_LIMIT.max)).map(key);
    expect(loose).toEqual([]);
    for (const url of ["/auth/password/forgot", "/auth/password/reset"]) {
      expect(limitOf(routes.find((route) => route.url === url && route.method === "POST")!)).toMatchObject(security.PASSWORD_RESET_RATE_LIMIT);
    }
  });

  it("logout and connecting a sign-in provider carry the sign-in limit", () => {
    for (const entry of ["POST /auth/logout", "POST /auth/oauth/:provider/connect"]) {
      const route = routes.find((r) => key(r) === entry);
      expect(route, entry).toBeDefined();
      expect(limitOf(route!), entry).toMatchObject(security.AUTH_RATE_LIMIT);
    }
  });

  it("every state-changing wallet route carries the wallet limit", () => {
    const wallet = routes.filter((route) => route.url.startsWith("/wallet/") && STATE_CHANGING.has(route.method));
    expect(wallet.map(key).sort()).toEqual([
      "POST /wallet/payout-destination/callback/confirm",
      "POST /wallet/payouts/withdraw",
      "POST /wallet/send/mfa/confirm",
      "POST /wallet/send/mfa/start",
      "PUT /wallet/payout-destination"
    ]);
    for (const route of wallet) expect(limitOf(route), key(route)).toMatchObject(security.WALLET_RATE_LIMIT);
  });

  it("the limits are enforced on the real server: the sixth wallet MFA attempt from one address is refused", async () => {
    const route = { method: "POST", url: "/wallet/send/mfa/confirm" };
    const ip = "203.0.113.7";
    const statuses: number[] = [];
    for (let i = 0; i < security.WALLET_RATE_LIMIT.max + 1; i++) statuses.push((await call(route, cookie("no-such-session"), ip)).statusCode);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // A signed-in caller is limited the same way (the limit is per address, not per session).
    expect((await call(route, cookie("user-session"), ip)).statusCode).toBe(429);
    expect((await call(route, cookie("no-such-session"), "203.0.113.8")).statusCode).toBe(401);
  });

  it("the eleventh sign-in attempt from one address is refused", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < security.AUTH_RATE_LIMIT.max + 1; i++) {
      const res = await app.inject({ method: "POST", url: "/auth/login", remoteAddress: "203.0.113.9", payload: { email: "user@example.com", password: "wrong-password-1" } });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("session and wallet-challenge expiry is enforced in the store (#17)", () => {
  function recordingStore(rows: unknown[] = []) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return { rows, rowCount: rows.length };
      }
    };
    return { store: new PortalStoreClass(pool as never), queries };
  }

  it("a session is looked up by token hash and only while unexpired", async () => {
    const { store, queries } = recordingStore();
    const before = Date.now();
    expect(await store.getSessionByTokenHash("hash-1")).toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("WHERE token_hash = $1 AND expires_at_ms > $2");
    expect(queries[0].params[0]).toBe("hash-1");
    expect(Number(queries[0].params[1])).toBeGreaterThanOrEqual(before);
    expect(Number(queries[0].params[1])).toBeLessThanOrEqual(Date.now());
  });

  it("a wallet send challenge is consumed atomically, once, and only while unexpired", async () => {
    const { store, queries } = recordingStore();
    const before = Date.now();
    expect(await store.consumeWalletSendMfaChallenge("challenge-1", "u-owner")).toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/^UPDATE portal_wallet_send_mfa_challenges SET consumed_at_ms = \$2 WHERE challenge_id = \$1 AND user_id = \$3 AND consumed_at_ms IS NULL AND expires_at_ms > \$2 RETURNING /);
    expect(queries[0].params[0]).toBe("challenge-1");
    expect(queries[0].params[2]).toBe("u-owner");
    expect(Number(queries[0].params[1])).toBeGreaterThanOrEqual(before);
  });
});
