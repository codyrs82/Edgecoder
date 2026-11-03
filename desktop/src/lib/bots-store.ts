// The bots list, shared by the sidebar and the bot page; refreshed every few seconds while the
// app is open (a local call to :4304), faster while a bot is working.
import { writable } from "svelte/store";
import { listBots } from "./api";
import type { Bot } from "./bots";

export const bots = writable<Bot[]>([]);
/** The bot whose conversation is open in the chat tab, or null for an ordinary chat. */
export const activeBotId = writable<string | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;
let polling = 0;

export async function refreshBots(): Promise<Bot[]> {
  try {
    const list = await listBots();
    bots.set(list);
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
