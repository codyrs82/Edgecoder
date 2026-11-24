// The compute the chat runs on, picked in the chat bar (like a model picker, but it also says
// where): a model on this computer, on your own machines, on the network (optionally one class),
// or on a machine you reserved. Stored as one model id, the same ids external tools use:
//   "qwen3.5:9b"  "mine/qwen3.5:9b"  "network/qwen3.5:9b@gpu"  "reserved/<id>/qwen3.5:9b"
// Undefined means Auto on this computer; "auto" means Auto anywhere: each request goes to the
// cheapest place that fits it (a reservation, this computer, your machines, then the network).

import { writable } from "svelte/store";

const KEY = "edgecoder-compute-choice";

function load(): string | undefined {
  try {
    return localStorage.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}

export const computeChoice = writable<string | undefined>(load());
computeChoice.subscribe((v) => {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: the choice lasts for this session
  }
});

export const CLASS_LABELS: Record<string, string> = { any: "Any", cpu: "CPU", apple: "Apple", gpu: "GPU", "gpu.dc": "Datacenter GPU", cloud: "Cloud" };

/** A cloud model's picker hint from /inference/models: "Cloud · recommended", "Cloud · premium", "Cloud"; null for other models. */
export function cloudHint(m: { cloudRank?: number; cloudHint?: string; classes?: string[] }): string | null {
  if (typeof m.cloudRank !== "number" && !(m.classes ?? []).includes("cloud")) return null;
  return m.cloudHint ? `Cloud · ${m.cloudHint}` : "Cloud";
}

export interface ParsedChoice {
  where: "auto" | "anywhere" | "local" | "mine" | "network" | "reserved" | "frontier";
  model?: string;
  computeClass?: string;
  reservationId?: string;
  /** "frontier": the provider of your own key (anthropic, openai, ...). */
  provider?: string;
}

/** Names of the Anthropic models offered on your own key (src/inference-api/frontier-models.ts). */
const FRONTIER_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
};

export const isFrontierChoice = (id: string | undefined) => typeof id === "string" && id.startsWith("frontier/");

/** "frontier/anthropic/claude-opus-5-5" -> "Claude Opus 5.5"; other providers show the model id. */
export function frontierName(id: string): string {
  const c = parseChoice(id);
  return (c.provider === "anthropic" && c.model && FRONTIER_NAMES[c.model]) || c.model || id;
}

export const formatUsd = (usd: number) => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** The session footer on a frontier lead: "Claude Opus 5.5 · your key · $0.42 this session". */
export function frontierFooter(id: string, sessionUsd: number): string {
  return `${frontierName(id)} · your key · ${formatUsd(sessionUsd)} this session`;
}

export function parseChoice(id: string | undefined): ParsedChoice {
  if (!id) return { where: "auto" };
  if (id === "auto") return { where: "anywhere" };
  const frontier = /^frontier\/([a-z0-9-]+)\/(.+)$/.exec(id);
  if (frontier) return { where: "frontier", provider: frontier[1], model: frontier[2] };
  if (id.startsWith("mine/")) return { where: "mine", model: id.slice(5) };
  const reserved = /^reserved\/([^/]+)\/(.+)$/.exec(id);
  if (reserved) return { where: "reserved", reservationId: reserved[1], model: reserved[2] };
  if (id.startsWith("network/")) {
    const rest = id.slice(8);
    const at = rest.lastIndexOf("@");
    const cls = at > 0 ? rest.slice(at + 1) : "";
    return CLASS_LABELS[cls] && cls !== "any" ? { where: "network", model: rest.slice(0, at), computeClass: cls } : { where: "network", model: rest, computeClass: "any" };
  }
  return { where: "local", model: id };
}

export function choiceId(c: ParsedChoice): string | undefined {
  if (c.where === "anywhere") return "auto";
  if (c.where === "auto" || !c.model) return undefined;
  if (c.where === "local") return c.model;
  if (c.where === "frontier") return `frontier/${c.provider}/${c.model}`;
  if (c.where === "mine") return `mine/${c.model}`;
  if (c.where === "reserved") return `reserved/${c.reservationId}/${c.model}`;
  return `network/${c.model}${c.computeClass && c.computeClass !== "any" ? `@${c.computeClass}` : ""}`;
}

/** Short model name: "qwen2.5-coder:7b-instruct-q4" -> "qwen2.5-coder:7b". */
export function shortModel(model: string): string {
  const [name, tag] = model.split(":");
  const t = tag?.split("-")[0];
  return t ? `${name}:${t}` : name;
}

/** "qwen3.5:9b · This Mac", "qwen3.5:9b · Network GPU", "Auto". */
export function choiceLabel(id: string | undefined): { model: string; where: string } {
  const c = parseChoice(id);
  if (c.where === "anywhere") return { model: "Auto", where: "Cheapest anywhere" };
  if (c.where === "auto" || !c.model) return { model: "Auto", where: "This computer" };
  if (c.where === "frontier") return { model: `Lead: ${frontierName(id!)}`, where: "your key" };
  const where =
    c.where === "local" ? "This computer" : c.where === "mine" ? "My machines" : c.where === "reserved" ? "Reserved" : c.computeClass && c.computeClass !== "any" ? `Network ${CLASS_LABELS[c.computeClass]}` : "Network";
  return { model: shortModel(c.model), where };
}

/** What a reply that ran on this choice says when the server didn't report cost (free places only). */
export function freeReplyUsage(id: string | undefined): { cSats: number; where: string } | undefined {
  const c = parseChoice(id);
  if (c.where !== "auto" && c.where !== "local" && c.where !== "mine") return undefined;
  const l = choiceLabel(id);
  return { cSats: 0, where: l.model === "Auto" ? l.where : `${l.where} · ${l.model}` };
}

/**
 * The reply footer: where it actually ran and what it actually cost. "free" only for places that
 * are free (this computer, your machines); a reservation is prepaid; anything else shows the cSats,
 * even 0. Nothing when the reply never ran anywhere (no place, no cost), e.g. a failed run.
 */
export function usageText(u: { cSats: number; where?: string; usd?: number }): string | null {
  const where = u.where?.trim();
  // Your own frontier key: billed by the provider in dollars, never cSats.
  if (typeof u.usd === "number" && Number.isFinite(u.usd)) return `${where || "Your key"} · ${formatUsd(u.usd)}`;
  const spent = Number.isFinite(u.cSats) && u.cSats > 0;
  if (!where && !spent) return null;
  const place = where || "Network";
  const cost = spent
    ? `${u.cSats.toLocaleString(undefined, { maximumFractionDigits: 3 })} cSats`
    : /^(this computer|my machines|your machines|local\b)/i.test(place)
      ? "free"
      : /^(reserved|your reserved)/i.test(place)
        ? "prepaid"
        : "0 cSats";
  return `${place} · ${cost}`;
}

/** Whether replies on this choice cost cSats. */
export const isBilled = (id: string | undefined) => ["network", "anywhere"].includes(parseChoice(id).where);

/**
 * Ollama's own cloud models ("gpt-oss:120b-cloud", "deepseek-v3.1:671b-cloud", "kimi:cloud") show
 * up in this computer's model list but run on Ollama's servers: they are not "This computer · free".
 */
export const isOllamaCloudTag = (name: string) => /(?::|-)cloud$/i.test(name.trim());

/** Network models served by EdgeCoder's cloud hosts (class "cloud"): listed only under Network. */
export function cloudModelNames(models: Array<{ model: string; classes?: string[] }> | undefined): Set<string> {
  return new Set((models ?? []).filter((m) => (m.classes ?? []).includes("cloud")).map((m) => m.model));
}

/** The picker's "This computer" rows: models installed in Ollama here, without embedders or anything that runs elsewhere. */
export function thisComputerModels(tags: string[], cloud: Set<string> = new Set()): string[] {
  return tags.filter((n) => !/embed/i.test(n) && !isOllamaCloudTag(n) && !cloud.has(n));
}

/** "My machines" rows: models on your other online machines; a cloud host (class "cloud") is never one of them. */
export function myMachineModels(
  machines: Array<{ agentId: string; online: boolean; models: string[]; computeClass?: string }> | undefined,
  selfAgentId: string | null | undefined,
  cloud: Set<string> = new Set(),
): Array<{ model: string; machines: number }> {
  const counts = new Map<string, number>();
  for (const m of machines ?? []) {
    if (!m.online || m.agentId === selfAgentId || m.computeClass === "cloud") continue;
    for (const model of m.models) if (!cloud.has(model) && !isOllamaCloudTag(model)) counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return [...counts.entries()].map(([model, machines]) => ({ model, machines }));
}

/** The hint on the picker's "This computer" heading: these are models installed here (Ollama). */
export function thisComputerHint(platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent || ""): string {
  return /mac/i.test(platform) ? "installed on this Mac" : "installed on this computer";
}
