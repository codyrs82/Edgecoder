// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Agent routes: register, heartbeat, benchmark response and diagnostics.
 */
import { noteLocalWebReport } from "../local-web.js";
import { z } from "zod";
import type { SandboxMode } from "../../../common/types.js";
import { rewardAccountForAgent } from "../../../credits/store.js";
import { pgStore } from "../../../db/store.js";
import { classifyHardware } from "../../../economy/compute-classes.js";
import { normalizeReportedModels } from "../../model-catalog.js";
import { cloudHostAllowed, filterCloudModels } from "../cloud-hosts.js";
import type { ChallengeResponse } from "../../benchmark.js";
import { rawBodyOf } from "../../../security/request-signing.js";
import {
  verifyBinaryIntegrity,
  type VerificationStatus,
  type BinaryIntegrityPayload
} from "../../../security/release-verifier.js";
import type { CoordinatorApp } from "../app.js";
import {
  requestOrigin,
  agentRateLimiter,
  agentChunkRateLimiter,
  agentLeaseRateLimiter,
  agentPullRateLimiter,
  queue,
  OLLAMA_MODEL,
  securityLog,
  identity,
  preAuthFailures
} from "../context.js";
import { mutable } from "../mutable-state.js";
import {
  agentCapabilities,
  activeBlacklistRecord,
  releaseManifestCache,
  REQUIRE_VERIFIED_AGENTS,
  behaviorTracker,
  autoBlacklister,
  evaluateAndEnforce,
  ordering,
  pendingTunnelInvites,
  pendingTunnelCloseNotices,
  directWorkInbox,
  directWorkById,
  pruneDirectWork,
  DIRECT_WORK_OFFER_TTL_MS,
  DIRECT_WORK_INBOX_MAX,
  type DirectWorkOffer,
  agentOrchestration,
  blacklistByAgent
} from "../agent-state.js";
import { extractSignedHeaders, verifyAgentRequest, hasMeshToken, hasPortalServiceToken, agentSignatureAtGate } from "../auth.js";
import {
  rateOracleConfig,
  CLOUD_HOST_OWNERS,
  hardwareVerifier,
  marketOrders,
  effectiveHardware,
  orderBook,
  askCapabilityOf,
  verificationSummary,
  benchmarkModelFor,
  pickBenchmarkWitness,
  repostAsk
} from "../economy.js";
import { diagnosticsByAgentId } from "../services.js";
import { persistStatsLedgerRecord } from "../stats-ledger.js";
import { validatePortalNode } from "../enrollment.js";
import { attestAgentSigningKey } from "../attested-keys.js";
import { sanitizeLanAddresses } from "../../lan-proximity.js";
import { noteAgentMemory } from "../memory-admission.js";
import { meshWsAgentRegistered } from "../mesh-ws-bindings.js";
import { agentUpdateHint } from "../agent-update-hint.js";
import { noteAgentHttpAlive } from "../agent-liveness.js";
import {
  registerSchema,
  defaultPolicy,
  heartbeatSchema,
  benchmarkResponseSchema,
  diagnosticsSchema
} from "../schemas.js";

/**
 * Proof of key for /register: the request is signed (worker-runner signs /register) by the key
 * this coordinator already holds for the agent, and keeps that key. A key change never counts as
 * proof; it needs a portal-validated registration token (or the loopback exemption).
 */
async function registerProvesStoredKey(
  req: unknown,
  agentId: string,
  claimedKeyPem: string | undefined,
  storedKeyPem: string | undefined
): Promise<boolean> {
  if (!storedKeyPem) return false;
  if (claimedKeyPem !== undefined && claimedKeyPem !== storedKeyPem) return false;
  const r = req as { headers?: Record<string, unknown>; ip?: string };
  const headers = r.headers ?? {};
  if (!extractSignedHeaders(headers)) return false;
  const verified = await verifyAgentRequest(headers, "/register", r.ip, { requireSigned: true, rawBody: rawBodyOf(req as any) });
  return verified !== null && verified !== "rejected" && verified.agentId === agentId;
}

export function registerAgentRoutes(app: CoordinatorApp): void {
  app.post("/register", async (req, reply) => {
    const parsedRegister = registerSchema.safeParse(req.body);
    if (!parsedRegister.success) {
      // A malformed registration is the agent's fault, not a server error: 400 with the
      // issues so the agent logs something actionable instead of retrying a 500 forever.
      return reply.code(400).send({ error: "invalid_registration", issues: parsedRegister.error.issues });
    }
    const body = parsedRegister.data;
    const now = Date.now();
    // A registration without a hardware profile (the agent's reconnect probe after a coordinator
    // restart, older agents) makes no new claim: it keeps the last one this agent made (in memory,
    // else from its stored verification record) instead of reclassifying it as cpu.std, which reset
    // a proven grant and showed GPUs / Apple silicon as CPU until the next full registration.
    // Anti-spoofing is unchanged: the kept claim is verified exactly as if it had been re-sent.
    const priorHardware = body.hardwareProfile ? undefined : hardwareVerifier.get(body.agentId);
    const hardwareProfile = body.hardwareProfile ?? agentCapabilities.get(body.agentId)?.hardwareProfile ?? priorHardware?.profile;
    const challengeKinds = body.hardwareProfile ? body.challengeKinds : (body.challengeKinds ?? priorHardware?.challengeKinds);
    const hardwareClass = classifyHardware(hardwareProfile, rateOracleConfig.computeClasses);
    const origin = requestOrigin(req);
    const sourceIp = origin.clientIp;
    // Denied registrations count against the caller's address (they cost an audit record, a
    // signature and a portal round trip each); a flooding address is turned away up front.
    const failureKey = sourceIp ?? "unknown";
    if (!origin.loopback && preAuthFailures.blocked(failureKey)) {
      return reply.code(429).send({ error: "too_many_failed_registrations" });
    }
    const previous = agentCapabilities.get(body.agentId);
    const proofOfKey = await registerProvesStoredKey(req, body.agentId, body.publicKeyPem, previous?.publicKeyPem);
    const activation = await validatePortalNode({
      nodeId: body.agentId,
      nodeKind: "agent",
      registrationToken: body.registrationToken,
      deviceId: body.deviceId,
      sourceIp,
      loopback: origin.loopback,
      proofOfKey
    });
    if (!activation.allowed) {
      if (!origin.loopback) preAuthFailures.record(failureKey);
      app.log.warn({ agentId: body.agentId, reason: activation.reason }, "register_denied");
      // tokenNodeId: the agent's own token's node id (it named itself differently), so its log can say which name to use.
      return reply.code(403).send({ error: "node_not_activated", reason: activation.reason, ...(activation.tokenNodeId ? { tokenNodeId: activation.tokenNodeId } : {}) });
    }
    app.log.info({ agentId: body.agentId, reason: activation.reason }, "register_allowed");
    agentRateLimiter.reset(body.agentId);
    agentChunkRateLimiter.reset(body.agentId);
    agentLeaseRateLimiter.reset(body.agentId);
    agentPullRateLimiter.reset(body.agentId);
    const blacklisted = activeBlacklistRecord(body.agentId);
    if (blacklisted) {
      return reply.code(403).send({ error: "agent_blacklisted", reason: blacklisted.reason });
    }
    // Cloud hosts (src/cloud-host/): the cloud class is the operator's to grant (CLOUD_HOST_OWNER_EMAILS).
    const cloudHost = hardwareClass.computeClass === "cloud";
    if (cloudHost && !cloudHostAllowed(CLOUD_HOST_OWNERS, activation.ownerEmail, activation.hostApproved ?? previous?.hostApproved)) {
      app.log.warn({ agentId: body.agentId, ownerEmail: activation.ownerEmail ?? null }, "cloud_host_not_allowed");
      return reply.code(403).send({ error: "cloud_host_not_allowed", reason: "this account is not on the coordinator's cloud-host allowlist (CLOUD_HOST_OWNER_EMAILS)" });
    }
    queue.registerAgent(body.agentId, defaultPolicy, {
      os: body.os,
      version: body.version,
      mode: body.mode,
      localModelEnabled: true
    });
    // Cloud model ids only from a cloud host, and a cloud host serves nothing else (cloud-hosts.ts).
    const reportedModels = filterCloudModels(normalizeReportedModels(body.installedModels), cloudHost);
    // Memory, loaded models and budget: admission control (memory-admission.ts). It can only narrow
    // what the agent is handed, so an unsigned report is as safe to keep as none.
    noteAgentMemory(body.agentId, body.memory);
    agentCapabilities.set(body.agentId, {
      os: body.os,
      version: body.version,
      mode: body.mode,
      localModelEnabled: true,
      localModelProvider: body.localModelProvider,
      // What the agent reports it has installed (signed /register). Older agents don't say: the default
      // model is assumed for display, but an assumed catalog never makes them eligible for a named model (#54).
      // A cloud host with nothing to serve (paused by its spend guard) holds nothing: no assumed default.
      localModelCatalog: reportedModels.length || cloudHost ? reportedModels : body.localModelProvider === "ollama-local" ? [OLLAMA_MODEL] : ["edgecoder-default"],
      modelsReported: reportedModels.length > 0 || cloudHost,
      ...(body.ownerModels !== undefined ? { ownerModels: filterCloudModels(normalizeReportedModels(body.ownerModels), cloudHost).filter((m) => !reportedModels.includes(m)) } : previous?.ownerModels ? { ownerModels: previous.ownerModels } : {}),
      ...(body.activeModel || reportedModels.length ? { activeModel: body.activeModel ?? reportedModels[0] } : {}),
      ...(body.inferenceEngine && body.inferenceEngine !== "ollama" ? { inferenceEngine: body.inferenceEngine, ...(body.engineModel ? { engineModel: body.engineModel } : {}) } : {}),
      clientType: body.clientType,
      swarmEnabled: true,
      ideEnabled: body.mode === "ide-enabled",
      maxConcurrentTasks: body.maxConcurrentTasks,
      connectedPeers: previous?.connectedPeers ?? new Set<string>(),
      ownerEmail: activation.ownerEmail,
      sourceIp: activation.sourceIp ?? sourceIp,
      // A body without them (older agents, AGENT_LAN_HINTS=off) reports none.
      ...(body.lanAddresses && sanitizeLanAddresses(body.lanAddresses).length ? { lanAddresses: sanitizeLanAddresses(body.lanAddresses) } : {}),
      countryCode: activation.countryCode,
      // Self-reported hosting region (FLY_REGION or AGENT_REGION): coarse display only (GET /network/world).
      ...(body.region ? { region: body.region } : {}),
      vpnDetected: activation.vpnDetected,
      enrollmentReason: activation.reason,
      // The portal's host approval; a registration the portal did not answer keeps the last one known.
      ...(typeof (activation.hostApproved ?? previous?.hostApproved) === "boolean" ? { hostApproved: activation.hostApproved ?? previous?.hostApproved } : {}),
      powerTelemetry: body.powerTelemetry
        ? {
            ...body.powerTelemetry,
            updatedAtMs: body.powerTelemetry.updatedAtMs ?? now
          }
        : undefined,
      // A body without a key keeps the registered one; a body without an envelope key keeps the
      // stored one only while the signing key is unchanged.
      publicKeyPem: body.publicKeyPem ?? previous?.publicKeyPem,
      x25519PublicKey:
        body.x25519PublicKey ??
        (previous?.publicKeyPem && (body.publicKeyPem ?? previous.publicKeyPem) === previous.publicKeyPem ? previous.x25519PublicKey : undefined),
      sandboxMode: body.sandboxMode as SandboxMode,
      hardwareProfile,
      computeClass: hardwareClass.computeClass,
      hardwareClass,
      lastSeenMs: now
    });
    noteAgentHttpAlive(body.agentId, now);
    // #122: the shared key record lets other coordinators verify this agent's forwarded results.
    const registeredKey = agentCapabilities.get(body.agentId)?.publicKeyPem;
    if (registeredKey) attestAgentSigningKey(body.agentId, registeredKey);
    // ── Binary integrity verification ──
    let verificationStatus: VerificationStatus = "unverified";
    if (body.binaryIntegrity) {
      const result = verifyBinaryIntegrity(
        body.binaryIntegrity as BinaryIntegrityPayload,
        releaseManifestCache.getAllManifests(),
        now
      );
      verificationStatus = result.status;
      const existing = agentCapabilities.get(body.agentId);
      if (existing) {
        (existing as any).verificationStatus = verificationStatus;
        agentCapabilities.set(body.agentId, existing);
      }
      if (result.status === "signature_mismatch" || result.status === "hash_mismatch") {
        securityLog.log({
          level: securityLog.severity("binary_integrity_failure"),
          event: "binary_integrity_failure",
          source: { type: "agent", id: body.agentId },
          details: { status: result.status, details: result.details, version: body.binaryIntegrity.releaseVersion, channel: body.binaryIntegrity.distributionChannel },
          action: "integrity_flag",
          coordinatorId: identity.peerId,
        });
        if (REQUIRE_VERIFIED_AGENTS) {
          return reply.code(403).send({ error: "binary_integrity_failed", status: result.status });
        }
      }
      app.log.info({ agentId: body.agentId, verificationStatus, version: body.binaryIntegrity.releaseVersion }, "binary_integrity_check");
    }
    // Verified-only policy: a missing attestation, an uncached manifest, or absent release keys all
    // leave verificationStatus "unverified" — reject those too, not just explicit mismatches, so the
    // policy actually guarantees a verified binary when enabled (audit mesh#2).
    if (REQUIRE_VERIFIED_AGENTS && verificationStatus !== "verified") {
      return reply.code(403).send({ error: "binary_integrity_required", status: verificationStatus });
    }

    behaviorTracker.recordRegistration(body.agentId, now);
    evaluateAndEnforce(body.agentId);
    // Hardware verification: the claim is paid at its class base tier until a challenge proves it.
    const hardwareRecord = hardwareVerifier.register({
      agentId: body.agentId,
      claimed: hardwareClass,
      profile: hardwareProfile,
      benchmark: body.benchmark,
      challengeKinds,
      nowMs: now
    });
    // Market: post the agent's ask on its (verified) compute class (tracking the oracle reference unless explicit).
    {
      const ownerAccount = await rewardAccountForAgent(body.agentId);
      const standing = marketOrders.get(`${ownerAccount}:sell`);
      const cls = (effectiveHardware(body.agentId, { hardwareClass }) ?? hardwareClass).computeClass;
      const ask = body.askMsatPerCredit ?? (standing && (standing.computeClass === "any" || standing.computeClass === cls) && standing.msatPerCredit > 0 ? standing.msatPerCredit : undefined);
      orderBook.postAsk(body.agentId, cls, ask, now, askCapabilityOf(body.agentId, { hardwareClass }));
    }
    // A /mesh/ws connection that came back before this registration (coordinator restart) is checked
    // against the registered key now and, if its bind was signed by it, counts as connected.
    meshWsAgentRegistered(body.agentId, agentCapabilities.get(body.agentId)?.publicKeyPem);
    const approvalRecord = ordering.append({
      eventType: "node_approval",
      taskId: `agent:${body.agentId}`,
      actorId: body.agentId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({
        approved: true,
        activationReason: activation.reason ?? null,
        ownerEmail: activation.ownerEmail ?? null,
        sourceIp: activation.sourceIp ?? sourceIp ?? null,
        countryCode: activation.countryCode ?? null,
        vpnDetected: activation.vpnDetected ?? null
      })
    });
    try {
      const registerAuditPersistTimeoutMs = 3_000;
      await Promise.race([
        Promise.all([
          pgStore?.persistLedgerRecord(approvalRecord),
          persistStatsLedgerRecord(approvalRecord)
        ]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("register_audit_persist_timeout")), registerAuditPersistTimeoutMs)
        )
      ]);
    } catch (error) {
      app.log.warn({ error, agentId: body.agentId }, "register_audit_persist_failed");
    }
    return reply.send({
      accepted: true,
      policy: defaultPolicy,
      mode: body.mode,
      // No meshToken: the coordinators' shared token is never handed to agents. Agents authenticate
      // every request with their own key (docs/security/agent-threat-model.md).
      hardwareVerification: verificationSummary(hardwareRecord),
      // #63: BLE credit transactions sign the reward account; tell the agent which one we resolve.
      rewardAccountId: await rewardAccountForAgent(body.agentId),
      // A newer agent release: the agent asks its own updater to check now (agent-update-hint.ts).
      ...agentUpdateHint(body.version)
    });
  });

  app.post("/heartbeat", async (req, reply) => {
    const verified = await verifyAgentRequest((req as any).headers ?? {}, "/heartbeat", req.ip, { rawBody: rawBodyOf(req) });
    if (verified === "rejected") return reply.code(401).send({ error: "signature_invalid" });

    const parsedHeartbeat = heartbeatSchema.safeParse(req.body);
    if (!parsedHeartbeat.success) {
      return reply.code(400).send({ error: "invalid_heartbeat", issues: parsedHeartbeat.error.issues });
    }
    const body = parsedHeartbeat.data;
    if (verified && verified.agentId !== body.agentId) {
      return reply.code(401).send({ error: "agent_id_mismatch" });
    }
    const now = Date.now();
    if (!agentCapabilities.has(body.agentId)) {
      return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
    }
    const blacklisted = activeBlacklistRecord(body.agentId);
    if (blacklisted) {
      return reply.send({
        ok: false,
        blacklisted: true,
        reason: blacklisted.reason,
        blacklistVersion: mutable.blacklistVersion
      });
    }
    if (body.goingOffline) {
      // BHV006: a clean goodbye. Hand its claims to other agents now (no abandoned claims), and
      // show it offline until it heartbeats again.
      const released = queue.releaseClaimsOf(body.agentId, now);
      const cap = agentCapabilities.get(body.agentId);
      if (cap) cap.lastSeenMs = 0;
      securityLog.log({
        level: "INFO",
        event: "agent_went_offline",
        source: { type: "agent", id: body.agentId },
        details: { reason: body.goingOffline, released: released.length },
        action: "claims_released",
        coordinatorId: identity.peerId,
      });
      return reply.send({ ok: true, offline: true, released: released.length });
    }
    queue.heartbeat(body.agentId);
    noteAgentHttpAlive(body.agentId, now);
    // A busy agent is alive: without this a long job (a big prompt on a slow model) made it look
    // offline, which ended its reservation and hid it from the model list.
    const seen = agentCapabilities.get(body.agentId);
    if (seen) seen.lastSeenMs = now;
    if (body.leaseOnly) {
      // #51: mid-task lease renewal. Signature was checked above (unsigned is rejected
      // when REQUIRE_SIGNED_AGENT_REQUESTS is on, the production default); nothing is drained.
      return reply.send({ ok: true, leaseOnly: true });
    }
    behaviorTracker.recordHeartbeat(body.agentId);
    // A tier claim starts (or resets) hardware verification, so only a signed heartbeat may make one.
    if (body.benchmark && verified) hardwareVerifier.reportBenchmark(body.agentId, body.benchmark, now);
    if (body.powerTelemetry) {
      const existing = agentCapabilities.get(body.agentId);
      if (existing) {
        existing.powerTelemetry = {
          ...body.powerTelemetry,
          updatedAtMs: body.powerTelemetry.updatedAtMs ?? now
        };
        existing.lastSeenMs = now;
        agentCapabilities.set(body.agentId, existing);
      }
    } else {
      const existing = agentCapabilities.get(body.agentId);
      if (existing) {
        existing.lastSeenMs = now;
        agentCapabilities.set(body.agentId, existing);
      }
    }
    // #54: a signed heartbeat refreshes the installed-model catalog (a model pulled or removed since
    // /register). Unsigned heartbeats (non-production only) can't change what the agent is routed.
    if (body.installedModels !== undefined && verified) {
      const existing = agentCapabilities.get(body.agentId);
      // Cloud model ids only from a cloud host (cloud-hosts.ts); a cloud host's empty list is meant
      // (its spend guard paused it) and clears what it serves.
      const cloudHost = existing?.hardwareClass?.computeClass === "cloud";
      const models = filterCloudModels(normalizeReportedModels(body.installedModels), cloudHost);
      if (existing && (models.length || cloudHost)) {
        existing.localModelCatalog = models;
        existing.modelsReported = true;
        if (!existing.activeModel || !models.includes(existing.activeModel)) existing.activeModel = models[0];
      }
    }
    // Owner-only models (kept off the network by the agent's memory budget): a signed heartbeat replaces them.
    if (body.ownerModels !== undefined && verified) {
      const existing = agentCapabilities.get(body.agentId);
      if (existing) existing.ownerModels = filterCloudModels(normalizeReportedModels(body.ownerModels), existing.hardwareClass?.computeClass === "cloud").filter((m) => !existing.localModelCatalog.includes(m));
    }
    if (body.activeModel !== undefined) {
      const existing = agentCapabilities.get(body.agentId);
      if (existing) {
        existing.activeModel = body.activeModel;
        existing.activeModelParamSize = body.activeModelParamSize ?? 0;
        existing.modelSwapInProgress = body.modelSwapInProgress ?? false;
      }
    }
    if (body.askMsatPerCredit !== undefined) {
      const existing = agentCapabilities.get(body.agentId);
      const cls = existing ? (effectiveHardware(body.agentId, existing)?.computeClass ?? existing.computeClass) : undefined;
      if (existing && cls) orderBook.postAsk(body.agentId, cls, body.askMsatPerCredit > 0 ? body.askMsatPerCredit : undefined, now, askCapabilityOf(body.agentId, existing));
    }
    if (body.memory) noteAgentMemory(body.agentId, body.memory, now);
    // Local web (src/web-tool/local-web.ts): only a signed heartbeat says what this machine does; every one replaces it.
    if (verified) noteLocalWebReport(body.agentId, body.localWeb, now);
    if (body.sandboxMode !== undefined) {
      const existing = agentCapabilities.get(body.agentId);
      if (existing) {
        existing.sandboxMode = body.sandboxMode as SandboxMode;
      }
    }
    // #51: lease-based requeue (timeout + grace, renewed by heartbeat, retry cap).
    const leaseExpiry = queue.expireLeases();
    const requeued = leaseExpiry.requeued.length;
    if (leaseExpiry.failed.length > 0) {
      app.log.warn({ subtaskIds: leaseExpiry.failed }, "subtask_failed_max_attempts");
    }
    const tunnelInvites = pendingTunnelInvites.get(body.agentId) ?? [];
    pendingTunnelInvites.set(body.agentId, []);
    const tunnelCloseNotices = pendingTunnelCloseNotices.get(body.agentId) ?? [];
    pendingTunnelCloseNotices.set(body.agentId, []);
    pruneDirectWork(now);
    const directOfferIds = directWorkInbox.get(body.agentId) ?? [];
    const directWorkOffers = directOfferIds
      .map((id) => directWorkById.get(id))
      // Only offers whose same-account check passed carry fromAccountId; the worker checks it too.
      .filter((offer): offer is DirectWorkOffer => Boolean(offer && offer.status === "offered" && offer.fromAccountId && now - offer.createdAtMs <= DIRECT_WORK_OFFER_TTL_MS))
      .slice(0, DIRECT_WORK_INBOX_MAX);
    // Hardware verification: hand out a benchmark challenge when one is due (the deadline runs from now).
    const benchmarkChallenge = hardwareVerifier.nextChallenge(body.agentId, {
      nowMs: now,
      model: benchmarkModelFor(body.agentId),
      pickWitness: (model, exclude) => pickBenchmarkWitness(body.agentId, model, now, exclude)
    });
    return reply.send({
      ok: true,
      ...(benchmarkChallenge ? { benchmarkChallenge } : {}),
      hardwareVerification: verificationSummary(hardwareVerifier.get(body.agentId)),
      requeued,
      policy: defaultPolicy,
      orchestration: agentOrchestration.get(body.agentId) ?? null,
      tunnelInvites,
      tunnelCloseNotices,
      directWorkOffers,
      blacklist: {
        version: mutable.blacklistVersion,
        agents: [...blacklistByAgent.keys()]
      },
      ...agentUpdateHint(agentCapabilities.get(body.agentId)?.version)
    });
  });

  app.post("/benchmark/response", async (req, reply) => {
    // Signed-only (any trust policy): an answer settles that agent's tier, or a witness check on
    // another agent's, so an unsigned caller naming a registered agentId could demote it.
    const verified = await verifyAgentRequest((req as any).headers ?? {}, "/benchmark/response", req.ip, { requireSigned: true, rawBody: rawBodyOf(req) });
    if (verified === "rejected" || !verified) return reply.code(401).send({ error: "signature_invalid" });
    const parsed = benchmarkResponseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_benchmark_response", issues: parsed.error.issues });
    const { agentId, ...response } = parsed.data;
    if (verified.agentId !== agentId) return reply.code(401).send({ error: "agent_id_mismatch" });
    if (!agentCapabilities.has(agentId)) return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
    if (activeBlacklistRecord(agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
    const result = hardwareVerifier.submit(agentId, response as ChallengeResponse, Date.now());
    if (!result.accepted) return reply.code(409).send({ ok: false, error: result.reason });
    // A witness's answer can settle the subject's cross-check: act on the record it changed.
    const subjectId = result.record?.agentId ?? agentId;
    if (result.invalid) {
      securityLog.log({
        level: securityLog.severity("hardware_challenge_invalid"),
        event: "hardware_challenge_invalid",
        source: { type: "agent", id: subjectId },
        details: { reason: result.invalid, claimedTier: result.record?.claimed.tier, reportedBy: agentId },
        action: "grant_base_tier",
        coordinatorId: identity.peerId
      });
    }
    if (result.disagreeingWitness) {
      // A second witness overruled this one's mismatch: recorded on its verification record
      // (witnessDisagreements); repeated disagreement is the signal for a witness penalty.
      securityLog.log({
        level: securityLog.severity("hardware_witness_disagreement"),
        event: "hardware_witness_disagreement",
        source: { type: "agent", id: result.disagreeingWitness },
        details: { subjectId, claimedTier: result.record?.claimed.tier, overruledBy: agentId, disagreements: hardwareVerifier.get(result.disagreeingWitness)?.witnessDisagreements },
        action: "record_witness_disagreement",
        coordinatorId: identity.peerId
      });
    }
    for (const strike of result.struckWitnesses ?? []) {
      // A confirmatory round with two fresh witnesses cleared the subject this witness disagreed with.
      securityLog.log({
        level: securityLog.severity("hardware_witness_disagreement"),
        event: "hardware_witness_disagreement",
        source: { type: "agent", id: strike.agentId },
        details: { subjectId, claimedTier: result.record?.claimed.tier, overruledBy: "confirmatory_round", witnessStrikes: strike.strikes, excludedFromWitnessing: strike.excluded },
        action: strike.newlyExcluded ? "witness_excluded" : "witness_strike",
        coordinatorId: identity.peerId
      });
      // Past the threshold: no more witness duty (canWitness) and one behaviour strike.
      if (strike.newlyExcluded) {
        autoBlacklister.processAnomalies(strike.agentId, [
          {
            ruleId: "HWW001",
            ruleName: "hardware_witness_overruled",
            severity: "WARN",
            blacklistReason: "forged_results",
            description: "as a hardware witness, repeatedly contradicted subjects that confirmatory rounds then cleared",
            stats: { subjectId, witnessStrikes: strike.strikes }
          }
        ]);
      }
    }
    if (result.changed) repostAsk(subjectId);
    if (result.record) {
      app.log.info({ agentId: subjectId, status: result.record.status, granted: result.record.granted.tier, measured: result.record.measured?.value, unit: result.record.measured?.unit }, "hardware_challenge_result");
    }
    return reply.send({ ok: true, verification: subjectId === agentId ? verificationSummary(result.record) : null });
  });

  app.post("/agent/diagnostics", async (req, reply) => {
    const body = diagnosticsSchema.parse(req.body);
    // An agent writes its own diagnostics only (shown to the operator); the mesh token is a coordinator's.
    const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
    if (!hasMeshToken(headers) && agentSignatureAtGate(headers, "POST", "/agent/diagnostics") !== body.agentId) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    if (!agentCapabilities.has(body.agentId)) {
      return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
    }
    const existing = diagnosticsByAgentId.get(body.agentId) ?? [];
    const normalizedEvents = body.events.map((event) => ({
      eventAtMs: Number(event.eventAtMs ?? Date.now()),
      message: event.message
    }));
    const merged = [...existing, ...normalizedEvents].slice(-200);
    diagnosticsByAgentId.set(body.agentId, merged);
    const last = normalizedEvents.at(-1);
    app.log.info(
      {
        agentId: body.agentId,
        source: body.source ?? "unknown",
        runtimeState: body.runtimeState,
        modelState: body.modelState,
        eventCount: normalizedEvents.length,
        lastEvent: last?.message
      },
      "agent_diagnostics"
    );
    return reply.send({ ok: true, stored: merged.length });
  });

  app.get("/agent/diagnostics/:agentId", async (req, reply) => {
    const meshAuthorized = hasMeshToken((req as any).headers ?? {});
    const portalAuthorized = hasPortalServiceToken((req as any).headers ?? {});
    if (!meshAuthorized && !portalAuthorized) {
      return reply.code(401).send({ error: "diagnostics_access_unauthorized" });
    }
    const params = z.object({ agentId: z.string().min(1) }).parse(req.params);
    const events = diagnosticsByAgentId.get(params.agentId) ?? [];
    const sorted = [...events].sort((a, b) => Number(b.eventAtMs) - Number(a.eventAtMs));
    return reply.send({
      ok: true,
      agentId: params.agentId,
      events: sorted.slice(0, 200),
      count: sorted.length,
      latestEventAtMs: sorted.length > 0 ? sorted[0].eventAtMs : undefined
    });
  });
}
