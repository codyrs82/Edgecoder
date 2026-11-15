// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Invite codes for the soft launch (LAUNCH_MODE=invite, src/economy/launch-gate.ts).
 *
 * A system admin mints codes in Settings > Admin: single-use or N-use, optionally expiring, with a
 * label. The code is shown once; only its SHA-256 and a short prefix are stored (like API keys),
 * so the list shows prefix, label, uses and expiry, and a code can be revoked. In invite mode a
 * new account needs a code that is not revoked, not expired and not used up; redeeming it is one
 * atomic update, so N uses admit at most N accounts across portal instances. Accounts that exist
 * already are grandfathered and never asked for one.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LaunchMode } from "../economy/launch-gate.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CODE_RE = /^EC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export const MAX_INVITE_USES = 1000;
export const MAX_INVITE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** EC-XXXX-XXXX-XXXX-XXXX, 16 characters from a 31-letter alphabet (about 79 bits). */
export function generateInviteCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(16);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `EC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

/** The canonical form of a typed or pasted code (case and spaces forgiven), or null if it cannot be one. */
export function normalizeInviteCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const compact = input.toUpperCase().replace(/[\s-]+/g, "");
  if (!/^EC[A-Z0-9]{16}$/.test(compact)) return null;
  const body = compact.slice(2);
  const code = `EC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
  return CODE_RE.test(code) ? code : null;
}

export function inviteCodeHash(code: string): string {
  return createHash("sha256").update(`edgecoder-invite:${code}`).digest("hex");
}

export interface InviteRecord {
  codeId: string;
  /** First characters of the code (EC-XXXX), to tell codes apart in the list. */
  prefix: string;
  label: string | null;
  maxUses: number;
  uses: number;
  expiresAtMs: number | null;
  createdBy: string;
  createdAtMs: number;
  revokedAtMs: number | null;
}

export interface InviteStore {
  createInviteCode(input: { codeId: string; codeHash: string; prefix: string; label: string | null; maxUses: number; expiresAtMs: number | null; createdBy: string; createdAtMs: number }): Promise<void>;
  listInviteCodes(limit: number): Promise<InviteRecord[]>;
  /** True when the code existed and was not revoked yet. */
  revokeInviteCode(codeId: string, nowMs: number): Promise<boolean>;
  /** Whether the code could be redeemed now (no use is taken). */
  inviteCodeRedeemable(codeHash: string, nowMs: number): Promise<boolean>;
  /** Takes one use for `userId` atomically; false when revoked, expired, used up or unknown. */
  redeemInviteCode(codeHash: string, userId: string, nowMs: number): Promise<boolean>;
}

export type InviteStatus = "active" | "used_up" | "expired" | "revoked";

export function inviteStatus(r: InviteRecord, nowMs: number): InviteStatus {
  if (r.revokedAtMs !== null) return "revoked";
  if (r.expiresAtMs !== null && r.expiresAtMs <= nowMs) return "expired";
  if (r.uses >= r.maxUses) return "used_up";
  return "active";
}

export type InviteGateResult = { ok: true; redeemed: boolean } | { ok: false; status: 403; error: "invite_required" | "invite_invalid"; detail: string };

const INVITE_REQUIRED_DETAIL = "EdgeCoder is in early access: creating an account needs an invite code.";
const INVITE_INVALID_DETAIL = "That invite code is not valid: it may be mistyped, expired, revoked or used up.";

/**
 * The gate a new account passes. Open mode: always (nothing redeemed). Invite mode: the code must
 * be redeemable, and one use is taken for `userId`.
 */
export async function redeemInviteForNewAccount(input: { mode: LaunchMode; store: Pick<InviteStore, "redeemInviteCode"> | null | undefined; code: unknown; userId: string; nowMs?: number }): Promise<InviteGateResult> {
  if (input.mode !== "invite") return { ok: true, redeemed: false };
  if (input.code === undefined || input.code === null || input.code === "") return { ok: false, status: 403, error: "invite_required", detail: INVITE_REQUIRED_DETAIL };
  const code = normalizeInviteCode(input.code);
  if (!code || !input.store) return { ok: false, status: 403, error: "invite_invalid", detail: INVITE_INVALID_DETAIL };
  const ok = await input.store.redeemInviteCode(inviteCodeHash(code), input.userId, input.nowMs ?? Date.now());
  return ok ? { ok: true, redeemed: true } : { ok: false, status: 403, error: "invite_invalid", detail: INVITE_INVALID_DETAIL };
}

/** Checks a code without using it (OAuth: checked at the start, redeemed when the account is made). */
export async function inviteCodeUsable(store: Pick<InviteStore, "inviteCodeRedeemable"> | null | undefined, code: unknown, nowMs = Date.now()): Promise<string | null> {
  const normalized = normalizeInviteCode(code);
  if (!normalized || !store) return null;
  return (await store.inviteCodeRedeemable(inviteCodeHash(normalized), nowMs)) ? normalized : null;
}

export interface InviteAdminDeps {
  store: InviteStore | null | undefined;
  launchMode: LaunchMode;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean } | null>;
  buildAccessContext: (user: { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean }) => Promise<{ isSystemAdmin: boolean }>;
  now?: () => number;
}

const mintBody = z.object({
  label: z
    .string()
    .trim()
    .max(80)
    .regex(/^[^<>\u0000-\u001f]*$/)
    .optional(),
  maxUses: z.number().int().min(1).max(MAX_INVITE_USES).default(1),
  /** Days until it expires; omitted = no expiry. */
  expiresInDays: z.number().int().min(1).max(MAX_INVITE_DAYS).optional()
});

/**
 * System-admin API behind Settings > Admin > Early access:
 *   GET  /portal/api/admin/invites                 -> { launchMode, invites }
 *   POST /portal/api/admin/invites { label?, maxUses, expiresInDays? } -> { invite, code } (code shown once)
 *   POST /portal/api/admin/invites/:codeId/revoke  -> { ok }
 */
export function registerInviteAdminRoutes(app: FastifyInstance, deps: InviteAdminDeps): void {
  const now = deps.now ?? Date.now;
  async function admin(req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (!deps.store) {
      reply.code(503).send({ error: "portal_database_not_configured" });
      return null;
    }
    const user = await deps.getCurrentUser(req as never);
    if (!user) {
      reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    if (!(await deps.buildAccessContext(user)).isSystemAdmin) {
      reply.code(403).send({ error: "admin_only" });
      return null;
    }
    return { user, store: deps.store };
  }
  const view = (r: InviteRecord) => ({ ...r, status: inviteStatus(r, now()) });

  app.get("/portal/api/admin/invites", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    return reply.send({ launchMode: deps.launchMode, invites: (await a.store.listInviteCodes(500)).map(view) });
  });

  app.post("/portal/api/admin/invites", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const parsed = mintBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_invite", detail: `maxUses: 1 to ${MAX_INVITE_USES}; expiresInDays: 1 to ${MAX_INVITE_DAYS}; label: up to 80 characters` });
    const code = generateInviteCode();
    const createdAtMs = now();
    const record: InviteRecord = {
      codeId: randomBytes(12).toString("hex"),
      prefix: code.slice(0, 7),
      label: parsed.data.label || null,
      maxUses: parsed.data.maxUses,
      uses: 0,
      expiresAtMs: parsed.data.expiresInDays ? createdAtMs + parsed.data.expiresInDays * DAY_MS : null,
      createdBy: a.user.email,
      createdAtMs,
      revokedAtMs: null
    };
    await a.store.createInviteCode({ ...record, codeHash: inviteCodeHash(code) });
    req.log.info({ codeId: record.codeId, maxUses: record.maxUses, expiresAtMs: record.expiresAtMs, by: a.user.userId }, "invite_code_minted");
    return reply.send({ invite: view(record), code });
  });

  app.post("/portal/api/admin/invites/:codeId/revoke", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const parsed = z.object({ codeId: z.string().regex(/^[0-9a-f]{24}$/) }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_invite_id" });
    if (!(await a.store.revokeInviteCode(parsed.data.codeId, now()))) return reply.code(404).send({ error: "invite_not_found" });
    req.log.info({ codeId: parsed.data.codeId, by: a.user.userId }, "invite_code_revoked");
    return reply.send({ ok: true });
  });
}
