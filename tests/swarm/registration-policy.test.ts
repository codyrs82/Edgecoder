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
