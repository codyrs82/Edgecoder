// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Brand-account posting (src/social) on the portal: the admin API behind Settings > Social posts
 * and the scheduled job that drafts and sends.
 *
 * Admin API (system admins, session; state changes go through the portal's CSRF origin check):
 *   GET  /portal/api/admin/social                     switch, X / Nostr configured (booleans), queue, recent
 *   POST /portal/api/admin/social/settings            { enabled }: the pause switch
 *   POST /portal/api/admin/social/check               { text }: rule problems and length, for the editor
 *   POST /portal/api/admin/social/drafts              { text }: a manual draft
 *   POST /portal/api/admin/social/posts/:id/edit      { text }
 *   POST /portal/api/admin/social/posts/:id/approve   { text? }: approve (and send when sending is on)
 *   POST /portal/api/admin/social/posts/:id/reject
 *   POST /portal/api/admin/social/run                 run the drafting job now (nothing while paused)
 *
 * Responses never carry a credential: X and Nostr show only whether they are configured.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { request } from "undici";
import { z } from "zod";
import { RELEASE_API_URL } from "../install/update.js";
import { socialConfigFromEnv, type SocialConfig } from "../social/config.js";
import { noteBech32 } from "../social/nostr-brand.js";
import { xWeightedLength, X_MAX_WEIGHTED } from "../social/rules.js";
import { SocialService, type PostView, type SocialServiceDeps } from "../social/service.js";
import { MemorySocialStore, PostgresSocialStore } from "../social/store.js";
import { tweetUrl } from "../social/x-client.js";
import { loadMergedNetwork, type NetworkAdminRoutesDeps } from "./routes/network-admin.js";

type User = { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean };

export interface SocialRoutesDeps {
  service: SocialService;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<User | null>;
  buildAccessContext: (user: User) => Promise<{ isSystemAdmin: boolean }>;
}

const textBody = z.object({ text: z.string().min(1).max(2_000) });
const approveBody = z.object({ text: z.string().min(1).max(2_000).optional() });
const settingsBody = z.object({ enabled: z.boolean() });
const idParam = z.object({ id: z.string().uuid() });

function present(p: PostView) {
  return {
    ...p,
    dedupeHash: undefined,
    length: xWeightedLength(p.text),
    maxLength: X_MAX_WEIGHTED,
    xUrl: p.xTweetId ? tweetUrl(p.xTweetId) : null,
    nostrNoteId: p.nostrEventId ? noteBech32(p.nostrEventId) : null,
    nostrUrl: p.nostrEventId ? `https://njump.me/${noteBech32(p.nostrEventId)}` : null
  };
}

export function registerSocialRoutes(app: FastifyInstance, d: SocialRoutesDeps): void {
  const svc = d.service;
  async function gate(req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<{ email: string } | null> {
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
  const result = (r: Awaited<ReturnType<SocialService["approve"]>>, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (r.ok) return { ok: true, post: present(svc.view(r.post)), note: r.note ?? null };
    const status = r.error === "not_found" ? 404 : r.error === "rule_problems" || r.error === "empty" ? 422 : 409;
    return reply.code(status).send({ ok: false, error: r.error, problems: r.problems ?? [], post: r.post ? present(svc.view(r.post)) : null });
  };

  app.get("/portal/api/admin/social", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const [settings, send, queue, recent] = await Promise.all([svc.settings(), svc.canSend(), svc.queue(), svc.recent()]);
    reply.header("cache-control", "no-store");
    return { settings, sending: send, channels: svc.channels(), queue: queue.map(present), recent: recent.map(present), generatedAtMs: Date.now() };
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
    const parsed = textBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return result(await svc.compose(parsed.data.text), reply);
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

  app.post("/portal/api/admin/social/posts/:id/reject", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const id = parseId(req.params);
    if (!id.success) return reply.code(400).send({ error: "invalid_request" });
    return result(await svc.reject(id.data.id), reply);
  });

  app.post("/portal/api/admin/social/run", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    return { ok: true, ...(await svc.tick()) };
  });
}

// ── Wiring ──

const MAX_TEXT_BYTES = 4 << 20;

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

/** The service, the admin routes now, and the job once the portal listens (start()). */
export function setupPortalSocial(
  app: FastifyInstance,
  d: Pick<NetworkAdminRoutesDeps, "coordinatorAdminToken" | "EXTERNAL_HTTP_TIMEOUT_MS" | "coordinatorUrls" | "getCurrentUser" | "buildAccessContext" | "lookupOwners"> & { pool: Pool | null },
  config: SocialConfig = socialConfigFromEnv(),
  overrides: Partial<Pick<SocialServiceDeps, "fetch" | "publishNostr" | "sources">> = {}
) {
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
  const run = () =>
    service.tick().then(
      (r) => (r.drafted || r.sent ? app.log.info(r, "social_tick") : undefined),
      (error) => app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "social_tick_failed")
    );
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
  return {
    service,
    start: () => {
      if (timer) return;
      timer = setInterval(run, config.tickMs);
      timer.unref?.();
      app.log.info({ tickMs: config.tickMs, sendEnabledEnv: config.sendEnabled, x: config.x !== null, nostr: service.channels().nostr.configured }, "social_job_started");
    }
  };
}
