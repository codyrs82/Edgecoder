// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Code from your phone, portal side (src/common/code-relay.ts has the whole chain; the coordinator's
 * half is src/swarm/coordinator/routes/code-relay.ts). The iOS app is written against this contract.
 *
 *   GET  /portal/api/code/machines               the signed-in account's machines, projects and sessions
 *   POST /portal/api/code/:agentId/commands      { action, ...args } -> 202 { commandId }
 *   GET  /portal/api/code/commands/:commandId    { status: pending|done|failed|expired, result?, error? }
 *
 * The account is always acct-<session user> (never from the request: account fields in a body are
 * dropped). The portal asks only about the user's enrolled agent nodes and refuses a command for any
 * other machine; each coordinator checks the agent's verified ownership row again before it shows a
 * snapshot or signs a command, and answers a command's state only to the account that sent it.
 * Every answer is no-store.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { request } from "undici";
import { z } from "zod";
import { CODE_COMMAND_BODY_LIMIT, CODE_CONTROL_ACTIONS, codeControlRequestSchema, type CodeSnapshot } from "../../common/code-relay.js";

export interface CodeRoutesDeps {
  PORTAL_SERVICE_TOKEN: string;
  EXTERNAL_HTTP_TIMEOUT_MS: number;
  discoverCoordinatorUrlsForPortal: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string } | null | undefined>;
  store: { listNodesByOwner(userId: string): Promise<Array<{ nodeId: string; nodeKind: string }>> } | null | undefined;
}

interface CoordinatorCodeMachine {
  agentId: string;
  connected: boolean;
  snapshot: CodeSnapshot | null;
  reportedAtMs: number | null;
  lastSeenMs?: number | null;
}

export interface CodeMachineView {
  agentId: string;
  name: string;
  online: boolean;
  controls: "off" | "view" | "on";
  projects: Array<{ projectId: string; name: string; parent: string; branch?: string }>;
  sessions: Array<{ sessionId: string; projectId: string; title: string; status: "idle" | "running" | "waiting"; updatedAtMs: number; pendingApprovals: number; startedFrom: "phone" | "mac" }>;
  updatedAtMs: number;
}

const MAX_COORDINATORS = 8;
const agentIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const commandIdSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/);
/** Fields a client might send to name an account: never used (the session decides), so dropped. */
const ACCOUNT_FIELDS = ["accountId", "account", "userId", "requestedBy", "ownerAccountId"];

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** One machine as the phone sees it (a machine with no snapshot: controls "off", empty lists). */
export function codeMachineView(agentId: string, m: CoordinatorCodeMachine | undefined): CodeMachineView {
  const s = m?.snapshot && typeof m.snapshot === "object" ? m.snapshot : null;
  const projects = (Array.isArray(s?.projects) ? s!.projects : [])
    .filter((p) => p && typeof p.projectId === "string")
    .map((p) => ({ projectId: p.projectId, name: str(p.name, 255), parent: str(p.parent, 255), ...(typeof p.branch === "string" && p.branch ? { branch: p.branch.slice(0, 255) } : {}) }));
  const sessions = (Array.isArray(s?.sessions) ? s!.sessions : [])
    .filter((x) => x && typeof x.id === "string")
    .map((x) => {
      const pending = num(x.pending);
      return {
        sessionId: x.id,
        projectId: str(x.projectId, 64),
        title: str(x.title, 200),
        // Waiting on an approval wins over running (the turn is paused for the owner).
        status: (pending > 0 ? "waiting" : x.running === true ? "running" : "idle") as "idle" | "running" | "waiting",
        updatedAtMs: num(x.updatedAt),
        pendingApprovals: pending,
        startedFrom: (x.origin === "remote" ? "phone" : "mac") as "phone" | "mac",
      };
    });
  return {
    agentId,
    name: str(s?.machineName, 80) || agentId,
    online: !!m?.connected,
    controls: s ? (s.controls === "on" ? "on" : "view") : "off",
    projects,
    sessions,
    updatedAtMs: num(m?.reportedAtMs ?? s?.generatedAtMs ?? m?.lastSeenMs ?? 0),
  };
}

/** One entry per machine from every coordinator's answer: the connected one wins (its view is the machine's current setting), else the latest report. */
export function mergeCodeMachines(answers: CoordinatorCodeMachine[][]): Map<string, CoordinatorCodeMachine> {
  const merged = new Map<string, CoordinatorCodeMachine>();
  for (const m of answers.flat()) {
    if (typeof m?.agentId !== "string") continue;
    const prev = merged.get(m.agentId);
    const better =
      !prev ||
      (m.connected && !prev.connected) ||
      (m.connected === prev.connected && ((m.snapshot && !prev.snapshot) || (!!m.snapshot === !!prev.snapshot && (m.reportedAtMs ?? 0) > (prev.reportedAtMs ?? 0))));
    if (better) merged.set(m.agentId, m);
  }
  return merged;
}

const COMMAND_STATUS: Record<string, "pending" | "done" | "failed" | "expired"> = { sent: "pending", done: "done", refused: "failed", failed: "failed", expired: "expired" };

export function registerCodeRoutes(app: FastifyInstance, deps: CodeRoutesDeps): void {
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(deps.PORTAL_SERVICE_TOKEN ? { "x-portal-service-token": deps.PORTAL_SERVICE_TOKEN } : {}),
  });
  async function coordinators(): Promise<string[]> {
    return [...new Set((await deps.discoverCoordinatorUrlsForPortal()).map((u) => u.replace(/\/$/, "")))].slice(0, MAX_COORDINATORS);
  }
  async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await request(url, { method: "POST", headers: headers(), body: JSON.stringify(body), headersTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS, bodyTimeout: deps.EXTERNAL_HTTP_TIMEOUT_MS });
    return { status: res.statusCode, body: await res.body.json().catch(() => ({})) };
  }
  async function agentNodes(userId: string): Promise<string[]> {
    if (!deps.store) return [];
    return (await deps.store.listNodesByOwner(userId)).filter((n) => n.nodeKind === "agent").map((n) => n.nodeId).slice(0, 100);
  }
  /** What every coordinator knows of these (enrolled) machines, merged; only those machines. */
  async function coordinatorView(accountId: string, agentIds: string[]): Promise<Map<string, CoordinatorCodeMachine>> {
    if (!agentIds.length) return new Map();
    const answers = await Promise.all(
      (await coordinators()).map(async (base) => {
        try {
          const r = await postJson(`${base}/agent-control/code`, { accountId, agentIds });
          return r.status === 200 && Array.isArray(r.body?.machines) ? (r.body.machines as CoordinatorCodeMachine[]) : [];
        } catch {
          return [];
        }
      }),
    );
    // Only the user's own enrolled machines, whatever a coordinator answered.
    const mine = new Set(agentIds);
    return mergeCodeMachines(answers.map((list) => list.filter((m) => mine.has(m?.agentId))));
  }
  /** One command to the coordinator holding the machine's connection (each is tried in turn). */
  async function sendCommand(agentId: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    let notConnected = false;
    let unreachable = false;
    for (const base of await coordinators()) {
      try {
        const r = await postJson(`${base}/agent-control/agents/${encodeURIComponent(agentId)}/code-commands`, body);
        // Another coordinator may hold the machine's connection.
        if (r.status === 409 && r.body?.error === "agent_not_connected") {
          notConnected = true;
          continue;
        }
        return r;
      } catch {
        unreachable = true;
      }
    }
    // Offline wherever we could ask; unreachable only when no coordinator answered at all.
    return unreachable && !notConnected ? { status: 502, body: { error: "coordinator_unreachable" } } : { status: 409, body: { error: "agent_not_connected" } };
  }
  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");
  async function signedIn(req: unknown, reply: FastifyReply): Promise<string | null> {
    noStore(reply);
    const user = await deps.getCurrentUser(req as never);
    if (!user) {
      void reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    return user.userId;
  }

  app.get("/portal/api/code/machines", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
    const userId = await signedIn(req, reply);
    if (!userId) return reply;
    const agentIds = await agentNodes(userId);
    const known = await coordinatorView(`acct-${userId}`, agentIds);
    return reply.send({ machines: agentIds.map((id) => codeMachineView(id, known.get(id))) });
  });

  // A message may carry images (CODE_COMMAND_BODY_LIMIT; codeImagesSchema checks type, size and count).
  app.post("/portal/api/code/:agentId/commands", { bodyLimit: CODE_COMMAND_BODY_LIMIT, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const userId = await signedIn(req, reply);
    if (!userId) return reply;
    const p = z.object({ agentId: agentIdSchema }).safeParse(req.params);
    const raw = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? { ...(req.body as Record<string, unknown>) } : null;
    if (!p.success || !raw) return reply.code(400).send({ error: "bad_request" });
    for (const k of ACCOUNT_FIELDS) delete raw[k];
    const { action, args: nested, ...flat } = raw;
    // { action, ...args } (the contract); { action, args: {...} } is taken too.
    const args = nested && typeof nested === "object" && !Array.isArray(nested) && !Object.keys(flat).length ? { ...(nested as Record<string, unknown>) } : nested === undefined ? flat : null;
    if (!args || !z.enum(CODE_CONTROL_ACTIONS).safeParse(action).success) return reply.code(400).send({ error: "bad_request" });
    for (const k of ACCOUNT_FIELDS) delete args[k];
    const parsed = codeControlRequestSchema.safeParse({ action, args });
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", message: parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`.slice(0, 300) : undefined });
    // First check here (enrolled to this user); the coordinator checks the verified ownership row again.
    const agentIds = await agentNodes(userId);
    if (!agentIds.includes(p.data.agentId)) return reply.code(403).send({ error: "not_your_machine" });
    const accountId = `acct-${userId}`;
    // The machine's own setting, from its latest snapshot (the Mac refuses the same way if this is stale).
    const m = (await coordinatorView(accountId, [p.data.agentId])).get(p.data.agentId);
    if (m?.connected && !m.snapshot) return reply.code(409).send({ error: "relay_off", message: "Code from your phone is off on this Mac." });
    if (m?.connected && m.snapshot?.controls !== "on") return reply.code(409).send({ error: "view_only", message: "This Mac shows its sessions on the phone but takes no commands." });
    const r = await sendCommand(p.data.agentId, { accountId, action: parsed.data.action, args: parsed.data.args });
    if (r.status === 200 && typeof r.body?.commandId === "string") return reply.code(202).send({ commandId: r.body.commandId });
    if (r.status === 400) return reply.code(400).send({ error: "bad_request", message: r.body?.detail ?? r.body?.message });
    const status = [403, 409, 429, 503].includes(r.status) ? r.status : 502;
    return reply.code(status).send({ error: r.body?.error ?? "command_failed", ...(r.body?.message ? { message: String(r.body.message).slice(0, 300) } : {}) });
  });

  app.get("/portal/api/code/commands/:commandId", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const userId = await signedIn(req, reply);
    if (!userId) return reply;
    const p = z.object({ commandId: commandIdSchema }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    for (const base of await coordinators()) {
      try {
        // The coordinator answers only the account that sent it; anyone else's id is unknown there.
        const r = await postJson(`${base}/agent-control/code-commands/${encodeURIComponent(p.data.commandId)}`, { accountId: `acct-${userId}` });
        if (r.status !== 200 || !r.body || typeof r.body.status !== "string") continue;
        const status = COMMAND_STATUS[r.body.status] ?? "failed";
        const result = r.body.result;
        return reply.send({
          status,
          ...(result?.data !== undefined ? { result: result.data } : {}),
          ...(status === "failed" ? { error: str(result?.error, 80) || "failed" } : {}),
          ...(status === "failed" && typeof result?.message === "string" ? { message: result.message.slice(0, 300) } : {}),
        });
      } catch {
        /* try the next coordinator */
      }
    }
    return reply.code(404).send({ error: "unknown_command" });
  });
}
