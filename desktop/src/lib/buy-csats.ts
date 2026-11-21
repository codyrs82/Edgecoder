// "Buy cSats" from a failure: which amount to suggest, the request the Wallet page picks up
// (preselected amount, then back to the bot or chat after payment), and when a balance is low.
import { writable } from "svelte/store";
import { get } from "svelte/store";
import { callsForCSats, FUND_EXAMPLE_CLASS } from "./onboarding";
import { clampBuyAmount, type BuyLimit } from "./buy-limits";

/** The Wallet page's amounts (sats; a sat buys about a cSat before fees). */
export const TOP_UP_PRESETS = [5_000, 20_000, 100_000] as const;

/**
 * The amount to suggest: about a day of the bot's budget, or the step's estimate × 20, whichever
 * is more, rounded up to a Wallet preset (5k, 20k, 100k). 5k when nothing is known.
 */
export function suggestedTopUpSats(opts: { budgetCSatsPerDay?: number | null; stepCSats?: number | null; limit?: BuyLimit | null } = {}): number {
  const need = Math.max(opts.budgetCSatsPerDay ?? 0, (opts.stepCSats ?? 0) * 20);
  const pick = TOP_UP_PRESETS.find((p) => p >= need) ?? TOP_UP_PRESETS[TOP_UP_PRESETS.length - 1];
  // Never more than can be bought now (the 100 to 1M range): the Wallet would only refuse it.
  const limit = opts.limit === undefined ? get(buyLimitState) : opts.limit;
  return limit && limit.maxSats >= limit.minSats ? clampBuyAmount(pick, limit) : pick;
}

/** The Wallet page's effective purchase limit, once it has loaded the caps (null until then). */
export const buyLimitState = writable<BuyLimit | null>(null);

/** "This step needs about 0.4 cSats" → 0.4. */
export function neededCSatsIn(error: string | undefined): number | undefined {
  const m = /needs about ([0-9.]+) cSats/.exec(error ?? "");
  return m ? Number(m[1]) : undefined;
}

export interface BuyRequest {
  amountSats: number;
  /** Where the user came from ("Harry", "the chat"): the Wallet page offers to go back after payment. */
  returnTo?: string;
}

/** Set by a Buy cSats button; the Wallet page preselects the amount and clears it when done. */
export const buyRequest = writable<BuyRequest | null>(null);

/** Asks the app to open the Wallet page (App listens; ChatMessage and banners call it). */
export const openWalletRequest = writable(0);

export function requestBuy(req: BuyRequest): void {
  buyRequest.set(req);
  openWalletRequest.update((n) => n + 1);
}

/**
 * A balance worth a gentle "Running low": under about ten typical calls at live prices (or under
 * 1 cSat when prices aren't known). Zero is not "low", it is out (the failure says so).
 */
export function lowBalance(cSats: number | null | undefined, live?: { models?: Array<{ model: string; cSatsPerMTokens?: { input: number; output: number } }> | null; btcUsd?: number | null }): boolean {
  if (cSats == null || !(cSats > 0)) return false;
  const calls = callsForCSats(cSats, FUND_EXAMPLE_CLASS, live ?? {});
  return calls === null ? cSats < 1 : calls < 10;
}

/** The balance as the account menu last saw it (it polls), and whether it is low: for "Running low" notes. */
export const balanceState = writable<{ cSats: number | null; low: boolean }>({ cSats: null, low: false });
