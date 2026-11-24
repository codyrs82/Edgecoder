// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Cloud models: models the network serves through a hosted model API (Fireworks first) instead of
 * a machine's own engine. A cloud host (src/cloud-host/host.ts, docs/cloud-host.md) is a normal
 * agent whose backend forwards each call to the provider with the platform's one API key.
 *
 * This list is shared by both sides, and both read the same entry:
 * - the cloud host, which advertises the enabled ids, maps them to the provider's model id and
 *   counts what each call cost in USD (the spend guard);
 * - the coordinator, which prices a call on a cloud model at the provider's USD price plus a margin
 *   (src/economy/cloud-pricing.ts), never on what a host says. A host cannot set its own price.
 *
 * Only agents of the coordinator's cloud-host allowlist (CLOUD_HOST_OWNER_EMAILS) serve these ids:
 * the coordinator drops them from any other agent's model list, so nobody can advertise "glm-5.3"
 * and answer with a small local model at the cloud price.
 *
 * Prices are USD per million tokens from the provider's public price list. CLOUD_MODELS_JSON
 * (the same value on the coordinators and the cloud host) adds models or replaces built-in entries
 * by id, so a price change does not need a release.
 */

export type CloudProviderId = "fireworks";

export interface CloudTokenPrice {
  /** USD per million prompt tokens. */
  input: number;
  /** USD per million prompt tokens served from the provider's prompt cache. */
  cachedInput: number;
  /** USD per million generated tokens. */
  output: number;
}

export interface CloudModelSpec {
  /** Network model id, e.g. "glm-5.3" (shown as "glm-5.3 · cloud"). */
  id: string;
  provider: CloudProviderId;
  /** The provider's model id, e.g. "accounts/fireworks/models/glm-5p3". */
  providerModel: string;
  /** Provider price, USD per million tokens. */
  usdPerM: CloudTokenPrice;
  /** When the price was read off the provider's price list (YYYY-MM-DD). */
  priceAsOf: string;
  /** Context window the network serves the model with, tokens (at most the provider's). */
  contextWindow: number;
  /** Total parameters, billions (MoE total): Auto's sizing and display. */
  paramsB: number;
  /** Who made the model and where (ISO 3166-1 alpha-2): the data for an origin filter. */
  origin: { vendor: string; country: string };
  capabilities: Array<"tools" | "thinking" | "vision">;
  /**
   * Order among cloud models wherever they are listed (lower first; the default cloud model is 1).
   * The apps list cloud models in this order (orderCloudModels), never by name.
   */
  rank: number;
  /** Short hint after "Cloud" in pickers ("Cloud · recommended"); none: just "Cloud". */
  hint?: "recommended" | "premium";
  /**
   * Auto (best fit) may consider it without being told to (AUTO_CLOUD_MODELS unset: every
   * autoEligible model whose host is online). false keeps it out of Auto unless AUTO_CLOUD_MODELS
   * names it. CLOUD_MODELS_JSON entries default to true. docs/cloud-host.md.
   */
  autoEligible: boolean;
}

/** Built-in cloud models. Prices and ids read from fireworks.ai/pricing and the model pages on 2026-11-23. */
export const BUILTIN_CLOUD_MODELS: readonly CloudModelSpec[] = [
  {
    id: "glm-5.3",
    provider: "fireworks",
    providerModel: "accounts/fireworks/models/glm-5p3",
    usdPerM: { input: 1.4, cachedInput: 0.26, output: 4.4 },
    priceAsOf: "2026-11-23",
    // Fireworks serves 1040k; a round 1M leaves room for its own accounting.
    contextWindow: 1_000_000,
    paramsB: 744,
    origin: { vendor: "Z.ai (Zhipu AI)", country: "CN" },
    capabilities: ["tools"],
    // The premium cloud model: listed after the default. Auto takes it only when Flash can't take
    // the job, or the job asks for the best quality at top-tier complexity and the price allows it.
    rank: 2,
    hint: "premium",
    autoEligible: true,
  },
  {
    id: "deepseek-v4.1-flash",
    provider: "fireworks",
    providerModel: "accounts/fireworks/models/deepseek-v4p1-flash",
    usdPerM: { input: 0.3, cachedInput: 0.006, output: 1.2 },
    priceAsOf: "2026-11-23",
    contextWindow: 1_000_000,
    paramsB: 552,
    origin: { vendor: "DeepSeek", country: "CN" },
    capabilities: ["tools"],
    // The default cloud model (owner decision 2026-11-23): listed first; Auto's cloud pick by default (cheapest).
    rank: 1,
    hint: "recommended",
    autoEligible: true,
  },
];

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const PROVIDERS: readonly CloudProviderId[] = ["fireworks"];

function bad(msg: string): never {
  throw new Error(`CLOUD_MODELS_JSON: ${msg}`);
}

function price(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000) bad(`${what} must be a number of USD per million tokens (0-10000)`);
  return v;
}

/** One entry of CLOUD_MODELS_JSON, validated (throws with the reason). */
export function parseCloudModelSpec(raw: unknown): CloudModelSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("each entry must be an object");
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim().toLowerCase() : "";
  if (!ID_RE.test(id)) bad(`id ${JSON.stringify(r.id)} must be lower case letters, digits, '.', '-' or '_' (max 80)`);
  const provider = (r.provider ?? "fireworks") as CloudProviderId;
  if (!PROVIDERS.includes(provider)) bad(`${id}: provider must be one of ${PROVIDERS.join(", ")}`);
  if (typeof r.providerModel !== "string" || !r.providerModel.trim() || r.providerModel.length > 200) bad(`${id}: providerModel is required`);
  const p = (r.usdPerM ?? {}) as Record<string, unknown>;
  const input = price(p.input, `${id}: usdPerM.input`);
  const output = price(p.output, `${id}: usdPerM.output`);
  // A provider without a cache discount bills cached tokens as input.
  const cachedInput = p.cachedInput === undefined ? input : price(p.cachedInput, `${id}: usdPerM.cachedInput`);
  if (cachedInput > input) bad(`${id}: usdPerM.cachedInput is above usdPerM.input`);
  const ctx = r.contextWindow === undefined ? 128_000 : Number(r.contextWindow);
  if (!Number.isInteger(ctx) || ctx < 1_024 || ctx > 10_000_000) bad(`${id}: contextWindow must be an integer from 1024 to 10000000`);
  const paramsB = r.paramsB === undefined ? 100 : Number(r.paramsB);
  if (!Number.isFinite(paramsB) || paramsB <= 0 || paramsB > 100_000) bad(`${id}: paramsB must be a positive number`);
  const o = (r.origin ?? {}) as Record<string, unknown>;
  const vendor = typeof o.vendor === "string" && o.vendor.trim() ? o.vendor.trim().slice(0, 80) : "unknown";
  const country = typeof o.country === "string" && /^[A-Za-z]{2}$/.test(o.country) ? o.country.toUpperCase() : "ZZ";
  const caps = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is "tools" | "thinking" | "vision" => c === "tools" || c === "thinking" || c === "vision")
    : (["tools"] as Array<"tools">);
  const asOf = typeof r.priceAsOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.priceAsOf) ? r.priceAsOf : "unknown";
  const rank = r.rank === undefined ? 100 : Number(r.rank);
  if (!Number.isInteger(rank) || rank < 0 || rank > 10_000) bad(`${id}: rank must be an integer from 0 to 10000`);
  if (r.hint !== undefined && r.hint !== "recommended" && r.hint !== "premium") bad(`${id}: hint must be "recommended" or "premium"`);
  if (r.autoEligible !== undefined && typeof r.autoEligible !== "boolean") bad(`${id}: autoEligible must be true or false`);
  return {
    id, provider, providerModel: r.providerModel.trim(), usdPerM: { input, cachedInput, output }, priceAsOf: asOf, contextWindow: ctx, paramsB, origin: { vendor, country }, capabilities: caps,
    rank, ...(r.hint ? { hint: r.hint as "recommended" | "premium" } : {}), autoEligible: r.autoEligible !== false,
  };
}

/**
 * The catalog: the built-in models with CLOUD_MODELS_JSON (a JSON array of entries) layered over
 * them by id. Unset or empty = the built-in list. Throws on a malformed value, so a coordinator or
 * host never starts with a price list it could not read.
 */
export function parseCloudCatalog(raw: string | undefined): CloudModelSpec[] {
  const byId = new Map<string, CloudModelSpec>(BUILTIN_CLOUD_MODELS.map((m) => [m.id, m]));
  if (raw === undefined || raw.trim() === "") return [...byId.values()];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    bad("must be a JSON array of model entries");
  }
  if (!Array.isArray(parsed)) bad("must be a JSON array of model entries");
  if (parsed.length > 50) bad("at most 50 entries");
  for (const entry of parsed) {
    const m = parseCloudModelSpec(entry);
    byId.set(m.id, m);
  }
  return [...byId.values()];
}

let active: CloudModelSpec[] = [...BUILTIN_CLOUD_MODELS];

/** Use this catalog in this process (the coordinator and the cloud host call it at start with CLOUD_MODELS_JSON). */
export function configureCloudCatalog(raw: string | undefined): CloudModelSpec[] {
  active = parseCloudCatalog(raw);
  return active;
}

/** The catalog in use. */
export function cloudCatalog(): readonly CloudModelSpec[] {
  return active;
}

/** The cloud model a network model id names ("glm-5.3", any case, ":latest" ignored), or undefined. */
export function cloudModelSpec(model: string | undefined | null): CloudModelSpec | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase().replace(/:latest$/, "");
  return active.find((m) => m.id === id);
}

/**
 * `rows` with the cloud models in catalog rank order (the default cloud model first). Every other
 * row keeps its place, and the cloud rows keep the places they had, only their order among
 * themselves changes, so a list sorted by something else (machines online) stays sorted by it.
 */
export function orderCloudModels<T>(rows: readonly T[], modelOf: (row: T) => string, rankOf: (row: T) => number | undefined = (row) => cloudModelSpec(modelOf(row))?.rank): T[] {
  const slots: number[] = [];
  const cloud: T[] = [];
  rows.forEach((row, i) => {
    if (rankOf(row) !== undefined) {
      slots.push(i);
      cloud.push(row);
    }
  });
  const sorted = cloud
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (rankOf(a.row) ?? 0) - (rankOf(b.row) ?? 0) || a.i - b.i)
    .map((x) => x.row);
  const out = [...rows];
  slots.forEach((slot, i) => (out[slot] = sorted[i]));
  return out;
}

/** "Cloud · recommended", "Cloud · premium", or "Cloud". */
export function cloudLabel(hint: string | undefined): string {
  return hint ? `Cloud · ${hint}` : "Cloud";
}

/**
 * Which cloud models Auto may use (AUTO_CLOUD_MODELS): "all" (unset or empty, the default: every
 * autoEligible catalog model whose host is online), "off" (none: the emergency switch), or a list
 * of ids (only those, autoEligible or not).
 */
export type AutoCloudModels = "all" | "off" | readonly string[];

/** AUTO_CLOUD_MODELS: unset/empty = "all"; "off" (or none/0/false) = "off"; else the comma list (lower case, deduplicated). */
export function parseAutoCloudModels(raw: string | undefined): AutoCloudModels {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "" || t === "all" || t === "auto") return "all";
  if (t === "off" || t === "none" || t === "0" || t === "false") return "off";
  const list = [...new Set(t.split(",").map((s) => s.trim()).filter(Boolean))];
  return list.length ? list : "all";
}

/**
 * Auto may place a job on `model`: a catalog cloud model that the setting allows ("all": flagged
 * autoEligible; a list: named in it; "off": never). Never a model outside the cloud catalog.
 */
export function autoMayUseCloudModel(model: string, allowed: AutoCloudModels = "all"): boolean {
  const spec = cloudModelSpec(model);
  if (!spec || allowed === "off") return false;
  return allowed === "all" ? spec.autoEligible : allowed.includes(spec.id);
}

export function isCloudModel(model: string | undefined | null): boolean {
  return cloudModelSpec(model) !== undefined;
}

/** USD a call cost the platform at the provider's price (cached tokens are part of promptTokens). */
export function providerCostUsd(spec: Pick<CloudModelSpec, "usdPerM">, usage: { promptTokens?: number; cachedPromptTokens?: number; outputTokens?: number }): number {
  const prompt = Math.max(0, usage.promptTokens ?? 0);
  const cached = Math.min(prompt, Math.max(0, usage.cachedPromptTokens ?? 0));
  return ((prompt - cached) * spec.usdPerM.input + cached * spec.usdPerM.cachedInput + Math.max(0, usage.outputTokens ?? 0) * spec.usdPerM.output) / 1_000_000;
}
