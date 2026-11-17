import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTER_REFRESH_MS,
  ENROLLMENT_LOG_REPEAT_MS,
  enrollmentBackoffMs,
  enrollmentRefusalFromError,
  enrollmentRefusalKey,
  enrollmentRefusalMessage,
  portalLabel,
  isAgentNotRegisteredError,
  shouldLogEnrollmentRefusal,
  registeredLogLine,
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

describe("registeredLogLine", () => {
  it("names the agent, the coordinator and the granted class and tier", () => {
    const line = registeredLogLine("agent-7", "https://coordinator.edgecoder.io", {
      accepted: true,
      hardwareVerification: { status: "verified", grantedClass: "gpu", grantedTier: "pro", claimedTier: "pro" }
    });
    expect(line).toBe("[agent:agent-7] registered with https://coordinator.edgecoder.io (class=gpu tier=pro verification=verified)");
  });

  it("still logs a registration when the response carries no hardware verdict", () => {
    expect(registeredLogLine("a1", "http://127.0.0.1:4301", { accepted: true })).toBe("[agent:a1] registered with http://127.0.0.1:4301");
    expect(registeredLogLine("a1", "http://127.0.0.1:4301", undefined)).toBe("[agent:a1] registered with http://127.0.0.1:4301");
  });
});

describe("enrolment refusals: one clear line and a long back-off", () => {
  const refused = (body: unknown) => Object.assign(new Error(`POST /register failed (403): ${JSON.stringify(body)}`), { statusCode: 403 });

  it("recognises the enrolment reasons of a 403 node_not_activated, nothing else", () => {
    expect(enrollmentRefusalFromError(refused({ error: "node_not_activated", reason: "node_not_enrolled", tokenNodeId: "RTXA2000-Laptop" }))).toEqual({ reason: "node_not_enrolled", tokenNodeId: "RTXA2000-Laptop" });
    expect(enrollmentRefusalFromError(refused({ error: "node_not_activated", reason: "registration_token_required" }))).toEqual({ reason: "registration_token_required" });
    expect(enrollmentRefusalFromError(refused({ error: "node_not_activated", reason: "node_not_enrolled", tokenNodeId: "bad id\nx" }))).toEqual({ reason: "node_not_enrolled" });
    expect(enrollmentRefusalFromError(refused({ error: "node_not_activated", reason: "portal_validation_unreachable" }))).toBeNull();
    expect(enrollmentRefusalFromError(refused({ error: "agent_blacklisted", reason: "x" }))).toBeNull();
    expect(enrollmentRefusalFromError(Object.assign(new Error("POST /register failed (500): {}"), { statusCode: 500 }))).toBeNull();
    expect(enrollmentRefusalFromError(null)).toBeNull();
  });

  it("says which name to enrol, and the token's name when it differs", () => {
    const line = enrollmentRefusalMessage("nvidia-1-gpu", { reason: "node_not_enrolled", tokenNodeId: "RTXA2000-Laptop" }, 60_000, portalLabel("https://edgecoder.io"));
    expect(portalLabel(undefined)).toBe("the portal");
    expect(line).toContain(`This machine's id "nvidia-1-gpu" isn't enrolled. Enroll it on edgecoder.io → Settings → Nodes with exactly this name, or re-run the installer with an install key`);
    expect(line).toContain(`issued for "RTXA2000-Laptop"`);
    expect(line).toContain("Retrying in 60s.");
    expect(line.split("\n")).toHaveLength(1);
    expect(enrollmentRefusalMessage("box-gpu", { reason: "registration_token_required" }, 1000)).toContain("--token box-gpu=<token>");
  });

  it("backs off 1, 2, 4 ... minutes up to 15, and logs a refusal once an hour unless it changes", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(enrollmentBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
    const r = { reason: "node_not_enrolled" as const, tokenNodeId: "a-node" };
    expect(shouldLogEnrollmentRefusal(null, r, 0)).toBe(true);
    const last = { key: enrollmentRefusalKey(r), atMs: 0 };
    expect(shouldLogEnrollmentRefusal(last, r, 59 * 60_000)).toBe(false);
    expect(shouldLogEnrollmentRefusal(last, r, ENROLLMENT_LOG_REPEAT_MS)).toBe(true);
    expect(shouldLogEnrollmentRefusal(last, { reason: "registration_token_invalid" }, 1)).toBe(true);
  });
});
