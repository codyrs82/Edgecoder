// The app's connectivity wiring (lib/connectivity.ts): what happens when it goes offline and when
// it comes back. The handlers are separate from the monitor so they are tested directly.
import { get } from "svelte/store";
import { updateBot } from "./api";
import { bots, refreshBots } from "./bots-store";
import type { Bot } from "./bots";
import { BACK_ONLINE_TEXT, BACK_ONLINE_TOAST_MS, reachEdgeCoder, startConnectivityMonitor, stopConnectivityMonitor } from "./connectivity";
import { coordinatorUrl, portalUrl } from "./endpoints";
import { offlinePausedIds, pauseNetworkBots, resumeNetworkBots } from "./offline-bots";
import { inDesktopShell } from "./service-status";
import { notify } from "./toast";

export interface ConnectivityHandlerDeps {
  notify: (text: string, kind: "success", id: string, durationMs: number) => void;
  bots: () => Bot[];
  update: (id: string, patch: { enabled: boolean }) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  /** Where the paused ids are kept (localStorage by default). */
  store?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

export function connectivityHandlers(d: ConnectivityHandlerDeps) {
  return {
    /** Network-only bots pause (status "Offline"); everything on this computer keeps working. */
    onOffline: async () => {
      await pauseNetworkBots(d.bots(), d.update, ...(d.store !== undefined ? [d.store] : []));
      await d.refresh().catch(() => undefined);
    },
    /** A short "Back online" toast; the bots the app paused resume. Pages refresh via onBackOnline. */
    onOnline: async () => {
      d.notify(BACK_ONLINE_TEXT, "success", "back-online", BACK_ONLINE_TOAST_MS);
      await resumeNetworkBots(d.update, ...(d.store !== undefined ? [d.store] : []));
      await d.refresh().catch(() => undefined);
    },
  };
}

/** Start watching connectivity (desktop app only). Returns the stop function. */
export function startConnectivity(): () => void {
  if (!inDesktopShell()) return () => {};
  const h = connectivityHandlers({ notify, bots: () => get(bots), update: (id, patch) => updateBot(id, patch), refresh: refreshBots });
  const m = startConnectivityMonitor({
    check: () => reachEdgeCoder([`${coordinatorUrl()}/health`, `${portalUrl()}/health`]),
    events: window,
    onOffline: () => void h.onOffline(),
    onOnline: () => void h.onOnline(),
  });
  // Closed while offline last time: resume what the app paused once the network is confirmed.
  void m.checkNow().then(() => {
    if (m.current.state === "online" && offlinePausedIds().length) void resumeNetworkBots(updateBot).then(() => refreshBots());
  });
  return stopConnectivityMonitor;
}
