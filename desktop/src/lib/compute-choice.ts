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

export const CLASS_LABELS: Record<string, string> = { any: "Any", cpu: "CPU", apple: "Apple", gpu: "GPU", "gpu.dc": "Datacenter GPU" };

export interface ParsedChoice {
  where: "auto" | "anywhere" | "local" | "mine" | "network" | "reserved";
  model?: string;
  computeClass?: string;
  reservationId?: string;
}

export function parseChoice(id: string | undefined): ParsedChoice {
  if (!id) return { where: "auto" };
  if (id === "auto") return { where: "anywhere" };
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
export function usageText(u: { cSats: number; where?: string }): string | null {
  const where = u.where?.trim();
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
