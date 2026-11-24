// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Remote model control: the command a coordinator sends an agent for its owner.
 *
 * Chain of authority (docs/security/agent-threat-model.md, "Remote model control"):
 *
 *   owner (portal session) -> portal (service token, accountId = acct-<session user>)
 *     -> coordinator (verified ownership row: the agent belongs to accountId)
 *     -> agent (this frame, signed by the coordinator's identity key, down the agent's
 *        authenticated mesh WebSocket)
 *
 * The agent acts only on a frame that verifies against the coordinator identity it pinned and
 * proved (its challenge), names this agent's id, is inside its short lifetime, and whose id it has
 * not seen. Everything after that is still the agent's own policy (allowlist, bounds, disk and
 * memory, AGENT_REMOTE_CONTROL=off): a signed command is a request, not an order.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { signPayload, verifyPayload } from "../../mesh/peer.js";
import { isOllamaLibraryModelName } from "../ollama-installer.js";

export const MODEL_CONTROL_FRAME_TYPE = "model_control";
export const MODEL_CONTROL_VERSION = 1;
/** A command lives at most this long after it is issued. */
export const MODEL_CONTROL_MAX_LIFETIME_MS = 2 * 60_000;
/** How far ahead of the agent's clock issuedAtMs may be. */
export const MODEL_CONTROL_MAX_FUTURE_SKEW_MS = 60_000;
/** Remembered command ids (each kept until its command expires). */
export const MODEL_CONTROL_SEEN_LIMIT = 10_000;

export const MODEL_CONTROL_ACTIONS = ["refresh", "pull", "set_model", "remove", "set_settings", "restart_model"] as const;
export type ModelControlAction = (typeof MODEL_CONTROL_ACTIONS)[number];

/** Ollama library names only (the shape isOllamaLibraryModelName accepts), at most 200 chars. */
const modelName = z
  .string()
  .min(1)
  .max(200)
  .refine((m) => isOllamaLibraryModelName(m), "an Ollama library model name (name[:tag] or namespace/name[:tag], no registry host)");

export const keepAliveSchema = z
  .string()
  .trim()
  .max(16)
  .regex(/^(-1|0|\d{1,6}|\d{1,4}(s|m|h))$/, "-1, 0, seconds, or a duration such as 30m or 2h");

/**
 * "Automatic" for a sized setting: the agent drops the portal's override of it and sizes it again
 * (GPU free VRAM, else RAM: src/swarm/parallelism.ts), unless the machine's own config pins it.
 *
 * A value of the same field rather than a separate `clear` list: one field says one thing (no
 * `contextWindow: 8192` alongside a clear of it), and an agent from before this
 * (MODEL_CONTROL_FEATURE_SETTINGS_AUTO) has `z.number().int()` here, so it refuses the whole command
 * as `invalid_request` and reports that, changing nothing: never a misread number.
 */
export const SETTING_AUTO = "auto" as const;
const sizedSetting = z.union([z.number().int(), z.literal(SETTING_AUTO)]);

/** What an agent says it understands, in its state (ModelControlState.features). */
export const MODEL_CONTROL_FEATURE_SETTINGS_AUTO = "settings_auto";
export const MODEL_CONTROL_FEATURES: readonly string[] = [MODEL_CONTROL_FEATURE_SETTINGS_AUTO];
/**
 * The first agent release that takes `"auto"` (agent-v tag), for machines whose state has not said
 * so yet. Release installs report their tag as their version; desktop and source builds report
 * package.json's, so for them the state's `features` is the answer.
 */
export const SETTINGS_AUTO_MIN_AGENT_VERSION = "1.2.8";

export const modelSettingsSchema = z
  .object({
    contextWindow: sizedSetting.optional(),
    parallel: sizedSetting.optional(),
    keepAlive: keepAliveSchema.optional()
  })
  .strict()
  .refine((s) => s.contextWindow !== undefined || s.parallel !== undefined || s.keepAlive !== undefined, "at least one setting");

/** One schema per action; anything else is refused before it is signed or acted on. */
export const modelControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh"), args: z.object({}).strict().default({}) }),
  z.object({ action: z.literal("pull"), args: z.object({ model: modelName }).strict() }),
  z.object({ action: z.literal("set_model"), args: z.object({ model: modelName }).strict() }),
  z.object({ action: z.literal("remove"), args: z.object({ model: modelName }).strict() }),
  z.object({ action: z.literal("set_settings"), args: modelSettingsSchema }),
  z.object({ action: z.literal("restart_model"), args: z.object({}).strict().default({}) })
]);
export type ModelControlRequest = z.infer<typeof modelControlRequestSchema>;

export interface ModelControlCommand {
  v: typeof MODEL_CONTROL_VERSION;
  /** Unique per command: the agent's replay key and the audit row's id. */
  id: string;
  /** The agent this command is for; any other agent refuses it. */
  agentId: string;
  /** The coordinator that signed it (its mesh peer id). */
  coordinatorId: string;
  /** The owning account the coordinator verified (acct-<userId>). */
  requestedBy: string;
  issuedAtMs: number;
  expiresAtMs: number;
  action: ModelControlAction;
  args: Record<string, unknown>;
}

export interface ModelControlFrame {
  type: typeof MODEL_CONTROL_FRAME_TYPE;
  command: ModelControlCommand;
  /** Ed25519 (base64) by the coordinator's identity key over canonicalJson(command). */
  signature: string;
}

/** JSON with object keys sorted at every level, so both sides sign and verify the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function modelControlSigningPayload(command: ModelControlCommand): string {
  return `edgecoder-model-control-v1\n${canonicalJson(command)}`;
}

export function createModelControlFrame(input: {
  request: ModelControlRequest;
  agentId: string;
  coordinatorId: string;
  requestedBy: string;
  privateKeyPem: string;
  nowMs?: number;
  lifetimeMs?: number;
  id?: string;
}): ModelControlFrame {
  const issuedAtMs = input.nowMs ?? Date.now();
  const command: ModelControlCommand = {
    v: MODEL_CONTROL_VERSION,
    id: input.id ?? randomUUID(),
    agentId: input.agentId,
    coordinatorId: input.coordinatorId,
    requestedBy: input.requestedBy,
    issuedAtMs,
    expiresAtMs: issuedAtMs + Math.min(input.lifetimeMs ?? MODEL_CONTROL_MAX_LIFETIME_MS, MODEL_CONTROL_MAX_LIFETIME_MS),
    action: input.request.action,
    args: input.request.args as Record<string, unknown>
  };
  return { type: MODEL_CONTROL_FRAME_TYPE, command, signature: signPayload(modelControlSigningPayload(command), input.privateKeyPem) };
}

/** Remembers command ids until their command expires; full of live ids, it refuses new commands. */
export class CommandReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly limit = MODEL_CONTROL_SEEN_LIMIT) {}

  /** True the first time an id is offered (and records it). */
  accept(id: string, expiresAtMs: number, nowMs: number): boolean | "full" {
    if (this.seen.has(id)) return false;
    if (this.seen.size >= this.limit) {
      for (const [k, until] of this.seen) if (until < nowMs) this.seen.delete(k);
      if (this.seen.size >= this.limit) return "full";
    }
    this.seen.set(id, expiresAtMs);
    return true;
  }
}

export type FrameVerdict =
  | { ok: true; command: ModelControlCommand; request: ModelControlRequest }
  | {
      ok: false;
      reason:
        | "malformed"
        | "no_verified_coordinator"
        | "wrong_coordinator"
        | "invalid_signature"
        | "wrong_agent"
        | "expired"
        | "from_future"
        | "lifetime_too_long"
        | "replayed"
        | "replay_cache_full"
        | "invalid_request";
    };

const commandShape = z.object({
  v: z.literal(MODEL_CONTROL_VERSION),
  id: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/),
  agentId: z.string().min(1).max(128),
  coordinatorId: z.string().min(1).max(256),
  requestedBy: z.string().min(1).max(160),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
  action: z.enum(MODEL_CONTROL_ACTIONS),
  args: z.record(z.string(), z.unknown())
}).strict();

/**
 * The agent's check of a frame. `coordinator` is the identity the agent's trust gate proved (the
 * pinned key); with none, nothing is accepted. The replay id is recorded only once the signature,
 * target and lifetime pass, so a forged frame cannot burn a real command's id.
 */
export function verifyModelControlFrame(
  frame: unknown,
  ctx: { agentId: string; coordinator: { peerId: string; publicKeyPem: string } | null; replay: CommandReplayGuard; nowMs?: number }
): FrameVerdict {
  const f = frame as Partial<ModelControlFrame> | null;
  if (!f || typeof f !== "object" || f.type !== MODEL_CONTROL_FRAME_TYPE || typeof f.signature !== "string") return { ok: false, reason: "malformed" };
  const parsed = commandShape.safeParse(f.command);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const command = parsed.data as ModelControlCommand;
  if (!ctx.coordinator) return { ok: false, reason: "no_verified_coordinator" };
  if (command.coordinatorId !== ctx.coordinator.peerId) return { ok: false, reason: "wrong_coordinator" };
  // Verify the command as received (strict shape: no key the signature did not cover can ride along).
  if (!verifyPayload(modelControlSigningPayload(f.command as ModelControlCommand), f.signature, ctx.coordinator.publicKeyPem)) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (command.agentId !== ctx.agentId) return { ok: false, reason: "wrong_agent" };
  const now = ctx.nowMs ?? Date.now();
  if (command.issuedAtMs > now + MODEL_CONTROL_MAX_FUTURE_SKEW_MS) return { ok: false, reason: "from_future" };
  if (command.expiresAtMs - command.issuedAtMs > MODEL_CONTROL_MAX_LIFETIME_MS || command.expiresAtMs < command.issuedAtMs) {
    return { ok: false, reason: "lifetime_too_long" };
  }
  if (now > command.expiresAtMs) return { ok: false, reason: "expired" };
  const request = modelControlRequestSchema.safeParse({ action: command.action, args: command.args });
  if (!request.success) return { ok: false, reason: "invalid_request" };
  const fresh = ctx.replay.accept(command.id, command.expiresAtMs, now);
  if (fresh === "full") return { ok: false, reason: "replay_cache_full" };
  if (!fresh) return { ok: false, reason: "replayed" };
  return { ok: true, command, request: request.data };
}

/** What an agent reports about its models (also the portal's per-machine view). */
export interface ModelControlState {
  /** Remote control on this host (AGENT_REMOTE_CONTROL); off = view only. */
  remoteControl: "on" | "off";
  ollamaVersion?: string;
  ollamaReachable: boolean;
  activeModel: string;
  installed: Array<{ name: string; sizeBytes: number; modifiedAt?: string }>;
  loaded: Array<{ name: string; sizeBytes: number; vramBytes: number; expiresAt?: string }>;
  gpu?: { vendor?: string; model?: string; vramBytes?: number; count?: number };
  ramBytes: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  settings: { contextWindow: number; parallel: number; keepAlive: string };
  /** Where each setting comes from: the env file, a remote override, or the default sizing. */
  sources: { model: SettingSource; contextWindow: SettingSource; parallel: SettingSource; keepAlive: SettingSource };
  bounds: ModelSettingsBounds;
  /** Models this host lets a remote command pull or select. */
  allowlist: Array<{ name: string; sizeBytes?: number; minMemoryGb?: number }>;
  /** Ollama's server-side parallel limit, when the agent knows it (OLLAMA_NUM_PARALLEL). */
  ollamaNumParallel?: number;
  notes: string[];
  pull?: { commandId: string; model: string; status: string; completedBytes?: number; totalBytes?: number; startedAtMs: number };
  /** Optional protocol features this agent understands (MODEL_CONTROL_FEATURES); absent on older agents. */
  features?: string[];
  /** The desktop app (or any local UI) owns this machine's settings; remote changes still apply until it changes them. */
  localUi: boolean;
  reportedAtMs: number;
}

export type SettingSource = "env" | "remote" | "default";

export interface ModelSettingsBounds {
  contextWindow: { min: number; max: number };
  parallel: { min: number; max: number };
  /** Keep-alive in seconds; -1 (never unload) is also allowed. */
  keepAliveSeconds: { min: number; max: number };
}

/** Result of one command, reported by the agent (signed request) and kept in the audit log. */
export interface ModelControlResult {
  commandId: string;
  status: "accepted" | "progress" | "done" | "refused" | "failed";
  /** A short machine-readable reason (refusals and failures). */
  error?: string;
  message?: string;
  progressPct?: number;
}
