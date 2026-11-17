// What the network has right now, per machine class: the bot form's "Network <class> only" cards
// and the model list under them. Pure; fed by /v1/ide/compute (ComputeOverview).
import type { ComputeOverview } from "./api";
import { CLASS_LABELS, shortModel } from "./compute-choice";

/**
 * The classes a "Network <class> only" choice runs on: "gpu" is any GPU (consumer and datacenter);
 * the rest are themselves. Mirrors src/inference-api/auto-route.ts classFamily.
 */
export function classFamily(cls: string): string[] {
  return cls === "gpu" ? ["gpu", "gpu.dc"] : [cls];
}

export type ClassAvailability =
  /** Offline, not signed in, or the network didn't answer: nothing is disabled. */
  | { state: "unknown" }
  /** `online`: machines with a model (null when this coordinator doesn't count them); `models`: what they serve. */
  | { state: "available"; online: number | null; models: string[] }
  | { state: "none" };

/** Network models anyone may call (restricted ones run only on your own or reserved machines). */
function callable(ov: ComputeOverview): NonNullable<ComputeOverview["models"]> {
  return (ov.models ?? []).filter((m) => !m.restricted);
}

/** The network model id without "network/" and "@class". */
function bareModel(model: string): string {
  return model.replace(/^network\//, "").replace(/@[^@/]+$/, "");
}

/**
 * What a class (its family) has now; `model`: only machines serving that model. Unknown when the
 * overview is missing, not connected, or lists no models at all (the network didn't answer).
 */
export function classAvailability(ov: ComputeOverview | null | undefined, cls: string | undefined, model?: string): ClassAvailability {
  if (!ov || !ov.connected || !ov.models) return { state: "unknown" };
  const family = cls ? classFamily(cls) : ["cpu", "apple", "gpu", "gpu.dc"];
  const want = model ? bareModel(model) : undefined;
  const models = callable(ov).filter((m) => (!want || m.model === want) && m.classes.some((c) => family.includes(c)));
  if (!models.length) return { state: "none" };
  let online: number | null;
  if (want) {
    const by = models[0].agentsByClass;
    online = by ? family.reduce((n, c) => n + (by[c] ?? 0), 0) : null;
  } else {
    const counts = family.map((c) => ov.classes?.[c]?.agents);
    online = counts.every((n) => typeof n === "number") ? (counts as number[]).reduce((a, b) => a + b, 0) : null;
  }
  // A coordinator that counts machines and says 0 wins over a stale model list.
  if (online === 0) return { state: "none" };
  return { state: "available", online, models: [...models].sort((a, b) => b.agents - a.agents).map((m) => m.model) };
}

/** A class's name in sentences: "GPU", "Datacenter GPU", "Apple". */
export const classLabel = (cls: string): string => CLASS_LABELS[cls] ?? cls;

/** The card's live line: "2 online · qwen3-coder:30b", "Online · qwen3-coder:30b +2", "None online", "Availability unknown". */
export function availabilityLine(a: ClassAvailability): string {
  if (a.state === "unknown") return "Availability unknown";
  if (a.state === "none") return "None online";
  const first = a.models[0] ? shortModel(a.models[0]) : "";
  const more = a.models.length > 1 ? ` +${a.models.length - 1}` : "";
  return `${a.online === null ? "Online" : `${a.online} online`}${first ? ` · ${first}${more}` : ""}`;
}

/** The disabled card's tooltip. */
export function unavailableTitle(cls: string, model?: string): string {
  return model ? `No ${classLabel(cls)} machines with ${shortModel(bareModel(model))} on the network right now` : `No ${classLabel(cls)} machines on the network right now`;
}

/** The warning on a saved choice whose class is empty now. */
export function unavailableWarning(cls: string, model?: string): string {
  return `No ${classLabel(cls)} machines online${model ? ` with ${shortModel(bareModel(model))}` : ""}: runs will fail until one is back. Choose another option.`;
}

/** Network models a class (its family) serves now, for the Model list under a per-class card; null: don't filter. */
export function modelsInClass(ov: ComputeOverview | null | undefined, cls: string | undefined): string[] | null {
  if (!ov || !ov.connected || !ov.models || !cls) return null;
  const family = classFamily(cls);
  return callable(ov).filter((m) => m.classes.some((c) => family.includes(c))).map((m) => m.model);
}
