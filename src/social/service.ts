// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { SocialConfig } from "./config.js";
import { brandNostrKeys, publishNote, type NostrPostResult } from "./nostr-brand.js";
import { dedupeHash, forNostr, postProblems, stripLeadingMentions, type RuleProblem } from "./rules.js";
import { docsDraft, docsPath, docsTitle, hostSatsFromRevenue, latestReleases, networkWeekly, releaseDraft, sitemapUrls, weeklyDraft, isoWeekKey, type ReleaseProduct } from "./sources.js";
import type { NewDraft, PostStatus, SocialPost, SocialStore } from "./store.js";
import { postTweet, type FetchLike } from "./x-client.js";
import type { NostrKeys } from "../discovery/nostr.js";

/**
 * The brand-account queue: drafts from live data or the admin's compose box, admin approval
 * (always), then X and a Nostr cross-post.
 *
 *   draft ──approve──▶ approved ──send──▶ posting ──▶ posted
 *     │  ▲                │                   └────▶ failed ──edit──▶ draft
 *     │  └──edit (draft)  └──reject                     └──approve (retry)
 *     └──reject──▶ rejected
 *
 * Every send needs both switches: the admin setting (stored, default paused) and
 * SOCIAL_POSTING_ENABLED=1. Paused also stops the drafting job (it reads coordinators, GitHub and
 * the docs sitemap). The rules (src/social/rules.ts) are checked on every draft, at approval and
 * once more right before sending, with the 90-day duplicate check.
 */

export const DUPLICATE_WINDOW_MS = 90 * 86_400_000;
/** A post left "posting" this long (the machine died mid-send) is marked failed for a human to check. */
export const STUCK_POSTING_MS = 10 * 60_000;
/** At most this many new docs pages are drafted per run; the rest wait for the next run. */
export const DOCS_PER_RUN = 5;

const SETTINGS = "settings";
const RELEASES_SEEN = "releases_seen";
const DOCS_SEEN = "docs_seen";

export interface SocialSettings {
  /** The admin switch. false (the default) pauses all drafting and posting. */
  enabled: boolean;
  updatedBy?: string | null;
  updatedAtMs?: number | null;
}

type Log = { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };

export interface SocialSources {
  /** The merged admin network view over 7 days (src/portal/routes/network-admin.ts loadMergedNetwork). */
  network?: () => Promise<Parameters<typeof networkWeekly>[0]>;
  /** A coordinator's GET /admin/revenue (the Revenue page's report). */
  revenue?: () => Promise<Parameters<typeof hostSatsFromRevenue>[0]>;
  /** The GitHub releases listing (src/install/update.ts RELEASE_API_URL). */
  releases?: () => Promise<unknown>;
  /** GET a URL as text (the docs sitemap and page titles); null on any failure. */
  fetchText?: (url: string) => Promise<string | null>;
}

export interface SocialServiceDeps {
  store: SocialStore;
  config: SocialConfig;
  sources?: SocialSources;
  /** The fetch used for X (tests pass a mock). */
  fetch?: FetchLike;
  publishNostr?: (text: string, keys: NostrKeys, relays: string[]) => Promise<NostrPostResult>;
  now?: () => number;
  log?: Log;
}

export type ActionResult = { ok: true; post: SocialPost; note?: string } | { ok: false; error: string; problems?: RuleProblem[]; post?: SocialPost | null };

export interface PostView extends SocialPost {
  problems: RuleProblem[];
}

const noLog: Log = { info: () => undefined, warn: () => undefined };

export class SocialService {
  private readonly now: () => number;
  private readonly log: Log;
  private nostrKeys: NostrKeys | null = null;
  private nostrKeyError: string | null = null;
  private running = false;

  constructor(private readonly d: SocialServiceDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? noLog;
    if (d.config.nostrSecret) {
      try {
        this.nostrKeys = brandNostrKeys(d.config.nostrSecret);
      } catch (error) {
        this.nostrKeyError = error instanceof Error ? error.message : "invalid NOSTR_BRAND_NSEC";
      }
    }
  }

  get store(): SocialStore {
    return this.d.store;
  }

  async settings(): Promise<SocialSettings> {
    const s = await this.d.store.getState<SocialSettings>(SETTINGS);
    return { enabled: s?.enabled === true, updatedBy: s?.updatedBy ?? null, updatedAtMs: s?.updatedAtMs ?? null };
  }

  async setEnabled(enabled: boolean, by: string): Promise<SocialSettings> {
    const s: SocialSettings = { enabled, updatedBy: by, updatedAtMs: this.now() };
    await this.d.store.setState(SETTINGS, s, this.now());
    this.log.info({ enabled }, "social_posting_switch");
    return s;
  }

  /** Whether anything may be sent now: the admin switch and SOCIAL_POSTING_ENABLED=1. */
  async canSend(): Promise<{ ok: boolean; reason: string | null }> {
    if (!(await this.settings()).enabled) return { ok: false, reason: "paused" };
    if (!this.d.config.sendEnabled) return { ok: false, reason: "SOCIAL_POSTING_ENABLED is not 1" };
    return { ok: true, reason: null };
  }

  /** Configured status for the admin page: booleans and relay URLs only, never a credential. */
  channels() {
    return {
      sendEnabledEnv: this.d.config.sendEnabled,
      x: { configured: this.d.config.x !== null },
      nostr: { configured: this.nostrKeys !== null, invalid: this.nostrKeyError !== null, relays: this.d.config.relays }
    };
  }

  view(p: SocialPost): PostView {
    return { ...p, problems: postProblems(p.text) };
  }

  /** Rules plus the 90-day duplicate check (the post itself excluded). */
  async problems(text: string, selfId?: string): Promise<RuleProblem[]> {
    const out = postProblems(text);
    const hash = dedupeHash(text);
    const recent = await this.d.store.postedSince(this.now() - DUPLICATE_WINDOW_MS);
    if (recent.some((r) => r.id !== selfId && r.dedupeHash === hash)) out.push({ code: "duplicate", message: "The same text was posted in the last 90 days." });
    return out;
  }

  async addDraft(d: NewDraft): Promise<SocialPost | null> {
    const post = await this.d.store.insertDraft({ ...d, text: stripLeadingMentions(d.text).trim() }, this.now());
    if (post) this.log.info({ postId: post.id, kind: post.kind }, "social_draft_created");
    return post;
  }

  async compose(text: string): Promise<ActionResult> {
    const t = stripLeadingMentions(text).trim();
    if (!t) return { ok: false, error: "empty" };
    const post = await this.addDraft({ sourceKey: `manual:${randomUUID()}`, kind: "manual", text: t });
    return post ? { ok: true, post } : { ok: false, error: "not_created" };
  }

  async edit(id: string, text: string): Promise<ActionResult> {
    const t = stripLeadingMentions(text).trim();
    if (!t) return { ok: false, error: "empty" };
    const post = await this.d.store.transition(id, ["draft", "failed"], { text: t, status: "draft", error: null }, this.now());
    if (!post) return { ok: false, error: "not_editable", post: await this.d.store.get(id) };
    return { ok: true, post };
  }

  async reject(id: string): Promise<ActionResult> {
    const post = await this.d.store.transition(id, ["draft", "failed", "approved"], { status: "rejected" }, this.now());
    if (!post) return { ok: false, error: "not_rejectable", post: await this.d.store.get(id) };
    this.log.info({ postId: id }, "social_post_rejected");
    return { ok: true, post };
  }

  /**
   * Approve a draft (or retry a failed post), optionally with edited text. Refused while the text
   * breaks a rule. Sent at once when sending is allowed, else at the next run after it is.
   */
  async approve(id: string, by: string, text?: string): Promise<ActionResult> {
    const current = await this.d.store.get(id);
    if (!current) return { ok: false, error: "not_found" };
    if (current.status !== "draft" && current.status !== "failed") return { ok: false, error: "not_approvable", post: current };
    const t = text === undefined ? current.text : stripLeadingMentions(text).trim();
    if (t !== current.text) {
      const edited = await this.edit(id, t);
      if (!edited.ok) return edited;
    }
    const problems = await this.problems(t, id);
    if (problems.length) return { ok: false, error: "rule_problems", problems, post: await this.d.store.get(id) };
    const approved = await this.d.store.transition(id, ["draft", "failed"], { status: "approved", approvedBy: by, approvedAtMs: this.now(), error: null }, this.now());
    if (!approved) return { ok: false, error: "not_approvable", post: await this.d.store.get(id) };
    this.log.info({ postId: id }, "social_post_approved");
    const send = await this.canSend();
    if (!send.ok) return { ok: true, post: approved, note: `Approved. Not sent yet: ${send.reason}. It goes out at the next run once sending is on.` };
    const sent = await this.send(id);
    return { ok: true, post: sent ?? approved };
  }

  /** Send one approved post: claim it, check again, X, then Nostr. */
  async send(id: string): Promise<SocialPost | null> {
    if (!(await this.canSend()).ok) return this.d.store.get(id);
    const claimed = await this.d.store.get(id);
    if (!claimed || claimed.status !== "approved") return claimed;
    const hash = dedupeHash(claimed.text);
    const problems = await this.problems(claimed.text, id);
    if (problems.length) return this.d.store.transition(id, ["approved"], { status: "failed", error: `Refused before sending: ${problems.map((p) => p.message).join(" ")}` }, this.now());
    const posting = await this.d.store.transition(id, ["approved"], { status: "posting", dedupeHash: hash }, this.now());
    if (!posting) return this.d.store.get(id);
    const x = this.d.config.x;
    if (!x) return this.fail(id, "X is not configured (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET).");
    const tweet = await postTweet(posting.text, x, { fetch: this.d.fetch });
    if (!tweet.ok) {
      this.log.warn({ postId: id, status: tweet.status ?? null }, "social_x_post_failed");
      return this.fail(id, tweet.error);
    }
    this.log.info({ postId: id, tweetId: tweet.id }, "social_x_posted");
    let nostrEventId: string | null = null;
    let nostrNote: string;
    if (!this.nostrKeys) {
      nostrNote = this.nostrKeyError ? `skipped: ${this.nostrKeyError}` : "skipped: NOSTR_BRAND_NSEC not set";
    } else {
      try {
        const r = await (this.d.publishNostr ?? ((t, k, relays) => publishNote(t, k, relays)))(forNostr(posting.text), this.nostrKeys, this.d.config.relays);
        nostrEventId = r.eventId;
        nostrNote = r.ok ? `posted to ${r.relaysOk} of ${r.relays} relays` : `failed: ${r.error}`;
        this.log.info({ postId: id, nostrEventId: r.eventId, ok: r.ok }, "social_nostr_published");
      } catch (error) {
        nostrNote = `failed: ${error instanceof Error ? error.message : "error"}`.slice(0, 300);
      }
    }
    return this.d.store.transition(id, ["posting"], { status: "posted", postedAtMs: this.now(), xTweetId: tweet.id, nostrEventId, nostrNote, error: null }, this.now());
  }

  private fail(id: string, error: string) {
    return this.d.store.transition(id, ["posting"], { status: "failed", dedupeHash: null, error: error.slice(0, 500) }, this.now());
  }

  /** Posts stuck in "posting" (the portal stopped mid-send): failed, for a human to check X first. */
  async recoverStuck(): Promise<number> {
    let n = 0;
    for (const p of await this.d.store.list(["posting"], 50)) {
      if (this.now() - p.updatedAtMs < STUCK_POSTING_MS) continue;
      const r = await this.d.store.transition(p.id, ["posting"], { status: "failed", dedupeHash: null, error: "Interrupted while sending. Check the X account before approving again." }, this.now());
      if (r) n++;
    }
    return n;
  }

  async sendApproved(): Promise<number> {
    if (!(await this.canSend()).ok) return 0;
    const approved = (await this.d.store.list(["approved"], 20)).sort((a, b) => (a.approvedAtMs ?? 0) - (b.approvedAtMs ?? 0));
    let n = 0;
    for (const p of approved) if ((await this.send(p.id))?.status === "posted") n++;
    return n;
  }

  // ── Drafting ──

  async draftWeekly(): Promise<SocialPost | null> {
    const s = this.d.sources;
    if (!s?.network && !s?.revenue) return null;
    const nowMs = this.now();
    if (await this.d.store.hasSourceKey(`weekly:${isoWeekKey(nowMs)}`)) return null;
    const [network, revenue] = await Promise.all([s.network ? s.network().catch(() => null) : null, s.revenue ? s.revenue().catch(() => null) : null]);
    const draft = weeklyDraft({ ...networkWeekly(network, nowMs), hostSats7d: hostSatsFromRevenue(revenue, nowMs) }, nowMs);
    return draft ? this.addDraft(draft) : null;
  }

  async draftReleases(): Promise<SocialPost[]> {
    if (!this.d.sources?.releases) return [];
    const latest = latestReleases(await this.d.sources.releases());
    const seen = (await this.d.store.getState<Partial<Record<ReleaseProduct, string>>>(RELEASES_SEEN)) ?? {};
    const next = { ...seen };
    const out: SocialPost[] = [];
    for (const r of Object.values(latest)) {
      if (!r) continue;
      const prev = seen[r.product];
      next[r.product] = r.version;
      // First run: the current release is the baseline, not news.
      if (!prev || prev === r.version) continue;
      const [a, b] = [prev.split(".").map(Number), r.version.split(".").map(Number)];
      const newer = a[0] !== b[0] ? b[0]! > a[0]! : a[1] !== b[1] ? b[1]! > a[1]! : b[2]! > a[2]!;
      if (!newer) {
        next[r.product] = prev;
        continue;
      }
      const post = await this.addDraft(releaseDraft(r));
      if (post) out.push(post);
    }
    await this.d.store.setState(RELEASES_SEEN, next, this.now());
    return out;
  }

  async draftDocs(): Promise<SocialPost[]> {
    const fetchText = this.d.sources?.fetchText;
    if (!fetchText) return [];
    const sitemapUrl = this.d.config.docsSitemapUrl;
    const xml = await fetchText(sitemapUrl);
    if (!xml) return [];
    const urls = sitemapUrls(xml, new URL(sitemapUrl).host);
    if (!urls.length) return [];
    const state = await this.d.store.getState<{ paths: string[] }>(DOCS_SEEN);
    if (!state) {
      await this.d.store.setState(DOCS_SEEN, { paths: urls.map(docsPath) }, this.now());
      return [];
    }
    const seen = new Set(state.paths);
    const fresh = urls.filter((u) => !seen.has(docsPath(u))).slice(0, DOCS_PER_RUN);
    const out: SocialPost[] = [];
    for (const url of fresh) {
      const post = await this.addDraft(docsDraft(url, docsTitle(url, await fetchText(url))));
      if (post) out.push(post);
      seen.add(docsPath(url));
    }
    if (fresh.length) await this.d.store.setState(DOCS_SEEN, { paths: [...seen] }, this.now());
    return out;
  }

  /**
   * One run of the job: nothing at all while paused; else draft from every source (each failure
   * logged and skipped), then send what is approved when SOCIAL_POSTING_ENABLED=1.
   */
  async tick(): Promise<{ skipped?: string; drafted: number; sent: number }> {
    if (!(await this.settings()).enabled) return { skipped: "paused", drafted: 0, sent: 0 };
    if (this.running) return { skipped: "running", drafted: 0, sent: 0 };
    this.running = true;
    try {
      let drafted = 0;
      const step = async (name: string, f: () => Promise<unknown>) => {
        try {
          const r = await f();
          drafted += Array.isArray(r) ? r.length : r ? 1 : 0;
        } catch (error) {
          this.log.warn({ source: name, error: error instanceof Error ? error.message : String(error) }, "social_draft_source_failed");
        }
      };
      await step("weekly", () => this.draftWeekly());
      await step("releases", () => this.draftReleases());
      await step("docs", () => this.draftDocs());
      await this.recoverStuck();
      const sent = await this.sendApproved();
      return { drafted, sent };
    } finally {
      this.running = false;
    }
  }

  async queue(): Promise<PostView[]> {
    return (await this.d.store.list(["draft", "failed", "approved", "posting"] as PostStatus[], 100)).map((p) => this.view(p));
  }

  async recent(): Promise<PostView[]> {
    return (await this.d.store.list(["posted", "rejected"], 50)).map((p) => this.view(p));
  }
}
