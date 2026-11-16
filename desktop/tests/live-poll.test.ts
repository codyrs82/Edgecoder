import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { livePoll } from "../src/lib/live-poll";

function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    set(hidden: boolean) {
      this.hidden = hidden;
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("livePoll", () => {
  it("runs at once and every interval, pauses while hidden, refreshes when shown again", async () => {
    const doc = fakeDoc();
    const fn = vi.fn(async () => {});
    const poll = livePoll(fn, 2000, doc as unknown as Document);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(3);
    doc.set(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fn).toHaveBeenCalledTimes(3);
    doc.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(4);
    poll.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(doc.listeners.size).toBe(0);
  });

  it("never overlaps a slow refresh and keeps going after a failure", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      await new Promise((r) => setTimeout(r, 5000));
    });
    const poll = livePoll(fn, 1000, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    void poll.now();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(3);
    poll.stop();
  });
});
