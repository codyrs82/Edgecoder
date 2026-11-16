import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import {
  LocalServiceUnreachableError, RESTART_RETRY_DELAYS_MS, UNREACHABLE_SAVE_TEXT, UNREACHABLE_TEXT, fetchLocalService, isNetworkFailure, localServiceRestarting,
} from "../src/lib/local-service";

const ok = () => new Response(JSON.stringify({ bot: { id: "b1" } }), { status: 200 });
const loadFailed = () => new TypeError("Load failed");

describe("calls to the local service while it restarts (auto-update)", () => {
  it("knows a network-level failure from the rest", () => {
    expect(isNetworkFailure(new TypeError("Load failed"))).toBe(true);
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isNetworkFailure(new Error("budget: 400"))).toBe(false);
  });

  it("retries a save until the service is back, saying it's restarting meanwhile", async () => {
    const restarting: boolean[] = [];
    const off = localServiceRestarting.subscribe((v) => restarting.push(v));
    let n = 0;
    const send = vi.fn(async () => {
      n++;
      if (n <= 3) throw loadFailed();
      return ok();
    });
    const sleeps: number[] = [];
    const res = await fetchLocalService(send, { method: "PATCH", sleep: async (ms) => void sleeps.push(ms) });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual(RESTART_RETRY_DELAYS_MS.slice(0, 3));
    expect(restarting).toEqual([false, true, false]);
    expect(get(localServiceRestarting)).toBe(false);
    off();
  });

  it("gives up after about 10 s with a clear message, never the raw 'Load failed'", async () => {
    expect(RESTART_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9_000);
    expect(RESTART_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(12_000);
    const send = vi.fn(async () => {
      throw loadFailed();
    });
    const save = fetchLocalService(send, { method: "PATCH", sleep: async () => undefined });
    await expect(save).rejects.toBeInstanceOf(LocalServiceUnreachableError);
    await expect(fetchLocalService(send, { method: "POST", sleep: async () => undefined })).rejects.toThrow(UNREACHABLE_SAVE_TEXT);
    await expect(fetchLocalService(send, { method: "GET", sleep: async () => undefined })).rejects.toThrow(UNREACHABLE_TEXT);
    expect(send).toHaveBeenCalledTimes(3 * (RESTART_RETRY_DELAYS_MS.length + 1));
    expect(get(localServiceRestarting)).toBe(false);
  });

  it("an HTTP error or a cancelled call is not retried", async () => {
    const bad = vi.fn(async () => new Response("{}", { status: 400 }));
    expect((await fetchLocalService(bad, { method: "PATCH", sleep: async () => undefined })).status).toBe(400);
    expect(bad).toHaveBeenCalledTimes(1);
    const ctl = new AbortController();
    ctl.abort();
    const send = vi.fn(async () => {
      throw loadFailed();
    });
    await expect(fetchLocalService(send, { method: "POST", signal: ctl.signal, sleep: async () => undefined })).rejects.toThrow("Load failed");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
