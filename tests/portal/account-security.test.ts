import { describe, expect, it } from "vitest";
import { base32Decode, hotp, totpStep } from "../../src/portal/totp.js";
import { maskDestination, securityKey, twoFactorCodecFromEnv, userIdFromLinkToken, MAX_2FA_FAILURES } from "../../src/portal/account-security.js";
import { HOUR, testSecurity } from "./fixtures/account-security-memory.js";

const codeFor = (secretB32: string, nowMs: number, offsetSteps = 0) => hotp(base32Decode(secretB32), totpStep(nowMs) + offsetSteps);

async function enrolled(over = {}) {
  const t = testSecurity(over);
  const setup = await t.security.startTotp("u1", "u1@mail.example");
  if (!setup.ok) throw new Error(setup.error);
  // Enabling uses the current step; move two steps on so the previous step (skew) is a new one too.
  const enable = await t.security.enableTotp("u1", codeFor(setup.secret, t.clock.now));
  if (!enable.ok) throw new Error(enable.error);
  t.clock.now += 60_000;
  return { ...t, secret: setup.secret, recoveryCodes: enable.recoveryCodes };
}

describe("account security: TOTP enrolment", () => {
  it("needs a code from the new secret, then returns 10 recovery codes once", async () => {
    const t = testSecurity();
    const setup = await t.security.startTotp("u1", "u1@mail.example");
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.otpauthUri).toContain(setup.secret);
    expect(await t.security.enableTotp("u1", "000000")).toEqual({ ok: false, error: "totp_code_invalid" });
    const r = await t.security.enableTotp("u1", codeFor(setup.secret, t.clock.now));
    expect(r.ok && r.recoveryCodes.length).toBe(10);
    const status = t.security.status(await t.security.load("u1"), 0);
    expect(status).toMatchObject({ enabled: true, totpEnabled: true, recoveryCodesRemaining: 10, methods: ["totp", "recovery_code"] });
    expect(await t.security.startTotp("u1", "x")).toEqual({ ok: false, error: "totp_already_enabled" });
  });

  it("stores the secret encrypted and the recovery codes hashed", async () => {
    const t = await enrolled();
    const raw = t.kv.rows.get(securityKey("u1"))!.json;
    expect(raw).not.toContain(t.secret);
    expect(raw).not.toContain(Buffer.from(base32Decode(t.secret)).toString("base64"));
    expect(raw).toContain("enc:v1:");
    for (const c of t.recoveryCodes) expect(raw).not.toContain(c);
  });

  it("refuses to enrol without an encryption key", async () => {
    const t = testSecurity({ codec: twoFactorCodecFromEnv({}) });
    expect(await t.security.startTotp("u1", "x")).toEqual({ ok: false, error: "two_factor_key_not_configured" });
  });

  it("derives a working key from OAUTH_STATE_SECRET, and PORTAL_2FA_KEY added later still reads it", () => {
    const derived = twoFactorCodecFromEnv({ OAUTH_STATE_SECRET: "s".repeat(40) });
    const sealed = derived.encodeText("secret", "totp:u1");
    const both = twoFactorCodecFromEnv({ PORTAL_2FA_KEY: "ab".repeat(32), OAUTH_STATE_SECRET: "s".repeat(40) });
    expect(both.decodeText(sealed, "totp:u1")).toBe("secret");
    expect(() => both.decodeText(sealed, "totp:u2")).toThrow();
  });
});

describe("account security: second factor", () => {
  it("accepts the current code and ±1 step, each step only once", async () => {
    const t = await enrolled();
    expect(await t.security.verifyCode("u1", codeFor(t.secret, t.clock.now, -1), null)).toEqual({ ok: true, via: "totp" });
    // The same code again (replay) and any older one are refused.
    expect(await t.security.verifyCode("u1", codeFor(t.secret, t.clock.now, -1), null)).toMatchObject({ ok: false });
    expect(await t.security.verifyCode("u1", codeFor(t.secret, t.clock.now, 1), null)).toEqual({ ok: true, via: "totp" });
    t.clock.now += 120_000;
    expect(await t.security.verifyCode("u1", codeFor(t.secret, t.clock.now, 2), null)).toMatchObject({ ok: false, error: "two_factor_code_invalid" });
    expect(await t.security.verifyCode("u1", codeFor(t.secret, t.clock.now), null)).toEqual({ ok: true, via: "totp" });
  });

  it("recovery codes work once each", async () => {
    const t = await enrolled();
    const [first, second] = t.recoveryCodes;
    expect(await t.security.verifyCode("u1", first.toUpperCase(), null)).toEqual({ ok: true, via: "recovery_code" });
    expect(await t.security.verifyCode("u1", first, null)).toMatchObject({ ok: false, error: "two_factor_code_invalid" });
    expect(await t.security.verifyCode("u1", second, null)).toEqual({ ok: true, via: "recovery_code" });
    expect(t.security.status(await t.security.load("u1"), 0).recoveryCodesRemaining).toBe(8);
  });

  it("pauses after too many wrong codes, then recovers after the window", async () => {
    const t = await enrolled();
    for (let i = 0; i < MAX_2FA_FAILURES; i++) expect(await t.security.verifyCode("u1", "000000", null)).toMatchObject({ ok: false, error: "two_factor_code_invalid" });
    expect(await t.security.verifyCode("u1", codeFor(t.secret, t.clock.now), null)).toMatchObject({ ok: false, error: "two_factor_rate_limited" });
    t.clock.now += 16 * 60 * 1000;
    expect(await t.security.verifyCode("u1", codeFor(t.secret, t.clock.now), null)).toEqual({ ok: true, via: "totp" });
  });

  it("requireSecondFactor: open without 2FA; with it, a step-up in this session or a right code", async () => {
    const plain = testSecurity();
    expect(await plain.security.requireSecondFactor("u1", { passkeyCount: 0, sessionHash: "s1" })).toEqual({ ok: true, via: "not_enabled" });

    const t = await enrolled();
    const refused = await t.security.requireSecondFactor("u1", { passkeyCount: 0, sessionHash: "s1" });
    expect(refused).toMatchObject({ ok: false, status: 403, body: { error: "two_factor_required", methods: ["totp", "recovery_code"] } });
    expect(await t.security.requireSecondFactor("u1", { passkeyCount: 0, sessionHash: "s1", code: "111111" })).toMatchObject({ ok: false, status: 401 });
    expect(await t.security.requireSecondFactor("u1", { passkeyCount: 0, sessionHash: "s1", code: codeFor(t.secret, t.clock.now) })).toEqual({ ok: true, via: "totp" });
    // The code made a step-up for session s1 only, for 10 minutes.
    expect(await t.security.requireSecondFactor("u1", { passkeyCount: 0, sessionHash: "s1" })).toEqual({ ok: true, via: "step_up" });
    expect(await t.security.requireSecondFactor("u1", { passkeyCount: 0, sessionHash: "s2" })).toMatchObject({ ok: false, status: 403 });
    t.clock.now += 11 * 60 * 1000;
    expect(await t.security.requireSecondFactor("u1", { passkeyCount: 0, sessionHash: "s1" })).toMatchObject({ ok: false, status: 403 });
  });

  it("a passkey counts as 2FA: required, and satisfied by a passkey step-up", async () => {
    const t = testSecurity();
    const r = await t.security.requireSecondFactor("u1", { passkeyCount: 1, sessionHash: "s1" });
    expect(r).toMatchObject({ ok: false, status: 403, body: { methods: ["passkey"] } });
    await t.security.grantStepUp("u1", "s1");
    expect(await t.security.requireSecondFactor("u1", { passkeyCount: 1, sessionHash: "s1" })).toEqual({ ok: true, via: "step_up" });
  });

  it("turning TOTP off needs a valid code and drops the recovery codes", async () => {
    const t = await enrolled();
    expect(await t.security.disableTotp("u1", "000000", null)).toMatchObject({ ok: false });
    expect(await t.security.disableTotp("u1", t.recoveryCodes[0], null)).toEqual({ ok: true });
    expect(t.security.status(await t.security.load("u1"), 0)).toMatchObject({ enabled: false, recoveryCodesRemaining: 0 });
  });

  it("new recovery codes replace the old ones", async () => {
    const t = await enrolled();
    const r = await t.security.regenerateRecoveryCodes("u1", codeFor(t.secret, t.clock.now), null);
    expect(r.ok).toBe(true);
    expect(await t.security.verifyCode("u1", t.recoveryCodes[0], null)).toMatchObject({ ok: false });
    if (r.ok) expect(await t.security.verifyCode("u1", r.recoveryCodes[0], null)).toEqual({ ok: true, via: "recovery_code" });
  });

  it("admins without 2FA get a grace period from first seen, then are enforced", async () => {
    const t = testSecurity();
    const first = await t.security.adminRequirement("a1", false);
    expect(first).toMatchObject({ required: true, enabled: false, enforced: false, graceEndsAtMs: t.clock.now + 7 * 24 * HOUR });
    t.clock.now += 6 * 24 * HOUR;
    expect((await t.security.adminRequirement("a1", false)).enforced).toBe(false);
    t.clock.now += 2 * 24 * HOUR;
    expect((await t.security.adminRequirement("a1", false)).enforced).toBe(true);
    expect(await t.security.adminRequirement("a1", true)).toMatchObject({ enabled: true, enforced: false });
  });
});

describe("account security: payout destination confirmation and cooling-off", () => {
  const req = { kind: "lightning_address", destination: "new@getalby.com", network: "signet", first: false };

  it("the emailed link works once, starts the 24 h cooling-off, and is refused after", async () => {
    const t = testSecurity();
    const r = await t.security.requestDestination("u1", req);
    expect(userIdFromLinkToken(r.token)).toBe("u1");
    const c = await t.security.confirmDestinationByToken(r.token);
    expect(c?.userId).toBe("u1");
    expect(c?.pending.activatesAtMs).toBe(t.clock.now + 24 * HOUR);
    expect(await t.security.confirmDestinationByToken(r.token)).toBeNull();
    expect(t.security.coolingOff(await t.security.load("u1"))?.destination).toBe("new@getalby.com");
  });

  it("the link expires after 30 minutes", async () => {
    const t = testSecurity();
    const r = await t.security.requestDestination("u1", req);
    t.clock.now += 31 * 60 * 1000;
    expect(await t.security.confirmDestinationByToken(r.token)).toBeNull();
  });

  it("refuses forged and tampered tokens, and a token for another account", async () => {
    const t = testSecurity();
    const r = await t.security.requestDestination("u1", req);
    const other = await t.security.requestDestination("u2", req);
    const [, secretPart] = r.token.split(".");
    const forged = `${Buffer.from("u2").toString("base64url")}.${secretPart}`;
    expect(await t.security.confirmDestinationByToken(forged)).toBeNull();
    expect(await t.security.confirmDestinationByToken(`${r.token.slice(0, -2)}xx`)).toBeNull();
    expect(await t.security.confirmDestinationByToken("garbage")).toBeNull();
    expect((await t.security.confirmDestinationByToken(other.token))?.userId).toBe("u2");
  });

  it("the first destination of an account cools off for 1 h", async () => {
    const t = testSecurity();
    const r = await t.security.requestDestination("u1", { ...req, first: true });
    const c = await t.security.confirmDestinationByToken(r.token);
    expect(c?.pending.activatesAtMs).toBe(t.clock.now + 1 * HOUR);
  });

  it("the emailed code confirms the same request; a wrong code uses it up", async () => {
    const t = testSecurity();
    const r = await t.security.requestDestination("u1", req);
    expect(await t.security.confirmDestinationByCode("u1", r.id, r.code, "other@getalby.com")).toBeNull();
    expect(await t.security.confirmDestinationByCode("u1", r.id, "000000", req.destination)).toBeNull();
    expect(await t.security.confirmDestinationByCode("u1", r.id, r.code, req.destination)).toBeNull();
    const r2 = await t.security.requestDestination("u1", req);
    expect((await t.security.confirmDestinationByCode("u1", r2.id, r2.code, req.destination))?.pending.confirmedAtMs).toBe(t.clock.now);
    expect(await t.security.confirmDestinationByToken(r2.token)).toBeNull();
  });

  it("only activates after the cooling-off, and not while the account is locked", async () => {
    const t = testSecurity();
    const r = await t.security.requestDestination("u1", req);
    await t.security.confirmDestinationByToken(r.token);
    expect(await t.security.listPendingUserIds()).toEqual(["u1"]);
    t.clock.now += 23 * HOUR;
    expect(await t.security.takeDueDestination("u1")).toBeNull();
    t.clock.now += 2 * HOUR;
    await t.security.lock("u1", "admin");
    expect(await t.security.takeDueDestination("u1")).toBeNull();
    await t.security.unlock("u1", "admin@example.com");
    expect((await t.security.takeDueDestination("u1"))?.destination).toBe("new@getalby.com");
    expect(await t.security.takeDueDestination("u1")).toBeNull();
    expect(await t.security.listPendingUserIds()).toEqual([]);
  });

  it("the cancel link drops the change once; unconfirmed requests never activate", async () => {
    const t = testSecurity();
    const unconfirmed = await t.security.requestDestination("u1", req);
    t.clock.now += 48 * HOUR;
    expect(await t.security.takeDueDestination("u1")).toBeNull();
    expect(await t.security.confirmDestinationByToken(unconfirmed.token)).toBeNull();

    const r = await t.security.requestDestination("u1", req);
    const c = await t.security.confirmDestinationByToken(r.token);
    expect(await t.security.cancelDestinationByToken(r.token)).toBeNull();
    expect((await t.security.cancelDestinationByToken(c!.cancelToken))?.userId).toBe("u1");
    expect(await t.security.cancelDestinationByToken(c!.cancelToken)).toBeNull();
    t.clock.now += 48 * HOUR;
    expect(await t.security.takeDueDestination("u1")).toBeNull();
  });

  it("two concurrent confirmations of one link: exactly one wins", async () => {
    const t = testSecurity();
    const r = await t.security.requestDestination("u1", req);
    const results = await Promise.all([t.security.confirmDestinationByToken(r.token), t.security.confirmDestinationByToken(r.token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("account security: lock", () => {
  it("receipt lock links lock the account; an admin unlocks it", async () => {
    const t = testSecurity();
    const token = await t.security.issueLockToken("u1");
    expect(await t.security.lockByToken("bogus.token")).toBeNull();
    expect(await t.security.lockByToken(token)).toBe("u1");
    expect((await t.security.load("u1")).lock).toMatchObject({ source: "receipt_link" });
    expect(await t.security.listLocked()).toEqual([{ userId: "u1", lockedAtMs: t.clock.now, source: "receipt_link" }]);
    expect(await t.security.unlock("u1", "admin@example.com")).toBe(true);
    expect(await t.security.unlock("u1", "admin@example.com")).toBe(false);
    expect(await t.security.listLocked()).toEqual([]);
  });

  it("lock links expire after 30 days", async () => {
    const t = testSecurity();
    const token = await t.security.issueLockToken("u1");
    t.clock.now += 31 * 24 * HOUR;
    expect(await t.security.lockByToken(token)).toBeNull();
  });
});

describe("maskDestination", () => {
  it("keeps enough to recognise, not to copy", () => {
    expect(maskDestination("alice@getalby.com")).toBe("al…@getalby.com");
    expect(maskDestination("lnbcrt25u1pjqwertyuiopasdfghjklzxcvbnm1234")).toBe("lnbcrt25u1…1234");
    expect(maskDestination("short")).toBe("short");
  });
});
