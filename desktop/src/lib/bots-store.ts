// The bots list, shared by the sidebar and the bot page; refreshed every few seconds while the
// app is open (a local call to :4304), faster while a bot is working.
import { writable } from "svelte/store";
import { listBots } from "./api";
import { stuckText, type Bot } from "./bots";
import { notify } from "./toast";

export const bots = writable<Bot[]>([]);
/** The bot whose conversation is open in the chat tab, or null for an ordinary chat. */
export const activeBotId = writable<string | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;
let polling = 0;

/** Bots already announced as stuck (one toast each time a bot gets stuck). */
const stuckSeen = new Map<string, number>();

/** Say so when a bot pauses itself because it kept hitting the same problem. */
export function announceStuck(list: Bot[], say: (text: string, id: string) => void = (t, id) => notify(t, "info", id)): void {
  for (const b of list) {
    if (!b.stuck) {
      stuckSeen.delete(b.id);
      continue;
    }
    if (stuckSeen.get(b.id) === b.stuck.atMs) continue;
    stuckSeen.set(b.id, b.stuck.atMs);
    say(stuckText(b.name, b.stuck), `bot-stuck-${b.id}`);
  }
}

export async function refreshBots(): Promise<Bot[]> {
  try {
    const list = await listBots();
    bots.set(list);
    announceStuck(list);
    return list;
  } catch {
    return [];
  }
}

/** Keep the list fresh; returns a stop function. */
export function pollBots(): () => void {
  polling++;
  const loop = async () => {
    const list = await refreshBots();
    const busy = list.some((b) => b.status === "running" || b.status === "needs_approval");
    if (polling > 0) timer = setTimeout(loop, busy ? 2_000 : 8_000);
  };
  void loop();
  return () => {
    polling = Math.max(0, polling - 1);
    if (polling === 0) clearTimeout(timer);
  };
}
