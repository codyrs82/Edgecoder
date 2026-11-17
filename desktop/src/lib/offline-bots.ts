// Bots while the app is offline (connectivity.ts). A bot that can run on this computer keeps
// working; a bot that needs the network (Network only, or a network / reserved model) pauses with
// the status "Offline", not "Failed", and resumes by itself when the app is back online.
//
// The pause is the bot's own `enabled: false` (the server then starts no scheduled run), and the
// ids the app paused are kept in localStorage so only those resume, even after a restart while
// offline. Bots the user paused stay paused.
import { botCompute, statusChip, type Bot } from "./bots";

export const OFFLINE_PAUSED_KEY = "edgecoder_offlinePausedBots";

/** Can this bot only run on the network? ("This computer only", Auto, Local first, My machines: no.) */
export function needsNetwork(bot: Pick<Bot, "compute">): boolean {
  const c = botCompute(bot);
  if (c.policy === "network_only") return true;
  if (c.policy === "model") return /^(network|reserved)\//.test(c.model ?? "");
  return false;
}

/** The header chip, offline-aware: a network-only bot says "Offline" (not "Failed") while offline. */
export function botStatusChip(
  bot: Pick<Bot, "status" | "compute"> & Partial<Pick<Bot, "stuck" | "id">>,
  offline: boolean,
  pausedIds: readonly string[] = [],
): ReturnType<typeof statusChip> {
  if (bot.status !== "running" && bot.status !== "needs_approval") {
    if (offline && needsNetwork(bot)) return { text: "Offline", tone: "muted" };
    if (bot.id && pausedIds.includes(bot.id) && bot.status === "paused") return { text: "Offline", tone: "muted" };
  }
  return statusChip(bot);
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function safeStorage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function offlinePausedIds(store: Store | null = safeStorage()): string[] {
  try {
    const v = JSON.parse(store?.getItem(OFFLINE_PAUSED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveIds(ids: string[], store: Store | null): void {
  try {
    if (ids.length) store?.setItem(OFFLINE_PAUSED_KEY, JSON.stringify([...new Set(ids)]));
    else store?.removeItem(OFFLINE_PAUSED_KEY);
  } catch {
    /* storage unavailable */
  }
}

type Update = (id: string, patch: { enabled: boolean }) => Promise<unknown>;

/** Gone offline: pause the network-only bots that are on, and remember which. Returns their ids. */
export async function pauseNetworkBots(list: Bot[], update: Update, store: Store | null = safeStorage()): Promise<string[]> {
  const paused: string[] = [];
  for (const b of list) {
    if (!b.enabled || !needsNetwork(b)) continue;
    try {
      await update(b.id, { enabled: false });
      paused.push(b.id);
    } catch {
      // The local service may be down too; it simply runs nothing it can't reach.
    }
  }
  saveIds([...offlinePausedIds(store), ...paused], store);
  return paused;
}

/** Back online: resume the bots the app paused (and only those). Returns the ids resumed. */
export async function resumeNetworkBots(update: Update, store: Store | null = safeStorage()): Promise<string[]> {
  const ids = offlinePausedIds(store);
  const left: string[] = [];
  const resumed: string[] = [];
  for (const id of ids) {
    try {
      await update(id, { enabled: true });
      resumed.push(id);
    } catch (e) {
      // A deleted bot (404) is done with; anything else is tried again next time.
      if ((e as { status?: number })?.status !== 404) left.push(id);
    }
  }
  saveIds(left, store);
  return resumed;
}
