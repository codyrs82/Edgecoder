import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACK_ONLINE_TEXT, BACK_ONLINE_TOAST_MS, CONFIRM_MS, ConnectivityMonitor, FAILS_TO_GO_OFFLINE, ONLINE_CHECK_MS, connectivity, nextConnectivity, offlineBackoffMs,
  onBackOnline, reachEdgeCoder, setConnectivityForTests, startConnectivityMonitor, stopConnectivityMonitor,
} from "../src/lib/connectivity";
import { OFFLINE_PAUSED_KEY, botStatusChip, needsNetwork, offlinePausedIds, pauseNetworkBots, resumeNetworkBots } from "../src/lib/offline-bots";
import type { Bot } from "../src/lib/bots";

vi.mock("../src/lib/api", () => ({ updateBot: vi.fn(), listBots: vi.fn(async () => []) }));
vi.mock("../src/lib/toast", () => ({ notify: vi.fn() }));
const { connectivityHandlers } = await import("../src/lib/connectivity-app");

function fakeCheck(initial = true) {
  const s = { up: initial, calls: 0 };
  return { s, check: vi.fn(async () => (s.calls++, s.up)) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stopConnectivityMonitor();
  vi.useRealTimers();
});

describe("nextConnectivity (debounce)", () => {
  const online = { state: "online" as const, offlineSinceMs: null };
  it("one failed check is not offline; two are", () => {
    expect(FAILS_TO_GO_OFFLINE).toBe(2);
    const a = nextConnectivity(online, 0, false, 10);
    expect(a.state.state).toBe("online");
    const b = nextConnectivity(a.state, a.fails, false, 20);
    expect(b.state).toEqual({ state: "offline", offlineSinceMs: 20 });
  });
  it("one success brings it back and clears the count", () => {
    expect(nextConnectivity({ state: "offline", offlineSinceMs: 1 }, 7, true, 30)).toEqual({ state: online, fails: 0 });
    expect(nextConnectivity(online, 1, true, 30).fails).toBe(0);
  });
  it("backs off while offline: 2 s, 5 s, 10 s, then every 30 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(offlineBackoffMs)).toEqual([2_000, 5_000, 10_000, 30_000, 30_000, 30_000]);
  });
});

describe("ConnectivityMonitor (fake timers)", () => {
  it("online → (one blip: still online) → offline after two failures → online after one success", async () => {
    const { s, check } = fakeCheck(true);
    const onOffline = vi.fn();
    const onOnline = vi.fn();
    const m = new ConnectivityMonitor({ check, onOffline, onOnline });
    const seen: string[] = [];
    m.subscribe((v) => seen.push(v.state));
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.current.state).toBe("online");
    // A single dropped check: confirmed CONFIRM_MS later, and it's fine: no flap.
    s.up = false;
    await vi.advanceTimersByTimeAsync(ONLINE_CHECK_MS);
    expect(m.current.state).toBe("online");
    s.up = true;
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(m.current.state).toBe("online");
    expect(onOffline).not.toHaveBeenCalled();
    // Really gone: two failures in a row.
    s.up = false;
    await vi.advanceTimersByTimeAsync(ONLINE_CHECK_MS);
    expect(m.current.state).toBe("online");
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(m.current.state).toBe("offline");
    expect(onOffline).toHaveBeenCalledOnce();
    // Checks back off while offline.
    const at = s.calls;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.calls).toBe(at + 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(s.calls).toBe(at + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toBe(at + 2);
    // One success: back online.
    s.up = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.current.state).toBe("online");
    expect(onOnline).toHaveBeenCalledOnce();
    expect(seen).toEqual(["online", "offline", "online"]);
    m.stop();
  });

  it("the window's online/offline events check at once", async () => {
    const { s, check } = fakeCheck(true);
    const target = new EventTarget() as unknown as Window;
    const m = new ConnectivityMonitor({ check, events: target });
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    const at = s.calls;
    target.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.calls).toBe(at + 1);
    m.stop();
  });

  it("the shared store is online until the app starts the monitor; onBackOnline fires on offline → online only", async () => {
    expect(get(connectivity).state).toBe("online");
    const fn = vi.fn();
    const off = onBackOnline(fn);
    setConnectivityForTests("online");
    expect(fn).not.toHaveBeenCalled();
    const { s, check } = fakeCheck(false);
    startConnectivityMonitor({ check });
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(get(connectivity).state).toBe("offline");
    s.up = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(get(connectivity).state).toBe("online");
    expect(fn).toHaveBeenCalledOnce();
    off();
  });
});

describe("reachEdgeCoder", () => {
  it("any HTTP answer from the coordinator or the portal counts; the OS saying offline doesn't try", async () => {
    vi.useRealTimers();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("coord")) throw new TypeError("Load failed");
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    expect(await reachEdgeCoder(["https://coord/health", "https://portal/health"], { fetchImpl, navigatorOnLine: () => true })).toBe(true);
    const down = vi.fn(async () => { throw new TypeError("Load failed"); }) as unknown as typeof fetch;
    expect(await reachEdgeCoder(["https://coord/health", "https://portal/health"], { fetchImpl: down, navigatorOnLine: () => true })).toBe(false);
    const never = vi.fn() as unknown as typeof fetch;
    expect(await reachEdgeCoder(["https://coord/health"], { fetchImpl: never, navigatorOnLine: () => false })).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
});

// ---- Bots ------------------------------------------------------------------------------
function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const bot = (id: string, compute: Bot["compute"], extra: Partial<Bot> = {}) => ({ id, name: id, enabled: true, status: "idle", compute, ...extra }) as Bot;

describe("bots while offline", () => {
  it("needs the network: Network only, or a network / reserved model; not this computer, Auto or my machines", () => {
    expect(needsNetwork(bot("a", { policy: "network_only" }))).toBe(true);
    expect(needsNetwork(bot("b", { policy: "model", model: "network/qwen3:32b@gpu" }))).toBe(true);
    expect(needsNetwork(bot("c", { policy: "model", model: "reserved/r1/qwen" }))).toBe(true);
    expect(needsNetwork(bot("d", { policy: "local_only" }))).toBe(false);
    expect(needsNetwork(bot("e", { policy: "model", model: "qwen3.5:9b" }))).toBe(false);
    expect(needsNetwork(bot("f", { policy: "auto" }))).toBe(false);
    expect(needsNetwork(bot("g", undefined))).toBe(false);
  });

  it("status: a network-only bot says Offline, not Failed; a this-computer bot is unchanged", () => {
    const net = bot("a", { policy: "network_only" }, { status: "error" });
    expect(botStatusChip(net, false).text).toBe("Failed");
    expect(botStatusChip(net, true)).toEqual({ text: "Offline", tone: "muted" });
    expect(botStatusChip(bot("b", { policy: "local_only" }, { status: "running" }), true).text).toBe("Running");
    expect(botStatusChip(bot("c", { policy: "local_only" }, { status: "error" }), true).text).toBe("Failed");
    // Paused by the app while offline, shown as Offline until it resumes.
    expect(botStatusChip(bot("d", { policy: "network_only" }, { status: "paused" }), false, ["d"]).text).toBe("Offline");
  });

  it("going offline pauses only the network-only bots that are on; back online resumes only those", async () => {
    const store = memStore();
    const update = vi.fn(async () => undefined);
    const list = [
      bot("net", { policy: "network_only" }),
      bot("local", { policy: "local_only" }),
      bot("userPaused", { policy: "network_only" }, { enabled: false }),
    ];
    expect(await pauseNetworkBots(list, update, store)).toEqual(["net"]);
    expect(update).toHaveBeenCalledWith("net", { enabled: false });
    expect(update).toHaveBeenCalledTimes(1);
    expect(offlinePausedIds(store)).toEqual(["net"]);
    update.mockClear();
    expect(await resumeNetworkBots(update, store)).toEqual(["net"]);
    expect(update).toHaveBeenCalledWith("net", { enabled: true });
    expect(store.getItem(OFFLINE_PAUSED_KEY)).toBeNull();
  });

  it("a resume that fails is kept for next time; a deleted bot is dropped", async () => {
    const store = memStore();
    store.setItem(OFFLINE_PAUSED_KEY, JSON.stringify(["a", "gone"]));
    const update = vi.fn(async (id: string) => {
      if (id === "a") throw new TypeError("Load failed");
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    expect(await resumeNetworkBots(update, store)).toEqual([]);
    expect(offlinePausedIds(store)).toEqual(["a"]);
  });
});

describe("reconnect", () => {
  it("shows a short Back online toast (about 3 s), resumes paused bots and refreshes", async () => {
    vi.useRealTimers();
    const notify = vi.fn();
    const update = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => []);
    const h = connectivityHandlers({ notify, bots: () => [bot("net", { policy: "network_only" })], update, refresh, store: memStore() });
    await h.onOffline();
    expect(update).toHaveBeenCalledWith("net", { enabled: false });
    expect(notify).not.toHaveBeenCalled();
    await h.onOnline();
    expect(notify).toHaveBeenCalledWith(BACK_ONLINE_TEXT, "success", "back-online", BACK_ONLINE_TOAST_MS);
    expect(BACK_ONLINE_TOAST_MS).toBe(3_000);
    expect(update).toHaveBeenLastCalledWith("net", { enabled: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
