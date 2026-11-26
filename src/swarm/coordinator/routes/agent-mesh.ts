// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent mesh routes: peer lookup, tunnels, relay, direct work and model requests.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pairKey } from "../../coordinator-utils.js";
import type { CoordinatorApp } from "../app.js";
import {
  activeBlacklistRecord,
  agentCapabilities,
  tunnelByPairKey,
  activeTunnels,
  pendingTunnelInvites,
  relayWindowByAgent,
  RELAY_RATE_LIMIT_PER_10S,
  TUNNEL_MAX_RELAYS_PER_MIN,
  pendingTunnelCloseNotices,
  offerWindowByAgent,
  DIRECT_WORK_OFFERS_PER_10S,
  type DirectWorkOffer,
  directWorkById,
  directWorkInbox,
  pruneDirectWork,
  DIRECT_WORK_INBOX_MAX,
  DIRECT_WORK_INPUT_MAX_CHARS
} from "../agent-state.js";
import { requireMeshToken, requireAgentSelf, agentSignatureAtGate } from "../auth.js";
import { accountsFor, verifiedAccountOf } from "../agent-accounts.js";
import { DIRECT_WORK_MARKET_HINT, directWorkAccountDecision, type DirectWorkAccountDecision } from "../../direct-work-policy.js";

/** Direct work is unpaid: only between agents of the same verified account (src/swarm/direct-work-policy.ts). */
async function directWorkAccounts(fromAgentId: string, toAgentId: string): Promise<DirectWorkAccountDecision> {
  const [from, to] = await Promise.all([verifiedAccountOf(fromAgentId), verifiedAccountOf(toAgentId)]);
  return directWorkAccountDecision(from, to);
}

/** A refused /agent-mesh/connect is logged at most once per agent pair per hour. */
export const CONNECT_REFUSAL_LOG_INTERVAL_MS = 60 * 60_000;
const connectRefusalLoggedAt = new Map<string, number>();

export function shouldLogConnectRefusal(fromAgentId: string, toAgentId: string, nowMs: number): boolean {
  const key = pairKey(fromAgentId, toAgentId);
  const last = connectRefusalLoggedAt.get(key);
  if (last !== undefined && nowMs - last < CONNECT_REFUSAL_LOG_INTERVAL_MS) return false;
  if (connectRefusalLoggedAt.size >= 10_000) {
    for (const [k, at] of connectRefusalLoggedAt) if (nowMs - at >= CONNECT_REFUSAL_LOG_INTERVAL_MS) connectRefusalLoggedAt.delete(k);
    if (connectRefusalLoggedAt.size >= 10_000) connectRefusalLoggedAt.clear();
  }
  connectRefusalLoggedAt.set(key, nowMs);
  return true;
}

export function registerAgentMeshRoutes(app: CoordinatorApp): void {
  app.get("/agent-mesh/peers/:agentId", async (req, reply) => {
    const params = z.object({ agentId: z.string() }).parse(req.params);
    // A coordinator (mesh token), or the named agent itself (its signature over this GET).
    const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
    const signer = agentSignatureAtGate(headers, "GET", String(req.url ?? "").split("?")[0]);
    if (signer !== params.agentId && !requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    if (activeBlacklistRecord(params.agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
    const candidates = [...agentCapabilities.keys()].filter(
      (id) => id !== params.agentId && !activeBlacklistRecord(id)
    );
    // Only peers this agent may open a tunnel to (/agent-mesh/connect): same verified account.
    const accounts = await accountsFor([params.agentId, ...candidates], Date.now());
    const own = accounts.get(params.agentId) ?? null;
    const peers = candidates.filter((id) => directWorkAccountDecision(own, accounts.get(id) ?? null).ok);
    return { peers };
  });

  app.get("/agent-mesh/models/available", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const query = z
      .object({
        provider: z.enum(["edgecoder-local", "ollama-local"]).optional(),
        includeBlacklisted: z.coerce.boolean().optional().default(false)
      })
      .parse(req.query);
    const models = [...agentCapabilities.entries()]
      .filter(([agentId, info]) => {
        if (!query.includeBlacklisted && activeBlacklistRecord(agentId)) return false;
        if (!info.localModelEnabled) return false;
        if (query.provider && info.localModelProvider !== query.provider) return false;
        return true;
      })
      .map(([agentId, info]) => ({
        agentId,
        provider: info.localModelProvider,
        modelCatalog: info.localModelCatalog,
        maxConcurrentTasks: info.maxConcurrentTasks,
        connectedPeers: info.connectedPeers.size
      }));
    return { models, generatedAtMs: Date.now() };
  });

  app.post("/agent-mesh/connect", async (req, reply) => {
    const body = z.object({ fromAgentId: z.string(), toAgentId: z.string() }).parse(req.body);
    if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
    if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
      return reply.code(403).send({ error: "agent_blacklisted" });
    }
    if (!agentCapabilities.has(body.fromAgentId) || !agentCapabilities.has(body.toAgentId)) {
      return reply.code(404).send({ error: "agent_not_found" });
    }
    const accounts = await directWorkAccounts(body.fromAgentId, body.toAgentId);
    if (!accounts.ok) {
      if (shouldLogConnectRefusal(body.fromAgentId, body.toAgentId, Date.now())) {
        app.log.warn({ fromAgentId: body.fromAgentId, toAgentId: body.toAgentId, reason: accounts.error }, "agent_mesh_connect_refused");
      }
      return reply.code(403).send({ error: accounts.error, message: DIRECT_WORK_MARKET_HINT, market: "/submit" });
    }
    const existing = tunnelByPairKey.get(pairKey(body.fromAgentId, body.toAgentId));
    if (existing) {
      const tunnel = activeTunnels.get(existing);
      if (tunnel) {
        tunnel.lastRelayMs = Date.now();
        activeTunnels.set(existing, tunnel);
        return { ok: true, token: existing, reused: true };
      }
      tunnelByPairKey.delete(pairKey(body.fromAgentId, body.toAgentId));
    }
    const token = randomUUID();
    activeTunnels.set(token, {
      fromAgentId: body.fromAgentId,
      toAgentId: body.toAgentId,
      createdAtMs: Date.now(),
      lastRelayMs: Date.now(),
      relayCount: 0,
      relayWindowStartMs: Date.now() - (Date.now() % 60_000),
      relayWindowCount: 0
    });
    tunnelByPairKey.set(pairKey(body.fromAgentId, body.toAgentId), token);
    const pending = pendingTunnelInvites.get(body.toAgentId) ?? [];
    pending.push({ fromAgentId: body.fromAgentId, token });
    pendingTunnelInvites.set(body.toAgentId, pending);
    return { ok: true, token };
  });

  app.post("/agent-mesh/accept", async (req, reply) => {
    const body = z.object({ agentId: z.string(), token: z.string() }).parse(req.body);
    if (!(await requireAgentSelf(req, reply, body.agentId))) return;
    if (activeBlacklistRecord(body.agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
    const tunnel = activeTunnels.get(body.token);
    if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
    if (tunnel.toAgentId !== body.agentId) return reply.code(403).send({ error: "tunnel_target_mismatch" });
    agentCapabilities.get(tunnel.fromAgentId)?.connectedPeers.add(tunnel.toAgentId);
    agentCapabilities.get(tunnel.toAgentId)?.connectedPeers.add(tunnel.fromAgentId);
    return { ok: true };
  });

  app.post("/agent-mesh/relay", async (req, reply) => {
    const body = z.object({ token: z.string(), fromAgentId: z.string(), payload: z.string() }).parse(req.body);
    if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
    if (activeBlacklistRecord(body.fromAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
    const tunnel = activeTunnels.get(body.token);
    if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
    if (tunnel.fromAgentId !== body.fromAgentId && tunnel.toAgentId !== body.fromAgentId) {
      return reply.code(403).send({ error: "tunnel_peer_mismatch" });
    }
    if (body.payload.length > 16_384) {
      return reply.code(413).send({ error: "relay_payload_too_large" });
    }
    const now = Date.now();
    const relayWindowStart = now - (now % 10_000);
    const relayWindow = relayWindowByAgent.get(body.fromAgentId);
    if (!relayWindow || relayWindow.windowMs !== relayWindowStart) {
      relayWindowByAgent.set(body.fromAgentId, { windowMs: relayWindowStart, count: 1 });
    } else {
      relayWindow.count += 1;
      if (relayWindow.count > RELAY_RATE_LIMIT_PER_10S) {
        return reply.code(429).send({ error: "relay_rate_limited" });
      }
    }
    const relayMinuteWindowStart = now - (now % 60_000);
    if (tunnel.relayWindowStartMs !== relayMinuteWindowStart) {
      tunnel.relayWindowStartMs = relayMinuteWindowStart;
      tunnel.relayWindowCount = 0;
    }
    if (tunnel.relayWindowCount >= TUNNEL_MAX_RELAYS_PER_MIN) {
      return reply.code(429).send({ error: "tunnel_relay_cap_reached" });
    }
    tunnel.lastRelayMs = Date.now();
    tunnel.relayCount += 1;
    tunnel.relayWindowCount += 1;
    activeTunnels.set(body.token, tunnel);
    return { ok: true, relayCount: tunnel.relayCount };
  });

  app.post("/agent-mesh/close", async (req, reply) => {
    const body = z.object({ fromAgentId: z.string(), token: z.string(), reason: z.string() }).parse(req.body);
    if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
    const tunnel = activeTunnels.get(body.token);
    if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
    if (tunnel.fromAgentId !== body.fromAgentId && tunnel.toAgentId !== body.fromAgentId) {
      return reply.code(403).send({ error: "tunnel_peer_mismatch" });
    }
    const peerAgentId = tunnel.fromAgentId === body.fromAgentId ? tunnel.toAgentId : tunnel.fromAgentId;
    activeTunnels.delete(body.token);
    tunnelByPairKey.delete(pairKey(tunnel.fromAgentId, tunnel.toAgentId));
    agentCapabilities.get(tunnel.fromAgentId)?.connectedPeers.delete(tunnel.toAgentId);
    agentCapabilities.get(tunnel.toAgentId)?.connectedPeers.delete(tunnel.fromAgentId);
    const notices = pendingTunnelCloseNotices.get(peerAgentId) ?? [];
    notices.push({ peerAgentId: body.fromAgentId, token: body.token, reason: body.reason });
    pendingTunnelCloseNotices.set(peerAgentId, notices);
    return { ok: true };
  });

  app.post("/agent-mesh/close-ack", async (req, reply) => {
    const body = z.object({ agentId: z.string(), token: z.string() }).parse(req.body);
    if (!(await requireAgentSelf(req, reply, body.agentId))) return;
    const notices = (pendingTunnelCloseNotices.get(body.agentId) ?? []).filter((n) => n.token !== body.token);
    pendingTunnelCloseNotices.set(body.agentId, notices);
    return { ok: true };
  });

  app.post("/agent-mesh/direct-work/offer", async (req, reply) => {
    const parsedOffer = z
      .object({
        fromAgentId: z.string(),
        toAgentId: z.string(),
        workType: z.enum(["code_task", "model_inference"]).default("code_task"),
        language: z.enum(["python", "javascript"]).optional(),
        input: z.string().min(1).max(DIRECT_WORK_INPUT_MAX_CHARS)
      })
      .safeParse(req.body);
    if (!parsedOffer.success) return reply.code(400).send({ error: "invalid_offer", issues: parsedOffer.error.issues.slice(0, 5) });
    const body = parsedOffer.data;
    if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
    if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
      return reply.code(403).send({ error: "agent_blacklisted" });
    }
    if (!agentCapabilities.has(body.fromAgentId) || !agentCapabilities.has(body.toAgentId)) {
      return reply.code(404).send({ error: "agent_not_found" });
    }
    const accounts = await directWorkAccounts(body.fromAgentId, body.toAgentId);
    if (!accounts.ok) {
      app.log.warn({ fromAgentId: body.fromAgentId, toAgentId: body.toAgentId, reason: accounts.error }, "direct_work_offer_refused");
      return reply.code(403).send({ error: accounts.error, message: DIRECT_WORK_MARKET_HINT, market: "/submit" });
    }
    const now = Date.now();
    const offerWindowStart = now - (now % 10_000);
    const offerWindow = offerWindowByAgent.get(body.fromAgentId);
    if (!offerWindow || offerWindow.windowMs !== offerWindowStart) {
      offerWindowByAgent.set(body.fromAgentId, { windowMs: offerWindowStart, count: 1 });
    } else {
      offerWindow.count += 1;
      if (offerWindow.count > DIRECT_WORK_OFFERS_PER_10S) {
        return reply.code(429).send({ error: "direct_work_offer_rate_limited" });
      }
    }
    pruneDirectWork(now);
    const pending = (directWorkInbox.get(body.toAgentId) ?? []).filter((id) => directWorkById.get(id)?.status === "offered");
    if (pending.length >= DIRECT_WORK_INBOX_MAX) return reply.code(429).send({ error: "target_inbox_full" });
    const offer: DirectWorkOffer = {
      offerId: randomUUID(),
      fromAgentId: body.fromAgentId,
      toAgentId: body.toAgentId,
      workType: body.workType,
      language: body.workType === "code_task" ? (body.language ?? "python") : undefined,
      input: body.input,
      createdAtMs: Date.now(),
      status: "offered",
      fromAccountId: accounts.accountId
    };
    directWorkById.set(offer.offerId, offer);
    const inbox = directWorkInbox.get(body.toAgentId) ?? [];
    inbox.push(offer.offerId);
    directWorkInbox.set(body.toAgentId, inbox);
    return { ok: true, offerId: offer.offerId };
  });

  app.post("/agent-mesh/models/request", async (req, reply) => {
    const body = z
      .object({
        fromAgentId: z.string(),
        toAgentId: z.string(),
        prompt: z.string().min(1).max(16_384)
      })
      .parse(req.body);
    if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
    if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
      return reply.code(403).send({ error: "agent_blacklisted" });
    }
    const fromInfo = agentCapabilities.get(body.fromAgentId);
    const toInfo = agentCapabilities.get(body.toAgentId);
    if (!fromInfo || !toInfo) {
      return reply.code(404).send({ error: "agent_not_found" });
    }
    if (!toInfo.localModelEnabled) {
      return reply.code(409).send({ error: "target_has_no_local_model" });
    }
    const accounts = await directWorkAccounts(body.fromAgentId, body.toAgentId);
    if (!accounts.ok) {
      app.log.warn({ fromAgentId: body.fromAgentId, toAgentId: body.toAgentId, reason: accounts.error }, "direct_work_model_request_refused");
      return reply.code(403).send({ error: accounts.error, message: DIRECT_WORK_MARKET_HINT, market: "/submit" });
    }
    const now = Date.now();
    const offerWindowStart = now - (now % 10_000);
    const offerWindow = offerWindowByAgent.get(body.fromAgentId);
    if (!offerWindow || offerWindow.windowMs !== offerWindowStart) {
      offerWindowByAgent.set(body.fromAgentId, { windowMs: offerWindowStart, count: 1 });
    } else {
      offerWindow.count += 1;
      if (offerWindow.count > DIRECT_WORK_OFFERS_PER_10S) {
        return reply.code(429).send({ error: "direct_work_offer_rate_limited" });
      }
    }
    pruneDirectWork(now);
    const pendingForTarget = (directWorkInbox.get(body.toAgentId) ?? []).filter((id) => directWorkById.get(id)?.status === "offered");
    if (pendingForTarget.length >= DIRECT_WORK_INBOX_MAX) return reply.code(429).send({ error: "target_inbox_full" });
    const offer: DirectWorkOffer = {
      offerId: randomUUID(),
      fromAgentId: body.fromAgentId,
      toAgentId: body.toAgentId,
      workType: "model_inference",
      input: body.prompt,
      createdAtMs: now,
      status: "offered",
      fromAccountId: accounts.accountId
    };
    directWorkById.set(offer.offerId, offer);
    const inbox = directWorkInbox.get(body.toAgentId) ?? [];
    inbox.push(offer.offerId);
    directWorkInbox.set(body.toAgentId, inbox);
    return { ok: true, offerId: offer.offerId, targetProvider: toInfo.localModelProvider };
  });

  app.get("/agent-mesh/models/request/:offerId", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    const params = z.object({ offerId: z.string() }).parse(req.params);
    const offer = directWorkById.get(params.offerId);
    if (!offer) return reply.code(404).send({ error: "offer_not_found" });
    if (offer.workType !== "model_inference") {
      return reply.code(409).send({ error: "offer_not_model_request" });
    }
    return {
      offerId: offer.offerId,
      fromAgentId: offer.fromAgentId,
      toAgentId: offer.toAgentId,
      status: offer.status,
      acceptedAtMs: offer.acceptedAtMs,
      result: offer.result ?? null
    };
  });

  app.post("/agent-mesh/direct-work/accept", async (req, reply) => {
    const body = z.object({ offerId: z.string(), byAgentId: z.string() }).parse(req.body);
    if (!(await requireAgentSelf(req, reply, body.byAgentId))) return;
    if (activeBlacklistRecord(body.byAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
    const offer = directWorkById.get(body.offerId);
    if (!offer) return reply.code(404).send({ error: "offer_not_found" });
    if (offer.toAgentId !== body.byAgentId) return reply.code(403).send({ error: "offer_target_mismatch" });
    if (offer.status !== "offered") return reply.code(409).send({ error: "offer_not_available" });
    // Checked again: ownership may have moved since the offer was queued.
    const accounts = await directWorkAccounts(offer.fromAgentId, body.byAgentId);
    if (!accounts.ok) {
      offer.status = "rejected";
      app.log.warn({ offerId: offer.offerId, fromAgentId: offer.fromAgentId, byAgentId: body.byAgentId, reason: accounts.error }, "direct_work_accept_refused");
      return reply.code(403).send({ error: accounts.error, message: DIRECT_WORK_MARKET_HINT, market: "/submit" });
    }
    offer.status = "accepted";
    offer.acceptedBy = body.byAgentId;
    offer.acceptedAtMs = Date.now();
    directWorkById.set(body.offerId, offer);
    const inbox = (directWorkInbox.get(body.byAgentId) ?? []).filter((id) => id !== body.offerId);
    directWorkInbox.set(body.byAgentId, inbox);
    return { ok: true, accepted: true, offer };
  });

  app.post("/agent-mesh/direct-work/result", async (req, reply) => {
    const body = z
      .object({
        offerId: z.string(),
        byAgentId: z.string(),
        ok: z.boolean(),
        output: z.string(),
        error: z.string().optional(),
        durationMs: z.number()
      })
      .parse(req.body);
    if (!(await requireAgentSelf(req, reply, body.byAgentId))) return;
    if (activeBlacklistRecord(body.byAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
    const offer = directWorkById.get(body.offerId);
    if (!offer) return reply.code(404).send({ error: "offer_not_found" });
    if (offer.toAgentId !== body.byAgentId) return reply.code(403).send({ error: "offer_target_mismatch" });
    if (offer.status !== "accepted") return reply.code(409).send({ error: "offer_not_accepted" });
    offer.status = "completed";
    offer.result = {
      ok: body.ok,
      output: body.output,
      error: body.error,
      durationMs: body.durationMs,
      completedAtMs: Date.now()
    };
    directWorkById.set(body.offerId, offer);
    return { ok: true };
  });
}
