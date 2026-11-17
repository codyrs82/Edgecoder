// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The web tool (docs/web-tool.md): POST /v1/tools/web/status, /v1/tools/web/search and
 * /v1/tools/web/read, for the caller's account. Callers: a signed agent (the desktop app's IDE
 * server through its local forwarder; the account is the signer's owner) or the portal (service
 * token; the portal names the account it authenticated: a web chat user or an API key). Searches
 * and page reads run here, on EdgeCoder's servers, never on a host's machine; the Brave key
 * (BRAVE_SEARCH_API_KEY) stays here. Billing and limits: src/web-tool/service.ts.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { creditEngine, grantCreditsIdempotent, spendCredits } from "../../../credits/store.js";
import { pgStore } from "../../../db/store.js";
import { WebToolService, webToolConfigFromEnv } from "../../../web-tool/service.js";
import type { CoordinatorApp } from "../app.js";
import { callerAccount } from "../auth.js";
import { CC } from "../context.js";

export const webToolService = new WebToolService(webToolConfigFromEnv(CC), {
  debit: async (accountId, cSats, reason, key) => {
    await spendCredits(accountId, cSats, reason, undefined, { idempotencyKey: key });
  },
  refund: async (accountId, cSats, reason, key) => {
    await grantCreditsIdempotent(accountId, cSats, reason, key);
  },
  balance: async (accountId) => (pgStore ? await pgStore.creditBalance(accountId) : creditEngine.balance(accountId)),
});

const base = { accountId: z.string().max(200).optional(), requestId: z.string().min(1).max(100).optional() };

export function registerWebToolRoutes(app: CoordinatorApp, service: WebToolService = webToolService): void {
  app.post("/v1/tools/web/status", async (req, reply) => {
    const body = z.object(base).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const caller = await callerAccount(req, "/v1/tools/web/status", body.data.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    return reply.send(await service.status(caller.accountId));
  });

  app.post("/v1/tools/web/search", async (req, reply) => {
    const body = z.object({ ...base, query: z.string().max(2_000), count: z.number().min(1).max(8).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request", message: "Send {query, count?}." });
    const caller = await callerAccount(req, "/v1/tools/web/search", body.data.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    const r = await service.search(caller.accountId, body.data.query, body.data.count ?? 5, body.data.requestId ?? randomUUID());
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    req.log.info({ accountId: caller.accountId, results: r.value.results.length, cSats: r.cSats }, "web_search");
    return reply.send({ ...r.value, cSats: r.cSats });
  });

  app.post("/v1/tools/web/read", async (req, reply) => {
    const body = z.object({ ...base, url: z.string().min(1).max(4_000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request", message: "Send {url}." });
    const caller = await callerAccount(req, "/v1/tools/web/read", body.data.accountId);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    const r = await service.read(caller.accountId, body.data.url, body.data.requestId ?? randomUUID());
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    // The host only: page URLs can carry tokens in their query strings.
    req.log.info({ accountId: caller.accountId, host: new URL(r.value.url).hostname, chars: r.value.text.length, cSats: r.cSats }, "read_page");
    return reply.send({ url: r.value.url, title: r.value.title, text: r.value.text, truncated: r.value.truncated, contentType: r.value.contentType, cSats: r.cSats });
  });
}
