// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Web calls on the owner's own machine (docs/web-tool.md, "Searches on your own machine").
 *
 * A chat whose model runs on the account's own machine (the coordinator decides that basis; a
 * client can't claim it, basis.ts) searches with that machine's SearXNG and reads pages from that
 * machine, so the traffic comes from the owner's own connection and costs nothing:
 *
 *   coordinator (/v1/tools/web/search | /read, ownMachine basis, an agent of that very account that
 *   reported local web in its signed heartbeat and has an authenticated mesh WebSocket)
 *     -> agent: a local_web frame signed with the coordinator's identity key, down that WebSocket
 *        (pinned key, own agent id, 30 s lifetime, replay cache), the same chain as bot_control
 *     -> agent: its local SearXNG on 127.0.0.1 (searxng.ts), or fetchPage with the server reader's
 *        SSRF rules (public addresses only, pinned connection, ports 80/443, 2 MB, 10 s)
 *     -> coordinator: the result in a signed request; it settles only a command this coordinator
 *        sent to this agent, and is cleaned again there (cleanResults / cleanLocalPage).
 *
 * Anything else (no such machine, SearXNG down, no answer in time, no results) falls back to the
 * usual path: free with daily caps on your own machine, then paid. A host can't turn its claim
 * into free Brave searches: what it gets for claiming is that its own machine is asked first.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { signPayload, verifyPayload } from "../mesh/peer.js";
import { canonicalJson, CommandReplayGuard } from "../model/remote-control/protocol.js";
import { cleanResults, SEARCH_MAX_COUNT, type SearchResult } from "./brave.js";
import { PAGE_TEXT_MAX_CHARS } from "./extract.js";
import type { FetchedPage } from "./fetch-page.js";

export const LOCAL_WEB_FRAME_TYPE = "local_web";
export const LOCAL_WEB_VERSION = 1;
/** A frame is good for this long (a search answers in seconds; a late one is useless anyway). */
export const LOCAL_WEB_MAX_LIFETIME_MS = 30_000;
export const LOCAL_WEB_MAX_FUTURE_SKEW_MS = 60_000;
/** How long the coordinator waits for the agent's answer before falling back. */
export const LOCAL_SEARCH_WAIT_MS = 9_000;
export const LOCAL_READ_WAIT_MS = 15_000;
/** Calls one agent runs per window (protects the owner's IP from engines' rate limits; over it the coordinator falls back). */
export const AGENT_LOCAL_WEB_PER_WINDOW = 120;
export const AGENT_LOCAL_WEB_WINDOW_MS = 10 * 60_000;
/** A local_web result body (a page read's text is the big part). */
export const LOCAL_WEB_RESULT_MAX_BYTES = 256 * 1024;
/** A heartbeat's local-web report counts for this long. */
export const LOCAL_WEB_REPORT_TTL_MS = 3 * 60_000;

/** What an agent can do locally, from its signed heartbeat. */
export interface LocalWebCapability {
  /** Its SearXNG answered its health check. */
  search: boolean;
  /** It reads pages itself (AGENT_LOCAL_WEB not off). */
  read: boolean;
}

export const localWebCapabilitySchema = z.object({ search: z.boolean(), read: z.boolean() }).strict();

export type LocalWebRequest = { action: "search"; args: { query: string; count: number } } | { action: "read"; args: { url: string } };

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search"), args: z.object({ query: z.string().min(1).max(400), count: z.number().int().min(1).max(SEARCH_MAX_COUNT) }).strict() }),
  z.object({ action: z.literal("read"), args: z.object({ url: z.string().min(1).max(4_000) }).strict() }),
]);

export interface LocalWebCommand {
  v: typeof LOCAL_WEB_VERSION;
  id: string;
  agentId: string;
  coordinatorId: string;
  /** The owning account the coordinator verified (the chat's account). */
  requestedBy: string;
  issuedAtMs: number;
  expiresAtMs: number;
  action: LocalWebRequest["action"];
  args: Record<string, unknown>;
}

export interface LocalWebFrame {
  type: typeof LOCAL_WEB_FRAME_TYPE;
  command: LocalWebCommand;
  signature: string;
}

export function localWebSigningPayload(command: LocalWebCommand): string {
  return `edgecoder-local-web-v1\n${canonicalJson(command)}`;
}

export function createLocalWebFrame(input: { request: LocalWebRequest; agentId: string; coordinatorId: string; requestedBy: string; privateKeyPem: string; nowMs?: number; id?: string }): LocalWebFrame {
  const issuedAtMs = input.nowMs ?? Date.now();
  const command: LocalWebCommand = {
    v: LOCAL_WEB_VERSION,
    id: input.id ?? randomUUID(),
    agentId: input.agentId,
    coordinatorId: input.coordinatorId,
    requestedBy: input.requestedBy,
    issuedAtMs,
    expiresAtMs: issuedAtMs + LOCAL_WEB_MAX_LIFETIME_MS,
    action: input.request.action,
    args: input.request.args as Record<string, unknown>,
  };
  return { type: LOCAL_WEB_FRAME_TYPE, command, signature: signPayload(localWebSigningPayload(command), input.privateKeyPem) };
}

const commandShape = z
  .object({
    v: z.literal(LOCAL_WEB_VERSION),
    id: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/),
    agentId: z.string().min(1).max(128),
    coordinatorId: z.string().min(1).max(256),
    requestedBy: z.string().min(1).max(160),
    issuedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
    action: z.enum(["search", "read"]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

export type LocalWebVerdict =
  | { ok: true; command: LocalWebCommand; request: LocalWebRequest }
  | { ok: false; reason: "malformed" | "no_verified_coordinator" | "wrong_coordinator" | "invalid_signature" | "wrong_agent" | "expired" | "from_future" | "lifetime_too_long" | "replayed" | "replay_cache_full" | "invalid_request" };

/** The agent's check of a local_web frame (the same rules as bot_control and model control). */
export function verifyLocalWebFrame(frame: unknown, ctx: { agentId: string; coordinator: { peerId: string; publicKeyPem: string } | null; replay: CommandReplayGuard; nowMs?: number }): LocalWebVerdict {
  const f = frame as Partial<LocalWebFrame> | null;
  if (!f || typeof f !== "object" || f.type !== LOCAL_WEB_FRAME_TYPE || typeof f.signature !== "string") return { ok: false, reason: "malformed" };
  const parsed = commandShape.safeParse(f.command);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const command = parsed.data as LocalWebCommand;
  if (!ctx.coordinator) return { ok: false, reason: "no_verified_coordinator" };
  if (command.coordinatorId !== ctx.coordinator.peerId) return { ok: false, reason: "wrong_coordinator" };
  if (!verifyPayload(localWebSigningPayload(f.command as LocalWebCommand), f.signature, ctx.coordinator.publicKeyPem)) return { ok: false, reason: "invalid_signature" };
  if (command.agentId !== ctx.agentId) return { ok: false, reason: "wrong_agent" };
  const now = ctx.nowMs ?? Date.now();
  if (command.issuedAtMs > now + LOCAL_WEB_MAX_FUTURE_SKEW_MS) return { ok: false, reason: "from_future" };
  if (command.expiresAtMs - command.issuedAtMs > LOCAL_WEB_MAX_LIFETIME_MS || command.expiresAtMs < command.issuedAtMs) return { ok: false, reason: "lifetime_too_long" };
  if (now > command.expiresAtMs) return { ok: false, reason: "expired" };
  const request = requestSchema.safeParse({ action: command.action, args: command.args });
  if (!request.success) return { ok: false, reason: "invalid_request" };
  const fresh = ctx.replay.accept(command.id, command.expiresAtMs, now);
  if (fresh === "full") return { ok: false, reason: "replay_cache_full" };
  if (!fresh) return { ok: false, reason: "replayed" };
  return { ok: true, command, request: request.data as LocalWebRequest };
}

/** The agent's answer to one command (signed request to the coordinator). */
export interface LocalWebResult {
  commandId: string;
  status: "done" | "failed" | "refused";
  error?: string;
  results?: SearchResult[];
  page?: { url: string; title: string; text: string; truncated: boolean; contentType: string };
}

export const localWebResultSchema = z
  .object({
    commandId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/),
    status: z.enum(["done", "failed", "refused"]),
    error: z.string().max(80).optional(),
    results: z.array(z.object({ title: z.unknown(), url: z.unknown(), snippet: z.unknown() }).passthrough()).max(SEARCH_MAX_COUNT * 4).optional(),
    page: z.object({ url: z.string().max(4_000), title: z.string().max(2_000), text: z.string().max(PAGE_TEXT_MAX_CHARS * 2), truncated: z.boolean(), contentType: z.string().max(200) }).strict().optional(),
  })
  .strict();

/**
 * A page an agent read, cleaned like the server reader's output before it reaches a model: an
 * http(s) URL, a one-line title of 300 characters at most, text within PAGE_TEXT_MAX_CHARS. null
 * when it isn't a page at all.
 */
export function cleanLocalPage(page: LocalWebResult["page"] | undefined): FetchedPage | null {
  if (!page || typeof page.url !== "string" || !/^https?:\/\/[^\s]+$/i.test(page.url)) return null;
  const text = String(page.text ?? "");
  const over = text.length > PAGE_TEXT_MAX_CHARS;
  return {
    url: page.url,
    title: String(page.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    text: over ? text.slice(0, PAGE_TEXT_MAX_CHARS) : text,
    truncated: page.truncated === true || over,
    contentType: String(page.contentType ?? "").replace(/[^\w.+/;= -]/g, "").slice(0, 100),
  };
}

/** An agent's search results, cleaned again on the coordinator (it is the host's word). */
export function cleanLocalResults(results: LocalWebResult["results"] | undefined, n: number): SearchResult[] {
  return cleanResults(results ?? [], n);
}

// ───────────────────────────── the agent's side ─────────────────────────────

export interface LocalWebAgentDeps {
  agentId: string;
  /** SEARXNG_URL as a loopback base (searxng.ts searxngBaseUrl), or null: no local search. */
  searxngUrl: string | null;
  /** AGENT_LOCAL_WEB (default on): off makes this machine do no web calls for the coordinator. */
  enabled: boolean;
  search: (baseUrl: string, query: string, count: number) => Promise<SearchResult[]>;
  read: (url: string) => Promise<FetchedPage>;
  healthy: (baseUrl: string) => Promise<boolean>;
  /** Signed POST of the result to the coordinator this agent is registered with. */
  report: (result: LocalWebResult) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

/** How often the agent re-checks its SearXNG (the heartbeat carries the last answer). */
export const SEARXNG_HEALTH_EVERY_MS = 60_000;

export class LocalWebAgent {
  private readonly replay = new CommandReplayGuard(5_000);
  private recent: number[] = [];
  private health: { ok: boolean; atMs: number } | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly deps: LocalWebAgentDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** For the heartbeat: undefined when this machine does no local web at all (older coordinators never see the field). */
  async capability(): Promise<LocalWebCapability | undefined> {
    if (!this.deps.enabled) return undefined;
    const base = this.deps.searxngUrl;
    if (base && (!this.health || this.now() - this.health.atMs >= SEARXNG_HEALTH_EVERY_MS)) {
      this.checking ??= this.deps
        .healthy(base)
        .catch(() => false)
        .then((ok) => {
          if (this.health && this.health.ok !== ok) this.deps.log?.(`local search (SearXNG at ${base}) is ${ok ? "up" : "down"}`);
          this.health = { ok, atMs: this.now() };
        })
        .finally(() => {
          this.checking = null;
        });
      await this.checking;
    }
    return { search: !!base && this.health?.ok === true, read: true };
  }

  private limited(): boolean {
    const now = this.now();
    this.recent = this.recent.filter((t) => now - t < AGENT_LOCAL_WEB_WINDOW_MS);
    if (this.recent.length >= AGENT_LOCAL_WEB_PER_WINDOW) return true;
    this.recent.push(now);
    return false;
  }

  /** A local_web frame from the mesh WebSocket. `coordinator` is the identity this agent proved (pinned key). */
  async handleFrame(frame: unknown, coordinator: { peerId: string; publicKeyPem: string } | null): Promise<LocalWebResult | { status: "ignored"; error: string }> {
    const verdict = verifyLocalWebFrame(frame, { agentId: this.deps.agentId, coordinator, replay: this.replay, nowMs: this.now() });
    if (!verdict.ok) {
      this.deps.log?.(`local_web refused: ${verdict.reason}`);
      return { status: "ignored", error: verdict.reason };
    }
    const { command, request } = verdict;
    const finish = async (r: Omit<LocalWebResult, "commandId">): Promise<LocalWebResult> => {
      let result: LocalWebResult = { commandId: command.id, ...r };
      if (Buffer.byteLength(JSON.stringify(result)) > LOCAL_WEB_RESULT_MAX_BYTES) result = { commandId: command.id, status: "failed", error: "result_too_large" };
      try {
        await this.deps.report(result);
      } catch (e) {
        this.deps.log?.(`local_web result report failed: ${String(e).slice(0, 160)}`);
      }
      return result;
    };
    if (!this.deps.enabled) return finish({ status: "refused", error: "local_web_off" });
    if (this.limited()) return finish({ status: "refused", error: "agent_rate_limited" });
    if (request.action === "search") {
      const base = this.deps.searxngUrl;
      if (!base) return finish({ status: "refused", error: "no_local_search" });
      try {
        const results = cleanResults(await this.deps.search(base, request.args.query, request.args.count), request.args.count);
        return finish({ status: "done", results });
      } catch (e) {
        // Down now: say so in the next heartbeat too (checked again on the next one).
        this.health = { ok: false, atMs: 0 };
        return finish({ status: "failed", error: "search_failed" });
      }
    }
    try {
      const p = await this.deps.read(request.args.url);
      return finish({ status: "done", page: { url: p.url, title: p.title, text: p.text, truncated: p.truncated, contentType: p.contentType } });
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return finish({ status: "failed", error: typeof code === "string" ? code.slice(0, 40) : "read_failed" });
    }
  }
}

/** AGENT_LOCAL_WEB: off turns the whole thing off on this machine (default on). */
export function localWebEnabled(value: string | undefined): boolean {
  return !/^(off|0|false|no)$/i.test((value ?? "").trim());
}
