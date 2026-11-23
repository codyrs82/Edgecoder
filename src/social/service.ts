// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash, randomUUID } from "node:crypto";
import type { SocialConfig } from "./config.js";
import { altProblems, validateImage, type ImageInput } from "./media.js";
import { brandNostrKeys, publishNote, type NostrPostResult } from "./nostr-brand.js";
import { dedupeHash, forNostr, normalizeForDedupe, postProblems, stripLeadingMentions, type RuleProblem } from "./rules.js";
import { docsDraft, docsPath, docsTitle, hostSatsFromRevenue, latestReleases, networkWeekly, releaseDraft, sitemapUrls, weeklyDraft, isoWeekKey, type ReleaseProduct } from "./sources.js";
import type { NewDraft, PostImage, PostStatus, SocialPost, SocialStore } from "./store.js";
import { postTweet, setMediaAltText, uploadMedia, type FetchLike, type XPostResult } from "./x-client.js";
import type { NostrKeys } from "../discovery/nostr.js";

/**
 * The brand-account queue: drafts from live data, the admin's compose box or the bulk import,
 * admin approval (always), then X and a Nostr cross-post.
 *
 *   draft ──approve──▶ approved ──send (when due)──▶ posting ──▶ posted
 *     │  ▲                │                               └────▶ failed ──edit──▶ draft
 *     │  └──edit (draft)  └──reject                                 └──approve (retry)
 *     └──reject──▶ rejected
 *
 * Every send needs both switches: the admin setting (stored, default paused) and
 * SOCIAL_POSTING_ENABLED=1. Paused also stops the drafting job (it reads coordinators, GitHub and
 * the docs sitemap). The rules (src/social/rules.ts) are checked on every draft, at approval and
 * once more right before sending, with the 90-day duplicate check per post text.
 *
 * Images: up to 4 per post (src/social/media.ts), uploaded to X right before the post is sent.
 *
 * Threads: posts sharing a thread id go out together, in position order, once every post of the
 * thread that is not rejected is approved and the thread is due. Approving any post of a thread
 * approves all of them (each still passes the rules; one problem approves none). Post 1 is an
 * original post; each next post replies to the post before it, and ONLY to that post: the id X
 * just returned for it in the same run, or (when a failed thread is retried) the id this system
 * recorded when it posted the previous post of the same thread. Nothing else is ever replied to.
 * When a post fails, the rest of the thread is marked failed and the posted ones are recorded.
 * Nostr gets plain sequential kind-1 notes (no reply tags), one per post that reached X.
 *
 * Send times: a post (or thread, by its first post) with scheduledAtMs in the future waits; the
 * portal checks for due posts every minute (sendDue), while drafting keeps its own cadence (tick).
 */

export const DUPLICATE_WINDOW_MS = 90 * 86_400_000;
/** A post left "posting" this long (the machine died mid-send) is marked failed for a human to check. */
export const STUCK_POSTING_MS = 10 * 60_000;
/** At most this many new docs pages are drafted per run; the rest wait for the next run. */
export const DOCS_PER_RUN = 5;
/** At most this many posts in one thread. */
export const MAX_THREAD_POSTS = 25;

const SETTINGS = "settings";
const RELEASES_SEEN = "releases_seen";
const DOCS_SEEN = "docs_seen";

export const THREAD_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

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
  images: PostImage[];
}

export interface ImportItem {
  text: string;
  /** A stable id for the item; default: a hash of threadKey, position and the normalized text. */
  key?: string;
  scheduledAtMs?: number | null;
  threadKey?: string;
  position?: number;
  images?: ImageInput[];
}

export interface ImportResult {
  created: Array<{ index: number; id: string; problems: RuleProblem[] }>;
  existing: Array<{ index: number; id: string }>;
  errors: Array<{ index: number; error: string; problems?: RuleProblem[] }>;
}

const noLog: Log = { info: () => undefined, warn: () => undefined };
const EDITABLE: PostStatus[] = ["draft", "failed"];
/** Images may still be swapped on an approved post until it starts sending (text, time and thread stay locked). */
const IMAGE_EDITABLE: PostStatus[] = ["draft", "failed", "approved"];

export class SocialService {
  private readonly now: () => number;
  private readonly log: Log;
  private nostrKeys: NostrKeys | null = null;
  private nostrKeyError: string | null = null;
  private running = false;
  private sending = false;

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

  view(p: SocialPost, images: PostImage[] = []): PostView {
    return { ...p, problems: [...postProblems(p.text), ...images.flatMap((i) => (i.alt ? altProblems(i.alt) : []))], images };
  }

  private async views(posts: SocialPost[]): Promise<PostView[]> {
    const images = await this.d.store.listImages(posts.map((p) => p.id));
    return posts.map((p) => this.view(p, images.filter((i) => i.postId === p.id)));
  }

  async viewOf(p: SocialPost): Promise<PostView> {
    return (await this.views([p]))[0]!;
  }

  /** Rules plus the 90-day duplicate check (the post itself excluded). */
  async problems(text: string, selfId?: string): Promise<RuleProblem[]> {
    const out = postProblems(text);
    const hash = dedupeHash(text);
    const recent = await this.d.store.postedSince(this.now() - DUPLICATE_WINDOW_MS);
    if (recent.some((r) => r.id !== selfId && r.dedupeHash === hash)) out.push({ code: "duplicate", message: "The same text was posted in the last 90 days." });
    return out;
  }

  /** Everything that keeps a stored post from being approved or sent: text rules, duplicates, image descriptions. */
  async postProblemsFor(p: SocialPost): Promise<RuleProblem[]> {
    const images = await this.d.store.listImages([p.id]);
    return [...(await this.problems(p.text, p.id)), ...images.flatMap((i) => (i.alt ? altProblems(i.alt) : []))];
  }

  async addDraft(d: NewDraft): Promise<SocialPost | null> {
    const post = await this.d.store.insertDraft({ ...d, text: stripLeadingMentions(d.text).trim() }, this.now());
    if (post) this.log.info({ postId: post.id, kind: post.kind }, "social_draft_created");
    return post;
  }

  private async nextPosition(threadId: string): Promise<number> {
    return (await this.d.store.threadPosts(threadId)).reduce((m, p) => Math.max(m, (p.threadPosition ?? 0) + 1), 1);
  }

  async compose(text: string, o: { threadId?: string | null; threadPosition?: number | null; scheduledAtMs?: number | null } = {}): Promise<ActionResult> {
    const t = stripLeadingMentions(text).trim();
    if (!t) return { ok: false, error: "empty" };
    const threadId = o.threadId || null;
    if (threadId && !THREAD_ID_RE.test(threadId)) return { ok: false, error: "invalid_thread" };
    const threadPosition = threadId ? (o.threadPosition ?? (await this.nextPosition(threadId))) : null;
    const post = await this.addDraft({ sourceKey: `manual:${randomUUID()}`, kind: "manual", text: t, threadId, threadPosition, scheduledAtMs: o.scheduledAtMs ?? null });
    return post ? { ok: true, post } : { ok: false, error: "not_created" };
  }

  async edit(id: string, text: string): Promise<ActionResult> {
    const t = stripLeadingMentions(text).trim();
    if (!t) return { ok: false, error: "empty" };
    const post = await this.d.store.transition(id, EDITABLE, { text: t, status: "draft", error: null }, this.now());
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
   * Set or clear the send time (UTC ms; null: send once approved). Allowed until the post starts
   * sending. On a thread post it moves the whole thread.
   */
  async setSchedule(id: string, scheduledAtMs: number | null): Promise<ActionResult> {
    const current = await this.d.store.get(id);
    if (!current) return { ok: false, error: "not_found" };
    const targets = current.threadId ? (await this.d.store.threadPosts(current.threadId)).filter((p) => ["draft", "failed", "approved"].includes(p.status)) : [current];
    let updated: SocialPost | null = null;
    for (const p of targets) {
      const r = await this.d.store.transition(p.id, ["draft", "failed", "approved"], { scheduledAtMs }, this.now());
      if (p.id === id) updated = r;
    }
    if (!updated) return { ok: false, error: "not_schedulable", post: await this.d.store.get(id) };
    this.log.info({ postId: id, threadId: current.threadId, scheduled: scheduledAtMs !== null }, "social_post_scheduled");
    return { ok: true, post: updated };
  }

  /** Put a draft into a thread (position default: last) or take it out (threadId null). */
  async setThread(id: string, threadId: string | null, position?: number | null): Promise<ActionResult> {
    if (threadId !== null && !THREAD_ID_RE.test(threadId)) return { ok: false, error: "invalid_thread" };
    const current = await this.d.store.get(id);
    if (!current) return { ok: false, error: "not_found" };
    let threadPosition: number | null = null;
    let scheduledAtMs = current.scheduledAtMs;
    if (threadId) {
      const members = (await this.d.store.threadPosts(threadId)).filter((p) => p.id !== id);
      if (members.length >= MAX_THREAD_POSTS) return { ok: false, error: "thread_full" };
      threadPosition = position ?? members.reduce((m, p) => Math.max(m, (p.threadPosition ?? 0) + 1), 1);
      // A thread goes out at one time: joining takes the thread's send time.
      const first = members.find((p) => p.status !== "rejected");
      if (first) scheduledAtMs = first.scheduledAtMs;
    }
    const post = await this.d.store.transition(id, EDITABLE, { threadId, threadPosition, scheduledAtMs }, this.now());
    if (!post) return { ok: false, error: "not_editable", post: current };
    return { ok: true, post };
  }

  async addImage(id: string, input: ImageInput): Promise<{ ok: true; image: PostImage } | { ok: false; error: string; problems?: RuleProblem[] }> {
    const post = await this.d.store.get(id);
    if (!post) return { ok: false, error: "not_found" };
    if (!IMAGE_EDITABLE.includes(post.status)) return { ok: false, error: "not_editable" };
    const v = validateImage(input);
    if (!v.ok) return v;
    const image = await this.d.store.addImage(id, v.image, this.now());
    if (image === "full") return { ok: false, error: "too_many_images" };
    this.log.info({ postId: id, imageId: image.id, size: image.size }, "social_image_added");
    return { ok: true, image };
  }

  async removeImage(id: string, imageId: string): Promise<{ ok: boolean; error?: string }> {
    const post = await this.d.store.get(id);
    if (!post) return { ok: false, error: "not_found" };
    if (!IMAGE_EDITABLE.includes(post.status)) return { ok: false, error: "not_editable" };
    return (await this.d.store.deleteImage(id, imageId)) ? { ok: true } : { ok: false, error: "not_found" };
  }

  /**
   * Approve a draft (or retry a failed post), optionally with edited text. Refused while the text
   * breaks a rule. Sent at once when sending is allowed and it is due, else when it is. A thread
   * post approves its whole thread.
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
    if (current.threadId) return this.approveThread(current.threadId, by, id);
    const problems = await this.postProblemsFor({ ...current, text: t });
    if (problems.length) return { ok: false, error: "rule_problems", problems, post: await this.d.store.get(id) };
    const approved = await this.d.store.transition(id, EDITABLE, { status: "approved", approvedBy: by, approvedAtMs: this.now(), error: null }, this.now());
    if (!approved) return { ok: false, error: "not_approvable", post: await this.d.store.get(id) };
    this.log.info({ postId: id }, "social_post_approved");
    const send = await this.canSend();
    if (!send.ok) return { ok: true, post: approved, note: `Approved. Not sent yet: ${send.reason}. It goes out at the next run once sending is on.` };
    if (approved.scheduledAtMs !== null && approved.scheduledAtMs > this.now()) return { ok: true, post: approved, note: "Approved. Scheduled: it is sent at its send time." };
    const sent = await this.send(id);
    return { ok: true, post: sent ?? approved };
  }

  /**
   * Approve every draft or failed post of a thread. Each is checked (rules, 90-day duplicates,
   * repeated text inside the thread); any problem approves none.
   */
  async approveThread(threadId: string, by: string, reportId?: string): Promise<ActionResult> {
    const members = (await this.d.store.threadPosts(threadId)).filter((p) => p.status !== "rejected");
    const pending = members.filter((p) => EDITABLE.includes(p.status));
    const report = async () => (reportId ? await this.d.store.get(reportId) : (pending[0] ?? null));
    if (!pending.length) return { ok: false, error: "not_approvable", post: await report() };
    if (members.length > MAX_THREAD_POSTS) return { ok: false, error: "thread_too_long", post: await report() };
    const problems: RuleProblem[] = [];
    const seen = new Map<string, number>();
    for (const [i, p] of members.entries()) {
      const label = `Post ${i + 1}: `;
      if (EDITABLE.includes(p.status)) for (const pr of await this.postProblemsFor(p)) problems.push({ code: pr.code, message: label + pr.message });
      const h = normalizeForDedupe(p.text);
      if (seen.has(h)) problems.push({ code: "duplicate", message: `${label}Same text as post ${seen.get(h)! + 1} of this thread.` });
      else seen.set(h, i);
    }
    if (problems.length) return { ok: false, error: "rule_problems", problems, post: await report() };
    for (const p of pending) {
      await this.d.store.transition(p.id, EDITABLE, { status: "approved", approvedBy: by, approvedAtMs: this.now(), error: null }, this.now());
    }
    this.log.info({ threadId, posts: pending.length }, "social_thread_approved");
    const first = (await this.d.store.threadPosts(threadId)).find((p) => p.status !== "rejected" && p.status !== "posted");
    const send = await this.canSend();
    const post = (await report())!;
    if (!send.ok) return { ok: true, post, note: `Thread approved (${pending.length} post${pending.length === 1 ? "" : "s"}). Not sent yet: ${send.reason}. It goes out at the next run once sending is on.` };
    if (first?.scheduledAtMs != null && first.scheduledAtMs > this.now()) return { ok: true, post, note: "Thread approved. Scheduled: it is sent at its send time." };
    await this.sendThread(threadId);
    return { ok: true, post: (await report())! };
  }

  /** Upload the post's images (alt text when given) and post it to X. */
  private async postToX(p: SocialPost, inReplyToOwnTweetId: string | undefined): Promise<XPostResult> {
    const x = this.d.config.x!;
    const mediaIds: string[] = [];
    for (const img of (await this.d.store.postImages(p.id)).slice(0, 4)) {
      const up = await uploadMedia({ filename: img.filename, contentType: img.contentType, bytes: img.bytes }, x, { fetch: this.d.fetch });
      if (!up.ok) {
        this.log.warn({ postId: p.id, imageId: img.id, status: up.status ?? null }, "social_x_media_upload_failed");
        return { ok: false, status: up.status, error: `image ${img.position + 1} (${img.filename}): ${up.error}` };
      }
      if (img.alt) {
        const alt = await setMediaAltText(up.id, img.alt, x, { fetch: this.d.fetch });
        // The image still posts without its description; the log says so.
        if (!alt.ok) this.log.warn({ postId: p.id, imageId: img.id, status: alt.status ?? null }, "social_x_alt_text_failed");
      }
      mediaIds.push(up.id);
    }
    return postTweet(p.text, x, { fetch: this.d.fetch, mediaIds, inReplyToOwnTweetId });
  }

  /** The Nostr cross-post of one post that reached X: a plain kind-1 note (threads: sequential notes, no reply tags). */
  private async crossPostNostr(p: SocialPost): Promise<{ nostrEventId: string | null; nostrNote: string }> {
    if (!this.nostrKeys) return { nostrEventId: null, nostrNote: this.nostrKeyError ? `skipped: ${this.nostrKeyError}` : "skipped: NOSTR_BRAND_NSEC not set" };
    try {
      const r = await (this.d.publishNostr ?? ((t, k, relays) => publishNote(t, k, relays)))(forNostr(p.text), this.nostrKeys, this.d.config.relays);
      this.log.info({ postId: p.id, nostrEventId: r.eventId, ok: r.ok }, "social_nostr_published");
      return { nostrEventId: r.eventId, nostrNote: r.ok ? `posted to ${r.relaysOk} of ${r.relays} relays` : `failed: ${r.error}` };
    } catch (error) {
      return { nostrEventId: null, nostrNote: `failed: ${error instanceof Error ? error.message : "error"}`.slice(0, 300) };
    }
  }

  /** Send one approved post when it is due: claim it, check again, X (images, then the post), then Nostr. */
  async send(id: string): Promise<SocialPost | null> {
    if (!(await this.canSend()).ok) return this.d.store.get(id);
    const claimed = await this.d.store.get(id);
    if (!claimed || claimed.status !== "approved") return claimed;
    if (claimed.threadId) {
      await this.sendThread(claimed.threadId);
      return this.d.store.get(id);
    }
    if (claimed.scheduledAtMs !== null && claimed.scheduledAtMs > this.now()) return claimed;
    const hash = dedupeHash(claimed.text);
    const problems = await this.postProblemsFor(claimed);
    if (problems.length) return this.d.store.transition(id, ["approved"], { status: "failed", error: `Refused before sending: ${problems.map((p) => p.message).join(" ")}` }, this.now());
    const posting = await this.d.store.transition(id, ["approved"], { status: "posting", dedupeHash: hash }, this.now());
    if (!posting) return this.d.store.get(id);
    if (!this.d.config.x) return this.fail(id, "X is not configured (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET).");
    const tweet = await this.postToX(posting, undefined);
    if (!tweet.ok) {
      this.log.warn({ postId: id, status: tweet.status ?? null }, "social_x_post_failed");
      return this.fail(id, tweet.error);
    }
    this.log.info({ postId: id, tweetId: tweet.id }, "social_x_posted");
    const nostr = await this.crossPostNostr(posting);
    return this.d.store.transition(id, ["posting"], { status: "posted", postedAtMs: this.now(), xTweetId: tweet.id, ...nostr, error: null }, this.now());
  }

  /**
   * Send a thread once every post that is not rejected is approved (or already posted) and its
   * first unsent post is due. Each post replies to the previous post of this thread only.
   */
  async sendThread(threadId: string): Promise<{ posted: number; failed: number }> {
    const none = { posted: 0, failed: 0 };
    if (!(await this.canSend()).ok) return none;
    const members = (await this.d.store.threadPosts(threadId)).filter((p) => p.status !== "rejected");
    const firstPending = members.findIndex((p) => p.status !== "posted");
    if (firstPending < 0) return none;
    const pending = members.slice(firstPending);
    // Not ready: a post still in draft or failed, already sending, or posted out of order.
    if (pending.some((p) => p.status !== "approved")) return none;
    if (pending[0]!.scheduledAtMs !== null && pending[0]!.scheduledAtMs > this.now()) return none;
    const prev = firstPending > 0 ? members[firstPending - 1]! : null;
    // The only reply target allowed for the first unsent post: our own previous post of this thread.
    let replyTo: string | undefined = undefined;
    if (prev) {
      if (prev.threadId !== threadId || prev.status !== "posted" || !prev.xTweetId) return none;
      replyTo = prev.xTweetId;
    }
    const problems: string[] = [];
    for (const [i, p] of pending.entries()) for (const pr of await this.postProblemsFor(p)) problems.push(`Post ${firstPending + i + 1}: ${pr.message}`);
    if (problems.length) {
      let failed = 0;
      for (const p of pending) if (await this.d.store.transition(p.id, ["approved"], { status: "failed", error: `Thread refused before sending: ${problems.join(" ")}`.slice(0, 500) }, this.now())) failed++;
      return { posted: 0, failed };
    }
    // Claim every post (compare-and-set): another machine that got here first keeps the thread.
    const claimed: SocialPost[] = [];
    for (const p of pending) {
      const c = await this.d.store.transition(p.id, ["approved"], { status: "posting", dedupeHash: dedupeHash(p.text) }, this.now());
      if (!c) {
        for (const done of claimed) await this.d.store.transition(done.id, ["posting"], { status: "approved", dedupeHash: null }, this.now());
        return none;
      }
      claimed.push(c);
    }
    if (!this.d.config.x) {
      for (const p of claimed) await this.fail(p.id, "X is not configured (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET).");
      return { posted: 0, failed: claimed.length };
    }
    const postedNow: number[] = [];
    for (const [i, p] of claimed.entries()) {
      const position = firstPending + i + 1;
      const tweet = await this.postToX(p, replyTo);
      if (!tweet.ok) {
        this.log.warn({ postId: p.id, threadId, position, status: tweet.status ?? null }, "social_x_thread_post_failed");
        await this.fail(p.id, tweet.error);
        const postedList = [...members.slice(0, firstPending).map((_, k) => k + 1), ...postedNow];
        const note = `Not sent: post ${position} of this thread failed (${tweet.error.slice(0, 200)}). Posted: ${postedList.length ? postedList.join(", ") : "none"}.`;
        for (const rest of claimed.slice(i + 1)) await this.fail(rest.id, note);
        return { posted: postedNow.length, failed: claimed.length - i };
      }
      this.log.info({ postId: p.id, threadId, position, tweetId: tweet.id }, "social_x_posted");
      const nostr = await this.crossPostNostr(p);
      await this.d.store.transition(p.id, ["posting"], { status: "posted", postedAtMs: this.now(), xTweetId: tweet.id, replyToTweetId: replyTo ?? null, ...nostr, error: null }, this.now());
      postedNow.push(position);
      // The next post replies to the one X just returned to us: never any other id.
      replyTo = tweet.id;
    }
    return { posted: postedNow.length, failed: 0 };
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

  /**
   * Send every approved post that is due (no send time, or its time has come). Cheap enough to run
   * every minute: the switch read, then one indexed query. Nothing while paused.
   */
  async sendDue(): Promise<number> {
    if (!(await this.canSend()).ok) return 0;
    if (this.sending) return 0;
    this.sending = true;
    try {
      await this.recoverStuck();
      const due = await this.d.store.listDue(this.now(), 20);
      const threads = new Set<string>();
      let n = 0;
      for (const p of due) {
        if (p.threadId) {
          if (threads.has(p.threadId)) continue;
          threads.add(p.threadId);
          n += (await this.sendThread(p.threadId)).posted;
        } else if ((await this.send(p.id))?.status === "posted") n++;
      }
      return n;
    } finally {
      this.sending = false;
    }
  }

  /** Kept for callers of the first version: the same as sendDue. */
  sendApproved(): Promise<number> {
    return this.sendDue();
  }

  // ── Bulk import ──

  /** The stable source key of an import item: re-importing the same item finds it instead of duplicating it. */
  static importSourceKey(item: Pick<ImportItem, "key" | "text" | "threadKey" | "position">): string {
    if (item.key) return `import:${item.key}`;
    const h = createHash("sha256")
      .update(JSON.stringify([item.threadKey ?? "", item.position ?? null, normalizeForDedupe(stripLeadingMentions(item.text))]))
      .digest("hex")
      .slice(0, 40);
    return `import:${h}`;
  }

  /**
   * Create drafts (never approved) from a list. An item already imported (same source key) is
   * reported as existing and left as it is. Images are checked before anything is created, so an
   * item with a bad image creates nothing. Rule problems do not block a draft (they block approval)
   * and are returned per item.
   */
  async importPosts(items: ImportItem[]): Promise<ImportResult> {
    const out: ImportResult = { created: [], existing: [], errors: [] };
    for (const [index, item] of items.entries()) {
      const text = stripLeadingMentions(item.text).trim();
      if (!text) {
        out.errors.push({ index, error: "empty" });
        continue;
      }
      if (item.threadKey !== undefined && !THREAD_ID_RE.test(item.threadKey)) {
        out.errors.push({ index, error: "invalid_thread_key" });
        continue;
      }
      const sourceKey = SocialService.importSourceKey(item);
      const found = await this.d.store.getBySourceKey(sourceKey);
      if (found) {
        out.existing.push({ index, id: found.id });
        continue;
      }
      const images = [];
      let bad: { error: string; problems?: RuleProblem[] } | null = null;
      if ((item.images?.length ?? 0) > 4) bad = { error: "too_many_images" };
      for (const [k, img] of (item.images ?? []).entries()) {
        if (bad) break;
        const v = validateImage(img);
        if (v.ok) images.push(v.image);
        else bad = { error: `image ${k + 1}: ${v.error}`, problems: v.problems };
      }
      if (bad) {
        out.errors.push({ index, ...bad });
        continue;
      }
      const threadId = item.threadKey ?? null;
      const threadPosition = threadId ? (item.position ?? (await this.nextPosition(threadId))) : null;
      const post = await this.addDraft({ sourceKey, kind: "import", text, threadId, threadPosition, scheduledAtMs: item.scheduledAtMs ?? null });
      if (!post) {
        const raced = await this.d.store.getBySourceKey(sourceKey);
        if (raced) out.existing.push({ index, id: raced.id });
        else out.errors.push({ index, error: "not_created" });
        continue;
      }
      for (const img of images) await this.d.store.addImage(post.id, img, this.now());
      out.created.push({ index, id: post.id, problems: await this.postProblemsFor(post) });
    }
    this.log.info({ created: out.created.length, existing: out.existing.length, errors: out.errors.length }, "social_import");
    return out;
  }

  // ── Drafting ──

  async draftWeekly(): Promise<SocialPost | null> {
    const s = this.d.sources;
    if (!s?.network && !s?.revenue) return null;
    const nowMs = this.now();
    if (await this.d.store.hasSourceKey(`weekly:${isoWeekKey(nowMs)}`)) return null;
    const [network, revenue] = await Promise.all([s.network ? s.network().catch(() => null) : null, s.revenue ? s.revenue().catch(() => null) : null]);
    const draft = weeklyDraft({ ...networkWeekly(network, nowMs), hostSats7d: hostSatsFromRevenue(revenue, nowMs) }, nowMs, this.d.config.siteUrl);
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
    if (!sitemapUrl) return [];
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
   * One drafting run: nothing at all while paused; else draft from every source (each failure
   * logged and skipped), then send what is approved and due when SOCIAL_POSTING_ENABLED=1.
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
      const sent = await this.sendDue();
      return { drafted, sent };
    } finally {
      this.running = false;
    }
  }

  async queue(): Promise<PostView[]> {
    return this.views(await this.d.store.list(["draft", "failed", "approved", "posting"] as PostStatus[], 100));
  }

  async recent(): Promise<PostView[]> {
    return this.views(await this.d.store.list(["posted", "rejected"], 50));
  }
}
