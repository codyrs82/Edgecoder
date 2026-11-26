// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What one helper (tentacle) model call may set aside (#525). Each network call carries a price
 * ceiling (`maxCSats`) and the coordinator caps the call's reserve at it. The ceiling is the
 * smaller of
 *
 * - what is left of the tentacle's own budget, and
 * - what is left of the session's tentacle budget after the ceilings of the other helper calls
 *   in flight right now (their reserves are held on the account at the same time),
 *
 * so four helpers on a 25 cSat budget set aside at most 100 cSats together, never 4 × 53.6. A call
 * whose ceiling is below the smallest useful reserve (MIN_HELPER_CALL_CSATS) does not start: it
 * waits while other helpers' calls hold the session budget, and otherwise stops the helper with a
 * message that says why. Free places (this computer, your machines, a lease) hold nothing.
 */

/** The smallest ceiling a paid helper call starts with: below it the reply would be cut short. */
export const MIN_HELPER_CALL_CSATS = 0.05;

/**
 * Reply tokens a helper call may write at most (sent as max_tokens). A patch is a few hundred to
 * a couple of thousand tokens; a bounded reply keeps the reserve small, and with the prompt it
 * fits the 8192-token window most network hosts serve (an 8192 reply alone did not, so only hosts
 * with a larger window could take a helper call).
 */
export const HELPER_MAX_TOKENS = 4096;

/** The smallest reply a helper call asks for when its prompt leaves less room in the window. */
export const HELPER_MIN_REPLY_TOKENS = 1024;

/** The context window a helper call is sized to fit first: the network's common agent window (MIN_CONTEXT_WINDOW). */
export const HELPER_FIT_WINDOW = 8192;

/** Margin the coordinator adds to a call's prompt and reply (src/inference-api/ollama.ts contextNeeded). */
const CONTEXT_MARGIN = 256;

/** The helper's reply cap: EDGECODER_TENTACLE_MAX_TOKENS when set (256..32768), else HELPER_MAX_TOKENS. */
export function helperMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EDGECODER_TENTACLE_MAX_TOKENS);
  return env.EDGECODER_TENTACLE_MAX_TOKENS && Number.isFinite(n) ? Math.min(32_768, Math.max(256, Math.floor(n))) : HELPER_MAX_TOKENS;
}

/** A call's prompt in tokens, as the coordinator counts it (about 3 characters a token, tool calls and tool list included). */
export function promptTokensOf(messages: Array<{ content: string; tool_calls?: unknown }>, tools?: unknown[]): number {
  const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) + (tools ? JSON.stringify(tools).length : 0);
  return Math.ceil(chars / 3);
}

/**
 * The smallest context window (8192, 16384, 32768) that holds a helper call's prompt with at least
 * the minimum reply: the window the call is sized for, and its minContext routing hint.
 */
export function helperContextWindow(promptTokens: number, floor = HELPER_FIT_WINDOW): number {
  let w = Math.max(HELPER_FIT_WINDOW, floor);
  while (w < promptTokens + HELPER_MIN_REPLY_TOKENS + CONTEXT_MARGIN && w < 32_768) w *= 2;
  return w;
}

/**
 * Reply tokens for one helper call: the cap (helperMaxTokens), cut so the prompt and the reply fit
 * the smallest window that holds the prompt (helperContextWindow), never under the minimum (or the
 * cap, when that is lower). So the reply never pushes a call past the hosts its prompt fits.
 */
export function helperReplyTokens(promptTokens: number, cap = helperMaxTokens(), window = helperContextWindow(promptTokens)): number {
  const room = window - promptTokens - CONTEXT_MARGIN;
  return Math.max(Math.min(cap, HELPER_MIN_REPLY_TOKENS), Math.min(cap, room));
}

const round = (n: number) => Number(Math.max(0, n).toFixed(6));

/** Whether calls on `model` are billed per call on the network (auto, network/<m>); mine/, reserved/ and local tags are not. */
export function paidWorker(model: string): boolean {
  return model === "auto" || model.startsWith("network/");
}

/** One call's ceiling: the tentacle's budget left, within the session's budget left after the others' holds. */
export function helperCallCeiling(o: { tentacleLeft: number; sessionLeft: number; heldByOthers: number }): number {
  return round(Math.min(o.tentacleLeft, o.sessionLeft - Math.max(0, o.heldByOthers)));
}

/**
 * The smallest ceiling a helper call may start with: MIN_HELPER_CALL_CSATS, or (run 12) what the
 * network said the cheapest model that fits the call needs (`need`, from a no_route_fits "price"
 * refusal: nothing within the ceiling). Two helpers in network run 12 were sent with 1.139 cSats
 * left of the session after the other helpers' holds, the cheapest fitting (≥ 7B) model needed
 * ~3.9, and they failed instead of waiting for those holds to end.
 */
export function helperCallMinimum(need?: number): number {
  return Math.max(MIN_HELPER_CALL_CSATS, need !== undefined && Number.isFinite(need) ? need : 0);
}

/** Why a paid helper call can't start on `ceiling` (at least helperCallMinimum(need)), or null when it can. */
export function ceilingRefusal(ceiling: number, o: { tentacleBudget: number; tentacleLeft: number; need?: number }): string | null {
  const min = helperCallMinimum(o.need);
  if (ceiling >= min) return null;
  const fmt = (c: number) => `${c < 10 ? c.toFixed(2) : Math.round(c)} cSats`;
  const what = min > MIN_HELPER_CALL_CSATS ? `the cheapest model that fits this call needs (${fmt(min)})` : `one call sets aside (${fmt(min)})`;
  return o.tentacleLeft < min
    ? `budget reached: ${fmt(Math.max(0, o.tentacleLeft))} of the tentacle's ${fmt(o.tentacleBudget)} is left, less than ${what}`
    : `budget reached: the session's tentacle budget left (${fmt(Math.max(0, ceiling))}) is less than ${what}`;
}

/**
 * Run 12: the network refused a helper call for its price ceiling ("no_route_fits", reason "price")
 * and said what the cheapest fitting model needs: that need, or undefined for any other failure.
 */
export function priceRefusalNeed(err: unknown): number | undefined {
  const info = (err as { info?: { code?: string; reason?: string; neededCSats?: number } } | null)?.info;
  if (!info || info.code !== "no_route_fits" || info.reason !== "price") return undefined;
  return typeof info.neededCSats === "number" && Number.isFinite(info.neededCSats) && info.neededCSats > 0 ? info.neededCSats : undefined;
}

/** The ceilings of a session's helper calls in flight (held on the account until each call ends). */
export class CallHolds {
  private readonly holds = new Map<number, number>();
  private next = 0;
  private readonly waiters = new Set<() => void>();

  /** The sum of the holds, without `except`. */
  total(except?: number): number {
    let n = 0;
    for (const [k, v] of this.holds) if (k !== except) n += v;
    return round(n);
  }

  /** Hold `cSats` for a call; returns its key. */
  hold(cSats: number): number {
    const k = ++this.next;
    this.holds.set(k, Math.max(0, cSats));
    return k;
  }

  release(key: number | undefined): void {
    if (key === undefined || !this.holds.delete(key)) return;
    for (const w of [...this.waiters]) w();
  }

  /** Resolves when a hold is released (or after `ms`, or on abort). */
  async released(ms: number, signal?: AbortSignal): Promise<void> {
    if (!this.holds.size || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
