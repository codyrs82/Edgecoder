import { describe, expect, test } from "vitest";
import { acceptedTokens, matchesTokenSet, previousUntilProblem, tokenSet, MAX_PREVIOUS_WINDOW_MS } from "../../src/common/token-rotation.js";
import { checkTokenSet } from "../../src/common/env-guard.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");

describe("token rotation: dual-accept window", () => {
  test("the previous value is accepted only inside TOKEN_PREVIOUS_UNTIL", () => {
    const set = tokenSet("new-token", "old-token", "2026-11-18T12:00:00Z", NOW);
    expect(matchesTokenSet("new-token", set, NOW)).toBe(true);
    expect(matchesTokenSet("old-token", set, NOW)).toBe(true);
    expect(matchesTokenSet("old-token", set, Date.parse("2026-11-18T12:00:01Z"))).toBe(false);
    expect(matchesTokenSet("new-token", set, Date.parse("2026-11-30T00:00:00Z"))).toBe(true);
    expect(matchesTokenSet("other", set, NOW)).toBe(false);
    expect(matchesTokenSet(undefined, set, NOW)).toBe(false);
    expect(matchesTokenSet("", set, NOW)).toBe(false);
  });

  test("no window, a malformed one, or one more than 7 days ahead: the previous value is never accepted", () => {
    expect(acceptedTokens(tokenSet("new", "old", undefined, NOW), NOW)).toEqual(["new"]);
    expect(acceptedTokens(tokenSet("new", "old", "soon", NOW), NOW)).toEqual(["new"]);
    expect(acceptedTokens(tokenSet("new", "old", String(NOW + MAX_PREVIOUS_WINDOW_MS + 1), NOW), NOW)).toEqual(["new"]);
    expect(acceptedTokens(tokenSet("new", "old", String(NOW + 3_600_000), NOW), NOW)).toEqual(["new", "old"]);
    expect(previousUntilProblem("soon", NOW)).toMatch(/ISO 8601/);
    expect(previousUntilProblem(String(NOW + MAX_PREVIOUS_WINDOW_MS + 60_000), NOW)).toMatch(/7 days/);
    expect(previousUntilProblem(undefined, NOW)).toBeNull();
  });

  test("checkTokenSet: configured-ness comes from the current value", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(checkTokenSet(tokenSet("", "old", until), "old", true)).toBe("not_configured");
    expect(checkTokenSet(tokenSet("cur", "old", until), "old", true)).toBe("ok");
    expect(checkTokenSet(tokenSet("cur", "old", until), "nope", true)).toBe("unauthorized");
  });
});
