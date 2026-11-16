import { describe, expect, it } from "vitest";
import { LOUD_AFTER_MS, initialRefreshState, refreshFailed, refreshSucceeded, retryDelayMs, showBanner, staleNote } from "../src/lib/refresh-quiet";

describe("quiet refresh failures", () => {
  const T = 1_000_000;
  const ok = refreshSucceeded(initialRefreshState(), T);

  it("retries on a short backoff: 2 s, 5 s, then 15 s", () => {
    expect([1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([2_000, 5_000, 15_000, 15_000, 15_000]);
  });

  it("one failed refresh (a coordinator deploy) keeps the view with a muted note, no banner", () => {
    const s = refreshFailed(ok, T + 40_000, 502);
    expect(showBanner(s, T + 40_000)).toBe(false);
    expect(staleNote(s, T + 40_000)).toBe("Updated 40 s ago · reconnecting…");
    // Recovered: no note, no banner.
    const back = refreshSucceeded(s, T + 42_000);
    expect(showBanner(back, T + 42_000)).toBe(false);
    expect(staleNote(back, T + 42_000)).toBeNull();
  });

  it("the banner shows after about 60 s of continuous failure", () => {
    let s = refreshFailed(ok, T + 15_000, 502);
    s = refreshFailed(s, T + 17_000, 502);
    s = refreshFailed(s, T + 22_000, 502);
    expect(showBanner(s, T + 15_000 + LOUD_AFTER_MS - 1)).toBe(false);
    expect(showBanner(s, T + 15_000 + LOUD_AFTER_MS)).toBe(true);
    expect(staleNote(s, T + 15_000 + LOUD_AFTER_MS)).toBeNull();
  });

  it("an auth error shows the banner at once", () => {
    expect(showBanner(refreshFailed(ok, T + 1, 401), T + 1)).toBe(true);
    expect(showBanner(refreshFailed(ok, T + 1, 403), T + 1)).toBe(true);
  });

  it("with no view yet, the banner after three tries rather than a minute of skeleton", () => {
    let s = refreshFailed(initialRefreshState(), T, undefined);
    expect(showBanner(s, T)).toBe(false);
    s = refreshFailed(refreshFailed(s, T + 2_000), T + 7_000);
    expect(showBanner(s, T + 7_000)).toBe(true);
  });
});
