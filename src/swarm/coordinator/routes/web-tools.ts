// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The web tool (docs/web-tool.md): POST /v1/tools/web/status, /v1/tools/web/search and
 * /v1/tools/web/read, for the caller's account. Callers: a signed agent (the desktop app's IDE
 * server through its local forwarder; the account is the signer's owner) or the portal (service
 * token; the portal names the account it authenticated: a web chat user or an API key). Searches
 * and page reads run here, on EdgeCoder's servers (or, for own-machine chats, on that machine; below); the Brave key
 * (BRAVE_SEARCH_API_KEY) stays here. Billing and limits: src/web-tool/service.ts.
 *
 * Free on your own machine: a body may say `ownMachine: true` (the chat's model runs on the
 * account's own machine). It counts only from a caller that can vouch for it (ownMachineBasis):
 * the portal, which resolved the chat's compute itself (and never relays a client's claim), or a
 * signed agent linked to the very account the call is billed to (the desktop's local model on that
 * agent's machine). Anything else is ignored and the call is paid as usual.
 *
 * Searched on your own machine (src/web-tool/local-web.ts, ../local-web.ts): with that basis the
 * search (or page read) is first sent to one of the account's own machines that has local web, as a
 * signed local_web frame down its mesh WebSocket; it answers on
 *   POST /agent-control/agents/:agentId/web/result   the agent itself (signed)
 * Free and uncapped when it answers; otherwise the usual path.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { creditEngine, grantCreditsIdempotent, spendCredits } from "../../../credits/store.js";
import { pgStore } from "../../../db/store.js";
import { WebToolService, webToolConfigFromEnv } from "../../../web-tool/service.js";
import type { CoordinatorApp } from "../app.js";
import { callerAccount, requireAgentSelf } from "../auth.js";
import { CC, coordinatorKeys, identity, saveUsage } from "../context.js";
import { freeWebUsageRecord, ownMachineBasis } from "../../../web-tool/basis.js";
import { localWebResultSchema, type LocalWebResult } from "../../../web-tool/local-web.js";
import { accountsFor } from "../agent-accounts.js";
import { agentCapabilities } from "../agent-state.js";
import { acceptLocalWebResult, defaultLocalWebDeps, LocalWebRelay } from "../local-web.js";

export const localWebRelay = new LocalWebRelay(
  defaultLocalWebDeps({
    accountsFor: (ids, now) => accountsFor(ids, now),
    lastSeenMs: (id) => agentCapabilities.get(id)?.lastSeenMs ?? 0,
    coordinatorId: () => identity.peerId,
    privateKeyPem: () => coordinatorKeys.privateKeyPem,
  }),
);

export const webToolService = new WebToolService(webToolConfigFromEnv(CC), {
  debit: async (accountId, cSats, reason, key) => {
    await spendCredits(accountId, cSats, reason, undefined, { idempotencyKey: key });
  },
  refund: async (accountId, cSats, reason, key) => {
    await grantCreditsIdempotent(accountId, cSats, reason, key);
  },
  balance: async (accountId) => (pgStore ? await pgStore.creditBalance(accountId) : creditEngine.balance(accountId)),
  recordFree: (accountId, count) => saveUsage(freeWebUsageRecord(accountId, count, identity.peerId)),
  local: {
    available: (accountId, prefer) => localWebRelay.available(accountId, prefer),
    search: (accountId, query, count, prefer) => localWebRelay.search(accountId, query, count, prefer),
    read: (accountId, url, prefer) => localWebRelay.read(accountId, url, prefer),
  },
});

const base = { accountId: z.string().max(200).optional(), requestId: z.string().min(1).max(100).optional(), ownMachine: z.boolean().optional() };

export function registerWebToolRoutes(app: CoordinatorApp, service: WebToolService = webToolService): void {
  app.post("/v1/tools/web/status", async (req, reply) => {
    const body = z.object(base).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const caller = await callerAccount(req, "/v1/tools/web/status", body.data.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    return reply.send(await service.status(caller.accountId, ownMachineBasis(caller, body.data.ownMachine)));
  });

  app.post("/v1/tools/web/search", async (req, reply) => {
    const body = z.object({ ...base, query: z.string().max(2_000), count: z.number().min(1).max(8).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request", message: "Send {query, count?}." });
    const caller = await callerAccount(req, "/v1/tools/web/search", body.data.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    const r = await service.search(caller.accountId, body.data.query, body.data.count ?? 5, body.data.requestId ?? randomUUID(), ownMachineBasis(caller, body.data.ownMachine));
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    req.log.info({ accountId: caller.accountId, results: r.value.results.length, cSats: r.cSats, free: r.free === true, local: r.local === true }, "web_search");
    return reply.send({ ...r.value, cSats: r.cSats, ...(r.free ? { free: true } : {}), ...(r.local ? { local: true } : {}) });
  });

  app.post("/v1/tools/web/read", async (req, reply) => {
    const body = z.object({ ...base, url: z.string().min(1).max(4_000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request", message: "Send {url}." });
    const caller = await callerAccount(req, "/v1/tools/web/read", body.data.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    const r = await service.read(caller.accountId, body.data.url, body.data.requestId ?? randomUUID(), ownMachineBasis(caller, body.data.ownMachine));
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    // The host only: page URLs can carry tokens in their query strings.
    req.log.info({ accountId: caller.accountId, host: new URL(r.value.url).hostname, chars: r.value.text.length, cSats: r.cSats, free: r.free === true, local: r.local === true }, "read_page");
    return reply.send({ url: r.value.url, title: r.value.title, text: r.value.text, truncated: r.value.truncated, contentType: r.value.contentType, cSats: r.cSats, ...(r.free ? { free: true } : {}), ...(r.local ? { local: true } : {}) });
  });

  app.post("/agent-control/agents/:agentId/web/result", { bodyLimit: 512 * 1024 }, async (req, reply) => {
    const params = z.object({ agentId: z.string().min(1).max(128) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    if (!(await requireAgentSelf(req, reply, params.data.agentId))) return reply;
    const body = localWebResultSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_result" });
    const r = acceptLocalWebResult(params.data.agentId, body.data as LocalWebResult);
    if (!r.ok) return reply.code(404).send(r);
    return reply.send({ ok: true });
  });
}
