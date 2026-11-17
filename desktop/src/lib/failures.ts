// One failure, one place, one action: what kind a run or chat failure is, its short status, the
// compact line the conversation shows instead of the raw error, and repeats collapsed.

export type FailureKind = "csats" | "budget" | "class" | "offline" | "model" | "other";

/** The kind of a failure message (src/inference-api/auto-route.ts words them). */
export function failureKind(error: string | undefined): FailureKind {
  const e = (error ?? "").trim();
  if (/budget is spent|no cSats left today/i.test(e)) return "budget";
  if (/not enough cSats|no cSats|insufficient|balance 0|costs more than the .* cSats ceiling/i.test(e)) return "csats";
  if (/^No .+ machines? online|machine runs .* right now|no network .* machine has a model|no agent with a model is online/i.test(e)) return "class";
  if (/isn't connected|not connected|offline|isn't running|unreachable/i.test(e)) return "offline";
  if (/isn't installed|no model is installed|no model is available|no model fits|no model on the network fits/i.test(e)) return "model";
  return "other";
}

/** The short neutral status (sidebar, chip). */
export const FAILURE_STATUS: Record<FailureKind, string> = {
  csats: "Out of cSats",
  budget: "Budget spent",
  class: "No machines of its class online",
  offline: "Offline",
  model: "No model available",
  other: "Last run failed",
};

/** The compact conversation line. */
export const FAILURE_LINE: Record<FailureKind, string> = {
  csats: "Couldn't run: out of cSats",
  budget: "Couldn't run: today's budget is spent",
  class: "Couldn't run: no machines of that class online",
  offline: "Couldn't run: offline",
  model: "Couldn't run: no model available",
  other: "Couldn't run",
};

/**
 * A reply split from the model error at its end ("Error contacting model: …" from the agent loop,
 * "Error: …" from chat). `error` is undefined when the reply didn't fail.
 */
export function splitModelError(content: string): { text: string; error?: string } {
  const m = /(^|\n)(?:Error contacting model|Error): ([^\n]*)(?:\n\n\([^\n]*\)\s*)?\s*$/.exec(content);
  if (!m) return { text: content };
  return { text: content.slice(0, m.index).trimEnd(), error: m[2].trim() };
}

export type CollapsedItem<T> = { kind: "item"; item: T } | { kind: "failure"; id: string; failure: FailureKind; error: string; count: number };

/**
 * A conversation with failed replies as compact lines, repeats collapsed: a failure of the same
 * kind as the last line shown, with only events ("Scheduled run · 10:30") between them, adds to
 * its count (×3) instead of another line. `failureOf` says whether an item is a bare failure
 * (no other text, no tool calls); `isEvent` which items are run markers.
 */
export function collapseFailures<T>(items: T[], failureOf: (t: T) => { id: string; error: string } | null, isEvent: (t: T) => boolean): Array<CollapsedItem<T>> {
  const out: Array<CollapsedItem<T>> = [];
  let last: Extract<CollapsedItem<T>, { kind: "failure" }> | null = null;
  let held: T[] = [];
  for (const t of items) {
    if (last && isEvent(t)) {
      held.push(t);
      continue;
    }
    const f = failureOf(t);
    if (f) {
      const kind = failureKind(f.error);
      if (last && last.failure === kind) {
        last.count++;
        last.error = f.error;
        held = [];
        continue;
      }
      for (const h of held) out.push({ kind: "item", item: h });
      held = [];
      last = { kind: "failure", id: f.id, failure: kind, error: f.error, count: 1 };
      out.push(last);
      continue;
    }
    for (const h of held) out.push({ kind: "item", item: h });
    held = [];
    last = null;
    out.push({ kind: "item", item: t });
  }
  for (const h of held) out.push({ kind: "item", item: h });
  return out;
}
