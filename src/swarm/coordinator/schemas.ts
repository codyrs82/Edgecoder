// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Request schemas for agent registration, heartbeat, tasks and results.
 */
import { z } from "zod";
import type { ExecutionPolicy } from "../../common/types.js";
import {
  ACCEPTED_COMPUTE_CLASS_IDS,
  COMPUTE_CLASS_IDS,
  normalizeComputeClass,
  type ComputeClassId
} from "../../economy/compute-classes.js";
import { agentReceiptClaimSchema } from "../../receipts/issue.js";
import { isValidSnapshotRef } from "../snapshot-resolver.js";
// Imported for load order only: this module is set up after the app, as in coordinator.ts.
import "./app.js";

export const defaultPolicy: ExecutionPolicy = {
  cpuCapPercent: 50,
  memoryLimitMb: 2048,
  idleOnly: true,
  maxConcurrentTasks: 1,
  allowedHours: { startHourUtc: 22, endHourUtc: 6 }
};

const hardwareProfileSchema = z.object({
  cpuCores: z.number().int().min(1).max(4096).optional(),
  cpuModel: z.string().max(128).optional(),
  ramGb: z.number().min(0).max(65536).optional(),
  arch: z.string().max(16).optional(),
  platform: z.string().max(16).optional(),
  gpu: z
    .object({
      vendor: z.string().max(32).optional(),
      model: z.string().max(128).optional(),
      vramGb: z.number().min(0).max(8192).optional(),
      datacenter: z.boolean().optional()
    })
    .optional(),
  benchmarkScore: z.number().min(0).optional(),
  overridden: z.boolean().optional()
});

/** The agent's self-benchmark (src/swarm/benchmark.ts). Plausibility evidence only; a malformed one is dropped, never a 400. */
const benchmarkReportSchema = z
  .object({
    version: z.literal(1),
    ranAtMs: z.number().nonnegative(),
    durationMs: z.number().nonnegative().max(3_600_000),
    cpu: z
      .object({
        workUnitsPerSec: z.number().nonnegative().max(1e9),
        threads: z.number().int().min(1).max(4096),
        processed: z.number().int().nonnegative(),
        elapsedMs: z.number().nonnegative(),
        digest: z.string().max(64)
      })
      .optional(),
    gpu: z
      .object({
        model: z.string().max(128),
        tokensPerSec: z.number().nonnegative().max(1e6),
        evalTokens: z.number().int().nonnegative().max(1e7),
        weightsGb: z.number().nonnegative().max(4096).optional(),
        bandwidthGbps: z.number().nonnegative().max(1e6).optional()
      })
      .optional(),
    loaded: z.object({ model: z.string().max(128), vramGb: z.number().nonnegative().max(8192) }).optional(),
    errors: z.array(z.string().max(120)).max(8).optional()
  })
  .optional()
  .catch(undefined);
/** Challenge kinds the agent can answer; absent (older agents) = none, so they stay at base tier. */
const challengeKindsSchema = z.array(z.string().max(16)).max(8).optional().catch(undefined);

export const registerSchema = z.object({
  agentId: z.string(),
  deviceId: z.string().min(3).max(128).optional(),
  os: z.string().min(2),
  version: z.string(),
  mode: z.enum(["swarm-only", "ide-enabled"]),
  registrationToken: z.string().optional(),
  localModelProvider: z.enum(["edgecoder-local", "ollama-local"]).default("edgecoder-local"),
  /** Models installed in the agent's Ollama (network inference runs only on agents that have the model). */
  installedModels: z.array(z.string().min(1).max(200)).max(200).optional(),
  activeModel: z.string().min(1).max(200).optional(),
  clientType: z.string().min(1).max(64).default("edgecoder-native"),
  maxConcurrentTasks: z.number().int().min(1).max(64).default(1),
  powerTelemetry: z
    .object({
      onExternalPower: z.boolean().optional(),
      batteryLevelPct: z.number().min(0).max(100).optional(),
      lowPowerMode: z.boolean().optional(),
      updatedAtMs: z.number().optional(),
      onACPower: z.boolean().optional(),
      batteryPct: z.number().min(0).max(100).optional(),
      thermalState: z.enum(["nominal", "fair", "serious", "critical"]).optional(),
      cpuUsagePct: z.number().min(0).max(100).optional(),
      memoryUsagePct: z.number().min(0).max(100).optional(),
      deviceType: z.enum(["desktop", "laptop", "phone", "tablet", "server"]).optional()
    })
    .optional(),
  publicKeyPem: z.string().optional(),
  x25519PublicKey: z.string().optional(),
  sandboxMode: z.enum(["none", "docker", "vm"]).default("none"),
  /** Hardware the agent runs on; classified into a compute class that prices its seconds. */
  hardwareProfile: hardwareProfileSchema.optional(),
  /** Minimum price the agent will work for (msat per credit). Omit to track the class reference. */
  askMsatPerCredit: z.number().positive().max(1e9).optional(),
  benchmark: benchmarkReportSchema,
  challengeKinds: challengeKindsSchema,
  binaryIntegrity: z
    .object({
      distHash: z.string(),
      releaseVersion: z.string(),
      releaseSignature: z.string(),
      distributionChannel: z.string(),
    })
    .optional()
});

export const heartbeatSchema = z.object({
  agentId: z.string(),
  /** #51: renew claim leases only; don't drain tunnel invites/notices or offers. */
  leaseOnly: z.boolean().optional(),
  powerTelemetry: z
    .object({
      onExternalPower: z.boolean().optional(),
      batteryLevelPct: z.number().min(0).max(100).optional(),
      lowPowerMode: z.boolean().optional(),
      updatedAtMs: z.number().optional(),
      onACPower: z.boolean().optional(),
      batteryPct: z.number().min(0).max(100).optional(),
      thermalState: z.enum(["nominal", "fair", "serious", "critical"]).optional(),
      cpuUsagePct: z.number().min(0).max(100).optional(),
      memoryUsagePct: z.number().min(0).max(100).optional(),
      deviceType: z.enum(["desktop", "laptop", "phone", "tablet", "server"]).optional()
    })
    .optional(),
  activeModel: z.string().optional(),
  activeModelParamSize: z.number().optional(),
  /** #54: models in the agent's Ollama (/api/tags); refreshes the catalog. Signed heartbeats only. */
  installedModels: z.array(z.string().min(1).max(200)).max(200).optional(),
  modelSwapInProgress: z.boolean().optional(),
  sandboxMode: z.enum(["none", "docker", "vm"]).optional(),
  /** Update the agent's ask; omit to leave it, 0 to track the class reference again. */
  askMsatPerCredit: z.number().min(0).max(1e9).optional(),
  /** A new self-benchmark (periodic). */
  benchmark: benchmarkReportSchema
});
/** Answer to a benchmark challenge handed out in a heartbeat response. */
export const benchmarkResponseSchema = z.object({
  agentId: z.string(),
  challengeId: z.string().min(1).max(128),
  kind: z.enum(["cpu", "gpu"]),
  solutions: z.array(z.number().int().nonnegative()).max(4096).optional(),
  output: z.string().max(16_000).optional(),
  evalCount: z.number().nonnegative().max(1e7).optional(),
  evalDurationMs: z.number().nonnegative().max(3_600_000).optional(),
  elapsedMs: z.number().nonnegative().max(3_600_000),
  declined: z.string().max(120).optional()
});
export const diagnosticsSchema = z.object({
  agentId: z.string(),
  events: z
    .array(
      z.object({
        eventAtMs: z.number().optional(),
        message: z.string().min(1).max(500)
      })
    )
    .max(40),
  source: z.string().optional(),
  runtimeState: z.string().optional(),
  modelState: z.string().optional()
});

/**
 * API edge for a class parameter: the four current ids plus the nine legacy ones, which are mapped
 * (never rejected) so stale clients, scripts and bookmarked portal URLs keep working.
 */
export const classParam = z
  .string()
  .refine((v) => normalizeComputeClass(v) !== undefined, { message: `computeClass must be one of ${COMPUTE_CLASS_IDS.join(", ")}` })
  .transform((v) => normalizeComputeClass(v) as ComputeClassId);
/** Capability constraint (GB): positive and bounded. */
const minGbParam = z.number().positive().max(4096).optional();

export const taskSchema = z.object({
  taskId: z.string(),
  prompt: z.string().min(1),
  /** What sent it, for the usage page (a connection, "EdgeCoder chat", ...). */
  source: z.string().max(80).optional(),
  language: z.enum(["python", "javascript"]).default("python"),
  snapshotRef: z.string().min(1).refine(isValidSnapshotRef, {
    message: "snapshotRef must be a 40-char hex commit hash or an https:// tarball URL"
  }),
  submitterAccountId: z.string().default("anonymous"),
  projectId: z.string().default("default"),
  tenantId: z.string().optional(),
  resourceClass: z.enum(["cpu", "gpu"]).default("cpu"),
  priority: z.number().min(0).max(100).default(50),
  requestedModel: z.string().optional(),
  sandboxRequired: z.boolean().default(false),
  /**
   * Which class-market should run it (cpu | apple | gpu | gpu.dc), or "any". A legacy id
   * (gpu.c24, ...) is mapped onto its class with the capability it implied (see /submit).
   */
  computeClass: z.enum([...(ACCEPTED_COMPUTE_CLASS_IDS as [string, ...string[]]), "any"]).default("any"),
  /** Requester's ceiling in msat per credit. Default: class reference × (1 + MARKET_DEFAULT_BID_PREMIUM_BPS). */
  maxBidMsatPerCredit: z.number().positive().max(1e9).optional(),
  /** Only agents with at least this much discrete GPU VRAM may claim (e.g. 24 for a 30B model). Default: no constraint. */
  minVramGb: minGbParam,
  /** Only agents with at least this much system / unified memory may claim. Default: no constraint. */
  minMemoryGb: minGbParam,
  /** Only agents with a rolling reliability score (0..1) at least this high may claim; agents without enough evidence never do. */
  minReliability: z.number().positive().max(1).optional()
});

export const pullSchema = z.object({ agentId: z.string() });
export const resultSchema = z.object({
  subtaskId: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
  durationMs: z.number(),
  reportNonce: z.string().optional(),
  reportSignature: z.string().optional(),
  /** #54: the model that produced the result (newer agents; covered by the request signature). */
  model: z.string().min(1).max(200).optional(),
  receipt: agentReceiptClaimSchema.optional() // work receipt claim signed by the agent (src/receipts)
});
