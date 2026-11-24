// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Growth signals on the portal (src/growth): which X posts and ads bring people, and who signs up.
 *
 * - Visits: a GET of a public HTML page with utm_* tags, or the /x/<campaign> short link, counts
 *   once per visitor per campaign per Chicago day (the `ec_utm` cookie, src/growth/attribution.ts)
 *   in the aggregate table growth_utm_daily. Robots and HEAD requests are not counted. Nothing per
 *   person is stored for a visit.
 * - Sign-ups: a new human account (email and password, or Google / Microsoft / GitHub; never an
 *   agent account) gets its first-touch campaign from the cookie, is counted for that campaign, and
 *   is emailed to ALERT_EMAILS at once unless SIGNUP_ALERT_IGNORE matches it. At most
 *   SIGNUP_ALERTS_PER_HOUR single alerts go out per hour; the rest are held and sent as one message.
 *   Never blocks or fails the sign-up: everything runs after it, errors are only logged.
 * - The daily digest: at 8:00 America/Chicago, yesterday's visits and sign-ups by campaign and the
 *   new sign-ups, to ALERT_EMAILS. Sent even when there is nothing (one line).
 *
 * Admin API (system admins, session; the Traffic from X panel on Settings > Social posts):
 *   GET /portal/api/admin/growth   the last 14 days by campaign, with the post each campaign is in
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { alertConfigFromEnv } from "../alerting/config.js";
import { postResendEmail, type ResendMessage } from "../common/resend.js";
import {
  UTM_COOKIE,
  chicagoDay,
  chicagoHour,
  decideVisit,
  decodeUtmCookie,
  encodeUtmCookie,
  previousDay,
  utmCookieMaxAgeSeconds,
  utmFromQuery,
  type Utm
} from "../growth/attribution.js";
import { emailIgnored, growthConfigFromEnv, type GrowthConfig } from "../growth/config.js";
import { digestEmail, postsByCampaign, signupAlertEmail, signupBatchEmail, type Email, type PostRef } from "../growth/report.js";
import { MemoryGrowthStore, PostgresGrowthStore, type GrowthStore } from "../growth/store.js";
import { PostgresSocialStore, type SocialPost } from "../social/store.js";
import { appendSetCookie } from "./oauth-state-cookie.js";
import { encodeCookie, parseCookies, readCookie } from "./portal-utils.js";

type User = { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean };

export const SIGNUP_ALERTS_PER_HOUR = 10;
/** Held alerts wait this long (so a burst lands in one message), then go at most once an hour. */
export const SIGNUP_BATCH_DELAY_MS = 15 * 60_000;
export const DIGEST_HOUR_CHICAGO = 8;
export const GROWTH_PANEL_DAYS = 14;
export const GROWTH_TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
const POSTS_CACHE_MS = 5 * 60_000;

export type SignupMethod = "email" | "google" | "microsoft" | "github";

export interface SignupEvent {
  userId: string;
  email: string;
  method: SignupMethod | string;
  /** The request's Cookie header (the first-touch campaign is read from it). */
  cookieHeader: string | undefined;
}

export interface PortalGrowthDeps {
  pool: Pool | null;
  portalUrl: string;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<User | null>;
  buildAccessContext: (user: User) => Promise<{ isSystemAdmin: boolean }>;
  // Overridable for tests.
  store?: GrowthStore;
  config?: GrowthConfig;
  /** null: no alert email (ALERT_EMAILS or Resend unset, or alerting off). */
  send?: ((e: Email) => Promise<void>) | null;
  socialPosts?: () => Promise<SocialPost[]>;
  now?: () => number;
}

/** The Resend sender for ALERT_EMAILS, or null when mail is not configured. */
function alertMailer(): ((e: Email) => Promise<void>) | null {
  const c = alertConfigFromEnv();
  if (!c.enabled || !c.resendApiKey || !c.resendFromEmail || c.emails.length === 0) return null;
  return (e) => postResendEmail({ apiKey: c.resendApiKey, from: c.resendFromEmail, to: c.emails, subject: e.subject, html: e.html, text: e.text } satisfies ResendMessage, "growth_email");
}

/** The campaign of a response: its query tags, or for the short link the tags it redirects to. */
function responseUtm(req: FastifyRequest, reply: FastifyReply): Utm | null {
  if (reply.statusCode >= 400) return null;
  const route = req.routeOptions?.url ?? "";
  if (route === "/x/:campaign") {
    const to = reply.getHeader("location");
    if (typeof to !== "string" || !to.startsWith("/")) return null;
    return utmFromQuery(Object.fromEntries(new URL(to, "http://x").searchParams));
  }
  if (reply.statusCode >= 300) return null;
  if (route.startsWith("/portal/api/") || route.startsWith("/internal/")) return null;
  if (!String(reply.getHeader("content-type") ?? "").includes("text/html")) return null;
  return utmFromQuery(req.query as Record<string, unknown>);
}

export function setupPortalGrowth(app: FastifyInstance, d: PortalGrowthDeps) {
  const store: GrowthStore = d.store ?? (d.pool ? new PostgresGrowthStore(d.pool) : new MemoryGrowthStore());
  const config = d.config ?? growthConfigFromEnv();
  const send = d.send === undefined ? alertMailer() : d.send;
  const now = d.now ?? Date.now;
  const base = d.portalUrl.replace(/\/+$/, "");
  const panelUrl = `${base}/portal/settings/social#traffic`;
  const adminUserUrl = (email: string) => `${base}/portal/settings/admin?user=${encodeURIComponent(email)}`;
  const socialStore = d.pool ? new PostgresSocialStore(d.pool) : null;
  const loadPosts = d.socialPosts ?? (async () => (socialStore ? socialStore.list(["posted", "posting", "approved", "draft", "failed"], 500) : []));
  let postsCache: { at: number; map: Map<string, PostRef> } | null = null;
  const posts = async (): Promise<Map<string, PostRef>> => {
    if (postsCache && now() - postsCache.at < POSTS_CACHE_MS) return postsCache.map;
    const map = postsByCampaign(await loadPosts().catch(() => []));
    postsCache = { at: now(), map };
    return map;
  };
  const warn = (msg: string) => (error: unknown) => app.log.warn({ error: error instanceof Error ? error.message : String(error) }, msg);
  const ignored = (email: string) => emailIgnored(email, config.ignore);

  // Visits: after the page is rendered, before it is sent (the cookie rides on the response).
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET" && req.method !== "HEAD") return payload;
    try {
      const utm = responseUtm(req, reply);
      if (!utm) return payload;
      const t = now();
      const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
      const v = decideVisit({ method: req.method, utm, userAgent: req.headers["user-agent"], cookie: readCookie(cookies, UTM_COOKIE), nowMs: t });
      if (v.count) void store.addVisit(v.day, v.count).catch(warn("growth_visit_failed"));
      if (v.cookie) {
        appendSetCookie(reply, encodeCookie(UTM_COOKIE, encodeUtmCookie(v.cookie), utmCookieMaxAgeSeconds(v.cookie, t)));
        // A response that sets a visitor's cookie must not be shared by a cache.
        reply.header("cache-control", "private, no-store");
      }
    } catch (error) {
      warn("growth_visit_failed")(error);
    }
    return payload;
  });

  async function handleSignup(e: SignupEvent): Promise<void> {
    const t = now();
    const cookie = decodeUtmCookie(readCookie(parseCookies(e.cookieHeader), UTM_COOKIE), t);
    const first = cookie?.first ?? null;
    const isIgnored = ignored(e.email);
    const alertState = isIgnored ? "ignored" : send ? "pending" : "off";
    const inserted = await store.recordSignup({ userId: e.userId, email: e.email, method: e.method, createdAtMs: t, day: chicagoDay(t), first, ignored: isIgnored, alertState });
    if (!inserted || alertState !== "pending" || !send) return;
    // Over the hourly limit: held, and sent with the next batch (tick).
    if (!(await store.claimSignupAlert(e.userId, t, t - HOUR_MS, SIGNUP_ALERTS_PER_HOUR))) return;
    const post = first && first.source === "x" ? ((await posts()).get(first.campaign) ?? null) : null;
    await send(signupAlertEmail({ email: e.email, method: e.method, createdAtMs: t, first, post, adminUrl: adminUserUrl(e.email) }));
  }

  /** One minute's work: held alerts and the daily digest. Safe on several machines at once. */
  async function tick(): Promise<{ batched: number; digest: string | null }> {
    const out = { batched: 0, digest: null as string | null };
    if (!send) return out;
    const t = now();
    const pending = await store.pendingSummary();
    if (pending.count && pending.oldestMs !== null && t - pending.oldestMs >= SIGNUP_BATCH_DELAY_MS) {
      const batch = (await store.claimPendingBatch(t, HOUR_MS)).map((s) => ({ ...s, ignoredNow: ignored(s.email) }));
      out.batched = batch.filter((s) => !s.ignoredNow).length;
      if (out.batched) await send(signupBatchEmail(batch, `${base}/portal/settings/admin`));
    }
    if (chicagoHour(t) >= DIGEST_HOUR_CHICAGO) {
      const day = previousDay(chicagoDay(t));
      if (await store.claimDay("digest_day", day, t)) {
        const [rows, signups] = await Promise.all([store.dailyRows(day, day), store.signupsOn(day)]);
        await send(digestEmail({ day, rows, signups, isIgnored: ignored, posts: await posts(), panelUrl }));
        out.digest = day;
      }
    }
    return out;
  }

  app.get("/portal/api/admin/growth", async (req, reply) => {
    const user = await d.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    if (!(await d.buildAccessContext(user)).isSystemAdmin) return reply.code(403).send({ error: "admin_only" });
    const today = chicagoDay(now());
    const days = [today];
    while (days.length < GROWTH_PANEL_DAYS) days.push(previousDay(days[days.length - 1]!));
    const from = days[days.length - 1]!;
    const [rows, signups, map] = await Promise.all([store.dailyRows(from, today), store.signupsSince(from), posts()]);
    const withPost = rows
      .sort((a, b) => (a.day === b.day ? b.visits - a.visits || b.signups - a.signups : a.day < b.day ? 1 : -1))
      .map((r) => ({ ...r, post: r.source === "x" ? (map.get(r.campaign) ?? null) : null }));
    const signupsByDay = days.map((day) => {
      const s = signups.find((x) => x.day === day);
      return { day, total: s?.total ?? 0, attributed: s?.attributed ?? 0 };
    });
    reply.header("cache-control", "no-store");
    return {
      timeZone: "America/Chicago",
      days,
      rows: withPost,
      signupsByDay,
      totals: {
        visits: rows.reduce((n, r) => n + r.visits, 0),
        campaignSignups: rows.reduce((n, r) => n + r.signups, 0),
        signups: signupsByDay.reduce((n, s) => n + s.total, 0)
      },
      alerts: { email: send !== null, ignorePatterns: config.ignore.length },
      generatedAtMs: now()
    };
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
  return {
    store,
    tick,
    /** Fire and forget: never throws, never delays the sign-up response. */
    onSignup(e: SignupEvent): void {
      void handleSignup(e).catch(warn("growth_signup_alert_failed"));
    },
    /** Exposed for tests: the same work as onSignup, awaited. */
    handleSignup,
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick().catch(warn("growth_tick_failed")), GROWTH_TICK_MS);
      timer.unref?.();
    }
  };
}
