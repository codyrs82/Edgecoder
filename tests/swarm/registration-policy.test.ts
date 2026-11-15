import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTER_REFRESH_MS,
  isAgentNotRegisteredError,
  registerRefreshMsFromEnv,
  shouldRegister
} from "../../src/swarm/registration-policy.js";

// Regression: the worker loop registered on every ~1.2 s tick and the coordinator's
// BHV008 rule (10 registrations / 10 min) blacklisted every healthy worker within seconds.
describe("worker registration policy", () => {
  const url = "http://127.0.0.1:4301";

  it("registers on the first tick and after a coordinator change", () => {
    expect(shouldRegister({ registeredWithUrl: null, lastRegisteredAtMs: 0 }, url, 1_000)).toBe(true);
    expect(shouldRegister({ registeredWithUrl: "http://other:4301", lastRegisteredAtMs: 1_000 }, url, 2_000)).toBe(true);
  });

  it("does not re-register on ordinary ticks: fewer than 10 registrations in any 10-minute window", () => {
    const state = { registeredWithUrl: url, lastRegisteredAtMs: 0 };
    let registrations = 0;
    for (let now = 0; now < 10 * 60_000; now += 1_200) {
      if (shouldRegister(state, url, now)) {
        registrations++;
        state.lastRegisteredAtMs = now;
      }
    }
    expect(registrations).toBeLessThan(10);
    expect(registrations).toBeGreaterThanOrEqual(2); // the slow refresh still happens
  });

  it("refresh interval from env is clamped to at least one minute", () => {
    expect(registerRefreshMsFromEnv({})).toBe(DEFAULT_REGISTER_REFRESH_MS);
    expect(registerRefreshMsFromEnv({ AGENT_REGISTER_REFRESH_MS: "1000" })).toBe(DEFAULT_REGISTER_REFRESH_MS);
    expect(registerRefreshMsFromEnv({ AGENT_REGISTER_REFRESH_MS: "120000" })).toBe(120_000);
    expect(registerRefreshMsFromEnv({ AGENT_REGISTER_REFRESH_MS: "nope" })).toBe(DEFAULT_REGISTER_REFRESH_MS);
  });

  it("recognises the coordinator's agent_not_registered 401 and nothing else", () => {
    const notRegistered = Object.assign(new Error('POST /heartbeat failed (401): {"error":"mesh_unauthorized","reason":"agent_not_registered"}'), { statusCode: 401 });
    expect(isAgentNotRegisteredError(notRegistered)).toBe(true);
    expect(isAgentNotRegisteredError(Object.assign(new Error("POST /heartbeat failed (401): signature_invalid"), { statusCode: 401 }))).toBe(false);
    expect(isAgentNotRegisteredError(Object.assign(new Error("agent_not_registered"), { statusCode: 403 }))).toBe(false);
    expect(isAgentNotRegisteredError(null)).toBe(false);
  });
});

describe("429 handling (rate limit, not an auth failure)", () => {
  it("parseRetryAfterMs reads delta seconds and HTTP dates", async () => {
    const { parseRetryAfterMs } = await import("../../src/swarm/registration-policy.js");
    expect(parseRetryAfterMs("12")).toBe(12_000);
    expect(parseRetryAfterMs(["3"])).toBe(3_000);
    expect(parseRetryAfterMs(new Date(1_000_000 + 7_000).toUTCString(), 1_000_000)).toBe(7_000);
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });

  it("rateLimitWaitMs: a 429 means wait (bounded), anything else is not a rate limit", async () => {
    const { rateLimitWaitMs, isAgentNotRegisteredError, DEFAULT_RATE_LIMIT_WAIT_MS, MAX_RATE_LIMIT_WAIT_MS } = await import("../../src/swarm/registration-policy.js");
    const limited = Object.assign(new Error("POST /pull failed (429): {\"error\":\"agent_rate_limited\"}"), { statusCode: 429, retryAfterMs: 20_000 });
    expect(rateLimitWaitMs(limited)).toBe(20_000);
    expect(isAgentNotRegisteredError(limited)).toBe(false); // never a reason to re-register
    expect(rateLimitWaitMs(Object.assign(new Error("x"), { statusCode: 429 }))).toBe(DEFAULT_RATE_LIMIT_WAIT_MS);
    expect(rateLimitWaitMs(Object.assign(new Error("x"), { statusCode: 429, retryAfterMs: 3_600_000 }))).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(rateLimitWaitMs(Object.assign(new Error("x"), { statusCode: 401 }))).toBeNull();
    expect(rateLimitWaitMs(new Error("network"))).toBeNull();
  });
});
