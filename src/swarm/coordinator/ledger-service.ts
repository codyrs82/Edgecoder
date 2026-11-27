// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// Coordinator wiring of the ledger service (src/ledger-service):
// - a seed (its own DATABASE_URL) serves POST /ledger/v1/* to outside coordinators while
//   LEDGER_SERVICE_ENABLED is on, and the owner's admin routes to see, stop and resume one member's
//   billing here at once (/admin/ledger-service/members/*);
// - an outside coordinator with LEDGER_SERVICE_URL (or, in production, no DATABASE_URL) bills its
//   calls through that service instead of its own database (credits/store.ts setRemoteLedger).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgStore } from "../../db/store.js";
import { setRemoteLedger } from "../../credits/store.js";
import { LedgerService, ledgerServiceConfigFromEnv, registerLedgerServiceRoutes } from "../../ledger-service/server.js";
import { LedgerServiceClient, ledgerServiceUrlFromEnv } from "../../ledger-service/client.js";
import { rawBodyOf } from "../../security/request-signing.js";
import { DEFAULT_DISCOVERY_URL } from "../../portal/coordinator-discovery.js";
import { app, type CoordinatorApp } from "./app.js";
import { CC, coordinatorKeys, identity, portalActionKeys, registryTrust, securityLog, setLedgerServiceOn } from "./context.js";
import { ordering } from "./agent-state.js";
import { persistStatsLedgerRecord } from "./stats-ledger.js";

/** The seeds' service (null without a database of its own). */
export const ledgerService: LedgerService | null = pgStore
  ? new LedgerService({
      store: pgStore,
      config: ledgerServiceConfigFromEnv(CC),
      member: (peerId) => registryTrust.member(peerId),
      portalKeys: () => [...portalActionKeys()],
      recordAccrual: async (r) => {
        const record = ordering.append({
          eventType: "earnings_accrual",
          taskId: r.taskId,
          subtaskId: r.subtaskId,
          actorId: r.hostAccountId,
          coordinatorId: identity.peerId,
          payloadJson: JSON.stringify(r.payload)
        });
        await pgStore?.persistLedgerRecord(record);
        await persistStatsLedgerRecord(record);
      },
      alert: (event, detail) => {
        app.log.error(detail, event);
        securityLog.log({
          level: securityLog.severity("ledger_service_member_suspended"),
          event: "ledger_service_member_suspended",
          source: { type: "coordinator", id: String(detail.peerId ?? "unknown") },
          details: detail,
          action: "billing_suspended",
          coordinatorId: identity.peerId
        });
      },
      log: (msg, detail) => app.log.warn(detail ?? {}, msg)
    })
  : null;
// Run 24: peers that are billable community members get billed calls only while this runs (context.ts peerMayBillCalls).
setLedgerServiceOn(ledgerService !== null);

/** Where this coordinator bills, when not on its own database (outside coordinators). */
export const ledgerServiceUrl = ledgerServiceUrlFromEnv({ LEDGER_SERVICE_URL: CC.LEDGER_SERVICE_URL, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV }, DEFAULT_DISCOVERY_URL);

/** Install the remote ledger client (outside coordinators) and the seeds' routes and sweep. */
export function registerLedgerService(coordinatorApp: CoordinatorApp): void {
  if (ledgerServiceUrl) {
    setRemoteLedger(new LedgerServiceClient({ baseUrl: ledgerServiceUrl, peerId: identity.peerId, privateKeyPem: coordinatorKeys.privateKeyPem, publicKeyPem: identity.publicKeyPem }));
    coordinatorApp.log.info({ ledgerServiceUrl }, "billing_through_ledger_service");
  }
  if (!ledgerService) return;
  registerLedgerServiceRoutes(coordinatorApp as never, ledgerService, rawBodyOf);
  if (ledgerService.enabled && !process.env.VITEST) {
    coordinatorApp.addHook("onReady", async () => ledgerService.startSweep());
    coordinatorApp.addHook("onClose", async () => ledgerService.stopSweep());
  }
}

const memberBody = z.object({ peerId: z.string().min(1).max(256), reason: z.string().trim().max(500).optional() });

/** Admin (inside the admin plugin, behind authorizeAdmin): one member's billing here. */
export function registerLedgerServiceAdminRoutes(admin: FastifyInstance): void {
  admin.get("/admin/ledger-service/members/:peerId", async (req, reply) => {
    if (!ledgerService) return reply.code(404).send({ error: "ledger_service_unavailable" });
    const peerId = String((req.params as { peerId?: string }).peerId ?? "");
    return reply.send(await ledgerService.memberStatus(peerId));
  });
  // Stops billing for the member on every seed at once (the state is in the shared database).
  admin.post("/admin/ledger-service/members/disable", async (req, reply) => {
    if (!ledgerService) return reply.code(404).send({ error: "ledger_service_unavailable" });
    const parsed = memberBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    await ledgerService.disableMember(parsed.data.peerId, parsed.data.reason || "disabled_by_owner");
    return reply.send(await ledgerService.memberStatus(parsed.data.peerId));
  });
  admin.post("/admin/ledger-service/members/enable", async (req, reply) => {
    if (!ledgerService) return reply.code(404).send({ error: "ledger_service_unavailable" });
    const parsed = memberBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    await ledgerService.enableMember(parsed.data.peerId);
    return reply.send(await ledgerService.memberStatus(parsed.data.peerId));
  });
}
