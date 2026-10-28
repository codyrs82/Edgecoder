// #10: portal security headers (helmet), CSRF origin checks and per-route rate limits.
// Kept separate from server.ts so it can be tested with a small Fastify app.
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Login/signup/verification/passkey/OAuth: 10 requests per minute per client IP. */
export const AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
/** Wallet send + MFA: 5 requests per minute per client IP. */
export const WALLET_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;

const AUTH_ROUTES: RegExp[] = [
  /^\/auth\/signup$/,
  /^\/auth\/login$/,
  /^\/auth\/resend-verification$/,
  /^\/auth\/passkey\//,
  /^\/auth\/oauth\/[^/]+\/callback$/,
  /^\/auth\/oauth\/mobile\/complete$/,
];
// Only the send-code start and confirm steps (POST). GET /wallet/send/requests (the wallet
// page's list) must not share this bucket.
const WALLET_ROUTES: RegExp[] = [/^\/wallet\/send\/mfa\/(start|confirm)$/];

/**
 * The only legitimate cross-site POST: Apple's OAuth uses response_mode=form_post, so
 * appleid.apple.com POSTs the callback (currently disabled; kept for when Apple returns).
 * Google, Microsoft and GitHub return by GET redirect, so the generic
 * /auth/oauth/:provider/callback is NOT exempt (that would allow login CSRF).
 */
export const CSRF_EXEMPT_ROUTES = new Set(["/auth/oauth/apple/callback"]);

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function rateLimitFor(url: string, method: string | string[] = "POST"): { max: number; timeWindow: string } | undefined {
  const methods = (Array.isArray(method) ? method : [method]).map((m) => m.toUpperCase());
  if (methods.includes("POST") && WALLET_ROUTES.some((r) => r.test(url))) return WALLET_RATE_LIMIT;
  if (AUTH_ROUTES.some((r) => r.test(url))) return AUTH_RATE_LIMIT;
  return undefined;
}

/** PORTAL_TRUST_PROXY_HOPS: a positive integer, else 1 (Fly). */
export function trustProxyHops(raw: string | undefined): number {
  const n = Number(raw ?? 1);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Same-origin form posts when the portal is reached on a host other than PORTAL_PUBLIC_URL. */
function sameHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

export interface PortalSecurityOptions {
  /** Origin of PORTAL_PUBLIC_URL, e.g. https://edgecoder.io */
  publicOrigin: string;
  /** Extra origins allowed to make state-changing requests (the desktop CORS origins). */
  trustedOrigins: string[];
  /** Extra connect-src origins (PORTAL_CONNECT_ORIGINS). */
  connectOrigins?: string[];
  /** Enforce the CSP instead of sending it as Report-Only (first release ships report-only). */
  enforceCsp?: boolean;
}

/**
 * Register helmet, the CSRF origin check and rate limits on `app`.
 * Must be awaited **before** any route is declared, so the onRoute hook can attach the
 * per-route rate-limit config.
 */
export async function registerPortalSecurity(app: FastifyInstance, opts: PortalSecurityOptions): Promise<void> {
  // Runs before @fastify/rate-limit's own onRoute hook (registered next), so the config is seen.
  app.addHook("onRoute", (route) => {
    const limit = rateLimitFor(route.url ?? route.path ?? "", route.method);
    if (limit && !(route.config as { rateLimit?: unknown } | undefined)?.rateLimit) {
      route.config = { ...(route.config ?? {}), rateLimit: limit } as typeof route.config;
    }
  });
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req: FastifyRequest) => req.ip,
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: "rate_limited", retryAfter: ctx.after }),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      reportOnly: !opts.enforceCsp,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
        "connect-src": ["'self'", ...(opts.connectOrigins ?? [])],
        "frame-ancestors": ["'none'"],
        "upgrade-insecure-requests": opts.enforceCsp ? [] : null,
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    frameguard: { action: "deny" },
    crossOriginEmbedderPolicy: false,
    // OAuth providers (Google, Microsoft) may use popups; same-origin would break them.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    // The desktop app (tauri:// origin) loads portal API responses cross-origin.
    crossOriginResourcePolicy: false,
  });

  const trusted = new Set([opts.publicOrigin, ...opts.trustedOrigins].map((o) => o.toLowerCase()));
  app.addHook("onRequest", async (req, reply) => {
    if (!STATE_CHANGING.has(req.method)) return;
    if (CSRF_EXEMPT_ROUTES.has(req.routeOptions.url ?? "")) return;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin.toLowerCase() : "";
    if (origin) {
      if (trusted.has(origin) || sameHost(origin, req.headers.host)) return;
      return reply.code(403).send({ error: "cross_site_request_forbidden" });
    }
    // No Origin: server-to-server callers (agents, coordinators, webhooks) send neither header.
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "cross_site_request_forbidden" });
    }
  });
}
