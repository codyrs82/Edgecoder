// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Brand-account posting (src/social) on the portal: the admin API behind Settings > Social posts
 * and the scheduled jobs that draft and send.
 *
 * Admin API (system admins). Auth is the portal session: the browser's session cookie, or the same
 * session token as `Authorization: Bearer <token>` for scripts (getCurrentUser). State changes go
 * through the portal's CSRF origin check (a browser must be same-origin; a script sends no Origin):
 *   GET  /portal/api/admin/social                       switch, X / Nostr configured (booleans), queue, recent
 *   POST /portal/api/admin/social/settings              { enabled }: the pause switch
 *   POST /portal/api/admin/social/check                 { text }: rule problems and length, for the editor
 *   POST /portal/api/admin/social/drafts                { text, threadId?, position?, scheduledAt? | scheduledAtLocal? }
 *   POST /portal/api/admin/social/import                { posts: [{ text, key?, scheduledAt? | scheduledAtLocal?, threadKey?, position?, images? }] }
 *   POST /portal/api/admin/social/posts/:id/edit        { text }
 *   POST /portal/api/admin/social/posts/:id/approve     { text? }: approve (and send when sending is on and it is due); a thread post approves its thread
 *   POST /portal/api/admin/social/posts/:id/reject
 *   POST /portal/api/admin/social/posts/:id/schedule    { scheduledAt | scheduledAtLocal } (null or "" clears); a thread post moves its thread
 *   POST /portal/api/admin/social/posts/:id/thread      { threadId (null: none), position? }
 *   POST /portal/api/admin/social/posts/:id/images      { filename, base64, alt? }: PNG/JPEG, at most 5 MB, 4 per post
 *   POST /portal/api/admin/social/posts/:id/images/:imageId/delete
 *   GET  /portal/api/admin/social/images/:imageId       the image bytes (thumbnails)
 *   POST /portal/api/admin/social/threads/:threadId/approve
 *   POST /portal/api/admin/social/run                   run the drafting job now (nothing while paused)
 *
 * scheduledAt is ISO 8601 UTC (Z or an offset); scheduledAtLocal is America/Chicago wall time
 * (YYYY-MM-DDTHH:mm). Responses never carry a credential: X and Nostr show only whether they are
 * configured.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { request } from "undici";
import { z } from "zod";
import { RELEASE_API_URL } from "../install/update.js";
import { socialConfigFromEnv, type SocialConfig } from "../social/config.js";
import { MAX_ALT_CHARS, MAX_IMAGE_BYTES, MAX_IMAGES_PER_POST, parseSchedule, SCHEDULE_TIME_ZONE, utcMsToChicagoLocal } from "../social/media.js";
import { noteBech32 } from "../social/nostr-brand.js";
import { xWeightedLength, X_MAX_WEIGHTED } from "../social/rules.js";
import { SocialService, THREAD_ID_RE, type ImportItem, type PostView, type SocialServiceDeps } from "../social/service.js";
import { MemorySocialStore, PostgresSocialStore } from "../social/store.js";
import { tweetUrl } from "../social/x-client.js";
import { loadMergedNetwork, type NetworkAdminRoutesDeps } from "./routes/network-admin.js";
import { DEFAULT_PUBLIC_DOCS_URL, siteOrigin } from "./pages/seo.js";

type User = { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean };

export interface SocialRoutesDeps {
  service: SocialService;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<User | null>;
  buildAccessContext: (user: User) => Promise<{ isSystemAdmin: boolean }>;
}

/** One image as base64 is 4/3 of 5 MB plus the JSON around it. */
export const IMAGE_BODY_LIMIT = 8 * 1024 * 1024;
/** The bulk import: several posts with images. Larger plans go in several requests. */
export const IMPORT_BODY_LIMIT = 48 * 1024 * 1024;
export const MAX_IMPORT_POSTS = 200;

const schedule = {
  scheduledAt: z.string().max(40).nullable().optional(),
  scheduledAtLocal: z.string().max(40).nullable().optional()
};
const threadIdSchema = z.string().regex(THREAD_ID_RE);
const textBody = z.object({ text: z.string().min(1).max(2_000) });
const draftBody = z.object({ text: z.string().min(1).max(2_000), threadId: threadIdSchema.nullable().optional(), position: z.number().int().min(1).max(1_000).optional(), ...schedule });
const approveBody = z.object({ text: z.string().min(1).max(2_000).optional() });
const settingsBody = z.object({ enabled: z.boolean() });
const scheduleBody = z.object(schedule);
const threadBody = z.object({ threadId: threadIdSchema.nullable(), position: z.number().int().min(1).max(1_000).optional() });
const imageBody = z.object({ filename: z.string().min(1).max(255), base64: z.string().min(1).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 128), alt: z.string().max(MAX_ALT_CHARS).nullable().optional() });
const importBody = z.object({
  posts: z
    .array(
      z.object({
        text: z.string().min(1).max(2_000),
        key: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/).optional(),
        threadKey: threadIdSchema.optional(),
        position: z.number().int().min(1).max(1_000).optional(),
        images: z.array(imageBody).max(MAX_IMAGES_PER_POST).optional(),
        ...schedule
      })
    )
    .min(1)
    .max(MAX_IMPORT_POSTS)
});
const idParam = z.object({ id: z.string().uuid() });
const imageParam = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });
const threadParam = z.object({ threadId: threadIdSchema });

function present(p: PostView) {
  return {
    ...p,
    dedupeHash: undefined,
    length: xWeightedLength(p.text),
    maxLength: X_MAX_WEIGHTED,
    scheduledAtLocal: p.scheduledAtMs !== null ? utcMsToChicagoLocal(p.scheduledAtMs) : null,
    scheduleTimeZone: SCHEDULE_TIME_ZONE,
    images: (p.images ?? []).map((i) => ({ ...i, url: `/portal/api/admin/social/images/${i.id}` })),
    xUrl: p.xTweetId ? tweetUrl(p.xTweetId) : null,
    nostrNoteId: p.nostrEventId ? noteBech32(p.nostrEventId) : null,
    nostrUrl: p.nostrEventId ? `https://njump.me/${noteBech32(p.nostrEventId)}` : null
  };
}

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

export function registerSocialRoutes(app: FastifyInstance, d: SocialRoutesDeps): void {
  const svc = d.service;
  async function gate(req: unknown, reply: Reply): Promise<{ email: string } | null> {
    const user = await d.getCurrentUser(req as never);
    if (!user) {
      reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    if (!(await d.buildAccessContext(user)).isSystemAdmin) {
      reply.code(403).send({ error: "admin_only" });
      return null;
    }
    return { email: user.email };
  }
  const parseId = (params: unknown) => idParam.safeParse(params ?? {});
  const statusOf = (error: string) => (error === "not_found" ? 404 : error === "rule_problems" || error === "empty" ? 422 : 409);
  const result = async (r: Awaited<ReturnType<SocialService["approve"]>>, reply: Reply) => {
    if (r.ok) return { ok: true, post: present(await svc.viewOf(r.post)), note: r.note ?? null };
    return reply.code(statusOf(r.error)).send({ ok: false, error: r.error, problems: r.problems ?? [], post: r.post ? present(await svc.viewOf(r.post)) : null });
  };

  app.get("/portal/api/admin/social", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const [settings, send, queue, recent] = await Promise.all([svc.settings(), svc.canSend(), svc.queue(), svc.recent()]);
    reply.header("cache-control", "no-store");
    return { settings, sending: send, channels: svc.channels(), queue: queue.map(present), recent: recent.map(present), scheduleTimeZone: SCHEDULE_TIME_ZONE, generatedAtMs: Date.now() };
  });

  app.post("/portal/api/admin/social/settings", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = settingsBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const settings = await svc.setEnabled(parsed.data.enabled, who.email);
    req.log.info({ enabled: settings.enabled }, "admin_social_switch");
    return { ok: true, settings, sending: await svc.canSend() };
  });

  app.post("/portal/api/admin/social/check", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const parsed = textBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return { problems: await svc.problems(parsed.data.text), length: xWeightedLength(parsed.data.text), maxLength: X_MAX_WEIGHTED };
  });

  app.post("/portal/api/admin/social/drafts", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const parsed = draftBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const when = parseSchedule(parsed.data);
    if (!when.ok) return reply.code(400).send({ error: when.error });
    return result(await svc.compose(parsed.data.text, { threadId: parsed.data.threadId ?? null, threadPosition: parsed.data.position ?? null, scheduledAtMs: when.ms ?? null }), reply);
  });

  app.post("/portal/api/admin/social/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = importBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) });
    const items: ImportItem[] = [];
    const errors: Array<{ index: number; error: string }> = [];
    for (const [index, p] of parsed.data.posts.entries()) {
      const when = parseSchedule(p);
      if (!when.ok) {
        errors.push({ index, error: when.error });
        continue;
      }
      items.push({ text: p.text, key: p.key, threadKey: p.threadKey, position: p.position, scheduledAtMs: when.ms ?? null, images: p.images ?? [] });
    }
    if (errors.length) return reply.code(400).send({ error: "invalid_request", errors });
    const r = await svc.importPosts(items);
    req.log.info({ created: r.created.length, existing: r.existing.length, errors: r.errors.length }, "admin_social_import");
    return { ok: r.errors.length === 0, ...r };
  });

  app.post("/portal/api/admin/social/posts/:id/edit", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const id = parseId(req.params);
    const parsed = textBody.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return result(await svc.edit(id.data.id, parsed.data.text), reply);
  });

  app.post("/portal/api/admin/social/posts/:id/approve", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const id = parseId(req.params);
    const parsed = approveBody.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return result(await svc.approve(id.data.id, who.email, parsed.data.text), reply);
  });

  app.post("/portal/api/admin/social/threads/:threadId/approve", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const t = threadParam.safeParse(req.params ?? {});
    if (!t.success) return reply.code(400).send({ error: "invalid_request" });
    return result(await svc.approveThread(t.data.threadId, who.email), reply);
  });

  app.post("/portal/api/admin/social/posts/:id/reject", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const id = parseId(req.params);
    if (!id.success) return reply.code(400).send({ error: "invalid_request" });
    return result(await svc.reject(id.data.id), reply);
  });

  app.post("/portal/api/admin/social/posts/:id/schedule", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const id = parseId(req.params);
    const parsed = scheduleBody.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const when = parseSchedule(parsed.data);
    if (!when.ok) return reply.code(400).send({ error: when.error });
    if (when.ms === undefined) return reply.code(400).send({ error: "scheduled_at_missing (send null to clear)" });
    return result(await svc.setSchedule(id.data.id, when.ms), reply);
  });

  app.post("/portal/api/admin/social/posts/:id/thread", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const id = parseId(req.params);
    const parsed = threadBody.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return result(await svc.setThread(id.data.id, parsed.data.threadId, parsed.data.position ?? null), reply);
  });

  app.post("/portal/api/admin/social/posts/:id/images", { bodyLimit: IMAGE_BODY_LIMIT }, async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const id = parseId(req.params);
    const parsed = imageBody.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const r = await svc.addImage(id.data.id, parsed.data);
    if (!r.ok) return reply.code(r.error === "not_found" ? 404 : r.error === "not_editable" || r.error === "too_many_images" ? 409 : 422).send({ ok: false, error: r.error, problems: r.problems ?? [] });
    return { ok: true, image: { ...r.image, url: `/portal/api/admin/social/images/${r.image.id}` } };
  });

  app.post("/portal/api/admin/social/posts/:id/images/:imageId/delete", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const p = imageParam.safeParse(req.params ?? {});
    if (!p.success) return reply.code(400).send({ error: "invalid_request" });
    const r = await svc.removeImage(p.data.id, p.data.imageId);
    if (!r.ok) return reply.code(r.error === "not_found" ? 404 : 409).send({ ok: false, error: r.error });
    return { ok: true };
  });

  app.get("/portal/api/admin/social/images/:imageId", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const p = z.object({ imageId: z.string().uuid() }).safeParse(req.params ?? {});
    if (!p.success) return reply.code(400).send({ error: "invalid_request" });
    const img = await svc.store.getImage(p.data.imageId);
    if (!img) return reply.code(404).send({ error: "not_found" });
    reply.header("cache-control", "private, no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-disposition", "inline");
    return reply.type(img.contentType).send(Buffer.from(img.bytes));
  });

  app.post("/portal/api/admin/social/run", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    return { ok: true, ...(await svc.tick()) };
  });
}

// ── Wiring ──

const MAX_TEXT_BYTES = 4 << 20;
/** How often approved posts are checked for their send time (a cheap indexed query). */
export const SOCIAL_DUE_CHECK_MS = 60_000;

async function getText(url: string, headers: Record<string, string>, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": "edgecoder-portal", ...headers }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return null;
    const text = await res.text();
    return text.length > MAX_TEXT_BYTES ? null : text;
  } catch {
    return null;
  }
}

/** The service, the admin routes now, and the jobs once the portal listens (start()). */
export function setupPortalSocial(
  app: FastifyInstance,
  d: Pick<NetworkAdminRoutesDeps, "coordinatorAdminToken" | "EXTERNAL_HTTP_TIMEOUT_MS" | "coordinatorUrls" | "getCurrentUser" | "buildAccessContext" | "lookupOwners"> & { pool: Pool | null },
  envConfig: SocialConfig = socialConfigFromEnv(),
  overrides: Partial<Pick<SocialServiceDeps, "fetch" | "publishNostr" | "sources">> = {}
) {
  // The weekly report links the public site; new docs pages come from the public docs site's sitemap unless SOCIAL_DOCS_SITEMAP_URL says otherwise.
  const config: SocialConfig = { ...envConfig, siteUrl: envConfig.siteUrl ?? `${siteOrigin()}/`, docsSitemapUrl: envConfig.docsSitemapUrl ?? new URL("sitemap.xml", DEFAULT_PUBLIC_DOCS_URL).href };
  const timeoutMs = d.EXTERNAL_HTTP_TIMEOUT_MS;
  const adminRevenue = async () => {
    if (!d.coordinatorAdminToken) return null;
    const base = (await d.coordinatorUrls())[0]?.replace(/\/+$/, "");
    if (!base) return null;
    const res = await request(`${base}/admin/revenue`, { method: "GET", headers: { "x-admin-token": d.coordinatorAdminToken }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    const text = await res.body.text();
    return res.statusCode === 200 ? JSON.parse(text) : null;
  };
  const service = new SocialService({
    store: d.pool ? new PostgresSocialStore(d.pool) : new MemorySocialStore(),
    config,
    log: app.log,
    sources: {
      network: d.coordinatorAdminToken ? () => loadMergedNetwork(d, "7d") : undefined,
      revenue: d.coordinatorAdminToken ? adminRevenue : undefined,
      releases: async () => {
        const text = await getText(RELEASE_API_URL, { accept: "application/vnd.github+json" }, 8_000);
        return text ? JSON.parse(text) : null;
      },
      fetchText: (url) => getText(url, {}, 8_000),
      ...overrides.sources
    },
    fetch: overrides.fetch,
    publishNostr: overrides.publishNostr
  });
  registerSocialRoutes(app, { service, getCurrentUser: d.getCurrentUser, buildAccessContext: d.buildAccessContext });
  let timer: ReturnType<typeof setInterval> | null = null;
  let dueTimer: ReturnType<typeof setInterval> | null = null;
  const failed = (error: unknown) => app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "social_tick_failed");
  // Drafting (and sending) on SOCIAL_TICK_MINUTES; due checks every minute.
  const run = () => service.tick().then((r) => (r.drafted || r.sent ? app.log.info(r, "social_tick") : undefined), failed);
  const runDue = () => service.sendDue().then((sent) => (sent ? app.log.info({ sent }, "social_due_sent") : undefined), failed);
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    if (dueTimer) clearInterval(dueTimer);
    timer = null;
    dueTimer = null;
  });
  return {
    service,
    start: () => {
      if (timer) return;
      timer = setInterval(run, config.tickMs);
      timer.unref?.();
      dueTimer = setInterval(runDue, SOCIAL_DUE_CHECK_MS);
      dueTimer.unref?.();
      app.log.info({ tickMs: config.tickMs, dueCheckMs: SOCIAL_DUE_CHECK_MS, sendEnabledEnv: config.sendEnabled, x: config.x !== null, nostr: service.channels().nostr.configured }, "social_job_started");
    }
  };
}
