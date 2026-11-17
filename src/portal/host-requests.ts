// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Hosting by request (early access).
 *
 * Running a node for other people's work is invite-only while the network is in early access:
 *
 * - The public page /host explains it and carries a "Request to host" form. POST /host/request
 *   stores the request (portal_host_requests), after a honeypot check, input validation and two
 *   rate limits (per client IP on the route, see security.ts, and per email and per IP over 24 h
 *   in the store, which holds across portal machines). System admins are emailed.
 * - Settings > Admin > Host requests lists them; an admin sets the status (new, contacted,
 *   approved, declined) and notes. Approving one approves the email as a host and, when no
 *   account exists for it yet, mints a single-use invite code (src/portal/invites.ts) that is
 *   emailed to the requester when email is configured, and shown to the admin either way.
 * - Host approval (portal_host_approvals, keyed by email) is what the coordinators check. With
 *   HOST_APPROVAL_REQUIRED on (the default), the portal's /internal/nodes/validate and
 *   /internal/nodes/lookup answers carry `hostApproved: false` for nodes of accounts that are not
 *   approved hosts, and a coordinator then lets those agents run only their owner's own work
 *   ("My machines", free) and never another account's (src/swarm/coordinator/dispatch.ts).
 *   Approved: system admins (SYSTEM_ADMIN_EMAILS), HOST_APPROVED_EMAILS, and every email in
 *   portal_host_approvals. When the table is first created, the owners of every node approved
 *   at that moment are grandfathered into it (PortalStore.migrateHostRequests).
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LaunchMode } from "../economy/launch-gate.js";
import { mintInviteCode, type InviteStore } from "./invites.js";
import { normalizeEmail } from "./portal-utils.js";

export const HOST_KINDS = ["compute_agent", "coordinator", "bitcoin_node", "lightning_node"] as const;
export type HostKind = (typeof HOST_KINDS)[number];
export const HOST_KIND_LABELS: Record<HostKind, string> = {
  compute_agent: "Compute agent",
  coordinator: "Coordinator",
  bitcoin_node: "Bitcoin node",
  lightning_node: "Lightning node"
};

export const COMPUTE_HARDWARE = ["cpu", "nvidia_gpu", "amd_gpu", "apple_silicon", "other"] as const;
export type ComputeHardware = (typeof COMPUTE_HARDWARE)[number];
export const COMPUTE_HARDWARE_LABELS: Record<ComputeHardware, string> = {
  cpu: "CPU only",
  nvidia_gpu: "NVIDIA GPU",
  amd_gpu: "AMD GPU",
  apple_silicon: "Apple silicon (M-series)",
  other: "Other"
};

export const HOST_REQUEST_STATUSES = ["new", "contacted", "approved", "declined"] as const;
export type HostRequestStatus = (typeof HOST_REQUEST_STATUSES)[number];

export interface HostRequestRecord {
  requestId: string;
  createdAtMs: number;
  name: string;
  email: string;
  organisation: string | null;
  hostKinds: HostKind[];
  computeHardware: ComputeHardware | null;
  hardwareDetails: string | null;
  region: string | null;
  message: string | null;
  status: HostRequestStatus;
  notes: string | null;
  updatedAtMs: number;
  updatedBy: string | null;
  /** Invite code minted when the request was approved (its id; the code itself is never stored). */
  inviteCodeId: string | null;
}

export type HostApprovalSource = "grandfathered" | "admin" | "host_request";
export interface HostApprovalRecord {
  email: string;
  approvedAtMs: number;
  approvedBy: string;
  source: HostApprovalSource;
  note: string | null;
}

export interface HostRequestStore {
  createHostRequest(record: HostRequestRecord & { ipHash: string | null }): Promise<void>;
  /** Requests since `sinceMs` from this email, and from this IP hash. */
  countHostRequestsSince(input: { email: string; ipHash: string | null; sinceMs: number }): Promise<{ byEmail: number; byIp: number }>;
  listHostRequests(limit: number): Promise<HostRequestRecord[]>;
  getHostRequest(requestId: string): Promise<HostRequestRecord | null>;
  updateHostRequest(requestId: string, patch: { status?: HostRequestStatus; notes?: string | null; inviteCodeId?: string; updatedAtMs: number; updatedBy: string }): Promise<HostRequestRecord | null>;
  getHostApproval(email: string): Promise<HostApprovalRecord | null>;
  listHostApprovals(limit: number): Promise<HostApprovalRecord[]>;
  /** Insert or replace the approval for `email`. */
  approveHost(record: HostApprovalRecord): Promise<void>;
  /** True when there was an approval to remove. */
  revokeHost(email: string): Promise<boolean>;
}

// ── Policy ──

export interface HostApprovalPolicy {
  /** HOST_APPROVAL_REQUIRED: on unless set to 0 or false. */
  required: boolean;
  /** SYSTEM_ADMIN_EMAILS plus HOST_APPROVED_EMAILS, normalised. */
  allowlist: Set<string>;
}

function emailList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((v) => normalizeEmail(v))
    .filter(Boolean);
}

export function hostApprovalPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): HostApprovalPolicy {
  const raw = (env.HOST_APPROVAL_REQUIRED ?? "").trim().toLowerCase();
  return {
    required: !(raw === "0" || raw === "false"),
    allowlist: new Set([...emailList(env.SYSTEM_ADMIN_EMAILS), ...emailList(env.HOST_APPROVED_EMAILS)])
  };
}

/**
 * Whether the account with this email may run other accounts' work. Gate off: everyone. On:
 * allowlisted emails and approved hosts. An unknown or empty email is not approved.
 */
export async function isApprovedHost(
  email: string | null | undefined,
  policy: HostApprovalPolicy,
  store: Pick<HostRequestStore, "getHostApproval"> | null | undefined
): Promise<boolean> {
  if (!policy.required) return true;
  const e = normalizeEmail(email ?? "");
  if (!e) return false;
  if (policy.allowlist.has(e)) return true;
  if (!store) return false;
  return (await store.getHostApproval(e)) !== null;
}

// ── Automatic requests ──

/** Shown as the request's source (in its message) in Settings > Admin > Host requests. */
export const AUTO_HOST_REQUEST_SOURCE = "auto (machine enrolled)";

/**
 * When a machine of an account that is not an approved host is approved as a node, or first
 * connects, file a pending host request for that account so it shows up in Host requests and the
 * admin approves it with one click. One open request per email: nothing is filed when the account
 * is already a host, or any request from that email is new, contacted or approved. Declined
 * requests are not reopened automatically. Returns the request filed, or null.
 */
export async function autoRequestHosting(
  deps: {
    store: Pick<HostRequestStore, "createHostRequest" | "listHostRequests" | "getHostApproval"> | null | undefined;
    policy: HostApprovalPolicy;
    now?: () => number;
  },
  node: { nodeId: string; nodeKind: "agent" | "coordinator"; ownerEmail: string; lastIp?: string; lastCountryCode?: string; hardware?: string | null }
): Promise<HostRequestRecord | null> {
  if (!deps.store || !deps.policy.required) return null;
  const email = normalizeEmail(node.ownerEmail ?? "");
  if (!email || !z.string().email().safeParse(email).success) return null;
  if (await isApprovedHost(email, deps.policy, deps.store)) return null;
  const existing = (await deps.store.listHostRequests(1000)).filter((r) => normalizeEmail(r.email) === email);
  if (existing.length > 0) return null;
  const nowMs = (deps.now ?? Date.now)();
  const clean = (v: string, max: number) => v.replace(/[<>\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  const record: HostRequestRecord = {
    requestId: randomBytes(12).toString("hex"),
    createdAtMs: nowMs,
    name: clean(email.split("@")[0] || email, 100),
    email,
    organisation: null,
    hostKinds: [node.nodeKind === "coordinator" ? "coordinator" : "compute_agent"],
    computeHardware: null,
    hardwareDetails: clean(`Machine: ${node.nodeId}` + (node.hardware ? ` · ${node.hardware}` : ""), 500),
    region: node.lastCountryCode ? clean(node.lastCountryCode, 80) : null,
    message: `Source: ${AUTO_HOST_REQUEST_SOURCE}`,
    status: "new",
    notes: null,
    updatedAtMs: nowMs,
    updatedBy: null,
    inviteCodeId: null
  };
  await deps.store.createHostRequest({ ...record, ipHash: null });
  return record;
}

/** autoRequestHosting for a route: logs, never throws. */
export async function autoRequestHostingSafe(
  deps: Parameters<typeof autoRequestHosting>[0] & { log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void } },
  node: Parameters<typeof autoRequestHosting>[1]
): Promise<void> {
  try {
    const filed = await autoRequestHosting(deps, node);
    if (filed) deps.log.info({ requestId: filed.requestId, nodeId: node.nodeId }, "host_request_auto_filed");
  } catch (err) {
    deps.log.warn({ err: err instanceof Error ? err.message : String(err), nodeId: node.nodeId }, "host_request_auto_failed");
  }
}

// ── Request validation ──

/** Printable text without angle brackets or control characters (newlines allowed where `multiline`). */
const text = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(multiline ? /^[^<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/ : /^[^<>\u0000-\u001f\u007f]*$/);
const optionalText = (max: number, multiline = false) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), text(max, multiline).optional());

export const hostRequestSchema = z.object({
  name: text(100).min(1),
  email: z.string().trim().max(254).email().transform(normalizeEmail),
  organisation: optionalText(120),
  hostKinds: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.enum(HOST_KINDS)).min(1).max(HOST_KINDS.length)),
  computeHardware: z.preprocess((v) => (v === "" ? undefined : v), z.enum(COMPUTE_HARDWARE).optional()),
  hardwareDetails: optionalText(500, true),
  region: optionalText(80),
  message: optionalText(2000, true)
});
export type HostRequestInput = z.infer<typeof hostRequestSchema>;

export const HOST_REQUEST_FIELD_HINTS: Record<string, string> = {
  name: "Your name (up to 100 characters).",
  email: "A valid email address we can reply to.",
  organisation: "Organisation: up to 120 characters.",
  hostKinds: "Pick at least one thing you would host.",
  computeHardware: "Pick the kind of hardware.",
  hardwareDetails: "Hardware details: up to 500 characters.",
  region: "Region: up to 80 characters.",
  message: "Message: up to 2,000 characters."
};

/** The honeypot field: hidden from people, filled in by form-filling bots. */
export const HONEYPOT_FIELD = "website";

export type HostRequestValidation =
  | { ok: true; value: HostRequestInput }
  | { ok: false; fields: string[] };

export function validateHostRequest(body: unknown): HostRequestValidation {
  const parsed = hostRequestSchema.safeParse(body ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
  return { ok: false, fields };
}

/** True when a bot filled the hidden field. */
export function honeypotTripped(body: unknown): boolean {
  const v = (body as Record<string, unknown> | null | undefined)?.[HONEYPOT_FIELD];
  return typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null;
}

/** application/x-www-form-urlencoded to an object; repeated keys (hostKinds) become arrays. */
export function parseFormBody(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

// ── Limits ──

export const HOST_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Requests one email may send per 24 h. */
export const HOST_REQUESTS_PER_EMAIL = 3;
/** Requests one client IP may send per 24 h (on top of the per-minute route limit). */
export const HOST_REQUESTS_PER_IP = 10;
/** Days an invite minted for an approved host request stays valid. */
export const HOST_INVITE_DAYS = 30;

export function ipHash(ip: string | undefined | null): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`edgecoder-host-request:${ip}`).digest("hex");
}

// ── Routes ──

type SessionUser = { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean };

export interface HostRequestRouteDeps {
  store: (HostRequestStore & InviteStore & { getUserByEmail(email: string): Promise<{ userId: string } | null> }) | null | undefined;
  policy: HostApprovalPolicy;
  launchMode: LaunchMode;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<SessionUser | null>;
  buildAccessContext: (user: SessionUser) => Promise<{ isSystemAdmin: boolean }>;
  /** The address rate limits key on (security.ts clientIp). */
  clientIp: (req: FastifyRequest) => string;
  /** Email the system admins about a new request; resolves false when email is not configured. */
  notifyAdmins: (record: HostRequestRecord) => Promise<boolean>;
  /** Email an approved requester (with their invite code when one was minted); false when not configured. */
  notifyApproved: (input: { email: string; name: string; inviteCode: string | null }) => Promise<boolean>;
  /** Renders the HTML answer for a browser form post (pages/host.ts). */
  renderFormResult: (result: { ok: true } | { ok: false; error: "invalid" | "rate_limited" | "unavailable"; fields?: string[]; values?: Record<string, unknown> }) => string;
  log?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
  now?: () => number;
}

const statusBody = z.object({
  status: z.enum(HOST_REQUEST_STATUSES).optional(),
  notes: z.preprocess((v) => (v === "" ? null : v), z.string().max(4000).regex(/^[^<>\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/).nullable().optional()),
  /** On approve: mint and send an invite when the requester has no account yet (default true). */
  sendInvite: z.boolean().optional()
});
const approveHostBody = z.object({
  email: z.string().trim().max(254).email().transform(normalizeEmail),
  note: z.string().trim().max(200).regex(/^[^<>\u0000-\u001f]*$/).optional()
});

const FORM_TYPE = "application/x-www-form-urlencoded";

/**
 * POST /host/request (public; JSON or a browser form post) and the system-admin API behind
 * Settings > Admin > Host requests:
 *   GET  /portal/api/host/status                       -> { required, approved } for the signed-in account
 *   GET  /portal/api/admin/host-requests               -> { required, requests, hosts }
 *   POST /portal/api/admin/host-requests/:id { status?, notes?, sendInvite? } -> { request, invite? }
 *   POST /portal/api/admin/hosts { email, note? }      -> { host }
 *   POST /portal/api/admin/hosts/revoke { email }      -> { ok }
 */
export async function registerHostRequestRoutes(app: FastifyInstance, deps: HostRequestRouteDeps): Promise<void> {
  const now = deps.now ?? Date.now;

  // The form post: an encapsulated scope, so only this route accepts form bodies.
  await app.register(async (scope) => {
    scope.addContentTypeParser(FORM_TYPE, { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
      try {
        done(null, parseFormBody(String(body)));
      } catch (err) {
        done(err as Error, undefined);
      }
    });
    scope.post("/host/request", { bodyLimit: 16 * 1024 }, async (req, reply) => {
      const isForm = String(req.headers["content-type"] ?? "").startsWith(FORM_TYPE);
      const answer = (status: number, json: Record<string, unknown>, html: Parameters<HostRequestRouteDeps["renderFormResult"]>[0]) =>
        isForm ? reply.code(status).type("text/html").send(deps.renderFormResult(html)) : reply.code(status).send(json);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // A bot filled the hidden field: answer as if it worked, store nothing, send nothing.
      if (honeypotTripped(body)) {
        deps.log?.info({ ip: ipHash(deps.clientIp(req))?.slice(0, 12) }, "host_request_honeypot");
        return answer(200, { ok: true }, { ok: true });
      }
      const values = { ...body };
      delete values[HONEYPOT_FIELD];
      const v = validateHostRequest(body);
      if (!v.ok) {
        return answer(400, { error: "invalid_host_request", fields: v.fields, detail: v.fields.map((f) => HOST_REQUEST_FIELD_HINTS[f] ?? f).join(" ") }, { ok: false, error: "invalid", fields: v.fields, values });
      }
      if (!deps.store) return answer(503, { error: "portal_database_not_configured" }, { ok: false, error: "unavailable", values });
      const nowMs = now();
      const ip = ipHash(deps.clientIp(req));
      const counts = await deps.store.countHostRequestsSince({ email: v.value.email, ipHash: ip, sinceMs: nowMs - HOST_REQUEST_WINDOW_MS });
      if (counts.byEmail >= HOST_REQUESTS_PER_EMAIL || counts.byIp >= HOST_REQUESTS_PER_IP) {
        return answer(429, { error: "rate_limited", detail: "We already have your request. We reply to every one; please wait for us to get in touch." }, { ok: false, error: "rate_limited", values });
      }
      const record: HostRequestRecord = {
        requestId: randomBytes(12).toString("hex"),
        createdAtMs: nowMs,
        name: v.value.name,
        email: v.value.email,
        organisation: v.value.organisation ?? null,
        hostKinds: v.value.hostKinds,
        computeHardware: v.value.computeHardware ?? null,
        hardwareDetails: v.value.hardwareDetails ?? null,
        region: v.value.region ?? null,
        message: v.value.message ?? null,
        status: "new",
        notes: null,
        updatedAtMs: nowMs,
        updatedBy: null,
        inviteCodeId: null
      };
      await deps.store.createHostRequest({ ...record, ipHash: ip });
      deps.log?.info({ requestId: record.requestId, hostKinds: record.hostKinds }, "host_request_received");
      deps.notifyAdmins(record).catch((err: unknown) => deps.log?.warn({ err: err instanceof Error ? err.message : String(err), requestId: record.requestId }, "host_request_notify_failed"));
      return answer(200, { ok: true }, { ok: true });
    });
  });

  app.get("/portal/api/host/status", async (req, reply) => {
    const user = await deps.getCurrentUser(req as never);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const approved = await isApprovedHost(user.emailVerified === false ? "" : user.email, deps.policy, deps.store);
    return reply.send({ required: deps.policy.required, approved });
  });

  async function admin(req: unknown, reply: FastifyReply) {
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

  app.get("/portal/api/admin/host-requests", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const [requests, hosts] = await Promise.all([a.store.listHostRequests(500), a.store.listHostApprovals(1000)]);
    return reply.send({ required: deps.policy.required, allowlist: [...deps.policy.allowlist], requests, hosts });
  });

  app.post("/portal/api/admin/host-requests/:requestId", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const params = z.object({ requestId: z.string().regex(/^[0-9a-f]{24}$/) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_host_request_id" });
    const body = statusBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_host_request_update", detail: "status: new, contacted, approved or declined; notes: up to 4,000 characters" });
    const existing = await a.store.getHostRequest(params.data.requestId);
    if (!existing) return reply.code(404).send({ error: "host_request_not_found" });
    const nowMs = now();
    const by = a.user.email;
    let invite: { code: string; codeId: string; emailed: boolean } | undefined;
    let approvalEmailed: boolean | undefined;
    const becomesApproved = body.data.status === "approved" && existing.status !== "approved";
    if (becomesApproved) {
      await a.store.approveHost({ email: existing.email, approvedAtMs: nowMs, approvedBy: by, source: "host_request", note: `request ${existing.requestId}` });
      const hasAccount = Boolean(await a.store.getUserByEmail(existing.email));
      let code: string | null = null;
      if (!hasAccount && body.data.sendInvite !== false && deps.launchMode === "invite") {
        const minted = await mintInviteCode(a.store, { label: `Host: ${existing.email}`.slice(0, 80), maxUses: 1, expiresInDays: HOST_INVITE_DAYS, createdBy: by, nowMs });
        code = minted.code;
        invite = { code, codeId: minted.record.codeId, emailed: false };
      }
      approvalEmailed = await deps.notifyApproved({ email: existing.email, name: existing.name, inviteCode: code }).catch((err: unknown) => {
        deps.log?.warn({ err: err instanceof Error ? err.message : String(err), requestId: existing.requestId }, "host_request_approval_email_failed");
        return false;
      });
      if (invite) invite.emailed = approvalEmailed;
    }
    // Declining an approved request takes back the host approval it gave.
    if (body.data.status === "declined" && existing.status === "approved") {
      const current = await a.store.getHostApproval(existing.email);
      if (current?.source === "host_request") await a.store.revokeHost(existing.email);
    }
    const updated = await a.store.updateHostRequest(existing.requestId, {
      ...(body.data.status ? { status: body.data.status } : {}),
      ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
      ...(invite ? { inviteCodeId: invite.codeId } : {}),
      updatedAtMs: nowMs,
      updatedBy: by
    });
    req.log.info({ requestId: existing.requestId, status: body.data.status, invite: Boolean(invite), by: a.user.userId }, "host_request_updated");
    return reply.send({ request: updated, ...(invite ? { invite } : {}), ...(approvalEmailed !== undefined ? { approvalEmailed } : {}) });
  });

  app.post("/portal/api/admin/hosts", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const body = approveHostBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_host", detail: "A valid email; note up to 200 characters." });
    const host: HostApprovalRecord = { email: body.data.email, approvedAtMs: now(), approvedBy: a.user.email, source: "admin", note: body.data.note || null };
    await a.store.approveHost(host);
    req.log.info({ by: a.user.userId }, "host_approved");
    return reply.send({ host });
  });

  app.post("/portal/api/admin/hosts/revoke", async (req, reply) => {
    const a = await admin(req, reply);
    if (!a) return reply;
    const body = z.object({ email: z.string().trim().max(254).email().transform(normalizeEmail) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_host" });
    if (!(await a.store.revokeHost(body.data.email))) return reply.code(404).send({ error: "host_not_found" });
    req.log.info({ by: a.user.userId }, "host_revoked");
    return reply.send({ ok: true });
  });
}
