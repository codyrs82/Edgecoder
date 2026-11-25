// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A cloud host (docs/cloud-host.md): the normal agent (src/swarm/worker-runner.ts) with a hosted
 * model API in place of Ollama / vLLM. It registers, heartbeats, pulls and streams like any host;
 * this class is what differs:
 * - what it advertises: the enabled cloud models (catalog.ts), none while the spend guard pauses it;
 * - its claim: the `cloud` class (hardwareProfile.cloud), which the coordinator grants only to
 *   CLOUD_HOST_OWNER_EMAILS;
 * - how a call runs: forwarded to the provider (backend.ts) with the platform's key, the provider's
 *   token counts reported back, and what the call cost the platform added to the spend guard.
 * The coordinator prices the call (cost plus margin, economy/cloud-pricing.ts) and pays the host's
 * owner account like any host.
 */
import { cpus, totalmem } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { contextNeeded, type OllamaPiece } from "../inference-api/ollama.js";
import { EngineError } from "../inference-api/openai-engine.js";
import type { ChatMessage, ToolSpec } from "../inference-api/types.js";
import { alertChannels } from "../alerting/index.js";
import type { AlertConfig } from "../alerting/config.js";
import type { AlertNotification } from "../alerting/types.js";
import { cloudCatalog, cloudModelSpec, providerCostUsd, type CloudModelSpec, type CloudProviderId } from "./catalog.js";
import { CloudApiError, probeKey, reasoningChat, type RemoteBackendConfig } from "./backend.js";
import { DEFAULT_SPEND_GUARD, SpendGuard, type SpendEvent, type SpendGuardConfig, type SpendState } from "./spend-guard.js";

export const PROVIDER_DEFAULTS: Record<CloudProviderId, { label: string; baseUrl: string }> = {
  fireworks: { label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" }
};

export interface CloudHostConfig {
  provider: CloudProviderId;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** Enabled network model ids (catalog ids of this provider). */
  models: string[];
  /** Network id -> provider model id, over the catalog's providerModel. */
  modelMap: Record<string, string>;
  maxSlots: number;
  maxRetries: number;
  guard: SpendGuardConfig;
  /** While paused for auth failures, probe the key this often. */
  authProbeMs: number;
  /** Where the spend totals are kept; unset = memory only. */
  stateFile?: string;
  /** `reasoning_effort` sent with each call (CLOUD_HOST_REASONING_EFFORT); unset: the provider's default. */
  reasoningEffort?: string;
  /**
   * Reasoning models and the tokens of thinking asked for on top of each call's max_tokens
   * (CLOUD_HOST_REASONING_ALLOWANCE; DEFAULT_REASONING_ALLOWANCE). A model not listed: none.
   */
  reasoningAllowance?: Record<string, number>;
}

/**
 * Thinking room per built-in reasoning model, on top of the caller's max_tokens (run 4: DeepSeek
 * V4.1 Flash still ran out inside its reasoning on a standard refactor at max_tokens 2048; GLM-5.3
 * thinks less).
 */
export const DEFAULT_REASONING_ALLOWANCE: Readonly<Record<string, number>> = { "deepseek-v4.1-flash": 4_096, "glm-5.3": 2_048 };

/**
 * CLOUD_HOST_REASONING_ALLOWANCE: unset, DEFAULT_REASONING_ALLOWANCE; a number, every enabled model
 * at that (0: none); "model=n" pairs, comma-separated, set those models over the defaults (model=0
 * removes one); "off": none. Throws on anything else.
 */
export function parseReasoningAllowance(raw: string | undefined, models: readonly string[]): Record<string, number> {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "") return { ...DEFAULT_REASONING_ALLOWANCE };
  if (t === "off" || t === "none") return {};
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 200_000;
  const bad = () => new Error("CLOUD_HOST_REASONING_ALLOWANCE must be a token count (0-200000), model=tokens pairs separated by commas, or off");
  const out: Record<string, number> = {};
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (!ok(n)) throw bad();
    for (const m of models) out[m] = n;
  } else {
    Object.assign(out, DEFAULT_REASONING_ALLOWANCE);
    for (const part of t.split(",").map((x) => x.trim()).filter(Boolean)) {
      const eq = part.lastIndexOf("=");
      const n = Number(part.slice(eq + 1).trim());
      if (eq <= 0 || !ok(n)) throw bad();
      out[part.slice(0, eq).trim()] = n;
    }
  }
  for (const [m, n] of Object.entries(out)) if (n === 0) delete out[m];
  return out;
}

/** The subset of the worker's validated env (src/config/worker.ts) a cloud host reads. */
export interface CloudHostEnv {
  CLOUD_HOST_API_KEY?: string;
  CLOUD_HOST_PROVIDER?: string;
  CLOUD_HOST_BASE_URL?: string;
  CLOUD_HOST_MODELS?: string;
  CLOUD_HOST_MODEL_MAP?: string;
  CLOUD_HOST_MAX_SLOTS?: number;
  CLOUD_HOST_MAX_RETRIES?: number;
  CLOUD_HOST_DAILY_CAP_USD?: number;
  CLOUD_HOST_MONTHLY_CAP_USD?: number;
  CLOUD_HOST_ALERT_PCT?: number;
  CLOUD_HOST_AUTH_FAILURES?: number;
  CLOUD_HOST_AUTH_PROBE_MINUTES?: number;
  CLOUD_HOST_STATE_FILE?: string;
  CLOUD_HOST_REASONING_EFFORT?: string;
  CLOUD_HOST_REASONING_ALLOWANCE?: string;
}

/** The cloud host's configuration (throws with the variable named when something is missing or wrong). */
export function cloudHostConfigFromEnv(env: CloudHostEnv, defaults: { stateFile?: string } = {}): CloudHostConfig {
  const apiKey = env.CLOUD_HOST_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("CLOUD_HOST_API_KEY is required for a cloud host (EDGECODER_ENGINE=cloud)");
  const provider = (env.CLOUD_HOST_PROVIDER?.trim().toLowerCase() || "fireworks") as CloudProviderId;
  const preset = PROVIDER_DEFAULTS[provider];
  if (!preset) throw new Error(`CLOUD_HOST_PROVIDER must be one of ${Object.keys(PROVIDER_DEFAULTS).join(", ")}`);
  const baseUrl = (env.CLOUD_HOST_BASE_URL?.trim() || preset.baseUrl).replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new Error("CLOUD_HOST_BASE_URL must be an http(s) URL");
  const ofProvider = cloudCatalog().filter((m) => m.provider === provider);
  const wanted = (env.CLOUD_HOST_MODELS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const id of wanted) {
    if (!ofProvider.some((m) => m.id === id)) throw new Error(`CLOUD_HOST_MODELS: ${id} is not a ${preset.label} model in the cloud catalog (known: ${ofProvider.map((m) => m.id).join(", ")}; add one with CLOUD_MODELS_JSON)`);
  }
  const models = wanted.length ? wanted : ofProvider.map((m) => m.id);
  if (!models.length) throw new Error(`no ${preset.label} models in the cloud catalog`);
  const modelMap: Record<string, string> = {};
  for (const pair of (env.CLOUD_HOST_MODEL_MAP ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const id = pair.slice(0, eq).trim().toLowerCase();
    const target = pair.slice(eq + 1).trim();
    if (eq <= 0 || !target || !models.includes(id)) throw new Error(`CLOUD_HOST_MODEL_MAP: "${pair}" must be <enabled model id>=<provider model id>`);
    modelMap[id] = target;
  }
  const guard: SpendGuardConfig = {
    dailyCapUsd: env.CLOUD_HOST_DAILY_CAP_USD ?? DEFAULT_SPEND_GUARD.dailyCapUsd,
    monthlyCapUsd: env.CLOUD_HOST_MONTHLY_CAP_USD ?? DEFAULT_SPEND_GUARD.monthlyCapUsd,
    alertAtPct: (env.CLOUD_HOST_ALERT_PCT ?? DEFAULT_SPEND_GUARD.alertAtPct * 100) / 100,
    authFailureLimit: env.CLOUD_HOST_AUTH_FAILURES ?? DEFAULT_SPEND_GUARD.authFailureLimit
  };
  const stateFile = env.CLOUD_HOST_STATE_FILE?.trim() || defaults.stateFile;
  const reasoningEffort = env.CLOUD_HOST_REASONING_EFFORT?.trim().toLowerCase() || undefined;
  if (reasoningEffort && !/^[a-z]{1,16}$/.test(reasoningEffort)) throw new Error("CLOUD_HOST_REASONING_EFFORT must be a word such as low, medium, high or none");
  return {
    provider,
    label: preset.label,
    baseUrl,
    apiKey,
    models,
    modelMap,
    maxSlots: Math.max(1, Math.min(16, env.CLOUD_HOST_MAX_SLOTS ?? 16)),
    maxRetries: env.CLOUD_HOST_MAX_RETRIES ?? 3,
    guard,
    authProbeMs: Math.max(1, env.CLOUD_HOST_AUTH_PROBE_MINUTES ?? 15) * 60_000,
    ...(stateFile ? { stateFile } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    reasoningAllowance: parseReasoningAllowance(env.CLOUD_HOST_REASONING_ALLOWANCE, models)
  };
}

/** File storage for the spend totals (written atomically). */
export function fileStateStore(path: string): { load: () => unknown; save: (s: SpendState) => void } {
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return undefined;
      }
    },
    save: (s) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
      renameSync(tmp, path);
    }
  };
}

/**
 * The provider refused a call because of the account, not the key or the call: HTTP 412 (Fireworks
 * answers this for a suspended account), 402, or an error that says the account is suspended or
 * out of credit / over its spending limit (network test 3b, D1). Calls keep failing until the owner
 * fixes the account in the provider's console, so the owner is alerted (at most once per
 * PROVIDER_ACCOUNT_ALERT_EVERY_MS per host). The host's pause and the coordinator's breaker are unchanged.
 */
export interface ProviderAccountEvent {
  kind: "provider_account";
  status: number;
  message: string;
}
/** What a cloud host reports to its notifier: spend-guard events and provider account problems. */
export type CloudHostEvent = SpendEvent | ProviderAccountEvent;
export const PROVIDER_ACCOUNT_ALERT_EVERY_MS = 60 * 60_000;

const ACCOUNT_TEXT = /\b(account[^.]{0,40}suspended|suspended[^.]{0,40}account|spending limit|spend limit|billing|payment required|insufficient (credit|credits|funds|balance)|out of credits?|credit balance)\b/i;

/** The provider error as an account problem, or null when it is something else. */
export function providerAccountProblem(err: unknown): ProviderAccountEvent | null {
  if (!(err instanceof CloudApiError)) return null;
  if (err.status === 412 || err.status === 402 || ACCOUNT_TEXT.test(err.message)) return { kind: "provider_account", status: err.status, message: err.message.slice(0, 300) };
  return null;
}

/** A provider account problem as an ops alert. */
export function providerAccountAlert(e: ProviderAccountEvent, ctx: { agentId: string; provider: string; reporter: string; portalUrl: string; nowMs: number }): AlertNotification {
  return {
    kind: "firing",
    reporter: ctx.reporter,
    url: `${ctx.portalUrl.replace(/\/$/, "")}/portal/settings/network#alerts`,
    nowMs: ctx.nowMs,
    alert: {
      source: `cloud-host:${ctx.agentId}`,
      key: `cloud_host_provider_account:${ctx.agentId}`,
      rule: "cloud_provider_account",
      severity: "critical",
      title: `Cloud host ${ctx.agentId}: ${ctx.provider} refused a call for the account (HTTP ${e.status})`,
      summary: `${e.message}. The ${ctx.provider} account may be suspended, out of credit or over its spending limit; cloud-model calls fail until it is fixed in the ${ctx.provider} console. This alert repeats at most once an hour while it lasts.`,
      link: null,
      details: { agentId: ctx.agentId, provider: ctx.provider, status: e.status },
      status: "active",
      firstSeenMs: ctx.nowMs,
      lastSeenMs: ctx.nowMs,
      resolvedAtMs: null,
      lastNotifiedMs: null,
      notifyCount: 0,
      acknowledgedAtMs: null,
      acknowledgedBy: null
    }
  };
}

/** A spend-guard event as an ops alert (the src/alerting channels: ALERT_EMAILS via Resend, ALERT_WEBHOOK_URL). */
export function spendAlert(e: SpendEvent, ctx: { agentId: string; provider: string; reporter: string; portalUrl: string; nowMs: number }): AlertNotification {
  const usd = (n: number | undefined) => `$${(n ?? 0).toFixed(2)}`;
  const scope = e.kind === "warn" ? e.scope : e.reason === "monthly_cap" ? "month" : e.reason === "daily_cap" ? "day" : "auth";
  const title =
    e.kind === "warn"
      ? `Cloud host ${ctx.agentId}: ${scope === "day" ? "daily" : "monthly"} ${ctx.provider} spend at ${Math.round((e.spentUsd / e.capUsd) * 100)} % of its cap`
      : e.kind === "paused"
        ? e.reason === "auth"
          ? `Cloud host ${ctx.agentId} paused: ${ctx.provider} is refusing the API key`
          : `Cloud host ${ctx.agentId} paused: ${scope === "day" ? "daily" : "monthly"} ${ctx.provider} spend cap reached`
        : `Cloud host ${ctx.agentId} serving again (${e.reason === "auth" ? "the API key works again" : "new spend period"})`;
  const summary =
    e.kind === "warn"
      ? `Spent ${usd(e.spentUsd)} of the ${usd(e.capUsd)} ${scope === "day" ? "daily" : "monthly"} cap on ${ctx.provider}. At the cap the host stops taking cloud-model calls until the period ends.`
      : e.kind === "paused"
        ? e.reason === "auth"
          ? `${e.failures ?? "Several"} calls in a row failed with 401/403. The host advertises no models until the key works again (it re-checks every few minutes). Check CLOUD_HOST_API_KEY.`
          : `Spent ${usd(e.spentUsd)} of the ${usd(e.capUsd)} cap. Cloud models are off the network until ${e.resumesAtMs ? new Date(e.resumesAtMs).toISOString() : "the next period"}; raise CLOUD_HOST_${scope === "day" ? "DAILY" : "MONTHLY"}_CAP_USD to resume sooner.`
        : "Cloud models are advertised again.";
  const severity = e.kind === "paused" ? "critical" : "warning";
  return {
    kind: e.kind === "resumed" ? "resolved" : "firing",
    reporter: ctx.reporter,
    url: `${ctx.portalUrl.replace(/\/$/, "")}/portal/settings/network#alerts`,
    nowMs: ctx.nowMs,
    alert: {
      source: `cloud-host:${ctx.agentId}`,
      key: `cloud_host_${scope}:${ctx.agentId}`,
      rule: e.kind === "warn" ? "cloud_spend_warning" : e.kind === "paused" ? `cloud_paused_${e.reason}` : `cloud_resumed_${e.reason}`,
      severity,
      title,
      summary,
      link: null,
      details: { agentId: ctx.agentId, provider: ctx.provider, ...(e.kind !== "resumed" && "spentUsd" in e && e.spentUsd !== undefined ? { spentUsd: Number(e.spentUsd.toFixed(2)), capUsd: e.capUsd } : {}) },
      status: e.kind === "resumed" ? "resolved" : "active",
      firstSeenMs: ctx.nowMs,
      lastSeenMs: ctx.nowMs,
      resolvedAtMs: e.kind === "resumed" ? ctx.nowMs : null,
      lastNotifiedMs: null,
      notifyCount: 0,
      acknowledgedAtMs: null,
      acknowledgedBy: null
    }
  };
}

/** Send spend-guard events and provider account problems to the configured alert channels; failures are logged, never thrown. */
export function alertNotifier(cfg: AlertConfig, ctx: { agentId: string; provider: string; portalUrl: string; log: (line: string) => void }): (e: CloudHostEvent) => void {
  const channels = cfg.enabled ? alertChannels(cfg) : [];
  return (e) => {
    const actx = { ...ctx, reporter: `cloud host ${ctx.agentId}`, nowMs: Date.now() };
    const n = e.kind === "provider_account" ? providerAccountAlert(e, actx) : spendAlert(e, actx);
    ctx.log(`${n.alert.severity}: ${n.alert.title}`);
    for (const ch of channels) void ch.send(n).catch((err) => ctx.log(`alert via ${ch.name} failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`));
  };
}

export class CloudHost {
  readonly guard: SpendGuard;
  private readonly backend: RemoteBackendConfig;
  private lastProbeMs = 0;
  private lastAdvertised = "";
  private readonly notify?: (e: CloudHostEvent) => void;
  private readonly now: () => number;
  /** When the last provider account alert went out (deduplicated to one per PROVIDER_ACCOUNT_ALERT_EVERY_MS). */
  private lastAccountAlertMs = -Infinity;

  constructor(
    readonly config: CloudHostConfig,
    deps: { notify?: (e: CloudHostEvent) => void; now?: () => number; backend?: Partial<RemoteBackendConfig>; store?: { load: () => unknown; save: (s: SpendState) => void } } = {}
  ) {
    this.notify = deps.notify;
    this.now = deps.now ?? Date.now;
    const store = deps.store ?? (config.stateFile ? fileStateStore(config.stateFile) : undefined);
    this.guard = new SpendGuard(config.guard, { ...(deps.now ? { now: deps.now } : {}), ...(store ?? {}), ...(deps.notify ? { notify: deps.notify } : {}) });
    this.backend = { label: config.label, baseUrl: config.baseUrl, apiKey: config.apiKey, maxRetries: config.maxRetries, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}), ...deps.backend };
    this.lastAdvertised = this.advertisedModels().join(",");
  }

  private spec(model: string): CloudModelSpec | undefined {
    const spec = cloudModelSpec(model);
    return spec && this.config.models.includes(spec.id) ? spec : undefined;
  }

  /** The models to advertise now: the enabled ones, none while paused. */
  advertisedModels(): string[] {
    return this.guard.canServe() ? [...this.config.models] : [];
  }

  /** True when the advertised list changed since the last call (the worker then re-registers). */
  advertisedChanged(): boolean {
    const key = this.advertisedModels().join(",");
    const changed = key !== this.lastAdvertised;
    this.lastAdvertised = key;
    return changed;
  }

  ready(): boolean {
    return this.guard.canServe();
  }

  /** The window reported to the coordinator: the largest of the enabled models (each call is checked against its own). */
  contextWindow(): number {
    return Math.max(...this.config.models.map((id) => cloudModelSpec(id)?.contextWindow ?? 0), 4_096);
  }

  /** The hardware claim: this process's machine plus `cloud` (the coordinator classifies it as the cloud class). */
  hardwareProfile(): Record<string, unknown> {
    return { platform: process.platform, arch: process.arch, cpuCores: cpus().length, ramGb: Math.round(totalmem() / 1024 ** 3), cloud: { provider: this.config.provider } };
  }

  /** While paused for a bad key, check it now and then; a good answer resumes the host. */
  async maybeProbeKey(nowMs = Date.now()): Promise<void> {
    if (this.guard.status().reason !== "auth" || nowMs - this.lastProbeMs < this.config.authProbeMs) return;
    this.lastProbeMs = nowMs;
    const r = await probeKey(this.backend);
    if (r.ok) this.guard.noteAuthOk();
  }

  /** Alert the owner when the provider refuses calls for the account (suspended, out of credit), at most hourly. */
  private noteAccountProblem(err: unknown): void {
    const e = providerAccountProblem(err);
    if (!e || !this.notify) return;
    const now = this.now();
    if (now - this.lastAccountAlertMs < PROVIDER_ACCOUNT_ALERT_EVERY_MS) return;
    this.lastAccountAlertMs = now;
    try {
      this.notify(e);
    } catch {
      // alerting never breaks a call's error path
    }
  }

  /**
   * Run a network call on the provider (inference-runner deps.chat). Refused with
   * "cloud_capacity_paused" while paused; a call longer than the model's window is a context
   * overflow (another host may serve it). Whatever it cost is added to the spend guard: the
   * provider's counts, else an estimate when the stream broke off before them.
   *
   * A reasoning model gets room to think (reasoningAllowance, backend.ts reasoningChat): the
   * provider is asked for max_tokens plus the allowance, the answer is capped at max_tokens, and a
   * reasoning-only reply is asked once more with twice the allowance. The counts reported to the
   * coordinator are the provider's (reasoning included); the coordinator bills output tokens only up
   * to the call's own max_tokens (inference-streams.ts boundTokenCounts), so the thinking past that,
   * and an attempt asked again, are the platform's cost: they go to the spend guard, never to the buyer.
   */
  async *chat(model: string, req: { messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number; temperature?: number }, signal: AbortSignal, timeoutMs: number): AsyncGenerator<OllamaPiece> {
    const paused = this.guard.pausedError();
    if (paused) throw new Error(paused);
    const spec = this.spec(model);
    if (!spec) throw new Error(`model_unavailable: this cloud host serves ${this.config.models.join(", ")}, not ${model}`);
    const need = contextNeeded(req.messages, req.tools, req.maxTokens);
    if (need > spec.contextWindow) throw new EngineError(`${model} serves ${spec.contextWindow} tokens; the call needs about ${need}`, 400, true);
    let answered = false;
    let outChars = 0;
    let usage: { promptTokens?: number; outputTokens?: number; cachedPromptTokens?: number } | undefined;
    try {
      const allowance = this.config.reasoningAllowance?.[spec.id] ?? 0;
      const billed = (u: NonNullable<CloudApiError["usage"]>) => this.guard.record(providerCostUsd(spec, u));
      for await (const piece of reasoningChat(this.backend, { model: this.config.modelMap[spec.id] ?? spec.providerModel, ...req }, allowance, signal, timeoutMs, billed)) {
        if (!answered) {
          answered = true;
          this.guard.noteAuthOk();
        }
        if ("delta" in piece) outChars += piece.delta.length;
        else if ("toolCalls" in piece) outChars += JSON.stringify(piece.toolCalls).length;
        else if ("doneReason" in piece) usage = { promptTokens: piece.promptTokens, outputTokens: piece.outputTokens, cachedPromptTokens: piece.cachedPromptTokens };
        yield piece;
      }
    } catch (err) {
      if (err instanceof CloudApiError && err.kind === "auth") this.guard.noteAuthFailure();
      this.noteAccountProblem(err);
      // Reasoning only: the provider answered (and bills the thinking) though nothing reached the caller.
      if (err instanceof CloudApiError && err.usage) {
        answered = true;
        usage = err.usage;
      }
      throw err;
    } finally {
      // The provider bills a call it answered, finished or not: count it.
      if (answered) {
        const counted = usage && (usage.promptTokens !== undefined || usage.outputTokens !== undefined);
        const promptBytes = Buffer.byteLength(JSON.stringify(req.messages) + (req.tools ? JSON.stringify(req.tools) : ""), "utf8");
        const tokens = counted ? usage! : { promptTokens: Math.ceil(promptBytes / 3), outputTokens: Math.ceil(outChars / 3) };
        this.guard.record(providerCostUsd(spec, tokens));
      }
    }
  }
}
